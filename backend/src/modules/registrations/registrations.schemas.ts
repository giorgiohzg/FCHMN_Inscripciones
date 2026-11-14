import { z } from "zod";
import { uuidField } from "../../shared/uuid.schema";

export const createRegistrationSchema = z.object({
  competitionEventId: uuidField("Prueba de competencia inválida"),
  clubId: uuidField("Club inválido"),
  personId: uuidField("Nadador inválido"),
  // La categoría YA NO se ingresa manualmente: se calcula automáticamente
  // (edad del nadador vs. fecha de corte de la competencia).
  seedTimeCentiseconds: z.coerce.number().int().min(0).optional(), // tiempo estimado en centésimas de segundo (opcional)
});
export type CreateRegistrationInput = z.infer<typeof createRegistrationSchema>;

export const availableEventsQuerySchema = z.object({
  competitionId: uuidField("Competencia inválida"),
  personId: uuidField("Nadador inválido"),
});
export type AvailableEventsQuery = z.infer<typeof availableEventsQuerySchema>;

export const clubEligibilityQuerySchema = z.object({
  competitionId: uuidField("Competencia inválida"),
  clubId: uuidField("Club inválido"),
});
export type ClubEligibilityQuery = z.infer<typeof clubEligibilityQuerySchema>;

export const clubSwimmersQuerySchema = z.object({
  clubId: uuidField("Club inválido"),
  /** Opcional: con él, cada nadador trae `edadAlCorte` de esa competencia (Panel de Relevos). */
  competitionId: uuidField("Competencia inválida").optional(),
});
export type ClubSwimmersQuery = z.infer<typeof clubSwimmersQuerySchema>;

export const updateRegistrationSchema = z.object({
  seedTimeCentiseconds: z.coerce.number().int().min(0).nullable(),
});
export type UpdateRegistrationInput = z.infer<typeof updateRegistrationSchema>;

export const registrationListQuerySchema = z.object({
  competitionId: uuidField().optional(),
  competitionEventId: uuidField().optional(),
  clubId: uuidField().optional(),
  personId: uuidField().optional(),
  status: z.enum(["confirmed", "cancelled"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type RegistrationListQuery = z.infer<typeof registrationListQuerySchema>;

export const eligibleSwimmersQuerySchema = z.object({
  clubId: uuidField("Club inválido"),
  competitionEventId: uuidField("Prueba de competencia inválida"),
  categoryId: uuidField("Categoría inválida"),
});
export type EligibleSwimmersQuery = z.infer<typeof eligibleSwimmersQuerySchema>;
