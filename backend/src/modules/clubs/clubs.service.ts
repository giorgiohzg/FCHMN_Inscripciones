import { prisma } from "../../shared/prisma.client";
import { audit, withAudit } from "../audit/audit.service";
import { assertUsernameAvailable } from "../../shared/username";
import { hashPassword, generateOpaqueToken } from "../auth/password.util";
import { normalizeRun } from "../../shared/run.util";
import { ValidationError, NotFoundError } from "../../shared/errors";
import { LONG_TRANSACTION_OPTIONS, type Db } from "../../shared/transaction";
import type { ClubCreateInput, ClubUpdateInput, ClubListQuery } from "./clubs.schemas";
import { resolveClubFilter, type ActorContext as ScopedActor } from "../../shared/actorContext";

/** Actor mínimo para auditar una escritura (quién y desde dónde). */
interface ActorContext {
  userId: string;
  ipAddress?: string;
}

const staffInclude = {
  staff: { include: { person: { select: { id: true, fullName: true, run: true } } } },
} as const;

async function assertRutNotDuplicated(rut: string, excludeClubId?: string) {
  const normalized = normalizeRun(rut);
  const existing = await prisma.club.findFirst({
    where: { rut: normalized, deletedAt: null, ...(excludeClubId ? { id: { not: excludeClubId } } : {}) },
  });
  if (existing) throw new ValidationError("Ya existe un club registrado con este RUT");
}

// Hallazgo 20: misma razón que en Personas — la comprobación miraba solo
// `clubs`. Ahora la fuente de verdad es `shared/username.ts`.

/**
 * No se designa representante legal sin personalidad jurídica CONFIRMADA.
 *
 * Vive en el servicio y no solo en el esquema Zod porque es una regla del
 * negocio, y porque las pruebas y los guiones de carga llaman a los servicios
 * directamente: una validación que solo estuviera en la capa HTTP dejaría la
 * puerta abierta por dentro.
 */
function assertRepresentanteLegalPermitido(estado: boolean | null, representante?: string | null) {
  if (!representante || estado === true) return;
  throw new ValidationError(
    estado === null
      ? "No se puede designar un representante legal mientras la personalidad jurídica esté pendiente de verificar. Confirme primero la personalidad jurídica."
      : "Solo los clubes con personalidad jurídica pueden tener representante legal"
  );
}

async function assertPersonsExist(personIds: string[], roleLabel: string) {
  if (personIds.length === 0) return;
  const found = await prisma.person.findMany({ where: { id: { in: personIds }, deletedAt: null }, select: { id: true } });
  if (found.length !== new Set(personIds).size) {
    throw new ValidationError(`Una o más personas seleccionadas como ${roleLabel} no existen`);
  }
}

const STAFF_ROLE_LABELS: Record<string, string> = {
  delegate: "delegado(a)",
  coach: "entrenador(a)",
  legal_representative: "representante legal",
};

/**
 * REGLA DE NEGOCIO — una persona es personal de UN SOLO club.
 *
 * Aplica a los tres roles (delegado, entrenador y representante legal) y
 * **entre roles distintos**: nadie puede ser delegado del club A y entrenador
 * del club B. El representante legal no es una excepción: por decisión
 * confirmada es un rol de acceso con las mismas atribuciones que un delegado,
 * así que le corresponde la misma restricción de alcance (A-02).
 *
 * Antes la comprobación era por rol por separado (`roleType` en el `where`),
 * de modo que sí se podía ser delegado de un club y entrenador de otro. Esa
 * situación rompía el modelo de autorización: `resolvePersonClubId()` tiene
 * que devolver UN club para acotar la sesión, y con vínculos a dos clubes
 * elegía uno arbitrariamente. Hoy esa función además falla cerrado si
 * encuentra ese estado en la base (ver `auth/authorization.ts`).
 */
