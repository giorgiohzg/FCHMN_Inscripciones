import { z } from "zod";

const nombre = z.string().trim().min(2, "El nombre de la piscina es obligatorio");
const direccion = z.string().trim().optional();
const largoDelCarril = z.enum(["short_25m", "long_50m"], { error: "Debe indicar si es piscina de 25 o 50 metros" });

export const poolCreateSchema = z.object({
  name: nombre,
  address: direccion,
  isHeated: z.boolean().default(false),
  isCovered: z.boolean().default(false),
  courseLength: largoDelCarril,
});
export type PoolCreateInput = z.infer<typeof poolCreateSchema>;

/**
 * Actualización parcial. NO deriva de `poolCreateSchema.partial()` a propósito (SEC-03 C): Zod 4 aplica los `.default()`
 * también dentro de campos opcionales, así que esa derivación rellenaría `isHeated` e `isCovered` con `false` y
 * restablecería una piscina que solo cambió su nombre. Aquí los indicadores son booleanos sin valor por omisión:
 * omitidos significan «no modificar».
 */
export const poolUpdateSchema = z
  .object({
    name: nombre,
    address: direccion,
    isHeated: z.boolean(),
    isCovered: z.boolean(),
    courseLength: largoDelCarril,
  })
  .partial();
export type PoolUpdateInput = z.infer<typeof poolUpdateSchema>;

export const poolListQuerySchema = z.object({
  search: z.string().trim().optional(),
});
export type PoolListQuery = z.infer<typeof poolListQuerySchema>;
