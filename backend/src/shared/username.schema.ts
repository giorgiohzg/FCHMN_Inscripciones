import { z } from "zod";

/**
 * FORMATO del nombre de usuario — única definición del contrato, compartida por
 * personas, clubes y el administrador inicial: los tres nombres compiten por la
 * misma reserva (`username_reservations`).
 *
 * Módulo PURO: su única dependencia es Zod. La DISPONIBILIDAD vive aparte, en
 * `shared/username.ts`, que sí usa Prisma; validar la forma de una cadena no
 * debe arrastrar un cliente de base de datos.
 */
export const usernameField = z
  .string()
  .trim()
  .min(4, "El nombre de usuario debe tener al menos 4 caracteres")
  .max(30, "El nombre de usuario no puede superar los 30 caracteres")
  .regex(/^[a-zA-Z0-9._-]+$/, "Solo se permiten letras, números, puntos, guiones y guiones bajos");

/**
 * Nombre de usuario OPCIONAL de una persona o un club (desde `username_opcional`).
 *
 * La ausencia es `null`, nunca una cadena vacía:
 *   - `null`, `""` o solo espacios → `null` («sin nombre»);
 *   - cualquier otro valor se recorta y debe cumplir `usernameField`.
 *
 * El significado de OMITIR el campo lo decide cada esquema con `.optional()`:
 * en un alta equivale a «sin nombre», en una edición a «no tocar».
 *
 * Se valida con `superRefine` y no con una unión, para conservar los mensajes
 * concretos de `usernameField` en vez de un «entrada inválida» genérico.
 */
export const usernameOpcionalField = z
  .string()
  .nullable()
  .transform((valor) => (valor === null || valor.trim() === "" ? null : valor.trim()))
  .superRefine((valor, ctx) => {
    if (valor === null) return;
    const resultado = usernameField.safeParse(valor);
    if (!resultado.success) {
      for (const issue of resultado.error.issues) ctx.addIssue({ code: "custom", message: issue.message });
    }
  });
