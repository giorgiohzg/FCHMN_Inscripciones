/**
 * Las validaciones de `phase4_identity_guards`, ejecutadas de verdad.
 *
 * La migración crea un índice único y tres disparadores. Sobre datos que ya
 * incumplen esas reglas, PostgreSQL aborta con un error del motor que no dice
 * qué fila la causó ("could not create unique index ..."), y el operador se
 * queda con una migración marcada como fallida y sin pista de qué corregir.
 *
 * Por eso la migración VALIDA antes de crear nada. Esta prueba construye cada
 * estado histórico incompatible sobre una base que está justo en la migración
 * anterior, intenta aplicarla, y comprueba que se detiene con el mensaje que
 * nombra el problema y remite al preflight.
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
const GUARDS = "20260906020000_phase4_identity_guards";
const ANTERIOR = "20260906010000_phase4_user_identity";
const DB = "natacion_guards_test";

let adminUrl: string;
let dbUrl: string;
let workDir: string;

function urlDe(database: string): string {
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

function desplegar(hasta: string): string {
  const nombres = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .filter((n) => n <= hasta);

  const target = join(workDir, "prisma", "migrations");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const n of nombres) cpSync(join(MIGRATIONS_DIR, n), join(target, n), { recursive: true });
  cpSync(join(MIGRATIONS_DIR, "migration_lock.toml"), join(target, "migration_lock.toml"));

  try {
    return execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", join(workDir, "prisma", "schema.prisma")], {
      cwd: BACKEND_DIR,
      env: { ...process.env, DATABASE_URL: dbUrl },
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
    });
  } catch (err) {
    // El mensaje útil está en la salida del proceso, no en el Error de Node;
    // se conserva el original como `cause` para no perder el contexto.
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`${e.stdout ?? ""}${e.stderr ?? ""}`, { cause: err });
  }
}

/** Base limpia en la migración ANTERIOR a las garantías, con datos mínimos. */
async function baseEnLaAnterior(sembrar: (c: Client) => Promise<void>) {
  await conCliente(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${DB}"`);
  });
  desplegar(ANTERIOR);
  await conCliente(dbUrl, async (c) => {
    await c.query(`
      INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at) VALUES
        ('c1000000-0000-0000-0000-000000000001', 'Club Norte', 'club_norte', 'CN', 'cn@test.cl', 'active', false, now()),
        ('c1000000-0000-0000-0000-000000000002', 'Club Sur',   'club_sur',   'CS', 'cs@test.cl', 'active', false, now());
      INSERT INTO persons (id, run, username, full_name, birth_date, gender, status, updated_at) VALUES
        ('p1000000-0000-0000-0000-000000000001', '11111111', 'ana',   'Ana Pérez',  '1985-04-04', 'female', 'active', now()),
        ('p1000000-0000-0000-0000-000000000002', '22222222', 'bruno', 'Bruno Soto', '1990-06-06', 'male',   'active', now());
    `);
    await sembrar(c);
  });
}

beforeAll(async () => {
  adminUrl = process.env.DATABASE_URL!;
  dbUrl = urlDe(DB);
  workDir = mkdtempSync(join(tmpdir(), "natacion-guards-"));
  mkdirSync(join(workDir, "prisma"), { recursive: true });
  cpSync(join(BACKEND_DIR, "prisma", "schema.prisma"), join(workDir, "prisma", "schema.prisma"));
}, 120_000);

