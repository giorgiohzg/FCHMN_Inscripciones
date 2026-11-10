/**
 * C-04: intentos de `/auth/change-password` por SESIÓN.
 *
 * POLÍTICA. Se cuentan las contraseñas actuales incorrectas durante toda la vida de la
 * sesión (el refresh rota tokens dentro de la misma sesión, así que no reinicia nada). En
 * la quinta se termina SOLO esa sesión; la cuenta, las demás sesiones y los logins futuros
 * no cambian. Rige igual para el cambio obligatorio y el voluntario.
 *
 * TRES COSAS DISTINTAS:
 *   - RESERVA: permiso para que UNA comprobación produzca efectos. Lleva token y caducidad.
 *   - VERIFICACIÓN: el trabajo de Argon2. Va siempre FUERA de las transacciones; no se
 *     promete que solo haya una en curso, porque una operación lenta sigue calculando
 *     aunque su reserva venza.
 *   - FALLO: una contraseña actual incorrecta cuyo resultado SÍ se aplicó, porque su
 *     reserva seguía siendo la vigente. Es lo único que cuenta.
 *
 * RESULTADO OBSOLETO. Antes de cualquier efecto se comprueba, con el usuario y la sesión
 * bloqueados (orden único: users → refresh_sessions), que el token sigue siendo el dueño
 * de la reserva y que esta no venció. Si no, el resultado no cuenta, no cambia la
 * contraseña y no libera nada, y la respuesta es la misma acierte o no.
 *
 * LO QUE NO CUENTA: la validación de la contraseña nueva (ocurre antes de reservar, en la
 * ruta), los errores de ejecución (base, Argon2) y los resultados obsoletos. En esos casos
 * se libera la reserva —solo si sigue siendo la propia— para poder reintentar enseguida;
 * si el proceso cae, la reserva caduca sola.
 */
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { audit } from "../audit/audit.service";
import { AppError, ConflictError, UnauthorizedError, ValidationError } from "../../shared/errors";
import { OPCIONES_TX_SESION, bloquearUsuario, terminarSesion } from "./sessions";

type Tx = Prisma.TransactionClient;

/** Contraseñas actuales incorrectas que admite una sesión antes de terminarse. */
export const MAX_FALLOS_CAMBIO_CONTRASENA = 5;

/**
 * Vida de una reserva. Cubre con holgura las dos derivaciones de Argon2 (verificar la
 * actual y calcular la nueva); vencida, otra solicitud puede reservar y la anterior ya
 * no produce efectos.
 */
export const DURACION_RESERVA_MS = 30_000;

export interface ReservaDeCambio {
  sessionId: string;
  userId: string;
  token: string;
}

interface RequestContext {
  ipAddress?: string;
}

export const MENSAJE_SESION_NO_VALIDA = "La sesión ya no es válida. Vuelva a iniciar sesión.";
export const MENSAJE_CONTRASENA_ACTUAL_INCORRECTA = "La contraseña actual es incorrecta";
export const MENSAJE_INTENTOS_AGOTADOS =
  "Demasiados intentos con una contraseña actual incorrecta. Por seguridad se cerró esta sesión: inicie sesión nuevamente.";
export const MENSAJE_CAMBIO_EN_CURSO = "Hay un cambio de contraseña en curso en esta sesión. Espere unos segundos y vuelva a intentarlo.";
export const MENSAJE_OBSOLETO = "La solicitud de cambio de contraseña no pudo completarse. Vuelva a intentarlo.";

const sesionNoValida = () => new UnauthorizedError(MENSAJE_SESION_NO_VALIDA);

/** 401 propio: el cliente lo trata como una sesión terminada y vuelve al login. */
export class IntentosDeCambioAgotadosError extends AppError {
  constructor() {
    super(401, "PASSWORD_CHANGE_ATTEMPTS_EXCEEDED", MENSAJE_INTENTOS_AGOTADOS);
  }
}

/** 429: otra solicitud de esta misma sesión tiene la reserva vigente. No cuenta como fallo. */
export class CambioDeContrasenaEnCursoError extends AppError {
  constructor() {
    super(429, "PASSWORD_CHANGE_IN_PROGRESS", MENSAJE_CAMBIO_EN_CURSO);
  }
}

/** Resultado que llegó tarde: su reserva venció o la tomó otra solicitud. Misma respuesta acierte o no. */
export const resultadoObsoleto = () => new ConflictError(MENSAJE_OBSOLETO);

/**
 * Toma la reserva de la sesión, o explica por qué no.
 *
 * Una sola sentencia UPDATE condicional: dos solicitudes simultáneas no pueden obtenerla
 * ambas. No bloquea `users` ni retiene nada después.
 */
