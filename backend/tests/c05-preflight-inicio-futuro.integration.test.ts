/**
 * C-05: comprobación previa `membresias-activas-con-inicio-futuro` (scripts/migrationChecks.ts),
 * ejecutada en PostgreSQL real (base desechable), con los DOS tipos que ha tenido `start_date`:
 *
 *  - DATE (desde 20261031000000_fecha_efectiva_membresia): fecha de calendario tal cual;
 *  - TIMESTAMP(3) con el instante en UTC (bases anteriores): se convierte a la fecha de Santiago.
 *
 * SOLO LECTURA sobre las tablas reales: cada caso crea una tabla TEMPORAL `club_swimmers` que solo
 * existe en su sesión y tapa a la real (`pg_temp` se busca primero). El instante «actual» se fija
 * sustituyendo el ÚNICO `now()` de la consulta por un parámetro, para probar cambios de mes y año.
 * Cada escenario se repite con varios `DateStyle` y `TimeZone` de sesión: el resultado no puede
 * cambiar. Los casos detectan falsos positivos (hoy o pasado marcados como futuros) y falsos
 * negativos (futuros que no se marcan). Datos sintéticos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { CHECKS } from "../scripts/migrationChecks";

const check = CHECKS.find((c) => c.id === "membresias-activas-con-inicio-futuro")!;

/** La consulta real, con su único `now()` reemplazado por un instante fijo (`$1`). */
function consultaConInstante(): string {
  expect(check.query.match(/now\(\)/g), "la consulta debe usar now() exactamente una vez").toHaveLength(1);
  return check.query.replace("now()", "$1::timestamptz");
}

const SESIONES = [
  { dateStyle: "ISO, MDY", timeZone: "UTC" },
  { dateStyle: "SQL, DMY", timeZone: "America/Santiago" },
  { dateStyle: "German", timeZone: "Asia/Tokyo" },
  { dateStyle: "Postgres, YMD", timeZone: "Pacific/Kiritimati" },
  { dateStyle: "SQL, MDY", timeZone: "America/Los_Angeles" },
] as const;

/**
 * Instantes «actuales» y el día de Santiago que les corresponde. Santiago está en UTC-4 desde el
 * 5-abr-2026 y en UTC-3 desde el 6-sep-2026.
 */
const INSTANTES = {
  finDeAbril: "2026-04-30T23:30:00-04:00", // hoy = 2026-04-30; en UTC ya es 1-may
  finDeAbrilUltimoSegundo: "2026-05-01T03:59:59Z", // hoy = 2026-04-30 23:59:59 en Santiago
  finDeAnio: "2026-12-31T23:30:00-03:00", // hoy = 2026-12-31; en UTC ya es 2027
  inicioDeAnio: "2027-01-01T03:30:00Z", // hoy = 2027-01-01 00:30 en Santiago
} as const;

let pg: Client;

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
});

afterAll(async () => {
  await pg?.end();
});

/** Crea la tabla temporal con el tipo indicado y sus filas, y devuelve los ids marcados por sesión. */
async function marcados(tipo: "date" | "timestamp(3)", filas: [string, string, string | null][], instante: string) {
  await pg.query("DROP TABLE IF EXISTS pg_temp.club_swimmers");
  await pg.query(`CREATE TEMP TABLE club_swimmers (id text, club_id text, person_id text, status text, start_date ${tipo})`);
  for (const [id, estado, inicio] of filas) {
    await pg.query("INSERT INTO pg_temp.club_swimmers VALUES ($1, 'club-sintetico', 'persona-sintetica', $2, $3)", [id, estado, inicio]);
  }
  const consulta = consultaConInstante();
  const resultados: string[][] = [];
  for (const sesion of SESIONES) {
    await pg.query(`SET DateStyle = '${sesion.dateStyle}'`);
    await pg.query(`SET TimeZone = '${sesion.timeZone}'`);
    const r = await pg.query<{ id: string; club_id: string; person_id: string }>(consulta, [instante]);
    // Solo identificadores.
    for (const f of r.rows) expect(Object.keys(f).sort()).toEqual(["club_id", "id", "person_id"]);
    resultados.push(r.rows.map((f) => f.id).sort());
  }
  await pg.query("RESET DateStyle");
  await pg.query("RESET TimeZone");
  await pg.query("DROP TABLE IF EXISTS pg_temp.club_swimmers");
  // Mismo resultado con todas las configuraciones de sesión.
  for (const r of resultados) expect(r, "el resultado no depende de DateStyle ni de TimeZone").toEqual(resultados[0]);
  return resultados[0]!;
}

