/**
 * Migración `20261102010000_username_opcional`, probada CONTRA DATOS QUE YA EXISTEN.
 *
 * Lo que la migración promete, y lo que se comprueba aquí:
 *
 *   1. Conserva TODOS los nombres existentes, incluidos los anteriores a la
 *      regla de formato (uno de 3 letras) y los de titulares con cuenta.
 *   2. Las reservas existentes no cambian.
 *   3. Después de migrar, personas y clubes admiten NULL, varios a la vez, sin
 *      reserva; quitar un nombre lo libera; la cadena vacía no entra.
 *   4. Las garantías de identidad siguen: con cuenta vigente no se puede
 *      quitar el nombre, y no puede nacer una cuenta para un titular sin nombre.
 *   5. Si antes de migrar hay un nombre vacío, la migración se DETIENE con el
 *      detalle y no modifica nada; el preflight lo detecta con la misma consulta.
 *
 * Mismo procedimiento que `migracion-club-email.integration.test.ts`: una base
 * aparte con todas las migraciones anteriores, datos sintéticos, y solo contra
 * la base desechable (`.env.test`).
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

const MIGRACION = "20261102010000_username_opcional";
const DB_PRUEBA = "natacion_migra_username_test";

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

const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  conCliente(dbUrl, (c) => c.query(sql, params)).then((r) => r.rows as T[]);

/** Nombres sintéticos. `ana` es anterior a la regla de 4 caracteres y DEBE conservarse. */
const PERSONAS: Record<string, string> = { "p-ana": "ana", "p-bruno": "bruno.soto", "p-con-cuenta": "con.cuenta" };
const CLUBES: Record<string, string> = { "c-norte": "club_norte" };
const PERSONA_VACIA = "p-vacia";

async function poblar(c: Client) {
  let i = 0;
  for (const [id, username] of Object.entries(PERSONAS)) {
    await c.query(
      `INSERT INTO persons (id, run, username, full_name, birth_date, gender, status, updated_at)
       VALUES ($1, $2, $3, $4, '1985-04-04', 'female', 'active', now())`,
      [id, `2000000${i++}`, username, `Persona ${id}`]
    );
  }
  for (const [id, username] of Object.entries(CLUBES)) {
    await c.query(
      `INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at)
       VALUES ($1, $2, $3, 'CN', 'norte@example.invalid', 'active', false, now())`,
      [id, `Club ${id}`, username]
    );
  }
  // Una cuenta vigente, con el nombre de su titular.
  await c.query(
    `INSERT INTO users (id, username, password_hash, must_change_password, status, owner_type, person_id, updated_at)
     VALUES ('u-con-cuenta', 'con.cuenta', 'x', false, 'active', 'person', 'p-con-cuenta', now())`
  );
  // El caso que debe detener la migración: con NOT NULL, "sin nombre" solo podía ser una cadena vacía.
  await c.query(
    `INSERT INTO persons (id, run, username, full_name, birth_date, gender, status, updated_at)
     VALUES ($1, '20000099', '   ', 'Persona Vacia', '1985-04-04', 'female', 'active', now())`,
    [PERSONA_VACIA]
  );
}

let reservasAntes: { username: string; owner_kind: string; owner_id: string }[] = [];

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL (use .env.test)");
  adminUrl = urlConBase("postgres");
  dbUrl = urlConBase(DB_PRUEBA);

  workDir = mkdtempSync(join(tmpdir(), "migra-username-"));
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

const admiteNull = async (tabla: "persons" | "clubs") =>
  (await q<{ is_nullable: string }>(`SELECT is_nullable FROM information_schema.columns WHERE table_name=$1 AND column_name='username'`, [tabla]))[0]!
    .is_nullable === "YES";

describe("antes de migrar", () => {
  it("el nombre es obligatorio y el preflight detecta el nombre vacío", async () => {
    expect(await admiteNull("persons")).toBe(false);
    expect(await admiteNull("clubs")).toBe(false);

    const check = CHECKS.find((c) => c.id === "username-vacio");
    expect(check, "debe existir la comprobación username-vacio").toBeDefined();
    expect(check!.constraint).toContain("persons_username_no_vacio");
    const filas = await q<{ id: string }>(check!.query);
    expect(filas.map((f) => f.id)).toEqual([PERSONA_VACIA]);
  });
});

