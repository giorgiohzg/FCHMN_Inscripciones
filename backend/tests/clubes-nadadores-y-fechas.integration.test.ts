/**
 * Conteo de nadadores en Clubes, orden del plantel, reporte «Clubes y nadadores» y corrección
 * de DESDE/HASTA. Por HTTP (`app.inject`) contra la base DESECHABLE. Datos SINTÉTICOS.
 *
 * Escenario:
 *   Club Alfa    25 activos (más que una página de 20): 20 «Zeta», «Ávila Soto, Ana»,
 *                «Avila, Ana» (sin materno), dos «Pérez Rojas, Juan» homónimos y un histórico sin
 *                campos separados. Además: una propuesta PENDIENTE (otra persona), una membresía
 *                FINALIZADA (otra persona), una delegada (personal, sin membresía) y una persona
 *                ELIMINADA con membresía activa (no cuenta ni aparece en el plantel).
 *   Club Beta    1 activo y 1 activo de una persona ELIMINADA (no cuenta).
 *   Club Charlie sin nadadores.
 *   @Club Fórmula sin nadadores (nombre que una planilla tomaría como fórmula).
 *   Club Delta   ELIMINADO, con 1 activo: va a la sección de REVISIÓN, no a «sin club».
 *   Sin club: la persona de la pendiente, la de la finalizada, la delegada (personal sin
 *   membresía activa) y una persona libre; NO una persona con cuenta bloqueada ni una eliminada.
 *
 * Los intercalados de «lectura coherente» son DETERMINISTAS: se envuelve la transacción de lectura
 * de la prueba para ejecutar una escritura real, confirmada, justo después de su primera consulta
 * de membresías. Sin esperas ni ganchos en el código de producción.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import { Client } from "pg";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { fechaCalendarioAUtc, hoyEnZonaDelNegocio } from "../src/shared/fecha.util";
import { compararClubes } from "../src/modules/reports/reports.rules";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createUser, addClubStaff, TEST_PASSWORD } from "./helpers/seedRbac";
import { runValido } from "./helpers/run";
import { assignSwimmerDirectly } from "../src/modules/swimmer-assignment/assignment.service";

let app: FastifyInstance;
const tokens: Record<"admin" | "club" | "delegada", string> = { admin: "", club: "", delegada: "" };
const club: Record<"alfa" | "beta" | "charlie" | "formula" | "delta", string> = { alfa: "", beta: "", charlie: "", formula: "", delta: "" };
const runs: string[] = [];
let adminUserId = "";
let cuerpo = 30_000_000;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
async function login(username: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login ${username}: ${res.statusCode}`);
  return res.json().accessToken as string;
}

async function persona(p: {
  firstName?: string | null;
  paternalLastName?: string | null;
  maternalLastName?: string | null;
  fullName: string;
  status?: "active" | "locked";
  deleted?: boolean;
  run?: string;
  username?: string;
}) {
  const run = p.run ?? runValido(++cuerpo);
  runs.push(run);
  return prisma.person.create({
    data: {
      run,
      username: p.username ?? null,
      firstName: p.firstName ?? null,
      paternalLastName: p.paternalLastName ?? null,
      maternalLastName: p.maternalLastName ?? null,
      fullName: p.fullName,
      birthDate: new Date("1980-02-02T00:00:00Z"),
      gender: "female",
      status: p.status ?? "active",
      deletedAt: p.deleted ? new Date() : null,
    },
  });
}
const membresia = (
  clubId: string,
  personId: string,
  status: "active" | "pending" | "ended",
  start: string | null,
  termino: string | null = null,
  endDate: Date | null = null
) =>
  prisma.clubSwimmer.create({
    data: {
      clubId,
      personId,
      status,
      requestedByUserId: adminUserId,
      reviewedByUserId: status === "pending" ? null : adminUserId,
      reviewedAt: status === "pending" ? null : new Date("2025-01-01T12:00:00Z"),
      startDate: start ? fechaCalendarioAUtc(start) : null,
      fechaTermino: termino ? fechaCalendarioAUtc(termino) : null,
      endDate: status === "ended" ? (endDate ?? new Date("2025-01-02T12:00:00Z")) : null,
    },
  });

/** Celdas de una línea CSV (RFC 4180, sin saltos de línea dentro de una celda). */
function celdasCsv(linea: string): string[] {
  const celdas: string[] = [];
  let actual = "";
  let entreComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]!;
    if (entreComillas) {
      if (c === '"' && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else if (c === '"') entreComillas = false;
      else actual += c;
    } else if (c === '"') entreComillas = true;
    else if (c === ",") {
      celdas.push(actual);
      actual = "";
    } else actual += c;
  }
  celdas.push(actual);
  return celdas;
}

