import type { FastifyInstance } from "fastify";
import * as reportsService from "./reports.service";
import { registrationsReportQuerySchema } from "./reports.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";
import { audit } from "../audit/audit.service";
import { buildActorContext } from "../../shared/actorContext";

export async function reportsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/reports/registrations", { preHandler: [requirePermission("reports:read")] }, async (req, reply) => {
    const parsed = registrationsReportQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros de filtro inválidos", parsed.error.flatten());
    reply.send(await reportsService.getRegistrationsReport(parsed.data, buildActorContext(req)));
  });

  app.get("/reports/registrations/export", { preHandler: [requirePermission("reports:read")] }, async (req, reply) => {
    const query = req.query as Record<string, string>;
    const parsed = registrationsReportQuerySchema.safeParse(query);
    if (!parsed.success) throw new ValidationError("Parámetros de filtro inválidos", parsed.error.flatten());

    const format = query.format;
    if (!format || !["csv", "xlsx", "pdf"].includes(format)) {
      throw new ValidationError("Formato de exportación inválido (use csv, xlsx o pdf)");
    }

    const { competitionName, individualRows, relayRows } = await reportsService.getRegistrationsReport(parsed.data, buildActorContext(req));
    const safeName = competitionName.replace(/[^\w\- ]/g, "").replace(/\s+/g, "_");

    // El archivo se genera ANTES de auditar. Antes la auditoría se escribía
    // primero: si `buildXlsx`/`buildPdf` fallaba, quedaba registrada una
    // exportación que nunca se entregó.
    const CONTENT_TYPES: Record<string, string> = {
      csv: "text/csv; charset=utf-8",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pdf: "application/pdf",
    };

    let body: string | Buffer;
    if (format === "csv") {
      body = reportsService.buildCsv(individualRows, relayRows);
    } else if (format === "xlsx") {
      body = await reportsService.buildXlsx(individualRows, relayRows);
    } else {
      body = await reportsService.buildPdf(competitionName, individualRows, relayRows);
    }

    await audit({
      userId: req.authUser!.sub,
      action: "REPORT_EXPORTED",
      entityType: "Competition",
      entityId: parsed.data.competitionId,
      ipAddress: req.ip,
      after: { format, filters: parsed.data, individualCount: individualRows.length, relayCount: relayRows.length },
    });

    reply
      .header("Content-Type", CONTENT_TYPES[format]!)
      .header("Content-Disposition", `attachment; filename="Inscritos_${safeName}.${format}"`)
      .send(body);
  });
}
