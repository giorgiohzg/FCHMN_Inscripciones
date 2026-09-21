import { prisma } from "../../shared/prisma.client";
import { audit, withAudit } from "../audit/audit.service";
import { ValidationError, NotFoundError } from "../../shared/errors";
import { type ActorContext, assertClubAccess } from "../../shared/actorContext";
import { type Db } from "../../shared/transaction";
import { evaluateTransition } from "./assignment.rules";
import type { ProposeAssignmentInput, AssignmentListQuery } from "./assignment.schemas";

/**
 * Quién ejecuta una operación que solo el administrador puede pedir.
 *
 * Es deliberadamente MÍNIMO: lo único que estas operaciones necesitan del actor
 * es a quién auditar. El alcance por club no aparece porque no se evalúa —el
 * permiso `swimmer-assignment:approve` ya lo decidió en la capa HTTP—, y un
 * campo que no se usa solo sirve para que alguien crea que protege algo.
 */
interface ContextoDeAuditoria {
  userId: string;
  ipAddress?: string;
}

/**
 * NO HAY UN `ActorContext` LOCAL.
 *
 * Existía uno, con `isAdmin?` y `actorClubId?` **opcionales**, y ese contrato
 * paralelo fue el origen de un defecto real: las rutas de proponer y finalizar
 * pasaban el `ActorContext` de `shared/actorContext` —que no tiene
 * `actorClubId`— y TypeScript lo aceptaba, porque un campo opcional ausente
 * encaja. En ejecución, la comparación `actor.actorClubId !== clubId` era
 * verdadera SIEMPRE para un no administrador, así que ningún club podía
 * proponer ni dar de baja en su propio plantel.
 *
 * Las operaciones con alcance usan ahora el `ActorContext` compartido y
 * `assertClubAccess`, que es exhaustivo sobre los tres alcances posibles.
 */

/**
 * UN SOLO CLUB ACTIVO ES UNA INVARIANTE, NO UN PARÁMETRO.
 *
 * Antes esto se consultaba en `system_settings` (`SWIMMER_SINGLE_CLUB_ACTIVE`)
 * y la regla solo se comprobaba si el parámetro estaba en `true`. Era una
 * configuración que no configuraba nada: la migración crea un índice único
 * parcial sobre `club_swimmers(person_id) WHERE status='active'` de forma
 * incondicional, así que con el parámetro en `false` PostgreSQL seguía
 * rechazando la segunda membresía — y el usuario, en vez del mensaje de
 * negocio, veía un error de base de datos.
 *
 * Se resolvió en favor de la invariante: la comprobación es incondicional y su
 * valor está en dar el mensaje claro ANTES de que la base lo impida. El índice
 * queda como red de seguridad frente a dos inserciones concurrentes, que la
 * comprobación por sí sola no puede evitar.
 */

/**
 * Sincroniza el PersonRole "swimmer" (y el UserRole de acceso, si ya
 * tiene credenciales) según si la persona sigue teniendo AL MENOS una
 * membresía de club activa — se llama después de cualquier cambio de
 * estado en ClubSwimmer. Reemplaza el checkbox manual "nadador" que
 * existía antes en la ficha de Personas: ya no hace falta tenerlo
 * marcado de antemano para poder asignar a alguien a un club — la
 * asignación misma es la que otorga el rol.
 *
 * Hallazgo 18: recibe el cliente de base de datos porque tiene que correr en
 * la MISMA transacción que el cambio de membresía que la provoca. Escritas
 * por separado, un fallo aquí dejaba la membresía guardada y el rol sin
 * sincronizar: un nadador dado de baja conservando el rol activo (y por lo
 * tanto inscribible), o uno recién incorporado sin el rol que necesita.
 */
