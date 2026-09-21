import { prisma } from "../../shared/prisma.client";
import { withAudit } from "../audit/audit.service";
import { ValidationError, NotFoundError } from "../../shared/errors";
import { dbFrom, type Db, type TxOption } from "../../shared/transaction";
import type { SessionLimitInput } from "./competitions.schemas";

interface ActorContext {
  userId: string;
  ipAddress?: string;
}

// ---------------- Tipos de jornada (catálogo extensible) ----------------

export function listSessionTypes() {
  return prisma.sessionType.findMany({ orderBy: { name: "asc" } });
}

export async function createSessionType(name: string, actor: ActorContext) {
  const existing = await prisma.sessionType.findUnique({ where: { name } });
  if (existing) throw new ValidationError("Ya existe un tipo de jornada con ese nombre");
  const sessionType = await withAudit(
    (tx) => tx.sessionType.create({ data: { name } }),
    (sessionType) => ({ userId: actor.userId, action: "SESSION_TYPE_CREATED", entityType: "SessionType", entityId: sessionType.id, ipAddress: actor.ipAddress, after: sessionType })
  );
  return sessionType;
}

// ---------------- Fechas de competencia ----------------

async function assertCompetitionExists(competitionId: string, db: Db = prisma) {
  const competition = await db.competition.findUnique({ where: { id: competitionId } });
  if (!competition) throw new NotFoundError("Competencia");
  return competition;
}

export async function addCompetitionDate(competitionId: string, date: Date, actor: ActorContext, options?: TxOption) {
  const db = dbFrom(options);
  await assertCompetitionExists(competitionId, db);

  const existing = await db.competitionDate.findFirst({ where: { competitionId, date } });
  if (existing) throw new ValidationError("Esta fecha ya fue agregada a la competencia");

  return withAudit(
    (tx) => tx.competitionDate.create({ data: { competitionId, date } }),
    (competitionDate) => ({
      userId: actor.userId,
      action: "COMPETITION_DATE_ADDED",
      entityType: "CompetitionDate",
      entityId: competitionDate.id,
      ipAddress: actor.ipAddress,
      after: competitionDate,
    }),
    options
  );
}

export async function removeCompetitionDate(dateId: string, actor: ActorContext) {
  const before = await prisma.competitionDate.findUnique({ where: { id: dateId } });
  if (!before) throw new NotFoundError("Fecha de competencia");

  const [individualCount, relayCount] = await Promise.all([
    prisma.registration.count({ where: { competitionEvent: { competitionSession: { competitionDateId: dateId } } } }),
    prisma.relayRegistration.count({ where: { competitionEvent: { competitionSession: { competitionDateId: dateId } } } }),
  ]);
  if (individualCount > 0 || relayCount > 0) {
    // El conteo incluye las inscripciones CANCELADAS, que son historial y no
    // desaparecen al cancelarlas. El mensaje anterior decía "cancele esas
    // inscripciones primero", una instrucción que no desbloquea nada: quien
    // la seguía cancelaba todo y volvía a chocar con el mismo error.
    throw new ValidationError(
      `No se puede eliminar esta fecha: sus pruebas tienen ${individualCount + relayCount} inscripción(es) en el historial (incluidas las canceladas). ` +
        `Eliminarla borraría ese registro. Si la fecha ya no se va a competir, deshabilite sus pruebas; si la competencia completa no se realizará, cancélela.`,
      { individualRegistrations: individualCount, relayRegistrations: relayCount, suggestion: "disable-events-or-cancel-competition" }
    );
  }

  // onDelete: Cascade en el schema se encarga de jornadas/límites/pruebas asociadas.
  await withAudit(
    (tx) => tx.competitionDate.delete({ where: { id: dateId } }),
    (_resultado) => ({ userId: actor.userId, action: "COMPETITION_DATE_REMOVED", entityType: "CompetitionDate", entityId: dateId, ipAddress: actor.ipAddress, before })
  );
}

// ---------------- Jornadas dentro de una fecha ----------------

