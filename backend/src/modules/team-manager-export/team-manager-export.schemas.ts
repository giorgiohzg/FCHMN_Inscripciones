import { z } from "zod";

export const teamManagerExportQuerySchema = z.object({
  competitionId: z.string().uuid("Debe seleccionar una competencia"),
  clubId: z.string().uuid("Debe seleccionar un club"),
});
export type TeamManagerExportQuery = z.infer<typeof teamManagerExportQuerySchema>;
