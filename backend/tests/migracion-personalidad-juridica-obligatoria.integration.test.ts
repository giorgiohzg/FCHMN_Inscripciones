/**
 * La migración 10b, `20261103030000_personalidad_juridica_obligatoria`: `clubs.has_legal_status`
 * pasa a `NOT NULL`, sin valor por omisión, y NO convierte ni borra nada.
 *
 * Todo ocurre en una base APARTE y desechable, que se prepara en el esquema ANTERIOR a 10b
 * (con la columna todavía anulable) para poder sembrar lo que ese esquema admite, incluido un
 * `NULL`. Así el esquema final no se debilita para conservar estas pruebas.
 *
 *   1. Aplicación completa de las migraciones en orden desde una base vacía (10a y 10b incluidas).
 *   2. 10b con solo `true` y `false`: se aplica sin alterar esos datos.
 *   3. 10b con un `NULL`: se detiene con diagnóstico, sin modificar nada.
 *   4. Después de migrar: la base rechaza `NULL`, y no hay DEFAULT.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";

const BACKEND_DIR = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(BACKEND_DIR, "prisma", "migrations");

const MIGRACION_10A = "20261102020000_personalidad_juridica_sin_pendiente";
const MIGRACION_10B = "20261103030000_personalidad_juridica_obligatoria";

const BASE_COMPLETA = "natacion_pj_obligatoria_orden_test";
const BASE_LIMPIA = "natacion_pj_obligatoria_limpia_test";
const BASE_CON_NULL = "natacion_pj_obligatoria_null_test";

let adminUrl: string;
let workDir: string;

function urlConBase(database: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

async function conCliente<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function desplegar(nombres: string[], databaseUrl: string) {
  const destino = join(workDir, "prisma", "migrations");
  rmSync(destino, { recursive: true, force: true });
  mkdirSync(destino, { recursive: true });
  for (const n of nombres) cpSync(join(MIGRATIONS_DIR, n), join(destino, n), { recursive: true });
  cpSync(join(MIGRATIONS_DIR, "migration_lock.toml"), join(destino, "migration_lock.toml"));

  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", join(workDir, "prisma", "schema.prisma")], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
    shell: process.platform === "win32",
  });
}

const todas = () =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
/** El esquema ANTERIOR a 10b: todo lo que la precede, 10a incluida. */
const hastaAntesDe10b = () => todas().filter((n) => n < MIGRACION_10B);
/** Todo hasta 10b inclusive (nada posterior: la prueba no debe depender de migraciones futuras). */
const hasta10b = () => todas().filter((n) => n <= MIGRACION_10B);

function salidaDelFallo(nombres: string[], url: string): string | null {
  try {
    desplegar(nombres, url);
    return null;
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    return `${err.stdout?.toString() ?? ""}\n${err.stderr?.toString() ?? ""}\n${err.message ?? ""}`;
  }
}

const crearBase = (nombre: string) =>
  conCliente(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${nombre}"`);
    await c.query(`CREATE DATABASE "${nombre}"`);
  });

const insertarClub = (c: Client, id: string, nombre: string, sigla: string, estado: string, rut: string | null = null) =>
  c.query(
    `INSERT INTO clubs (id, name, code, status, has_legal_status, rut, updated_at) VALUES ($1, $2, $3, 'active', ${estado}, $4, now())`,
    [id, nombre, sigla, rut]
  );

const foto = (c: Client) => c.query(`SELECT id, name, code, has_legal_status, rut FROM clubs ORDER BY id`).then((r) => r.rows);
const columna = (c: Client) =>
  c.query(`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'clubs' AND column_name = 'has_legal_status'`).then((r) => r.rows[0]);

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL (use .env.test)");
  adminUrl = urlConBase("postgres");
  workDir = mkdtempSync(join(tmpdir(), "migra-pj-obligatoria-"));
  mkdirSync(join(workDir, "prisma"), { recursive: true });
  cpSync(join(BACKEND_DIR, "prisma", "schema.prisma"), join(workDir, "prisma", "schema.prisma"));
}, 60_000);

