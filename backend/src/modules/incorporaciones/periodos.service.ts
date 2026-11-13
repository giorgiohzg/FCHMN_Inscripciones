/**
 * C-05: periodos GLOBALES de cambio de club. Los crea, lista y cierra SOLO administración, con
 * auditoría. Fechas de calendario inclusivas de America/Santiago. No hay apertura automática
 * (marzo y agosto son habituales, pero los abre administración).
 *
 * INMUTABILIDAD. No existe vía para editar fechas ni para reabrir un periodo: la base solo
 * rechaza la reapertura que crearía un solape (restricción de exclusión), así que la garantía
 * general de que un periodo cerrado no cambia la da este servicio al no ofrecer esas operaciones.
 * El historial se conserva: cerrar no borra.
 *
 * Cerrar un periodo NO toca las propuestas ni las solicitudes pendientes: administración las
 * resuelve después. Un cierre concurrente con una postulación espera a que esta termine (la
 * postulación lee el periodo con `FOR SHARE`).
 */
import { prisma } from "../../shared/prisma.client";
import { AppError, NotFoundError } from "../../shared/errors";
import { fechaCalendarioAUtc, hoyEnZonaDelNegocio, utcAFechaCalendario } from "../../shared/fecha.util";
import { audit } from "../audit/audit.service";
import { bloquear } from "../swimmer-assignment/membresias.protocolo";
import { CLAVES_DE_BLOQUEO } from "./incorporaciones.claves";

interface Actor {
  userId: string;
  ipAddress?: string;
}

const vista = (p: { id: string; inicio: Date; fin: Date; motivo: string | null; creadoEn: Date; cerradoEn: Date | null }) => ({
  id: p.id,
  inicio: utcAFechaCalendario(p.inicio),
  fin: utcAFechaCalendario(p.fin),
  motivo: p.motivo,
  creadoEn: p.creadoEn,
  cerradoEn: p.cerradoEn,
});

export async function listarPeriodos() {
  const periodos = await prisma.periodoCambioClub.findMany({ orderBy: [{ inicio: "desc" }, { id: "asc" }] });
  return periodos.map(vista);
}

export async function crearPeriodo(input: { inicio: string; fin: string; motivo?: string }, actor: Actor, opciones?: { ahora?: Date }) {
  const hoy = hoyEnZonaDelNegocio(opciones?.ahora ?? new Date());
  if (input.fin < input.inicio) throw new AppError(400, "PERIODO_FECHAS_INVALIDAS", "La fecha de fin no puede ser anterior a la de inicio.");
  if (input.fin < hoy) throw new AppError(400, "PERIODO_EN_EL_PASADO", `El periodo terminaría antes de hoy (${hoy}): no habilitaría ningún cambio.`);

  return prisma.$transaction(async (tx) => {
    // Serializa las altas de periodos: la comprobación de solape es la del mensaje claro; la
    // restricción de exclusión de la base queda como respaldo.
    await bloquear(tx, CLAVES_DE_BLOQUEO.periodos());
    const solapado = await tx.periodoCambioClub.findFirst({
      where: { cerradoEn: null, inicio: { lte: fechaCalendarioAUtc(input.fin) }, fin: { gte: fechaCalendarioAUtc(input.inicio) } },
      select: { id: true, inicio: true, fin: true },
    });
    if (solapado) {
      throw new AppError(409, "PERIODO_SOLAPADO", "Ya existe un periodo abierto que se solapa con esas fechas.", {
        periodo: { id: solapado.id, inicio: utcAFechaCalendario(solapado.inicio), fin: utcAFechaCalendario(solapado.fin) },
      });
    }
    const creado = await tx.periodoCambioClub.create({
      data: { inicio: fechaCalendarioAUtc(input.inicio), fin: fechaCalendarioAUtc(input.fin), motivo: input.motivo?.trim() || null, creadoPorUserId: actor.userId },
    });
    await audit({ userId: actor.userId, action: "CHANGE_PERIOD_CREATED", entityType: "PeriodoCambioClub", entityId: creado.id, ipAddress: actor.ipAddress, after: creado }, { tx });
    return vista(creado);
  });
}

/** Cierre anticipado. Un periodo ya cerrado no se vuelve a cerrar (409): no hay reapertura. */
export async function cerrarPeriodo(id: string, actor: Actor, opciones?: { ahora?: Date }) {
  const ahora = opciones?.ahora ?? new Date();
  return prisma.$transaction(async (tx) => {
    // FOR UPDATE: espera a las postulaciones que leyeron este periodo con FOR SHARE.
    const filas = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM periodos_cambio_club WHERE id = ${id} FOR UPDATE`;
    if (filas.length === 0) throw new NotFoundError("Periodo de cambio");
    const antes = await tx.periodoCambioClub.findUniqueOrThrow({ where: { id } });
    if (antes.cerradoEn) throw new AppError(409, "PERIODO_YA_CERRADO", "El periodo ya está cerrado. Un periodo cerrado no se reabre ni se modifica.");
    const cerrado = await tx.periodoCambioClub.update({ where: { id }, data: { cerradoEn: ahora, cerradoPorUserId: actor.userId } });
    await audit(
      { userId: actor.userId, action: "CHANGE_PERIOD_CLOSED", entityType: "PeriodoCambioClub", entityId: id, ipAddress: actor.ipAddress, before: antes, after: cerrado },
      { tx }
    );
    return vista(cerrado);
  });
}

/** Lo que ve el club: si hay un periodo vigente HOY (Santiago) y sus fechas. Sin datos personales. */
export async function periodoVigente(opciones?: { ahora?: Date }) {
  const hoy = fechaCalendarioAUtc(hoyEnZonaDelNegocio(opciones?.ahora ?? new Date()));
  const p = await prisma.periodoCambioClub.findFirst({ where: { cerradoEn: null, inicio: { lte: hoy }, fin: { gte: hoy } }, orderBy: { inicio: "asc" } });
  return p ? { vigente: true, inicio: utcAFechaCalendario(p.inicio), fin: utcAFechaCalendario(p.fin) } : { vigente: false };
}
