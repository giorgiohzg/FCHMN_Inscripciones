/**
 * Reporte DETALLADO (integración, flujo HTTP real): fechas y jornadas reales, filtros, alcances y
 * coincidencia del JSON que recibe la pantalla con los archivos exportados con los mismos filtros.
 *
 * Datos sintéticos; solo la base desechable de `docker-compose.test.yml` (el guard de `testDb.ts` lo exige).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createUser, createPerson, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";
import { formatSwimTimeReadable } from "../src/shared/swimTime.util";
import { bloqueDe, leerHojaDetallada, textoDe } from "./helpers/reporteDetalladoSintetico";
import { enDosBloques, textoDelClub, textoDelNadador, type ReporteDetallado } from "../src/modules/reports/reporteDetallado.rules";

let app: FastifyInstance;
const tokens: Record<string, string> = {};
const id: Record<string, string> = {};

const get = (rol: string, ruta: string, filtros: Record<string, string> = {}) =>
  app.inject({
    method: "GET",
    url: `${ruta}?${new URLSearchParams({ competitionId: id.competencia!, ...filtros })}`,
    headers: { authorization: `Bearer ${tokens[rol]}` },
  });
async function informe(rol: string, filtros: Record<string, string> = {}): Promise<ReporteDetallado> {
  const res = await get(rol, "/reports/registrations", filtros);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** «Persona: jornada → pruebas», para comparar de un vistazo. */
const resumen = (r: ReporteDetallado) =>
  Object.fromEntries(r.groupedByClub.flatMap((c) => c.swimmers).map((s) => [s.nombrePresentado, s.jornadas.map((j) => `${j.titulo}: ${j.pruebas.map((p) => `${p.numero ?? "-"} ${textoDe(p)}`).join(" | ")}`)]));

