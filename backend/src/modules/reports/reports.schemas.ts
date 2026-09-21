import { z } from "zod";

export const registrationsReportQuerySchema = z.object({
  competitionId: z.string().uuid("Debe seleccionar una competencia"),
  clubId: z.string().uuid().optional(),
  competitionDateId: z.string().uuid().optional(),
  sessionTypeId: z.string().uuid().optional(),
  competitionEventId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  gender: z.enum(["male", "female", "mixed"]).optional(),
});
export type RegistrationsReportQuery = z.infer<typeof registrationsReportQuerySchema>;

export const exportFormatSchema = z.object({
  format: z.enum(["csv", "xlsx", "pdf"]),
});