describe("la migración se detiene si hay nombres vacíos", () => {
  it("falla, nombra al titular y no modifica nada", async () => {
    let mensaje = "";
    try {
      desplegar([...anteriores(), MIGRACION], dbUrl);
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
      mensaje = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}${err.message ?? ""}`;
    }
    expect(mensaje, "la migración debía fallar").toMatch(/nombres de usuario vac/i);
    expect(mensaje).toContain(PERSONA_VACIA);

    expect(await admiteNull("persons")).toBe(false);
    expect(await q(`SELECT 1 FROM pg_constraint WHERE conname IN ('persons_username_no_vacio','clubs_username_no_vacio')`)).toHaveLength(0);
    expect((await q<{ username: string }>(`SELECT username FROM persons WHERE id=$1`, [PERSONA_VACIA]))[0]!.username).toBe("   ");
  }, 240_000);
});

describe("tras corregir el dato, como indica el preflight", () => {
  beforeAll(async () => {
    await conCliente(dbUrl, async (c) => {
      await c.query(`DELETE FROM _prisma_migrations WHERE finished_at IS NULL`);
      await c.query(`UPDATE persons SET username = 'persona.vacia' WHERE id = $1`, [PERSONA_VACIA]);
    });
    reservasAntes = await q(`SELECT username, owner_kind, owner_id FROM username_reservations ORDER BY username`);
    desplegar([...anteriores(), MIGRACION], dbUrl);
  }, 240_000);

  it("conserva todos los nombres —también el anterior a la regla de formato— y las reservas", async () => {
    for (const [id, username] of Object.entries(PERSONAS)) {
      expect((await q<{ username: string }>(`SELECT username FROM persons WHERE id=$1`, [id]))[0]!.username, id).toBe(username);
    }
    for (const [id, username] of Object.entries(CLUBES)) {
      expect((await q<{ username: string }>(`SELECT username FROM clubs WHERE id=$1`, [id]))[0]!.username, id).toBe(username);
    }
    expect(await q(`SELECT username, owner_kind, owner_id FROM username_reservations ORDER BY username`)).toEqual(reservasAntes);
  });

  it("personas y clubes admiten varios NULL, sin reserva", async () => {
    expect(await admiteNull("persons")).toBe(true);
    expect(await admiteNull("clubs")).toBe(true);
    // users.username sigue siendo obligatorio.
    const usuarios = await q<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name='users' AND column_name='username'`
    );
    expect(usuarios[0]!.is_nullable).toBe("NO");

    const antes = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM username_reservations`))[0]!.n;
    for (let i = 0; i < 3; i++) {
      await q(
        `INSERT INTO persons (id, run, username, full_name, birth_date, gender, status, updated_at)
         VALUES ($1, $2, NULL, 'Sin Nombre', '1985-04-04', 'female', 'active', now())`,
        [`p-null-${i}`, `3000000${i}`]
      );
      await q(
        `INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at)
         VALUES ($1, 'Sin Nombre', NULL, 'SN', NULL, 'active', false, now())`,
        [`c-null-${i}`]
      );
    }
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM username_reservations`))[0]!.n, "NULL no reserva").toBe(antes);
  });

  it("quitar el nombre de un titular SIN cuenta lo libera, y otro puede tomarlo", async () => {
    await q(`UPDATE persons SET username = NULL WHERE id = 'p-bruno'`);
    expect(await q(`SELECT 1 FROM username_reservations WHERE username = 'bruno.soto'`)).toHaveLength(0);
    await q(`UPDATE clubs SET username = 'bruno.soto' WHERE id = 'c-null-0'`);
    expect((await q<{ owner_id: string }>(`SELECT owner_id FROM username_reservations WHERE username = 'bruno.soto'`))[0]!.owner_id).toBe("c-null-0");
  });

  it.each([[""], ["   "], ["\t"]])("rechaza el nombre vacío %j en personas y en clubes", async (vacio) => {
    await expect(q(`UPDATE persons SET username = $1 WHERE id = 'p-ana'`, [vacio])).rejects.toThrow(/persons_username_no_vacio/);
    await expect(q(`UPDATE clubs SET username = $1 WHERE id = 'c-norte'`, [vacio])).rejects.toThrow(/clubs_username_no_vacio/);
  });

  it("con cuenta vigente, el nombre no se puede quitar (pasar a NULL también es cambiarlo)", async () => {
    await expect(q(`UPDATE persons SET username = NULL WHERE id = 'p-con-cuenta'`)).rejects.toThrow(/cuenta de acceso vigente/);
  });

  it("no puede nacer una cuenta para un titular sin nombre", async () => {
    await expect(
      q(
        `INSERT INTO users (id, username, password_hash, must_change_password, status, owner_type, person_id, updated_at)
         VALUES ('u-sin-titular', 'inventado', 'x', false, 'active', 'person', 'p-null-1', now())`
      )
    ).rejects.toThrow(/debe ser el de su titular/);
  });

  it("el registro de nombres sigue coherente según el preflight", async () => {
    const check = CHECKS.find((c) => c.id === "reservas-de-username-incoherentes")!;
    expect(await q(check.query)).toEqual([]);
    const colision = CHECKS.find((c) => c.id === "username-colision-global")!;
    expect(await q(colision.query)).toEqual([]);
    const duplicados = CHECKS.find((c) => c.id === "username-persona-duplicado")!;
    expect(await q(duplicados.query), "los titulares sin nombre no son «duplicados»").toEqual([]);
  });
});
