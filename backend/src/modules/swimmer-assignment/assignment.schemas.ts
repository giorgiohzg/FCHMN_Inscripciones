import { z } from "zod";
import { uuidField } from "../../shared/uuid.schema";
import { esFechaCalendarioValida, FORMATO_FECHA_CALENDARIO } from "../../shared/fecha.util";
import { listaAcotada } from "../../shared/listaAcotada";
import { LIMITES_LISTAS } from "../../shared/limites-listas";

/**
 * C-05: la postulación se inicia SOLO con el RUN. El servidor no acepta `personId`: proponer a
 * una persona por su identificador interno es justamente lo que entregaba su nombre y RUN a un
 * club cualquiera. Se RECHAZA con un mensaje explícito (no se ignora), para que un cliente
 * antiguo no crea que su operación se hizo.
 *
 * `clubId`: para el club y su personal sale de la sesión; si se envía, debe coincidir (403 si
 * no). Administración debe indicarlo.
 */
export const postulacionSchema = z
  .object({
    run: z.string({ error: "Debe indicar el RUN" }).trim().min(1, "Debe indicar el RUN").max(20, "RUN demasiado largo"),
    clubId: uuidField("Club inválido").optional(),
    personId: z
      .undefined({ error: "La postulación se inicia solo con el RUN: el campo personId ya no se acepta." })
      .optional(),
  })
  .strict();
export type PostulacionInput = z.infer<typeof postulacionSchema>;

/** Segundo paso de un RUN no registrado: nombre y apellido DECLARADOS por el club. Sin RUN. */
export const segundoPasoSchema = z
  .object({
    intentoId: uuidField("Intento inválido"),
    nombres: z.string({ error: "Debe indicar el nombre" }).trim().min(2, "Debe indicar el nombre").max(120),
    apellidos: z.string({ error: "Debe indicar el apellido" }).trim().min(2, "Debe indicar el apellido").max(120),
  })
  .strict();
export type SegundoPasoInput = z.infer<typeof segundoPasoSchema>;

/**
 * Campos comunes de las vías que ACTIVAN membresías (C-05): confirmación explícita de la
 * membresía activa que se finaliza en un traslado, y aceptación explícita de un historial con
 * fechas desconocidas.
 */
const confirmacionDeTrasladoField = uuidField("Membresía a finalizar inválida").optional();
const aceptarHistorialIncompletoField = z.boolean().optional();

/**
 * Fecha EFECTIVA de inicio de la membresía: desde cuándo pertenece al club.
 *
 * Es una fecha de CALENDARIO, nunca un instante: por eso se recibe como
 * `AAAA-MM-DD` y no como una fecha ISO con hora. Admitir la hora reabriría el
 * problema que esto cierra — el día guardado dependería de la zona de quien
 * la envía.
 *
 * Opcional: si no viene, el servicio usa el día de hoy en Chile.
 *
 * No se propone a la postulación (`postulacionSchema`): una
 * membresía `pending` no tiene fecha de inicio todavía, se le pone al aprobar.
 */
export const fechaEfectivaField = z
  .string()
  .trim()
  .regex(FORMATO_FECHA_CALENDARIO, "Use el formato AAAA-MM-DD (fecha de calendario, sin hora)")
  .refine(esFechaCalendarioValida, "Esa fecha no existe")
  .optional();

/** Asignación directa: el administrador activa la membresía en un solo paso. */
export const directAssignmentSchema = z.object({
  clubId: uuidField("Club inválido"),
  personId: uuidField("Nadador inválido"),
  fechaEfectiva: fechaEfectivaField,
  aceptarHistorialIncompleto: aceptarHistorialIncompletoField,
});
export type DirectAssignmentInput = z.infer<typeof directAssignmentSchema>;

/** Aprobación de una propuesta: es cuando la membresía recibe su fecha efectiva. */
export const approveAssignmentSchema = z.object({
  fechaEfectiva: fechaEfectivaField,
  confirmarFinDeMembresiaId: confirmacionDeTrasladoField,
  aceptarHistorialIncompleto: aceptarHistorialIncompletoField,
});
export type ApproveAssignmentInput = z.infer<typeof approveAssignmentSchema>;

/**
 * C-05: baja simple con fecha de término ELEGIDA por quien la registra (puede ser una renuncia
 * comunicada después). Obligatoria: sin ella el servidor rechaza, no elige ayer ni hoy en silencio.
 * Debe ser una fecha de calendario que exista; que no sea futura ni anterior al inicio lo comprueba
 * el servicio con la membresía bloqueada. `aceptarHistorialIncompleto` es solo de administración.
 */
export const endAssignmentSchema = z
  .object({
    fechaTermino: z
      .string({ error: "Debe indicar la fecha de término (AAAA-MM-DD)" })
      .trim()
      .regex(FORMATO_FECHA_CALENDARIO, "Use el formato AAAA-MM-DD (fecha de calendario, sin hora)")
      .refine(esFechaCalendarioValida, "Esa fecha no existe"),
    aceptarHistorialIncompleto: z.boolean().optional(),
  })
  .strict();
export type EndAssignmentInput = z.infer<typeof endAssignmentSchema>;

export const rejectAssignmentSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type RejectAssignmentInput = z.infer<typeof rejectAssignmentSchema>;

export const assignmentListQuerySchema = z.object({
  clubId: uuidField().optional(),
  personId: uuidField().optional(),
  status: z.enum(["pending", "active", "rejected", "ended"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type AssignmentListQuery = z.infer<typeof assignmentListQuerySchema>;

/**
 * Filtro de nadadores por club ACTUAL para la asignación masiva:
 * `clubId` = nadadores activos en ese club; `"none"` = nadadores sin
 * ningún club activo asignado ("Sin club").
 */
export const swimmersByClubFilterQuerySchema = z.object({
  clubFilter: z
    .string()
    .min(1, "Debe indicar un club o \"none\"")
    .refine((v) => v === "none" || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v), {
      message: "Debe ser un ID de club válido o \"none\"",
    }),
  search: z.string().trim().optional(),
});
export type SwimmersByClubFilterQuery = z.infer<typeof swimmersByClubFilterQuerySchema>;

export const bulkAssignSwimmersSchema = z.object({
  targetClubId: uuidField("Club de destino inválido"),
  // Tope de longitud comprobado ANTES de validar elementos (SEC-01). No garantiza una duración de la operación.
  personIds: listaAcotada(
    LIMITES_LISTAS.asignacionMasiva,
    z.array(uuidField()).min(1, "Debe seleccionar al menos un nadador"),
    "Se pueden asignar como máximo 10.000 nadadores por operación"
  ),
  // Una sola fecha para toda la tanda: lo que hace que 5.000 membresías
  // cargadas en una operación compartan la MISMA fecha efectiva, en vez de
  // recibir cada una el instante de su propia escritura.
  fechaEfectiva: fechaEfectivaField,
  aceptarHistorialIncompleto: aceptarHistorialIncompletoField,
});
export type BulkAssignSwimmersInput = z.infer<typeof bulkAssignSwimmersSchema>;

export const reassignSwimmerSchema = z.object({
  newClubId: uuidField("Club inválido"),
  fechaEfectiva: fechaEfectivaField,
  confirmarFinDeMembresiaId: confirmacionDeTrasladoField,
  aceptarHistorialIncompleto: aceptarHistorialIncompletoField,
});
export type ReassignSwimmerInput = z.infer<typeof reassignSwimmerSchema>;
