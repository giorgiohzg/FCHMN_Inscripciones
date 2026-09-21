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
