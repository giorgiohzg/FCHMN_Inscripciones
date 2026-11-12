import { z } from "zod";
import { uuidField } from "../../shared/uuid.schema";

export const registrationsReportQuerySchema = z.object({
  competitionId: uuidField("Debe seleccionar una competencia"),
  clubId: uuidField().optional(),
  competitionDateId: uuidField().optional(),
  sessionTypeId: uuidField().optional(),
  competitionEventId: uuidField().optional(),
  categoryId: uuidField().optional(),
  gender: z.enum(["male", "female", "mixed"]).optional(),
});
export type RegistrationsReportQuery = z.infer<typeof registrationsReportQuerySchema>;

export const exportFormatSchema = z.object({
  format: z.enum(["csv", "xlsx", "pdf"]),
});

/** Reportes de administración por club (opciones del selector y resumen): solo la competencia. */
export const competenciaDelReporteQuerySchema = z.object({
  competitionId: uuidField("Debe seleccionar una competencia"),
});
