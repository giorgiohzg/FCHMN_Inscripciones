import { prisma } from "../../shared/prisma.client";
import { ForbiddenError } from "../../shared/errors";
import type { SessionOwnerType } from "./jwt.util";

/**
 * Estado de autorización VIGENTE de un usuario, leído siempre de la base de
 * datos. Es la única fuente de verdad de roles, permisos y club efectivo.
 *
 * Lo usa `requireAuth` en cada solicitud; el login, el refresco y el cambio de
 * contraseña firman con la misma `resolverAutorizacionEfectiva`, así que el
 * contenido del access token nunca puede quedar por delante de la realidad.
 */
export interface AuthorizationState {
  userId: string;
  ownerType: SessionOwnerType;
  personId: string | null;
  /** Club al que queda acotada la sesión; `null` = sin club (nadador o admin). */
  clubId: string | null;
  roles: string[];
  permissions: string[];
  status: "active" | "locked" | "disabled";
  deletedAt: Date | null;
  mustChangePassword: boolean;
  /**
   * ¿La sesión es utilizable AHORA?
   *
   * Se calcula aquí, no en cada llamador, porque son tres los que deciden si
   * dejan pasar —`authenticate`, el login y el refresco— y cada uno repetía
   * su propia versión de la comprobación. Una condición nueva añadida en uno
   * solo de ellos deja una puerta abierta en los otros dos.
   *
   * Incluye algo que antes no se miraba: el estado de la PERSONA dueña de la
   * cuenta. `users.status` y `persons.status` son columnas distintas, y
   * bastaba una incoherencia —una persona inhabilitada cuya cuenta siguiera
   * activa— para que esa persona entrara con normalidad. Las cuentas `system`
   * y `club` no tienen persona detrás, así que para ellas esto no cambia
   * nada.
   */
  usable: boolean;
}

/**
 * Club de una persona según su vínculo como personal de club (delegado,
 * entrenador o representante legal).
 *
 * REGLA DE NEGOCIO (confirmada): una persona representa **un solo club**.
 * `clubs.service` lo impide al asignar personal, pero esta función no puede
 * asumir que los datos siempre entraron por ahí (importaciones, correcciones
 * manuales en base). Si encuentra vínculos con más de un club, **deniega**
 * en vez de elegir uno: antes usaba `findFirst()` sin `orderBy`, así que el
 * club efectivo de la sesión —y por lo tanto todo el alcance de acceso—
 * dependía del orden en que PostgreSQL devolviera las filas.
 */
export async function resolvePersonClubId(personId: string | null): Promise<string | null> {
  if (!personId) return null;

  const staff = await prisma.clubStaff.findMany({
    where: { personId, roleType: { in: ["delegate", "coach", "legal_representative"] } },
    select: { clubId: true },
  });

  const distinctClubIds = Array.from(new Set(staff.map((s) => s.clubId)));
  if (distinctClubIds.length === 0) return null;
  if (distinctClubIds.length > 1) {
    throw new ForbiddenError(
      "Su cuenta figura como delegado, entrenador o representante legal de más de un club. " +
        "El sistema admite un solo club por persona: pida a un administrador que corrija las asignaciones."
    );
  }
  return distinctClubIds[0]!;
}

/** Roles persistidos de una cuenta, cada uno con los permisos que aporta. */
async function cargarRolesConPermisos(userId: string): Promise<{ rol: string; permisos: string[] }[]> {
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
  });
  return userRoles.map((ur) => ({ rol: ur.role.name, permisos: ur.role.rolePermissions.map((rp) => rp.permission.code) }));
}

/** Roles y permisos PERSISTIDOS, sin reducción alguna. La autorización efectiva es `resolverAutorizacionEfectiva`. */
export async function loadRolesAndPermissions(userId: string): Promise<{ roles: string[]; permissions: string[] }> {
  const rolesConPermisos = await cargarRolesConPermisos(userId);
  return {
    roles: rolesConPermisos.map((r) => r.rol),
    permissions: Array.from(new Set(rolesConPermisos.flatMap((r) => r.permisos))),
  };
}

/**
 * Roles que solo tienen sentido actuando POR un club: el personal nombrado en
 * `club_staff`. La cuenta del club (`club`) no está aquí porque no es una
 * persona: si su club no está activo, la cuenta entera deja de ser utilizable.
 */
const ROLES_DE_PERSONAL = new Set(["delegate", "coach", "legal_representative"]);

/** Lo que hace falta saber de una cuenta para resolver su autorización efectiva. */
export interface CuentaParaAutorizar {
  id: string;
  ownerType: SessionOwnerType;
  personId: string | null;
  clubId: string | null;
}

/** Roles, permisos y club con los que la cuenta opera AHORA. */
export interface AutorizacionEfectiva {
  roles: string[];
  permissions: string[];
  /** Club al que queda acotada; `null` = sin club (administrador, nadador o personal de un club no activo). */
  clubId: string | null;
}

