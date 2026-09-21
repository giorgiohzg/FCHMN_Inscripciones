import { prisma } from "../../shared/prisma.client";
import { withAudit } from "../audit/audit.service";
import { ValidationError, NotFoundError } from "../../shared/errors";

interface ActorContext {
  userId: string;
  ipAddress?: string;
}

// --------------------------------------------------------------------------
// Tipos de prueba (sección 6) — catálogo sembrado, extensible a futuro.
// --------------------------------------------------------------------------

export function listTestTypes() {
  return prisma.testType.findMany({ orderBy: { name: "asc" } });
}

// --------------------------------------------------------------------------
// Distancias (sección 8) — catálogo extensible.
// --------------------------------------------------------------------------

export function listDistances() {
  return prisma.distance.findMany({ orderBy: { meters: "asc" } });
}

export async function createDistance(meters: number, actor: ActorContext) {
  const existing = await prisma.distance.findUnique({ where: { meters } });
  if (existing) throw new ValidationError("Ya existe una distancia con ese valor");

  const distance = await withAudit(
    (tx) => tx.distance.create({ data: { meters } }),
    (distance) => ({ userId: actor.userId, action: "DISTANCE_CREATED", entityType: "Distance", entityId: distance.id, ipAddress: actor.ipAddress, after: distance })
  );
  return distance;
}

export async function updateDistance(id: string, meters: number, actor: ActorContext) {
  const before = await prisma.distance.findUnique({ where: { id } });
  if (!before) throw new NotFoundError("Distancia");

  const duplicate = await prisma.distance.findFirst({ where: { meters, id: { not: id } } });
  if (duplicate) throw new ValidationError("Ya existe otra distancia con ese valor");

  const distance = await withAudit(
    (tx) => tx.distance.update({ where: { id }, data: { meters } }),
    (distance) => ({ userId: actor.userId, action: "DISTANCE_UPDATED", entityType: "Distance", entityId: id, ipAddress: actor.ipAddress, before, after: distance })
  );
  return distance;
}

export async function deleteDistance(id: string, actor: ActorContext) {
  const before = await prisma.distance.findUnique({ where: { id } });
  if (!before) throw new NotFoundError("Distancia");

  const inUse = await prisma.event.count({ where: { distanceId: id, deletedAt: null } });
  if (inUse > 0) {
    throw new ValidationError(`No se puede eliminar: esta distancia está en uso por ${inUse} prueba(s) del catálogo`);
  }

  await withAudit(
    (tx) => tx.distance.delete({ where: { id } }),
    (_resultado) => ({ userId: actor.userId, action: "DISTANCE_DELETED", entityType: "Distance", entityId: id, ipAddress: actor.ipAddress, before })
  );
}

// --------------------------------------------------------------------------
// Estilos (sección 8) — catálogo extensible.
// --------------------------------------------------------------------------

export function listStrokes() {
  return prisma.stroke.findMany({ orderBy: { name: "asc" } });
}

export async function createStroke(name: string, actor: ActorContext) {
  const existing = await prisma.stroke.findUnique({ where: { name } });
  if (existing) throw new ValidationError("Ya existe un estilo con ese nombre");

  const stroke = await withAudit(
    (tx) => tx.stroke.create({ data: { name } }),
    (stroke) => ({ userId: actor.userId, action: "STROKE_CREATED", entityType: "Stroke", entityId: stroke.id, ipAddress: actor.ipAddress, after: stroke })
  );
  return stroke;
}

export async function updateStroke(id: string, name: string, actor: ActorContext) {
  const before = await prisma.stroke.findUnique({ where: { id } });
  if (!before) throw new NotFoundError("Estilo");

  const duplicate = await prisma.stroke.findFirst({ where: { name, id: { not: id } } });
  if (duplicate) throw new ValidationError("Ya existe otro estilo con ese nombre");

  const stroke = await withAudit(
    (tx) => tx.stroke.update({ where: { id }, data: { name } }),
    (stroke) => ({ userId: actor.userId, action: "STROKE_UPDATED", entityType: "Stroke", entityId: id, ipAddress: actor.ipAddress, before, after: stroke })
  );
  return stroke;
}

export async function deleteStroke(id: string, actor: ActorContext) {
  const before = await prisma.stroke.findUnique({ where: { id } });
  if (!before) throw new NotFoundError("Estilo");

  const inUse = await prisma.event.count({ where: { strokeId: id, deletedAt: null } });
  if (inUse > 0) {
    throw new ValidationError(`No se puede eliminar: este estilo está en uso por ${inUse} prueba(s) del catálogo`);
  }

  await withAudit(
    (tx) => tx.stroke.delete({ where: { id } }),
    (_resultado) => ({ userId: actor.userId, action: "STROKE_DELETED", entityType: "Stroke", entityId: id, ipAddress: actor.ipAddress, before })
  );
}
