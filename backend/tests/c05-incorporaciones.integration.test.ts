/**
 * C-05, fase 1: la migración `20261112000000_c05_incorporaciones` y sus restricciones,
 * EJERCITADAS en PostgreSQL (base desechable), no inspeccionadas como texto.
 *
 *   1. Aplicación limpia: el setup global aplica TODAS las migraciones, C-05 incluida, sobre
 *      la base vacía de pruebas. Aquí se comprueba el historial y el catálogo resultante.
 *   2. Restricciones reales: cada CHECK, índice único parcial, exclusión y clave foránea se
 *      prueba con una fila que la viola (y con su caso válido límite).
 *   3. Lo que la base NO impone: se demuestra con filas que la base ACEPTA aunque el servicio
 *      deberá rechazarlas (coherencia de club entre referencias, cuota de 30, token de T2).
 *   4. Compatibilidad: las operaciones actuales de asignación, con el servicio real.
 *   5. Actualización desde las 39 migraciones anteriores, en una base auxiliar de nombre único:
 *      datos conservados, `fecha_termino` nula, guarda de duplicados (preflight y SQL), fallo
 *      inyectado al final de la migración y la recuperación que requiere cada caso.
 *
 * Todos los datos son SINTÉTICOS.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, createClub, createPerson } from "./helpers/seedRbac";
import * as assignmentService from "../src/modules/swimmer-assignment/assignment.service";
import * as postulacion from "../src/modules/incorporaciones/postulacion.service";
import { runValido } from "./helpers/run";
import { AppError } from "../src/shared/errors";
import { translatePrismaError } from "../src/shared/prismaErrors";
import { CHECKS } from "../scripts/migrationChecks";

const BACKEND_DIR = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(BACKEND_DIR, "prisma", "migrations");
const C05 = "20261112000000_c05_incorporaciones";

const TABLAS_C05 = ["periodos_cambio_club", "intentos_incorporacion", "solicitudes_alta_incorporacion"];
const ENUMS_C05 = ["EstadoIntentoIncorporacion", "EstadoSolicitudAlta"];
const RESTRICCIONES_C05 = [
  "club_swimmers_fecha_termino_solo_finalizada_check",
  "club_swimmers_fecha_termino_no_antes_del_inicio_check",
  "periodos_cambio_club_fechas_check",
  "periodos_cambio_club_cierre_check",
  "periodos_cambio_club_sin_solape_excl",
  "periodos_cambio_club_motivo_check",
  "intentos_incorporacion_clave_check",
  "intentos_incorporacion_huellas_check",
  "intentos_incorporacion_resolucion_check",
  "intentos_incorporacion_run_temporal_check",
  "intentos_incorporacion_run_formato_check",
  "intentos_incorporacion_expira_check",
  "intentos_incorporacion_consumo_check",
  "intentos_incorporacion_propuesta_check",
  "solicitudes_alta_run_formato_check",
  "solicitudes_alta_nombres_check",
  "solicitudes_alta_revision_check",
  "solicitudes_alta_resolucion_check",
  "solicitudes_alta_motivo_check",
  "solicitudes_alta_pese_a_eliminada_check",
];
const INDICES_C05 = [
  "club_swimmers_unique_pending_club_person",
  "solicitudes_alta_unique_pendiente_club_run",
  "intentos_incorporacion_club_id_user_id_clave_idempotencia_key",
  "intentos_incorporacion_propuesta_id_key",
  "intentos_incorporacion_club_id_dia_idx",
  "intentos_incorporacion_en_curso_idx",
  "intentos_incorporacion_run_temporal_idx",
  "solicitudes_alta_incorporacion_intento_id_key",
  "solicitudes_alta_incorporacion_membresia_id_key",
];

const H32 = Buffer.alloc(32, 0xab);
const H31 = Buffer.alloc(31, 0xab);

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function conCliente<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function urlConBase(database: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

/** El error de PostgreSQL de una sentencia que DEBE fallar: su código y la restricción. */
async function fallo(p: Promise<unknown>): Promise<{ code: string; constraint?: string; message: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint?: string; message: string };
    return { code: e.code ?? "?", constraint: e.constraint, message: e.message };
  }
  throw new Error("La sentencia se aceptó y debía ser rechazada por la base");
}

function insertar(c: Client, tabla: string, fila: Record<string, unknown>) {
  const cols = Object.keys(fila);
  const sql = `INSERT INTO "${tabla}" (${cols.map((x) => `"${x}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`;
  return c.query(sql, Object.values(fila));
}

// ---------------------------------------------------------------------------
// 1–4. Base de pruebas con todas las migraciones (C-05 incluida)
// ---------------------------------------------------------------------------

let pg: Client;
const ctx = {
  admin: "",
  usuarioClubA: "",
  usuarioClubB: "",
  clubA: "",
  clubB: "",
  personas: [] as string[],
};
let correlativo = 0;
const clave = () => `clave-${String(++correlativo).padStart(4, "0")}`;

const intento = (campos: Record<string, unknown> = {}) =>
  insertar(pg, "intentos_incorporacion", {
    id: randomUUID(),
    club_id: ctx.clubA,
    user_id: ctx.usuarioClubA,
    dia: "2026-11-12",
    clave_idempotencia: clave(),
    huella_contenido: H32,
    token_ejecucion: randomUUID(),
    ...campos,
  });

/** Un intento ya resuelto, que no exige ningún campo opcional. */
const intentoResuelto = (campos: Record<string, unknown> = {}) => intento({ estado: "duplicado", resuelto_en: new Date(), ...campos });

async function solicitud(campos: Record<string, unknown> = {}) {
  const intentoId = (campos.intento_id as string) ?? (await intentoResuelto()).rows[0].id;
  return insertar(pg, "solicitudes_alta_incorporacion", {
    id: randomUUID(),
    club_id: ctx.clubA,
    run_normalizado: "12345678K",
    nombres_declarados: "Nombre Sintético",
    apellidos_declarados: "Apellido Sintético",
    solicitado_por_user_id: ctx.usuarioClubA,
    ...campos,
    intento_id: intentoId,
  });
}