describe("start_date DATE (versión actual)", () => {
  const FILAS: [string, string, string | null][] = [
    ["d-abr29", "active", "2026-04-29"],
    ["d-abr30", "active", "2026-04-30"],
    ["d-may01", "active", "2026-05-01"],
    ["d-dic30", "active", "2026-12-30"],
    ["d-dic31", "active", "2026-12-31"],
    ["d-ene01", "active", "2027-01-01"],
    ["d-pendiente-futura", "pending", "2027-06-01"],
    ["d-activa-sin-inicio", "active", null],
  ];

  it.each([
    ["fin de abril (cambio de mes)", INSTANTES.finDeAbril, ["d-dic30", "d-dic31", "d-ene01", "d-may01"]],
    ["último segundo de abril en Santiago (en UTC ya es mayo)", INSTANTES.finDeAbrilUltimoSegundo, ["d-dic30", "d-dic31", "d-ene01", "d-may01"]],
    ["31 de diciembre (cambio de año; en UTC ya es 2027)", INSTANTES.finDeAnio, ["d-ene01"]],
    ["1 de enero en Santiago", INSTANTES.inicioDeAnio, []],
  ])("%s", async (_caso, instante, esperados) => {
    expect(await marcados("date", FILAS, instante)).toEqual([...esperados].sort());
  });
});

describe("start_date TIMESTAMP(3) en UTC (versión anterior a 20261031000000)", () => {
  // Cada instante UTC representa un día de Santiago (comentado). Su fecha «ingenua» en UTC difiere
  // del día de Santiago justo en los casos que detectarían una conversión equivocada.
  const FILAS: [string, string, string | null][] = [
    ["t-abr30-mediodia", "active", "2026-04-30 12:00:00"], // Santiago 30-abr 08:00
    ["t-abr30-noche", "active", "2026-05-01 03:30:00"], // Santiago 30-abr 23:30 (UTC ya 1-may)
    ["t-may01-madrugada", "active", "2026-05-01 04:30:00"], // Santiago 1-may 00:30
    ["t-dic31-noche", "active", "2027-01-01 02:00:00"], // Santiago 31-dic 23:00 (UTC ya 2027)
    ["t-ene01-madrugada", "active", "2027-01-01 03:30:00"], // Santiago 1-ene 00:30
    ["t-pendiente-futura", "pending", "2027-06-01 12:00:00"],
    ["t-activa-sin-inicio", "active", null],
  ];

  it.each([
    ["fin de abril (cambio de mes)", INSTANTES.finDeAbril, ["t-dic31-noche", "t-ene01-madrugada", "t-may01-madrugada"]],
    ["último segundo de abril en Santiago", INSTANTES.finDeAbrilUltimoSegundo, ["t-dic31-noche", "t-ene01-madrugada", "t-may01-madrugada"]],
    ["31 de diciembre (cambio de año)", INSTANTES.finDeAnio, ["t-ene01-madrugada"]],
    ["1 de enero en Santiago", INSTANTES.inicioDeAnio, []],
  ])("%s", async (_caso, instante, esperados) => {
    expect(await marcados("timestamp(3)", FILAS, instante)).toEqual([...esperados].sort());
  });
});

describe("la consulta real", () => {
  it("es de solo lectura y devuelve solo identificadores", () => {
    expect(check.query).toMatch(/^\s*SELECT cs\.id, cs\.club_id, cs\.person_id\s/);
    expect(check.query).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i);
    // Compara valores DATE: la fecha no se convierte a texto (dependería de DateStyle).
    expect(check.query).not.toMatch(/start_date::text|::date::text/);
  });
});
