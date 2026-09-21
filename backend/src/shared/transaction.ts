import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.client";

/**
 * Cliente de base de datos: el global o uno transaccional.
 *
 * El problema que resuelve (hallazgo 18): todos los servicios escribían
 * siempre con el `prisma` global, así que un flujo compuesto por varias
 * llamadas —crear un club y su personal, aprobar una membresía, importar una
 * competencia— no podía ser atómico ni aunque el llamador abriera una
 * transacción: cada servicio escribía por su cuenta, fuera de ella. Un fallo
 * a mitad de camino dejaba el flujo escrito a medias, y la única defensa
 * posible era una limpieza compensatoria que no cubre la caída del proceso.
 *
 * La convención es uniforme: cada servicio que escribe recibe un último
 * parámetro opcional `{ tx }`. Si viene, escribe dentro de esa transacción;
 * si no, usa el cliente global y se comporta exactamente como antes. Así el
 * cambio es incremental y no obliga a tocar a todos los llamadores.
 */
export type Db = Prisma.TransactionClient | typeof prisma;

/** Opción que aceptan los servicios que pueden participar de una transacción. */
export interface TxOption {
  tx?: Prisma.TransactionClient;
}

/** Devuelve el cliente transaccional si se entregó, o el global si no. */
export function dbFrom(options?: TxOption): Db {
  return options?.tx ?? prisma;
}

/**
 * Tiempos de las transacciones interactivas.
 *
 * El valor por defecto de Prisma (5 s) alcanza para las operaciones
 * corrientes, pero no para la importación de una competencia, que puede
 * insertar decenas de pruebas con varias consultas cada una. Se sube el
 * límite solo donde hace falta, en vez de dejar un valor global alto que
 * enmascare consultas lentas.
 */
export const LONG_TRANSACTION_OPTIONS = {
  /** Espera máxima para obtener una conexión del pool. */
  maxWait: 10_000,
  /** Duración máxima de la transacción. */
  timeout: 60_000,
} as const;

/** Un nombre de SAVEPOINT se interpola en SQL: solo se admite un identificador simple. */
const NOMBRE_DE_SAVEPOINT = /^[a-z_][a-z0-9_]*$/;

/**
 * Ejecuta un bloque dentro de un SAVEPOINT, de modo que su fallo revierta
 * SOLO ese bloque y no la transacción completa.
 *
 * Hace falta porque PostgreSQL aborta la transacción entera ante cualquier
 * sentencia fallida: dentro de una transacción, un `try/catch` alrededor de
 * una consulta no "continúa como si nada" — deja la transacción en estado
 * abortado y todo lo siguiente falla con "current transaction is aborted".
 *
 * Es decir: un flujo que tolera fallos parciales (la importación, que puede
 * saltarse pruebas individuales y seguir) no puede simplemente envolverse en
 * una transacción; necesita un punto de retorno por cada intento tolerado.
 *
 * Prisma no expone savepoints, así que se emiten a mano. El nombre se valida
 * porque se interpola directamente en el SQL.
 */
export async function withSavepoint<T>(tx: Prisma.TransactionClient, name: string, fn: () => Promise<T>): Promise<T> {
  if (!NOMBRE_DE_SAVEPOINT.test(name)) {
    throw new Error(`Nombre de savepoint inválido: ${name}`);
  }
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    // Si el propio ROLLBACK falla, la transacción ya no es recuperable: se
    // propaga ese error, no el original, porque describe el estado real.
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    // ROLLBACK TO SAVEPOINT NO elimina el savepoint: queda establecido y
    // vuelve a ser reutilizable. Sin este RELEASE, cada intento fallido deja
    // un savepoint vivo en la transacción, y una importación con muchas
    // pruebas problemáticas los va acumulando durante toda su duración.
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    throw err;
  }
}
