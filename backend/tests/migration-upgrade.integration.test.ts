/**
 * Actualización desde una base REPRESENTATIVA DE LA VERSIÓN ANTERIOR, poblada
 * y con los datos exactos que impiden crear los índices nuevos.
 *
 * Probar la migración solo contra una instalación vacía no demuestra nada:
 * los índices únicos parciales y la clave foránea compuesta de la Fase 2 son
 * justamente lo que puede fallar cuando ya hay datos. Esta prueba:
 *
 *   1. Crea una base aparte y le aplica SOLO las 14 migraciones anteriores.
 *   2. La puebla con datos realistas, incluyendo duplicados que violan cada
 *      índice nuevo y una prueba asociada a la jornada de otra competencia.
 *   3. Verifica que el preflight los detecta TODOS (si no, el despliegue
 *      real fallaría a ciegas).
 *   4. Verifica que aplicar la migración en ese estado FALLA (es la prueba de
 *      que el preflight no es decorativo).
 *   5. Corrige los datos como indica el preflight y comprueba que ahora la
 *      migración se aplica y las garantías quedan activas.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { createHash } from "node:crypto";
import { CHECKS } from "../scripts/migrationChecks";

const BACKEND_DIR = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(BACKEND_DIR, "prisma", "migrations");

/** Migraciones introducidas por la Fase 2 (todo lo anterior es "la versión previa"). */
const PHASE2_MIGRATIONS = [
  "20260905000000_phase2_integrity",
  "20260905010000_phase2_integrity_fixes",
  "20260905020000_phase2_block_date_reassignment",
];

/** Migraciones de la Fase 4 (hallazgo 20: identidad de cuentas y usernames). */
const PHASE4_MIGRATIONS = [
  "20260906000000_phase4_owner_type_system",
  "20260906010000_phase4_user_identity",
  "20260906020000_phase4_identity_guards",
];

/** Limpieza de esquema muerto (hallazgo 32). */
const CLEANUP_MIGRATIONS = ["20260913000000_drop_dead_schema"];

/** Todo lo que la actualización agrega sobre la versión previa. */
const MIGRACIONES_NUEVAS = [...PHASE2_MIGRATIONS, ...PHASE4_MIGRATIONS, ...CLEANUP_MIGRATIONS];

/**
 * Frontera temporal de «la versión previa»: la primera migración de la Fase 2.
 *
 * Se compara por marca de tiempo y no por una lista de exclusiones, que es como
 * estaba: con una lista, **cualquier migración nueva se contaba como antigua** y
 * se aplicaba antes que las demás, con lo que la prueba fallaba por un motivo
 * que no tenía nada que ver con lo que quiere comprobar. Pasó exactamente eso al
 * añadir la limpieza de esquema muerto.
 */
const FRONTERA_VERSION_PREVIA = PHASE2_MIGRATIONS[0]!;

const LEGACY_DB = "natacion_legacy_test";

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

/** Aplica con `prisma migrate deploy` solo el subconjunto de migraciones indicado. */
function deployMigrations(names: string[], databaseUrl: string) {
  const migrationsTarget = join(workDir, "prisma", "migrations");
  rmSync(migrationsTarget, { recursive: true, force: true });
  mkdirSync(migrationsTarget, { recursive: true });
  for (const name of names) {
    cpSync(join(MIGRATIONS_DIR, name), join(migrationsTarget, name), { recursive: true });
  }
  cpSync(join(MIGRATIONS_DIR, "migration_lock.toml"), join(migrationsTarget, "migration_lock.toml"));

  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", join(workDir, "prisma", "schema.prisma")], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
    shell: process.platform === "win32",
  });
}

function legacyMigrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name < FRONTERA_VERSION_PREVIA)
    .map((d) => d.name)
    .sort();
}