const membresia = (campos: Record<string, unknown> = {}) =>
  insertar(pg, "club_swimmers", {
    id: randomUUID(),
    club_id: ctx.clubA,
    person_id: ctx.personas[0],
    status: "pending",
    requested_by_user_id: ctx.usuarioClubA,
    updated_at: new Date(),
    ...campos,
  });

const periodo = (campos: Record<string, unknown> = {}) =>
  insertar(pg, "periodos_cambio_club", { id: randomUUID(), inicio: "2026-03-01", fin: "2026-03-31", creado_por_user_id: ctx.admin, ...campos });

beforeAll(async () => {
  await truncateAllTables(prisma as unknown as Parameters<typeof truncateAllTables>[0]);
  await seedRolesAndPermissions();
  ctx.admin = (await createUser({ username: "admin.c05", roleNames: ["admin"] })).id;
  ctx.clubA = (await createClub("Club Sintético A", "CSA", "club.sintetico.a")).id;
  ctx.clubB = (await createClub("Club Sintético B", "CSB", "club.sintetico.b")).id;
  ctx.usuarioClubA = (await createUser({ username: "club.sintetico.a", roleNames: ["club"], clubId: ctx.clubA })).id;
  ctx.usuarioClubB = (await createUser({ username: "club.sintetico.b", roleNames: ["club"], clubId: ctx.clubB })).id;
  for (let i = 0; i < 8; i++) {
    ctx.personas.push((await createPerson({ run: `3000000${i}`, username: `sintetica${i}`, firstName: `Sintetica${i}`, gender: "female" })).id);
  }
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
}, 120_000);

afterAll(async () => {
  await pg?.end();
  await prisma.$disconnect();
});

describe("1. aplicación limpia de todas las migraciones, C-05 incluida", () => {
  it("las 40 migraciones del repositorio constan aplicadas una vez, sin fallos ni reversiones", async () => {
    const enDisco = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(enDisco).toHaveLength(40);
    expect(enDisco.at(-1)).toBe(C05);

    const { rows } = await pg.query(
      `SELECT migration_name, finished_at IS NOT NULL AS terminada, rolled_back_at IS NOT NULL AS revertida FROM _prisma_migrations ORDER BY migration_name`
    );
    expect(rows.map((r) => r.migration_name)).toEqual(enDisco);
    expect(rows.every((r) => r.terminada && !r.revertida)).toBe(true);
  });

  it("crea las tres tablas, los dos enumerados, la columna nula y todas las restricciones e índices", async () => {
    for (const t of TABLAS_C05) {
      expect((await pg.query(`SELECT to_regclass('public.' || $1) IS NOT NULL AS ok`, [t])).rows[0].ok, t).toBe(true);
    }
    const enums = await pg.query(
      `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS valores
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = ANY($1) GROUP BY t.typname`,
      [ENUMS_C05]
    );
    expect(enums.rows.map((r) => r.typname).sort()).toEqual([...ENUMS_C05].sort());

    const col = await pg.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'club_swimmers' AND column_name = 'fecha_termino'`
    );
    expect(col.rows[0]).toEqual({ data_type: "date", is_nullable: "YES", column_default: null });

    const cons = await pg.query(`SELECT conname, contype FROM pg_constraint WHERE conname = ANY($1)`, [RESTRICCIONES_C05]);
    expect(cons.rows.map((r) => r.conname).sort()).toEqual([...RESTRICCIONES_C05].sort());
    expect(cons.rows.find((r) => r.conname === "periodos_cambio_club_sin_solape_excl")?.contype).toBe("x");

    const idx = await pg.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`, [INDICES_C05]);
    expect(idx.rows.map((r) => r.indexname).sort()).toEqual([...INDICES_C05].sort());
  });
});

