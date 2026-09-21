import type { FastifyInstance } from "fastify";
import * as dashboardService from "./dashboard.service";
import { requireAuth, requireRole } from "../auth/rbac.middleware";

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/dashboard/stats", { preHandler: [requireRole("admin")] }, async (_req, reply) => {
    reply.send(await dashboardService.getDashboardStats());
  });
}