/** Lo que debe leerse en el Excel de un reporte: títulos y filas de dos bloques, con su tiempo. */
const hojaEsperada = (r: ReporteDetallado) =>
  r.groupedByClub.map((c) => ({
    club: textoDelClub(c),
    nadadores: c.swimmers.map((s) => ({
      linea: `${s.numero}. ${textoDelNadador(s)}`,
      filas: s.jornadas.flatMap((j) => enDosBloques(j.pruebas).map((f) => ({ jornada: j.titulo, bloques: [f.izquierda, f.derecha].flatMap((p) => (p ? [bloqueDe(p)] : [])) }))),
    })),
  }));

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();

  const admin = await createUser({ username: "admin_det", roleNames: ["admin"] });
  const clubA = await createClub("Club Alfa", "DETA", "club_det_a");
  const clubB = await createClub("Club Beta", "DETB", "club_det_b");
  id.clubA = clubA.id;
  id.clubB = clubB.id;
  await createUser({ username: "club_det_a", roleNames: ["club"], clubId: clubA.id });

  const persona = async (k: string, n: number, clubId: string, paterno: string | null, materno: string | null, nombre: string) => {
    const p = await createPerson({ run: `RUNDET${n}`, username: `det_${k}`, firstName: nombre, gender: n % 2 ? "female" : "male" });
    await prisma.person.update({ where: { id: p.id }, data: { firstName: paterno ? nombre : null, paternalLastName: paterno, maternalLastName: materno, birthDate: new Date("1984-05-10") } });
    await addActiveMembership(clubId, p.id, admin.id);
    id[k] = p.id;
  };
  await persona("ana", 1, clubA.id, "Prueba", "Sintética", "Ana");
  await persona("bruno", 2, clubA.id, "Ñandú", null, "Bruno");
  await persona("carla", 3, clubA.id, "Zeta", "Uno", "Carla");
  await persona("diego", 4, clubA.id, "Ávila", "Dos", "Diego"); // solo relevos
  await persona("elisa", 5, clubB.id, "Beta", "Tres", "Elisa");
  await createUser({ username: "det_ana", roleNames: ["swimmer"], personId: id.ana });

  const tipoInd = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
  const tipoRel = await prisma.testType.create({ data: { name: "Relevo", swimmersCount: 4 } });
  const catInd = await prisma.category.create({ data: { testTypeId: tipoInd.id, name: "Master D", minAge: 5, maxAge: 99 } });
  const catRel = await prisma.category.create({ data: { testTypeId: tipoRel.id, name: "Relevo 160-199", minAge: 5, maxAge: 400 } });
  const libre = await prisma.stroke.create({ data: { name: "Libre" } });
  const pecho = await prisma.stroke.create({ data: { name: "Pecho" } });
  const distancia: Record<number, string> = {};
  for (const m of [50, 100, 200]) distancia[m] = (await prisma.distance.create({ data: { meters: m } })).id;
  const evento = async (tipo: string, m: number, estilo: string) =>
    (await prisma.event.create({ data: { testTypeId: tipo, distanceId: distancia[m]!, strokeId: estilo, gender: "mixed" } })).id;

  const ahora = Date.now();
  const competencia = await prisma.competition.create({
    data: {
      name: "CAMPEONATO SINTÉTICO",
      status: "open",
      registrationStartAt: new Date(ahora - 86_400_000),
      registrationEndAt: new Date(ahora + 86_400_000),
      ageCutoffDate: new Date("2027-12-31"),
    },
  });
  id.competencia = competencia.id;
  const tipoJornada: Record<string, string> = {};
  for (const n of ["Tarde", "Mañana", "Especial", "Noche"]) tipoJornada[n] = (await prisma.sessionType.create({ data: { name: n } })).id;
  id.tipoManana = tipoJornada["Mañana"]!;

  // Fechas y sesiones creadas en desorden.
  const sesion: Record<string, string> = {};
  for (const [clave, dia, jornadas] of [
    ["jue", "2027-01-07", ["Especial", "Noche", "Mañana"]],
    ["mie", "2027-01-06", ["Tarde", "Mañana"]],
  ] as const) {
    const fecha = await prisma.competitionDate.create({ data: { competitionId: competencia.id, date: new Date(`${dia}T00:00:00.000Z`) } });
    id[clave] = fecha.id;
    for (const j of jornadas) sesion[`${clave}${j}`] = (await prisma.competitionSession.create({ data: { competitionDateId: fecha.id, sessionTypeId: tipoJornada[j]!, competitionId: competencia.id } })).id;
  }
  const prueba = async (k: string, s: string, n: number | null, eventId: string) => {
    id[k] = (await prisma.competitionEvent.create({ data: { competitionId: competencia.id, eventId, competitionSessionId: sesion[s]!, displayOrder: n } })).id;
  };
  const l50 = await evento(tipoInd.id, 50, libre.id);
  const l100 = await evento(tipoInd.id, 100, libre.id);
  const l200 = await evento(tipoInd.id, 200, libre.id);
  const p50 = await evento(tipoInd.id, 50, pecho.id);
  const p100 = await evento(tipoInd.id, 100, pecho.id);
  const rel = await evento(tipoRel.id, 200, libre.id);
  await prueba("mie10", "mieMañana", 10, l50);
  await prueba("mie2", "mieMañana", 2, l100);
  await prueba("mieSin", "mieMañana", null, l200);
  await prueba("mieT", "mieTarde", 12, p50);
  await prueba("jue5", "jueMañana", 20, p100);
  await prueba("jueRel", "jueMañana", 21, rel);
  // La noche abre antes el programa, pero con una prueba en que NADIE del filtro está inscrito.
  await prueba("jueN30", "jueNoche", 30, l100);
  await prueba("jueN60", "jueNoche", 60, l50);
  await prueba("jueE40", "jueEspecial", 40, l200);

  const inscribir = (k: string, clubId: string, ce: string, marca: number | null = null) =>
    prisma.registration.create({ data: { competitionEventId: id[ce]!, personId: id[k]!, clubId, categoryId: catInd.id, status: "confirmed", seedTimeCentiseconds: marca, registeredByUserId: admin.id } });
  await inscribir("ana", clubA.id, "jue5", 9907);
  await inscribir("ana", clubA.id, "mie10");
  await inscribir("ana", clubA.id, "mieSin");
  await inscribir("ana", clubA.id, "mie2", 78308);
  await inscribir("ana", clubA.id, "jueE40");
  await inscribir("ana", clubA.id, "jueN60");
  await inscribir("bruno", clubA.id, "mieT", 4510);
  await inscribir("carla", clubA.id, "mie2");
  await inscribir("elisa", clubB.id, "jueN30");
  await prisma.registration.create({
    data: { competitionEventId: id.mieT!, personId: id.ana!, clubId: clubA.id, categoryId: catInd.id, status: "cancelled", registeredByUserId: admin.id },
  });
  await prisma.relayRegistration.create({
    data: {
      competitionEventId: id.jueRel!,
      clubId: clubA.id,
      categoryId: catRel.id,
      status: "confirmed",
      seedTimeCentiseconds: 13534,
      registeredByUserId: admin.id,
      members: { create: ["ana", "bruno", "carla", "diego"].map((k, i) => ({ personId: id[k]!, orderPosition: i + 1 })) },
    },
  });

  for (const rol of ["admin_det", "club_det_a", "det_ana"]) {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: rol, password: TEST_PASSWORD } });
    tokens[rol] = res.json().accessToken as string;
  }
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const ANA = [
  "06-01-2027 Mañana: 2 100m Libre 13:03,08 | 10 50m Libre | - 200m Libre",
  "07-01-2027 Mañana: 20 100m Pecho 1:39,07 | 21 Relevo 200m Libre (Mixto) 2:15,34",
  "07-01-2027 Noche: 60 50m Libre",
  "07-01-2027 Especial: 40 200m Libre",
];
const RELEVO = "07-01-2027 Mañana: 21 Relevo 200m Libre (Mixto) 2:15,34";

