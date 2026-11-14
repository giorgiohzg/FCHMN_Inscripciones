/**
 * AUD-10 y AUD-14 (integración, flujo HTTP real con login y `buildActorContext`).
 *
 * AUD-10 — reportes de inscritos:
 *   - administración (también admin + nadador): fecha de nacimiento completa en JSON, CSV y XLSX,
 *     con la estructura de siempre;
 *   - club, delegado, entrenador, representante legal, personal del club que también es nadador y
 *     nadador: la EDAD (a la fecha de corte de la competencia o, si falta, la de siempre) en el lugar
 *     de la fecha, sin la fecha en ninguna parte de la respuesta; CSV/XLSX con «Edad»;
 *   - mismas filas, orden, filtros y totales que antes; ningún reporte con RUN; la neutralización de
 *     fórmulas sigue.
 *
 * AUD-14 — relevos (`GET /relay-registrations`):
 *   - administración y alcance de club: todos los RUN de los integrantes de su alcance;
 *   - nadador sin funciones de club: su RUN y, en sus compañeros, la propiedad `run` ausente;
 *   - mismos relevos, paginación y totales; un parámetro `clubId` no amplía nada.
 *
 * Datos sintéticos; solo la base desechable de `docker-compose.test.yml` (el guard de `testDb.ts` lo exige).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import AdmZip from "adm-zip";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { computeAge, getDefaultAgeCutoffDate } from "../src/shared/age.util";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createUser, createPerson, addActiveMembership, addClubStaff, TEST_PASSWORD } from "./helpers/seedRbac";

let app: FastifyInstance;
const tokens: Record<string, string> = {};
let competitionId = "";
let clubAId = "";
let clubBId = "";
const FECHA_DE_CORTE = new Date("2030-06-30");

/** Personas sintéticas: RUN centinela y fecha de nacimiento elegida para que la fecha de corte importe. */
const NACIMIENTOS: Record<string, string> = {
  N1: "1990-12-31",
  N2: "1985-03-10",
  N3: "1992-08-01",
  N4: "1988-11-20",
  D: "1980-07-20",
  AN: "1975-01-15",
  M1: "1991-02-02",
  M2: "1993-04-04",
  M3: "1994-06-06",
  M4: "1995-09-09",
};
const persona: Record<string, { id: string; run: string; fullName: string }> = {};

const ROLES_ADMIN = ["admin", "admin_nad"] as const;
const ROLES_GENERALES = ["club_alfa", "deleg_nad", "coach_a", "replegal_a", "nadador_n1"] as const;
const CLAVES_ADMIN = ["competencia", "club", "nombreCompleto", "fechaNacimiento", "categoria", "prueba", "distancia", "estilo", "genero", "fecha", "jornada", "tipoDePrueba"];
const CLAVES_GENERAL = CLAVES_ADMIN.map((k) => (k === "fechaNacimiento" ? "edad" : k));
const ENCABEZADOS_ADMIN = "Competencia,Club,Nombre completo,Fecha de nacimiento,Categoría,Prueba,Distancia,Estilo,Género,Fecha,Jornada,Tipo de prueba";
const ENCABEZADOS_GENERAL = ENCABEZADOS_ADMIN.replace("Fecha de nacimiento", "Edad");

const ddmmyyyy = (iso: string) => iso.split("-").reverse().join("-");
/** Todas las formas en que la fecha completa podría filtrarse: dd-mm-yyyy, yyyy-mm-dd e ISO. */
const formasDeFecha = (iso: string) => [ddmmyyyy(iso), iso, `${iso}T00:00:00`];
const nombreDe = (k: string) => persona[k]!.fullName;
const claveDeNombre = (nombre: string) => Object.keys(persona).find((k) => persona[k]!.fullName === nombre)!;

const auth = (rol: string) => ({ authorization: `Bearer ${tokens[rol]}` });
const get = (rol: string, url: string) => app.inject({ method: "GET", url, headers: auth(rol) });
const informe = async (rol: string, extra = "") => {
  const res = await get(rol, `/reports/registrations?competitionId=${competitionId}${extra}`);
  expect(res.statusCode, `${rol}: ${res.body}`).toBe(200);
  return res.json() as { individualRows: Record<string, unknown>[]; relayRows: Record<string, unknown>[]; groupedByClub: { clubName: string; swimmers: { nombreCompleto: string; edad: number; categoria: string }[] }[] };
};
const exportar = (rol: string, formato: "csv" | "xlsx" | "pdf") => get(rol, `/reports/registrations/export?competitionId=${competitionId}&format=${formato}`);
const relevos = async (rol: string, extra = "") => {
  const res = await get(rol, `/relay-registrations?competitionId=${competitionId}${extra}`);
  expect(res.statusCode, `${rol}: ${res.body}`).toBe(200);
  return res.json() as { items: { id: string; clubId: string; members: { id: string; personId: string; orderPosition: number; person: Record<string, unknown> }[] }[]; total: number; page: number; pageSize: number };
};