export async function addSession(competitionDateId: string, sessionTypeId: string, actor: ActorContext, options?: TxOption) {
  const db = dbFrom(options);
  const date = await db.competitionDate.findUnique({ where: { id: competitionDateId } });
  if (!date) throw new NotFoundError("Fecha de competencia");

  const sessionType = await db.sessionType.findUnique({ where: { id: sessionTypeId } });
  if (!sessionType) throw new ValidationError("Tipo de jornada inválido");

  const existing = await db.competitionSession.findFirst({ where: { competitionDateId, sessionTypeId } });
  if (existing) throw new ValidationError(`Ya existe una jornada '${sessionType.name}' para esta fecha`);

  return withAudit(
    (tx) =>
      tx.competitionSession.create({
        // `competitionId` se deriva de la fecha: es la columna que permite
        // garantizar en base de datos que una prueba no se asocie a la jornada
        // de otra competencia. Un disparador la recalcula igualmente, así que
        // este valor y el de la base no pueden divergir.
        data: { competitionDateId, sessionTypeId, competitionId: date.competitionId },
        include: { sessionType: true },
      }),
    (session) => ({
      userId: actor.userId,
      action: "COMPETITION_SESSION_ADDED",
      entityType: "CompetitionSession",
      entityId: session.id,
      ipAddress: actor.ipAddress,
      after: session,
    }),
    options
  );
}

export async function removeSession(sessionId: string, actor: ActorContext) {
  const before = await prisma.competitionSession.findUnique({ where: { id: sessionId } });
  if (!before) throw new NotFoundError("Jornada");

  const [individualCount, relayCount] = await Promise.all([
    prisma.registration.count({ where: { competitionEvent: { competitionSessionId: sessionId } } }),
    prisma.relayRegistration.count({ where: { competitionEvent: { competitionSessionId: sessionId } } }),
  ]);
  if (individualCount > 0 || relayCount > 0) {
    // Mismo criterio y misma corrección de mensaje que en
    // `removeCompetitionDate`: el conteo incluye canceladas, así que
    // "cancele las inscripciones" no era una salida.
    throw new ValidationError(
      `No se puede eliminar esta jornada: sus pruebas tienen ${individualCount + relayCount} inscripción(es) en el historial (incluidas las canceladas). ` +
        `Eliminarla borraría ese registro. Si la jornada ya no se va a competir, deshabilite sus pruebas.`,
      { individualRegistrations: individualCount, relayRegistrations: relayCount, suggestion: "disable-events" }
    );
  }

  await withAudit(
    (tx) => tx.competitionSession.delete({ where: { id: sessionId } }),
    (_resultado) => ({ userId: actor.userId, action: "COMPETITION_SESSION_REMOVED", entityType: "CompetitionSession", entityId: sessionId, ipAddress: actor.ipAddress, before })
  );
}

/**
 * Sección 12: define/actualiza los límites de pruebas individuales y de
 * relevos para una fecha+jornada. NULL en cualquiera de los dos campos
 * significa "sin límite".
 */
export async function setSessionLimit(sessionId: string, input: SessionLimitInput, actor: ActorContext) {
  const session = await prisma.competitionSession.findUnique({ where: { id: sessionId }, include: { limit: true } });
  if (!session) throw new NotFoundError("Jornada");

  const before = session.limit;
  const limit = await withAudit(
    (tx) =>
      tx.sessionLimit.upsert({
        where: { competitionSessionId: sessionId },
        update: { maxIndividualEvents: input.maxIndividualEvents, maxRelayEvents: input.maxRelayEvents },
        create: { competitionSessionId: sessionId, maxIndividualEvents: input.maxIndividualEvents, maxRelayEvents: input.maxRelayEvents },
      }),
    (limit) => ({ userId: actor.userId, action: "SESSION_LIMIT_SET", entityType: "SessionLimit", entityId: limit.id, ipAddress: actor.ipAddress, before, after: limit })
  );
  return limit;
}
