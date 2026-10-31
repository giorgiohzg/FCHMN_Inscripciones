/**
 * Las dos migraciones del 2026-10-31, probadas CONTRA DATOS QUE YA EXISTEN.
 *
 * Aplicarlas sobre una base vacía no demuestra nada: lo que puede salir mal es
 * la conversión de `start_date` de `TIMESTAMP` a `DATE`, y eso solo se ve con
 * instantes reales — en particular los que caen junto a la medianoche chilena y
 * los que están a un lado y al otro del horario de verano.
 *
 * El procedimiento es el de `migration-upgrade.integration.test.ts`:
 *
 *   1. Una base aparte con TODAS las migraciones anteriores a estas dos.
 *   2. Se puebla con membresías cuyas marcas de tiempo son los casos límite.
 *   3. Se aplican las dos migraciones nuevas.
 *   4. Se comprueba qué quedó guardado, dato por dato.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";

const BACKEND_DIR = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(BACKEND_DIR, "prisma", "migrations");

/** Las dos migraciones que esta prueba ejercita, en orden. */
const MIGRACIONES_NUEVAS = ["20261031000000_fecha_efectiva_membresia", "20261031000100_personalidad_juridica_pendiente"];
const FRONTERA = MIGRACIONES_NUEVAS[0]!;

const DB_PRUEBA = "natacion_migra_fechas_test";

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
    .filter((d) => d.isDirectory() && d.name < FRONTERA)
    .map((d) => d.name)
    .sort();

/**
 * Los casos límite. Cada uno es un instante UTC y el día CHILENO que le
 * corresponde, calculado a mano a partir del desplazamiento vigente en esa
 * fecha: UTC-3 en verano austral, UTC-4 en invierno.
 */
const CASOS: { id: string; instante: string; diaChileno: string; porQue: string }[] = [
  {
    id: "c1-noche-del-ensayo",
    instante: "2026-10-31T02:58:24.031Z",
    diaChileno: "2026-10-30",
    porQue: "el instante real del ensayo: en Chile eran las 23:58 del 30, y la base guardaba el 31",
  },
  {
    id: "c2-un-ms-antes-de-medianoche",
    instante: "2026-10-31T02:59:59.999Z",
    diaChileno: "2026-10-30",
    porQue: "el último milisegundo del día chileno",
  },
  {
    id: "c3-medianoche-chilena-exacta",
    instante: "2026-10-31T03:00:00.000Z",
    diaChileno: "2026-10-31",
    porQue: "la medianoche chilena: aquí sí cambia el día",
  },
  {
    id: "c4-mediodia",
    instante: "2026-10-30T14:00:00.000Z",
    diaChileno: "2026-10-30",
    porQue: "un instante sin ambigüedad, de control",
  },
  {
    id: "c5-invierno-austral",
    instante: "2026-07-15T03:30:00.000Z",
    diaChileno: "2026-07-14",
    porQue: "invierno: Chile en UTC-4, así que son las 23:30 del día anterior. Con un -3 fijo daría el 15",
  },
  {
    id: "c6-verano-austral",
    instante: "2026-01-15T03:30:00.000Z",
    diaChileno: "2026-01-15",
    porQue: "verano: Chile en UTC-3, el MISMO reloj UTC cae en el día siguiente. Con un -4 fijo daría el 14",
  },
];

const ID_SIN_REVISION = "c7-sin-reviewed-at";
const ID_SIN_FECHA = "c8-sin-start-date";
const ID_CON_REVISION_PROPIA = "c9-reviewed-at-propio";
const INSTANTE_REVISION_PROPIA = "2026-05-05T10:00:00.000Z";

const CLUB_CON_PJ = "cl-con-pj";
const CLUB_SIN_PJ = "cl-sin-pj";

