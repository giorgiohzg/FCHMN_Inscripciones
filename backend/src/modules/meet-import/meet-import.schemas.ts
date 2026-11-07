import { z } from "zod";
import { uuidField } from "../../shared/uuid.schema";
import { listaAcotada } from "../../shared/listaAcotada";
import { LIMITES_LISTAS } from "../../shared/limites-listas";

export const meetImportOptionsSchema = z.object({
  // Con Zod 3 el mensaje del esquema también cubría a `.int()`; en Zod 4 se da explícitamente.
  maxIndividualEventsPerSwimmer: z.coerce
    .number({ error: "Debe ingresar la cantidad máxima de pruebas individuales por nadador" })
    .int("Debe ingresar la cantidad máxima de pruebas individuales por nadador")
    .min(1, "Debe ser al menos 1"),
  /** Opcional: si no se indica, la competencia importada usa el valor por defecto (1). */
  maxRelayEventsPerSwimmerPerSession: z.coerce.number().int().min(0).optional(),
});
export type MeetImportOptions = z.infer<typeof meetImportOptionsSchema>;

/**
 * Decisión del usuario para UNA prueba de relevo (fase 2).
 *
 * Es una unión discriminada y no un `testTypeId` opcional a propósito: con un
 * campo opcional, "no lo mandé" y "elijo omitirla" serían indistinguibles, y
 * la omisión por descuido pasaría por una decisión tomada. Aquí omitir hay que
 * pedirlo expresamente.
 */
export const decisionDeRelevoSchema = z.discriminatedUnion("decision", [
  z.object({
    eventNumber: z.number().int().positive(),
    decision: z.literal("tipo"),
    testTypeId: uuidField("El tipo de relevo elegido no es válido"),
  }),
  z.object({
    eventNumber: z.number().int().positive(),
    decision: z.literal("omitir"),
  }),
]);

/**
 * Confirmación completa que acompaña a la importación.
 *
 * `fileHash` ata las decisiones al archivo sobre el que se tomaron: sin él,
 * unas decisiones numeradas por prueba se aplicarían a otro archivo cuyos
 * números coinciden y cuyos significados no.
 *
 * El tope de `decisiones` es holgado para cualquier programa real y evita que
 * una petición enorme haga trabajo inútil antes de rechazarse.
 */
export const confirmacionDeRelevosSchema = z.object({
  fileHash: z.string().regex(/^[0-9a-f]{64}$/, "La huella del archivo no es válida"),
  // El mismo tope y el mismo mensaje de siempre, pero ahora corta ANTES de validar las decisiones (SEC-01).
  decisiones: listaAcotada(LIMITES_LISTAS.decisionesDeRelevo, z.array(decisionDeRelevoSchema), "Demasiadas decisiones de relevo"),
});
export type ConfirmacionDeRelevos = z.infer<typeof confirmacionDeRelevosSchema>;
