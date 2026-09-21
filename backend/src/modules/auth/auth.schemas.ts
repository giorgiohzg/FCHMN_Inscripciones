import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().trim().min(1, "El nombre de usuario es obligatorio"),
  password: z.string().min(1, "La contraseña es obligatoria"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

/**
 * Política de contraseñas, en un solo lugar.
 *
 * Se exporta para que el seed del administrador inicial la aplique a
 * `SEED_ADMIN_PASSWORD`: no tendría sentido exigirle diez caracteres con
 * mayúscula y número a cualquier usuario y crear la cuenta más poderosa del
 * sistema con lo que venga en una variable de entorno.
 */
export const passwordField = z
  .string()
  .min(10, "La contraseña debe tener al menos 10 caracteres")
  .regex(/[A-Z]/, "Debe incluir al menos una mayúscula")
  .regex(/[a-z]/, "Debe incluir al menos una minúscula")
  .regex(/\d/, "Debe incluir al menos un número");

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: passwordField,
    confirmPassword: z.string().min(1),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Las contraseñas no coinciden",
    path: ["confirmPassword"],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// Los esquemas de auto-recuperación (`forgotPassword` / `resetPassword`) se
// eliminaron junto con sus endpoints: la recuperación es administrativa.
// Ver la nota en auth.service.ts.
