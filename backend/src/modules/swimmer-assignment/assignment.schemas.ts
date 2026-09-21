import { z } from "zod";

export const proposeAssignmentSchema = z.object({
  clubId: z.string().uuid("Club inválido"),
  personId: z.string().uuid("Nadador inválido"),
});
export type ProposeAssignmentInput = z.infer<typeof proposeAssignmentSchema>;

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
});
export type BulkAssignSwimmersInput = z.infer<typeof bulkAssignSwimmersSchema>;

export const reassignSwimmerSchema = z.object({
  newClubId: z.string().uuid("Club inválido"),
});
export type ReassignSwimmerInput = z.infer<typeof reassignSwimmerSchema>;
