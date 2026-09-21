import { prisma } from "../../shared/prisma.client";
import { withAudit } from "../audit/audit.service";
import { ValidationError, NotFoundError } from "../../shared/errors";
import type { EventCreateInput, EventUpdateInput, EventListQuery } from "./catalogs.schemas";

interface ActorContext {
  userId: string;
  ipAddress?: string;
}

const eventInclude = {
  testType: { select: { id: true, name: true, swimmersCount: true } },
  distance: { select: { id: true, meters: true } },
  stroke: { select: { id: true, name: true } },
} as const;

export async function listEvents(query: EventListQuery) {
  const where: any = { deletedAt: null };
  if (query.testTypeId) where.testTypeId = query.testTypeId;
  if (query.distanceId) where.distanceId = query.distanceId;
  if (query.strokeId) where.strokeId = query.strokeId;
  if (query.gender) where.gender = query.gender;

  const [items, total] = await Promise.all([
    prisma.event.findMany({
      where,
      include: eventInclude,
      // La distancia se repite en muchos eventos: `id` cierra el orden.
      orderBy: [{ distance: { meters: "asc" } }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.event.count({ where }),
  ]);

  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getEventById(id: string) {
  const event = await prisma.event.findFirst({ where: { id, deletedAt: null }, include: eventInclude });
  if (!event) throw new NotFoundError("Prueba");
  return event;
}

export async function createEvent(input: EventCreateInput, actor: ActorContext) {
  const [testType, distance, stroke] = await Promise.all([
    prisma.testType.findUnique({ where: { id: input.testTypeId } }),
    prisma.distance.findUnique({ where: { id: input.distanceId } }),
    prisma.stroke.findUnique({ where: { id: input.strokeId } }),
  ]);
  if (!testType) throw new ValidationError("El tipo de prueba seleccionado no existe");
  if (!distance) throw new ValidationError("La distancia seleccionada no existe");
  if (!stroke) throw new ValidationError("El estilo seleccionado no existe");

  const duplicate = await prisma.event.findFirst({
    where: { testTypeId: input.testTypeId, distanceId: input.distanceId, strokeId: input.strokeId, gender: input.gender, deletedAt: null },
  });
  if (duplicate) throw new ValidationError("Ya existe una prueba con esta combinación de tipo, distancia, estilo y género");

  return withAudit(
    (tx) =>
      tx.event.create({
        data: {
          testTypeId: input.testTypeId,
          distanceId: input.distanceId,
          strokeId: input.strokeId,
          gender: input.gender,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
        include: eventInclude,
      }),
    (event) => ({ userId: actor.userId, action: "EVENT_CREATED", entityType: "Event", entityId: event.id, ipAddress: actor.ipAddress, after: event })
  );
}

export async function updateEvent(id: string, input: EventUpdateInput, actor: ActorContext) {
  const before = await getEventById(id);

  const event = await withAudit(
    (tx) =>
      tx.event.update({
        where: { id },
        data: { gender: input.gender ?? undefined, updatedBy: actor.userId },
        include: eventInclude,
      }),
    (event) => ({ userId: actor.userId, action: "EVENT_UPDATED", entityType: "Event", entityId: id, ipAddress: actor.ipAddress, before, after: event })
  );
  return event;
}

/**
 * RB-13: eliminación lógica de la prueba maestra. Esto NUNCA ocurre como
 * efecto secundario de quitar la prueba de una competencia (Módulo 6) —
 * esa acción solo borra la relación `competition_events`, nunca esta fila.
 */
export async function softDeleteEvent(id: string, actor: ActorContext) {
  const before = await getEventById(id);
  const event = await withAudit(
    (tx) => tx.event.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: actor.userId } }),
    (event) => ({ userId: actor.userId, action: "EVENT_DELETED", entityType: "Event", entityId: id, ipAddress: actor.ipAddress, before, after: event })
  );
  return event;
}
