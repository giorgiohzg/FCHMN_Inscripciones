import type { FastifyInstance } from "fastify";
import * as poolsService from "./pools.service";
import { poolCreateSchema, poolUpdateSchema, poolListQuerySchema } from "./pools.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";

export async function poolsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/pools", { preHandler: [requirePermission("catalogs:read")] }, async (req, reply) => {
    const parsed = poolListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros de búsqueda inválidos", parsed.error.flatten());
    reply.send(await poolsService.listPools(parsed.data));
  });

  app.get("/pools/:id", { preHandler: [requirePermission("catalogs:read")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await poolsService.getPoolById(id));
  });

  app.post("/pools", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const parsed = poolCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de la piscina inválidos", parsed.error.flatten());
    const pool = await poolsService.createPool(parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(pool);
  });

  app.put("/pools/:id", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = poolUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de la piscina inválidos", parsed.error.flatten());
    reply.send(await poolsService.updatePool(id, parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.delete("/pools/:id", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await poolsService.deletePool(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(204).send();
  });
}