/** Lo que el informe de un rol general debe parecerse al del administrador: mismas filas, sin la fecha. */
const proyeccion = (filas: Record<string, unknown>[]) => filas.map(({ fechaNacimiento: _f, edad: _e, ...resto }) => resto);

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();

  const adminUser = await createUser({ username: "admin", roleNames: ["admin"] });

  // `=` al inicio: comprueba que la neutralización de fórmulas sigue en la vista general.
  const clubA = await createClub("=Club Alfa", "PRVA", "club_alfa");
  const clubB = await createClub("Club Beta", "PRVB", "club_beta");
  clubAId = clubA.id;
  clubBId = clubB.id;
  await createUser({ username: "club_alfa", roleNames: ["club"], clubId: clubA.id });

  const crear = async (k: string, n: number, opts: { roles?: ("swimmer" | "delegate" | "coach" | "legal_representative")[]; club?: string; usuario?: string } = {}) => {
    // Con cuenta, la persona lleva el mismo nombre de usuario que la cuenta.
    const p = await createPerson({ run: `RUNPRIV${String(n).padStart(2, "0")}`, username: opts.usuario ?? `prv_${k.toLowerCase()}`, firstName: `Pers${k}`, gender: n % 2 ? "female" : "male", roles: opts.roles });
    if (NACIMIENTOS[k]) await prisma.person.update({ where: { id: p.id }, data: { birthDate: new Date(NACIMIENTOS[k]!) } });
    if (opts.club) await addActiveMembership(opts.club, p.id, adminUser.id);
    persona[k] = { id: p.id, run: p.run, fullName: p.fullName };
    return p;
  };

  // Club A: cuatro nadadores; N1 con cuenta de nadador.
  for (const [i, k] of ["N1", "N2", "N3", "N4"].entries()) await crear(k, i + 1, { club: clubA.id, usuario: k === "N1" ? "nadador_n1" : undefined });
  await createUser({ username: "nadador_n1", roleNames: ["swimmer"], personId: persona.N1!.id });

  // Delegado que además es nadador del club (alcance de club).
  const d = await crear("D", 5, { roles: ["swimmer", "delegate"], club: clubA.id, usuario: "deleg_nad" });
  await addClubStaff(clubA.id, d.id, "delegate");
  await createUser({ username: "deleg_nad", roleNames: ["delegate", "swimmer"], personId: d.id });

  const c = await crear("C", 6, { roles: ["coach"], usuario: "coach_a" });
  await addClubStaff(clubA.id, c.id, "coach");
  await createUser({ username: "coach_a", roleNames: ["coach"], personId: c.id });

  const l = await crear("L", 7, { roles: ["legal_representative"], usuario: "replegal_a" });
  await addClubStaff(clubA.id, l.id, "legal_representative");
  await createUser({ username: "replegal_a", roleNames: ["legal_representative"], personId: l.id });

  // Administrador que además es nadador inscrito del club A: prevalece la administración.
  const an = await crear("AN", 8, { club: clubA.id, usuario: "admin_nad" });
  await createUser({ username: "admin_nad", roleNames: ["admin", "swimmer"], personId: an.id });

  // Club B: el equipo ajeno.
  for (const [i, k] of ["M1", "M2", "M3", "M4"].entries()) await crear(k, 11 + i, { club: clubB.id });

  // Catálogo y competencia (con fecha de corte explícita, lejos de hoy).
  const tipoInd = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
  const tipoRel = await prisma.testType.create({ data: { name: "Relevo", swimmersCount: 4 } });
  const d50 = await prisma.distance.create({ data: { meters: 50 } });
  const libre = await prisma.stroke.create({ data: { name: "Libre" } });
  const espalda = await prisma.stroke.create({ data: { name: "Espalda" } });
  const manana = await prisma.sessionType.create({ data: { name: "Mañana" } });
  const catInd = await prisma.category.create({ data: { testTypeId: tipoInd.id, name: "Todo competidor", minAge: 5, maxAge: 99 } });
  const catRel = await prisma.category.create({ data: { testTypeId: tipoRel.id, name: "Relevo libre", minAge: 5, maxAge: 400 } });
  const evLibre = await prisma.event.create({ data: { testTypeId: tipoInd.id, distanceId: d50.id, strokeId: libre.id, gender: "mixed" } });
  const evEspalda = await prisma.event.create({ data: { testTypeId: tipoInd.id, distanceId: d50.id, strokeId: espalda.id, gender: "mixed" } });
  const evRelLibre = await prisma.event.create({ data: { testTypeId: tipoRel.id, distanceId: d50.id, strokeId: libre.id, gender: "mixed" } });
  const evRelEspalda = await prisma.event.create({ data: { testTypeId: tipoRel.id, distanceId: d50.id, strokeId: espalda.id, gender: "mixed" } });

  const ahora = new Date();
  const competencia = await prisma.competition.create({
    data: {
      name: "Copa Privacidad",
      status: "open",
      registrationStartAt: new Date(ahora.getTime() - 86_400_000),
      registrationEndAt: new Date(ahora.getTime() + 86_400_000),
      ageCutoffDate: FECHA_DE_CORTE,
    },
  });
  competitionId = competencia.id;
  const fecha = await prisma.competitionDate.create({ data: { competitionId, date: ahora } });
  const sesion = await prisma.competitionSession.create({ data: { competitionDateId: fecha.id, sessionTypeId: manana.id, competitionId } });
  const ce = async (eventId: string, displayOrder: number) => prisma.competitionEvent.create({ data: { competitionId, eventId, competitionSessionId: sesion.id, displayOrder } });
  const ceLibre = await ce(evLibre.id, 1);
  const ceEspalda = await ce(evEspalda.id, 2);
  const ceRelLibre = await ce(evRelLibre.id, 3);
  const ceRelEspalda = await ce(evRelEspalda.id, 4);

  const inscribir = (k: string, clubId: string, ceId: string) =>
    prisma.registration.create({ data: { competitionEventId: ceId, personId: persona[k]!.id, clubId, categoryId: catInd.id, status: "confirmed", registeredByUserId: adminUser.id } });
  for (const k of ["N1", "N2", "D", "AN"]) await inscribir(k, clubA.id, ceLibre.id);
  await inscribir("N1", clubA.id, ceEspalda.id);
  await inscribir("M1", clubB.id, ceLibre.id);

  const equipo = (clubId: string, ceId: string, integrantes: string[]) =>
    prisma.relayRegistration.create({
      data: {
        competitionEventId: ceId,
        clubId,
        categoryId: catRel.id,
        status: "confirmed",
        registeredByUserId: adminUser.id,
        members: { create: integrantes.map((k, i) => ({ personId: persona[k]!.id, orderPosition: i + 1 })) },
      },
    });
  await equipo(clubA.id, ceRelLibre.id, ["N1", "N2", "N3", "N4"]);
  await equipo(clubA.id, ceRelEspalda.id, ["N2", "N1", "N4", "N3"]);
  await equipo(clubB.id, ceRelLibre.id, ["M1", "M2", "M3", "M4"]);

  for (const rol of [...ROLES_ADMIN, ...ROLES_GENERALES]) {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: rol, password: TEST_PASSWORD } });
    if (res.statusCode !== 200) throw new Error(`login de ${rol}: ${res.statusCode}`);
    tokens[rol] = res.json().accessToken as string;
  }
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("AUD-10: JSON del reporte por rol", () => {
  it("administración (también admin + nadador): fecha completa, estructura de siempre", async () => {
    for (const rol of ROLES_ADMIN) {
      const r = await informe(rol);
      expect(r.individualRows.length, rol).toBe(6);
      for (const fila of r.individualRows) {
        expect(Object.keys(fila), rol).toEqual(CLAVES_ADMIN);
        expect(fila.fechaNacimiento, rol).toBe(ddmmyyyy(NACIMIENTOS[claveDeNombre(fila.nombreCompleto as string)]!));
      }
      expect(JSON.stringify(r), rol).not.toContain("RUNPRIV");
    }
  });

  it("los demás roles: edad a la fecha de corte de la competencia, en lugar de la fecha, sin la fecha en ninguna parte", async () => {
    for (const rol of ROLES_GENERALES) {
      const r = await informe(rol);
      expect(r.individualRows.length, rol).toBeGreaterThan(0);
      for (const fila of r.individualRows) {
        expect(Object.keys(fila), rol).toEqual(CLAVES_GENERAL);
        const nac = new Date(NACIMIENTOS[claveDeNombre(fila.nombreCompleto as string)]!);
        expect(fila.edad, `${rol}: ${fila.nombreCompleto}`).toBe(computeAge(nac, FECHA_DE_CORTE));
        expect(fila.categoria, rol).toBe("Todo competidor");
      }
      // Coherente con la vista agrupada, que ya calculaba la edad así.
      const agrupadas = new Map(r.groupedByClub.flatMap((g) => g.swimmers).map((s) => [s.nombreCompleto, s.edad]));
      for (const fila of r.individualRows) expect(fila.edad, rol).toBe(agrupadas.get(fila.nombreCompleto as string));

      const json = JSON.stringify(r);
      for (const iso of Object.values(NACIMIENTOS)) for (const forma of formasDeFecha(iso)) expect(json, `${rol}: «${forma}»`).not.toContain(forma);
      expect(json, rol).not.toMatch(/fechaNacimiento|birthDate|birth_date/i);
      expect(json, rol).not.toContain("RUNPRIV");
    }
    // La fecha de corte importa: a hoy, N1 tendría otra edad.
    const n1 = (await informe("nadador_n1")).individualRows[0]!;
    expect(n1.edad).not.toBe(computeAge(new Date(NACIMIENTOS.N1!), new Date()));
  });

  it("mismas filas, orden, totales y vista agrupada que la administración filtrando por el club", async () => {
    const admin = await informe("admin", `&clubId=${clubAId}`);
    for (const rol of ["club_alfa", "deleg_nad", "coach_a", "replegal_a"]) {
      const r = await informe(rol);
      expect(proyeccion(r.individualRows), rol).toEqual(proyeccion(admin.individualRows));
      expect(r.relayRows, rol).toEqual(admin.relayRows);
      expect(r.groupedByClub, rol).toEqual(admin.groupedByClub);
    }
    // El nadador: solo lo suyo, igual que antes.
    const n1 = await informe("nadador_n1");
    expect(n1.individualRows.map((f) => f.nombreCompleto)).toEqual([nombreDe("N1"), nombreDe("N1")]);
    expect(proyeccion(n1.individualRows)).toEqual(proyeccion(admin.individualRows.filter((f) => f.nombreCompleto === nombreDe("N1"))));
    expect(n1.groupedByClub.flatMap((g) => g.swimmers).map((s) => s.nombreCompleto)).toEqual([nombreDe("N1")]);
  });

  it("filtros: el club no puede pedir otro club (403) y un filtro de prueba acota igual que antes", async () => {
    expect((await get("club_alfa", `/reports/registrations?competitionId=${competitionId}&clubId=${clubBId}`)).statusCode).toBe(403);
    const admin = await informe("admin", `&clubId=${clubAId}&gender=mixed`);
    const delegado = await informe("deleg_nad", `&gender=mixed`);
    expect(proyeccion(delegado.individualRows)).toEqual(proyeccion(admin.individualRows));
  });

  it("sin fecha de corte en la competencia: el mismo fallback de la vista agrupada, no la fecha actual", async () => {
    await prisma.competition.update({ where: { id: competitionId }, data: { ageCutoffDate: null } });
    try {
      const r = await informe("club_alfa");
      const corte = getDefaultAgeCutoffDate();
      const agrupadas = new Map(r.groupedByClub.flatMap((g) => g.swimmers).map((s) => [s.nombreCompleto, s.edad]));
      for (const fila of r.individualRows) {
        expect(fila.edad).toBe(computeAge(new Date(NACIMIENTOS[claveDeNombre(fila.nombreCompleto as string)]!), corte));
        expect(fila.edad).toBe(agrupadas.get(fila.nombreCompleto as string));
      }
    } finally {
      await prisma.competition.update({ where: { id: competitionId }, data: { ageCutoffDate: FECHA_DE_CORTE } });
    }
  });
});