async function assertNotStaffOfAnotherClub(personIds: string[], _roleType: "delegate" | "coach" | "legal_representative", clubId: string | undefined, _roleLabel: string) {
  if (personIds.length === 0) return;
  const conflicting = await prisma.clubStaff.findMany({
    where: { personId: { in: personIds }, ...(clubId ? { clubId: { not: clubId } } : {}) },
    include: { club: { select: { name: true } }, person: { select: { fullName: true } } },
  });
  if (conflicting.length > 0) {
    const names = conflicting
      .map((c) => `${c.person.fullName} (ya es ${STAFF_ROLE_LABELS[c.roleType] ?? c.roleType} de ${c.club.name})`)
      .join(", ");
    throw new ValidationError(
      `No se puede asignar: ${names}. Una persona solo puede ser delegado, entrenador o representante legal de un club a la vez.`
    );
  }
}

/**
 * Sincroniza el PersonRole (y el UserRole de acceso, si ya tiene
 * credenciales) de una persona según si sigue siendo delegado/entrenador/
 * representante legal de AL MENOS UN club — se llama después de cualquier
 * cambio en ClubStaff. Reemplaza el checkbox manual que existía antes en
 * la ficha de Personas: el rol ahora se deriva siempre de la asignación
 * real. El representante legal tiene exactamente los mismos permisos que
 * delegado/entrenador.
 */
async function syncFunctionalRole(personId: string, roleType: "delegate" | "coach" | "legal_representative", db: Db) {
  const stillHasStaffRole = await db.clubStaff.findFirst({ where: { personId, roleType } });

  const existingPersonRole = await db.personRole.findUnique({ where: { personId_roleType: { personId, roleType } } });
  if (stillHasStaffRole) {
    if (existingPersonRole) {
      if (!existingPersonRole.active) await db.personRole.update({ where: { id: existingPersonRole.id }, data: { active: true } });
    } else {
      await db.personRole.create({ data: { personId, roleType, active: true } });
    }
  } else if (existingPersonRole?.active) {
    await db.personRole.update({ where: { id: existingPersonRole.id }, data: { active: false } });
  }

  // Si ya tiene credenciales de acceso, sincroniza también su UserRole —
  // mismo criterio que updatePerson() en persons.service.ts.
  const user = await db.user.findUnique({ where: { personId } });
  if (!user) return;
  const roleRecord = await db.role.findUnique({ where: { name: roleType } });
  if (!roleRecord) return;
  const hasUserRole = await db.userRole.findUnique({ where: { userId_roleId: { userId: user.id, roleId: roleRecord.id } } });
  if (stillHasStaffRole && !hasUserRole) {
    await db.userRole.create({ data: { userId: user.id, roleId: roleRecord.id } });
  } else if (!stillHasStaffRole && hasUserRole) {
    await db.userRole.delete({ where: { userId_roleId: { userId: user.id, roleId: roleRecord.id } } });
  }
}

/**
 * Reemplaza el conjunto de ClubStaff de un tipo (delegate/coach/legal_representative)
 * para un club, dado el nuevo listado completo de personIds — agrega los
 * que falten, quita los que ya no correspondan, y sincroniza el rol
 * funcional de cada persona AFECTADA (agregada o quitada).
 */
async function replaceClubStaff(clubId: string, roleType: "delegate" | "coach" | "legal_representative", personIds: string[], db: Db) {
  const current = await db.clubStaff.findMany({ where: { clubId, roleType } });
  const currentIds = new Set(current.map((s) => s.personId));
  const desiredIds = new Set(personIds);

  const toAdd = personIds.filter((id) => !currentIds.has(id));
  const toRemove = current.filter((s) => !desiredIds.has(s.personId));

  /**
   * Primero se QUITA y después se AGREGA, no al revés.
   *
   * Desde `phase4_identity_guards` hay un índice único parcial que admite un
   * solo representante legal por club. Insertando antes de borrar, reemplazar
   * al representante legal dejaba momentáneamente dos filas y chocaba contra
   * ese índice — dentro de una misma transacción el índice se comprueba por
   * sentencia, no al final. El orden inverso no tiene ese problema y es
   * igual de atómico: todo ocurre dentro de la transacción del llamador.
   */
  if (toRemove.length > 0) {
    await db.clubStaff.deleteMany({ where: { id: { in: toRemove.map((s) => s.id) } } });
  }
  if (toAdd.length > 0) {
    await db.clubStaff.createMany({ data: toAdd.map((personId) => ({ clubId, personId, roleType })), skipDuplicates: true });
  }

  if (roleType === "delegate" || roleType === "coach" || roleType === "legal_representative") {
    const affected = new Set([...toAdd, ...toRemove.map((s) => s.personId)]);
    for (const personId of affected) await syncFunctionalRole(personId, roleType, db);
  }
}

