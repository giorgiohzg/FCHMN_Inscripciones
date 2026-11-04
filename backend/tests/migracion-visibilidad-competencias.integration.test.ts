/**
 * La migración `20261102030000_competencia_visible_en_paneles`, probada CONTRA DATOS QUE YA EXISTEN.
 *
 * Aplicarla sobre una base vacía no demuestra lo que importa: que las competencias
 * que ya estaban sigan VISIBLES en los dos paneles. Para eso hace falta una base
 * con TODAS las migraciones anteriores, competencias reales de cada estado, y
 * recién entonces la migración.
 *
 * Procedimiento (el de `migracion-fecha-efectiva.integration.test.ts`):
 *   1. Una base aparte con todas las migraciones anteriores a esta.
 *   2. Se puebla con competencias de cada estado.
 *   3. Se aplica la migración.
 *   4. Se comprueba qué quedó guardado, fila por fila, y el comportamiento por omisión.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";

const BACKEND_DIR = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(BACKEND_DIR, "prisma", "migrations");

const MIGRACION = "20261102030000_competencia_visible_en_paneles";
const DB_PRUEBA = "natacion_migra_visibilidad_test";

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

/** Todas las migraciones anteriores a la que se prueba (por marca de tiempo, no por lista de exclusiones). */
const anteriores = () =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name < MIGRACION)
    .map((d) => d.name)
    .sort();

/** Una competencia por estado "vivo", con lo mínimo que exige la base. */
const ESTADOS = ["draft", "scheduled", "open", "in_progress", "finished", "cancelled"] as const;

async function poblar(c: Client) {
  for (const estado of ESTADOS) {
    await c.query(
      `INSERT INTO competitions (id, name, status, registration_start_at, registration_end_at, updated_at)
       VALUES ($1, $2, $3::"CompetitionStatus", '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', now())`,
      [`comp-${estado}`, `Competencia ${estado}`, estado]
    );
  }
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL (use .env.test)");
  adminUrl = urlConBase("postgres");
  dbUrl = urlConBase(DB_PRUEBA);

  workDir = mkdtempSync(join(tmpdir(), "migra-visibilidad-"));
  mkdirSync(join(workDir, "prisma"), { recursive: true });
  cpSync(join(BACKEND_DIR, "prisma", "schema.prisma"), join(workDir, "prisma", "schema.prisma"));

  await conCliente(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${DB_PRUEBA}"`);
    await c.query(`CREATE DATABASE "${DB_PRUEBA}"`);
  });

  desplegar(anteriores(), dbUrl);
  await conCliente(dbUrl, poblar);
}, 180_000);

afterAll(async () => {
  if (adminUrl) {
    await conCliente(adminUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${DB_PRUEBA}"`);
    });
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const columna = (c: Client) =>
  c.query(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'competitions' AND column_name = 'visible_in_registration_panels'`
  );

describe("antes de migrar", () => {
  it("la columna no existe y hay competencias de todos los estados", async () => {
    await conCliente(dbUrl, async (c) => {
      expect((await columna(c)).rowCount).toBe(0);
      expect((await c.query(`SELECT count(*)::int AS n FROM competitions`)).rows[0].n).toBe(ESTADOS.length);
    });
  });
});

describe("después de migrar", () => {
  beforeAll(() => {
    desplegar([...anteriores(), MIGRACION], dbUrl);
  }, 120_000);

  it("la columna es BOOLEAN NOT NULL con DEFAULT true", async () => {
    await conCliente(dbUrl, async (c) => {
      const { rows } = await columna(c);
      expect(rows).toHaveLength(1);
      expect(rows[0].data_type).toBe("boolean");
      expect(rows[0].is_nullable).toBe("NO");
      expect(rows[0].column_default).toBe("true");
    });
  });

  it("TODAS las competencias que ya existían quedan VISIBLES, sea cual sea su estado", async () => {
    await conCliente(dbUrl, async (c) => {
      const { rows } = await c.query(`SELECT id, name, status, visible_in_registration_panels AS visible FROM competitions ORDER BY id`);
      expect(rows).toHaveLength(ESTADOS.length);
      for (const fila of rows) expect(fila.visible, `${fila.name} debe seguir visible`).toBe(true);
      // Y nada más cambió: mismos nombres y estados.
      expect(rows.map((f) => `${f.id}:${f.status}`).sort()).toEqual(ESTADOS.map((e) => `comp-${e}:${e}`).sort());
    });
  });

  it("una competencia nueva SIN indicar el campo nace visible; con false queda oculta", async () => {
    await conCliente(dbUrl, async (c) => {
      await c.query(
        `INSERT INTO competitions (id, name, status, registration_start_at, registration_end_at, updated_at)
         VALUES ('comp-nueva', 'Nueva', 'draft', '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z', now())`
      );
      await c.query(
        `INSERT INTO competitions (id, name, status, registration_start_at, registration_end_at, updated_at, visible_in_registration_panels)
         VALUES ('comp-oculta', 'Oculta', 'draft', '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z', now(), false)`
      );
      const { rows } = await c.query(`SELECT id, visible_in_registration_panels AS visible FROM competitions WHERE id IN ('comp-nueva','comp-oculta') ORDER BY id`);
      expect(rows).toEqual([
        { id: "comp-nueva", visible: true },
        { id: "comp-oculta", visible: false },
      ]);
    });
  });

  it("NULL no se admite", async () => {
    await conCliente(dbUrl, async (c) => {
      await expect(
        c.query(
          `INSERT INTO competitions (id, name, status, registration_start_at, registration_end_at, updated_at, visible_in_registration_panels)
           VALUES ('comp-nula', 'Nula', 'draft', '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z', now(), NULL)`
        )
      ).rejects.toThrow(/null value|not-null|visible_in_registration_panels/i);
    });
  });

  it("la migración queda registrada como aplicada, completa y sin error", async () => {
    await conCliente(dbUrl, async (c) => {
      const { rows } = await c.query(
        `SELECT finished_at IS NOT NULL AS terminada, rolled_back_at IS NULL AS sin_reversion
           FROM _prisma_migrations WHERE migration_name = $1`,
        [MIGRACION]
      );
      expect(rows).toEqual([{ terminada: true, sin_reversion: true }]);
    });
  });
});