function runPreflight(databaseUrl: string): { code: number; output: string } {
  try {
    const output = execFileSync("npx", ["tsx", "scripts/preflight-migration.ts"], {
      cwd: BACKEND_DIR,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * Datos de una federación pequeña real: 2 clubes, 3 nadadores, 1 competencia
 * con 2 fechas — MÁS los conflictos que la migración no tolera.
 */
async function poblarBaseAnterior(client: Client) {
  await client.query(`
    INSERT INTO test_types (id, name, swimmers_count) VALUES
      ('11111111-1111-1111-1111-111111111111', 'Individual', 1),
      ('11111111-1111-1111-1111-111111111112', 'Relevo', 4);

    INSERT INTO distances (id, meters) VALUES ('22222222-2222-2222-2222-222222222221', 50);
    INSERT INTO strokes (id, name) VALUES ('33333333-3333-3333-3333-333333333331', 'Libre');
    INSERT INTO session_types (id, name) VALUES
      ('44444444-4444-4444-4444-444444444441', 'Mañana'),
      ('44444444-4444-4444-4444-444444444442', 'Tarde');

    INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at) VALUES
      ('55555555-5555-5555-5555-555555555551', 'Club Norte', 'club_norte', 'CN', 'norte@test.cl', 'active', false, now()),
      ('55555555-5555-5555-5555-555555555552', 'Club Sur',   'club_sur',   'CS', 'sur@test.cl',   'active', false, now());

    INSERT INTO persons (id, run, username, full_name, birth_date, gender, status, updated_at) VALUES
      ('66666666-6666-6666-6666-666666666661', '11111111', 'ana',   'Ana Pérez',   '1985-04-04', 'female', 'active', now()),
      ('66666666-6666-6666-6666-666666666662', '22222222', 'bruno', 'Bruno Soto',  '1990-06-06', 'male',   'active', now()),
      ('66666666-6666-6666-6666-666666666663', '33333333', 'cira',  'Cira Rojas',  '1978-09-09', 'female', 'active', now());

    INSERT INTO categories (id, test_type_id, name, min_age, max_age, updated_at) VALUES
      ('77777777-7777-7777-7777-777777777771', '11111111-1111-1111-1111-111111111111', 'Master A', 25, 45, now());

    INSERT INTO events (id, test_type_id, distance_id, stroke_id, gender, updated_at) VALUES
      ('88888888-8888-8888-8888-888888888881', '11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333331', 'mixed', now());

    INSERT INTO competitions (id, name, status, registration_start_at, registration_end_at, updated_at) VALUES
      ('99999999-9999-9999-9999-999999999991', 'Nacional Máster', 'open', now() - interval '1 day', now() + interval '10 days', now()),
      ('99999999-9999-9999-9999-999999999992', 'Regional Máster', 'open', now() - interval '1 day', now() + interval '10 days', now());

    -- Fechas en días distintos: competition_dates tiene una restriccion unica
    -- (competition_id, date), y la prueba de mas abajo mueve una fecha de una
    -- competencia a la otra.
    INSERT INTO competition_dates (id, competition_id, date) VALUES
      ('aaaaaaa1-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991', now()),
      ('aaaaaaa1-0000-0000-0000-000000000002', '99999999-9999-9999-9999-999999999992', now() + interval '1 day');

    INSERT INTO competition_sessions (id, competition_date_id, session_type_id) VALUES
      ('bbbbbbb1-0000-0000-0000-000000000001', 'aaaaaaa1-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444441'),
      ('bbbbbbb1-0000-0000-0000-000000000002', 'aaaaaaa1-0000-0000-0000-000000000002', '44444444-4444-4444-4444-444444444442');

    INSERT INTO competition_events (id, competition_id, event_id, competition_session_id, status, updated_at) VALUES
      ('ccccccc1-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991',
       '88888888-8888-8888-8888-888888888881', 'bbbbbbb1-0000-0000-0000-000000000001', 'enabled', now());
  `);

  // -------------------------------------------------------------------------
  // CONFLICTOS: uno por CADA comprobación del preflight. La prueba de más
  // abajo recorre `CHECKS` y exige que todas queden ejercitadas, así que si se
  // agrega una comprobación sin su caso aquí, la suite falla.
  // -------------------------------------------------------------------------
  await client.query(`
    -- [registros-duplicados] dos inscripciones CONFIRMADAS del mismo nadador y prueba.
    INSERT INTO registrations (id, competition_event_id, person_id, club_id, category_id, status, registered_by_user_id, updated_at) VALUES
      ('ddddddd1-0000-0000-0000-000000000001', 'ccccccc1-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666661',
       '55555555-5555-5555-5555-555555555551', '77777777-7777-7777-7777-777777777771', 'confirmed', '66666666-6666-6666-6666-666666666661', now()),
      ('ddddddd1-0000-0000-0000-000000000002', 'ccccccc1-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666661',
       '55555555-5555-5555-5555-555555555551', '77777777-7777-7777-7777-777777777771', 'confirmed', '66666666-6666-6666-6666-666666666661', now());

    -- [membresias-multiples] un nadador con DOS membresías activas en clubes distintos.
    INSERT INTO club_swimmers (id, club_id, person_id, status, requested_by_user_id, start_date, updated_at) VALUES
      ('eeeeeee1-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555551', '66666666-6666-6666-6666-666666666662',
       'active', '66666666-6666-6666-6666-666666666661', now(), now()),
      ('eeeeeee1-0000-0000-0000-000000000002', '55555555-5555-5555-5555-555555555552', '66666666-6666-6666-6666-666666666662',
       'active', '66666666-6666-6666-6666-666666666661', now(), now());

    -- [jornada-de-otra-competencia] prueba asociada a la jornada de otra competencia.
    INSERT INTO competition_events (id, competition_id, event_id, competition_session_id, status, updated_at) VALUES
      ('ccccccc1-0000-0000-0000-000000000002', '99999999-9999-9999-9999-999999999991',
       '88888888-8888-8888-8888-888888888881', 'bbbbbbb1-0000-0000-0000-000000000002', 'enabled', now());
  `);

  // [relevos-duplicados] dos equipos CONFIRMADOS del mismo club para la misma
  // prueba y categoría. Requiere una prueba de relevo y su categoría.
  await client.query(`
    INSERT INTO categories (id, test_type_id, name, min_age, max_age, updated_at) VALUES
      ('77777777-7777-7777-7777-777777777772', '11111111-1111-1111-1111-111111111112', 'Relevo 100-119', 100, 119, now());

    INSERT INTO events (id, test_type_id, distance_id, stroke_id, gender, updated_at) VALUES
      ('88888888-8888-8888-8888-888888888882', '11111111-1111-1111-1111-111111111112',
       '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333331', 'mixed', now());

    INSERT INTO competition_events (id, competition_id, event_id, competition_session_id, status, updated_at) VALUES
      ('ccccccc1-0000-0000-0000-000000000003', '99999999-9999-9999-9999-999999999991',
       '88888888-8888-8888-8888-888888888882', 'bbbbbbb1-0000-0000-0000-000000000001', 'enabled', now());

    INSERT INTO relay_registrations (id, competition_event_id, club_id, category_id, status, registered_by_user_id, updated_at) VALUES
      ('fffffff1-0000-0000-0000-000000000001', 'ccccccc1-0000-0000-0000-000000000003', '55555555-5555-5555-5555-555555555551',
       '77777777-7777-7777-7777-777777777772', 'confirmed', '66666666-6666-6666-6666-666666666661', now()),
      ('fffffff1-0000-0000-0000-000000000002', 'ccccccc1-0000-0000-0000-000000000003', '55555555-5555-5555-5555-555555555551',
       '77777777-7777-7777-7777-777777777772', 'confirmed', '66666666-6666-6666-6666-666666666661', now());
  `);

  /**
   * Las seis comprobaciones de CLAVES NATURALES necesitan un paso previo.
   *
   * En el esquema anterior esas columnas tienen índices únicos TOTALES
   * (`persons_run_key`, `clubs_username_key`, etc.), así que una base íntegra
   * de la versión previa no puede contener esos duplicados: la propia base
   * los impedía. La migración los reemplaza por índices PARCIALES, más
   * permisivos.
   *
   * ¿Por qué entonces el preflight los comprueba? Porque el índice total pudo
   * haberse eliminado a mano en algún momento (una restauración parcial, una
   * corrección de emergencia, una carga masiva con los índices desactivados),
   * y en ese caso los duplicados sí existen y la migración fallaría. Para
   * ejercitar esas seis comprobaciones hay que reproducir exactamente ese
   * escenario: se quitan los índices totales y recién entonces se insertan
   * los duplicados.
   */
  await client.query(`
    DROP INDEX IF EXISTS "persons_run_key";
    DROP INDEX IF EXISTS "persons_username_key";
    DROP INDEX IF EXISTS "clubs_username_key";
    DROP INDEX IF EXISTS "categories_test_type_id_name_key";
    DROP INDEX IF EXISTS "events_test_type_id_distance_id_stroke_id_gender_key";
    DROP INDEX IF EXISTS "category_groups_name_key";
  `);

  // [run-duplicado] y [username-persona-duplicado]
  await client.query(`
    INSERT INTO persons (id, run, username, full_name, birth_date, gender, status, updated_at) VALUES
      ('66666666-6666-6666-6666-666666666664', '11111111', 'ana_dup',  'Ana Pérez (duplicada)', '1985-04-04', 'female', 'active', now()),
      ('66666666-6666-6666-6666-666666666665', '44444444', 'bruno',    'Bruno Soto (homónimo)', '1991-01-01', 'male',   'active', now());
  `);

  // [username-club-duplicado]
  await client.query(`
    INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at) VALUES
      ('55555555-5555-5555-5555-555555555553', 'Club Norte (duplicado)', 'club_norte', 'CN2', 'norte2@test.cl', 'active', false, now());
  `);

  // [categoria-duplicada]
  await client.query(`
    INSERT INTO categories (id, test_type_id, name, min_age, max_age, updated_at) VALUES
      ('77777777-7777-7777-7777-777777777773', '11111111-1111-1111-1111-111111111111', 'Master A', 46, 55, now());
  `);

  // [grupo-categoria-duplicado]
  await client.query(`
    INSERT INTO category_groups (id, name, updated_at) VALUES
      ('aaaaaaa2-0000-0000-0000-000000000001', 'Master FINA', now()),
      ('aaaaaaa2-0000-0000-0000-000000000002', 'Master FINA', now());
  `);

  // [prueba-duplicada]
  await client.query(`
    INSERT INTO events (id, test_type_id, distance_id, stroke_id, gender, updated_at) VALUES
      ('88888888-8888-8888-8888-888888888883', '11111111-1111-1111-1111-111111111111',
       '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333331', 'mixed', now());
  `);

  /**
   * [cuenta-dueno-incoherente] — una cuenta con persona Y club a la vez.
   *
   * El esquema anterior no lo impedía: `owner_type` era una etiqueta sin
   * relación obligatoria con las columnas. Este caso NO lo corrige la
   * migración sola (sí el del administrador, que pasa a `system`), así que
   * queda como conflicto que el preflight debe reportar.
   *
   * La cuenta del administrador —`owner_type = 'person'` sin persona— también
   * se inserta aquí: es el caso que la migración resuelve sin intervención, y
   * sirve para comprobar que el respaldo de datos funciona.
   */
  await client.query(`
    INSERT INTO users (id, username, password_hash, must_change_password, status, owner_type, person_id, club_id, updated_at) VALUES
      ('c0ffee01-0000-0000-0000-000000000001', 'cuenta_incoherente', 'x', false, 'active', 'person',
       '66666666-6666-6666-6666-666666666661', '55555555-5555-5555-5555-555555555551', now()),
      ('c0ffee01-0000-0000-0000-000000000002', 'admin_legacy', 'x', false, 'active', 'person', NULL, NULL, now());
  `);

  /**
   * [username-colision-global] — una persona y un club con el MISMO nombre de
   * usuario. Ningún índice podía impedirlo: son tablas distintas. El choque
   * aparecía recién al pedir credenciales para el segundo.
   */
  await client.query(`
    INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at) VALUES
      ('55555555-5555-5555-5555-555555555554', 'Club Ana', 'ana', 'CA', 'ana@test.cl', 'active', false, now());
  `);

  /**
   * Conflictos de las garantías de la Fase 4 (`phase4_identity_guards`). En el
   * esquema anterior `club_staff` no tenía ninguna de estas restricciones, así
   * que estos estados son perfectamente posibles en una base real.
   *
   * [representantes-legales-multiples] dos representantes legales del mismo club.
   * [persona-en-varios-clubes]        una persona con cargos en dos clubes.
   *
   * `cuenta-username-distinto-al-titular` no necesita fila propia: la cuenta
   * 'cuenta_incoherente' de más arriba ya pertenece a Ana ('ana') con otro
   * nombre, y es exactamente ese caso.
   */
  await client.query(`
    INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES
      ('c5a44001-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555551',
       '66666666-6666-6666-6666-666666666661', 'legal_representative'),
      ('c5a44001-0000-0000-0000-000000000002', '55555555-5555-5555-5555-555555555551',
       '66666666-6666-6666-6666-666666666662', 'legal_representative'),
      ('c5a44001-0000-0000-0000-000000000003', '55555555-5555-5555-5555-555555555551',
       '66666666-6666-6666-6666-666666666663', 'delegate'),
      ('c5a44001-0000-0000-0000-000000000004', '55555555-5555-5555-5555-555555555552',
       '66666666-6666-6666-6666-666666666663', 'coach');
  `);
}

/** Correcciones, una por comprobación, en el orden que sugiere el preflight. */
async function corregirConflictos(client: Client) {
  await client.query(`
    UPDATE registrations SET status = 'cancelled', cancelled_at = now() WHERE id = 'ddddddd1-0000-0000-0000-000000000002';
    UPDATE relay_registrations SET status = 'cancelled', cancelled_at = now() WHERE id = 'fffffff1-0000-0000-0000-000000000002';
    UPDATE club_swimmers SET status = 'ended', end_date = now() WHERE id = 'eeeeeee1-0000-0000-0000-000000000002';
    DELETE FROM competition_events WHERE id = 'ccccccc1-0000-0000-0000-000000000002';
    -- Las fichas duplicadas se eliminan LÓGICAMENTE: el historial se conserva.
    -- Antes esta corrección las borraba físicamente, porque el paso siguiente
    -- recreaba los índices únicos TOTALES, que no distinguen filas eliminadas.
    -- Ya no hace falta: el índice de compatibilidad es ordinario.
    UPDATE persons SET deleted_at = now() WHERE id IN ('66666666-6666-6666-6666-666666666664', '66666666-6666-6666-6666-666666666665');
    UPDATE clubs SET deleted_at = now() WHERE id = '55555555-5555-5555-5555-555555555553';
    UPDATE categories SET deleted_at = now() WHERE id = '77777777-7777-7777-7777-777777777773';
    UPDATE category_groups SET deleted_at = now() WHERE id = 'aaaaaaa2-0000-0000-0000-000000000002';
    UPDATE events SET deleted_at = now() WHERE id = '88888888-8888-8888-8888-888888888883';

    -- [cuenta-dueno-incoherente] la cuenta se queda con UN dueño. La del
    -- administrador no se toca: la migración la pasa sola a 'system'.
    UPDATE users SET club_id = NULL WHERE id = 'c0ffee01-0000-0000-0000-000000000001';

    -- [username-colision-global] se renombra al titular que cede el nombre.
    -- No se puede hacer desde la aplicación (el nombre de usuario es
    -- inmutable), y por eso el preflight indica hacerlo por base de datos.
    UPDATE clubs SET username = 'club_ana' WHERE id = '55555555-5555-5555-5555-555555555554';

    -- [cuenta-username-distinto-al-titular] la cuenta pasa a llamarse como su
    -- titular. Corrige de paso el mismo caso que veía 'cuenta-dueno-incoherente'.
    UPDATE users SET username = 'ana' WHERE id = 'c0ffee01-0000-0000-0000-000000000001';

    -- [representantes-legales-multiples] queda uno solo.
    DELETE FROM club_staff WHERE id = 'c5a44001-0000-0000-0000-000000000002';

    -- [persona-en-varios-clubes] Cira conserva su vínculo con un solo club.
    DELETE FROM club_staff WHERE id = 'c5a44001-0000-0000-0000-000000000004';
  `);

  /**
   * [indices-previos-ausentes] — índices de compatibilidad ORDINARIOS, no
   * únicos. Es exactamente el SQL que imprime el preflight.
   *
   * Que no sean únicos es lo que permite conservar las filas eliminadas
   * lógicamente: un índice único total las contaría igual y no se podría
   * crear. La migración solo necesita el nombre para poder hacer su
   * `DROP INDEX` y crear en su lugar el índice único PARCIAL definitivo.
   */
  await client.query(`
    CREATE INDEX "persons_run_key" ON "persons" ("run");
    CREATE INDEX "persons_username_key" ON "persons" ("username");
    CREATE INDEX "clubs_username_key" ON "clubs" ("username");
    CREATE INDEX "categories_test_type_id_name_key" ON "categories" ("test_type_id", "name");
    CREATE INDEX "events_test_type_id_distance_id_stroke_id_gender_key" ON "events" ("test_type_id", "distance_id", "stroke_id", "gender");
    CREATE INDEX "category_groups_name_key" ON "category_groups" ("name");
  `);
}

beforeAll(async () => {
  adminUrl = process.env.DATABASE_URL!;
  legacyUrl = baseUrlWithDatabase(LEGACY_DB);

  await withClient(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${LEGACY_DB}"`);
    await c.query(`CREATE DATABASE "${LEGACY_DB}"`);
  });

  workDir = mkdtempSync(join(tmpdir(), "natacion-migracion-"));
  mkdirSync(join(workDir, "prisma"), { recursive: true });
  cpSync(join(BACKEND_DIR, "prisma", "schema.prisma"), join(workDir, "prisma", "schema.prisma"));
}, 120_000);

afterAll(async () => {
  await withClient(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${LEGACY_DB}"`);
  }).catch(() => void 0);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
}, 60_000);

describe("actualización desde la versión anterior con datos", () => {
  it("aplica las 14 migraciones previas y admite datos realistas", async () => {
    const legacy = legacyMigrationNames();
    expect(legacy.length, "deben existir las migraciones previas a la Fase 2").toBe(14);

    deployMigrations(legacy, legacyUrl);
    await withClient(legacyUrl, poblarBaseAnterior);

    const { rows } = await withClient(legacyUrl, (c) => c.query("SELECT count(*)::int AS n FROM registrations"));
    expect(rows[0].n).toBe(2);
  }, 180_000);

  /**
   * Cobertura EXHAUSTIVA: se recorre la lista real de comprobaciones y se
   * exige que cada una haya encontrado su conflicto. Antes esta prueba
   * afirmaba solo tres de las diez, y las siete restantes —incluidos los
   * relevos confirmados duplicados— quedaban sin ejercitar: su consulta podía
   * estar mal escrita y nadie se enteraba.
   */
  it("el preflight detecta TODAS las comprobaciones, una por una, y explica cómo resolverlas", () => {
    const { code, output } = runPreflight(legacyUrl);

    expect(code, "debe salir con código 1 para frenar un despliegue automatizado").toBe(1);

    /**
     * Las comprobaciones marcadas con `requires` miran objetos que crea
     * una migración POSTERIOR a la versión de esta base, así que aquí no
     * aplican y no se les puede sembrar un conflicto. El preflight debe
     * decirlo explícitamente —"NO APLICA"— y no confundirlo con un aprobado
     * ni con un "sin verificar".
     */
    const aplicables = CHECKS.filter((c) => !c.requires);
    const noAplicables = CHECKS.filter((c) => c.requires);

    const noDetectadas = aplicables.filter((check) => !output.includes(`BLOQUEA ${check.title}`)).map((c) => c.id);
    expect(noDetectadas, "toda comprobación aplicable debe tener su caso de conflicto en los datos y ser detectada").toEqual([]);

    for (const check of noAplicables) {
      expect(output, `${check.id} debería reportarse como NO APLICA`).toContain(`NO APLICA ${check.title}`);
      expect(output, `${check.id} no puede contarse como verificada`).not.toContain(`OK ${check.title}`);
    }

    expect(CHECKS.length, "si se agregan comprobaciones, hay que sembrar su conflicto arriba").toBe(17);

    // Cada bloqueo nombra la restricción y dice qué hacer, no solo que falla.
    for (const check of aplicables) {
      expect(output, `falta la restricción de ${check.id}`).toContain(check.constraint);
    }
    expect(output).toMatch(/Cómo resolverlo/);
    expect(output).toContain("respaldo");
  }, 120_000);

  it("los relevos confirmados duplicados se reportan con el club y el conteo", () => {
    const { output } = runPreflight(legacyUrl);
    expect(output).toContain("Equipos de relevo confirmados duplicados");
    expect(output).toContain("relay_registrations_unique_confirmed_team");
    expect(output).toContain("Club Norte");
  }, 120_000);

  it("una comprobación que NO se puede ejecutar impide aprobar la migración", async () => {
    // Se simula una base más antigua de lo esperado: falta una tabla que el
    // preflight necesita consultar. Antes esto solo imprimía un aviso y el
    // script podía terminar diciendo "la base puede migrarse".
    await withClient(legacyUrl, (c) => c.query(`ALTER TABLE category_groups RENAME TO category_groups_tmp`));
    try {
      const { code, output } = runPreflight(legacyUrl);
      expect(code, "no puede aprobar con comprobaciones sin verificar").toBe(1);
      expect(output).toContain("SIN VERIFICAR");
      expect(output).not.toContain("la base puede migrarse");
    } finally {
      await withClient(legacyUrl, (c) => c.query(`ALTER TABLE category_groups_tmp RENAME TO category_groups`));
    }
  }, 120_000);

  it("aplicar la migración SIN corregir falla (el preflight no es decorativo)", () => {
    expect(() => deployMigrations([...legacyMigrationNames(), ...MIGRACIONES_NUEVAS], legacyUrl)).toThrow();
  }, 180_000);

  it("tras corregir los datos como indica el preflight, la migración se aplica", async () => {
    // La migración anterior quedó marcada como fallida: se limpia el registro
    // para reintentar, igual que haría `prisma migrate resolve --rolled-back`.
    await withClient(legacyUrl, async (c) => {
      await c.query(`DELETE FROM _prisma_migrations WHERE finished_at IS NULL`);
      await corregirConflictos(c);
    });

    expect(runPreflight(legacyUrl).code, "el preflight debe quedar limpio").toBe(0);

    deployMigrations([...legacyMigrationNames(), ...MIGRACIONES_NUEVAS], legacyUrl);

    // Los datos siguen ahí: migrar no perdió información.
    const { rows } = await withClient(legacyUrl, (c) =>
      c.query("SELECT (SELECT count(*)::int FROM registrations) AS inscripciones, (SELECT count(*)::int FROM persons) AS personas")
    );
    expect(rows[0].inscripciones).toBe(2); // una confirmada + una cancelada
    // Las 5 personas siguen ahí: 3 vigentes y 2 eliminadas LÓGICAMENTE
    // durante la corrección. Migrar no exigió borrar historial.
    expect(rows[0].personas).toBe(5);
  }, 240_000);

  /**
   * Reapertura 3, punto 4 — el caso que la contradicción anterior hacía
   * imposible: una fila VIGENTE y otra ELIMINADA LÓGICAMENTE compartiendo la
   * clave natural, sin borrado físico en ningún momento.
   *
   * Con la instrucción anterior (recrear el índice único total) esta base no
   * se podía migrar sin destruir el historial. Con el índice de
   * compatibilidad ordinario, sí.
   */
  it("migra conservando una fila eliminada lógicamente que comparte la clave natural con una vigente", async () => {
    const RUN_COMPARTIDO = "55555555";

    await withClient(legacyUrl, async (c) => {
      // Estado de partida: falta el índice previo (se quitó a mano en algún
      // momento) y existen dos fichas con el mismo RUN, una ya retirada.
      await c.query(`DROP INDEX IF EXISTS "persons_run_key"`);
      await c.query(`
        INSERT INTO persons (id, run, username, full_name, birth_date, gender, status, deleted_at, updated_at) VALUES
          ('66666666-6666-6666-6666-66666666666a', '${RUN_COMPARTIDO}', 'vigente_dup', 'Dora Vigente',  '1980-01-01', 'female', 'active',   NULL,  now()),
          ('66666666-6666-6666-6666-66666666666b', '${RUN_COMPARTIDO}', 'retirada_dup','Dora Retirada', '1980-01-01', 'female', 'disabled', now(), now());
      `);

      // Y se deshace la migración de Fase 2 para volver al punto anterior.
      // (Una sentencia por consulta: pg no admite varias con parámetros.)
      await c.query(`DROP INDEX IF EXISTS "persons_run_unique_active"`);
      await c.query(`DELETE FROM _prisma_migrations WHERE migration_name = ANY($1::text[])`, [MIGRACIONES_NUEVAS]);

      // La reversión se ejecuta desde los PLANES DE REVERSIÓN escritos
      // (`rollback.sql`), no desde una copia: así el plan que se entrega como
      // documentación es el que esta prueba comprueba que funciona de verdad.
      // En orden inverso al de aplicación.
      //
      // El de `drop_dead_schema` restaura la ESTRUCTURA de las dos tablas
      // retiradas —vacías, como estaban—, que es lo que hace falta para que el
      // esquema anterior vuelva a ser válido.
      await c.query(readFileSync(join(MIGRATIONS_DIR, "20260913000000_drop_dead_schema", "rollback.sql"), "utf8"));
      await c.query(readFileSync(join(MIGRATIONS_DIR, "20260906020000_phase4_identity_guards", "rollback.sql"), "utf8"));
      await c.query(readFileSync(join(MIGRATIONS_DIR, "20260906010000_phase4_user_identity", "rollback.sql"), "utf8"));

      await c.query(`
        DROP TRIGGER IF EXISTS competition_dates_forbid_reassignment ON "competition_dates";
        DROP TRIGGER IF EXISTS competition_sessions_set_competition_id ON "competition_sessions";
        ALTER TABLE "competition_events" DROP CONSTRAINT IF EXISTS "competition_events_session_belongs_to_competition_fkey";
        ALTER TABLE "competition_sessions" DROP CONSTRAINT IF EXISTS "competition_sessions_id_competition_id_key";
        ALTER TABLE "competition_sessions" DROP COLUMN IF EXISTS "competition_id";
        ALTER TABLE "competitions" DROP COLUMN IF EXISTS "max_relay_events_per_swimmer_per_session";
        DROP INDEX IF EXISTS "registrations_unique_confirmed_person_event";
        DROP INDEX IF EXISTS "relay_registrations_unique_confirmed_team";
        DROP INDEX IF EXISTS "club_swimmers_unique_active_person";
        DROP INDEX IF EXISTS "persons_username_unique_active";
        DROP INDEX IF EXISTS "clubs_username_unique_active";
        DROP INDEX IF EXISTS "categories_unique_active_name";
        DROP INDEX IF EXISTS "events_unique_active_definition";
        DROP INDEX IF EXISTS "category_groups_name_unique_active";
        CREATE INDEX "persons_username_key" ON "persons" ("username");
        CREATE INDEX "clubs_username_key" ON "clubs" ("username");
        CREATE INDEX "categories_test_type_id_name_key" ON "categories" ("test_type_id", "name");
        CREATE INDEX "events_test_type_id_distance_id_stroke_id_gender_key" ON "events" ("test_type_id", "distance_id", "stroke_id", "gender");
        CREATE INDEX "category_groups_name_key" ON "category_groups" ("name");
      `);
    });

    // El preflight debe señalar SOLO el índice ausente: el RUN repetido no es
    // un problema, porque una de las dos fichas está eliminada.
    const antes = runPreflight(legacyUrl);
    expect(antes.code).toBe(1);
    expect(antes.output).toContain("BLOQUEA Índices de la versión anterior");
    expect(antes.output, "un RUN compartido con una ficha retirada no debe bloquear").not.toContain("BLOQUEA RUN repetido");
    // Y debe entregar el SQL exacto, ordinario, listo para copiar.
    expect(antes.output).toContain('CREATE INDEX persons_run_key ON persons ("run");');

    // Se aplica la remediación tal cual la imprime el preflight.
    await withClient(legacyUrl, (c) => c.query(`CREATE INDEX "persons_run_key" ON "persons" ("run")`));

    const despues = runPreflight(legacyUrl);
    expect(despues.code, `el preflight debe quedar limpio:\n${despues.output}`).toBe(0);

    deployMigrations([...legacyMigrationNames(), ...MIGRACIONES_NUEVAS], legacyUrl);

    // AMBAS filas siguen existiendo: no hubo borrado físico en ningún paso.
    await withClient(legacyUrl, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE deleted_at IS NULL)::int AS vigentes,
                count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS eliminadas
           FROM persons WHERE run = $1`,
        [RUN_COMPARTIDO]
      );
      expect(rows[0].total, "la fila eliminada lógicamente debe conservarse").toBe(2);
      expect(rows[0].vigentes).toBe(1);
      expect(rows[0].eliminadas).toBe(1);

      // El índice definitivo quedó creado y es el PARCIAL correcto.
      const { rows: indices } = await c.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname = 'persons_run_unique_active'`
      );
      expect(indices).toHaveLength(1);
      expect(indices[0].indexdef).toMatch(/CREATE UNIQUE INDEX/);
      expect(indices[0].indexdef).toMatch(/WHERE \(deleted_at IS NULL\)/);

      // Y sigue impidiendo un segundo RUN vigente repetido.
      await expect(
        c.query(
          `INSERT INTO persons (id, run, username, full_name, birth_date, gender, status, updated_at)
           VALUES ('66666666-6666-6666-6666-66666666666c', $1, 'otra_mas', 'Otra Más', '1980-01-01', 'female', 'active', now())`,
          [RUN_COMPARTIDO]
        )
      ).rejects.toThrow();
    });
  }, 240_000);

  it("las garantías nuevas quedan activas sobre los datos migrados", async () => {
    await withClient(legacyUrl, async (c) => {
      // Índices parciales creados.
      const { rows: indices } = await c.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN
          ('registrations_unique_confirmed_person_event','club_swimmers_unique_active_person',
           'categories_unique_active_name','category_groups_name_unique_active')`
      );
      expect(indices.map((r) => r.indexname).sort()).toEqual([
        "categories_unique_active_name",
        "category_groups_name_unique_active",
        "club_swimmers_unique_active_person",
        "registrations_unique_confirmed_person_event",
      ]);

      // La columna derivada quedó poblada para las jornadas existentes.
      const { rows: sesiones } = await c.query(
        `SELECT count(*)::int AS descuadradas
           FROM competition_sessions s JOIN competition_dates d ON d.id = s.competition_date_id
          WHERE s.competition_id <> d.competition_id`
      );
      expect(sesiones[0].descuadradas).toBe(0);

      // Y ahora el duplicado que antes existía es imposible.
      await expect(
        c.query(`
          INSERT INTO registrations (id, competition_event_id, person_id, club_id, category_id, status, registered_by_user_id, updated_at)
          VALUES ('ddddddd1-0000-0000-0000-000000000003', 'ccccccc1-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666661',
                  '55555555-5555-5555-5555-555555555551', '77777777-7777-7777-7777-777777777771', 'confirmed', '66666666-6666-6666-6666-666666666661', now())`)
      ).rejects.toThrow();
    });
  }, 120_000);

  /**
   * Punto 2 de la reapertura: el disparador debe derivar `competition_id`
   * SIEMPRE, no solo cuando cambia `competition_date_id`.
   */
  it("no se puede adulterar competition_id de una jornada con un UPDATE directo", async () => {
    await withClient(legacyUrl, async (c) => {
      await c.query(
        `UPDATE competition_sessions SET competition_id = '99999999-9999-9999-9999-999999999992'
          WHERE id = 'bbbbbbb1-0000-0000-0000-000000000001'`
      );

      const { rows } = await c.query(
        `SELECT s.competition_id AS jornada, d.competition_id AS fecha
           FROM competition_sessions s JOIN competition_dates d ON d.id = s.competition_date_id
          WHERE s.id = 'bbbbbbb1-0000-0000-0000-000000000001'`
      );
      expect(rows[0].jornada, "el disparador debe haber restaurado el valor derivado").toBe(rows[0].fecha);
      expect(rows[0].jornada).toBe("99999999-9999-9999-9999-999999999991");
    });
  }, 120_000);

  /**
   * Reapertura 2, punto 1. La versión anterior de esta prueba comprobaba que
   * mover una fecha "re-sincronizaba" las jornadas — es decir, verificaba el
   * comportamiento equivocado: esa re-sincronización, combinada con la
   * cascada de la clave foránea, arrastraba las pruebas y su historial a otra
   * competencia. Ahora la operación está prohibida y esto verifica que NADA
   * se mueve.
   */
  it("mover una FECHA a otra competencia está PROHIBIDO y no arrastra nada", async () => {
    await withClient(legacyUrl, async (c) => {
      const antes = await c.query(
        `SELECT (SELECT count(*)::int FROM competition_events WHERE competition_id = '99999999-9999-9999-9999-999999999991') AS pruebas,
                (SELECT count(*)::int FROM registrations) AS inscripciones`
      );

      await expect(
        c.query(
          `UPDATE competition_dates SET competition_id = '99999999-9999-9999-9999-999999999992'
            WHERE id = 'aaaaaaa1-0000-0000-0000-000000000001'`
        )
      ).rejects.toThrow(/No se puede cambiar la competencia de una fecha/i);

      const despues = await c.query(
        `SELECT (SELECT count(*)::int FROM competition_events WHERE competition_id = '99999999-9999-9999-9999-999999999991') AS pruebas,
                (SELECT count(*)::int FROM registrations) AS inscripciones,
                (SELECT competition_id FROM competition_dates WHERE id = 'aaaaaaa1-0000-0000-0000-000000000001') AS competencia_de_la_fecha,
                (SELECT count(*)::int FROM competition_events WHERE competition_id = '99999999-9999-9999-9999-999999999992') AS pruebas_en_destino`
      );

      expect(despues.rows[0].competencia_de_la_fecha).toBe("99999999-9999-9999-9999-999999999991");
      expect(despues.rows[0].pruebas).toBe(antes.rows[0].pruebas);
      expect(despues.rows[0].inscripciones).toBe(antes.rows[0].inscripciones);
      expect(despues.rows[0].pruebas_en_destino, "la competencia de destino no debe recibir nada").toBe(0);
    });
  }, 120_000);
});

/**
 * `20260913000000_drop_dead_schema` — el EFECTO, no solo la aplicación.
 *
 * La suite ya aplicaba esta migración —lo hace `prisma migrate deploy` al
 * arrancar—, pero nada afirmaba su resultado: si el `DROP TABLE` desapareciera
 * del archivo, todo seguiría en verde. Aquí se consulta el catálogo del propio
 * PostgreSQL, que es la única autoridad sobre si una tabla existe.
 *
 * Se comprueba contra la base de integración (`natacion_test`), que es donde la
 * migración está aplicada de verdad.
 */
describe("retirada de esquema muerto: efecto comprobado en el catálogo", () => {
  /** Consulta el catálogo de la base de integración, no un modelo de Prisma. */
  const existeTabla = (nombre: string): Promise<boolean> =>
    withClient(process.env.DATABASE_URL!, async (c) => {
      const { rows } = await c.query<{ existe: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS existe`,
        [nombre]
      );
      return rows[0]!.existe;
    });

  it("`password_reset_tokens` ya no existe", async () => {
    expect(await existeTabla("password_reset_tokens"), "la retiró la migración `drop_dead_schema`").toBe(false);
  });

  it("`system_settings` ya no existe", async () => {
    expect(await existeTabla("system_settings")).toBe(false);
  });

  it("la migración está registrada como aplicada", async () => {
    const filas = await withClient(process.env.DATABASE_URL!, async (c) => {
      const { rows } = await c.query<{ migration_name: string; finished_at: Date | null }>(
        `SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = $1`,
        ["20260913000000_drop_dead_schema"]
      );
      return rows;
    });

    expect(filas, "tiene que constar en el historial, no haberse aplicado a mano").toHaveLength(1);
    expect(filas[0]!.finished_at, "y haber terminado sin error").not.toBeNull();
  });

  it("y las tablas que SÍ debían quedarse siguen ahí", async () => {
    /**
     * El contraste. Sin él, una prueba que solo mira ausencias pasaría también
     * si la migración hubiera arrasado con media base.
     */
    for (const tabla of ["users", "persons", "clubs", "club_swimmers", "refresh_tokens", "audit_logs"]) {
      expect(await existeTabla(tabla), `${tabla} no debía tocarse`).toBe(true);
    }
  });
});

