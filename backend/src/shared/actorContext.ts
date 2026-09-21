import type { FastifyRequest } from "fastify";
import { ForbiddenError, UnauthorizedError } from "./errors";

/**
 * Alcance con el que opera quien hace la solicitud. Es un tipo cerrado a
 * propósito: no existe un cuarto caso "sin alcance" que dejara pasar todo.
 *
 * - `admin`   → sin restricción de club (el permiso ya se validó en RBAC).
 * - `club`    → acotado a UN club (usuario de tipo club, o persona que es
 *               delegado/entrenador/representante legal de ese club).
 * - `swimmer` → acotado a UNA persona: un nadador sin club operativo detrás
 *               solo ve y modifica lo suyo.
 */
export type ActorScope = { kind: "admin" } | { kind: "club"; clubId: string } | { kind: "swimmer"; personId: string };

export interface ActorContext {
  userId: string;
  ipAddress?: string;
  isAdmin: boolean;
  scope: ActorScope;
  /** Permiso `registrations:write:post-close` (excepciones tras el cierre). */
  canRegisterPostClose: boolean;
}

/**
 * Construye el contexto del actor a partir del token ya verificado.
 *
 * Regla central: el alcance sale SIEMPRE de la identidad autenticada, nunca
 * de un `clubId` recibido por query o body. Antes cada módulo lo derivaba a
 * su manera y comparaba con `actor.actorClubId && actor.actorClubId !== ...`,
 * lo que silenciosamente NO comprobaba nada cuando el club no se podía
 * resolver. Aquí ese caso cae en `swimmer` (el alcance más restrictivo), no
 * en "sin restricción".
 */
export function buildActorContext(req: FastifyRequest): ActorContext {
  const auth = req.authUser;
  if (!auth) throw new UnauthorizedError();

  const isAdmin = auth.roles.includes("admin");
  const clubId = auth.clubId ?? null;
  const personId = auth.personId ?? null;

  let scope: ActorScope;
  if (isAdmin) {
    scope = { kind: "admin" };
  } else if (clubId) {
    scope = { kind: "club", clubId };
  } else if (personId) {
    scope = { kind: "swimmer", personId };
  } else {
    // Cuenta no administrativa sin club ni persona detrás: no hay ningún
    // dato al que pueda estar legítimamente acotada. Se rechaza en vez de
    // asumir acceso amplio.
    throw new ForbiddenError("Su cuenta no tiene un club ni una persona asociada; no puede operar sobre datos de inscripciones.");
  }

  return {
    userId: auth.sub,
    ipAddress: req.ip,
    isAdmin,
    scope,
    canRegisterPostClose: auth.permissions.includes("registrations:write:post-close"),
  };
}

/** `clubId` al que está acotado el actor, o `null` si es admin (sin restricción). */
export function scopedClubId(actor: ActorContext): string | null {
  return actor.scope.kind === "club" ? actor.scope.clubId : null;
}

/** `personId` al que está acotado el actor, o `null` si no es un nadador puro. */
export function scopedPersonId(actor: ActorContext): string | null {
  return actor.scope.kind === "swimmer" ? actor.scope.personId : null;
}

/**
 * Valida que el actor pueda operar sobre `clubId`. Un admin puede sobre
 * cualquiera; un usuario de club solo sobre el suyo; un nadador puro no
 * puede operar a nivel de club en absoluto.
 */
export function assertClubAccess(actor: ActorContext, clubId: string): void {
  switch (actor.scope.kind) {
    case "admin":
      return;
    case "club":
      if (actor.scope.clubId !== clubId) {
        throw new ForbiddenError("No tiene permiso para operar sobre datos de otro club.");
      }
      return;
    case "swimmer":
      throw new ForbiddenError("No tiene permiso para operar a nivel de club.");
  }
}

/**
 * Resuelve el `clubId` efectivo de una consulta.
 *
 * - Admin: usa el que pidió (o `null` = todos los clubes).
 * - Club: IGNORA lo pedido y devuelve el suyo; si pidió otro explícitamente,
 *   se rechaza en vez de "corregirlo" en silencio, para que un error de la
 *   interfaz no se confunda con un intento de acceso indebido.
 * - Nadador: devuelve `null`; el acotamiento efectivo es por `personId`.
 */
export function resolveClubFilter(actor: ActorContext, requestedClubId?: string | null): string | null {
  switch (actor.scope.kind) {
    case "admin":
      return requestedClubId ?? null;
    case "club":
      if (requestedClubId && requestedClubId !== actor.scope.clubId) {
        throw new ForbiddenError("No tiene permiso para consultar datos de otro club.");
      }
      return actor.scope.clubId;
    case "swimmer":
      return null;
  }
}

/**
 * Igual que `resolveClubFilter` pero para operaciones que EXIGEN un club
 * concreto (crear una inscripción, por ejemplo). Un admin debe indicarlo;
 * un usuario de club no puede indicar otro que el suyo.
 */
export function requireClubForWrite(actor: ActorContext, requestedClubId: string): string {
  assertClubAccess(actor, requestedClubId);
  return requestedClubId;
}