async function syncSwimmerRole(personId: string, db: Db) {
  const stillActive = await db.clubSwimmer.findFirst({ where: { personId, status: "active" } });

  const existingPersonRole = await db.personRole.findUnique({ where: { personId_roleType: { personId, roleType: "swimmer" } } });
  if (stillActive) {
    if (existingPersonRole) {
      if (!existingPersonRole.active) await db.personRole.update({ where: { id: existingPersonRole.id }, data: { active: true } });
    } else {
      await db.personRole.create({ data: { personId, roleType: "swimmer", active: true } });
    }
  } else if (existingPersonRole?.active) {
    await db.personRole.update({ where: { id: existingPersonRole.id }, data: { active: false } });
  }

  const user = await db.user.findUnique({ where: { personId } });
  if (!user) return;
  const roleRecord = await db.role.findUnique({ where: { name: "swimmer" } });
  if (!roleRecord) return;
  const hasUserRole = await db.userRole.findUnique({ where: { userId_roleId: { userId: user.id, roleId: roleRecord.id } } });
  if (stillActive && !hasUserRole) {
    await db.userRole.create({ data: { userId: user.id, roleId: roleRecord.id } });
  } else if (!stillActive && hasUserRole) {
    await db.userRole.delete({ where: { userId_roleId: { userId: user.id, roleId: roleRecord.id } } });
  }
}

async function assertClubActive(clubId: string) {
  const club = await prisma.club.findFirst({ where: { id: clubId, deletedAt: null } });
  if (!club) throw new NotFoundError("Club");
  if (club.status !== "active") throw new ValidationError("El club no está activo");
  return club;
}

/**
 * RB-06/A-04: retorna la asignación activa actual del nadador, si existe.
 * Usado también por otros módulos (ej. inscripciones) para determinar
 * automáticamente a qué club pertenece un nadador en un momento dado.
 */
export async function getCurrentClubForPerson(personId: string) {
  return prisma.clubSwimmer.findFirst({
    where: { personId, status: "active" },
    include: { club: { select: { id: true, name: true } } },
  });
}

/**
 * `restrictToClubId`: `undefined` = sin restricción (admin). Cualquier
 * otro valor SÍ restringe — incluido `null`, que significa "sin club
 * real detrás" (ej. rol delegado marcado pero no asignado a ningún
 * club): en ese caso no debe ver ninguna asignación, nunca todas.
 */