/**
 * Listado de clubes. Un actor no administrador solo obtiene el suyo.
 *
 * Antes devolvía TODOS los clubes a cualquiera con `clubs:read` —permiso que
 * tienen club, delegado, entrenador y representante legal— incluyendo RUT,
 * razón social, correo y la ficha de delegados/entrenadores (con su RUN) de
 * los demás clubes. `GET /clubs/:id` ya estaba acotado; el listado no.
 */
export async function listClubs(query: ClubListQuery, actor: ScopedActor) {
  const where: any = { deletedAt: null };

  const clubFilter = resolveClubFilter(actor, null);
  if (clubFilter) where.id = clubFilter;
  // Un nadador no tiene `clubs:read` en el seed, pero si algún día lo
  // tuviera, no debe ver la ficha de ningún club.
  if (actor.scope.kind === "swimmer") where.id = "__sin_alcance_de_club__";

  if (query.search) {
    const term = query.search.trim();
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { legalName: { contains: term, mode: "insensitive" } },
      { code: { contains: term, mode: "insensitive" } },
      { rut: { contains: normalizeRun(term) } },
    ];
  }
  if (query.status) where.status = query.status;
  // Los tres estados, explícitos. «pendiente» es `null` en la base, así que se
  // consulta con `null` y no con una comparación que lo confundiría con `false`.
  if (query.personalidadJuridica === "si") where.hasLegalStatus = true;
  else if (query.personalidadJuridica === "no") where.hasLegalStatus = false;
  else if (query.personalidadJuridica === "pendiente") where.hasLegalStatus = null;

  const [items, total] = await Promise.all([
    prisma.club.findMany({
      where,
      include: staffInclude,
      // Dos clubes pueden llamarse igual mientras uno esté eliminado.
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.club.count({ where }),
  ]);

  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getClubById(id: string, db: Db = prisma) {
  const club = await db.club.findFirst({
    where: { id, deletedAt: null },
    include: {
      ...staffInclude,
      user: { select: { id: true, username: true, status: true, mustChangePassword: true, lastLoginAt: true } },
    },
  });
  if (!club) throw new NotFoundError("Club");
  return club;
}

export async function createClub(input: ClubCreateInput, actor: ActorContext) {
  /**
   * El RUT se guarda salvo que se haya VERIFICADO que el club no tiene
   * personalidad jurídica. Con el estado pendiente (`null`) se conserva: es la
   * evidencia que después permite cerrar la verificación. Guardarlo no cambia
   * el estado — eso se decide aparte y a propósito.
   */
  const rut = input.hasLegalStatus === false ? null : input.rut?.trim() ? normalizeRun(input.rut) : null;
  if (rut) await assertRutNotDuplicated(rut);
  await assertUsernameAvailable(input.username);

  const delegatePersonIds = input.delegatePersonIds ?? [];
  const coachPersonIds = input.coachPersonIds ?? [];
  /**
   * Representante legal: SOLO con personalidad jurídica confirmada.
   *
   * Se RECHAZA, no se ignora. Descartar la designación en silencio dejaría a
   * quien la pidió creyendo que quedó hecha, y el representante legal es una vía
   * de acceso al sistema: un malentendido ahí no es cosmético.
   *
   * `=== true` y no una comparación por veracidad: con `boolean | null`, un
   * `if (input.hasLegalStatus)` trataría «pendiente» igual que «no».
   */
  assertRepresentanteLegalPermitido(input.hasLegalStatus, input.legalRepresentativePersonId);
  const legalRepresentativePersonId = input.hasLegalStatus === true ? input.legalRepresentativePersonId ?? null : null;

  await assertPersonsExist(delegatePersonIds, "delegado(a)");
  await assertPersonsExist(coachPersonIds, "entrenador(a)");
  await assertPersonsExist(legalRepresentativePersonId ? [legalRepresentativePersonId] : [], "representante legal");
  await assertNotStaffOfAnotherClub(delegatePersonIds, "delegate", undefined, "delegado(a)");
  await assertNotStaffOfAnotherClub(coachPersonIds, "coach", undefined, "entrenador(a)");
  await assertNotStaffOfAnotherClub(legalRepresentativePersonId ? [legalRepresentativePersonId] : [], "legal_representative", undefined, "representante legal");

  /**
   * Hallazgo 18: el club, su personal y los roles funcionales derivados se
   * escriben en UNA transacción. Antes eran escrituras sucesivas con el
   * cliente global: si `replaceClubStaff` fallaba a mitad —por ejemplo al
   * sincronizar el rol de la tercera persona—, quedaba un club creado con su
   * plantilla incompleta y personas con `ClubStaff` pero sin el `PersonRole`
   * que les da acceso, un estado que solo se detectaba usándolo.
   */
  const withStaff = await prisma.$transaction(async (tx) => {
    const club = await tx.club.create({
      data: {
        name: input.name,
        username: input.username,
        code: input.code.toUpperCase(),
        hasLegalStatus: input.hasLegalStatus,
        rut,
        legalName: input.legalName || null,
        email: input.email,
        isAchmnMember: input.isAchmnMember,
        isAchmnCollaborator: input.isAchmnCollaborator,
        isFchmnMember: input.isFchmnMember,
        isFchmnCollaborator: input.isFchmnCollaborator,
        status: "active",
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
    });

    await replaceClubStaff(club.id, "delegate", delegatePersonIds, tx);
    await replaceClubStaff(club.id, "coach", coachPersonIds, tx);
    await replaceClubStaff(club.id, "legal_representative", legalRepresentativePersonId ? [legalRepresentativePersonId] : [], tx);

    const creado = await getClubById(club.id, tx);
    await audit(
      { userId: actor.userId, action: "CLUB_CREATED", entityType: "Club", entityId: creado.id, ipAddress: actor.ipAddress, after: creado },
      { tx }
    );
    return creado;
  }, LONG_TRANSACTION_OPTIONS);

  return withStaff;
}

export async function updateClub(id: string, input: ClubUpdateInput, actor: ActorContext) {
  const before = await getClubById(id);

  /**
   * `input.hasLegalStatus` SIEMPRE viene en una actualización —el esquema lo
   * exige, para poder re-evaluar RB-02—, así que se usa tal cual.
   *
   * Aquí había un `??` y con tres estados se volvió una trampa: `null` es un
   * valor DELIBERADO —«pendiente de verificar»— y `??` lo habría descartado
   * para quedarse con el valor anterior, de modo que marcar un club como
   * pendiente no habría hecho nada.
   */
  const hasLegalStatus = input.hasLegalStatus;

  /**
   * El RUT: se descarta solo si se verificó que el club NO tiene personalidad
   * jurídica. Si no se envió el campo, no se toca.
   */
  const rut =
    hasLegalStatus === false
      ? null
      : input.rut !== undefined
        ? input.rut.trim()
          ? normalizeRun(input.rut)
          : null
        : before.rut;
  if (rut && rut !== before.rut) await assertRutNotDuplicated(rut, id);

  /**
   * Un representante legal YA DESIGNADO bloquea el cambio de estado.
   *
   * Antes, poner el indicador en `false` ejecutaba
   * `replaceClubStaff(legal_representative, [])`: borraba el nombramiento y
   * recalculaba el rol de acceso de esa persona, sin avisar. Con dos estados
   * eso pasaba poco; con tres, la transición «pendiente → no» es una operación
   * de rutina, y cada vez retiraría a alguien y su acceso en silencio.
   *
   * Ahora se rechaza y se pide retirarlo expresamente primero. Son dos pasos a
   * propósito: así quitar el acceso de una persona es una decisión visible y no
   * el efecto colateral de cambiar una casilla.
   */
  const representanteActual = before.staff?.find((s) => s.roleType === "legal_representative")?.personId ?? null;
  if (hasLegalStatus !== true && representanteActual) {
    throw new ValidationError(
      hasLegalStatus === null
        ? "Este club tiene un representante legal designado. Retírelo expresamente antes de dejar la personalidad jurídica como «pendiente de verificar»: el sistema no retira nombramientos ni permisos por su cuenta."
        : "Este club tiene un representante legal designado. Retírelo expresamente antes de declarar que el club no tiene personalidad jurídica: el sistema no retira nombramientos ni permisos por su cuenta."
    );
  }

  if (input.delegatePersonIds !== undefined) {
    await assertPersonsExist(input.delegatePersonIds, "delegado(a)");
    await assertNotStaffOfAnotherClub(input.delegatePersonIds, "delegate", id, "delegado(a)");
  }
  if (input.coachPersonIds !== undefined) {
    await assertPersonsExist(input.coachPersonIds, "entrenador(a)");
    await assertNotStaffOfAnotherClub(input.coachPersonIds, "coach", id, "entrenador(a)");
  }
  /**
   * Designar sin personalidad jurídica confirmada se RECHAZA, igual que al
   * crear. Y como el bloque de arriba ya garantizó que no queda ninguno
   * designado cuando el estado no es `true`, aquí no hay nada que borrar:
   * `undefined` significa «no tocar».
   */
  assertRepresentanteLegalPermitido(hasLegalStatus, input.legalRepresentativePersonId);
  const legalRepresentativePersonId = hasLegalStatus === true ? input.legalRepresentativePersonId : undefined;
  if (legalRepresentativePersonId) {
    await assertPersonsExist([legalRepresentativePersonId], "representante legal");
    await assertNotStaffOfAnotherClub([legalRepresentativePersonId], "legal_representative", id, "representante legal");
  }

  // Mismo criterio que en `createClub`: la ficha, la plantilla y los roles
  // derivados cambian juntos o no cambian.
  const withStaff = await prisma.$transaction(async (tx) => {
    await tx.club.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        code: input.code ? input.code.toUpperCase() : undefined,
        hasLegalStatus,
        rut,
        legalName: input.legalName !== undefined ? input.legalName || null : undefined,
        email: input.email ?? undefined,
        isAchmnMember: input.isAchmnMember ?? undefined,
        isAchmnCollaborator: input.isAchmnCollaborator ?? undefined,
        isFchmnMember: input.isFchmnMember ?? undefined,
        isFchmnCollaborator: input.isFchmnCollaborator ?? undefined,
        updatedBy: actor.userId,
      },
    });

    if (input.delegatePersonIds !== undefined) await replaceClubStaff(id, "delegate", input.delegatePersonIds, tx);
    if (input.coachPersonIds !== undefined) await replaceClubStaff(id, "coach", input.coachPersonIds, tx);
    /**
     * Ya NO hay una rama que vacíe la designación por el solo hecho de cambiar
     * el estado. Si el estado no es `true`, la comprobación de más arriba
     * garantiza que no había representante, así que no hay nada que retirar;
     * y retirarlo es siempre una petición explícita
     * (`legalRepresentativePersonId: null`) con el estado todavía en `true`.
     */
    if (hasLegalStatus === true && legalRepresentativePersonId !== undefined) {
      await replaceClubStaff(id, "legal_representative", legalRepresentativePersonId ? [legalRepresentativePersonId] : [], tx);
    }

    const actualizado = await getClubById(id, tx);
    await audit(
      { userId: actor.userId, action: "CLUB_UPDATED", entityType: "Club", entityId: id, ipAddress: actor.ipAddress, before, after: actualizado },
      { tx }
    );
    return actualizado;
  }, LONG_TRANSACTION_OPTIONS);

  return withStaff;
}