/**
 * EL HISTORIAL DE LA BASE COINCIDE CON LOS ARCHIVOS.
 *
 * Prisma calcula el checksum sobre el **archivo completo**, comentarios
 * incluidos. Editar una migración ya aplicada —aunque solo sea su cabecera
 * explicativa— deja la base con un historial que no representa lo que hay en
 * disco: la reproducibilidad se rompe y la divergencia aparece más tarde, en
 * otra máquina o en otro despliegue.
 *
 * Eso ocurrió de verdad en este proyecto, y ninguna prueba lo detectó: las de
 * `migration-upgrade` trabajan sobre una base efímera que crean y migran desde
 * cero con los archivos actuales, así que por construcción nunca ven una
 * divergencia. Este bloque mira la base de integración REAL, que conserva su
 * historial entre corridas y es la que puede desincronizarse.
 *
 * Solo lectura: si algo no cuadra, la respuesta es recrear la base desechable y
 * volver a migrar desde cero — nunca editar `_prisma_migrations` ni usar
 * `migrate resolve` para tapar la diferencia.
 */
describe("historial de migraciones de la base de integración", () => {
  const shaDe = (nombre: string): string =>
    createHash("sha256").update(readFileSync(join(MIGRATIONS_DIR, nombre, "migration.sql"))).digest("hex");

  interface FilaDeHistorial {
    migration_name: string;
    checksum: string;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }

  const historial = (): Promise<FilaDeHistorial[]> =>
    withClient(process.env.DATABASE_URL!, async (c) => {
      const { rows } = await c.query<FilaDeHistorial>(
        `SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`
      );
      return rows;
    });

  const migracionesEnDisco = (): string[] =>
    readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

  it("el checksum guardado de CADA migración es el del archivo en disco", async () => {
    const divergentes = (await historial())
      .filter((r) => r.checksum !== shaDe(r.migration_name))
      .map((r) => `${r.migration_name}: base=${r.checksum.slice(0, 12)}… archivo=${shaDe(r.migration_name).slice(0, 12)}…`);

    expect(
      divergentes,
      "una migración aplicada fue editada después; recree la base desechable y migre desde cero"
    ).toEqual([]);
  });

  it("no queda ninguna migración pendiente, a medias o revertida", async () => {
    const filas = await historial();

    expect(
      migracionesEnDisco().filter((n) => !filas.some((r) => r.migration_name === n)),
      "migraciones en disco que la base no tiene aplicadas"
    ).toEqual([]);
    expect(
      filas.filter((r) => r.finished_at === null).map((r) => r.migration_name),
      "migraciones registradas sin terminar"
    ).toEqual([]);
    expect(
      filas.filter((r) => r.rolled_back_at !== null).map((r) => r.migration_name),
      "migraciones marcadas como revertidas"
    ).toEqual([]);
  });

  it("y la base no tiene migraciones que el repositorio no contenga", async () => {
    const enDisco = new Set(migracionesEnDisco());
    const sobrantes = (await historial()).map((r) => r.migration_name).filter((n) => !enDisco.has(n));

    expect(sobrantes, "el historial nombra migraciones que ya no existen en el repositorio").toEqual([]);
  });
});
