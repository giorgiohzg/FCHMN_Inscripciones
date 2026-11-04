/**
 * Migración `20261102020000_personalidad_juridica_sin_pendiente` (etapa 10a),
 * probada CONTRA DATOS SINTÉTICOS en una base aparte de la base desechable.
 *
 * La migración convierte «pendiente» (`has_legal_status IS NULL`) en «No tiene»
 * (`false`) y elimina el RUT de esos MISMOS clubes. Aquí se comprueba, en orden:
 *
 *   1. El preflight detecta un club pendiente con representante legal.
 *   2. Con uno, la migración aborta ENTERA y no escribe nada.
 *   3. Un fallo A MITAD de la conversión (después de auditar) deshace también
 *      la auditoría: la transacción es explícita e íntegra.
 *   4. Resuelto lo anterior, la conversión:
 *        - convierte SOLO los NULL, vigentes o eliminados lógicamente;
 *        - elimina el RUT SOLO de esos clubes;
 *        - conserva el RUT de los demás estados, las razones sociales, los
 *          nombramientos, los roles y los permisos, y todas las demás columnas;
 *        - deja UNA auditoría por club convertido, exacta y SIN el valor del RUT;
 *        - no crea ninguna tabla;
 *        - NO hace obligatoria la columna (eso es la 10b).
 *
 * Todos los valores son sintéticos. Solo corre contra la base desechable
 * (`.env.test`).
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

const MIGRACION = "20261102020000_personalidad_juridica_sin_pendiente";
const DB_PRUEBA = "natacion_migra_pj_test";

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

/** Aplica la migración y devuelve el texto del fallo, o `null` si prosperó. */
function intentarMigrar(): string | null {
  try {
    desplegar([...anteriores(), MIGRACION], dbUrl);
    return null;
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    return `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}${err.message ?? ""}`;
  }
}

const anteriores = () =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name < MIGRACION)
    .map((d) => d.name)
    .sort();

const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  conCliente(dbUrl, (c) => c.query(sql, params)).then((r) => r.rows as T[]);

// ---------------------------------------------------------------------------
// Datos sintéticos. Los RUT son evidentemente falsos.
// ---------------------------------------------------------------------------

const RUT = { conPj: "111111111", falseConRut: "444444444", pendiente: "222222222", pendienteBorrado: "333333333", pendienteConRep: "555555555" };

/** id -> estado de partida. Los NULL son «pendiente». */
const CLUBES = [
  { id: "c-true", estado: true, rut: RUT.conPj, razon: "Razon A", borrado: false },
  { id: "c-false", estado: false, rut: null, razon: "Razon B", borrado: false },
  // `false` CON RUT: no debería existir, pero si existe NO se toca (otro estado).
  { id: "c-false-rut", estado: false, rut: RUT.falseConRut, razon: "Razon E", borrado: false },
  { id: "c-pend-rut", estado: null, rut: RUT.pendiente, razon: "Razon C", borrado: false },
  { id: "c-pend-sin", estado: null, rut: null, razon: null, borrado: false },
  { id: "c-pend-borrado", estado: null, rut: RUT.pendienteBorrado, razon: "Razon D", borrado: true },
  // Pendiente CON delegado: el delegado no impide la conversión y no se toca.
  { id: "c-pend-delegado", estado: null, rut: null, razon: null, borrado: false },
] as const;

const CONVERTIDOS_ESPERADOS = ["c-pend-borrado", "c-pend-delegado", "c-pend-rut", "c-pend-sin"];
/** Pendiente con representante legal: aborta la conversión mientras exista. */
const CLUB_CON_REPRESENTANTE = "c-pend-rep";

