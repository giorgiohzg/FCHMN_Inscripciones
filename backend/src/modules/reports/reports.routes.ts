import type { FastifyInstance } from "fastify";
import * as reportsService from "./reports.service";
import { csvDelReporteDetallado } from "./reporteDetallado.rules";
import { pdfDelReporteDetallado, xlsxDelReporteDetallado } from "./reporteDetallado.archivos";
import * as resumenPorClub from "./resumenPorClub.service";
import * as clubesYNadadores from "./clubesYNadadores.service";
import * as clubesYNadadoresReglas from "./clubesYNadadores.rules";
import { competenciaDelReporteQuerySchema, exportFormatSchema, registrationsReportQuerySchema, resumenPorClubQuerySchema } from "./reports.schemas";
import { requireAuth, requirePermission, requireRole } from "../auth/rbac.middleware";
import { requireFuncion } from "../accesos/accesos.middleware";
import { ValidationError } from "../../shared/errors";
import { audit } from "../audit/audit.service";
import { buildActorContext } from "../../shared/actorContext";

export async function reportsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/reports/registrations", { preHandler: [requirePermission("reports:read"), requireFuncion("reportes.generar")] }, async (req, reply) => {
    const parsed = registrationsReportQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros de filtro inválidos", parsed.error.flatten());
    reply.send(await reportsService.getRegistrationsReport(parsed.data, buildActorContext(req)));
  });

  /**
   * Exclusivos de ADMINISTRACIÓN, en el servidor y no solo en la interfaz: `requireRole("admin")`
   * se evalúa con los roles VIGENTES (recargados de la base en cada solicitud), y el servicio
   * vuelve a exigir el alcance de administración. Quien combina administración con otro rol
   * pasa; cualquier otro rol recibe 403, aunque tenga `reports:read`.
   */

  /** Opciones del selector de clubes: los clubes con inscripciones confirmadas en la competencia. */
  app.get("/reports/registrations/clubs", { preHandler: [requirePermission("reports:read"), requireRole("admin")] }, async (req, reply) => {
    const parsed = competenciaDelReporteQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros de filtro inválidos", parsed.error.flatten());
    reply.send(await resumenPorClub.listarClubesConInscripciones(parsed.data.competitionId, buildActorContext(req)));
  });

  /**
   * Resumen de inscripciones por club: cifras agregadas, sin datos personales. `edadMinima`
   * (opcional, 70 por omisión) solo cambia la columna de edad; ver `resumenPorClubQuerySchema`.
   */
  app.get("/reports/clubs-summary", { preHandler: [requirePermission("reports:read"), requireRole("admin")] }, async (req, reply) => {
    const parsed = resumenPorClubQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros de filtro inválidos", parsed.error.flatten());
    reply.send(await resumenPorClub.obtenerResumenPorClub(parsed.data.competitionId, buildActorContext(req), parsed.data.edadMinima));
  });

  /**
   * Reporte GENERAL «Clubes y nadadores»: pertenencia vigente, independiente de las competencias
   * (no recibe ni consulta ninguna). Exclusivo de administración en ambas rutas, con el mismo
   * doble control que el resumen por club. La exportación genera el archivo completo antes de
   * auditar.
   */
  app.get("/reports/clubes-y-nadadores", { preHandler: [requirePermission("reports:read"), requireRole("admin")] }, async (req, reply) => {
    reply.send(await clubesYNadadores.obtenerClubesYNadadores(buildActorContext(req)));
  });

  app.get("/reports/clubes-y-nadadores/export", { preHandler: [requirePermission("reports:read"), requireRole("admin")] }, async (req, reply) => {
    const parsed = exportFormatSchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Formato de exportación inválido (use csv, xlsx o pdf)", parsed.error.flatten());
    const { format } = parsed.data;
    const reporte = await clubesYNadadores.obtenerClubesYNadadores(buildActorContext(req));
    const body =
      format === "csv"
        ? clubesYNadadoresReglas.csvDelReporte(reporte)
        : format === "xlsx"
          ? await clubesYNadadores.xlsxDelReporte(reporte)
          : await clubesYNadadores.pdfDelReporte(reporte);
    await audit({
      userId: req.authUser!.sub,
      action: "REPORT_EXPORTED",
      entityType: "Report",
      entityId: "clubes-y-nadadores",
      ipAddress: req.ip,
      after: { format, reporte: "clubes-y-nadadores", ...reporte.totales },
    });
    const CONTENT_TYPES = { csv: "text/csv; charset=utf-8", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pdf: "application/pdf" } as const;
    reply
      .header("Content-Type", CONTENT_TYPES[format])
      .header("Content-Disposition", `attachment; filename="${clubesYNadadores.NOMBRE_DE_ARCHIVO}.${format}"`)
      .send(body);
  });

  app.get("/reports/registrations/export", { preHandler: [requirePermission("reports:read"), requireFuncion("reportes.exportar")] }, async (req, reply) => {
    const query = req.query as Record<string, string>;
    const parsed = registrationsReportQuerySchema.safeParse(query);
    if (!parsed.success) throw new ValidationError("Parámetros de filtro inválidos", parsed.error.flatten());

    const format = query.format;
    if (!format || !["csv", "xlsx", "pdf"].includes(format)) {
      throw new ValidationError("Formato de exportación inválido (use csv, xlsx o pdf)");
    }

    const actor = buildActorContext(req);
    // Los tres archivos presentan la MISMA estructura agrupada que la pantalla, con los mismos filtros y alcance.
    const reporte = await reportsService.getRegistrationsReport(parsed.data, actor);
    const { competitionName, individualRows, relayRows } = reporte;
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
      body = csvDelReporteDetallado(reporte);
    } else if (format === "xlsx") {
      body = await xlsxDelReporteDetallado(reporte);
    } else {
      body = await pdfDelReporteDetallado(reporte);
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
