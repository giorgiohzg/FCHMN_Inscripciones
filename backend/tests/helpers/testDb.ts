/**
 * Salvaguarda y utilidades de la base de datos de pruebas.
 *
 * Contexto: estas pruebas escriben y BORRAN filas. Una ejecución accidental
 * contra la base de trabajo ya destruyó datos una vez (categorías, jornadas,
 * pruebas de competencia e inscripciones). Este módulo existe para que eso
 * no pueda repetirse.
 *
 * La comprobación es acumulativa: deben cumplirse TODAS las condiciones. Ni
 * el puerto ni el sufijo del nombre bastan por sí solos — alguien podría
 * levantar una base real llamada `algo_test` en el 55432, o exponer la de
 * trabajo por un túnel en ese puerto.
 *
 *   1. Host local o el servicio de Compose (nunca una base remota).
 *   2. Puerto 55432, el de `docker-compose.test.yml`.
 *   3. Nombre terminado en `_test`.
 *   4. Confirmación explícita por variable de entorno.
 *   5. Marcador dentro de la propia base, escrito por el setup de esta suite:
 *      es la única condición que no se puede satisfacer por accidente desde
 *      fuera, porque exige que la base haya sido preparada por estas pruebas.
 */

/** Puerto declarado en `docker-compose.test.yml` — nunca el 5432 de trabajo. */
const EXPECTED_PORT = "55432";

/** Toda base de pruebas debe llamarse así; el guard lo exige. */
const REQUIRED_DB_SUFFIX = "_test";

/** Solo bases locales o el servicio del compose de pruebas. */
const ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]", "postgres-test"];

/** Valor exacto que debe tener `ALLOW_DESTRUCTIVE_TESTS` en `.env.test`. */
const CONFIRMATION_VALUE = "si-esta-base-es-desechable";

/** Tabla marcadora que el setup crea en la base de pruebas. */
export const MARKER_TABLE = "_test_database_marker";

export interface TestDatabaseTarget {
  host: string;
  port: string;
  database: string;
}

export type GuardResult = { ok: true; target: TestDatabaseTarget } | { ok: false; reason: string };

/**
 * Valida la cadena de conexión y la confirmación explícita, SIN conectarse.
 * Se exporta aparte de `assertDisposableDatabase` para poder probar el guard
 * con casos negativos sin matar el proceso de pruebas.
 */
export function checkDisposableDatabaseUrl(databaseUrl: string | undefined, confirmation?: string): GuardResult {
  if (!databaseUrl) {
    return { ok: false, reason: "DATABASE_URL no está definida. Copie backend/.env.test.example a backend/.env.test." };
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { ok: false, reason: "DATABASE_URL no es una URL válida." };
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    return { ok: false, reason: `Protocolo inesperado "${parsed.protocol}": se esperaba postgresql.` };
  }

  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return {
      ok: false,
      reason: `El host "${parsed.hostname}" no es local ni el servicio de docker-compose.test.yml. Las pruebas destructivas no pueden correr contra una base remota.`,
    };
  }

  const database = parsed.pathname.replace(/^\//, "");
  if (!database.endsWith(REQUIRED_DB_SUFFIX)) {
    return {
      ok: false,
      reason: `La base "${database}" no termina en "${REQUIRED_DB_SUFFIX}". Las pruebas de integración solo pueden correr contra una base desechable.`,
    };
  }

  if (parsed.port !== EXPECTED_PORT) {
    return {
      ok: false,
      reason: `El puerto ${parsed.port || "(por defecto)"} no es el ${EXPECTED_PORT} de docker-compose.test.yml. Se rechaza para no apuntar a la base de trabajo.`,
    };
  }

  if (confirmation !== CONFIRMATION_VALUE) {
    return {
      ok: false,
      reason: `Falta la confirmación explícita: defina ALLOW_DESTRUCTIVE_TESTS="${CONFIRMATION_VALUE}" en backend/.env.test para autorizar el borrado de esta base.`,
    };
  }

  return { ok: true, target: { host: parsed.hostname, port: parsed.port, database } };
}

/** Corta el proceso si el destino no cumple TODAS las condiciones. */
export function assertDisposableDatabase(): TestDatabaseTarget {
  const result = checkDisposableDatabaseUrl(process.env.DATABASE_URL, process.env.ALLOW_DESTRUCTIVE_TESTS);
  if (!result.ok) {
    throw new Error(
      `[pruebas de integración] Conexión rechazada por seguridad.\n` +
        `  Motivo: ${result.reason}\n` +
        `  Levante la base desechable con: docker compose -f docker-compose.test.yml up -d`
    );
  }
  return result.target;
}

interface RawClient {
  $queryRawUnsafe: (sql: string) => Promise<unknown>;
  $executeRawUnsafe: (sql: string) => Promise<unknown>;
}

/**
 * Crea el marcador que autoriza el borrado. Lo llama el setup global una vez
 * validada la URL; ninguna base que no haya pasado por aquí puede truncarse.
 */
export async function createDisposableMarker(client: RawClient): Promise<void> {
  assertDisposableDatabase();
  await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${MARKER_TABLE}" (id int PRIMARY KEY, note text NOT NULL)`);
  await client.$executeRawUnsafe(
    `INSERT INTO "${MARKER_TABLE}" (id, note) VALUES (1, 'Base DESECHABLE de pruebas. Cualquier dato aquí puede borrarse sin aviso.') ON CONFLICT (id) DO NOTHING`
  );
}

async function hasDisposableMarker(client: RawClient): Promise<boolean> {
  const rows = (await client.$queryRawUnsafe(
    `SELECT 1 AS present FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${MARKER_TABLE}'`
  )) as unknown[];
  return rows.length > 0;
}

/**
 * Vacía todas las tablas de negocio conservando el esquema, las migraciones
 * aplicadas y el marcador. Se usa entre archivos de prueba para partir
 * siempre del mismo estado sin recrear la base.
 */
export async function truncateAllTables(client: RawClient) {
  assertDisposableDatabase();

  if (!(await hasDisposableMarker(client))) {
    throw new Error(
      `[pruebas de integración] La base no tiene el marcador "${MARKER_TABLE}" que la identifica como desechable. ` +
        `Se aborta el TRUNCATE: esta base no fue preparada por la suite de pruebas.`
    );
  }

  const rows = (await client.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', '${MARKER_TABLE}')`
  )) as { tablename: string }[];

  if (rows.length === 0) return;

  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
