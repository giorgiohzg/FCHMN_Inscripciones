/**
 * La migración `20261103020000_sigla_club_unica`, probada CONTRA DATOS QUE YA EXISTEN.
 *
 * Lo que puede salir mal es justo lo que una base vacía no muestra: que haya clubes
 * anteriores con la misma sigla. Entonces la migración debe DETENERSE con el detalle y sin
 * tocar ningún club; no renombra, no fusiona ni elimina. Una vez corregidos los datos por
 * quien corresponde, se aplica y la unicidad queda garantizada.
 *
 * Procedimiento (el de `migracion-fecha-efectiva.integration.test.ts`): una base aparte con
 * todas las migraciones anteriores, poblada a mano, y recién entonces la migración.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";

const BACKEND_DIR = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(BACKEND_DIR, "prisma", "migrations");

const MIGRACION = "20261103020000_sigla_club_unica";
const DB_PRUEBA = "natacion_migra_sigla_test";

let adminUrl: string;
let dbUrl: string;
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

/** Todas las migraciones anteriores a la que se prueba. */
const anteriores = () =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name < MIGRACION)
    .map((d) => d.name)
    .sort();

/** Lo que `prisma migrate deploy` escribió por stderr/stdout al fallar. */
function salidaDelFallo(nombres: string[]): string {
  try {
    desplegar(nombres, dbUrl);
    return "";
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    return `${err.stdout?.toString() ?? ""}\n${err.stderr?.toString() ?? ""}\n${err.message ?? ""}`;
  }
}

const insertarClub = (c: Client, id: string, nombre: string, sigla: string, extra = "'active', NULL") =>
  c.query(`INSERT INTO clubs (id, name, code, status, deleted_at, has_legal_status, updated_at) VALUES ($1, $2, $3, ${extra}, false, now())`, [id, nombre, sigla]);

const fotoDeClubes = (c: Client) =>
  c.query(`SELECT id, name, code, status::text, deleted_at FROM clubs ORDER BY id`).then((r) => r.rows);

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL (use .env.test)");
  adminUrl = urlConBase("postgres");
  dbUrl = urlConBase(DB_PRUEBA);

  workDir = mkdtempSync(join(tmpdir(), "migra-sigla-"));
  mkdirSync(join(workDir, "prisma"), { recursive: true });
  cpSync(join(BACKEND_DIR, "prisma", "schema.prisma"), join(workDir, "prisma", "schema.prisma"));

  await conCliente(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${DB_PRUEBA}"`);
    await c.query(`CREATE DATABASE "${DB_PRUEBA}"`);
  });

  desplegar(anteriores(), dbUrl);
  await conCliente(dbUrl, async (c) => {
    await insertarClub(c, "c-unico", "Club Único", "UNI");
    // Duplicados que solo aparecen al normalizar, uno de ellos inactivo.
    await insertarClub(c, "c-dup-a", "Club Duplicado A", "DUP");
    await insertarClub(c, "c-dup-b", "Club Duplicado B", " dup\t", "'disabled', NULL");
    // Un eliminado lógicamente NO cuenta como duplicado.
    await insertarClub(c, "c-borrado", "Club Borrado", "UNI", "'active', now()");
  });
}, 180_000);

afterAll(async () => {
  if (adminUrl) {
    await conCliente(adminUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${DB_PRUEBA}"`);
    });
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("con duplicados anteriores", () => {
  it("la migración se DETIENE, dice qué clubes son, y no modifica ningún dato", async () => {
    const antes = await conCliente(dbUrl, fotoDeClubes);

    const salida = salidaDelFallo([...anteriores(), MIGRACION]);

    expect(salida, "debe informar la sigla y los dos clubes").toMatch(/Hay clubes vigentes con la misma sigla/);
    expect(salida).toContain("DUP");
    expect(salida).toContain("Club Duplicado A");
    expect(salida).toContain("Club Duplicado B");
    expect(salida, "el eliminado no es un duplicado").not.toContain("Club Borrado");
    expect(salida).toMatch(/La migración no modifica ningún club/);

    await conCliente(dbUrl, async (c) => {
      expect(await fotoDeClubes(c), "ni renombra, ni fusiona, ni elimina").toEqual(antes);
      const indice = await c.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'clubs_code_unique_active'`);
      expect(indice.rowCount, "no queda un índice a medias").toBe(0);
    });
  }, 120_000);
});

describe("después de corregir los datos", () => {
  beforeAll(async () => {
    await conCliente(dbUrl, async (c) => {
      // Lo que haría quien decide: darle otra sigla a uno de los dos. Y registrar el reintento,
      // igual que `prisma migrate resolve --rolled-back`.
      await c.query(`UPDATE clubs SET code = 'DUB' WHERE id = 'c-dup-b'`);
      await c.query(`DELETE FROM _prisma_migrations WHERE migration_name = $1`, [MIGRACION]);
    });
    desplegar([...anteriores(), MIGRACION], dbUrl);
  }, 120_000);

  it("se aplica, y los clubes quedan como estaban", async () => {
    await conCliente(dbUrl, async (c) => {
      const { rows } = await c.query(`SELECT id, code FROM clubs ORDER BY id`);
      expect(rows).toEqual([
        { id: "c-borrado", code: "UNI" },
        { id: "c-dup-a", code: "DUP" },
        { id: "c-dup-b", code: "DUB" },
        { id: "c-unico", code: "UNI" },
      ]);
    });
  });

  it("el índice es único, parcial y sobre la sigla normalizada", async () => {
    await conCliente(dbUrl, async (c) => {
      const { rows } = await c.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'clubs_code_unique_active'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/UNIQUE INDEX/);
      expect(rows[0].indexdef).toMatch(/club_code_normalizado/);
      expect(rows[0].indexdef).toMatch(/deleted_at IS NULL/);
    });
  });

  it("desde ahora la base rechaza el duplicado, normalizado y con un club inactivo; admite el de un eliminado", async () => {
    await conCliente(dbUrl, async (c) => {
      await expect(insertarClub(c, "c-nuevo-1", "Nuevo", " uni ")).rejects.toThrow(/clubs_code_unique_active/);
      await expect(insertarClub(c, "c-nuevo-2", "Nuevo", "dub")).rejects.toThrow(/clubs_code_unique_active/);
      await insertarClub(c, "c-nuevo-3", "Nuevo Borrado", "uni", "'active', now()");
    });
  });
});
