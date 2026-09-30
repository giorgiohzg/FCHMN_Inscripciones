import { prisma } from "../../shared/prisma.client";
import { ForbiddenError } from "../../shared/errors";
import type { SessionOwnerType } from "./jwt.util";

/**
 * Estado de autorización VIGENTE de un usuario, leído siempre de la base de
 * datos. Es la única fuente de verdad de roles, permisos y club efectivo.
 *
 * Lo usan por igual el login, el refresco de sesión y `requireAuth`: así el
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

export async function loadRolesAndPermissions(userId: string): Promise<{ roles: string[]; permissions: string[] }> {
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
  });

  const roles = userRoles.map((ur) => ur.role.name);
  const permissions = Array.from(new Set(userRoles.flatMap((ur) => ur.role.rolePermissions.map((rp) => rp.permission.code))));
  return { roles, permissions };
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

  const { roles, permissions } = await loadRolesAndPermissions(user.id);
  const esAdministrador = roles.includes("admin");

  /**
   * El club efectivo se resuelve según el tipo de dueño, ahora de forma
   * exhaustiva: una cuenta `system` (el administrador) no tiene club y
   * tampoco tiene persona de la que derivarlo. Antes caía en la rama de
   * `person` y llamaba a `resolvePersonClubId(null)`, que devolvía `null` por
   * casualidad, no por decisión.
   *
   * UN ADMINISTRADOR NO PASA POR LA RESOLUCIÓN DE CLUB.
   *
   * La razón es que su alcance no depende de ningún club: `buildActorContext`
   * le da prioridad a `admin` sobre el club y la persona, así que el valor
   * resuelto aquí se descartaría de todas formas. Preguntar por él no aporta
   * nada y sí puede estorbar — `resolvePersonClubId` LANZA cuando la persona
   * figura como personal de más de un club, y ese error ocurriría antes de
   * que la prioridad se aplicara, dejando al administrador sin poder
   * autenticarse.
   *
   * Precisión sobre eso último: hoy la base rechaza el segundo vínculo, así
   * que ese caso solo puede venir de datos anteriores a esa restricción o
   * insertados por fuera. Es una rama defensiva, no un fallo en curso.
   *
   * Para el resto se conserva la validación tal cual: un delegado con
   * vínculos contradictorios sigue siendo rechazado.
   */
  const clubId =
    esAdministrador || user.ownerType === "system"
      ? null
      : user.ownerType === "club"
        ? user.clubId
        : await resolvePersonClubId(user.personId);

  /**
   * `user.person` es null para las cuentas `system` y `club`, así que la
   * condición de la persona solo puede denegar a las cuentas de persona.
   */
  const personaUtilizable = !user.person || (user.person.status === "active" && user.person.deletedAt === null);
  const cuentaUtilizable = user.status === "active" && user.deletedAt === null;

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
