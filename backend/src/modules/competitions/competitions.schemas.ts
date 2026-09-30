import { z } from "zod";

export const competitionCreateSchema = z
  .object({
    name: z.string().trim().min(3, "El nombre de la competencia es obligatorio"),
    description: z.string().trim().optional(),
    registrationStartAt: z.coerce.date({ errorMap: () => ({ message: "Fecha de inicio de inscripción inválida" }) }),
    registrationEndAt: z.coerce.date({ errorMap: () => ({ message: "Fecha de fin de inscripción inválida" }) }),
    ageCutoffDate: z.coerce.date({ errorMap: () => ({ message: "Fecha de corte de edad inválida" }) }),
    maxIndividualEventsPerSwimmer: z.coerce
      .number({ errorMap: () => ({ message: "Debe ingresar la cantidad máxima de pruebas individuales por nadador" }) })
      .int()
      .min(1, "Debe ser al menos 1"),
    /**
     * Máximo de relevos por nadador y jornada. Antes era una constante "1"
     * escondida en el validador de relevos; ahora se define al crear la
     * competencia. 0 = no se admiten relevos en esta competencia.
     */
    maxRelayEventsPerSwimmerPerSession: z.coerce
      .number({ errorMap: () => ({ message: "Debe indicar el máximo de relevos por nadador y jornada" }) })
      .int()
      .min(0, "No puede ser negativo")
      .default(1),
    /**
     * Cupos de NADADORES DISTINTOS, ambos opcionales. Omitirlos o enviarlos
     * nulos significa "sin límite", que es el comportamiento histórico y el
     * que conservan todas las competencias anteriores a estos campos.
     *
     * `nullable` además de `optional` a propósito: el formulario necesita
     * poder QUITAR un cupo ya puesto, y para eso tiene que enviar null
     * explícitamente, no limitarse a omitir el campo.
     */
    maxSwimmers: z.coerce.number().int().min(1, "El cupo debe ser al menos 1").optional().nullable(),
    maxSwimmersPerClub: z.coerce.number().int().min(1, "El cupo por club debe ser al menos 1").optional().nullable(),
    // Opcional: si no se selecciona, la exportación a Team Manager usa
    // piscina larga por defecto (comportamiento previo, sin cambios).
    poolId: z.string().uuid().optional().nullable(),
  })
  .refine((d) => d.maxSwimmers == null || d.maxSwimmersPerClub == null || d.maxSwimmersPerClub <= d.maxSwimmers, {
    message: "El cupo por club no puede superar el cupo total de la competencia",
    path: ["maxSwimmersPerClub"],
  })
  .refine((d) => d.registrationEndAt > d.registrationStartAt, {
    message: "La fecha de fin de inscripción debe ser posterior a la de inicio",
    path: ["registrationEndAt"],
  });
export type CompetitionCreateInput = z.infer<typeof competitionCreateSchema>;

export const competitionUpdateSchema = z
  .object({
    name: z.string().trim().min(3).optional(),
    description: z.string().trim().optional(),
    registrationStartAt: z.coerce.date().optional(),
    registrationEndAt: z.coerce.date().optional(),
    ageCutoffDate: z.coerce.date().optional(),
    maxIndividualEventsPerSwimmer: z.coerce.number().int().min(1).optional(),
    maxRelayEventsPerSwimmerPerSession: z.coerce.number().int().min(0).optional(),
    // Igual que en el alta: null = quitar el cupo. La coherencia entre los
    // dos cupos se comprueba en el servicio, con los valores ya combinados
    // con lo guardado — aquí solo llegaría la mitad del par.
    maxSwimmers: z.coerce.number().int().min(1).optional().nullable(),
    maxSwimmersPerClub: z.coerce.number().int().min(1).optional().nullable(),
    poolId: z.string().uuid().optional().nullable(),
  })
  /**
   * Esta comprobación solo alcanza cuando AMBAS fechas vienen en la misma
   * solicitud. La validación que realmente protege el rango se hace en el
   * servicio, DESPUÉS de combinar lo enviado con lo ya guardado (hallazgo
   * 12): enviar solo `registrationStartAt` con una fecha posterior al fin
   * ya almacenado pasaba por aquí sin problema.
   */
  .refine((d) => !d.registrationStartAt || !d.registrationEndAt || d.registrationEndAt > d.registrationStartAt, {
    message: "La fecha de fin de inscripción debe ser posterior a la de inicio",
    path: ["registrationEndAt"],
  });
