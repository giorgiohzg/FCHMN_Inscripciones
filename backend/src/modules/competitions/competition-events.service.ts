import { prisma } from "../../shared/prisma.client";
import { audit, withAudit } from "../audit/audit.service";
import { ValidationError, NotFoundError } from "../../shared/errors";
import { dbFrom, type Db, type TxOption } from "../../shared/transaction";
import type { AddCompetitionEventInput, UpdateCompetitionEventInput } from "./competitions.schemas";

interface ActorContext {
  userId: string;
  ipAddress?: string;
}

const include = {
  event: {
    include: { testType: true, distance: true, stroke: true },
  },
  competitionSession: { include: { sessionType: true, competitionDate: true } },
  enabledCategories: { include: { category: { include: { categoryGroup: true } } } },
} as const;

/**
 * Las categorías habilitadas para esta prueba EN esta competencia deben
 * pertenecer al MISMO TIPO DE PRUEBA (Individual/Relevo) que la prueba
 * maestra — ya no se restringen a un subconjunto pre-seleccionado por
 * prueba (esa relación se eliminó del Módulo 5 por pedido explícito).
 */
async function assertCategoriesAllowedForEvent(eventId: string, categoryIds: string[], db: Db = prisma) {
  // Hallazgo 13 (reapertura): una prueba maestra ELIMINADA lógicamente no
  // puede asignarse a una competencia. Antes `findUnique` la encontraba
  // igual, así que un catálogo retirado seguía usándose para armar
  // competencias nuevas — solo desaparecía de los listados.
  const event = await db.event.findFirst({ where: { id: eventId, deletedAt: null } });
  if (!event) throw new NotFoundError("Prueba");

  const categories = await db.category.findMany({ where: { id: { in: categoryIds }, deletedAt: null } });
  if (categories.length !== categoryIds.length) {
    throw new ValidationError("Una o más categorías seleccionadas no existen");
  }
  const firstMismatch = categories.find((c) => c.testTypeId !== event.testTypeId);
  if (firstMismatch) {
    throw new ValidationError(
      `Las categorías deben pertenecer al mismo tipo de prueba de la competencia (categoría en conflicto: "${firstMismatch.name}")`
    );
  }
  return event;
}

