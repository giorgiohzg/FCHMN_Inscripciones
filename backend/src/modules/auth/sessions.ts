import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { env } from "../../shared/env";
import { generateOpaqueToken } from "./password.util";

/**
 * SESIONES DE AUTENTICACIÓN: identidad, bloqueos y revocación.
 *
 * Una sesión es lo que va de un inicio de sesión a su cierre. Sobrevive a la
 * rotación del refresh token, y el JWT la identifica con `sid`. Es lo que
 * permite terminar UNA sesión sin tocar las demás y que esa terminación tenga
 * efecto inmediato sobre el JWT ya emitido (ver `rbac.middleware.ts`).
 *
 * INVARIANTE. Terminar una sesión revoca sus refresh tokens en la misma
 * transacción. Así, incluso una versión anterior de la API, que no conoce esta
 * tabla, respeta una sesión terminada.
 *
 * ORDEN ÚNICO DE BLOQUEOS, sin excepciones:
 *
 *     persons / clubs (solo operaciones administrativas)
 *       → users → refresh_sessions → refresh_tokens
 *
 * Nada que ya tenga `users` vuelve a bloquear `persons` o `clubs`. Por eso el
 * login y el refresco LEEN el estado de la persona sin bloquearla: si una
 * inhabilitación está en curso, su escritura sobre `users` los hace esperar, y
 * la lectura siguiente —otra sentencia, otra instantánea— ya ve lo confirmado.
 *
 * `FOR NO KEY UPDATE` y no `FOR UPDATE`: serializa igual entre operaciones de
 * sesión, pero no choca con el `FOR KEY SHARE` de las claves foráneas. Con
 * `FOR UPDATE`, cualquier fila nueva de `audit_logs` o `refresh_tokens` que
 * apunte al usuario esperaría, y dos operaciones cruzadas podrían interbloquearse.
 *
 * LAS CREDENCIALES SE VERIFICAN FUERA DEL BLOQUEO. Argon2 es lento y costoso a
 * propósito: hacerlo bajo la fila serializaría a todo el usuario. Lo verificado
 * fuera se revalida dentro comparando el hash leído antes (H0) con el vigente:
 * si cambió, la credencial presentada ya no es la de la cuenta.
 */

/**
 * Opciones de toda transacción de sesión.
 *
 * `READ COMMITTED` es imprescindible: tras esperar el bloqueo de `users`, cada
 * sentencia siguiente debe ver lo que confirmó quien lo tenía. Los plazos son
 * explícitos porque aquí se ESPERA a propósito, y el valor por omisión de Prisma
 * no distingue esa espera de una operación atascada.
 */
export const OPCIONES_TX_SESION = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  /** Espera máxima para obtener una conexión del pool. */
  maxWait: 5_000,
  /** Duración máxima, incluida la espera por el bloqueo de `users`. */
  timeout: 10_000,
} as const;

/** Por qué terminó una sesión. Se guarda en `revoked_reason`. */
export type MotivoDeCierre = "logout" | "password_change" | "admin_revocation" | "reuse_detected" | "password_change_attempts";

type Tx = Prisma.TransactionClient;

/** La cuenta tal como está AHORA, con su fila bloqueada. */
export interface UsuarioBloqueado {
  id: string;
  passwordHash: string;
  status: "active" | "locked" | "disabled";
  personId: string | null;
  deletedAt: Date | null;
  lockedUntil: Date | null;
  failedLoginAttempts: number;
  mustChangePassword: boolean;
}

/**
 * Bloquea la cuenta y devuelve su estado vigente: la primera sentencia de toda
 * operación de sesión, y lo que serializa las de alcance usuario, que crean filas
 * nuevas y por eso no pueden serializarse bloqueando filas que aún no existen.
 *
 * Solo es fiable bajo `READ COMMITTED`, o bajo `Serializable` asumiendo que
 * PostgreSQL abortará la transacción si la fila cambió desde su instantánea.
 */
export async function bloquearUsuario(tx: Tx, userId: string): Promise<UsuarioBloqueado | null> {
  const filas = await tx.$queryRaw<UsuarioBloqueado[]>`
    SELECT id,
           password_hash AS "passwordHash",
           status::text AS status,
           person_id AS "personId",
           deleted_at AS "deletedAt",
           locked_until AS "lockedUntil",
           failed_login_attempts AS "failedLoginAttempts",
           must_change_password AS "mustChangePassword"
      FROM users
     WHERE id = ${userId}
       FOR NO KEY UPDATE`;
  return filas[0] ?? null;
}

