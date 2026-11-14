/**
 * COMPETENCIA POR DEFECTO de los paneles de Inscripción y de Relevos.
 *
 * Es una preferencia GLOBAL que solo marca la administración (la ruta exige el rol `admin`
 * además de `competitions:write`). Cada panel preselecciona la competencia marcada SOLO si
 * está entre las que esa cuenta ya puede ver y elegir en su desplegable: este módulo no
 * cambia la visibilidad, ni el estado, ni las fechas, ni abre inscripciones.
 *
 * COMO MÁXIMO UNA, TAMBIÉN EN CONCURRENCIA:
 *  - el índice único parcial `competitions_una_predeterminada` es la garantía de la base;
 *  - el servicio toma un bloqueo consultivo de transacción antes de leer y escribir, de modo
 *    que dos administraciones que marcan competencias distintas a la vez se ordenan: la
 *    segunda ve la marca de la primera y la reemplaza (la última confirmada gana), en vez
 *    de chocar contra el índice.
 *
 * Las escrituras son SQL directo sobre `es_predeterminada` a propósito: `tx.competition.update`
 * tocaría `updated_at`, y marcar la preferencia no es editar la competencia.
 *
 * Auditoría en la MISMA transacción: `COMPETITION_DEFAULT_SET` (con la anterior y la nueva)
 * y `COMPETITION_DEFAULT_CLEARED`. Repetir una operación que no cambia nada no audita.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { audit } from "../audit/audit.service";
import { NotFoundError } from "../../shared/errors";

interface ContextoDeAuditoria {
  userId: string;
  ipAddress?: string;
}

/** Clave del bloqueo consultivo que serializa los cambios de la predeterminada. */
export const CLAVE_BLOQUEO_PREDETERMINADA = "competencias:predeterminada";

export interface ResultadoPredeterminada {
  /** La competencia predeterminada tras la operación, o `null` si no queda ninguna. */
  competenciaPredeterminadaId: string | null;
  /** `false` si la operación no cambió nada (repetición). */
  cambio: boolean;
}

async function bloquear(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CLAVE_BLOQUEO_PREDETERMINADA}, 0))`;
}

async function predeterminadaActual(tx: Prisma.TransactionClient): Promise<string | null> {
  const filas = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM competitions WHERE es_predeterminada FOR UPDATE`;
  return filas[0]?.id ?? null;
}

async function exigirExistente(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const filas = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM competitions WHERE id = ${id} FOR UPDATE`;
  if (filas.length === 0) throw new NotFoundError("Competencia");
}

/** Marca `id` como la competencia predeterminada; desmarca la anterior si la había. */
export async function marcarPredeterminada(id: string, actor: ContextoDeAuditoria): Promise<ResultadoPredeterminada> {
  return prisma.$transaction(async (tx) => {
    await bloquear(tx);
    await exigirExistente(tx, id);
    const anterior = await predeterminadaActual(tx);
    if (anterior === id) return { competenciaPredeterminadaId: id, cambio: false };

    if (anterior) await tx.$executeRaw`UPDATE competitions SET es_predeterminada = false WHERE id = ${anterior}`;
    await tx.$executeRaw`UPDATE competitions SET es_predeterminada = true WHERE id = ${id}`;
    await audit(
      {
        userId: actor.userId,
        action: "COMPETITION_DEFAULT_SET",
        entityType: "Competition",
        entityId: id,
        ipAddress: actor.ipAddress,
        before: { competenciaPredeterminadaId: anterior },
        after: { competenciaPredeterminadaId: id },
      },
      { tx }
    );
    return { competenciaPredeterminadaId: id, cambio: true };
  });
}

/**
 * Quita la marca de `id`. Si `id` ya no es la predeterminada (otra administración marcó otra
 * entretanto) no hace nada: nunca desmarca una competencia distinta de la pedida.
 */
export async function quitarPredeterminada(id: string, actor: ContextoDeAuditoria): Promise<ResultadoPredeterminada> {
  return prisma.$transaction(async (tx) => {
    await bloquear(tx);
    await exigirExistente(tx, id);
    const anterior = await predeterminadaActual(tx);
    if (anterior !== id) return { competenciaPredeterminadaId: anterior, cambio: false };

    await tx.$executeRaw`UPDATE competitions SET es_predeterminada = false WHERE id = ${id}`;
    await audit(
      {
        userId: actor.userId,
        action: "COMPETITION_DEFAULT_CLEARED",
        entityType: "Competition",
        entityId: id,
        ipAddress: actor.ipAddress,
        before: { competenciaPredeterminadaId: id },
        after: { competenciaPredeterminadaId: null },
      },
      { tx }
    );
    return { competenciaPredeterminadaId: null, cambio: true };
  });
}
