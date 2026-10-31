import { z } from "zod";
import { esFechaCalendarioValida, FORMATO_FECHA_CALENDARIO } from "../../shared/fecha.util";

export const proposeAssignmentSchema = z.object({
  clubId: z.string().uuid("Club inválido"),
  personId: z.string().uuid("Nadador inválido"),
});
export type ProposeAssignmentInput = z.infer<typeof proposeAssignmentSchema>;

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
 * No se propone a la hoja de propuesta (`proposeAssignmentSchema`): una
 * membresía `pending` no tiene fecha de inicio todavía, se le pone al aprobar.
 */
export const fechaEfectivaField = z
  .string()
  .trim()
  .regex(FORMATO_FECHA_CALENDARIO, "Use el formato AAAA-MM-DD (fecha de calendario, sin hora)")
  .refine(esFechaCalendarioValida, "Esa fecha no existe")
  .optional();

/** Asignación directa: el administrador activa la membresía en un solo paso. */
export const directAssignmentSchema = proposeAssignmentSchema.extend({
  fechaEfectiva: fechaEfectivaField,
});
export type DirectAssignmentInput = z.infer<typeof directAssignmentSchema>;

/** Aprobación de una propuesta: es cuando la membresía recibe su fecha efectiva. */
export const approveAssignmentSchema = z.object({
  fechaEfectiva: fechaEfectivaField,
});
export type ApproveAssignmentInput = z.infer<typeof approveAssignmentSchema>;

export const rejectAssignmentSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type RejectAssignmentInput = z.infer<typeof rejectAssignmentSchema>;

export const assignmentListQuerySchema = z.object({
  clubId: z.string().uuid().optional(),
  personId: z.string().uuid().optional(),
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
  targetClubId: z.string().uuid("Club de destino inválido"),
  personIds: z.array(z.string().uuid()).min(1, "Debe seleccionar al menos un nadador"),
  // Una sola fecha para toda la tanda: lo que hace que 5.000 membresías
  // cargadas en una operación compartan la MISMA fecha efectiva, en vez de
  // recibir cada una el instante de su propia escritura.
  fechaEfectiva: fechaEfectivaField,
});
export type BulkAssignSwimmersInput = z.infer<typeof bulkAssignSwimmersSchema>;

export const reassignSwimmerSchema = z.object({
  newClubId: z.string().uuid("Club inválido"),
  fechaEfectiva: fechaEfectivaField,
});
export type ReassignSwimmerInput = z.infer<typeof reassignSwimmerSchema>;