afterAll(async () => {
  await conCliente(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`)).catch(() => void 0);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
}, 60_000);

describe("phase4_identity_guards valida el estado histórico antes de crear nada", () => {
  it("se detiene si un club ya tiene DOS representantes legales", async () => {
    await baseEnLaAnterior(async (c) => {
      await c.query(`
        INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES
          (gen_random_uuid(), 'c1000000-0000-0000-0000-000000000001', 'p1000000-0000-0000-0000-000000000001', 'legal_representative'),
          (gen_random_uuid(), 'c1000000-0000-0000-0000-000000000001', 'p1000000-0000-0000-0000-000000000002', 'legal_representative');
      `);
    });

    expect(() => desplegar(GUARDS)).toThrow(/más de un representante legal/i);

    // Y no dejó a medias ninguna de las garantías.
    await conCliente(dbUrl, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'club_staff_unique_legal_representative'`
      );
      expect(rows[0].n, "el índice no llegó a crearse: la migración se revirtió entera").toBe(0);
    });
  }, 300_000);

  it("se detiene si una persona ya es personal de DOS clubes", async () => {
    await baseEnLaAnterior(async (c) => {
      await c.query(`
        INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES
          (gen_random_uuid(), 'c1000000-0000-0000-0000-000000000001', 'p1000000-0000-0000-0000-000000000001', 'delegate'),
          (gen_random_uuid(), 'c1000000-0000-0000-0000-000000000002', 'p1000000-0000-0000-0000-000000000001', 'coach');
      `);
    });

    expect(() => desplegar(GUARDS)).toThrow(/personal a más de un club/i);
  }, 300_000);

  it("se detiene si una cuenta no se llama como su titular", async () => {
    await baseEnLaAnterior(async (c) => {
      await c.query(`
        INSERT INTO users (id, username, password_hash, must_change_password, status, owner_type, person_id, updated_at)
        VALUES (gen_random_uuid(), 'nombre_distinto', 'x', false, 'active', 'person', 'p1000000-0000-0000-0000-000000000001', now());
      `);
    });

    expect(() => desplegar(GUARDS)).toThrow(/no es el de su titular/i);
  }, 300_000);

  it("se detiene si el registro de nombres no describe a los titulares reales", async () => {
    await baseEnLaAnterior(async (c) => {
      // Se corrompe la reserva a mano: apunta a un titular que no es el suyo.
      // Es lo que dejaría un cambio de dueño hecho antes de que la propiedad
      // quedara congelada — y ya no se podría arreglar después.
      await c.query(
        `UPDATE username_reservations SET owner_id = 'p1000000-0000-0000-0000-000000000002' WHERE username = 'ana'`
      );
    });

    expect(() => desplegar(GUARDS)).toThrow(/no coincide con sus titulares/i);
  }, 300_000);

  it("se detiene si quedan reservas sin ningún titular vigente", async () => {
    await baseEnLaAnterior(async (c) => {
      await c.query(
        `INSERT INTO username_reservations (username, owner_kind, owner_id) VALUES ('fantasma', 'person', gen_random_uuid())`
      );
    });

    expect(() => desplegar(GUARDS)).toThrow(/sin ningún titular vigente/i);
  }, 300_000);

  it("con el estado ya correcto, la migración se aplica y las garantías quedan activas", async () => {
    await baseEnLaAnterior(async (c) => {
      await c.query(`
        INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES
          (gen_random_uuid(), 'c1000000-0000-0000-0000-000000000001', 'p1000000-0000-0000-0000-000000000001', 'legal_representative'),
          (gen_random_uuid(), 'c1000000-0000-0000-0000-000000000002', 'p1000000-0000-0000-0000-000000000002', 'delegate');
        INSERT INTO users (id, username, password_hash, must_change_password, status, owner_type, person_id, updated_at)
        VALUES (gen_random_uuid(), 'ana', 'x', false, 'active', 'person', 'p1000000-0000-0000-0000-000000000001', now());
      `);
    });

    expect(() => desplegar(GUARDS)).not.toThrow();

    await conCliente(dbUrl, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'club_staff_unique_legal_representative'`
      );
      expect(rows[0].n).toBe(1);

      // Y desde ahora la regla rige.
      await expect(
        c.query(
          `INSERT INTO club_staff (id, club_id, person_id, role_type)
           VALUES (gen_random_uuid(), 'c1000000-0000-0000-0000-000000000002', 'p1000000-0000-0000-0000-000000000001', 'coach')`
        )
      ).rejects.toThrow(/un club a la vez/i);
    });
  }, 300_000);
});


/**
 * Matriz completa de aplicabilidad: historial de migraciones × catálogo.
 *
 * Mirar solo si la tabla existe colapsa estados opuestos. El peor es una
 * ejecución FALLIDA —Prisma deja la fila con `finished_at` y `rolled_back_at`
 * nulos—, que un booleano "aplicada / no aplicada" clasificaba como "no
 * aplicada", es decir, del lado que NO bloquea. Justo al revés de lo que
 * corresponde: una migración a medias es el peor momento para migrar encima.
 */
describe("preflight — matriz historial × catálogo", () => {
  const CHECK = CHECKS.find((c) => c.id === "reservas-de-username-incoherentes")!;
  const MIGRACION = CHECK.requires!.migration;
  const TABLA = CHECK.requires!.table;

  function correrPreflight(): { code: number; output: string } {
    try {
      const output = execFileSync("npx", ["tsx", "scripts/preflight-migration.ts"], {
        cwd: BACKEND_DIR,
        env: { ...process.env, DATABASE_URL: dbUrl },
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      return { code: 0, output };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  /** Base nueva desplegada hasta la migración indicada. */
  async function baseHasta(migracion: string) {
    await conCliente(adminUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
      await c.query(`CREATE DATABASE "${DB}"`);
    });
    desplegar(migracion);
  }

  /** Marca la fila de la migración como una ejecución que quedó a medias. */
  async function marcarFallida() {
    await conCliente(dbUrl, (c) =>
      c.query(`UPDATE _prisma_migrations SET finished_at = NULL, rolled_back_at = NULL WHERE migration_name = $1`, [MIGRACION])
    );
  }

  it("aplicada + tabla presente -> se ejecuta", async () => {
    await baseHasta(ANTERIOR);

    const { code, output } = correrPreflight();

    expect(output).toContain(`OK ${CHECK.title}`);
    expect(code).toBe(0);
  }, 300_000);

  it("aplicada + tabla AUSENTE -> SIN VERIFICAR y bloquea", async () => {
    await baseHasta(ANTERIOR);
    await conCliente(dbUrl, (c) => c.query(`DROP TABLE ${TABLA} CASCADE`));

    const { code, output } = correrPreflight();

    expect(output).toContain(`SIN VERIFICAR ${CHECK.title}`);
    expect(output).toContain("figura aplicada");
    expect(code).toBe(1);
  }, 300_000);

  it("migración AUSENTE + tabla ausente -> NO APLICA y no bloquea", async () => {
    await baseHasta("20260905020000_phase2_block_date_reassignment");

    const { code, output } = correrPreflight();

    expect(output).toContain(`NO APLICA ${CHECK.title}`);
    expect(output).toContain("no figura en el historial");
    expect(code).toBe(0);
  }, 300_000);

  it("migración AUSENTE + tabla PRESENTE -> SIN VERIFICAR y bloquea", async () => {
    await baseHasta(ANTERIOR);
    // La tabla queda, pero el historial deja de respaldarla: es lo que produce
    // una restauración que mezcla dos momentos distintos.
    await conCliente(dbUrl, (c) => c.query(`DELETE FROM _prisma_migrations WHERE migration_name = $1`, [MIGRACION]));

    const { code, output } = correrPreflight();

    expect(output).toContain(`SIN VERIFICAR ${CHECK.title}`);
    expect(output).toContain("el historial no respalda lo que hay en la base");
    expect(code).toBe(1);
  }, 300_000);

  it("migración REVERTIDA + tabla ausente -> NO APLICA y no bloquea", async () => {
    await baseHasta(ANTERIOR);
    await conCliente(dbUrl, async (c) => {
      await c.query(`DROP TABLE ${TABLA} CASCADE`);
      await c.query(`UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = $1`, [MIGRACION]);
    });

    const { code, output } = correrPreflight();

    expect(output).toContain(`NO APLICA ${CHECK.title}`);
    expect(output).toContain("figura REVERTIDA");
    expect(code, "revertir a conciencia y limpiar la tabla es un estado coherente").toBe(0);
  }, 300_000);

  it("migración REVERTIDA + tabla PRESENTE -> SIN VERIFICAR y bloquea", async () => {
    await baseHasta(ANTERIOR);
    await conCliente(dbUrl, (c) =>
      c.query(`UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = $1`, [MIGRACION])
    );

    const { code, output } = correrPreflight();

    expect(output).toContain(`SIN VERIFICAR ${CHECK.title}`);
    expect(output).toContain("figura REVERTIDA");
    expect(code).toBe(1);
  }, 300_000);

  it("migración FALLIDA + tabla ausente -> SIN VERIFICAR y bloquea", async () => {
    await baseHasta(ANTERIOR);
    await conCliente(dbUrl, (c) => c.query(`DROP TABLE ${TABLA} CASCADE`));
    await marcarFallida();

    const { code, output } = correrPreflight();

    expect(output).toContain(`SIN VERIFICAR ${CHECK.title}`);
    expect(output).toContain("EJECUCIÓN FALLIDA");
    expect(output).toContain("no existe");
    expect(code, "una migración a medias NO puede tratarse como no aplicada").toBe(1);
  }, 300_000);

  it("migración FALLIDA + tabla presente (parcial) -> SIN VERIFICAR y bloquea", async () => {
    await baseHasta(ANTERIOR);
    // Tabla presente pero incompleta: se le quita el disparador que la
    // mantiene, que es lo que dejaría una migración cortada a mitad.
    await conCliente(dbUrl, (c) => c.query(`DROP TRIGGER persons_username_registry ON persons`));
    await marcarFallida();

    const { code, output } = correrPreflight();

    expect(output).toContain(`SIN VERIFICAR ${CHECK.title}`);
    expect(output).toContain("EJECUCIÓN FALLIDA");
    expect(output).toContain("puede estar incompleta");
    expect(code).toBe(1);
  }, 300_000);

  /**
   * Prisma inserta una fila por INTENTO, así que un mismo nombre de migración
   * puede tener varias. Lo que decide no es cuántas hay, sino si alguna quedó
   * SIN RESOLVER.
   */
  it("fallo RESUELTO como revertido y DESPUÉS reintento aplicado -> se ejecuta", async () => {
    await baseHasta(ANTERIOR);

    /**
     * La cronología importa para que el caso represente lo que dice: primero
     * el intento que falló y se resolvió con `migrate resolve --rolled-back`,
     * después el reintento bueno. Como el despliegue ya dejó la fila aplicada,
     * la revertida se inserta FECHADA ANTES que ella en vez de con `now()`.
     *
     * (`estadoDeMigracion` cuenta estados y no los ordena, así que el
     * resultado sería el mismo al revés; la cronología está aquí para que el
     * escenario sea realista, no porque el algoritmo dependa de ella.)
     */
    await conCliente(dbUrl, (c) =>
      c.query(
        `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, rolled_back_at, applied_steps_count)
         SELECT gen_random_uuid()::text, 'x', $1::text,
                aplicada.started_at - interval '2 minutes',
                aplicada.started_at - interval '1 minute',
                0
           FROM _prisma_migrations aplicada
          WHERE aplicada.migration_name = $1::text AND aplicada.finished_at IS NOT NULL
          LIMIT 1`,
        [MIGRACION]
      )
    );

    // Se comprueba la cronología construida antes de evaluar nada.
    const { rows } = await conCliente(dbUrl, (c) =>
      c.query<{ revertida_primero: boolean }>(
        `SELECT (SELECT min(started_at) FROM _prisma_migrations WHERE migration_name = $1::text AND rolled_back_at IS NOT NULL)
              < (SELECT min(started_at) FROM _prisma_migrations WHERE migration_name = $1::text AND finished_at IS NOT NULL)
                AS revertida_primero`,
        [MIGRACION]
      )
    );
    expect(rows[0]!.revertida_primero, "el intento revertido debe preceder al aplicado").toBe(true);

    const { code, output } = correrPreflight();

    expect(output, "un fallo ya resuelto no debe seguir bloqueando").toContain(`OK ${CHECK.title}`);
    expect(code).toBe(0);
  }, 300_000);

  it("fila aplicada + fallo ACTIVO sin resolver -> SIN VERIFICAR y bloquea", async () => {
    await baseHasta(ANTERIOR);
    /**
     * Escenario del defecto: la fila aplicada existía y ocultaba a la otra.
     * Un intento sin `finished_at` ni `rolled_back_at` es justo lo que hace
     * que Prisma se niegue a seguir con P3009, así que aprobar la base porque
     * hay OTRA fila correcta describiría una base sobre la que
     * `migrate deploy` no puede avanzar.
     */
    await conCliente(dbUrl, (c) =>
      c.query(
        `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count)
         VALUES (gen_random_uuid()::text, 'x', $1, now(), 0)`,
        [MIGRACION]
      )
    );

    const { code, output } = correrPreflight();

    expect(output).toContain(`SIN VERIFICAR ${CHECK.title}`);
    expect(output, "el motivo debe nombrar la ejecución fallida").toContain("EJECUCIÓN FALLIDA");
    expect(output).not.toContain(`OK ${CHECK.title}`);
    expect(code, "un fallo sin resolver bloquea aunque haya un intento aplicado").toBe(1);
  }, 300_000);
});