export async function listAssignments(query: AssignmentListQuery, restrictToClubId?: string | null) {
  const where: any = {};
  if (query.clubId) where.clubId = query.clubId;
  if (query.personId) where.personId = query.personId;
  if (query.status) where.status = query.status;
  if (restrictToClubId !== undefined) where.clubId = restrictToClubId ?? "__sin_club_real__";

  const [items, total] = await Promise.all([
    prisma.clubSwimmer.findMany({
      where,
      include: {
        club: { select: { id: true, name: true } },
        person: { select: { id: true, fullName: true, run: true } },
      },
      // La asignación masiva crea muchas filas con el mismo `createdAt`.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.clubSwimmer.count({ where }),
  ]);

  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getAssignmentById(id: string) {
  const assignment = await prisma.clubSwimmer.findUnique({
    where: { id },
    include: { club: { select: { id: true, name: true } }, person: { select: { id: true, fullName: true, run: true } } },
  });
  if (!assignment) throw new NotFoundError("Solicitud de asignación");
  return assignment;
}

/**
 * Asignación directa (sin flujo de propuesta/aprobación): un administrador
 * agrega un nadador a un club y la asignación queda ACTIVA de inmediato —
 * el propio admin es quien la solicita y quien la aprobaría, así que el
 * paso intermedio de "pendiente" no aporta nada. El flujo de propuesta
 * (`proposeAssignment`) sigue existiendo tal cual para el club y su personal
 * —delegado, entrenador y representante legal—,
 * que sí requieren la aprobación de un administrador (A-05).
 *
 * Se reutiliza la misma invariante de "un solo club activo" (RB-06) que
 * aplica `approveAssignment`: si el nadador ya tiene una membresía activa en
 * OTRO club, se bloquea con el mismo mensaje claro, en vez de hacer un
 * reemplazo silencioso.
 */
export async function assignSwimmerDirectly(input: ProposeAssignmentInput, actor: ContextoDeAuditoria) {
  await assertClubActive(input.clubId);

  const existingActiveSameClub = await prisma.clubSwimmer.findFirst({
    where: { clubId: input.clubId, personId: input.personId, status: "active" },
  });
  if (existingActiveSameClub) {
    throw new ValidationError("El nadador ya pertenece activamente a este club");
  }

  const currentActive = await getCurrentClubForPerson(input.personId);
  if (currentActive) {
    throw new ValidationError(
      `El nadador ya tiene una membresía activa en "${currentActive.club.name}". ` +
        `Debe finalizarla antes de asignarlo a un nuevo club.`
    );
  }

  // La membresía y el rol derivado se escriben juntos o no se escriben.
  const assignment = await prisma.$transaction(async (tx) => {
    const created = await tx.clubSwimmer.create({
      data: {
        clubId: input.clubId,
        personId: input.personId,
        status: "active",
        requestedByUserId: actor.userId,
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
        startDate: new Date(),
      },
    });
    await syncSwimmerRole(input.personId, tx);
    await audit(
      {
        userId: actor.userId,
        action: "SWIMMER_ASSIGNMENT_DIRECT",
        entityType: "ClubSwimmer",
        entityId: created.id,
        ipAddress: actor.ipAddress,
        after: created,
      },
      { tx }
    );
    return created;
  });

  return assignment;
}

/**
 * Lista nadadores (rol activo) filtrados por su club ACTUAL: `clubFilter`
 * es un ID de club (muestra los activos en ese club) o el literal
 * `"none"` (muestra los que no tienen ningún club activo asignado) — es
 * el filtro que alimenta la pantalla de asignación masiva.
 */
export async function listSwimmersByClubFilter(query: { clubFilter: string; search?: string }) {
  const searchWhere = query.search
    ? {
        OR: [
          { fullName: { contains: query.search, mode: "insensitive" as const } },
          { run: { contains: query.search, mode: "insensitive" as const } },
        ],
      }
    : {};

  /**
   * SIN filtrar por el rol `swimmer`.
   *
   * El rol es DERIVADO: lo activa `syncSwimmerRole` cuando la persona pasa a
   * tener una membresía activa. Exigirlo aquí volvía la opción «Sin club»
   * estructuralmente vacía para quien más la necesita: una persona recién
   * creada no tiene club y, por eso mismo, tampoco tiene el rol — así que
   * quedaba invisible justo en la pantalla que existe para asignarla.
   *
   * Para el filtro por club el rol era además redundante: tener una membresía
   * activa en ese club ya implica el rol.
   */
  const baseWhere = {
    deletedAt: null,
    status: "active" as const,
    ...searchWhere,
  };

  const where =
    query.clubFilter === "none"
      ? { ...baseWhere, clubAssignments: { none: { status: "active" as const } } }
      : { ...baseWhere, clubAssignments: { some: { status: "active" as const, clubId: query.clubFilter } } };

  const persons = await prisma.person.findMany({
    where,
    orderBy: { fullName: "asc" },
    select: { id: true, fullName: true, run: true, gender: true, birthDate: true },
  });

  return persons;
}

export interface BulkAssignRowResult {
  personId: string;
  fullName: string;
  status: "assigned" | "error";
  error?: string;
}

export interface BulkAssignSummary {
  totalCount: number;
  assignedCount: number;
  errorCount: number;
  results: BulkAssignRowResult[];
}

/**
 * Asigna varios nadadores al mismo club de una sola vez, reutilizando
 * exactamente las mismas reglas que `assignSwimmerDirectly` (uno por
 * uno, en el mismo orden en que se pediría manualmente) — un nadador con
 * problemas (ej. ya tiene membresía activa en otro club) NO detiene el
 * procesamiento de los demás; se acumula un reporte por nadador, igual
 * que la carga masiva de Personas.
 */
export async function bulkAssignSwimmers(input: { targetClubId: string; personIds: string[] }, actor: ContextoDeAuditoria): Promise<BulkAssignSummary> {
  await assertClubActive(input.targetClubId);

  const results: BulkAssignRowResult[] = [];
  let assignedCount = 0;

  for (const personId of input.personIds) {
    const person = await prisma.person.findFirst({ where: { id: personId, deletedAt: null } });
    const fullName = person?.fullName ?? personId;
    try {
      await assignSwimmerDirectly({ clubId: input.targetClubId, personId }, actor);
      results.push({ personId, fullName, status: "assigned" });
      assignedCount++;
    } catch (err) {
      results.push({ personId, fullName, status: "error", error: err instanceof Error ? err.message : "Error desconocido" });
    }
  }

  return { totalCount: results.length, assignedCount, errorCount: results.length - assignedCount, results };
}

/**
 * Reasigna un nadador a un club distinto en un solo paso: si tiene una
 * membresía activa en otro club, la finaliza automáticamente y crea la
 * nueva como activa — todo en una transacción. Evita el flujo manual de
 * dos pasos ("finalizar" y luego "asignar") al cambiar de club desde la
 * ficha de la persona.
 */
export async function reassignSwimmerToClub(personId: string, newClubId: string, actor: ContextoDeAuditoria) {
  await assertClubActive(newClubId);

  const current = await getCurrentClubForPerson(personId);
  if (current && current.clubId === newClubId) {
    throw new ValidationError("El nadador ya pertenece activamente a ese club");
  }

  const assignment = await prisma.$transaction(async (tx) => {
    if (current) {
      await tx.clubSwimmer.update({ where: { id: current.id }, data: { status: "ended", endDate: new Date() } });
    }
    const created = await tx.clubSwimmer.create({
      data: {
        clubId: newClubId,
        personId,
        status: "active",
        requestedByUserId: actor.userId,
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
        startDate: new Date(),
      },
    });
    // Dentro de la transacción: antes quedaba fuera, así que un fallo aquí
    // dejaba el traspaso hecho y el rol sin recalcular.
    await syncSwimmerRole(personId, tx);
    await audit(
      {
        userId: actor.userId,
        action: "SWIMMER_REASSIGNED",
        entityType: "ClubSwimmer",
        entityId: created.id,
        ipAddress: actor.ipAddress,
        before: current,
        after: created,
      },
      { tx }
    );
    return created;
  });

  return assignment;
}

/**
 * El club o su personal —delegado, entrenador y representante legal comparten
 * `CLUB_STAFF_PERMISSIONS`— proponen incorporar un nadador a su plantel. Queda
 * en estado `pending` hasta que un administrador la revise (A-05).
 *
 * No se exige que la persona tenga ya el rol `swimmer`: ese rol lo DERIVA
 * `syncSwimmerRole` de la membresía activa, así que pedirlo aquí sería exigir
 * el efecto para permitir la causa, y dejaría fuera del sistema a cualquier
 * nadador nuevo.
 */
export async function proposeAssignment(input: ProposeAssignmentInput, actor: ActorContext) {
  // El alcance decide, y es exhaustivo: un administrador pasa, el personal de
  // un club solo sobre SU club, y un nadador no opera a nivel de club.
  assertClubAccess(actor, input.clubId);
  await assertClubActive(input.clubId);

  const existingPending = await prisma.clubSwimmer.findFirst({
    where: { clubId: input.clubId, personId: input.personId, status: "pending" },
  });
  if (existingPending) {
    throw new ValidationError("Ya existe una solicitud pendiente para este nadador en este club");
  }

  const existingActiveSameClub = await prisma.clubSwimmer.findFirst({
    where: { clubId: input.clubId, personId: input.personId, status: "active" },
  });
  if (existingActiveSameClub) {
    throw new ValidationError("El nadador ya pertenece activamente a este club");
  }

  return withAudit(
    (tx) =>
      tx.clubSwimmer.create({
        data: {
          clubId: input.clubId,
          personId: input.personId,
          status: "pending",
          requestedByUserId: actor.userId,
        },
      }),
    (assignment) => ({
      userId: actor.userId,
      action: "SWIMMER_ASSIGNMENT_PROPOSED",
      entityType: "ClubSwimmer",
      entityId: assignment.id,
      ipAddress: actor.ipAddress,
      after: assignment,
    })
  );
}

/**
 * A-05: solo un administrador puede aprobar. RB-06/A-04: si la regla de
 * "un solo club activo" está habilitada y el nadador ya tiene una
 * asignación activa EN OTRO club, se bloquea la aprobación — el
 * administrador debe finalizar explícitamente la asignación anterior
 * primero (flujo auditable, sin swaps automáticos silenciosos).
 */
export async function approveAssignment(id: string, actor: ContextoDeAuditoria) {
  const before = await getAssignmentById(id);

  const transition = evaluateTransition(before.status, "approve");
  if (!transition.allowed) throw new ValidationError(transition.reason!);

  const currentActive = await getCurrentClubForPerson(before.personId);
  if (currentActive && currentActive.clubId !== before.clubId) {
    throw new ValidationError(
      `El nadador ya tiene una membresía activa en "${currentActive.club.name}". ` +
        `Debe finalizarla antes de aprobar esta nueva asignación.`
    );
  }

  const assignment = await prisma.$transaction(async (tx) => {
    const updated = await tx.clubSwimmer.update({
      where: { id },
      data: {
        status: "active",
        startDate: new Date(),
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
      },
    });
    await syncSwimmerRole(before.personId, tx);
    await audit(
      {
        userId: actor.userId,
        action: "SWIMMER_ASSIGNMENT_APPROVED",
        entityType: "ClubSwimmer",
        entityId: id,
        ipAddress: actor.ipAddress,
        before,
        after: updated,
      },
      { tx }
    );
    return updated;
  });

  return assignment;
}

export async function rejectAssignment(id: string, reason: string | undefined, actor: ContextoDeAuditoria) {
  const before = await getAssignmentById(id);

  const transition = evaluateTransition(before.status, "reject");
  if (!transition.allowed) throw new ValidationError(transition.reason!);

  return withAudit(
    (tx) =>
      tx.clubSwimmer.update({
        where: { id },
        data: { status: "rejected", reviewedByUserId: actor.userId, reviewedAt: new Date(), rejectionReason: reason ?? null },
      }),
    (assignment) => ({
      userId: actor.userId,
      action: "SWIMMER_ASSIGNMENT_REJECTED",
      entityType: "ClubSwimmer",
      entityId: id,
      ipAddress: actor.ipAddress,
      before,
      after: assignment,
    })
  );
}

export async function endAssignment(id: string, actor: ActorContext) {
  const before = await getAssignmentById(id);

  assertClubAccess(actor, before.clubId);

  const transition = evaluateTransition(before.status, "end");
  if (!transition.allowed) throw new ValidationError(transition.reason!);

  const assignment = await prisma.$transaction(async (tx) => {
    const updated = await tx.clubSwimmer.update({
      where: { id },
      data: { status: "ended", endDate: new Date() },
    });
    await syncSwimmerRole(before.personId, tx);
    await audit(
      {
        userId: actor.userId,
        action: "SWIMMER_ASSIGNMENT_ENDED",
        entityType: "ClubSwimmer",
        entityId: id,
        ipAddress: actor.ipAddress,
        before,
        after: updated,
      },
      { tx }
    );
    return updated;
  });

  return assignment;
}