describe("jerarquía con datos reales", () => {
  it("fechas y jornadas reales, orden de programa, solo relevos, canceladas fuera y totales por equipo", async () => {
    const r = await informe("admin_det");
    expect(r.groupedByClub.map(textoDelClub)).toEqual([
      "Club Alfa (4 nadadores, 8 pruebas individuales, 1 relevos)",
      "Club Beta (1 nadadores, 1 pruebas individuales, 0 relevos)",
    ]);
    expect(r.groupedByClub[0]!.swimmers.map((s) => `${s.numero}. ${textoDelNadador(s)}`)).toEqual([
      "1. ÁVILA DOS, DIEGO (43) - Relevo 160-199 - Varones",
      "2. ÑANDÚ, BRUNO (43) - Master D - Varones",
      "3. PRUEBA SINTÉTICA, ANA (43) - Master D - Damas",
      "4. ZETA UNO, CARLA (43) - Master D - Damas",
    ]);
    expect(resumen(r)).toEqual({
      "ÁVILA DOS, DIEGO": [RELEVO],
      "ÑANDÚ, BRUNO": ["06-01-2027 Tarde: 12 50m Pecho 0:45,10", RELEVO],
      // La noche (programa desde el 30) va antes que la especial (40), aunque Ana nade allí la 60.
      "PRUEBA SINTÉTICA, ANA": ANA,
      "ZETA UNO, CARLA": ["06-01-2027 Mañana: 2 100m Libre", RELEVO],
      "BETA TRES, ELISA": ["07-01-2027 Noche: 30 100m Libre"],
    });
  });

  it("filtros por club, fecha, jornada y prueba: acotan sin cambiar el orden ni los textos", async () => {
    const todo = await informe("admin_det");
    expect((await informe("admin_det", { clubId: id.clubA! })).groupedByClub).toEqual([todo.groupedByClub[0]]);
    expect(resumen(await informe("admin_det", { competitionDateId: id.mie! }))["PRUEBA SINTÉTICA, ANA"]).toEqual([ANA[0]]);
    expect(resumen(await informe("admin_det", { competitionDateId: id.jue! }))["PRUEBA SINTÉTICA, ANA"]).toEqual(ANA.slice(1));
    // La jornada «Mañana» existe los dos días: salen ambas, separadas.
    expect(resumen(await informe("admin_det", { sessionTypeId: id.tipoManana! }))["PRUEBA SINTÉTICA, ANA"]).toEqual(ANA.slice(0, 2));
    expect(resumen(await informe("admin_det", { competitionDateId: id.jue!, sessionTypeId: id.tipoManana! }))["PRUEBA SINTÉTICA, ANA"]).toEqual([ANA[1]]);
    const soloRelevo = await informe("admin_det", { competitionEventId: id.jueRel! });
    expect(soloRelevo.groupedByClub.map(textoDelClub)).toEqual(["Club Alfa (4 nadadores, 0 pruebas individuales, 1 relevos)"]);
  });

  it("alcances: el club solo lo suyo, el nadador solo su línea (sin compañeros de relevo), y otro club responde 403", async () => {
    const todo = await informe("admin_det");
    expect((await informe("club_det_a")).groupedByClub).toEqual([todo.groupedByClub[0]]);
    const ana = await informe("det_ana");
    expect(resumen(ana)).toEqual({ "PRUEBA SINTÉTICA, ANA": ANA });
    expect(ana.groupedByClub[0]!.totalesTexto).toBe("1 nadadores, 6 pruebas individuales, 1 relevos");
    for (const ruta of ["/reports/registrations", "/reports/registrations/export"]) {
      expect((await get("club_det_a", ruta, { clubId: id.clubB!, format: "csv" })).statusCode).toBe(403);
    }
  });
});

