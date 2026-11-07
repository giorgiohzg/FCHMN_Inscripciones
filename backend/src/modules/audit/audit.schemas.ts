import { z } from "zod";
import { uuidField } from "../../shared/uuid.schema";

export const auditLogListQuerySchema = z.object({
  userId: uuidField().optional(),
  entityType: z.string().trim().optional(),
  entityId: z.string().optional(),
  action: z.string().trim().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>;