async function poblar(c: Client) {
  let i = 0;
  for (const k of [...CLUBES, { id: CLUB_CON_REPRESENTANTE, estado: null, rut: RUT.pendienteConRep, razon: "Razon F", borrado: false }]) {
    await c.query(
      `INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, rut, legal_name, deleted_at, updated_at)
       VALUES ($1, $2, $3, $4, 'x@example.invalid', 'active', $5, $6, $7, $8, now())`,
      [k.id, `Club ${k.id}`, `club_${k.id.replace(/-/g, "_")}`, `C${i++}`, k.estado, k.rut, k.razon, k.borrado ? new Date("2026-10-01") : null]
    );
  }

  // Un club CON personalidad jurídica y representante legal: nombramiento, rol y
  // permiso de acceso que deben quedar INTACTOS.
  await c.query(
    `INSERT INTO persons (id, run, username, full_name, birth_date, gender, status, updated_at)
     VALUES ('p-rep', '60000001', 'rep_true', 'Persona Representante', '1985-04-04', 'female', 'active', now()),
            ('p-del', '60000002', 'del_pend', 'Persona Delegada', '1986-05-05', 'female', 'active', now()),
            ('p-rep2', '60000003', 'rep_pend', 'Persona Representante Dos', '1987-06-06', 'female', 'active', now())`
  );
  await c.query(
    `INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES
       ('s-rep', 'c-true', 'p-rep', 'legal_representative'),
       ('s-del', 'c-pend-delegado', 'p-del', 'delegate'),
       ('s-rep2', '${CLUB_CON_REPRESENTANTE}', 'p-rep2', 'legal_representative')`
  );
  await c.query(
    `INSERT INTO person_roles (id, person_id, role_type, active, updated_at) VALUES
       ('r-rep', 'p-rep', 'legal_representative', true, now()),
       ('r-del', 'p-del', 'delegate', true, now())`
  );
  await c.query(
    `INSERT INTO users (id, username, password_hash, must_change_password, status, owner_type, person_id, updated_at)
     VALUES ('u-rep', 'rep_true', 'x', false, 'active', 'person', 'p-rep', now())`
  );
  await c.query(
    `INSERT INTO roles (id, name) VALUES ('role-rep', 'legal_representative') ON CONFLICT (name) DO NOTHING`
  );
  const rol = (await c.query(`SELECT id FROM roles WHERE name = 'legal_representative'`)).rows[0].id as string;
  await c.query(`INSERT INTO user_roles (user_id, role_id) VALUES ('u-rep', $1)`, [rol]);
}

/** Foto de todo lo que NO debe cambiar (más lo que sí, para compararlo aparte). */
async function foto() {
  const [clubes, staff, roles, userRoles, auditoria, tablas] = await Promise.all([
    q(`SELECT to_jsonb(c) AS fila FROM clubs c ORDER BY id`),
    q(`SELECT to_jsonb(s) AS fila FROM club_staff s ORDER BY id`),
    q(`SELECT to_jsonb(r) AS fila FROM person_roles r ORDER BY id`),
    q(`SELECT to_jsonb(u) AS fila FROM user_roles u ORDER BY user_id, role_id`),
    q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs`),
    q<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`),
  ]);
  return { clubes, staff, roles, userRoles, auditoria: auditoria[0], tablas };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL (use .env.test)");
  adminUrl = urlConBase("postgres");
  dbUrl = urlConBase(DB_PRUEBA);

  workDir = mkdtempSync(join(tmpdir(), "migra-pj-"));
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

/** Una migración fallida queda registrada: igual que `migrate resolve --rolled-back`. */
const olvidarMigracionFallida = () => q(`DELETE FROM _prisma_migrations WHERE finished_at IS NULL`);

let fotoInicial: Awaited<ReturnType<typeof foto>>;

describe("1. antes de migrar", () => {
  it("el preflight detecta el club pendiente con representante legal, y solo ese", async () => {
    fotoInicial = await foto();

    const check = CHECKS.find((c) => c.id === "club-pendiente-con-representante-legal");
    expect(check, "debe existir la comprobación").toBeDefined();
    const filas = await q<{ id: string; nombramientos: string }>(check!.query);
    expect(filas.map((f) => f.id)).toEqual([CLUB_CON_REPRESENTANTE]);
    // El diagnóstico nombra al club y cuenta nombramientos; no muestra RUT ni personas.
    expect(JSON.stringify(filas)).not.toContain(RUT.pendienteConRep);
    expect(check!.remediation).toMatch(/no lo resuelve por su cuenta/i);
  });
});