describe("AUD-10: CSV, XLSX y PDF por rol", () => {
  const filasCsv = (csv: string) => {
    const l = csv.split("\r\n");
    return { encabezado: l[1]!, filas: l.slice(2, l.indexOf("")).map((x) => x.split(",")), relevos: l.slice(l.indexOf("RELEVOS")) };
  };

  it("CSV: la administración conserva «Fecha de nacimiento»; los demás, «Edad» en su lugar, con valores alineados", async () => {
    const adminJson = await informe("admin");
    for (const rol of [...ROLES_ADMIN, ...ROLES_GENERALES]) {
      const res = await exportar(rol, "csv");
      expect(res.statusCode, rol).toBe(200);
      const esAdmin = (ROLES_ADMIN as readonly string[]).includes(rol);
      const json = await informe(rol);
      const { encabezado, filas, relevos: rel } = filasCsv(res.body);
      expect(encabezado, rol).toBe(esAdmin ? ENCABEZADOS_ADMIN : ENCABEZADOS_GENERAL);
      expect(rel[1], rol).toBe("Competencia,Club,Prueba,Categoría,Género,Fecha,Jornada,Integrante 1,Integrante 2,Integrante 3,Integrante 4");
      expect(filas, rol).toHaveLength(json.individualRows.length);
      filas.forEach((f, i) => {
        const fila = json.individualRows[i]!;
        expect(f, `${rol} fila ${i}`).toHaveLength(12);
        expect(f[2]).toBe(fila.nombreCompleto);
        expect(f[3]).toBe(esAdmin ? fila.fechaNacimiento : String(fila.edad));
        expect(f[4]).toBe(fila.categoria);
        expect(f[5]).toBe(fila.prueba);
        expect(["'=Club Alfa", "Club Beta"], "club neutralizado").toContain(f[1]);
      });
      expect(filas.some((f) => f[1] === "'=Club Alfa"), rol).toBe(true);
      for (const celda of res.body.split(/[,;\r\n]/)) expect(/^[=+@]/.test(celda.replace(/^"/, "")), `${rol}: «${celda}»`).toBe(false);
      expect(res.body, rol).not.toContain("RUNPRIV");
      if (!esAdmin) for (const iso of Object.values(NACIMIENTOS)) for (const forma of formasDeFecha(iso)) expect(res.body, `${rol}: «${forma}»`).not.toContain(forma);
    }
    expect(adminJson.individualRows).toHaveLength(6);
  });

  it("XLSX: mismos encabezados que el CSV de cada rol, 12 columnas, valores alineados y sin fecha en ninguna parte para los demás", async () => {
    for (const rol of [...ROLES_ADMIN, ...ROLES_GENERALES]) {
      const res = await exportar(rol, "xlsx");
      expect(res.statusCode, rol).toBe(200);
      const esAdmin = (ROLES_ADMIN as readonly string[]).includes(rol);
      const json = await informe(rol);
      const libro = new ExcelJS.Workbook();
      await libro.xlsx.load(res.rawPayload as never);
      const hoja = libro.getWorksheet("Individuales")!;
      expect((hoja.getRow(1).values as unknown[]).slice(1).join(","), rol).toBe(esAdmin ? ENCABEZADOS_ADMIN : ENCABEZADOS_GENERAL);
      expect(hoja.columnCount, rol).toBe(12);
      expect(hoja.rowCount - 1, rol).toBe(json.individualRows.length);
      json.individualRows.forEach((fila, i) => {
        const r = hoja.getRow(i + 2);
        expect(String(r.getCell(3).value)).toBe(fila.nombreCompleto);
        expect(String(r.getCell(4).value)).toBe(esAdmin ? fila.fechaNacimiento : String(fila.edad));
        expect(String(r.getCell(5).value)).toBe(fila.categoria);
        expect(["'=Club Alfa", "Club Beta"], "club neutralizado").toContain(String(r.getCell(2).value));
      });
      expect(libro.getWorksheet("Relevos")!.getRow(1).cellCount, rol).toBe(11);
      for (const parte of new AdmZip(res.rawPayload).getEntries()) {
        const texto = parte.getData().toString("utf8");
        expect(texto, `${rol} ${parte.entryName}`).not.toContain("RUNPRIV");
        if (!esAdmin) for (const iso of Object.values(NACIMIENTOS)) for (const forma of formasDeFecha(iso)) expect(texto, `${rol} ${parte.entryName}: «${forma}»`).not.toContain(forma);
      }
    }
  });

  it("PDF: se sigue generando para todos los roles, sin la fecha de nacimiento (su formato no la incluye)", async () => {
    for (const rol of ["admin", "club_alfa", "nadador_n1"]) {
      const res = await exportar(rol, "pdf");
      expect(res.statusCode, rol).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  });
});

describe("AUD-14: RUN de los integrantes en GET /relay-registrations", () => {
  const runDe = (m: { person: Record<string, unknown> }) => m.person.run;

  it("administración (también admin + nadador): todos los relevos, todos los RUN", async () => {
    for (const rol of ROLES_ADMIN) {
      const r = await relevos(rol);
      expect(r.total, rol).toBe(3);
      for (const item of r.items) for (const m of item.members) expect(runDe(m), rol).toBe(persona[claveDeNombre(m.person.fullName as string)]!.run);
    }
  });

  it("club, delegado (también nadador), entrenador y representante legal: los relevos del club propio, con todos sus RUN", async () => {
    const admin = await relevos("admin", `&clubId=${clubAId}`);
    for (const rol of ["club_alfa", "deleg_nad", "coach_a", "replegal_a"]) {
      const r = await relevos(rol);
      expect(r.total, rol).toBe(2);
      expect(r.items.every((i) => i.clubId === clubAId), rol).toBe(true);
      expect(r.items, rol).toEqual(admin.items);
      for (const item of r.items) for (const m of item.members) expect(typeof runDe(m), rol).toBe("string");
      expect((await get(rol, `/relay-registrations?competitionId=${competitionId}&clubId=${clubBId}`)).statusCode, rol).toBe(403);
    }
  });

  it("nadador: su RUN sí, la propiedad `run` de sus compañeros no; id, nombre, orden y demás datos iguales", async () => {
    const admin = await relevos("admin", `&clubId=${clubAId}`);
    const r = await relevos("nadador_n1");
    expect(r.total).toBe(2);
    expect(r.items.map((i) => i.id)).toEqual(admin.items.map((i) => i.id));
    for (const [n, item] of r.items.entries()) {
      const delAdmin = admin.items[n]!;
      expect(item.members.map((m) => m.orderPosition)).toEqual([1, 2, 3, 4]);
      for (const [j, m] of item.members.entries()) {
        if (m.personId === persona.N1!.id) {
          expect(m.person.run).toBe(persona.N1!.run);
          expect(m).toEqual(delAdmin.members[j]);
        } else {
          expect("run" in m.person, `compañero ${m.person.fullName}`).toBe(false);
          // Tampoco recibe la edad al corte de sus compañeros (se deriva de su fecha de
          // nacimiento); administración sí. Es la única otra diferencia, y es una medida
          // adicional de la edad en los paneles, no una decisión de AUD-14 (que regula el RUN).
          expect("edadAlCorte" in m, `edad de ${m.person.fullName}`).toBe(false);
          expect(typeof (delAdmin.members[j] as { edadAlCorte?: unknown }).edadAlCorte).toBe("number");
          const { run: _r, ...sinRun } = delAdmin.members[j]!.person;
          const { edadAlCorte: _e, ...miembroSinEdad } = delAdmin.members[j] as typeof delAdmin.members[number] & { edadAlCorte?: number };
          expect(m).toEqual({ ...miembroSinEdad, person: sinRun });
        }
      }
      expect({ ...item, members: null }).toEqual({ ...delAdmin, members: null });
    }
    const json = JSON.stringify(r);
    for (const k of ["N2", "N3", "N4", "M1", "M2", "M3", "M4", "D", "AN"]) expect(json, k).not.toContain(persona[k]!.run);
  });

  it("nadador: paginación y total sin cambios, y un `clubId` del cliente no amplía lo visible", async () => {
    const completo = await relevos("nadador_n1");
    const p1 = await relevos("nadador_n1", "&page=1&pageSize=1");
    const p2 = await relevos("nadador_n1", "&page=2&pageSize=1");
    expect([p1.total, p2.total, p1.pageSize, p1.page, p2.page]).toEqual([2, 2, 1, 1, 2]);
    expect([...p1.items, ...p2.items]).toEqual(completo.items);

    const conOtroClub = await relevos("nadador_n1", `&clubId=${clubBId}`);
    expect(conOtroClub.total).toBe(2);
    expect(conOtroClub.items.every((i) => i.clubId === clubAId)).toBe(true);
    expect(JSON.stringify(conOtroClub)).not.toMatch(/RUNPRIV1[1-4]/);
  });
});