describe("2. restricciones impuestas por PostgreSQL", () => {
  describe("club_swimmers: una propuesta pendiente por club y persona", () => {
    it("una segunda pendiente del mismo club y persona se rechaza; en otro club, o tras rechazar la primera, se admite", async () => {
      const p = ctx.personas[1];
      const primera = (await membresia({ person_id: p })).rows[0].id;
      const e = await fallo(membresia({ person_id: p }));
      expect(e).toMatchObject({ code: "23505", constraint: "club_swimmers_unique_pending_club_person" });

      await membresia({ person_id: p, club_id: ctx.clubB, requested_by_user_id: ctx.usuarioClubB });
      await pg.query(`UPDATE club_swimmers SET status = 'rejected', reviewed_at = now() WHERE id = $1`, [primera]);
      await membresia({ person_id: p });
    });
  });

  describe("club_swimmers.fecha_termino", () => {
    it("solo en una membresía finalizada: activa, pendiente o rechazada con fecha se rechazan", async () => {
      for (const status of ["active", "pending", "rejected"]) {
        const e = await fallo(membresia({ person_id: ctx.personas[2], status, start_date: "2026-01-01", fecha_termino: "2026-02-01" }));
        expect(e, status).toMatchObject({ code: "23514", constraint: "club_swimmers_fecha_termino_solo_finalizada_check" });
      }
    });

    it("nunca anterior al inicio; el mismo día del inicio sí; nula en una finalizada sí (término desconocido)", async () => {
      const e = await fallo(membresia({ person_id: ctx.personas[2], status: "ended", start_date: "2026-05-10", fecha_termino: "2026-05-09" }));
      expect(e).toMatchObject({ code: "23514", constraint: "club_swimmers_fecha_termino_no_antes_del_inicio_check" });
      await membresia({ person_id: ctx.personas[2], status: "ended", start_date: "2026-05-10", fecha_termino: "2026-05-10" });
      await membresia({ person_id: ctx.personas[2], status: "ended", start_date: "2026-05-10", fecha_termino: null });
    });

    it("reactivar una finalizada que conserva su fecha de término se rechaza", async () => {
      const id = (await membresia({ person_id: ctx.personas[3], status: "ended", start_date: "2026-01-01", fecha_termino: "2026-06-30" })).rows[0].id;
      const e = await fallo(pg.query(`UPDATE club_swimmers SET status = 'active' WHERE id = $1`, [id]));
      expect(e).toMatchObject({ code: "23514", constraint: "club_swimmers_fecha_termino_solo_finalizada_check" });
    });
  });

  describe("periodos_cambio_club", () => {
    it("fin anterior al inicio se rechaza; un periodo de un solo día se admite", async () => {
      const e = await fallo(periodo({ inicio: "2027-01-10", fin: "2027-01-09" }));
      expect(e).toMatchObject({ code: "23514", constraint: "periodos_cambio_club_fechas_check" });
      await periodo({ inicio: "2027-01-10", fin: "2027-01-10" });
    });

    it("el cierre exige instante y autor a la vez", async () => {
      for (const campos of [{ cerrado_en: new Date() }, { cerrado_por_user_id: ctx.admin }]) {
        const e = await fallo(periodo({ inicio: "2027-02-01", fin: "2027-02-05", ...campos }));
        expect(e).toMatchObject({ code: "23514", constraint: "periodos_cambio_club_cierre_check" });
      }
    });

    it("dos periodos abiertos no se solapan, ni siquiera en el día límite (inclusivo); los contiguos sí se admiten", async () => {
      await periodo({ inicio: "2027-03-01", fin: "2027-03-31" });
      const borde = await fallo(periodo({ inicio: "2027-03-31", fin: "2027-04-15" }));
      expect(borde).toMatchObject({ code: "23P01", constraint: "periodos_cambio_club_sin_solape_excl" });
      const dentro = await fallo(periodo({ inicio: "2027-03-10", fin: "2027-03-12" }));
      expect(dentro).toMatchObject({ code: "23P01", constraint: "periodos_cambio_club_sin_solape_excl" });
      await periodo({ inicio: "2027-04-01", fin: "2027-04-15" });
    });

    it("la base solo rechaza la reapertura que crearía un solape (la inmutabilidad general de los periodos es del servicio)", async () => {
      await periodo({ inicio: "2027-06-01", fin: "2027-06-30" });
      const cerrado = (await periodo({ inicio: "2027-06-15", fin: "2027-07-15", cerrado_en: new Date(), cerrado_por_user_id: ctx.admin })).rows[0].id;
      const e = await fallo(pg.query(`UPDATE periodos_cambio_club SET cerrado_en = NULL, cerrado_por_user_id = NULL WHERE id = $1`, [cerrado]));
      expect(e).toMatchObject({ code: "23P01", constraint: "periodos_cambio_club_sin_solape_excl" });
    });

    it("el motivo, si se informa, no puede estar en blanco", async () => {
      const e = await fallo(periodo({ inicio: "2027-08-01", fin: "2027-08-02", motivo: "   " }));
      expect(e).toMatchObject({ code: "23514", constraint: "periodos_cambio_club_motivo_check" });
    });

    it("el autor debe existir", async () => {
      const e = await fallo(periodo({ inicio: "2027-09-01", fin: "2027-09-02", creado_por_user_id: randomUUID() }));
      expect(e).toMatchObject({ code: "23503", constraint: "periodos_cambio_club_creado_por_user_id_fkey" });
    });
  });

  describe("intentos_incorporacion", () => {
    it("idempotencia: la misma clave del mismo usuario en el mismo club se rechaza; otro usuario puede usarla", async () => {
      const k = clave();
      await intento({ clave_idempotencia: k });
      const e = await fallo(intento({ clave_idempotencia: k }));
      expect(e).toMatchObject({ code: "23505", constraint: "intentos_incorporacion_club_id_user_id_clave_idempotencia_key" });
      await intento({ clave_idempotencia: k, club_id: ctx.clubB, user_id: ctx.usuarioClubB });
    });

    it("la clave tiene entre 8 y 64 caracteres", async () => {
      expect(await fallo(intento({ clave_idempotencia: "1234567" }))).toMatchObject({ code: "23514", constraint: "intentos_incorporacion_clave_check" });
      await intento({ clave_idempotencia: "12345678" });
      expect((await fallo(intento({ clave_idempotencia: "x".repeat(65) }))).code).toBe("22001"); // VARCHAR(64)
    });

    it("las huellas tienen exactamente 32 bytes", async () => {
      expect(await fallo(intento({ huella_contenido: H31 }))).toMatchObject({ code: "23514", constraint: "intentos_incorporacion_huellas_check" });
      // Intento consumido completo, para que solo falle la longitud de la huella del alta.
      const consumido = { estado: "alta_registrada", resuelto_en: new Date(), expira_en: new Date(), consumido_en: new Date() };
      expect(await fallo(intento({ ...consumido, huella_alta: H31 }))).toMatchObject({ code: "23514", constraint: "intentos_incorporacion_huellas_check" });
      await intento({ ...consumido, huella_alta: H32 });
    });

    it("solo `en_curso` está sin resolver: resuelto_en nulo si y solo si en_curso", async () => {
      expect(await fallo(intento({ resuelto_en: new Date() }))).toMatchObject({ constraint: "intentos_incorporacion_resolucion_check" });
      expect(await fallo(intento({ estado: "duplicado" }))).toMatchObject({ constraint: "intentos_incorporacion_resolucion_check" });
      expect((await fallo(intento({ estado: "inventado" }))).code).toBe("22P02"); // valor fuera del enumerado
    });

    it("el RUN temporal solo existe en `requiere_alta` sin consumir, con formato válido y con expira_en presente (rechazar el paso vencido es del servicio)", async () => {
      const requiere = { estado: "requiere_alta", resuelto_en: new Date(), expira_en: new Date(Date.now() + 3_600_000) };
      expect(await fallo(intentoResuelto({ run_normalizado: "12345678K" }))).toMatchObject({ constraint: "intentos_incorporacion_run_temporal_check" });
      expect(await fallo(intento({ ...requiere, run_normalizado: "1234567X" }))).toMatchObject({ constraint: "intentos_incorporacion_run_formato_check" });
      expect(await fallo(intento({ ...requiere, expira_en: null }))).toMatchObject({ constraint: "intentos_incorporacion_expira_check" });
      await intento({ ...requiere, run_normalizado: "1234567K" });
      await intento({ ...requiere, run_normalizado: "123456789" });
    });

    it("coherencia de los campos de consumo: instante y huella juntos, con vencimiento, y fuera de en_curso/requiere_alta (el uso único lo garantiza el servicio)", async () => {
      const consumido = { estado: "alta_registrada", resuelto_en: new Date(), expira_en: new Date(), consumido_en: new Date(), huella_alta: H32 };
      await intento(consumido);
      expect(await fallo(intento({ ...consumido, huella_alta: null }))).toMatchObject({ constraint: "intentos_incorporacion_consumo_check" });
      expect(await fallo(intento({ ...consumido, consumido_en: null }))).toMatchObject({ constraint: "intentos_incorporacion_consumo_check" });
      expect(await fallo(intento({ ...consumido, expira_en: null }))).toMatchObject({ constraint: "intentos_incorporacion_consumo_check" });
      expect(await fallo(intento({ ...consumido, estado: "requiere_alta" }))).toMatchObject({ code: "23514" });
      // El consumo cierra el RUN temporal: un consumido con RUN no se admite.
      expect(await fallo(intento({ ...consumido, run_normalizado: "12345678K" }))).toMatchObject({ code: "23514" });
    });

    it("la propuesta referida existe solo en `propuesta_creada`/`resuelto_por_propuesta`, existe en la base y es de un único intento", async () => {
      const propuesta = (await membresia({ person_id: ctx.personas[4] })).rows[0].id;
      expect(await fallo(intentoResuelto({ estado: "propuesta_creada" }))).toMatchObject({ constraint: "intentos_incorporacion_propuesta_check" });
      expect(await fallo(intentoResuelto({ propuesta_id: propuesta }))).toMatchObject({ constraint: "intentos_incorporacion_propuesta_check" });
      await intentoResuelto({ estado: "propuesta_creada", propuesta_id: propuesta });
      expect(await fallo(intentoResuelto({ estado: "resuelto_por_propuesta", propuesta_id: propuesta }))).toMatchObject({
        code: "23505",
        constraint: "intentos_incorporacion_propuesta_id_key",
      });
      expect(await fallo(intentoResuelto({ estado: "propuesta_creada", propuesta_id: randomUUID() }))).toMatchObject({
        code: "23503",
        constraint: "intentos_incorporacion_propuesta_id_fkey",
      });
      // La propuesta referida no se puede borrar (RESTRICT).
      expect(await fallo(pg.query(`DELETE FROM club_swimmers WHERE id = $1`, [propuesta]))).toMatchObject({ code: "23503" });
    });

    it("club y usuario deben existir", async () => {
      expect(await fallo(intento({ club_id: randomUUID() }))).toMatchObject({ code: "23503", constraint: "intentos_incorporacion_club_id_fkey" });
      expect(await fallo(intento({ user_id: randomUUID() }))).toMatchObject({ code: "23503", constraint: "intentos_incorporacion_user_id_fkey" });
    });
  });

  describe("solicitudes_alta_incorporacion", () => {
    const revisada = () => ({ revisado_por_user_id: ctx.admin, revisado_en: new Date() });

    it("RUN con formato válido y nombres no vacíos", async () => {
      expect(await fallo(solicitud({ run_normalizado: "12.345.678-K" }))).toMatchObject({ code: "22001" }); // VARCHAR(9)
      expect(await fallo(solicitud({ run_normalizado: "1234567k" }))).toMatchObject({ constraint: "solicitudes_alta_run_formato_check" });
      expect(await fallo(solicitud({ nombres_declarados: "  " }))).toMatchObject({ constraint: "solicitudes_alta_nombres_check" });
      expect(await fallo(solicitud({ apellidos_declarados: "" }))).toMatchObject({ constraint: "solicitudes_alta_nombres_check" });
    });

    it("revisión: pendiente sin revisar; resuelta con instante y revisor a la vez", async () => {
      expect(await fallo(solicitud({ ...revisada() }))).toMatchObject({ constraint: "solicitudes_alta_revision_check" });
      expect(await fallo(solicitud({ estado: "rechazada" }))).toMatchObject({ constraint: "solicitudes_alta_revision_check" });
      expect(await fallo(solicitud({ estado: "rechazada", revisado_en: new Date() }))).toMatchObject({ constraint: "solicitudes_alta_revision_check" });
      await solicitud({ estado: "rechazada", ...revisada(), motivo_rechazo: "Datos incompletos (sintético)" });
    });

    it("resolución: aprobada con persona y membresía; resuelta_por_propuesta con persona y propuesta; las demás sin ellas", async () => {
      const m = (await membresia({ person_id: ctx.personas[5], status: "active", start_date: "2026-11-01" })).rows[0].id;
      const prop = (await membresia({ person_id: ctx.personas[6] })).rows[0].id;
      const persona = ctx.personas[5];

      expect(await fallo(solicitud({ estado: "aprobada", ...revisada(), persona_id: persona }))).toMatchObject({ constraint: "solicitudes_alta_resolucion_check" });
      expect(await fallo(solicitud({ estado: "aprobada", ...revisada(), membresia_id: m }))).toMatchObject({ constraint: "solicitudes_alta_resolucion_check" });
      expect(await fallo(solicitud({ estado: "rechazada", ...revisada(), persona_id: persona }))).toMatchObject({ constraint: "solicitudes_alta_resolucion_check" });
      expect(await fallo(solicitud({ membresia_id: m }))).toMatchObject({ code: "23514" });
      expect(await fallo(solicitud({ estado: "resuelta_por_propuesta", ...revisada(), persona_id: ctx.personas[6] }))).toMatchObject({
        constraint: "solicitudes_alta_resolucion_check",
      });

      await solicitud({ estado: "aprobada", ...revisada(), persona_id: persona, membresia_id: m });
      await solicitud({ estado: "resuelta_por_propuesta", ...revisada(), persona_id: ctx.personas[6], propuesta_existente_id: prop });
      // Una membresía resuelve una sola solicitud.
      expect(await fallo(solicitud({ estado: "aprobada", ...revisada(), persona_id: persona, membresia_id: m }))).toMatchObject({
        code: "23505",
        constraint: "solicitudes_alta_incorporacion_membresia_id_key",
      });
    });

    it("el motivo de rechazo y la marca «pese a eliminada» solo en su estado", async () => {
      expect(await fallo(solicitud({ motivo_rechazo: "no corresponde" }))).toMatchObject({ constraint: "solicitudes_alta_motivo_check" });
      expect(await fallo(solicitud({ estado: "rechazada", ...revisada(), persona_creada_pese_a_eliminada: true }))).toMatchObject({
        constraint: "solicitudes_alta_pese_a_eliminada_check",
      });
    });

    it("una pendiente por club y RUN: la segunda se rechaza; en otro club, o tras rechazar la primera, se admite", async () => {
      const run = "87654321K";
      const primera = (await solicitud({ run_normalizado: run })).rows[0].id;
      expect(await fallo(solicitud({ run_normalizado: run }))).toMatchObject({ code: "23505", constraint: "solicitudes_alta_unique_pendiente_club_run" });
      const intentoB = (await intentoResuelto({ club_id: ctx.clubB, user_id: ctx.usuarioClubB })).rows[0].id;
      await solicitud({ run_normalizado: run, club_id: ctx.clubB, solicitado_por_user_id: ctx.usuarioClubB, intento_id: intentoB });
      await pg.query(`UPDATE solicitudes_alta_incorporacion SET estado = 'rechazada', revisado_en = now(), revisado_por_user_id = $2 WHERE id = $1`, [primera, ctx.admin]);
      await solicitud({ run_normalizado: run });
    });

    it("un intento tiene a lo más una solicitud, debe existir y no puede borrarse mientras la tenga", async () => {
      const i = (await intentoResuelto()).rows[0].id;
      await solicitud({ intento_id: i, run_normalizado: "11111111K" });
      expect(await fallo(solicitud({ intento_id: i, run_normalizado: "22222222K" }))).toMatchObject({
        code: "23505",
        constraint: "solicitudes_alta_incorporacion_intento_id_key",
      });
      expect(await fallo(solicitud({ intento_id: randomUUID(), run_normalizado: "44444444K" }))).toMatchObject({
        code: "23503",
        constraint: "solicitudes_alta_incorporacion_intento_id_fkey",
      });
      expect(await fallo(pg.query(`DELETE FROM intentos_incorporacion WHERE id = $1`, [i]))).toMatchObject({ code: "23503" });
    });

    it("las referencias a persona, membresía, propuesta, club y revisor deben existir", async () => {
      const revis = { estado: "aprobada", revisado_en: new Date() };
      expect(await fallo(solicitud({ ...revis, revisado_por_user_id: randomUUID(), persona_id: ctx.personas[5], membresia_id: randomUUID() }))).toMatchObject({
        code: "23503",
      });
      expect(await fallo(solicitud({ club_id: randomUUID(), run_normalizado: "55555555K" }))).toMatchObject({
        code: "23503",
        constraint: "solicitudes_alta_incorporacion_club_id_fkey",
      });
      expect(await fallo(solicitud({ solicitado_por_user_id: randomUUID(), run_normalizado: "66666666K" }))).toMatchObject({
        code: "23503",
        constraint: "solicitudes_alta_incorporacion_solicitado_por_user_id_fkey",
      });
    });
  });
});

