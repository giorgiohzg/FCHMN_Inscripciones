import { z } from "zod";

export const distanceCreateSchema = z.object({
  meters: z.coerce.number().int().positive("La distancia debe ser un número positivo de metros"),
});
export type DistanceCreateInput = z.infer<typeof distanceCreateSchema>;

export const strokeCreateSchema = z.object({
  name: z.string().trim().min(2, "El nombre del estilo es obligatorio"),
});
export type StrokeCreateInput = z.infer<typeof strokeCreateSchema>;

export const categoryGroupCreateSchema = z.object({
  name: z.string().trim().min(2, "El nombre del grupo es obligatorio"),
});
export type CategoryGroupCreateInput = z.infer<typeof categoryGroupCreateSchema>;

const categoryBase = {
  testTypeId: z.string().uuid("Tipo de prueba inválido"),
  categoryGroupId: z.string().uuid("Grupo de categorías inválido").optional().nullable(),
  name: z.string().trim().min(2, "El nombre de la categoría es obligatorio"),
  minAge: z.coerce.number().int().min(0, "La edad mínima no puede ser negativa"),
  maxAge: z.coerce.number().int().min(0),
};

export const categoryCreateSchema = z
  .object(categoryBase)
  .refine((d) => d.maxAge >= d.minAge, { message: "La edad máxima debe ser mayor o igual a la edad mínima", path: ["maxAge"] });
export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;

export const categoryUpdateSchema = z
  .object({ ...categoryBase, testTypeId: categoryBase.testTypeId.optional() })
  .partial({ name: true, minAge: true, maxAge: true, categoryGroupId: true })
  .refine((d) => d.minAge === undefined || d.maxAge === undefined || d.maxAge >= d.minAge, {
    message: "La edad máxima debe ser mayor o igual a la edad mínima",
    path: ["maxAge"],
  });
export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>;

export const categoryListQuerySchema = z.object({
  testTypeId: z.string().uuid().optional(),
  categoryGroupId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type CategoryListQuery = z.infer<typeof categoryListQuerySchema>;

const eventGenderEnum = z.enum(["male", "female", "mixed"]);

export const eventCreateSchema = z.object({
  testTypeId: z.string().uuid("Tipo de prueba inválido"),
  distanceId: z.string().uuid("Distancia inválida"),
  strokeId: z.string().uuid("Estilo inválido"),
  gender: eventGenderEnum,
});
export type EventCreateInput = z.infer<typeof eventCreateSchema>;

export const eventUpdateSchema = z.object({
  gender: eventGenderEnum.optional(),
});
export type EventUpdateInput = z.infer<typeof eventUpdateSchema>;

export const eventListQuerySchema = z.object({
  testTypeId: z.string().uuid().optional(),
  distanceId: z.string().uuid().optional(),
  strokeId: z.string().uuid().optional(),
  gender: eventGenderEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
