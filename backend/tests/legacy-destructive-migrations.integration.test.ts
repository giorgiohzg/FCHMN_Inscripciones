/**
 * Hallazgo 21 — auditoría de las migraciones destructivas, comprobada.
 *
 * Cuatro migraciones tempranas no son aplicables sobre una base con datos, o
 * destruyen información al aplicarse. Esta prueba no las corrige (ya están
 * aplicadas y no se reescriben): las EJERCITA sobre una base poblada con el
 * esquema anterior, de modo que el diagnóstico sea un hecho verificado y no una
 * lectura del SQL. Esta prueba es la única constancia del diagnóstico dentro
 * del repositorio.
 *
 * Lo que se comprueba, en orden:
 *
 *   1. `add_username_club_code_age_cutoff` FALLA sobre datos: agrega cuatro
 *      columnas NOT NULL sin valor por defecto.
 *   2. Aun vaciando lo justo para que pase, DESTRUYE `users.email` sin dejar
 *      dónde recuperarlo.
 *   3. `person_email_optional_club_membership` borra el delegado y el
 *      entrenador de cada club y crea `club_staff` VACÍA: los nombramientos
 *      no se migran.
 *   4. `seed_time_centiseconds` (individual y relevo) borra los tiempos de
 *      inscripción sin convertirlos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";

const BACKEND_DIR = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(BACKEND_DIR, "prisma", "migrations");

const INIT = "20260827015835_init";
const USERNAMES = "20260827161331_add_username_club_code_age_cutoff";
const CLUB_STAFF = "20260901212226_person_email_optional_club_membership";
/** Última migración ANTES de la conversión a centésimas (ya tiene `seed_time_seconds`). */
const SEED_TIME_PREVIA = "20260828210518_relay_seed_time";
const SEED_TIME_REL = "20260829162046_relay_seed_time_centiseconds";

const LEGACY_DB = "natacion_ancestro_test";

let adminUrl: string;
let legacyUrl: string;
let workDir: string;

function baseUrlWithDatabase(database: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Aplica exactamente las migraciones indicadas, en el orden de sus nombres. */
function deployMigrations(names: string[]): void {
  const target = join(workDir, "prisma", "migrations");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const name of names) {
    cpSync(join(MIGRATIONS_DIR, name), join(target, name), { recursive: true });
  }
  cpSync(join(MIGRATIONS_DIR, "migration_lock.toml"), join(target, "migration_lock.toml"));

  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", join(workDir, "prisma", "schema.prisma")], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: legacyUrl },
    stdio: "pipe",
    shell: process.platform === "win32",
  });
}

/** Migraciones entre `init` y la indicada, ambas incluidas, en orden. */
function migracionesHasta(ultima: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .filter((n) => n <= ultima);
}

async function reiniciarBaseAncestro() {
  await withClient(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${LEGACY_DB}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${LEGACY_DB}"`);
  });
}

/** Datos en la forma ANTERIOR: users con email, clubes con delegado, tiempos en segundos. */
async function poblarEsquemaAncestro(client: Client) {
  await client.query(`
    INSERT INTO persons (id, run, email, full_name, birth_date, gender, status, updated_at) VALUES
      ('66666666-6666-6666-6666-666666666661', '11111111', 'ana@club.cl',   'Ana Pérez',  '1985-04-04', 'female', 'active', now()),
      ('66666666-6666-6666-6666-666666666662', '22222222', 'bruno@club.cl', 'Bruno Soto', '1990-06-06', 'male',   'active', now());

    INSERT INTO clubs (id, name, email, status, has_legal_status, delegate_person_id, coach_person_id, updated_at) VALUES
      ('55555555-5555-5555-5555-555555555551', 'Club Norte', 'norte@test.cl', 'active', false,
       '66666666-6666-6666-6666-666666666661', '66666666-6666-6666-6666-666666666662', now());

    INSERT INTO users (id, email, password_hash, must_change_password, status, owner_type, person_id, updated_at) VALUES
      ('c0ffee00-0000-0000-0000-000000000001', 'ana@club.cl', 'x', false, 'active', 'person',
       '66666666-6666-6666-6666-666666666661', now());
  `);

  await client.query(`
    INSERT INTO test_types (id, name, swimmers_count) VALUES ('11111111-1111-1111-1111-111111111111', 'Individual', 1);
    INSERT INTO distances (id, meters) VALUES ('22222222-2222-2222-2222-222222222221', 50);
    INSERT INTO strokes (id, name) VALUES ('33333333-3333-3333-3333-333333333331', 'Libre');
    INSERT INTO session_types (id, name) VALUES ('44444444-4444-4444-4444-444444444441', 'Mañana');

    -- En el esquema inicial, la fecha de corte vivía en la categoría (después
    -- se movió a la competencia).
    INSERT INTO categories (id, test_type_id, name, min_age, max_age, cutoff_date, updated_at) VALUES
      ('77777777-7777-7777-7777-777777777771', '11111111-1111-1111-1111-111111111111', 'Master A', 25, 45, now(), now());

    INSERT INTO events (id, test_type_id, distance_id, stroke_id, gender, updated_at) VALUES
      ('88888888-8888-8888-8888-888888888881', '11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333331', 'mixed', now());

    INSERT INTO competitions (id, name, status, registration_start_at, registration_end_at, updated_at) VALUES
      ('99999999-9999-9999-9999-999999999991', 'Nacional Máster', 'open', now() - interval '1 day', now() + interval '10 days', now());

    INSERT INTO competition_dates (id, competition_id, date) VALUES
      ('aaaaaaa1-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991', now());

    INSERT INTO competition_sessions (id, competition_date_id, session_type_id) VALUES
      ('bbbbbbb1-0000-0000-0000-000000000001', 'aaaaaaa1-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444441');

    INSERT INTO competition_events (id, competition_id, event_id, competition_session_id, status, updated_at) VALUES
      ('ccccccc1-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991',
       '88888888-8888-8888-8888-888888888881', 'bbbbbbb1-0000-0000-0000-000000000001', 'enabled', now());

    INSERT INTO registrations (id, competition_event_id, person_id, club_id, category_id, status, registered_by_user_id, updated_at) VALUES
      ('ddddddd1-0000-0000-0000-000000000001', 'ccccccc1-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666661',
       '55555555-5555-5555-5555-555555555551', '77777777-7777-7777-7777-777777777771', 'confirmed',
       'c0ffee00-0000-0000-0000-000000000001', now());
  `);
}