export type CompetitionUpdateInput = z.infer<typeof competitionUpdateSchema>;

export const competitionListQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: z.enum(["draft", "scheduled", "open", "closed", "in_progress", "finished", "cancelled"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type CompetitionListQuery = z.infer<typeof competitionListQuerySchema>;

export const duplicateCompetitionSchema = z
  .object({
    name: z.string().trim().min(3, "El nombre de la nueva competencia es obligatorio"),
    registrationStartAt: z.coerce.date(),
    registrationEndAt: z.coerce.date(),
    ageCutoffDate: z.coerce.date().optional(), // si se omite, se copia de la competencia original
    maxIndividualEventsPerSwimmer: z.coerce.number().int().min(1).optional(), // si se omite, se copia de la original
    maxRelayEventsPerSwimmerPerSession: z.coerce.number().int().min(0).optional(), // si se omite, se copia de la original
    poolId: z.string().uuid().optional().nullable(), // si se omite, se copia de la original
  })
  .refine((d) => d.registrationEndAt > d.registrationStartAt, {
    message: "La fecha de fin de inscripción debe ser posterior a la de inicio",
    path: ["registrationEndAt"],
  });
export type DuplicateCompetitionInput = z.infer<typeof duplicateCompetitionSchema>;

// ---------------- Fechas y Jornadas ----------------

export const addDateSchema = z.object({
  date: z.coerce.date({ errorMap: () => ({ message: "Fecha inválida" }) }),
});
export type AddDateInput = z.infer<typeof addDateSchema>;

export const addSessionSchema = z.object({
  sessionTypeId: z.string().uuid("Tipo de jornada inválido"),
});
export type AddSessionInput = z.infer<typeof addSessionSchema>;

export const sessionLimitSchema = z.object({
  maxIndividualEvents: z.coerce.number().int().min(0).nullable(),
  maxRelayEvents: z.coerce.number().int().min(0).nullable(),
});
export type SessionLimitInput = z.infer<typeof sessionLimitSchema>;

export const sessionTypeCreateSchema = z.object({
  name: z.string().trim().min(2, "El nombre de la jornada es obligatorio"),
});
export type SessionTypeCreateInput = z.infer<typeof sessionTypeCreateSchema>;

// ---------------- Pruebas asignadas a la competencia ----------------

export const addCompetitionEventSchema = z.object({
  eventId: z.string().uuid("Prueba inválida"),
  competitionSessionId: z.string().uuid("Jornada inválida"),
  categoryIds: z.array(z.string().uuid()).min(1, "Debe habilitar al menos una categoría"),
  displayOrder: z.coerce.number().int().optional(),
});
export type AddCompetitionEventInput = z.infer<typeof addCompetitionEventSchema>;

export const updateCompetitionEventSchema = z.object({
  competitionSessionId: z.string().uuid().optional(),
  categoryIds: z.array(z.string().uuid()).min(1).optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
  displayOrder: z.coerce.number().int().nullable().optional(),
});
export type UpdateCompetitionEventInput = z.infer<typeof updateCompetitionEventSchema>;

export const reorderCompetitionEventsSchema = z.object({
  updates: z
    .array(z.object({ id: z.string().uuid(), displayOrder: z.coerce.number().int() }))
    .min(1, "Debe incluir al menos una prueba a renumerar"),
});
export type ReorderCompetitionEventsInput = z.infer<typeof reorderCompetitionEventsSchema>;