describe("2. aborto íntegro ante un representante legal en un club pendiente", () => {
  it("falla con diagnóstico y NO modifica nada", async () => {
    const fallo = intentarMigrar();
    expect(fallo, "la migración debía fallar").not.toBeNull();
    expect(fallo).toMatch(/representante legal/i);
    expect(fallo).toContain(CLUB_CON_REPRESENTANTE);
    expect(fallo, "el diagnóstico no incluye el RUT").not.toContain(RUT.pendienteConRep);
    expect(fallo, "ni datos de las personas").not.toMatch(/Persona Representante/);

    expect(await foto()).toEqual(fotoInicial);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'CLUB_LEGAL_STATUS_CONVERTED'`)).toHaveLength(0);
  }, 240_000);
});

describe("3. un fallo A MITAD de la conversión deshace TODO, también la auditoría", () => {
  beforeAll(async () => {
    await olvidarMigracionFallida();
    // La operadora resuelve el caso del representante (decisión de negocio, a mano).
    await q(`DELETE FROM club_staff WHERE id = 's-rep2'`);
    fotoInicial = await foto();

    // Sabotaje de ensayo, SOLO en la base desechable: hace fallar la actualización
    // de un club cualquiera DESPUÉS de que la migración ya insertó su auditoría.
    await q(`
      CREATE FUNCTION _sabotaje_pj() RETURNS trigger AS $f$
      BEGIN
        IF NEW.id = 'c-pend-borrado' THEN RAISE EXCEPTION 'sabotaje de ensayo'; END IF;
        RETURN NEW;
      END; $f$ LANGUAGE plpgsql;
      CREATE TRIGGER _sabotaje_pj BEFORE UPDATE OF has_legal_status ON clubs
        FOR EACH ROW EXECUTE FUNCTION _sabotaje_pj();
    `);
  }, 120_000);

  it("el preflight ya no encuentra el caso del representante", async () => {
    const check = CHECKS.find((c) => c.id === "club-pendiente-con-representante-legal")!;
    expect(await q(check.query)).toEqual([]);
  });

  it("la migración falla y no queda NADA: ni clubes convertidos, ni RUT borrados, ni auditoría", async () => {
    const fallo = intentarMigrar();
    expect(fallo, "la migración debía fallar").not.toBeNull();
    // Dentro de la transacción explícita Prisma pierde el texto del motor (queda el
    // genérico «transaction is aborted»): por eso la validación con diagnóstico va
    // ANTES de `BEGIN` y esto es solo la red de seguridad.
    expect(fallo).toMatch(/transaction is aborted|sabotaje de ensayo/);

    expect(await foto()).toEqual(fotoInicial);
    expect(await q(`SELECT 1 FROM audit_logs WHERE action = 'CLUB_LEGAL_STATUS_CONVERTED'`)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM clubs WHERE has_legal_status IS NULL`)).toHaveLength(CONVERTIDOS_ESPERADOS.length + 1);
  }, 240_000);
});

