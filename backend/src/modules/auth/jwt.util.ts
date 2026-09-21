import jwt from "jsonwebtoken";
import { env } from "../../shared/env";

/**
 * Tipo del dueño de la sesión. Es el enum `OwnerType` de la base, completo:
 * `system` es la cuenta administrativa, sin persona ni club (hallazgo 20).
 * Antes el contrato solo admitía `person | club` y el administrador viajaba
 * como `person` gracias a un cast, así que el token afirmaba algo falso sobre
 * quién era su dueño.
 */
export type SessionOwnerType = "person" | "club" | "system";

export interface AccessTokenPayload {
  sub: string; // userId
  ownerType: SessionOwnerType;
  personId?: string | null;
  clubId?: string | null;
  roles: string[];
  permissions: string[];
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: jwt.SignOptions = {
    /**
     * Un NÚMERO, que `jsonwebtoken` siempre interpreta como segundos. El cast
     * anterior existía porque el valor llegaba como cadena, y ahí "900" no
     * significaba 900 segundos sino 900 milisegundos: tokens ya caducados al
     * emitirse. La conversión y validación viven en `env.schema.ts`.
     */
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    issuer: "natacion-api",
  };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: "natacion-api" }) as AccessTokenPayload;
}
