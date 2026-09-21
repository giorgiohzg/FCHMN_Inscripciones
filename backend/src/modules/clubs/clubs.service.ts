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
  const rut = input.hasLegalStatus && input.rut ? normalizeRun(input.rut) : null;
  if (rut) await assertRutNotDuplicated(rut);
  await assertUsernameAvailable(input.username);

  const delegatePersonIds = input.delegatePersonIds ?? [];
  const coachPersonIds = input.coachPersonIds ?? [];
  // El representante legal solo aplica si el club tiene personalidad jurídica.
  const legalRepresentativePersonId = input.hasLegalStatus ? input.legalRepresentativePersonId ?? null : null;

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

  const hasLegalStatus = input.hasLegalStatus ?? before.hasLegalStatus;
  const rut = hasLegalStatus && input.rut ? normalizeRun(input.rut) : hasLegalStatus ? before.rut : null;
  if (rut && rut !== before.rut) await assertRutNotDuplicated(rut, id);

  if (input.delegatePersonIds !== undefined) {
    await assertPersonsExist(input.delegatePersonIds, "delegado(a)");
    await assertNotStaffOfAnotherClub(input.delegatePersonIds, "delegate", id, "delegado(a)");
  }
  if (input.coachPersonIds !== undefined) {
    await assertPersonsExist(input.coachPersonIds, "entrenador(a)");
    await assertNotStaffOfAnotherClub(input.coachPersonIds, "coach", id, "entrenador(a)");
  }
  // Si el club deja de tener personalidad jurídica, el representante legal se quita.
  const legalRepresentativePersonId = !hasLegalStatus
    ? null
    : input.legalRepresentativePersonId !== undefined
      ? input.legalRepresentativePersonId
      : undefined; // undefined = no tocar
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
    if (!hasLegalStatus) {
      await replaceClubStaff(id, "legal_representative", [], tx);
    } else if (legalRepresentativePersonId !== undefined) {
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