/**
 * Lo que la base ACEPTA y el servicio deberá rechazar. Estas pruebas no describen un defecto:
 * fijan el límite de lo que la fase 1 garantiza, para que nadie lo dé por impuesto.
 */
describe("3. garantías que NO impone la base (las deberá imponer el servicio)", () => {
  it("coherencia de club: una solicitud del club B puede apuntar a un intento del club A", async () => {
    const intentoA = (await intentoResuelto()).rows[0].id;
    await solicitud({ intento_id: intentoA, club_id: ctx.clubB, solicitado_por_user_id: ctx.usuarioClubB, run_normalizado: "33333333K" });
  });

  it("coherencia de club: un intento del club A puede referir una propuesta del club B", async () => {
    const propuestaB = (await membresia({ person_id: ctx.personas[7], club_id: ctx.clubB, requested_by_user_id: ctx.usuarioClubB })).rows[0].id;
    await intentoResuelto({ estado: "propuesta_creada", propuesta_id: propuestaB });
  });

  it("cuota: la base admite más de 30 intentos del mismo club en el mismo día", async () => {
    const dia = "2026-12-01";
    for (let i = 0; i < 31; i++) await intento({ dia });
    const { rows } = await pg.query(`SELECT count(*)::int AS n FROM intentos_incorporacion WHERE club_id = $1 AND dia = $2`, [ctx.clubA, dia]);
    expect(rows[0].n).toBe(31);
  });

  it("derecho de ejecución (T2): la base no exige el token para resolver un intento en curso", async () => {
    const id = (await intento()).rows[0].id;
    await pg.query(`UPDATE intentos_incorporacion SET estado = 'interrumpido', resuelto_en = now(), token_ejecucion = $2 WHERE id = $1`, [id, randomUUID()]);
    await pg.query(`UPDATE intentos_incorporacion SET estado = 'duplicado' WHERE id = $1`, [id]); // ni impide reabrir otro resultado
  });

  it("fechas: la base admite una fecha de inicio futura y una fecha de término sin relación con la membresía nueva", async () => {
    await membresia({ person_id: ctx.personas[3], status: "ended", start_date: "2030-01-01", fecha_termino: "2031-01-01" });
  });
});