async function setStatus(id: string, status: "active" | "locked" | "disabled", action: string, actor: ActorContext) {
  const before = await getClubById(id);

  // Mismo criterio que en `persons.service`: estado, cuenta y sesiones se
  // cambian juntos, y el bloqueo administrativo se marca con
  // `lockedUntil: null` para que sea indefinido.
  const club = await prisma.$transaction(async (tx) => {
    const updated = await tx.club.update({ where: { id }, data: { status, updatedBy: actor.userId } });
    await tx.user.updateMany({
      where: { clubId: id },
      data: status === "active" ? { status, lockedUntil: null, failedLoginAttempts: 0 } : { status, lockedUntil: null },
    });
    if (status !== "active") {
      await tx.refreshToken.updateMany({ where: { user: { clubId: id }, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await audit({ userId: actor.userId, action, entityType: "Club", entityId: id, ipAddress: actor.ipAddress, before, after: updated }, { tx });
    return updated;
  });
  return club;
}

export const blockClub = (id: string, actor: ActorContext) => setStatus(id, "locked", "CLUB_BLOCKED", actor);
export const disableClub = (id: string, actor: ActorContext) => setStatus(id, "disabled", "CLUB_DISABLED", actor);
export const reactivateClub = (id: string, actor: ActorContext) => setStatus(id, "active", "CLUB_REACTIVATED", actor);

export async function softDeleteClub(id: string, actor: ActorContext) {
  const before = await getClubById(id);

  // Igual que en personas: la eliminación lógica dejaba viva la cuenta de
  // acceso del club.
  const club = await prisma.$transaction(async (tx) => {
    const updated = await tx.club.update({ where: { id }, data: { deletedAt: new Date(), status: "disabled", updatedBy: actor.userId } });
    await tx.user.updateMany({ where: { clubId: id }, data: { status: "disabled", deletedAt: new Date(), lockedUntil: null } });
    await tx.refreshToken.updateMany({ where: { user: { clubId: id }, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(
      { userId: actor.userId, action: "CLUB_DELETED", entityType: "Club", entityId: id, ipAddress: actor.ipAddress, before, after: updated },
      { tx }
    );
    return updated;
  });
  return club;
}

// --------------------------------------------------------------------------
// Credenciales de acceso del club (RB-01, A-03: una credencial por club)
// --------------------------------------------------------------------------

/** Crea la cuenta de acceso del club usando su `username` ya definido. */
export async function createClubCredentials(clubId: string, actor: ActorContext) {
  const club = await getClubById(clubId);
  if (club.user) throw new ValidationError("El club ya tiene credenciales de acceso");

  // Solo puede tomar el nombre de usuario su propio dueño: el club.
  await assertUsernameAvailable(club.username, { excludeClubId: club.id });

  const clubRole = await prisma.role.findUnique({ where: { name: "club" } });
  if (!clubRole) throw new ValidationError("El rol 'club' no está configurado en el sistema (revise el seed)");

  const tempPassword = generateOpaqueToken().token.slice(0, 12);
  const passwordHash = await hashPassword(tempPassword);

  const user = await withAudit(
    (tx) =>
      tx.user.create({
        data: {
          username: club.username,
          passwordHash,
          ownerType: "club",
          clubId,
          mustChangePassword: true,
          status: "active",
          userRoles: { create: { roleId: clubRole.id } },
        },
      }),
    (user) => ({ userId: actor.userId, action: "CLUB_CREDENTIALS_CREATED", entityType: "User", entityId: user.id, ipAddress: actor.ipAddress })
  );

  return { userId: user.id, username: user.username, temporaryPassword: tempPassword };
}

export async function resetClubCredentials(clubId: string, actor: ActorContext) {
  const club = await getClubById(clubId);
  if (!club.user) throw new ValidationError("El club no tiene credenciales de acceso");

  const tempPassword = generateOpaqueToken().token.slice(0, 12);
  const passwordHash = await hashPassword(tempPassword);

  // Ver la nota equivalente en `persons.service.resetCredentials`.
  await withAudit(
    async (tx) => {
      await tx.user.update({
        where: { id: club.user!.id },
        data: { passwordHash, mustChangePassword: true, failedLoginAttempts: 0, status: "active", lockedUntil: null },
      });
      await tx.refreshToken.updateMany({ where: { userId: club.user!.id, revokedAt: null }, data: { revokedAt: new Date() } });
    },
    () => ({ userId: actor.userId, action: "CLUB_CREDENTIALS_RESET", entityType: "User", entityId: club.user!.id, ipAddress: actor.ipAddress })
  );

  return { temporaryPassword: tempPassword };
}
