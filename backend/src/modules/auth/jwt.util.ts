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

/**
 * Lo que se firma: la identidad y la SESIÓN a la que pertenece el token.
 *
 * `sid` es lo que permite invalidar un JWT antes de que caduque (ver
 * `sesionVigente` en `sessions.ts`). No forma parte de `AccessTokenPayload`
 * porque ese tipo describe también a `req.authUser`, que `/auth/me` devuelve.
 */
export interface AccessTokenClaims extends AccessTokenPayload {
  sid: string;
}

export function signAccessToken(payload: AccessTokenClaims): string {
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

/** `sid` queda opcional en el tipo: un token anterior a las sesiones no lo trae, y quien verifica lo rechaza. */
export function verifyAccessToken(token: string): AccessTokenPayload & { sid?: unknown } {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: "natacion-api" }) as AccessTokenPayload & { sid?: unknown };
}
