import { prisma } from "../../shared/prisma.client";
import { withAudit } from "../audit/audit.service";
import { ValidationError, NotFoundError } from "../../shared/errors";
import type { PoolCreateInput, PoolUpdateInput, PoolListQuery } from "./pools.schemas";

interface ActorContext {
  userId: string;
  ipAddress?: string;
}

export async function listPools(query: PoolListQuery) {
  const where: any = { deletedAt: null };
  if (query.search) {
    where.name = { contains: query.search.trim(), mode: "insensitive" };
  }
  return prisma.pool.findMany({ where, orderBy: { name: "asc" } });
}

export async function getPoolById(id: string) {
  const pool = await prisma.pool.findFirst({ where: { id, deletedAt: null } });
  if (!pool) throw new NotFoundError("Piscina");
  return pool;
}

export async function createPool(input: PoolCreateInput, actor: ActorContext) {
  return withAudit(
    (tx) =>
      tx.pool.create({
        data: {
          name: input.name,
          address: input.address || null,
          isHeated: input.isHeated,
          isCovered: input.isCovered,
          courseLength: input.courseLength,
        },
      }),
    (pool) => ({ userId: actor.userId, action: "POOL_CREATED", entityType: "Pool", entityId: pool.id, ipAddress: actor.ipAddress, after: pool })
  );
}

export async function updatePool(id: string, input: PoolUpdateInput, actor: ActorContext) {
  const before = await getPoolById(id);
  return withAudit(
    (tx) =>
      tx.pool.update({
        where: { id },
        data: {
          name: input.name ?? undefined,
          address: input.address !== undefined ? input.address || null : undefined,
          isHeated: input.isHeated ?? undefined,
          isCovered: input.isCovered ?? undefined,
          courseLength: input.courseLength ?? undefined,
        },
      }),
    (pool) => ({ userId: actor.userId, action: "POOL_UPDATED", entityType: "Pool", entityId: id, ipAddress: actor.ipAddress, before, after: pool })
  );
}

export async function deletePool(id: string, actor: ActorContext) {
  const before = await getPoolById(id);

  const inUse = await prisma.competition.count({ where: { poolId: id } });
  if (inUse > 0) {
    throw new ValidationError(`No se puede eliminar: esta piscina está seleccionada en ${inUse} competencia(s)`);
  }

  await withAudit(
    (tx) => tx.pool.update({ where: { id }, data: { deletedAt: new Date() } }),
    (pool) => ({ userId: actor.userId, action: "POOL_DELETED", entityType: "Pool", entityId: id, ipAddress: actor.ipAddress, before, after: pool })
  );
}