beforeAll(async () => {
  adminUrl = process.env.DATABASE_URL!;
  legacyUrl = baseUrlWithDatabase(LEGACY_DB);
  workDir = mkdtempSync(join(tmpdir(), "natacion-ancestro-"));
  mkdirSync(join(workDir, "prisma"), { recursive: true });
  cpSync(join(BACKEND_DIR, "prisma", "schema.prisma"), join(workDir, "prisma", "schema.prisma"));
}, 120_000);

afterAll(async () => {
  await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${LEGACY_DB}" WITH (FORCE)`)).catch(() => void 0);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
}, 60_000);

describe("hallazgo 21 — migraciones no aplicables sobre datos", () => {
  it("add_username_club_code_age_cutoff FALLA sobre una base poblada", async () => {
    await reiniciarBaseAncestro();
    deployMigrations([INIT]);
    await withClient(legacyUrl, poblarEsquemaAncestro);

    /**
     * Agrega `username` NOT NULL a tres tablas y `code` NOT NULL a `clubs`,
     * ninguna con valor por defecto ni respaldo de datos. PostgreSQL no puede
     * completar la operación si la tabla tiene filas: no sabe qué poner.
     */
    expect(() => deployMigrations(migracionesHasta(USERNAMES))).toThrow();

    await withClient(legacyUrl, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='persons' AND column_name='username'`
      );
      expect(rows[0].n, "la columna no llegó a crearse: la migración se revirtió entera").toBe(0);
    });
  }, 300_000);

  it("sobre una base VACÍA sí pasa, y al hacerlo destruye users.email sin respaldo", async () => {
    await reiniciarBaseAncestro();
    deployMigrations(migracionesHasta(USERNAMES));

    await withClient(legacyUrl, async (c) => {
      const { rows } = await c.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name IN ('email','username') ORDER BY column_name`
      );
      expect(rows.map((r) => r.column_name), "email desaparece y username ocupa su lugar").toEqual(["username"]);
    });
  }, 300_000);

  it("person_email_optional_club_membership borra los nombramientos y deja club_staff VACÍA", async () => {
    await reiniciarBaseAncestro();
    deployMigrations([INIT]);
    await withClient(legacyUrl, poblarEsquemaAncestro);

    // Se llega hasta la migración anterior sin pasar por la que falla: se
    // vacían solo las tablas que impiden agregar las columnas NOT NULL.
    await withClient(legacyUrl, async (c) => {
      await c.query(`DELETE FROM registrations`);
      await c.query(`DELETE FROM users`);
      await c.query(`UPDATE clubs SET delegate_person_id = NULL, coach_person_id = NULL`);
      await c.query(`DELETE FROM persons`);
      await c.query(`DELETE FROM clubs`);
    });
    deployMigrations(migracionesHasta(USERNAMES));

    // Ahora, con el esquema intermedio, se recrean club y nombramientos.
    await withClient(legacyUrl, async (c) => {
      await c.query(`
        INSERT INTO persons (id, run, username, email, full_name, birth_date, gender, status, updated_at) VALUES
          ('66666666-6666-6666-6666-666666666661', '11111111', 'ana',   'ana@club.cl',   'Ana Pérez',  '1985-04-04', 'female', 'active', now()),
          ('66666666-6666-6666-6666-666666666662', '22222222', 'bruno', 'bruno@club.cl', 'Bruno Soto', '1990-06-06', 'male',   'active', now());
        INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, delegate_person_id, coach_person_id, updated_at) VALUES
          ('55555555-5555-5555-5555-555555555551', 'Club Norte', 'club_norte', 'CN', 'norte@test.cl', 'active', false,
           '66666666-6666-6666-6666-666666666661', '66666666-6666-6666-6666-666666666662', now());
      `);
    });

    deployMigrations(migracionesHasta(CLUB_STAFF));

    await withClient(legacyUrl, async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM club_staff`);
      expect(rows[0].n, "los nombramientos NO se migran: club_staff nace vacía").toBe(0);

      const { rows: columnas } = await c.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name='clubs' AND column_name IN ('delegate_person_id','coach_person_id')`
      );
      expect(columnas[0].n, "y las columnas que los contenían ya no existen").toBe(0);
    });
  }, 300_000);

  it("seed_time_centiseconds borra el tiempo de inscripción en vez de convertirlo", async () => {
    /**
     * `seed_time_seconds` aparece DESPUÉS de la migración de usernames, así
     * que para llegar hasta aquí con datos hay que partir de una base vacía,
     * migrar hasta el esquema intermedio y recién entonces poblar. Es, por sí
     * mismo, otra consecuencia del hallazgo: la cadena no admite datos
     * anteriores a ese punto.
     */
    await reiniciarBaseAncestro();
    deployMigrations(migracionesHasta(SEED_TIME_PREVIA));

    await withClient(legacyUrl, async (c) => {
      await c.query(`
        INSERT INTO persons (id, run, username, email, full_name, birth_date, gender, status, updated_at) VALUES
          ('66666666-6666-6666-6666-666666666661', '11111111', 'ana', 'ana@club.cl', 'Ana Pérez', '1985-04-04', 'female', 'active', now());
        INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at) VALUES
          ('55555555-5555-5555-5555-555555555551', 'Club Norte', 'club_norte', 'CN', 'norte@test.cl', 'active', false, now());
        INSERT INTO users (id, username, password_hash, must_change_password, status, owner_type, person_id, updated_at) VALUES
          ('c0ffee00-0000-0000-0000-000000000001', 'ana', 'x', false, 'active', 'person', '66666666-6666-6666-6666-666666666661', now());

        INSERT INTO test_types (id, name, swimmers_count) VALUES ('11111111-1111-1111-1111-111111111111', 'Individual', 1);
        INSERT INTO distances (id, meters) VALUES ('22222222-2222-2222-2222-222222222221', 50);
        INSERT INTO strokes (id, name) VALUES ('33333333-3333-3333-3333-333333333331', 'Libre');
        INSERT INTO session_types (id, name) VALUES ('44444444-4444-4444-4444-444444444441', 'Mañana');
        INSERT INTO categories (id, test_type_id, name, min_age, max_age, updated_at) VALUES
          ('77777777-7777-7777-7777-777777777771', '11111111-1111-1111-1111-111111111111', 'Master A', 25, 45, now());
        INSERT INTO events (id, test_type_id, distance_id, stroke_id, gender, updated_at) VALUES
          ('88888888-8888-8888-8888-888888888881', '11111111-1111-1111-1111-111111111111',
           '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333331', 'mixed', now());
        INSERT INTO competitions (id, name, status, registration_start_at, registration_end_at, updated_at) VALUES
          ('99999999-9999-9999-9999-999999999991', 'Nacional', 'open', now() - interval '1 day', now() + interval '10 days', now());
        INSERT INTO competition_dates (id, competition_id, date) VALUES
          ('aaaaaaa1-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991', now());
        INSERT INTO competition_sessions (id, competition_date_id, session_type_id) VALUES
          ('bbbbbbb1-0000-0000-0000-000000000001', 'aaaaaaa1-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444441');
        INSERT INTO competition_events (id, competition_id, event_id, competition_session_id, status, updated_at) VALUES
          ('ccccccc1-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991',
           '88888888-8888-8888-8888-888888888881', 'bbbbbbb1-0000-0000-0000-000000000001', 'enabled', now());

        -- Tiempo de inscripción en SEGUNDOS: 32 s (la columna es entera).
        INSERT INTO registrations (id, competition_event_id, person_id, club_id, category_id, status, seed_time_seconds, registered_by_user_id, updated_at) VALUES
          ('ddddddd1-0000-0000-0000-000000000001', 'ccccccc1-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666661',
           '55555555-5555-5555-5555-555555555551', '77777777-7777-7777-7777-777777777771', 'confirmed', 32,
           'c0ffee00-0000-0000-0000-000000000001', now());
      `);
    });

    const { rows: antes } = await withClient(legacyUrl, (c) =>
      c.query(`SELECT seed_time_seconds FROM registrations WHERE id = 'ddddddd1-0000-0000-0000-000000000001'`)
    );
    expect(antes[0].seed_time_seconds).toBe(32);

    deployMigrations(migracionesHasta(SEED_TIME_REL));

    await withClient(legacyUrl, async (c) => {
      const { rows } = await c.query(
        `SELECT seed_time_centiseconds FROM registrations WHERE id = 'ddddddd1-0000-0000-0000-000000000001'`
      );
      expect(rows[0].seed_time_centiseconds, "32 s deberían haber quedado en 3200 centésimas").toBeNull();

      const { rows: columnas } = await c.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name='registrations' AND column_name='seed_time_seconds'`
      );
      expect(columnas[0].n, "y la columna original ya no existe: el dato no es recuperable").toBe(0);
    });
  }, 300_000);
});