describe("4. la conversión", () => {
  let antes: Awaited<ReturnType<typeof foto>>;

  beforeAll(async () => {
    await olvidarMigracionFallida();
    await q(`DROP TRIGGER _sabotaje_pj ON clubs; DROP FUNCTION _sabotaje_pj();`);
    antes = await foto();
    const fallo = intentarMigrar();
    expect(fallo, fallo ?? "").toBeNull();
  }, 240_000);

  const CONVERTIDOS = [...CONVERTIDOS_ESPERADOS, CLUB_CON_REPRESENTANTE].sort();

  it("convierte SOLO los NULL —vigentes y eliminados lógicamente— y deja a los demás como estaban", async () => {
    const filas = await q<{ id: string; has_legal_status: boolean | null; deleted: boolean }>(
      `SELECT id, has_legal_status, deleted_at IS NOT NULL AS deleted FROM clubs ORDER BY id`
    );
    expect(filas.filter((f) => f.has_legal_status === null)).toEqual([]);
    const estadoDe = Object.fromEntries(filas.map((f) => [f.id, f.has_legal_status]));
    expect(estadoDe["c-true"], "los true no se tocan").toBe(true);
    expect(estadoDe["c-false"]).toBe(false);
    expect(estadoDe["c-false-rut"]).toBe(false);
    for (const id of CONVERTIDOS) expect(estadoDe[id], id).toBe(false);
    // El eliminado lógicamente también se convirtió, y sigue eliminado.
    expect(filas.find((f) => f.id === "c-pend-borrado")).toMatchObject({ has_legal_status: false, deleted: true });
  });

  it("elimina el RUT SOLO de los convertidos; conserva el de los demás estados", async () => {
    const ruts = Object.fromEntries((await q<{ id: string; rut: string | null }>(`SELECT id, rut FROM clubs`)).map((r) => [r.id, r.rut]));
    for (const id of CONVERTIDOS) expect(ruts[id], `${id} no debe conservar RUT`).toBeNull();
    expect(ruts["c-true"], "RUT de un club «Tiene»").toBe(RUT.conPj);
    expect(ruts["c-false-rut"], "RUT de un club que ya era «No tiene»").toBe(RUT.falseConRut);
    expect(ruts["c-false"]).toBeNull();
  });

  it("no toca nada más: ni las razones sociales ni ninguna otra columna de ningún club", async () => {
    const despues = await foto();
    const sin = (f: { fila: Record<string, unknown> }) => {
      const { has_legal_status: _e, rut: _r, ...resto } = f.fila;
      return resto;
    };
    expect(despues.clubes.map((f) => sin(f as never))).toEqual(antes.clubes.map((f) => sin(f as never)));
    const razones = await q<{ id: string; legal_name: string | null }>(`SELECT id, legal_name FROM clubs ORDER BY id`);
    expect(razones.find((r) => r.id === "c-pend-rut")!.legal_name, "razón social de un convertido").toBe("Razon C");
    expect(razones.find((r) => r.id === "c-pend-borrado")!.legal_name).toBe("Razon D");
  });

  it("conserva nombramientos, roles y permisos, incluidos los del representante legal de un club «Tiene»", async () => {
    const despues = await foto();
    expect(despues.staff).toEqual(antes.staff);
    expect(despues.roles).toEqual(antes.roles);
    expect(despues.userRoles).toEqual(antes.userRoles);
    expect(await q(`SELECT 1 FROM club_staff WHERE id = 's-rep' AND role_type = 'legal_representative'`)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM club_staff WHERE id = 's-del'`), "el delegado de un club pendiente se conserva").toHaveLength(1);
    expect(await q(`SELECT 1 FROM user_roles WHERE user_id = 'u-rep'`)).toHaveLength(1);
  });

  it("deja EXACTAMENTE una auditoría por club convertido, con estado anterior, nuevo y si se eliminó un RUT", async () => {
    const filas = await q<{
      entity_id: string;
      entity_type: string;
      user_id: string | null;
      ip_address: string | null;
      before: unknown;
      after: unknown;
    }>(`SELECT entity_id, entity_type, user_id, ip_address, before, after FROM audit_logs WHERE action = 'CLUB_LEGAL_STATUS_CONVERTED' ORDER BY entity_id`);

    expect(filas.map((f) => f.entity_id)).toEqual(CONVERTIDOS);

    const teniaRut: Record<string, boolean> = {
      "c-pend-rut": true,
      "c-pend-borrado": true,
      [CLUB_CON_REPRESENTANTE]: true,
      "c-pend-sin": false,
      "c-pend-delegado": false,
    };
    for (const f of filas) {
      expect(f.entity_type).toBe("Club");
      expect(f.user_id, "la hace la migración, no una persona").toBeNull();
      expect(f.before).toEqual({ hasLegalStatus: null });
      expect(f.after).toEqual({ hasLegalStatus: false, rutEliminado: teniaRut[f.entity_id] });
    }
  });

  it("NINGÚN valor de RUT aparece en la auditoría", async () => {
    const texto = (await q<{ t: string }>(`SELECT string_agg(a::text, ' ') AS t FROM audit_logs a`))[0]!.t ?? "";
    for (const rut of Object.values(RUT)) expect(texto).not.toContain(rut);
  });

  it("no hay más auditoría que esa, y no se creó ninguna tabla", async () => {
    const despues = await foto();
    expect(despues.auditoria!.n).toBe(antes.auditoria!.n + CONVERTIDOS.length);
    expect(despues.tablas, "no hay tabla para conservar los RUT retirados").toEqual(antes.tablas);
  });

  it("la columna sigue admitiendo NULL: hacerla obligatoria es la migración 10b", async () => {
    const col = await q<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name='clubs' AND column_name='has_legal_status'`
    );
    expect(col[0]!.is_nullable).toBe("YES");
    // Mientras tanto, un cliente anterior todavía puede escribir NULL (la ventana de reversión del código).
    await q(
      `INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at)
       VALUES ('c-tardio', 'Tardío', 'club_tardio', 'TAR', 'x@example.invalid', 'active', NULL, now())`
    );
  });

  it("el preflight vuelve a dar limpio", async () => {
    const check = CHECKS.find((c) => c.id === "club-pendiente-con-representante-legal")!;
    expect(await q(check.query)).toEqual([]);
  });
});
