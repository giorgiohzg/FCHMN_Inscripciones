import { z } from "zod";
import { uuidField } from "../../shared/uuid.schema";

export const teamManagerExportQuerySchema = z.object({
  competitionId: uuidField("Debe seleccionar una competencia"),
  clubId: uuidField("Debe seleccionar un club"),
});
export type TeamManagerExportQuery = z.infer<typeof teamManagerExportQuerySchema>;