/** Orden esperado del plantel de Alfa (nombres completos almacenados). */
const ORDEN_ALFA: string[] = [];
const ids: Record<string, string> = {};

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();

  const admin = await createUser({ username: "admin_cn", roleNames: ["admin"] });
  adminUserId = admin.id;
  club.alfa = (await createClub("Club Alfa", "ALF", "club_alfa_cn")).id;
  club.beta = (await createClub("Club Beta", "BET")).id;
  club.charlie = (await createClub("Club Charlie", "CHA")).id;
  club.formula = (await createClub("@Club Fórmula", "FOR")).id;
  club.delta = (await createClub("Club Delta", "DEL")).id;
  await prisma.club.update({ where: { id: club.delta }, data: { deletedAt: new Date(), status: "disabled" } });
  await createUser({ username: "club_alfa_cn", roleNames: ["club"], clubId: club.alfa });

  // --- Alfa: 25 activos, insertados en un orden que NO es el esperado ---
  const zetas = [];
  for (let i = 19; i >= 0; i--) {
    const n = String(i).padStart(2, "0");
    zetas.push(
      await persona({ firstName: `Nombre${n}`, paternalLastName: "Zeta", maternalLastName: "Prueba", fullName: `Nombre${n} Zeta Prueba` })
    );
  }
  const historico = await persona({ fullName: "Antiguo Registro Histórico" });
  const perezB = await persona({
    firstName: "Juan",
    paternalLastName: "Pérez",
    maternalLastName: "Rojas",
    fullName: "Juan Pérez Rojas",
    run: runValido(20_000_002),
  });
  const avilaSinMaterno = await persona({ firstName: "Ana", paternalLastName: "Avila", fullName: "Ana Avila" });
  const perezA = await persona({
    firstName: "Juan",
    paternalLastName: "Perez",
    maternalLastName: "Rojas",
    fullName: "Juan Perez Rojas",
    run: runValido(20_000_001),
  });
  const avila = await persona({ firstName: "Ana", paternalLastName: "Ávila", maternalLastName: "Soto", fullName: "Ana Ávila Soto" });
  for (const p of [...zetas, historico, perezB, avilaSinMaterno, perezA, avila]) {
    const m = await membresia(club.alfa, p.id, "active", "2025-02-01");
    ids[p.fullName] = m.id;
  }
  // Persona ELIMINADA con membresía activa en Alfa: su apellido la pondría primera.
  const borrada = await persona({ firstName: "Borrada", paternalLastName: "Aaaa", fullName: "Borrada Aaaa", deleted: true });
  await membresia(club.alfa, borrada.id, "active", "2025-02-01");
  ORDEN_ALFA.push(
    "Ana Ávila Soto",
    "Ana Avila",
    "Juan Perez Rojas",
    "Juan Pérez Rojas",
    ...Array.from({ length: 20 }, (_, i) => `Nombre${String(i).padStart(2, "0")} Zeta Prueba`),
    "Antiguo Registro Histórico"
  );
  // Avila Soto tuvo antes un periodo FINALIZADO en Beta (para corregir fechas).
  ids.avilaBeta = (await membresia(club.beta, avila.id, "ended", "2024-01-01", "2024-12-31")).id;

  const pendiente = await persona({ firstName: "Pendiente", paternalLastName: "Sola", fullName: "Pendiente Sola" });
  ids.pendiente = (await membresia(club.alfa, pendiente.id, "pending", null)).id;
  const exAlfa = await persona({ firstName: "Ex", paternalLastName: "Socia", fullName: "Ex Socia" });
  await membresia(club.alfa, exAlfa.id, "ended", "2023-01-01", "2023-12-31");
  const delegada = await persona({
    firstName: "Delegada",
    paternalLastName: "Personal",
    fullName: "Delegada Personal",
    username: "delegada_cn",
  });
  await addClubStaff(club.alfa, delegada.id, "delegate");
  await createUser({ username: "delegada_cn", roleNames: ["delegate"], personId: delegada.id });

  // --- Beta, Delta y personas sin club ---
  const beta1 = await persona({ firstName: "Beto", paternalLastName: "Beta", fullName: "Beto Beta" });
  await membresia(club.beta, beta1.id, "active", "2025-01-01");
  const eliminada = await persona({ firstName: "Borrada", paternalLastName: "Eliminada", fullName: "Borrada Eliminada", deleted: true });
  await membresia(club.beta, eliminada.id, "active", "2025-01-01");
  const enDelta = await persona({ firstName: "Huérfana", paternalLastName: "Delta", fullName: "Huérfana Delta" });
  await membresia(club.delta, enDelta.id, "active", "2025-01-01");
  ids.libre = (await persona({ firstName: "Libre", paternalLastName: "Sinclub", fullName: "Libre Sinclub" })).id;
  await persona({ firstName: "Bloqueada", paternalLastName: "Cuenta", fullName: "Bloqueada Cuenta", status: "locked" });
  await persona({ firstName: "Otra", paternalLastName: "Eliminada", fullName: "Otra Eliminada", deleted: true });

  tokens.admin = await login("admin_cn");
  tokens.club = await login("club_alfa_cn");
  tokens.delegada = await login("delegada_cn");
});