export async function listCompetitionEvents(competitionId: string) {
  return prisma.competitionEvent.findMany({
    where: { competitionId },
    include,
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
}

export async function getCompetitionEventById(id: string) {
  const ce = await prisma.competitionEvent.findUnique({ where: { id }, include });
  if (!ce) throw new NotFoundError("Prueba de competencia");
  return ce;
}

/**
 * Hallazgo 6: la jornada elegida debe pertenecer a ESTA competencia.
 *
 * Antes solo se comprobaba que la jornada existiera. Enviando el id de una
 * jornada de otra competencia, la prueba quedaba asociada a una fecha y
 * jornada ajenas: los límites por jornada se contaban contra la competencia
 * equivocada y los reportes por fecha mostraban la prueba en el día de otra
 * competencia. La base de datos también lo impide ahora, mediante una clave
 * foránea compuesta (ver la migración `phase2_integrity`); esta comprobación
 * existe para dar un mensaje entendible antes de llegar a ese error.
 */
async function assertSessionBelongsToCompetition(competitionSessionId: string, competitionId: string, db: Db = prisma) {
  const session = await db.competitionSession.findUnique({
    where: { id: competitionSessionId },
    include: { competitionDate: { select: { competitionId: true } }, sessionType: { select: { name: true } } },
  });
  if (!session) throw new ValidationError("La jornada seleccionada no existe");

  if (session.competitionDate.competitionId !== competitionId) {
    throw new ValidationError("La jornada seleccionada pertenece a otra competencia.");
  }
  return session;
}

export async function addCompetitionEvent(
  competitionId: string,
  input: AddCompetitionEventInput,
  actor: ActorContext,
  options?: TxOption
) {
  const db = dbFrom(options);
  const competition = await db.competition.findUnique({ where: { id: competitionId } });
  if (!competition) throw new NotFoundError("Competencia");

  await assertSessionBelongsToCompetition(input.competitionSessionId, competitionId, db);

  await assertCategoriesAllowedForEvent(input.eventId, input.categoryIds, db);

  // Una prueba no puede repetirse en ninguna parte de la misma competencia
  // (no solo dentro de la misma jornada) — el catálogo de pruebas es
  // único por competencia.
  const duplicate = await db.competitionEvent.findFirst({
    where: { competitionId, eventId: input.eventId },
  });
  if (duplicate) throw new ValidationError("Esta prueba ya está asignada en esta competencia — no se puede repetir la misma prueba dos veces.");

  return withAudit(
    (tx) =>
      tx.competitionEvent.create({
        data: {
          competitionId,
          eventId: input.eventId,
          competitionSessionId: input.competitionSessionId,
          displayOrder: input.displayOrder ?? null,
          enabledCategories: { create: input.categoryIds.map((categoryId) => ({ categoryId })) },
        },
        include,
      }),
    (competitionEvent) => ({
      userId: actor.userId,
      action: "COMPETITION_EVENT_ADDED",
      entityType: "CompetitionEvent",
      entityId: competitionEvent.id,
      ipAddress: actor.ipAddress,
      after: competitionEvent,
    }),
    options
  );
}

/**
 * Actualiza el número (displayOrder) de VARIAS pruebas a la vez, en una
 * sola solicitud — reemplaza el patrón anterior de disparar una llamada
 * PUT por cada prueba afectada (`Promise.all` en el frontend), que en una
 * competencia con muchas pruebas podía disparar decenas de solicitudes en
 * paralelo y hacer saltar el límite de solicitudes por minuto del
 * servidor. Se usa al reordenar o mover una prueba entre jornadas/fechas
 * en el tablero de "Pruebas de la competencia", donde un solo movimiento
 * puede renumerar toda la competencia.
 */
export async function reorderCompetitionEvents(updates: { id: string; displayOrder: number }[], actor: ActorContext) {
  if (updates.length === 0) return { updated: 0 };

  await withAudit(
    async (tx) => {
      for (const u of updates) {
        await tx.competitionEvent.update({ where: { id: u.id }, data: { displayOrder: u.displayOrder } });
      }
    },
    () => ({
      userId: actor.userId,
      action: "COMPETITION_EVENTS_REORDERED",
      entityType: "CompetitionEvent",
      entityId: updates.map((u) => u.id).join(","),
      ipAddress: actor.ipAddress,
      after: { count: updates.length },
    })
  );

  return { updated: updates.length };
}

export async function updateCompetitionEvent(id: string, input: UpdateCompetitionEventInput, actor: ActorContext) {
  const before = await getCompetitionEventById(id);

  if (input.categoryIds) {
    await assertCategoriesAllowedForEvent(before.eventId, input.categoryIds);
  }

  if (input.competitionSessionId && input.competitionSessionId !== before.competitionSessionId) {
    await assertSessionBelongsToCompetition(input.competitionSessionId, before.competitionId);

    // Mover una prueba que YA tiene inscripciones cambia la fecha y jornada
    // bajo las que se validaron esas inscripciones: los máximos por jornada
    // se calcularon contra la jornada anterior y los reportes por fecha
    // mostrarían a los nadadores en un día en el que nunca se inscribieron.
    //
    // Se cuenta CUALQUIER inscripción, no solo las confirmadas: una
    // cancelada también quedó registrada bajo una fecha y jornada concretas,
    // y moverla cambiaría retroactivamente el historial (la auditoría diría
    // que se canceló una inscripción de la jornada de la mañana cuando la
    // prueba figura por la tarde).
    const [individuales, relevos] = await Promise.all([
      prisma.registration.count({ where: { competitionEventId: id } }),
      prisma.relayRegistration.count({ where: { competitionEventId: id } }),
    ]);
    if (individuales + relevos > 0) {
      throw new ValidationError(
        `No se puede mover esta prueba a otra jornada: su historial tiene ${individuales} inscripción(es) individual(es) y ${relevos} de relevo ` +
          `(incluidas las canceladas), registradas bajo la fecha y jornada actuales. ` +
          `Cree la prueba en la jornada de destino y deshabilite esta, para no alterar lo ya registrado.`,
        { individualRegistrations: individuales, relayRegistrations: relevos, suggestion: "create-and-disable" }
      );
    }
  }

  const competitionEvent = await prisma.$transaction(async (tx) => {
    await tx.competitionEvent.update({
      where: { id },
      data: {
        competitionSessionId: input.competitionSessionId ?? undefined,
        status: input.status ?? undefined,
        displayOrder: input.displayOrder !== undefined ? input.displayOrder : undefined,
      },
    });

    if (input.categoryIds) {
      await tx.competitionEventCategory.deleteMany({ where: { competitionEventId: id } });
      await tx.competitionEventCategory.createMany({ data: input.categoryIds.map((categoryId) => ({ competitionEventId: id, categoryId })) });
    }

    const actualizado = await tx.competitionEvent.findUniqueOrThrow({ where: { id }, include });

    await audit(
      {
        userId: actor.userId,
        action: "COMPETITION_EVENT_UPDATED",
        entityType: "CompetitionEvent",
        entityId: id,
        ipAddress: actor.ipAddress,
        before,
        after: actualizado,
      },
      { tx }
    );

    return actualizado;
  });

  return competitionEvent;
}

/**
 * RB-13: elimina SOLO la relación `competition_events`. La prueba maestra
 * (`Event`, Módulo 5) nunca se toca por esta operación.
 *
 * Hallazgo 7 — la eliminación ya no destruye inscripciones. La clave foránea
 * era `ON DELETE CASCADE`: borrar una prueba de la competencia borraba
 * silenciosamente todas sus inscripciones individuales y de relevo, sin
 * aviso, sin confirmación y sin dejar rastro de qué se perdió (la auditoría
 * solo guardaba la prueba, no las inscripciones arrastradas).
 *
 * Ahora, si existe CUALQUIER inscripción —incluidas las canceladas, que son
 * parte del historial— la eliminación se rechaza y se ofrece la alternativa
 * no destructiva: deshabilitar la prueba (`status = disabled`), que la retira
 * de las inscripciones nuevas conservando todo lo registrado. La base de
 * datos respalda la regla con `ON DELETE RESTRICT`.
 */
export async function removeCompetitionEvent(id: string, actor: ActorContext) {
  const before = await getCompetitionEventById(id);

  const [individuales, relevos] = await Promise.all([
    prisma.registration.count({ where: { competitionEventId: id } }),
    prisma.relayRegistration.count({ where: { competitionEventId: id } }),
  ]);

  if (individuales + relevos > 0) {
    throw new ValidationError(
      `No se puede eliminar esta prueba de la competencia: tiene ${individuales} inscripción(es) individual(es) y ${relevos} de relevo en su historial. ` +
        `Para retirarla de la competencia sin perder ese historial, deshabilítela en vez de eliminarla.`,
      { individualRegistrations: individuales, relayRegistrations: relevos, suggestion: "disable" }
    );
  }

  await withAudit(
    (tx) => tx.competitionEvent.delete({ where: { id } }),
    () => ({ userId: actor.userId, action: "COMPETITION_EVENT_REMOVED", entityType: "CompetitionEvent", entityId: id, ipAddress: actor.ipAddress, before })
  );
}
