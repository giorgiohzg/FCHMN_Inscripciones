/**
 * Migración `20261102000000_club_email_opcional`, probada CONTRA DATOS QUE YA EXISTEN.
 *
 * Lo que la migración promete, y lo que se comprueba aquí:
 *
 *   1. Conserva TODOS los correos existentes, incluidos los que parecen
 *      provisionales: no limpia nada.
 *   2. Después de migrar, `clubs.email` admite NULL.
 *   3. Una cadena vacía o de solo espacios NO entra, ni por SQL directo.
 *   4. Si ANTES de migrar hay un club con el correo vacío, la migración se
 *      DETIENE con el detalle y no modifica nada; la comprobación del preflight
 *      lo detecta con la misma consulta.
 *
 * El procedimiento es el de `migracion-fecha-efectiva.integration.test.ts`: una
 * base aparte, con todas las migraciones anteriores, poblada con datos
 * sintéticos. Solo corre contra la base desechable (`.env.test`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { CHECKS } from "../scripts/migrationChecks";

const BACKEND_DIR = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(BACKEND_DIR, "prisma", "migrations");

const MIGRACION = "20261102000000_club_email_opcional";
const DB_PRUEBA = "natacion_migra_email_test";

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

const anteriores = () =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name < MIGRACION)
    .map((d) => d.name)
    .sort();

/** Correos sintéticos; el último parece provisional y DEBE conservarse. */
const CORREOS: Record<string, string> = {
  "club-a": "a@example.invalid",
  "club-b": "b@example.invalid",
  "club-prov": "pendiente@provisional.invalid",
};

const CLUB_VACIO = "club-vacio";

async function poblar(c: Client) {
  for (const [id, email] of Object.entries(CORREOS)) {
    await c.query(
      `INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', false, now())`,
      [id, `Club ${id}`, `user_${id}`, id.slice(-4).toUpperCase(), email]
    );
  }
  // El caso que debe detener la migración: antes no había ninguna restricción.
  await c.query(
    `INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at)
     VALUES ($1, 'Club Vacio', 'user_vacio', 'VAC', '   ', 'active', false, now())`,
    [CLUB_VACIO]
  );
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL (use .env.test)");
  adminUrl = urlConBase("postgres");
  dbUrl = urlConBase(DB_PRUEBA);

  workDir = mkdtempSync(join(tmpdir(), "migra-email-"));
  mkdirSync(join(workDir, "prisma"), { recursive: true });
  cpSync(join(BACKEND_DIR, "prisma", "schema.prisma"), join(workDir, "prisma", "schema.prisma"));

  await conCliente(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${DB_PRUEBA}"`);
    await c.query(`CREATE DATABASE "${DB_PRUEBA}"`);
  });

  desplegar(anteriores(), dbUrl);
  await conCliente(dbUrl, poblar);
}, 240_000);

afterAll(async () => {
  if (adminUrl) {
    await conCliente(adminUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${DB_PRUEBA}"`);
    });
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const columnaAdmiteNull = () =>
  conCliente(dbUrl, (c) =>
    c.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name='clubs' AND column_name='email'`)
  ).then((r) => r.rows[0].is_nullable === "YES");

describe("antes de migrar", () => {
  it("el correo es obligatorio en la base y la comprobación del preflight detecta el club vacío", async () => {
    expect(await columnaAdmiteNull()).toBe(false);

    const check = CHECKS.find((c) => c.id === "club-email-vacio");
    expect(check, "debe existir la comprobación club-email-vacio").toBeDefined();
    expect(check!.constraint).toBe("clubs_email_no_vacio");
    expect(check!.remediation).toMatch(/correo real/i);

    const { rows } = await conCliente(dbUrl, (c) => c.query(check!.query));
    expect(rows.map((r) => r.id)).toEqual([CLUB_VACIO]);
  });
});

describe("la migración se detiene si hay correos vacíos", () => {
  it("falla, nombra al club y no modifica nada", async () => {
    let mensaje = "";
    try {
      desplegar([...anteriores(), MIGRACION], dbUrl);
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
      mensaje = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}${err.message ?? ""}`;
    }
    expect(mensaje, "la migración debía fallar").toMatch(/correo vac/i);
    expect(mensaje).toContain(CLUB_VACIO);

    // Nada cambió: sigue obligatorio y la restricción nueva no existe.
    expect(await columnaAdmiteNull()).toBe(false);
    const restriccion = await conCliente(dbUrl, (c) => c.query(`SELECT 1 FROM pg_constraint WHERE conname='clubs_email_no_vacio'`));
    expect(restriccion.rowCount).toBe(0);
    // Y el club vacío no fue "arreglado" por la migración.
    const vacio = await conCliente(dbUrl, (c) => c.query(`SELECT email FROM clubs WHERE id=$1`, [CLUB_VACIO]));
    expect(vacio.rows[0].email).toBe("   ");
  }, 240_000);
});

describe("tras corregir el dato, como indica el preflight", () => {
  beforeAll(async () => {
    await conCliente(dbUrl, async (c) => {
      // La migración fallida queda registrada: igual que `migrate resolve --rolled-back`.
      await c.query(`DELETE FROM _prisma_migrations WHERE finished_at IS NULL`);
      await c.query(`UPDATE clubs SET email = 'vacio@example.invalid' WHERE id = $1`, [CLUB_VACIO]);
    });
    desplegar([...anteriores(), MIGRACION], dbUrl);
  }, 240_000);

  it("conserva TODOS los correos existentes, incluido el que parece provisional", async () => {
    const { rows } = await conCliente(dbUrl, (c) => c.query(`SELECT id, email FROM clubs ORDER BY id`));
    const porId = Object.fromEntries(rows.map((r) => [r.id, r.email]));
    for (const [id, email] of Object.entries(CORREOS)) expect(porId[id], id).toBe(email);
    expect(porId[CLUB_VACIO]).toBe("vacio@example.invalid");
  });

  it("la columna admite NULL", async () => {
    expect(await columnaAdmiteNull()).toBe(true);
    await conCliente(dbUrl, (c) =>
      c.query(
        `INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at)
         VALUES ('club-sin-correo', 'Sin Correo', 'user_sin_correo', 'SCO', NULL, 'active', false, now())`
      )
    );
    const { rows } = await conCliente(dbUrl, (c) => c.query(`SELECT email FROM clubs WHERE id='club-sin-correo'`));
    expect(rows[0].email).toBeNull();
  });

  it.each([[""], ["   "], ["\t"]])("la restricción rechaza el correo %j (alta y edición)", async (vacio) => {
    await expect(
      conCliente(dbUrl, (c) =>
        c.query(
          `INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at)
           VALUES ('club-x', 'X', 'user_x', 'XXX', $1, 'active', false, now())`,
          [vacio]
        )
      )
    ).rejects.toThrow(/clubs_email_no_vacio/);

    await expect(conCliente(dbUrl, (c) => c.query(`UPDATE clubs SET email = $1 WHERE id = 'club-a'`, [vacio]))).rejects.toThrow(
      /clubs_email_no_vacio/
    );
  });

  it("un club con correo puede pasar a NULL y el preflight ya no detecta nada", async () => {
    await conCliente(dbUrl, (c) => c.query(`UPDATE clubs SET email = NULL WHERE id = 'club-b'`));
    const check = CHECKS.find((c) => c.id === "club-email-vacio")!;
    const { rows } = await conCliente(dbUrl, (c) => c.query(check.query));
    expect(rows).toEqual([]);
  });
});