export interface SesionBloqueada {
  id: string;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

/** Bloquea una sesión. Requiere tener ya bloqueado a su usuario. */
export async function bloquearSesion(tx: Tx, sessionId: string): Promise<SesionBloqueada | null> {
  const filas = await tx.$queryRaw<SesionBloqueada[]>`
    SELECT id,
           absolute_expires_at AS "absoluteExpiresAt",
           revoked_at AS "revokedAt"
      FROM refresh_sessions
     WHERE id = ${sessionId}
       FOR UPDATE`;
  return filas[0] ?? null;
}

export interface TokenBloqueado {
  id: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
}

/** Bloquea un refresh token. Requiere tener ya bloqueados su usuario y su sesión. */
export async function bloquearToken(tx: Tx, tokenHash: string): Promise<TokenBloqueado | null> {
  const filas = await tx.$queryRaw<TokenBloqueado[]>`
    SELECT id,
           expires_at AS "expiresAt",
           revoked_at AS "revokedAt",
           replaced_by AS "replacedBy"
      FROM refresh_tokens
     WHERE token_hash = ${tokenHash}
       FOR UPDATE`;
  return filas[0] ?? null;
}

/** Vencimiento de un refresh token: nunca más allá del límite absoluto de su sesión. */
export function vencimientoDeRefresh(absoluteExpiresAt: Date, ahora: number = Date.now()): Date {
  return new Date(Math.min(ahora + env.JWT_REFRESH_EXPIRES_IN_DAYS * 86_400_000, absoluteExpiresAt.getTime()));
}

interface OrigenDeSesion {
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Crea una sesión con su primer refresh token. El llamador debe tener bloqueado
 * al usuario: es lo que impide que nazca una sesión después de una revocación de
 * alcance usuario sin que esa revocación la alcance.
 */
export async function crearSesion(tx: Tx, userId: string, origen: OrigenDeSesion): Promise<{ sessionId: string; refreshToken: string }> {
  const ahora = Date.now();
  const absoluteExpiresAt = new Date(ahora + env.SESSION_ABSOLUTE_HOURS * 3_600_000);
  const sesion = await tx.refreshSession.create({ data: { userId, absoluteExpiresAt }, select: { id: true } });

  const { token: refreshToken, tokenHash } = generateOpaqueToken();
  await tx.refreshToken.create({
    data: {
      userId,
      sessionId: sesion.id,
      tokenHash,
      expiresAt: vencimientoDeRefresh(absoluteExpiresAt, ahora),
      ipAddress: origen.ipAddress,
      userAgent: origen.userAgent,
    },
  });
  return { sessionId: sesion.id, refreshToken };
}

/**
 * Termina UNA sesión y revoca sus tokens. Requiere tener bloqueado a su usuario.
 * Devuelve si la terminó ahora: repetirlo no es un error y no cambia el motivo.
 */
export async function terminarSesion(tx: Tx, sessionId: string, motivo: MotivoDeCierre): Promise<boolean> {
  const ahora = new Date();
  const { count } = await tx.refreshSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: ahora, revokedReason: motivo },
  });
  await tx.refreshToken.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: ahora } });
  return count > 0;
}

/**
 * Termina TODAS las sesiones de una cuenta. Es el único camino de revocación de
 * alcance usuario: cambio y restablecimiento de contraseña, bloqueo,
 * inhabilitación, eliminación y retiro del acceso administrativo.
 *
 * Bloquea al usuario primero aunque quien llama ya lo haya tocado: sin ese
 * bloqueo, un login concurrente podría dejar una sesión viva después de esto.
 * Revoca también los tokens sin sesión, para que tampoco una reversión de la API
 * pueda devolverles validez. Devuelve cuántos refresh tokens revocó.
 *
 * Reactivar una cuenta no deshace nada de esto: las sesiones terminadas no vuelven.
 */
export async function terminarSesionesDelUsuario(tx: Tx, userId: string, motivo: MotivoDeCierre): Promise<number> {
  await bloquearUsuario(tx, userId);

  const ahora = new Date();
  await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: ahora, revokedReason: motivo } });
  const { count } = await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: ahora } });
  return count;
}

/** Igual que `terminarSesionesDelUsuario`, partiendo del dueño de la cuenta. Sin cuenta, no hace nada. */
export async function terminarSesionesDelTitular(
  tx: Tx,
  titular: { personId: string } | { clubId: string },
  motivo: MotivoDeCierre
): Promise<number> {
  const cuenta = await tx.user.findFirst({ where: titular, select: { id: true } });
  return cuenta ? terminarSesionesDelUsuario(tx, cuenta.id, motivo) : 0;
}

/**
 * ¿Sigue vigente la sesión de este JWT? Se consulta en CADA petición autenticada,
 * sin caché: una caché reabriría justo la ventana que esto cierra.
 *
 * El límite es exclusivo: al alcanzar `absoluteExpiresAt` la sesión ya no vale.
 */
export async function sesionVigente(sessionId: string, userId: string): Promise<boolean> {
  const sesion = await prisma.refreshSession.findUnique({
    where: { id: sessionId },
    select: { userId: true, revokedAt: true, absoluteExpiresAt: true },
  });
  if (!sesion || sesion.userId !== userId || sesion.revokedAt !== null) return false;
  return sesion.absoluteExpiresAt.getTime() > Date.now();
}
