import argon2 from "argon2";
import crypto from "node:crypto";

// Argon2id — recomendado por OWASP sobre bcrypt para nuevos proyectos.
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // ~19 MB, valores OWASP 2023
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * Política mínima de contraseña. Se aplica en el schema de validación (Zod)
 * y aquí como defensa en profundidad.
 */
export function isPasswordStrong(plain: string): boolean {
  const minLength = 10;
  const hasUpper = /[A-Z]/.test(plain);
  const hasLower = /[a-z]/.test(plain);
  const hasNumber = /\d/.test(plain);
  return plain.length >= minLength && hasUpper && hasLower && hasNumber;
}

/**
 * Genera un token opaco (para refresh tokens y reset de contraseña) y
 * retorna tanto el valor en claro (se entrega al cliente) como su hash
 * SHA-256 (lo único que se persiste en base de datos).
 */
export function generateOpaqueToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(48).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