export async function reservarCambio(sessionId: string, userId: string, ahora: Date = new Date()): Promise<ReservaDeCambio> {
  const token = randomUUID();
  const { count } = await prisma.refreshSession.updateMany({
    where: {
      id: sessionId,
      userId,
      revokedAt: null,
      absoluteExpiresAt: { gt: ahora },
      passwordChangeFailures: { lt: MAX_FALLOS_CAMBIO_CONTRASENA },
      OR: [{ passwordChangeReservedUntil: null }, { passwordChangeReservedUntil: { lte: ahora } }],
    },
    data: { passwordChangeReservation: token, passwordChangeReservedUntil: new Date(ahora.getTime() + DURACION_RESERVA_MS) },
  });
  if (count === 1) return { sessionId, userId, token };

  // Diagnóstico de por qué no: cada causa tiene su respuesta.
  const sesion = await prisma.refreshSession.findUnique({
    where: { id: sessionId },
    select: { userId: true, revokedAt: true, absoluteExpiresAt: true, passwordChangeFailures: true, passwordChangeReservedUntil: true },
  });
  if (!sesion || sesion.userId !== userId || sesion.revokedAt !== null || sesion.absoluteExpiresAt <= ahora) throw sesionNoValida();
  // Presupuesto agotado sin sesión terminada no debería existir —el quinto fallo y la
  // revocación se confirman juntos—; si apareciera, se trata como sesión no válida.
  if (sesion.passwordChangeFailures >= MAX_FALLOS_CAMBIO_CONTRASENA) throw sesionNoValida();
  if (sesion.passwordChangeReservedUntil !== null && sesion.passwordChangeReservedUntil > ahora) throw new CambioDeContrasenaEnCursoError();
  // La reserva quedó libre entre la sentencia y el diagnóstico: se pide reintentar.
  throw new CambioDeContrasenaEnCursoError();
}

interface SesionReservada {
  id: string;
  userId: string;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  fallos: number;
  reserva: string | null;
  reservaHasta: Date | null;
}

/**
 * Estado de la reserva, con la sesión BLOQUEADA. Exige tener ya bloqueado al usuario.
 *
 *  - `sesion_invalida`: revocada, vencida o de otro usuario.
 *  - `obsoleta`: la reserva ya no es de este token, o venció.
 *  - `propia`: el resultado puede producir efectos.
 */
export async function estadoDeReserva(
  tx: Tx,
  reserva: ReservaDeCambio,
  ahora: Date = new Date()
): Promise<{ tipo: "sesion_invalida" } | { tipo: "obsoleta" } | { tipo: "propia"; fallos: number }> {
  const filas = await tx.$queryRaw<SesionReservada[]>`
    SELECT id,
           user_id AS "userId",
           absolute_expires_at AS "absoluteExpiresAt",
           revoked_at AS "revokedAt",
           password_change_failures AS "fallos",
           password_change_reservation AS "reserva",
           password_change_reserved_until AS "reservaHasta"
      FROM refresh_sessions
     WHERE id = ${reserva.sessionId}
       FOR UPDATE`;
  const s = filas[0];
  if (!s || s.userId !== reserva.userId || s.revokedAt !== null || s.absoluteExpiresAt <= ahora) return { tipo: "sesion_invalida" };
  if (s.reserva !== reserva.token || s.reservaHasta === null || s.reservaHasta <= ahora) return { tipo: "obsoleta" };
  return { tipo: "propia", fallos: s.fallos };
}

/**
 * Aplica una contraseña actual incorrecta. El incremento, la liberación de la reserva, la
 * revocación de la quinta y su auditoría van en UNA transacción: si cualquiera falla, no
 * queda ninguno. Devuelve el error que debe recibir el cliente.
 */
export async function aplicarFallo(reserva: ReservaDeCambio, ctx: RequestContext): Promise<AppError> {
  return prisma.$transaction(async (tx) => {
    await bloquearUsuario(tx, reserva.userId);
    const estado = await estadoDeReserva(tx, reserva);
    if (estado.tipo === "sesion_invalida") return sesionNoValida();
    if (estado.tipo === "obsoleta") return resultadoObsoleto();

    const fallos = estado.fallos + 1;
    await tx.refreshSession.update({
      where: { id: reserva.sessionId },
      data: { passwordChangeFailures: fallos, passwordChangeReservation: null, passwordChangeReservedUntil: null },
    });

    if (fallos >= MAX_FALLOS_CAMBIO_CONTRASENA) {
      await terminarSesion(tx, reserva.sessionId, "password_change_attempts");
      await audit(
        {
          userId: reserva.userId,
          action: "PASSWORD_CHANGE_ATTEMPTS_EXCEEDED",
          entityType: "RefreshSession",
          entityId: reserva.sessionId,
          ipAddress: ctx.ipAddress,
          after: { intentos: fallos },
        },
        { tx }
      );
      return new IntentosDeCambioAgotadosError();
    }

    await audit(
      {
        userId: reserva.userId,
        action: "PASSWORD_CHANGE_FAILED",
        entityType: "RefreshSession",
        entityId: reserva.sessionId,
        ipAddress: ctx.ipAddress,
        after: { intentos: fallos },
      },
      { tx }
    );
    return new ValidationError(MENSAJE_CONTRASENA_ACTUAL_INCORRECTA);
  }, OPCIONES_TX_SESION);
}

/**
 * Libera la reserva SOLO si sigue siendo la de este token. Nunca toca una reserva ajena,
 * y es inofensiva sobre una sesión ya terminada. Se usa cuando no se aplicó ningún efecto
 * (error de ejecución o resultado descartado).
 */
export async function liberarReserva(reserva: ReservaDeCambio): Promise<void> {
  await prisma.refreshSession.updateMany({
    where: { id: reserva.sessionId, passwordChangeReservation: reserva.token },
    data: { passwordChangeReservation: null, passwordChangeReservedUntil: null },
  });
}
