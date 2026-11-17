/**
 * C-05: protocolo COMÚN de concurrencia y de fechas para todas las vías que cambian membresías:
 * aprobar, rechazar, finalizar, asignar directamente, asignar masivamente, reasignar, postular y
 * resolver solicitudes de alta.
 *
 * PROTOCOLO. Dentro de la transacción de la operación:
 *   1. Bloqueo consultivo de la PERSONA (`c05:persona:<id>`), siempre DESPUÉS de los del club y
 *      del RUN cuando la vía también los toma (orden club → RUN → persona → filas).
 *   2. `SELECT … FOR UPDATE` de sus membresías pendientes y activas, en orden de id.
 *   3. Recién entonces se vuelven a leer y evaluar los estados: lo leído antes de bloquear no
 *      decide nada.
 * El índice único de membresía activa por persona queda como RESPALDO: las contradicciones
 * (aprobar frente a rechazar, frente a finalizar o frente a reasignar) las evita este orden.
 *
 * FECHAS. Las fechas de pertenencia son de calendario (`start_date`, `fecha_termino`) y se
 * distinguen del instante de la operación (`end_date`, `reviewed_at` y la auditoría).
 */
import type { Prisma } from "@prisma/client";
import { AppError, ValidationError } from "../../shared/errors";
import { diaCalendarioAnterior, fechaCalendarioAUtc, hoyEnZonaDelNegocio, utcAFechaCalendario } from "../../shared/fecha.util";
import { CLAVES_DE_BLOQUEO } from "../incorporaciones/incorporaciones.claves";

type Tx = Prisma.TransactionClient;

/** Error de negocio con un código estable para el cliente (va en `error` de la respuesta). */
export class ErrorDeMembresia extends AppError {
  constructor(status: number, codigo: string, mensaje: string, detalles?: unknown) {
    super(status, codigo, mensaje, detalles);
  }
}

export async function bloquear(tx: Tx, clave: string): Promise<void> {
  // `$executeRaw`: la función devuelve `void`, una columna que `$queryRaw` no sabe leer.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${clave}, 0))`;
}

export interface FilaMembresia {
  id: string;
  club_id: string;
  status: "pending" | "active" | "rejected" | "ended";
  start_date: string | null;
  end_date: Date | null;
  fecha_termino: string | null;
}

/** Pasos 1 y 2 del protocolo: bloqueo de la persona y de sus membresías pendientes y activas. */
export async function bloquearMembresiasDePersona(tx: Tx, personId: string): Promise<FilaMembresia[]> {
  await bloquear(tx, CLAVES_DE_BLOQUEO.persona(personId));
  return tx.$queryRaw<FilaMembresia[]>`
    SELECT id, club_id, status::text AS status, start_date::text AS start_date, end_date, fecha_termino::text AS fecha_termino
      FROM club_swimmers
     WHERE person_id = ${personId} AND status IN ('pending', 'active')
     ORDER BY id
       FOR UPDATE`;
}

/** Todas las membresías de la persona, para evaluar el historial (las finalizadas no cambian). */
export async function historialDePersona(tx: Tx, personId: string): Promise<FilaMembresia[]> {
  return tx.$queryRaw<FilaMembresia[]>`
    SELECT id, club_id, status::text AS status, start_date::text AS start_date, end_date, fecha_termino::text AS fecha_termino
      FROM club_swimmers
     WHERE person_id = ${personId}
     ORDER BY id`;
}

/**
 * Fecha efectiva de una activación: la pedida o, si no hay, hoy en Santiago. NUNCA futura
 * (decisión definitiva de C-05): no hay activaciones programadas.
 */
export function fechaEfectivaValida(fecha: string | undefined, ahora: Date = new Date()): string {
  const hoy = hoyEnZonaDelNegocio(ahora);
  const efectiva = fecha ?? hoy;
  if (efectiva > hoy) {
    throw new ErrorDeMembresia(400, "FECHA_FUTURA", `La fecha efectiva no puede ser posterior a hoy (${hoy}, America/Santiago).`, { hoy });
  }
  return efectiva;
}

export interface EvaluacionDeHistorial {
  /** Conflictos CONOCIDOS: con fechas registradas que contradicen la nueva. Siempre bloquean. */
  conflictos: { membresiaId: string; motivo: string }[];
  /** Membresías con fechas desconocidas que impiden descartar un solapamiento. */
  incompletas: string[];
}

