import { z } from "zod";

export const meetImportOptionsSchema = z.object({
  maxIndividualEventsPerSwimmer: z.coerce
    .number({ errorMap: () => ({ message: "Debe ingresar la cantidad máxima de pruebas individuales por nadador" }) })
    .int()
    .min(1, "Debe ser al menos 1"),
  /** Opcional: si no se indica, la competencia importada usa el valor por defecto (1). */
  maxRelayEventsPerSwimmerPerSession: z.coerce.number().int().min(0).optional(),
});
export type MeetImportOptions = z.infer<typeof meetImportOptionsSchema>;
