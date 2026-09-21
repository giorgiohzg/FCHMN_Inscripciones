import type { FastifyInstance } from "fastify";
import * as exportService from "./team-manager-export.service";
import { teamManagerExportQuerySchema } from "./team-manager-export.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";

export async function teamManagerExportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /**
   * Descarga el archivo .HY3 (formato Hy-Tek Team Manager) con las
   * inscripciones individuales confirmadas de un club en una competencia.
   */
  app.get("/export/team-manager/hy3", { preHandler: [requirePermission("export:team-manager")] }, async (req, reply) => {
    const parsed = teamManagerExportQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros inválidos", parsed.error.flatten());

    const { filename, content } = await exportService.buildTeamManagerHy3Export(
      parsed.data.competitionId,
      parsed.data.clubId,
      { userId: req.authUser!.sub, ipAddress: req.ip }
    );

    // Team Manager espera el archivo en ISO-8859-1 (Latin-1), igual que el
    // archivo de muestra original — no UTF-8.
    const buffer = Buffer.from(content, "latin1");

    reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(buffer);
  });
}