async function poblar(c: Client) {
  await c.query(`
    INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, rut, updated_at) VALUES
      ('${CLUB_CON_PJ}', 'Club Con Personalidad', 'club_con_pj', 'CCP', 'con@example.invalid', 'active', true,  '111111111', now()),
      ('${CLUB_SIN_PJ}', 'Club Sin Personalidad', 'club_sin_pj', 'CSP', 'sin@example.invalid', 'active', false, NULL, now());
  `);

  const filas = [...CASOS.map((x) => x.id), ID_SIN_REVISION, ID_SIN_FECHA, ID_CON_REVISION_PROPIA];
  // Una persona por fila: el índice único parcial sobre
  // `club_swimmers(person_id) WHERE status='active'` no admite dos activas de
  // la misma persona, y usar personas distintas evita razonar sobre eso.
  for (let i = 0; i < filas.length; i++) {
    await c.query(
      `INSERT INTO persons (id, run, username, full_name, birth_date, gender, status, updated_at)
       VALUES ($1, $2, $3, $4, '1985-04-04', 'female', 'active', now())`,
      [`per-${i}`, `1000000${i}`, `persona${i}`, `Persona ${i}`]
    );
  }

  for (let i = 0; i < CASOS.length; i++) {
    const caso = CASOS[i]!;
    await c.query(
      `INSERT INTO club_swimmers (id, club_id, person_id, status, requested_by_user_id, reviewed_at, start_date, updated_at)
       VALUES ($1, $2, $3, 'active', 'usuario-de-prueba', $4::timestamptz, $4::timestamptz, now())`,
      [caso.id, CLUB_CON_PJ, `per-${i}`, caso.instante]
    );
  }

  // Marca de auditoría ausente: la migración tiene que RECUPERARLA desde
  // `start_date` antes de descartar la hora.
  await c.query(
    `INSERT INTO club_swimmers (id, club_id, person_id, status, requested_by_user_id, reviewed_at, start_date, updated_at)
     VALUES ($1, $2, $3, 'active', 'usuario-de-prueba', NULL, $4::timestamptz, now())`,
    [ID_SIN_REVISION, CLUB_CON_PJ, `per-${CASOS.length}`, "2026-10-31T02:58:24.031Z"]
  );

  // Sin fecha de inicio: debe quedarse en NULL.
  await c.query(
    `INSERT INTO club_swimmers (id, club_id, person_id, status, requested_by_user_id, reviewed_at, start_date, updated_at)
     VALUES ($1, $2, $3, 'pending', 'usuario-de-prueba', NULL, NULL, now())`,
    [ID_SIN_FECHA, CLUB_CON_PJ, `per-${CASOS.length + 1}`]
  );

  // `reviewed_at` propio y DISTINTO de `start_date`: no se puede sobrescribir.
  await c.query(
    `INSERT INTO club_swimmers (id, club_id, person_id, status, requested_by_user_id, reviewed_at, start_date, updated_at)
     VALUES ($1, $2, $3, 'active', 'usuario-de-prueba', $4::timestamptz, $5::timestamptz, now())`,
    [ID_CON_REVISION_PROPIA, CLUB_CON_PJ, `per-${CASOS.length + 2}`, INSTANTE_REVISION_PROPIA, "2026-10-30T14:00:00.000Z"]
  );
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL (use .env.test)");
  adminUrl = urlConBase("postgres");
  dbUrl = urlConBase(DB_PRUEBA);

  workDir = mkdtempSync(join(tmpdir(), "migra-fechas-"));
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

describe("antes de migrar: el defecto está presente", () => {
  it("start_date es un TIMESTAMP y guarda el instante, no el día chileno", async () => {
    const tipo = await conCliente(dbUrl, (c) =>
      c.query(`SELECT data_type FROM information_schema.columns WHERE table_name='club_swimmers' AND column_name='start_date'`)
    );
    expect(tipo.rows[0].data_type).toBe("timestamp without time zone");

    const r = await conCliente(dbUrl, (c) => c.query(`SELECT start_date::text AS v FROM club_swimmers WHERE id='c1-noche-del-ensayo'`));
    // Lo que la base decía: el 31. En Chile era el 30.
    expect(r.rows[0].v.slice(0, 10)).toBe("2026-10-31");
  });

  it("has_legal_status no admite NULL", async () => {
    await expect(
      conCliente(dbUrl, (c) => c.query(`UPDATE clubs SET has_legal_status = NULL WHERE id='${CLUB_SIN_PJ}'`))
    ).rejects.toThrow(/null/i);
  });
});

describe("después de migrar", () => {
  beforeAll(() => {
    desplegar([...anteriores(), ...MIGRACIONES_NUEVAS], dbUrl);
  }, 180_000);

  it("start_date pasó a ser una fecha de calendario", async () => {
    const r = await conCliente(dbUrl, (c) =>
      c.query(`SELECT data_type FROM information_schema.columns WHERE table_name='club_swimmers' AND column_name='start_date'`)
    );
    expect(r.rows[0].data_type).toBe("date");
  });

  it.each(CASOS)("$id queda en $diaChileno — $porQue", async ({ id, diaChileno }) => {
    const r = await conCliente(dbUrl, (c) => c.query(`SELECT start_date::text AS v FROM club_swimmers WHERE id=$1`, [id]));
    expect(r.rows[0].v).toBe(diaChileno);
  });

  it("recupera la marca de auditoría ausente antes de descartar la hora", async () => {
    const r = await conCliente(dbUrl, (c) =>
      c.query(`SELECT reviewed_at AT TIME ZONE 'UTC' AS v, start_date::text AS f FROM club_swimmers WHERE id=$1`, [ID_SIN_REVISION])
    );
    // El instante completo sobrevive en `reviewed_at`...
    expect(new Date(`${r.rows[0].v.toISOString().slice(0, 23)}Z`).toISOString()).toBe("2026-10-31T02:58:24.031Z");
    // ...y la fecha efectiva es el día chileno.
    expect(r.rows[0].f).toBe("2026-10-30");
  });

  it("NO sobrescribe una marca de auditoría que ya existía", async () => {
    const r = await conCliente(dbUrl, (c) =>
      c.query(`SELECT reviewed_at AT TIME ZONE 'UTC' AS v FROM club_swimmers WHERE id=$1`, [ID_CON_REVISION_PROPIA])
    );
    expect(r.rows[0].v.toISOString().slice(0, 19)).toBe(INSTANTE_REVISION_PROPIA.slice(0, 19));
  });

  it("deja en NULL lo que estaba en NULL", async () => {
    const r = await conCliente(dbUrl, (c) => c.query(`SELECT start_date, reviewed_at FROM club_swimmers WHERE id=$1`, [ID_SIN_FECHA]));
    expect(r.rows[0].start_date).toBeNull();
    expect(r.rows[0].reviewed_at).toBeNull();
  });

  it("no pierde ni inventa filas", async () => {
    const r = await conCliente(dbUrl, (c) => c.query(`SELECT count(*)::int AS n FROM club_swimmers`));
    expect(r.rows[0].n).toBe(CASOS.length + 3);
  });

  it("has_legal_status conserva los valores existentes: NINGUNO se convirtió en NULL", async () => {
    const r = await conCliente(dbUrl, (c) => c.query(`SELECT id, has_legal_status FROM clubs ORDER BY id`));
    const porId = Object.fromEntries(r.rows.map((x: { id: string; has_legal_status: boolean | null }) => [x.id, x.has_legal_status]));
    expect(porId[CLUB_CON_PJ]).toBe(true);
    expect(porId[CLUB_SIN_PJ]).toBe(false);
    const nulos = await conCliente(dbUrl, (c) => c.query(`SELECT count(*)::int AS n FROM clubs WHERE has_legal_status IS NULL`));
    expect(nulos.rows[0].n).toBe(0);
  });

  it("has_legal_status ya admite NULL: es el estado «pendiente de verificar»", async () => {
    await conCliente(dbUrl, async (c) => {
      await c.query(`UPDATE clubs SET has_legal_status = NULL WHERE id=$1`, [CLUB_SIN_PJ]);
      const r = await c.query(`SELECT has_legal_status FROM clubs WHERE id=$1`, [CLUB_SIN_PJ]);
      expect(r.rows[0].has_legal_status).toBeNull();
      await c.query(`UPDATE clubs SET has_legal_status = false WHERE id=$1`, [CLUB_SIN_PJ]);
    });
  });

  it("se retiró el valor por omisión: omitir la columna deja «pendiente», no «no tiene»", async () => {
    await conCliente(dbUrl, async (c) => {
      await c.query(
        `INSERT INTO clubs (id, name, username, code, email, status, updated_at)
         VALUES ('cl-omitido', 'Club Omitido', 'club_omitido', 'COM', 'om@example.invalid', 'active', now())`
      );
      const r = await c.query(`SELECT has_legal_status FROM clubs WHERE id='cl-omitido'`);
      expect(r.rows[0].has_legal_status).toBeNull();
    });
  });
});