describe("4. compatibilidad con las operaciones de asignación (servicio real; contratos de la fase 2)", () => {
  const ADMIN_ACTOR = () => ({ userId: ctx.admin, isAdmin: true, scope: { kind: "admin" }, canRegisterPostClose: true }) as never;

  it("postular por RUN, aprobar con fecha y dar de baja con la fecha de término elegida", async () => {
    const run = runValido(40000001);
    await createPerson({ run, username: "compat1", firstName: "Compat", gender: "male" });
    const r = await postulacion.postularComoAdministracion({ run, clubId: ctx.clubA }, ADMIN_ACTOR());
    const propuestaId = (r.cuerpo.propuesta as { id: string }).id;
    const aprobada = await assignmentService.approveAssignment(propuestaId, { userId: ctx.admin }, { fechaEfectiva: "2026-11-01" });
    const finalizada = await assignmentService.endAssignment(aprobada.id, ADMIN_ACTOR(), { fechaTermino: "2026-11-05" });
    expect(finalizada.status).toBe("ended");
    const { rows } = await pg.query(`SELECT start_date::text AS inicio, fecha_termino::text AS termino, end_date IS NOT NULL AS con_instante FROM club_swimmers WHERE id = $1`, [aprobada.id]);
    expect(rows[0]).toEqual({ inicio: "2026-11-01", termino: "2026-11-05", con_instante: true });
  });

  it("rechazar y volver a postular sigue funcionando", async () => {
    const run = runValido(40000002);
    await createPerson({ run, username: "compat2", firstName: "Compat", gender: "male" });
    const p1 = await postulacion.postularComoAdministracion({ run, clubId: ctx.clubA }, ADMIN_ACTOR());
    await assignmentService.rejectAssignment((p1.cuerpo.propuesta as { id: string }).id, "sintético", { userId: ctx.admin });
    const p2 = await postulacion.postularComoAdministracion({ run, clubId: ctx.clubA }, ADMIN_ACTOR());
    expect((p2.cuerpo.propuesta as { status: string }).status).toBe("pending");
  });

  it("dos postulaciones simultáneas del mismo club y persona: queda UNA pendiente y la otra falla como conflicto, no como error interno", async () => {
    const run = runValido(40000003);
    const persona = (await createPerson({ run, username: "compat3", firstName: "Compat", gender: "male" })).id;
    // Pool precalentado: en este equipo abrir una conexión nueva tarda ~2 s y la segunda transacción
    // simultánea superaría el `maxWait` de Prisma mientras el pool crece (ajeno a C-05).
    await Promise.all(Array.from({ length: 4 }, () => prisma.$executeRaw`SELECT pg_sleep(0.05)`));
    const resultados = await Promise.allSettled([
      postulacion.postularComoAdministracion({ run, clubId: ctx.clubA }, ADMIN_ACTOR()),
      postulacion.postularComoAdministracion({ run, clubId: ctx.clubA }, ADMIN_ACTOR()),
    ]);
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rechazo = resultados.find((r) => r.status === "rejected") as PromiseRejectedResult;
    const err = rechazo.reason;
    // El protocolo (bloqueo del RUN y de la persona) serializa y la segunda ve la pendiente (409);
    // el índice único queda como respaldo (P2002, traducido a 409). Nunca un 500.
    const estado = err instanceof AppError ? err.statusCode : translatePrismaError(err)?.statusCode;
    expect([400, 409]).toContain(estado);
    const { rows } = await pg.query(`SELECT count(*)::int AS n FROM club_swimmers WHERE club_id = $1 AND person_id = $2 AND status = 'pending'`, [ctx.clubA, persona]);
    expect(rows[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Actualización desde las 39 migraciones anteriores (base auxiliar propia)
// ---------------------------------------------------------------------------

describe("5. actualización desde las 39 migraciones anteriores, en una base auxiliar", () => {
  const baseAux = `c05_aux_${randomBytes(4).toString("hex")}_test`;
  let auxUrl = "";
  let workDir = "";
  let creada = false;
  const urlTest = () => process.env.DATABASE_URL!;

  const anteriores = () =>
    readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name < C05)
      .map((d) => d.name)
      .sort();

  const schemaAux = () => join(workDir, "prisma", "schema.prisma");

  /** Prepara la carpeta de migraciones de trabajo. `c05` permite sustituir el SQL de C-05. */
  function prepararMigraciones(incluirC05: boolean, sqlC05?: string) {
    const destino = join(workDir, "prisma", "migrations");
    rmSync(destino, { recursive: true, force: true });
    mkdirSync(destino, { recursive: true });
    for (const n of anteriores()) cpSync(join(MIGRATIONS_DIR, n), join(destino, n), { recursive: true });
    if (incluirC05) {
      mkdirSync(join(destino, C05));
      writeFileSync(join(destino, C05, "migration.sql"), sqlC05 ?? readFileSync(join(MIGRATIONS_DIR, C05, "migration.sql")));
    }
    cpSync(join(MIGRATIONS_DIR, "migration_lock.toml"), join(destino, "migration_lock.toml"));
  }

  /** Ejecuta la CLI de Prisma contra la base auxiliar. Devuelve el código y la salida, sin lanzar. */
  function prismaCli(args: string[]): { code: number; output: string } {
    try {
      const output = execFileSync("npx", ["prisma", ...args, "--schema", schemaAux()], {
        cwd: BACKEND_DIR,
        env: { ...process.env, DATABASE_URL: auxUrl },
        encoding: "utf8",
        stdio: "pipe",
        shell: process.platform === "win32",
      });
      return { code: 0, output };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  function preflight(): { code: number; output: string } {
    try {
      const output = execFileSync("npx", ["tsx", "scripts/preflight-migration.ts"], {
        cwd: BACKEND_DIR,
        env: { ...process.env, DATABASE_URL: auxUrl },
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      return { code: 0, output };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  const aux = <T>(fn: (c: Client) => Promise<T>) => conCliente(auxUrl, fn);

  /** Qué objetos de C-05 existen en la base auxiliar (para detectar restos parciales). */
  const objetosC05 = () =>
    aux(async (c) => {
      const tablas = await c.query(`SELECT relname FROM pg_class WHERE relname = ANY($1) AND relkind = 'r'`, [TABLAS_C05]);
      const tipos = await c.query(`SELECT typname FROM pg_type WHERE typname = ANY($1)`, [ENUMS_C05]);
      const columna = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'club_swimmers' AND column_name = 'fecha_termino'`);
      const restricciones = await c.query(`SELECT conname FROM pg_constraint WHERE conname = ANY($1)`, [RESTRICCIONES_C05]);
      const indices = await c.query(`SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`, [INDICES_C05]);
      return {
        tablas: tablas.rowCount,
        tipos: tipos.rowCount,
        columna: columna.rowCount,
        restricciones: restricciones.rowCount,
        indices: indices.rowCount,
      };
    });

  const historialC05 = () =>
    aux(async (c) =>
      (
        await c.query(
          `SELECT finished_at IS NOT NULL AS terminada, rolled_back_at IS NOT NULL AS revertida, logs FROM _prisma_migrations WHERE migration_name = $1 ORDER BY started_at`,
          [C05]
        )
      ).rows as { terminada: boolean; revertida: boolean; logs: string | null }[]
    );

  /** Fotografía de las membresías, sin la columna nueva. */
  const fotoMembresias = () =>
    aux(async (c) => (await c.query(`SELECT to_jsonb(cs) - 'fecha_termino' AS fila FROM club_swimmers cs ORDER BY id`)).rows.map((r) => r.fila));

  const CLUB_N = "aux-club-norte";
  const CLUB_S = "aux-club-sur";
  const ids = { dupPrimera: "aux-m-dup-1", dupSegunda: "aux-m-dup-2" };
  let fotoAntes: unknown[] = [];

  beforeAll(async () => {
    // El nombre es nuevo: si existiera, la prueba se detiene en vez de reutilizarlo o borrarlo.
    const existe = await conCliente(urlTest(), async (c) => (await c.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [baseAux])).rowCount);
    if (existe) throw new Error(`La base auxiliar ${baseAux} ya existe: no se reutiliza ni se borra`);
    await conCliente(urlTest(), (c) => c.query(`CREATE DATABASE "${baseAux}"`));
    creada = true;
    auxUrl = urlConBase(baseAux);

    workDir = mkdtempSync(join(tmpdir(), "c05-migracion-"));
    mkdirSync(join(workDir, "prisma"), { recursive: true });
    cpSync(join(BACKEND_DIR, "prisma", "schema.prisma"), schemaAux());
  }, 60_000);

  afterAll(async () => {
    // Se elimina SOLO la base auxiliar que esta prueba creó.
    if (creada) await conCliente(urlTest(), (c) => c.query(`DROP DATABASE IF EXISTS "${baseAux}" WITH (FORCE)`));
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }, 60_000);

  it("aplica las 39 migraciones anteriores y admite datos sintéticos de la versión previa", async () => {
    expect(anteriores()).toHaveLength(39);
    prepararMigraciones(false);
    const r = prismaCli(["migrate", "deploy"]);
    expect(r.code, r.output).toBe(0);

    await aux(async (c) => {
      await c.query(`
        INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at) VALUES
          ('${CLUB_N}', 'Club Aux Norte', 'club.aux.norte', 'CAN', 'norte@example.invalid', 'active', false, now()),
          ('${CLUB_S}', 'Club Aux Sur',   'club.aux.sur',   'CAS', 'sur@example.invalid',   'active', false, now());
      `);
      for (let i = 0; i < 6; i++) {
        await c.query(
          `INSERT INTO persons (id, run, username, full_name, birth_date, gender, status, updated_at)
           VALUES ($1, $2, $3, $4, '1980-01-01', 'male', 'active', now())`,
          [`aux-p${i}`, `5000000${i}`, `aux.persona${i}`, `Persona Aux ${i}`]
        );
      }
      // Activa, finalizada con instante de operación, rechazada, pendiente y las dos pendientes duplicadas.
      await c.query(`
        INSERT INTO club_swimmers (id, club_id, person_id, status, requested_by_user_id, start_date, end_date, reviewed_at, updated_at) VALUES
          ('aux-m-activa',  '${CLUB_N}', 'aux-p0', 'active',   'usuario-sintetico', '2025-03-01', NULL, '2025-03-01T12:00:00Z', now()),
          ('aux-m-fin',     '${CLUB_N}', 'aux-p1', 'ended',    'usuario-sintetico', '2024-01-15', '2025-06-30T18:45:00Z', '2024-01-15T10:00:00Z', now()),
          ('aux-m-fin-sin', '${CLUB_S}', 'aux-p1', 'ended',    'usuario-sintetico', NULL,         NULL, NULL, now()),
          ('aux-m-rech',    '${CLUB_S}', 'aux-p2', 'rejected', 'usuario-sintetico', NULL,         NULL, '2025-01-01T00:00:00Z', now()),
          ('aux-m-pend',    '${CLUB_S}', 'aux-p3', 'pending',  'usuario-sintetico', NULL,         NULL, NULL, now()),
          ('${ids.dupPrimera}', '${CLUB_N}', 'aux-p4', 'pending', 'usuario-sintetico', NULL, NULL, NULL, now() - interval '1 day'),
          ('${ids.dupSegunda}', '${CLUB_N}', 'aux-p4', 'pending', 'usuario-sintetico', NULL, NULL, NULL, now());
      `);
    });
    fotoAntes = await fotoMembresias();
    expect(fotoAntes).toHaveLength(7);
  }, 300_000);

  it("el preflight detecta las propuestas pendientes duplicadas, solo por identificadores", () => {
    const r = preflight();
    const check = CHECKS.find((c) => c.id === "propuestas-pendientes-duplicadas")!;
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain(`BLOQUEA ${check.title}`);
    expect(r.output).toContain(check.constraint);
    expect(r.output).toContain(ids.dupPrimera);
    expect(r.output).toContain(ids.dupSegunda);
    // Las demás comprobaciones no bloquean: solo este conflicto se sembró.
    const otrosBloqueos = CHECKS.filter((c) => c.id !== check.id && r.output.includes(`BLOQUEA ${c.title}`)).map((c) => c.id);
    expect(otrosBloqueos).toEqual([]);
    expect(r.output, "no muestra datos de la persona").not.toContain("Persona Aux 4");
  }, 120_000);

  it("la guarda SQL detiene la migración antes de crear objetos de C-05 y sin tocar los datos", async () => {
    prepararMigraciones(true);
    const r = prismaCli(["migrate", "deploy"]);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("Hay propuestas pendientes duplicadas");
    expect(r.output).toContain(ids.dupPrimera);
    expect(r.output).not.toContain("Persona Aux 4");

    expect(await objetosC05()).toEqual({ tablas: 0, tipos: 0, columna: 0, restricciones: 0, indices: 0 });
    expect(await fotoMembresias(), "no corrige ni borra filas").toEqual(fotoAntes);

    // Prisma deja el intento como FALLIDO: sin terminar y sin revertir.
    const h = await historialC05();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ terminada: false, revertida: false });
  }, 300_000);

  it("con el intento fallido sin resolver, un nuevo despliegue se niega a seguir (P3009)", () => {
    const r = prismaCli(["migrate", "deploy"]);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("P3009");
  }, 120_000);

  it("con esta migración (Prisma 5.22, PostgreSQL 16), un fallo inyectado al FINAL se revirtió entero: sin objetos parciales (observación, no garantía general)", async () => {
    // Primero se resuelven los duplicados como indica el preflight y se declara revertido el
    // intento fallido (no aplicado: `--rolled-back`, nunca `--applied`).
    await aux((c) => c.query(`UPDATE club_swimmers SET status = 'rejected', reviewed_at = now() WHERE id = $1`, [ids.dupSegunda]));
    expect(prismaCli(["migrate", "resolve", "--rolled-back", C05]).code).toBe(0);
    const limpio = preflight();
    expect(limpio.code, limpio.output).toBe(0);
    fotoAntes = await fotoMembresias();

    const sql = readFileSync(join(MIGRATIONS_DIR, C05, "migration.sql"), "utf8");
    prepararMigraciones(true, `${sql}\n\nDO $$ BEGIN RAISE EXCEPTION 'C05_FALLO_INYECTADO_AL_FINAL'; END $$;\n`);
    const r = prismaCli(["migrate", "deploy"]);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("C05_FALLO_INYECTADO_AL_FINAL");

    // Todo lo anterior al fallo (tablas, tipos, columna, restricciones, índices) se deshizo.
    expect(await objetosC05()).toEqual({ tablas: 0, tipos: 0, columna: 0, restricciones: 0, indices: 0 });
    expect(await fotoMembresias()).toEqual(fotoAntes);
    const h = await historialC05();
    expect(h.map((x) => ({ terminada: x.terminada, revertida: x.revertida }))).toEqual([
      { terminada: false, revertida: true },
      { terminada: false, revertida: false },
    ]);
  }, 300_000);

  it("tras declarar revertido el intento fallido, la migración real se aplica conservando las filas", async () => {
    expect(prismaCli(["migrate", "resolve", "--rolled-back", C05]).code).toBe(0);
    prepararMigraciones(true);
    const r = prismaCli(["migrate", "deploy"]);
    expect(r.code, r.output).toBe(0);

    expect(await objetosC05()).toEqual({
      tablas: TABLAS_C05.length,
      tipos: ENUMS_C05.length,
      columna: 1,
      restricciones: RESTRICCIONES_C05.length,
      indices: INDICES_C05.length,
    });
    expect(await fotoMembresias(), "todas las filas y sus valores se conservan").toEqual(fotoAntes);

    const h = await historialC05();
    expect(h.filter((x) => x.terminada && !x.revertida)).toHaveLength(1);
    expect(h.filter((x) => x.revertida)).toHaveLength(2);
  }, 300_000);

  it("fecha_termino queda NULA en todas las membresías, también en la finalizada con end_date", async () => {
    const { rows } = await aux((c) => c.query(`SELECT id, status, end_date IS NOT NULL AS con_end_date, fecha_termino FROM club_swimmers ORDER BY id`));
    expect(rows.every((r) => r.fecha_termino === null)).toBe(true);
    expect(rows.find((r) => r.id === "aux-m-fin")).toMatchObject({ status: "ended", con_end_date: true, fecha_termino: null });
  });

  it("las operaciones de asignación de la versión anterior siguen funcionando sobre la base migrada", async () => {
    await aux(async (c) => {
      // Proponer (en otro club para la misma persona), aprobar, finalizar y rechazar, con las
      // mismas columnas que escribe el servicio actual.
      await c.query(`INSERT INTO club_swimmers (id, club_id, person_id, status, requested_by_user_id, updated_at)
                     VALUES ('aux-m-nueva', '${CLUB_S}', 'aux-p5', 'pending', 'usuario-sintetico', now())`);
      await c.query(`UPDATE club_swimmers SET status = 'active', start_date = '2026-11-12', reviewed_at = now(), reviewed_by_user_id = 'admin-sintetico' WHERE id = 'aux-m-nueva'`);
      await c.query(`UPDATE club_swimmers SET status = 'ended', end_date = now() WHERE id = 'aux-m-activa'`);
      await c.query(`UPDATE club_swimmers SET status = 'rejected', reviewed_at = now() WHERE id = 'aux-m-pend'`);
      const { rows } = await c.query(`SELECT id, status, fecha_termino FROM club_swimmers WHERE id IN ('aux-m-nueva', 'aux-m-activa', 'aux-m-pend') ORDER BY id`);
      expect(rows).toEqual([
        { id: "aux-m-activa", status: "ended", fecha_termino: null },
        { id: "aux-m-nueva", status: "active", fecha_termino: null },
        { id: "aux-m-pend", status: "rejected", fecha_termino: null },
      ]);
      // Y la garantía nueva queda activa sobre los datos migrados.
      await c.query(`INSERT INTO club_swimmers (id, club_id, person_id, status, requested_by_user_id, updated_at)
                     VALUES ('aux-m-p4-otra', '${CLUB_S}', 'aux-p4', 'pending', 'usuario-sintetico', now())`);
      const e = await fallo(
        c.query(`INSERT INTO club_swimmers (id, club_id, person_id, status, requested_by_user_id, updated_at)
                 VALUES ('aux-m-p4-dup', '${CLUB_N}', 'aux-p4', 'pending', 'usuario-sintetico', now())`)
      );
      expect(e).toMatchObject({ code: "23505", constraint: "club_swimmers_unique_pending_club_person" });
    });
  });
});