describe("tiempos, con el servicio real", () => {
  it("cada tiempo es el guardado en SU inscripción, con sus centésimas; sin tiempo guardado, «Sin tiempo»", async () => {
    const r = await informe("admin_det");
    const presentados = r.groupedByClub.flatMap((c) => c.swimmers.flatMap((s) => s.jornadas.flatMap((j) => j.pruebas.map((p) => [c.clubId, s.personId, p.numero, p.tipo, p.tiempo, p.tiempoTexto].join("|")))));
    const guardados = [
      ...(await prisma.registration.findMany({ where: { status: "confirmed", competitionEvent: { competitionId: id.competencia } }, include: { competitionEvent: true } })).map((x) =>
        [x.clubId, x.personId, x.competitionEvent.displayOrder, "individual", x.seedTimeCentiseconds === null ? null : formatSwimTimeReadable(x.seedTimeCentiseconds), x.seedTimeCentiseconds === null ? "Sin tiempo" : formatSwimTimeReadable(x.seedTimeCentiseconds)].join("|")
      ),
      ...(await prisma.relayRegistration.findMany({ where: { competitionEvent: { competitionId: id.competencia } }, include: { competitionEvent: true, members: true } })).flatMap((x) =>
        x.members.map((m) => [x.clubId, m.personId, x.competitionEvent.displayOrder, "relevo", formatSwimTimeReadable(x.seedTimeCentiseconds), formatSwimTimeReadable(x.seedTimeCentiseconds)].join("|"))
      ),
    ];
    expect(presentados.sort()).toEqual(guardados.sort());
    expect(presentados.some((p) => p.endsWith("|Sin tiempo"))).toBe(true);
    expect(presentados.some((p) => p.endsWith("|1:39,07"))).toBe(true);
  });

  it("un 0 guardado sigue siendo un tiempo guardado, no una ausencia", async () => {
    const una = await prisma.registration.findFirstOrThrow({ where: { personId: id.carla, status: "confirmed", competitionEvent: { competitionId: id.competencia } } });
    expect(una.seedTimeCentiseconds).toBeNull();
    await prisma.registration.update({ where: { id: una.id }, data: { seedTimeCentiseconds: 0 } });
    try {
      expect(resumen(await informe("admin_det"))["ZETA UNO, CARLA"]![0]).toBe("06-01-2027 Mañana: 2 100m Libre 0:00,00");
    } finally {
      await prisma.registration.update({ where: { id: una.id }, data: { seedTimeCentiseconds: null } });
    }
  });
});

