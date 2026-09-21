import { z } from "zod";

export const createRegistrationSchema = z.object({
  competitionEventId: z.string().uuid("Prueba de competencia inválida"),
  clubId: z.string().uuid("Club inválido"),
  personId: z.string().uuid("Nadador inválido"),
  // La categoría YA NO se ingresa manualmente: se calcula automáticamente
  // (edad del nadador vs. fecha de corte de la competencia).
  seedTimeCentiseconds: z.coerce.number().int().min(0).optional(), // tiempo estimado en centésimas de segundo (opcional)
});
export type CreateRegistrationInput = z.infer<typeof createRegistrationSchema>;

export const availableEventsQuerySchema = z.object({
  competitionId: z.string().uuid("Competencia inválida"),
  personId: z.string().uuid("Nadador inválido"),
});
export type AvailableEventsQuery = z.infer<typeof availableEventsQuerySchema>;

export const clubEligibilityQuerySchema = z.object({
  competitionId: z.string().uuid("Competencia inválida"),
  clubId: z.string().uuid("Club inválido"),
});
export type ClubEligibilityQuery = z.infer<typeof clubEligibilityQuerySchema>;

export const clubSwimmersQuerySchema = z.object({
  clubId: z.string().uuid("Club inválido"),
});
export type ClubSwimmersQuery = z.infer<typeof clubSwimmersQuerySchema>;

export const updateRegistrationSchema = z.object({
  seedTimeCentiseconds: z.coerce.number().int().min(0).nullable(),
});
export type UpdateRegistrationInput = z.infer<typeof updateRegistrationSchema>;

export const registrationListQuerySchema = z.object({
  competitionId: z.string().uuid().optional(),
  competitionEventId: z.string().uuid().optional(),
  clubId: z.string().uuid().optional(),
  personId: z.string().uuid().optional(),
  status: z.enum(["confirmed", "cancelled"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type RegistrationListQuery = z.infer<typeof registrationListQuerySchema>;

export const eligibleSwimmersQuerySchema = z.object({
  clubId: z.string().uuid("Club inválido"),
  competitionEventId: z.string().uuid("Prueba de competencia inválida"),
  categoryId: z.string().uuid("Categoría inválida"),
});
export type EligibleSwimmersQuery = z.infer<typeof eligibleSwimmersQuerySchema>;