/**
 * Evaluación PURA del historial frente a una fecha efectiva nueva.
 *
 * - La membresía activa que se finaliza (`vigente`) debe haber empezado ANTES de la fecha nueva:
 *   su término será el día anterior, que no puede preceder a su inicio. Con inicio desconocido,
 *   no se puede comprobar: queda como incompleta.
 * - Cada membresía FINALIZADA de la persona:
 *     · con `fecha_termino` conocida: la fecha nueva debe ser posterior; si no, conflicto;
 *     · con inicio conocido igual o posterior a la fecha nueva: conflicto;
 *     · con `fecha_termino` DESCONOCIDA: queda SIEMPRE como incompleta, aunque la operación
 *       (`end_date`) sea anterior a la fecha nueva. `end_date` es el instante en que se registró la
 *       baja, no una fecha de pertenencia: no sirve para descartar un solapamiento ni para omitir
 *       la aceptación, y no se completa nada por inferencia.
 */
export function evaluarHistorial(historial: readonly FilaMembresia[], fechaEfectiva: string, vigente?: FilaMembresia): EvaluacionDeHistorial {
  const conflictos: EvaluacionDeHistorial["conflictos"] = [];
  const incompletas: string[] = [];

  if (vigente) {
    if (vigente.start_date === null) incompletas.push(vigente.id);
    else if (fechaEfectiva <= vigente.start_date) {
      conflictos.push({ membresiaId: vigente.id, motivo: `la membresía vigente empezó el ${vigente.start_date}: la fecha efectiva debe ser posterior` });
    }
  }

  for (const m of historial) {
    if (m.status !== "ended") continue;
    if (m.fecha_termino !== null) {
      if (fechaEfectiva <= m.fecha_termino) {
        conflictos.push({ membresiaId: m.id, motivo: `una membresía anterior terminó el ${m.fecha_termino}` });
      }
      continue;
    }
    if (m.start_date !== null && m.start_date >= fechaEfectiva) {
      conflictos.push({ membresiaId: m.id, motivo: `una membresía anterior empezó el ${m.start_date}` });
      continue;
    }
    incompletas.push(m.id);
  }

  return { conflictos, incompletas };
}

export interface OpcionesDeActivacion {
  fechaEfectiva?: string;
  /** Id de la membresía ACTIVA en otro club que el administrador confirma finalizar. */
  confirmarFinDeMembresiaId?: string;
  /** Aceptación administrativa EXPLÍCITA de un historial con fechas desconocidas. */
  aceptarHistorialIncompleto?: boolean;
}

export interface DecisionDeActivacion {
  fechaEfectiva: string;
  /** Membresía activa en otro club que se finalizará (con confirmación). */
  vigente?: FilaMembresia;
  historialIncompletoAceptado: string[];
}

/**
 * Decide, con las filas YA BLOQUEADAS, si se puede activar una membresía en `clubId`.
 *
 * `permiteTraslado`: aprobar una propuesta, resolver un alta y `reassign` admiten finalizar
 * una membresía activa en otro club con confirmación explícita. `/direct` y `bulk-assign` NO:
 * siguen rechazando a quien está activo en otro club (`mensajeSinTraslado`).
 */
export function decidirActivacion(
  bloqueadas: readonly FilaMembresia[],
  historial: readonly FilaMembresia[],
  clubId: string,
  opciones: OpcionesDeActivacion & { fechaEfectiva: string },
  regla: { permiteTraslado: true } | { permiteTraslado: false; mensajeSinTraslado: (clubIdVigente: string) => string }
): DecisionDeActivacion {
  const activa = bloqueadas.find((m) => m.status === "active");

  if (activa && activa.club_id === clubId) {
    throw new ErrorDeMembresia(409, "YA_PERTENECE", "El nadador ya pertenece activamente a este club.");
  }

  let vigente: FilaMembresia | undefined;
  if (activa) {
    if (!regla.permiteTraslado) throw new ValidationError(regla.mensajeSinTraslado(activa.club_id));
    if (!opciones.confirmarFinDeMembresiaId) {
      throw new ErrorDeMembresia(
        409,
        "CONFIRMACION_REQUERIDA",
        "El nadador tiene una membresía activa en otro club. Confirme explícitamente cuál se finalizará.",
        { membresiaVigente: { id: activa.id, clubId: activa.club_id, startDate: activa.start_date } }
      );
    }
    if (opciones.confirmarFinDeMembresiaId !== activa.id) {
      throw new ErrorDeMembresia(409, "REVISAR_DE_NUEVO", "La membresía vigente cambió desde su revisión. Revise de nuevo antes de confirmar.", {
        membresiaVigente: { id: activa.id, clubId: activa.club_id, startDate: activa.start_date },
      });
    }
    vigente = activa;
  } else if (opciones.confirmarFinDeMembresiaId) {
    // Confirmó finalizar una membresía que ya no está vigente: algo cambió desde la revisión.
    throw new ErrorDeMembresia(409, "REVISAR_DE_NUEVO", "La membresía que confirmó finalizar ya no está vigente. Revise de nuevo.");
  }

  const { conflictos, incompletas } = evaluarHistorial(historial, opciones.fechaEfectiva, vigente);
  if (conflictos.length > 0) {
    throw new ErrorDeMembresia(409, "CONFLICTO_DE_FECHAS", "La fecha efectiva contradice fechas registradas en el historial del nadador.", { conflictos });
  }
  if (incompletas.length > 0 && opciones.aceptarHistorialIncompleto !== true) {
    throw new ErrorDeMembresia(
      409,
      "HISTORIAL_INCOMPLETO",
      "El historial del nadador tiene fechas desconocidas y no se puede descartar un solapamiento. Requiere aceptación administrativa explícita.",
      { membresias: incompletas }
    );
  }

  return { fechaEfectiva: opciones.fechaEfectiva, vigente, historialIncompletoAceptado: incompletas };
}