describe("archivos: los mismos datos y totales que la pantalla, con los mismos filtros y alcance", () => {
  const CASOS: [string, () => Record<string, string>][] = [
    ["admin_det", () => ({})],
    ["admin_det", () => ({ clubId: id.clubB! })],
    ["admin_det", () => ({ competitionDateId: id.jue! })],
    ["admin_det", () => ({ sessionTypeId: id.tipoManana! })],
    ["club_det_a", () => ({})],
    ["det_ana", () => ({})],
  ];

  it("CSV y Excel coinciden con el JSON, y no llevan RUN ni nacimiento", async () => {
    for (const [rol, f] of CASOS) {
      const contexto = `${rol} ${JSON.stringify(f())}`;
      const r = await informe(rol, f());
      const pruebas = r.groupedByClub.flatMap((c) =>
        c.swimmers.flatMap((s) => s.jornadas.flatMap((j) => j.pruebas.map((p) => [c.clubName, s.nombrePresentado, j.fecha, j.jornada, p.numero === null ? "" : String(p.numero), p.descripcion, p.tiempoTexto])))
      );
      expect(pruebas.length, contexto).toBeGreaterThan(0);

      const csv = await get(rol, "/reports/registrations/export", { ...f(), format: "csv" });
      expect(csv.statusCode, contexto).toBe(200);
      const filas = csv.body
        .replace("﻿", "")
        .split("\r\n")
        .map((l) => l.split(";").map((c) => c.replace(/^"|"$/g, "").trim()));
      const i = (h: string) => filas[0]!.indexOf(h);
      expect(
        filas.filter((x) => x[0] === "Prueba").map((x) => ["Club", "Nadador", "Fecha", "Jornada", "N° prueba", "Prueba", "Tiempo"].map((h) => x[i(h)])),
        contexto
      ).toEqual(pruebas);
      expect(
        filas.filter((x) => x[0] === "Club").map((x) => `${x[i("Club")]} (${x[i("Total nadadores")]} nadadores, ${x[i("Total pruebas individuales")]} pruebas individuales, ${x[i("Total relevos")]} relevos)`),
        contexto
      ).toEqual(r.groupedByClub.map(textoDelClub));
      expect(csv.body, contexto).not.toMatch(/RUNDET|1984/);

      const xlsx = await get(rol, "/reports/registrations/export", { ...f(), format: "xlsx" });
      const libro = new ExcelJS.Workbook();
      await libro.xlsx.load(xlsx.rawPayload as never);
      expect(leerHojaDetallada(libro.worksheets[0]!), contexto).toEqual(hojaEsperada(r));

      const pdf = await get(rol, "/reports/registrations/export", { ...f(), format: "pdf" });
      expect(pdf.rawPayload.subarray(0, 5).toString("latin1"), contexto).toBe("%PDF-");
    }
  });
});

/**
 * Una misma persona con inscripciones guardadas en dos clubes de la competencia (cambió de club entre
 * una y otra). Cada inscripción queda bajo el club que tiene GUARDADO, no bajo la membresía vigente.
 */
