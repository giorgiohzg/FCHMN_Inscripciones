import { z } from "zod";

export const poolCreateSchema = z.object({
  name: z.string().trim().min(2, "El nombre de la piscina es obligatorio"),
  address: z.string().trim().optional(),
  isHeated: z.boolean().default(false),
  isCovered: z.boolean().default(false),
  courseLength: z.enum(["short_25m", "long_50m"], { errorMap: () => ({ message: "Debe indicar si es piscina de 25 o 50 metros" }) }),
});
export type PoolCreateInput = z.infer<typeof poolCreateSchema>;

export const poolUpdateSchema = poolCreateSchema.partial();
export type PoolUpdateInput = z.infer<typeof poolUpdateSchema>;

export const poolListQuerySchema = z.object({
  search: z.string().trim().optional(),
});
export type PoolListQuery = z.infer<typeof poolListQuerySchema>;