/**
 * Corrección de fechas: pasos 1 y 2 del protocolo sobre TODO el historial de la persona.
 *
 * Mismo bloqueo consultivo de la persona que las demás vías (y antes de cualquier fila), y luego
 * `FOR UPDATE` de TODAS sus membresías —también las finalizadas, que son justamente las que se
 * corrigen— en orden de id. Como todas las vías toman primero el bloqueo de la persona, ampliar
 * el conjunto de filas no introduce un orden de bloqueo distinto.
 */
export async function bloquearHistorialDePersona(tx: Tx, personId: string): Promise<FilaMembresia[]> {
  await bloquear(tx, CLAVES_DE_BLOQUEO.persona(personId));
  return tx.$queryRaw<FilaMembresia[]>`
    SELECT id, club_id, status::text AS status, start_date::text AS start_date, end_date, fecha_termino::text AS fecha_termino
      FROM club_swimmers
     WHERE person_id = ${personId}
     ORDER BY id
       FOR UPDATE`;
}

/**
 * Evaluación PURA de una corrección de fechas frente al resto del historial.
 *
 * Cada membresía activa o finalizada es un intervalo de calendario con extremos INCLUSIVOS:
 * DESDE = `start_date`; HASTA = `fecha_termino` si está finalizada, o abierto (sin término) si
 * está activa. Una fecha nula es DESCONOCIDA. Pendientes y rechazadas no son pertenencia.
 *
 * Con otra membresía `o`, la corregida `e` es:
 *  - compatible si una termina ANTES de que empiece la otra (`HASTA < DESDE`, estricto: el día
 *    siguiente al último día es el primero posible de la siguiente);
 *  - un CONFLICTO si todas las fechas que deciden se conocen y no son compatibles;
 *  - INCOMPLETA si alguna fecha desconocida impide descartar la superposición. No se infiere
 *    nada de `end_date`, que es el instante de la operación de baja.
 */
export function evaluarFechasCorregidas(
  corregida: Pick<FilaMembresia, "id" | "status" | "start_date" | "fecha_termino">,
  historial: readonly FilaMembresia[]
): EvaluacionDeHistorial {
  const conflictos: EvaluacionDeHistorial["conflictos"] = [];
  const incompletas: string[] = [];
  const ABIERTO = "9999-12-31";
  const terminoDe = (m: Pick<FilaMembresia, "status" | "fecha_termino">) => (m.status === "active" ? ABIERTO : m.fecha_termino);
  const eInicio = corregida.start_date;
  const eFin = terminoDe(corregida);

  for (const o of historial) {
    if (o.id === corregida.id || (o.status !== "active" && o.status !== "ended")) continue;
    const oInicio = o.start_date;
    const oFin = terminoDe(o);
    const eAntes = eFin !== null && oInicio !== null && eFin < oInicio;
    const oAntes = oFin !== null && eInicio !== null && oFin < eInicio;
    if (eAntes || oAntes) continue;
    if (eInicio !== null && eFin !== null && oInicio !== null && oFin !== null) {
      const hasta = oFin === ABIERTO ? "sin término (vigente)" : `hasta el ${oFin}`;
      conflictos.push({ membresiaId: o.id, motivo: `se superpone con otra membresía (desde el ${oInicio}, ${hasta})` });
    } else {
      incompletas.push(o.id);
    }
  }
  return { conflictos, incompletas };
}

/** Finaliza la membresía vigente por traslado: término = día calendario ANTERIOR al nuevo inicio. */
export async function finalizarPorTraslado(tx: Tx, vigente: FilaMembresia, fechaEfectiva: string, ahora: Date) {
  return tx.clubSwimmer.update({
    where: { id: vigente.id },
    data: { status: "ended", endDate: ahora, fechaTermino: fechaCalendarioAUtc(diaCalendarioAnterior(fechaEfectiva)) },
  });
}

/** `start_date` de Prisma (Date a medianoche UTC) como fecha de calendario. */
export const comoFecha = (d: Date | null | undefined) => utcAFechaCalendario(d ?? null);