describe("persona con inscripciones en dos clubes", () => {
  const competencia = () => ({ competitionId: id.dosClubes! });
  let filasEsperadas: string[] = [];

  beforeAll(async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { username: "admin_det" } });
    const clubA = await prisma.club.findUniqueOrThrow({ where: { id: id.clubA } });
    const clubB = await prisma.club.findUniqueOrThrow({ where: { id: id.clubB } });
    const persona = async (k: string, n: number, nombre: string, paterno: string, materno: string, clubVigente: string) => {
      const p = await createPerson({ run: `RUNDOS${n}`, username: `dos_${k}`, firstName: nombre, gender: "female" });
      await prisma.person.update({
        where: { id: p.id },
        data: { firstName: nombre, paternalLastName: paterno, maternalLastName: materno, fullName: `${nombre} ${paterno} ${materno}`, birthDate: new Date("1984-05-10") },
      });
      await addActiveMembership(clubVigente, p.id, admin.id);
      id[k] = p.id;
    };
    // La membresía vigente de Dora es la de B; sus inscripciones están en A y en B.
    await persona("dora", 1, "Dora", "Doble", "Club", clubB.id);
    await persona("doraHomonima", 2, "Dora", "Doble", "Club", clubA.id);
    await persona("gala", 3, "Gala", "Única", "Beta", clubB.id);
    await persona("hilda", 4, "Hilda", "Única", "Beta", clubB.id);
    await persona("irma", 5, "Irma", "Única", "Beta", clubB.id);
    await createUser({ username: "dos_dora", roleNames: ["swimmer"], personId: id.dora });

    const base = await prisma.competition.findUniqueOrThrow({ where: { id: id.competencia } });
    const c = await prisma.competition.create({
      data: { name: "CAMPEONATO DE DOS CLUBES", status: "open", registrationStartAt: base.registrationStartAt, registrationEndAt: base.registrationEndAt, ageCutoffDate: base.ageCutoffDate },
    });
    id.dosClubes = c.id;
    const ce: Record<string, string> = {};
    for (const [dia, jornada, pruebas] of [
      ["2027-02-06", "Mañana", [["i1", 1, 50, "Individual"], ["i2", 2, 100, "Individual"]]],
      ["2027-02-07", "Tarde", [["i3", 3, 200, "Individual"], ["rel", 4, 200, "Relevo"]]],
    ] as const) {
      const fecha = await prisma.competitionDate.create({ data: { competitionId: c.id, date: new Date(`${dia}T00:00:00.000Z`) } });
      const tipoJornada = await prisma.sessionType.findUniqueOrThrow({ where: { name: jornada } });
      const s = await prisma.competitionSession.create({ data: { competitionDateId: fecha.id, sessionTypeId: tipoJornada.id, competitionId: c.id } });
      for (const [k, n, metros, tipo] of pruebas) {
        const evento = await prisma.event.findFirstOrThrow({ where: { distance: { meters: metros }, stroke: { name: "Libre" }, testType: { name: tipo } } });
        ce[k] = (await prisma.competitionEvent.create({ data: { competitionId: c.id, eventId: evento.id, competitionSessionId: s.id, displayOrder: n } })).id;
      }
    }
    const catInd = await prisma.category.findFirstOrThrow({ where: { name: "Master D" } });
    const catIndB = await prisma.category.create({ data: { testTypeId: (await prisma.testType.create({ data: { name: "Individual B", swimmersCount: 1 } })).id, name: "Master E", minAge: 5, maxAge: 99 } });
    const catRel = await prisma.category.findFirstOrThrow({ where: { name: "Relevo 160-199" } });
    const inscribir = (k: string, clubId: string, prueba: string, categoryId: string, marca: number | null) =>
      prisma.registration.create({ data: { competitionEventId: ce[prueba]!, personId: id[k]!, clubId, categoryId, status: "confirmed", seedTimeCentiseconds: marca, registeredByUserId: admin.id } });
    await inscribir("dora", clubA.id, "i1", catInd.id, 3512);
    await inscribir("dora", clubB.id, "i3", catIndB.id, 15000);
    await inscribir("doraHomonima", clubA.id, "i2", catInd.id, 8000);
    await prisma.relayRegistration.create({
      data: {
        competitionEventId: ce.rel!,
        clubId: clubB.id,
        categoryId: catRel.id,
        status: "confirmed",
        seedTimeCentiseconds: 13534,
        registeredByUserId: admin.id,
        members: { create: ["dora", "gala", "hilda", "irma"].map((k, i) => ({ personId: id[k]!, orderPosition: i + 1 })) },
      },
    });
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "dos_dora", password: TEST_PASSWORD } });
    tokens.dos_dora = login.json().accessToken as string;

    // Lo GUARDADO, leído directamente de la base: club | persona | fecha | jornada | número | marca.
    const incluir = { club: true, competitionEvent: { include: { competitionSession: { include: { sessionType: true, competitionDate: true } } } } } as const;
    const clave = (x: { club: { name: string }; seedTimeCentiseconds: number | null; competitionEvent: { displayOrder: number | null; competitionSession: { sessionType: { name: string }; competitionDate: { date: Date } } } }, personId: string) =>
      [x.club.name, personId, x.competitionEvent.competitionSession.competitionDate.date.toISOString().slice(0, 10).split("-").reverse().join("-"), x.competitionEvent.competitionSession.sessionType.name, x.competitionEvent.displayOrder, formatSwimTimeReadable(x.seedTimeCentiseconds)].join("|");
    const ind = await prisma.registration.findMany({ where: { competitionEvent: { competitionId: c.id } }, include: incluir });
    const rel = await prisma.relayRegistration.findMany({ where: { competitionEvent: { competitionId: c.id } }, include: { ...incluir, members: true } });
    filasEsperadas = [...ind.map((x) => clave(x, x.personId)), ...rel.flatMap((x) => x.members.map((m) => clave(x, m.personId)))].sort();
  });

  const relacion = (r: ReporteDetallado) =>
    r.groupedByClub
      .flatMap((c) => c.swimmers.flatMap((s) => s.jornadas.flatMap((j) => j.pruebas.map((p) => [c.clubName, s.personId, j.fecha, j.jornada, p.numero, p.tiempo ?? "Sin tiempo"].join("|")))))
      .sort();
  const REL = "07-02-2027 Tarde: 4 Relevo 200m Libre (Mixto) 2:15,34";
  const ALFA = { club: "Club Alfa (2 nadadores, 2 pruebas individuales, 0 relevos)", nadadores: [["DOBLE CLUB, DORA (43) - Master D - Damas", "06-02-2027 Mañana: 1 50m Libre 0:35,12"], ["DOBLE CLUB, DORA (43) - Master D - Damas", "06-02-2027 Mañana: 2 100m Libre 1:20,00"]] };
  const BETA = {
    club: "Club Beta (4 nadadores, 1 pruebas individuales, 1 relevos)",
    nadadores: [["DOBLE CLUB, DORA (43) - Master E - Damas", `07-02-2027 Tarde: 3 200m Libre 2:30,00 | ${REL.split(": ").slice(1).join(": ")}`], ["ÚNICA BETA, GALA (43) - Relevo 160-199 - Damas", REL], ["ÚNICA BETA, HILDA (43) - Relevo 160-199 - Damas", REL], ["ÚNICA BETA, IRMA (43) - Relevo 160-199 - Damas", REL]],
  };
  const vista = (r: ReporteDetallado) =>
    r.groupedByClub.map((c) => ({
      club: textoDelClub(c),
      nadadores: c.swimmers.map((s) => [textoDelNadador(s), ...s.jornadas.map((j) => `${j.titulo}: ${j.pruebas.map((p) => `${p.numero} ${textoDe(p)}`).join(" | ")}`)]),
    }));

  it("sin filtro: la estructura agrupada conserva la relación club/persona/inscripción de la base", async () => {
    const r = await informe("admin_det", competencia());
    expect(relacion(r)).toEqual(filasEsperadas);
    expect(vista(r)).toEqual([ALFA, BETA]);
    expect(r.groupedByClub.map((c) => c.clubId)).toEqual([id.clubA, id.clubB]);
    expect(r.groupedByClub.map((c) => c.swimmers.some((s) => s.personId === id.dora))).toEqual([true, true]);
  });

  it("las filas planas del JSON y la estructura agrupada tienen la misma distribución por club", async () => {
    const res = await get("admin_det", "/reports/registrations", competencia());
    const r = res.json() as ReporteDetallado & { individualRows: Record<string, string>[]; relayRows: Record<string, string>[] };
    const planas = [
      ...r.individualRows.map((f) => [f.club, f.nombreCompleto, f.fecha, f.jornada, f.prueba, "individual"].join("|")),
      ...r.relayRows.flatMap((f) => [f.integrante1, f.integrante2, f.integrante3, f.integrante4].map((n) => [f.equipoClub, n, f.fecha, f.jornada, f.prueba, "relevo"].join("|"))),
    ];
    const agrupadas = r.groupedByClub.flatMap((c) =>
      c.swimmers.flatMap((s) =>
        s.jornadas.flatMap((j) => j.pruebas.map((p) => [c.clubName, s.nombreCompleto, j.fecha, j.jornada, p.descripcion.replace(/^Relevo (.*) \(.*\)$/, "$1"), p.tipo].join("|")))
      )
    );
    expect(agrupadas.sort()).toEqual(planas.sort());
  });

  it("filtrado por cada club y con el alcance de la cuenta del club: solo su parte, idéntica a la de sin filtro", async () => {
    expect(vista(await informe("admin_det", { ...competencia(), clubId: id.clubA! }))).toEqual([ALFA]);
    expect(vista(await informe("admin_det", { ...competencia(), clubId: id.clubB! }))).toEqual([BETA]);
    // La cuenta del club A no ve la inscripción que la misma persona tiene en B.
    expect(vista(await informe("club_det_a", competencia()))).toEqual([ALFA]);
  });

  it("alcance de la nadadora: solo lo suyo, en cada uno de sus dos clubes, sin su homónima ni sus compañeras de relevo", async () => {
    const r = await informe("dos_dora", competencia());
    expect(vista(r)).toEqual([
      { club: "Club Alfa (1 nadadores, 1 pruebas individuales, 0 relevos)", nadadores: [ALFA.nadadores[0]] },
      { club: "Club Beta (1 nadadores, 1 pruebas individuales, 1 relevos)", nadadores: [BETA.nadadores[0]] },
    ]);
    expect(new Set(r.groupedByClub.flatMap((c) => c.swimmers).map((s) => s.personId))).toEqual(new Set([id.dora]));
  });

  it("los tres archivos, por HTTP: CSV y Excel con la misma distribución; PDF generado", async () => {
    const filtros: Record<string, string>[] = [{}, { clubId: id.clubA! }, { clubId: id.clubB! }];
    for (const filtro of filtros) {
      const r = await informe("admin_det", { ...competencia(), ...filtro });
      const csv = (await get("admin_det", "/reports/registrations/export", { ...competencia(), ...filtro, format: "csv" })).body.replace("\uFEFF", "");
      const filas = csv.split("\r\n").map((l) => l.split(";").map((c) => c.replace(/^"|"$/g, "").trim()));
      const col = (f: string[], h: string) => f[filas[0]!.indexOf(h)];
      expect(filas.filter((f) => f[0] === "Prueba").map((f) => ["Club", "N° nadador", "Nadador", "Categoría", "Fecha", "Jornada", "N° prueba", "Prueba", "Tiempo"].map((h) => col(f, h)).join("|"))).toEqual(
        r.groupedByClub.flatMap((c) =>
          c.swimmers.flatMap((s) => s.jornadas.flatMap((j) => j.pruebas.map((p) => [c.clubName, s.numero, s.nombrePresentado, s.categoria, j.fecha, j.jornada, p.numero, p.descripcion, p.tiempoTexto].join("|"))))
        )
      );
      const libro = new ExcelJS.Workbook();
      await libro.xlsx.load((await get("admin_det", "/reports/registrations/export", { ...competencia(), ...filtro, format: "xlsx" })).rawPayload as never);
      expect(leerHojaDetallada(libro.worksheets[0]!)).toEqual(hojaEsperada(r));
      expect((await get("admin_det", "/reports/registrations/export", { ...competencia(), ...filtro, format: "pdf" })).rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  });
});
