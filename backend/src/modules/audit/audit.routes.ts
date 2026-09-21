import type { FastifyInstance } from "fastify";
import * as auditService from "./audit.service";
import { auditLogListQuerySchema } from "./audit.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";

export async function auditRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/audit-logs", { preHandler: [requirePermission("audit:read")] }, async (req, reply) => {
    const parsed = auditLogListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros de filtro inválidos", parsed.error.flatten());
    reply.send(await auditService.listAuditLogs(parsed.data));
  });

  app.get("/audit-logs/filters", { preHandler: [requirePermission("audit:read")] }, async (_req, reply) => {
    reply.send(await auditService.listDistinctEntityTypesAndActions());
  });
}