const conexiones: Client[] = [];
async function abrirConexion(): Promise<Client> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  conexiones.push(c);
  return c;
}
/** Retiene el bloqueo consultivo del protocolo desde otra conexión, hasta `soltar` (como en C-05). */
async function retener(clave: string) {
  const c = await abrirConexion();
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [clave]);
  return { soltar: async () => void (await c.query("COMMIT")) };
}
/** Espera a que haya al menos `n` sesiones detenidas en un bloqueo consultivo. */
async function enEspera(n: number) {
  const observador = await abrirConexion();
  for (let i = 0; i < 400; i++) {
    const { rows } = await observador.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%pg_advisory_xact_lock(hashtextextended%'`
    );
    if (rows[0].n >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No se confirmó la espera de ${n} sesiones en el bloqueo de la persona`);
}

/**
 * Ejecuta `accion` envolviendo SOLO su transacción de lectura `REPEATABLE READ`: justo después de
 * la primera `clubSwimmer.findMany` de esa transacción, corre `intercalar` (una escritura real que
 * se confirma en otra conexión) y luego la lectura continúa. Determinista: no hay esperas.
 */
async function conIntercalado<T>(
  accion: () => Promise<T>,
  intercalar: () => Promise<void>
): Promise<{ resultado: T; intercalado: boolean }> {
  const original = prisma.$transaction.bind(prisma) as unknown as (fn: unknown, opciones?: unknown) => Promise<unknown>;
  let intercalado = false;
  const enlazar = (objeto: object, valor: unknown) => (typeof valor === "function" ? valor.bind(objeto) : valor);
  const envolver = (tx: object) =>
    new Proxy(tx, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (k !== "clubSwimmer") return enlazar(t, v);
        return new Proxy(v as object, {
          get(m, f) {
            const g = Reflect.get(m, f);
            if (f !== "findMany") return enlazar(m, g);
            return async (...args: unknown[]) => {
              const r = await (g as (...a: unknown[]) => Promise<unknown>).apply(m, args);
              if (!intercalado) {
                intercalado = true;
                await intercalar();
              }
              return r;
            };
          },
        });
      },
    });
  const espia = vi.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, opciones?: { isolationLevel?: string }) => {
    if (typeof fn !== "function" || opciones?.isolationLevel !== Prisma.TransactionIsolationLevel.RepeatableRead)
      return original(fn, opciones);
    return original((tx: object) => (fn as (t: object) => Promise<unknown>)(envolver(tx)), opciones);
  }) as never);
  try {
    return { resultado: await accion(), intercalado };
  } finally {
    espia.mockRestore();
  }
}

afterAll(async () => {
  await Promise.all(conexiones.map((c) => c.end().catch(() => undefined)));
  await app?.close();
});

describe("Clubes: columna Nadadores", () => {
  it("cuenta el plantel activo completo, sin eliminadas, pendientes, historial ni personal; una consulta por página", async () => {
    const res = await app.inject({ method: "GET", url: "/clubs?pageSize=100", headers: auth(tokens.admin) });
    expect(res.statusCode).toBe(200);
    const porNombre = Object.fromEntries(res.json().items.map((c: { name: string; nadadores: number }) => [c.name, c.nadadores]));
    expect(porNombre).toEqual({ "Club Alfa": 25, "Club Beta": 1, "Club Charlie": 0, "@Club Fórmula": 0 });
  });

  it("el total no depende de la página del listado", async () => {
    const res = await app.inject({ method: "GET", url: "/clubs?search=Alfa&pageSize=1", headers: auth(tokens.admin) });
    expect(res.json().items[0].nadadores).toBe(25);
  });

  it("conserva el alcance por club de un usuario no administrador", async () => {
    const res = await app.inject({ method: "GET", url: "/clubs?pageSize=100", headers: auth(tokens.club) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((c: { name: string; nadadores: number }) => [c.name, c.nadadores])).toEqual([["Club Alfa", 25]]);
  });
});

describe("Plantel de Editar Club: orden por apellidos antes de paginar", () => {
  const pagina = (token: string, page: number, clubId = club.alfa) =>
    app.inject({
      method: "GET",
      url: `/swimmer-assignments?clubId=${clubId}&status=active&orden=apellidos&page=${page}&pageSize=20`,
      headers: auth(token),
    });

  it("paterno, materno y nombre; homónimos y tildes; históricos al final; páginas contiguas", async () => {
    const p1 = await pagina(tokens.admin, 1);
    const p2 = await pagina(tokens.admin, 2);
    expect(p1.statusCode).toBe(200);
    expect(p1.json().total).toBe(25);
    expect(p1.json().items).toHaveLength(20);
    expect(p2.json().items).toHaveLength(5);
    const nombres = [...p1.json().items, ...p2.json().items].map((a: { person: { fullName: string } }) => a.person.fullName);
    expect(nombres).toEqual(ORDEN_ALFA);
    // Los homónimos (Perez/Pérez Rojas, Juan) desempatan por RUN, de forma estable.
    const otra = await pagina(tokens.admin, 1);
    expect(otra.json().items.map((a: { id: string }) => a.id)).toEqual(p1.json().items.map((a: { id: string }) => a.id));
  });

  it("excluye a la persona eliminada antes de ordenar y paginar: total igual al conteo de Clubes", async () => {
    const p1 = await pagina(tokens.admin, 1);
    const nombres = p1.json().items.map((a: { person: { fullName: string } }) => a.person.fullName);
    expect(nombres).not.toContain("Borrada Aaaa");
    const clubes = await app.inject({ method: "GET", url: "/clubs?search=Alfa", headers: auth(tokens.admin) });
    expect(p1.json().total).toBe(clubes.json().items[0].nadadores);
    // No se tocó su membresía: sigue activa en el historial administrativo.
    expect(await prisma.clubSwimmer.count({ where: { clubId: club.alfa, status: "active", person: { deletedAt: { not: null } } } })).toBe(
      1
    );
  });

  it("una baja confirmada ENTRE las dos lecturas no descuadra la página: ambas ven el mismo momento", async () => {
    const id = ids["Juan Perez Rojas"]!;
    const { resultado: res, intercalado } = await conIntercalado(
      () => pagina(tokens.admin, 1),
      async () => void (await prisma.clubSwimmer.update({ where: { id }, data: { status: "ended", endDate: new Date() } }))
    );
    try {
      expect(intercalado).toBe(true);
      expect(res.statusCode).toBe(200);
      // La instantánea es la de antes de la baja: misma página completa y mismo total.
      expect(res.json().total).toBe(25);
      expect(res.json().items.map((a: { person: { fullName: string } }) => a.person.fullName)).toEqual(ORDEN_ALFA.slice(0, 20));
      // Una lectura nueva ya ve la baja.
      expect((await pagina(tokens.admin, 1)).json().total).toBe(24);
    } finally {
      await prisma.clubSwimmer.update({ where: { id }, data: { status: "active", endDate: null } });
    }
  });

  it("sin `orden` se conserva el orden de siempre", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/swimmer-assignments?clubId=${club.alfa}&status=active&page=1&pageSize=20`,
      headers: auth(tokens.admin),
    });
    expect(res.json().items.map((a: { person: { fullName: string } }) => a.person.fullName)).not.toEqual(ORDEN_ALFA.slice(0, 20));
  });

  it("el club solo ve su plantel aunque pida otro club", async () => {
    const res = await pagina(tokens.club, 1, club.beta);
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(25);
    expect(res.json().items.every((a: { clubId: string }) => a.clubId === club.alfa)).toBe(true);
  });

  it("rechaza un orden desconocido", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/swimmer-assignments?clubId=${club.alfa}&orden=nombre`,
      headers: auth(tokens.admin),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Reporte «Clubes y nadadores»", () => {
  const leer = (token: string) => app.inject({ method: "GET", url: "/reports/clubes-y-nadadores", headers: auth(token) });

  it("grupos completos: clubes no eliminados por nombre, también vacíos, «Sin club asignado» y revisión", async () => {
    const res = await leer(tokens.admin);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    const nombres = r.clubes.map((c: { clubName: string }) => c.clubName);
    expect([...nombres].sort((a: string, b: string) => compararClubes(a, b))).toEqual(nombres);
    expect(new Set(nombres)).toEqual(new Set(["Club Alfa", "Club Beta", "Club Charlie", "@Club Fórmula"]));
    const alfa = r.clubes.find((c: { clubName: string }) => c.clubName === "Club Alfa");
    expect(alfa.nadadores).toHaveLength(25);
    expect(alfa.nadadores[0].nombre).toBe("ÁVILA SOTO, ANA");
    expect(alfa.nadadores[24].nombre).toBe("ANTIGUO REGISTRO HISTÓRICO");
    expect(
      r.clubes.find((c: { clubName: string }) => c.clubName === "Club Beta").nadadores.map((n: { nombre: string }) => n.nombre)
    ).toEqual(["BETA, BETO"]);
    expect(r.clubes.find((c: { clubName: string }) => c.clubName === "Club Charlie").nadadores).toEqual([]);
    expect(r.sinClub.map((n: { nombre: string }) => n.nombre)).toEqual([
      "PERSONAL, DELEGADA",
      "SINCLUB, LIBRE",
      "SOCIA, EX",
      "SOLA, PENDIENTE",
    ]);
    // La delegada sin membresía activa SÍ figura en «Sin club asignado» (criterio de Asignación).
    // Quien tiene su membresía activa en el club eliminado va a revisión, no a «sin club».
    expect(
      r.revision.map((g: { clubName: string; personas: { nombre: string }[] }) => [g.clubName, g.personas.map((p) => p.nombre)])
    ).toEqual([["Club Delta", ["DELTA, HUÉRFANA"]]]);
    expect(r.totales).toEqual({ clubes: 4, nadadoresConClub: 26, sinClub: 4, enClubesEliminados: 1 });
    // Cada persona, exactamente una vez en todo el reporte.
    const todas = [
      ...r.clubes.flatMap((c: { nadadores: { personId: string }[] }) => c.nadadores),
      ...r.sinClub,
      ...r.revision.flatMap((g: { personas: { personId: string }[] }) => g.personas),
    ].map((n: { personId: string }) => n.personId);
    expect(new Set(todas).size).toBe(todas.length);
    expect(todas).toHaveLength(26 + 4 + 1);
  });

  it("no entrega RUN, nacimiento ni correo", async () => {
    const cuerpoRespuesta = (await leer(tokens.admin)).body;
    for (const run of runs) expect(cuerpoRespuesta).not.toContain(run);
    expect(cuerpoRespuesta).not.toMatch(/1980|birth|email|"run"/i);
  });

  it("exclusivo de administración: el club, la delegada y una solicitud sin sesión no lo ven ni lo exportan", async () => {
    for (const t of [tokens.club, tokens.delegada]) {
      expect((await leer(t)).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/reports/clubes-y-nadadores/export?format=csv", headers: auth(t) })).statusCode).toBe(
        403
      );
    }
    expect((await app.inject({ method: "GET", url: "/reports/clubes-y-nadadores" })).statusCode).toBe(401);
  });

  it("CSV y Excel: el reporte completo, con las mismas filas y fórmulas neutralizadas", async () => {
    const csv = await app.inject({ method: "GET", url: "/reports/clubes-y-nadadores/export?format=csv", headers: auth(tokens.admin) });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-disposition"]).toContain("Clubes_y_nadadores.csv");
    const lineas = csv.body.split("\r\n");
    // Encabezado + 25 + 1 + Charlie + Fórmula + 1 en revisión + 4 sin club.
    expect(lineas).toHaveLength(34);
    expect(lineas[0]).toBe("Sección,Club,Sigla,N°,Nadador");
    expect(lineas).toContain("Club,'@Club Fórmula,FOR,,(sin nadadores)");
    expect(lineas.filter((l) => l.startsWith("Club,Club Alfa,"))).toHaveLength(25);
    expect(lineas.filter((l) => l.startsWith("Sin club asignado,"))).toHaveLength(4);
    // Orden de secciones: clubes, revisión y, al final, «Sin club asignado».
    expect(lineas[29]).toBe('Revisión: membresía activa en un club eliminado,Club Delta,DEL,1,"DELTA, HUÉRFANA"');
    expect(lineas[33]).toBe('Sin club asignado,,,4,"SOLA, PENDIENTE"');

    const xlsx = await app.inject({ method: "GET", url: "/reports/clubes-y-nadadores/export?format=xlsx", headers: auth(tokens.admin) });
    expect(xlsx.statusCode).toBe(200);
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    const hoja = libro.worksheets[0]!;
    const filas: string[][] = [];
    hoja.eachRow((row) => filas.push((row.values as unknown[]).slice(1).map((v) => (v === null || v === undefined ? "" : String(v)))));
    expect(filas.map((f) => f.join("|"))).toEqual(lineas.map((l) => celdasCsv(l).join("|")));
  });

  it("PDF válido y exportación auditada", async () => {
    const pdf = await app.inject({ method: "GET", url: "/reports/clubes-y-nadadores/export?format=pdf", headers: auth(tokens.admin) });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const auditorias = await prisma.auditLog.findMany({ where: { action: "REPORT_EXPORTED", entityId: "clubes-y-nadadores" } });
    expect(auditorias.map((a) => (a.after as { format: string }).format).sort()).toEqual(["csv", "pdf", "xlsx"]);
  });

  it("lectura coherente: una asignación confirmada DURANTE la lectura no omite ni duplica a la persona", async () => {
    const { resultado: res, intercalado } = await conIntercalado(
      () => leer(tokens.admin),
      async () =>
        void (await assignSwimmerDirectly(
          { clubId: club.charlie, personId: ids.libre!, fechaEfectiva: "2025-06-01" },
          { userId: adminUserId }
        ))
    );
    expect(intercalado).toBe(true);
    expect(res.statusCode).toBe(200);
    type Lectura = {
      clubes: { clubName: string; nadadores: { personId: string }[] }[];
      sinClub: { personId: string }[];
      revision: { personas: { personId: string }[] }[];
    };
    const donde = (l: Lectura) => [
      ...l.clubes.filter((c) => c.nadadores.some((n) => n.personId === ids.libre)).map((c) => c.clubName),
      ...(l.sinClub.some((n) => n.personId === ids.libre) ? ["sin club"] : []),
      ...l.revision.filter((g) => g.personas.some((n) => n.personId === ids.libre)).map(() => "revisión"),
    ];
    // Exactamente una vez y en el estado del MISMO momento: antes de la asignación.
    expect(donde(res.json())).toEqual(["sin club"]);
    expect(res.json().totales).toEqual({ clubes: 4, nadadoresConClub: 26, sinClub: 4, enClubesEliminados: 1 });
    // Una lectura nueva la ve ya asignada, también una sola vez.
    expect(donde((await leer(tokens.admin)).json())).toEqual(["Club Charlie"]);
  });

  it("formato inválido: 400", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/reports/clubes-y-nadadores/export?format=doc", headers: auth(tokens.admin) })).statusCode
    ).toBe(400);
  });
});

describe("Corrección de DESDE y HASTA", () => {
  const corregir = (id: string, payload: unknown, token = tokens.admin) =>
    app.inject({ method: "PUT", url: `/swimmer-assignments/${id}/fechas`, headers: auth(token), payload: payload as object });
  const manana = () => {
    const d = fechaCalendarioAUtc(hoyEnZonaDelNegocio());
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };

  it("exclusiva de administración: ni el club ni la delegada, aunque vean el plantel", async () => {
    expect((await corregir(ids["Ana Ávila Soto"]!, { startDate: "2025-01-15" }, tokens.club)).statusCode).toBe(403);
    expect((await corregir(ids["Ana Ávila Soto"]!, { startDate: "2025-01-15" }, tokens.delegada)).statusCode).toBe(403);
  });

  it("rechaza fechas futuras, HASTA en una activa, HASTA anterior a DESDE, null y pendientes", async () => {
    const futura = await corregir(ids["Ana Ávila Soto"]!, { startDate: manana() });
    expect([futura.statusCode, futura.json().error]).toEqual([400, "FECHA_FUTURA"]);
    const terminoActiva = await corregir(ids["Ana Ávila Soto"]!, { fechaTermino: "2025-03-01" });
    expect([terminoActiva.statusCode, terminoActiva.json().error]).toEqual([400, "TERMINO_EN_ACTIVA"]);
    const invertida = await corregir(ids.avilaBeta!, { fechaTermino: "2023-12-31" });
    expect([invertida.statusCode, invertida.json().error]).toEqual([400, "HASTA_ANTERIOR_A_DESDE"]);
    expect((await corregir(ids.avilaBeta!, { fechaTermino: null })).statusCode).toBe(400);
    const pendiente = await corregir(ids.pendiente!, { startDate: "2025-01-01" });
    expect([pendiente.statusCode, pendiente.json().error]).toEqual([409, "MEMBRESIA_NO_EDITABLE"]);
  });

  it("impide superposiciones con extremos inclusivos y acepta terminar el día anterior", async () => {
    const choca = await corregir(ids.avilaBeta!, { fechaTermino: "2025-02-01" });
    expect([choca.statusCode, choca.json().error]).toEqual([409, "CONFLICTO_DE_FECHAS"]);
    const activaAtras = await corregir(ids["Ana Ávila Soto"]!, { startDate: "2024-12-31" });
    expect([activaAtras.statusCode, activaAtras.json().error]).toEqual([409, "CONFLICTO_DE_FECHAS"]);
    const antes = await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: ids.avilaBeta! } });
    const ok = await corregir(ids.avilaBeta!, { fechaTermino: "2025-01-31" });
    expect(ok.statusCode).toBe(200);
    const despues = await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: ids.avilaBeta! } });
    // Solo cambia la fecha de pertenencia: estado, instante de baja y marcas reales intactos.
    expect(despues.fechaTermino?.toISOString().slice(0, 10)).toBe("2025-01-31");
    expect({ ...despues, fechaTermino: null, updatedAt: null }).toEqual({ ...antes, fechaTermino: null, updatedAt: null });
    const auditoria = await prisma.auditLog.findFirst({
      where: { action: "SWIMMER_ASSIGNMENT_DATES_CORRECTED", entityId: ids.avilaBeta! },
    });
    expect(auditoria?.before).toMatchObject({ fechaTermino: "2024-12-31", status: "ended" });
    expect(auditoria?.after).toMatchObject({ fechaTermino: "2025-01-31", status: "ended" });
  });

  it("el mismo día como DESDE y HASTA es válido; sin cambios responde 400", async () => {
    const p = await persona({ firstName: "Un", paternalLastName: "Dia", fullName: "Un Dia" });
    const m = await membresia(club.beta, p.id, "ended", "2022-05-01", "2022-05-31");
    expect((await corregir(m.id, { startDate: "2022-05-31" })).statusCode).toBe(200);
    const igual = await corregir(m.id, { startDate: "2022-05-31", fechaTermino: "2022-05-31" });
    expect([igual.statusCode, igual.json().error]).toEqual([400, "SIN_CAMBIOS"]);
  });

  it("historial desconocido: exige la aceptación explícita y no inventa las fechas que faltan", async () => {
    const p = await persona({ firstName: "Con", paternalLastName: "Historia", fullName: "Con Historia" });
    const vieja = await membresia(club.beta, p.id, "ended", null, null, new Date("2024-03-03T15:00:00Z"));
    const activa = await membresia(club.alfa, p.id, "active", "2025-05-01");
    const sin = await corregir(activa.id, { startDate: "2025-04-01" });
    expect([sin.statusCode, sin.json().error]).toEqual([409, "HISTORIAL_INCOMPLETO"]);
    expect(sin.json().details.membresias).toEqual([vieja.id]);
    const con = await corregir(activa.id, { startDate: "2025-04-01", aceptarHistorialIncompleto: true });
    expect(con.statusCode).toBe(200);
    const v = await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: vieja.id } });
    expect([v.startDate, v.fechaTermino, v.status]).toEqual([null, null, "ended"]);
    expect((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: activa.id } })).status).toBe("active");
  });

  it("concurrencia: dos correcciones válidas por separado pero superpuestas juntas; solo una se guarda", async () => {
    const p = await persona({ firstName: "Doble", paternalLastName: "Carrera", fullName: "Doble Carrera" });
    const m1 = await membresia(club.beta, p.id, "ended", "2023-01-01", "2023-06-30");
    const m2 = await membresia(club.charlie, p.id, "ended", "2023-08-01", "2023-12-31");
    // Pool precalentado (abrir una conexión nueva tarda ~2 s en este equipo, ver C-05) y el bloqueo de
    // la persona retenido: las DOS correcciones quedan esperando a la vez y, al soltarlo, la segunda
    // debe reevaluar con lo que confirmó la primera.
    await Promise.all(Array.from({ length: 4 }, () => prisma.$executeRaw`SELECT pg_sleep(0.05)`));
    const retencion = await retener(`c05:persona:${p.id}`);
    const pa = corregir(m1.id, { fechaTermino: "2023-07-20" });
    const pb = corregir(m2.id, { startDate: "2023-07-10" });
    await enEspera(2);
    await retencion.soltar();
    const [a, b] = await Promise.all([pa, pb]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.statusCode === 409)!.json().error).toBe("CONFLICTO_DE_FECHAS");
    const [f1, f2] = await Promise.all([m1, m2].map((m) => prisma.clubSwimmer.findUniqueOrThrow({ where: { id: m.id } })));
    // El resultado es coherente: el fin de una sigue antes del inicio de la otra.
    expect(f1!.fechaTermino!.getTime()).toBeLessThan(f2!.startDate!.getTime());
  });
});