/** ¿El club existe, está activo y no está eliminado? */
export async function clubOperativo(clubId: string | null, db: Pick<typeof prisma, "club"> = prisma): Promise<boolean> {
  if (!clubId) return false;
  const club = await db.club.findUnique({ where: { id: clubId }, select: { status: true, deletedAt: true } });
  return club !== null && club.status === "active" && club.deletedAt === null;
}

/**
 * AUTORIZACIÓN EFECTIVA — la ÚNICA resolución de roles, permisos y club.
 *
 * La usan el login, el refresco, el cambio de contraseña y cada solicitud
 * autenticada (`loadAuthorizationState`). Antes había dos copias —una aquí y otra
 * en `auth.service`— y una condición nueva añadida en una sola dejaba el token y la
 * solicitud en desacuerdo.
 *
 * PERSONAL DE UN CLUB NO ACTIVO (auditoría AUD-04). Bloquear, inhabilitar o
 * eliminar un club apagaba solo la cuenta del club; su personal seguía operando
 * por él. Ahora, si el club del nombramiento no está activo o está eliminado:
 *
 *  - la sesión queda SIN club (`clubId: null`);
 *  - se retiran del resultado los roles de personal y los permisos se recalculan
 *    con los roles que quedan —típicamente `swimmer`, si la persona también nada—.
 *
 * Es una reducción de la autorización EFECTIVA: `user_roles` y `club_staff` no se
 * tocan, así que al reactivar el club la siguiente solicitud recupera todo. Nadie
 * queda bloqueado ni se revoca ninguna sesión: la persona conserva su acceso
 * personal. Solo quitar `clubId` no bastaba: con los permisos de personal intactos
 * y el alcance personal, quedaban permisos de club (`export:team-manager`,
 * `swimmer-assignment:write`, `clubs:read`) sobre un alcance que no los acota.
 *
 * Se conservan tal cual: la prioridad del administrador (no pasa por la resolución
 * de club) y la regla de un solo club por persona (`resolvePersonClubId` lanza).
 */
export async function resolverAutorizacionEfectiva(cuenta: CuentaParaAutorizar): Promise<AutorizacionEfectiva> {
  const rolesConPermisos = await cargarRolesConPermisos(cuenta.id);
  const combinar = (lista: { rol: string; permisos: string[] }[]): AutorizacionEfectiva & { clubId: null } => ({
    roles: lista.map((r) => r.rol),
    permissions: Array.from(new Set(lista.flatMap((r) => r.permisos))),
    clubId: null,
  });
  const todos = combinar(rolesConPermisos);

  if (todos.roles.includes("admin") || cuenta.ownerType === "system") return todos;
  if (cuenta.ownerType === "club") return { ...todos, clubId: cuenta.clubId };

  const clubDelNombramiento = await resolvePersonClubId(cuenta.personId);
  if (!clubDelNombramiento) return todos;
  if (await clubOperativo(clubDelNombramiento)) return { ...todos, clubId: clubDelNombramiento };

  return combinar(rolesConPermisos.filter((r) => !ROLES_DE_PERSONAL.has(r.rol)));
}

/**
 * Carga el estado completo de autorización. Devuelve `null` si el usuario no
 * existe (el llamador decide cómo responder).
 */
export async function loadAuthorizationState(userId: string): Promise<AuthorizationState | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      ownerType: true,
      personId: true,
      clubId: true,
      status: true,
      deletedAt: true,
      mustChangePassword: true,
      // El estado de la PERSONA dueña, para poder denegar aunque la cuenta
      // figure activa por una incoherencia.
      person: { select: { status: true, deletedAt: true } },
    },
  });
  if (!user) return null;

  /**
   * Roles, permisos y club salen de la resolución ÚNICA, la misma que firma los
   * tokens. Un administrador no pasa por la resolución de club: su alcance no
   * depende de ninguno, y `resolvePersonClubId` LANZA cuando la persona figura
   * como personal de más de un club, lo que lo dejaría sin poder autenticarse.
   * Para el resto, un delegado con vínculos contradictorios sigue rechazado.
   */
  const { roles, permissions, clubId } = await resolverAutorizacionEfectiva(user);

  /**
   * `user.person` es null para las cuentas `system` y `club`, así que la
   * condición de la persona solo puede denegar a las cuentas de persona.
   */
  const personaUtilizable = !user.person || (user.person.status === "active" && user.person.deletedAt === null);
  /**
   * La cuenta de un club solo opera si SU club está activo y no eliminado
   * (AUD-04/11). Cambiar el estado del club ya cambia el de la cuenta, pero no
   * siempre fue así —un restablecimiento la reactivaba— y la cuenta no puede
   * depender de que esas dos columnas coincidan.
   */
  const clubUtilizable = user.ownerType !== "club" || (await clubOperativo(user.clubId));
  const cuentaUtilizable = user.status === "active" && user.deletedAt === null && clubUtilizable;

  return {
    userId: user.id,
    ownerType: user.ownerType,
    personId: user.personId,
    clubId,
    roles,
    permissions,
    status: user.status as "active" | "locked" | "disabled",
    deletedAt: user.deletedAt,
    mustChangePassword: user.mustChangePassword,
    usable: cuentaUtilizable && personaUtilizable,
  };
}