afterAll(async () => {
  if (adminUrl) {
    for (const base of [BASE_COMPLETA, BASE_LIMPIA, BASE_CON_NULL]) {
      await conCliente(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${base}"`));
    }
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("aplicación completa en orden, desde una base vacía", () => {
  it("10a y 10b se aplican en ese orden y quedan registradas sin error", async () => {
    await crearBase(BASE_COMPLETA);
    const url = urlConBase(BASE_COMPLETA);
    desplegar(hasta10b(), url);

    await conCliente(url, async (c) => {
      const { rows } = await c.query(
        `SELECT migration_name, finished_at IS NOT NULL AS terminada, rolled_back_at IS NULL AS sin_reversion
           FROM _prisma_migrations WHERE migration_name IN ($1, $2) ORDER BY started_at`,
        [MIGRACION_10A, MIGRACION_10B]
      );
      expect(rows.map((r) => r.migration_name)).toEqual([MIGRACION_10A, MIGRACION_10B]);
      expect(rows.every((r) => r.terminada && r.sin_reversion)).toBe(true);
      const col = await columna(c);
      expect(col.is_nullable).toBe("NO");
    });
  }, 240_000);
});

describe("10b con solo true y false", () => {
  beforeAll(async () => {
    await crearBase(BASE_LIMPIA);
    desplegar(hastaAntesDe10b(), urlConBase(BASE_LIMPIA));
    await conCliente(urlConBase(BASE_LIMPIA), async (c) => {
      // En el esquema anterior la columna todavía admite NULL.
      expect((await columna(c)).is_nullable).toBe("YES");
      await insertarClub(c, "c-true", "Club Con PJ", "CPJ", "true", "111111111");
      await insertarClub(c, "c-false", "Club Sin PJ", "SPJ", "false");
      await insertarClub(c, "c-false-rut", "Club Sin PJ Con RUT", "SPR", "false", "444444444");
    });
  }, 240_000);

  let antes: unknown[];

  it("se aplica SIN alterar ni un solo dato", async () => {
    const url = urlConBase(BASE_LIMPIA);
    antes = await conCliente(url, foto);
    desplegar(hasta10b(), url);
    expect(await conCliente(url, foto)).toEqual(antes);
    expect(antes).toHaveLength(3);
  }, 120_000);

  it("la columna queda NOT NULL y SIN valor por omisión", async () => {
    const col = await conCliente(urlConBase(BASE_LIMPIA), columna);
    expect(col.is_nullable).toBe("NO");
    expect(col.column_default, "la API debe exigir el booleano: la base no decide por nadie").toBeNull();
  });

  it("la base rechaza NULL, ya sea explícito o por omisión del campo", async () => {
    await conCliente(urlConBase(BASE_LIMPIA), async (c) => {
      await expect(insertarClub(c, "c-nulo", "Club Nulo", "NUL", "NULL")).rejects.toThrow(/has_legal_status|null value|not-null/i);
      await expect(
        c.query(`INSERT INTO clubs (id, name, code, status, updated_at) VALUES ('c-omitido', 'Club Omitido', 'OMI', 'active', now())`)
      ).rejects.toThrow(/has_legal_status|null value|not-null/i);
      await expect(c.query(`UPDATE clubs SET has_legal_status = NULL WHERE id = 'c-true'`)).rejects.toThrow(/has_legal_status|null value|not-null/i);
      expect((await c.query(`SELECT count(*)::int AS n FROM clubs`)).rows[0].n, "ningún intento dejó filas").toBe(3);
    });
  });

  it("true y false siguen aceptándose", async () => {
    await conCliente(urlConBase(BASE_LIMPIA), async (c) => {
      await insertarClub(c, "c-nuevo-t", "Nuevo T", "NVT", "true", "555555555");
      await insertarClub(c, "c-nuevo-f", "Nuevo F", "NVF", "false");
    });
  });
});

describe("10b con un NULL: se detiene con diagnóstico y no modifica nada", () => {
  beforeAll(async () => {
    await crearBase(BASE_CON_NULL);
    desplegar(hastaAntesDe10b(), urlConBase(BASE_CON_NULL));
    await conCliente(urlConBase(BASE_CON_NULL), async (c) => {
      await insertarClub(c, "c-true", "Club Con PJ", "CPJ", "true", "111111111");
      // Un pendiente que aparece DESPUÉS de la 10a (la columna aún lo admite) y otro eliminado lógicamente.
      await insertarClub(c, "c-pend", "Club Pendiente", "PEN", "NULL", "222222222");
      await insertarClub(c, "c-pend-borrado", "Club Pendiente Borrado", "PBO", "NULL");
      await c.query(`UPDATE clubs SET deleted_at = now() WHERE id = 'c-pend-borrado'`);
    });
  }, 240_000);

  it("rechaza con el detalle: cuántos, cuáles, y que no convierte nada", async () => {
    const url = urlConBase(BASE_CON_NULL);
    const antes = await conCliente(url, foto);

    const salida = salidaDelFallo(hasta10b(), url);

    expect(salida, "la migración debió fallar").not.toBeNull();
    expect(salida).toMatch(/Hay 2 club\(es\) con personalidad jurídica pendiente \(has_legal_status NULL\)/);
    expect(salida).toContain("Club Pendiente (c-pend)");
    expect(salida).toContain("Club Pendiente Borrado (c-pend-borrado, eliminado lógicamente)");
    expect(salida).not.toContain("Club Con PJ");
    expect(salida).toMatch(/no modifica nada/);
    expect(salida).toMatch(/20261102020000_personalidad_juridica_sin_pendiente/);
    expect(salida, "el diagnóstico llega completo, no el «transaction is aborted» genérico").not.toMatch(/current transaction is aborted/i);

    await conCliente(url, async (c) => {
      expect(await foto(c), "ni convierte ni borra").toEqual(antes);
      const col = await columna(c);
      expect(col.is_nullable, "la columna sigue como estaba").toBe("YES");
    });
  }, 240_000);

  it("el NULL no se convierte solo: tras decidirlo quien corresponde, 10b se aplica", async () => {
    const url = urlConBase(BASE_CON_NULL);
    await conCliente(url, async (c) => {
      // La decisión (convertirlos, como hace la 10a) es del negocio; aquí se simula con SQL explícito.
      await c.query(`UPDATE clubs SET has_legal_status = false, rut = NULL WHERE has_legal_status IS NULL`);
      // La migración fallida quedó registrada como fallida: se marca para reintentar, igual que `migrate resolve --rolled-back`.
      await c.query(`DELETE FROM _prisma_migrations WHERE migration_name = $1`, [MIGRACION_10B]);
    });
    desplegar(hasta10b(), url);
    await conCliente(url, async (c) => {
      expect((await columna(c)).is_nullable).toBe("NO");
      const { rows } = await c.query(`SELECT id, has_legal_status FROM clubs ORDER BY id`);
      expect(rows).toEqual([
        { id: "c-pend", has_legal_status: false },
        { id: "c-pend-borrado", has_legal_status: false },
        { id: "c-true", has_legal_status: true },
      ]);
    });
  }, 240_000);
});
