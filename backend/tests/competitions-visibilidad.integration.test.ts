/**
 * Cambio 6 — visibilidad de competencias en los desplegables de inscripción y relevos.
 *
 * DEFINICIÓN. Ocultar una competencia solo la quita del selector del Panel de
 * Inscripción y del Panel de Relevos, para todos los roles (el administrador
 * incluido). No toca permisos, accesos directos, reglas de inscripción, Reportes
 * ni los asistentes.
 *
 * MECANISMO. Un filtro EXPLÍCITO del listado, `visibleInRegistrationPanels`, que
 * envían únicamente esos dos paneles. Omitido, el listado se comporta como
 * siempre. Se prueba por HTTP, para que el parseo de la consulta sea el real —en
 * particular que el texto `false` NO se interprete como verdadero—, y con datos
 * mezclados de visibles, ocultas, borradores, programadas y finalizadas para
 * comprobar que el filtro SE SUMA a las restricciones por rol y estado en vez de
 * pisarlas, y que resultados, total y paginación salen de la misma condición.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { buildServer } from "../src/server";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";
import * as competitionsService from "../src/modules/competitions/competitions.service";
import * as structureService from "../src/modules/competitions/competition-structure.service";
import * as competitionEventsService from "../src/modules/competitions/competition-events.service";
import * as registrationsService from "../src/modules/registrations/registrations.service";
import * as relayService from "../src/modules/relay-registrations/relay-registrations.service";
import * as catalogsCategories from "../src/modules/catalogs/categories.service";
import * as catalogsEvents from "../src/modules/catalogs/events.service";
import * as reportsService from "../src/modules/reports/reports.service";

let app: FastifyInstance;
let adminToken: string;
let clubToken: string;
let ADMIN: { userId: string; isAdmin: true; scope: { kind: "admin" }; canRegisterPostClose: boolean };
let CLUB_ACTOR: { userId: string; isAdmin: false; scope: { kind: "club"; clubId: string }; canRegisterPostClose: boolean };
let SYSTEM: { userId: string };
let clubId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const DIA = 86_400_000;

async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username} devolvió ${res.statusCode}: ${res.body}`);
  return res.json().accessToken as string;
}

interface Pagina {
  items: { id: string; name: string; visibleInRegistrationPanels: boolean }[];
  total: number;
  page: number;
  pageSize: number;
}

async function listar(token: string, params: Record<string, string | number> = {}) {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString();
  const res = await app.inject({ method: "GET", url: `/competitions${query ? `?${query}` : ""}`, headers: auth(token) });
  return { status: res.statusCode, body: res.json() as Pagina };
}

/** Recorre TODAS las páginas y devuelve los nombres, el total que informó cada una y las filas vistas. */
async function recorrer(token: string, params: Record<string, string | number>, pageSize: number) {
  const nombres: string[] = [];
  const totales = new Set<number>();
  for (let page = 1; page < 50; page++) {
    const { status, body } = await listar(token, { ...params, page, pageSize });
    expect(status).toBe(200);
    totales.add(body.total);
    nombres.push(...body.items.map((i) => i.name));
    if (body.items.length === 0 || nombres.length >= body.total) break;
  }
  return { nombres, totales: [...totales] };
}

/**
 * Datos mezclados. El nombre dice qué es: V = visible, H = oculta (Hidden).
 * Las fechas de inicio van distintas y descendentes para que el orden sea total.
 */
const CATALOGO: { nombre: string; estado: "open" | "draft" | "scheduled" | "finished"; visible: boolean }[] = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ nombre: `Abierta V${n}`, estado: "open" as const, visible: true })),
  ...[1, 2, 3, 4].map((n) => ({ nombre: `Abierta H${n}`, estado: "open" as const, visible: false })),
  { nombre: "Borrador V", estado: "draft", visible: true },
  { nombre: "Borrador H", estado: "draft", visible: false },
  { nombre: "Programada V", estado: "scheduled", visible: true },
  { nombre: "Programada H", estado: "scheduled", visible: false },
  { nombre: "Finalizada V", estado: "finished", visible: true },
  { nombre: "Finalizada H", estado: "finished", visible: false },
];
const nombresDe = (f: (c: (typeof CATALOGO)[number]) => boolean) => CATALOGO.filter(f).map((c) => c.nombre).sort();
const ordenados = (xs: string[]) => [...xs].sort();

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();

  const admin = await createUser({ username: "admin_visibilidad", roleNames: ["admin"] });
  const club = await createClub("Club Visibilidad", "CLBV", "club_visibilidad");
  clubId = club.id;
  const usuarioClub = await createUser({ username: "club_visibilidad", roleNames: ["club"], clubId: club.id });
  SYSTEM = { userId: admin.id };
  ADMIN = { userId: admin.id, isAdmin: true, scope: { kind: "admin" }, canRegisterPostClose: true };
  CLUB_ACTOR = { userId: usuarioClub.id, isAdmin: false, scope: { kind: "club", clubId: club.id }, canRegisterPostClose: false };

  const ahora = Date.now();
  for (const [i, c] of CATALOGO.entries()) {
    await prisma.competition.create({
      data: {
        name: c.nombre,
        status: c.estado,
        // "Programada" necesita inicio FUTURO: su estado efectivo se recalcula con las fechas.
        registrationStartAt: new Date(c.estado === "scheduled" ? ahora + (30 + i) * DIA : ahora - (100 - i) * DIA),
        registrationEndAt: new Date(c.estado === "scheduled" ? ahora + (60 + i) * DIA : c.estado === "finished" ? ahora - 10 * DIA : ahora + (200 + i) * DIA),
        ageCutoffDate: new Date(Date.UTC(new Date().getUTCFullYear(), 11, 31)),
        maxIndividualEventsPerSwimmer: 5,
        visibleInRegistrationPanels: c.visible,
      },
    });
  }

  adminToken = await login("admin_visibilidad");
  clubToken = await login("club_visibilidad");
});

afterAll(async () => {
  await app?.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("el filtro del listado: omitido, verdadero y falso", () => {
  it("OMITIDO: el listado general no cambia —el administrador ve todas, ocultas incluidas— y cada fila informa su visibilidad", async () => {
    const { status, body } = await listar(adminToken, { pageSize: 100 });
    expect(status).toBe(200);
    expect(ordenados(body.items.map((i) => i.name))).toEqual(nombresDe(() => true));
    expect(body.total).toBe(CATALOGO.length);
    for (const i of body.items) {
      const origen = CATALOGO.find((c) => c.nombre === i.name)!;
      expect(i.visibleInRegistrationPanels).toBe(origen.visible);
    }
  });

  it("VERDADERO (administrador): excluye las ocultas y deja el resto, borradores incluidos", async () => {
    const { status, body } = await listar(adminToken, { visibleInRegistrationPanels: "true", pageSize: 100 });
    expect(status).toBe(200);
    expect(ordenados(body.items.map((i) => i.name))).toEqual(nombresDe((c) => c.visible));
    expect(body.total).toBe(nombresDe((c) => c.visible).length);
    expect(body.items.every((i) => i.visibleInRegistrationPanels)).toBe(true);
  });

  it("FALSO: solo las ocultas. El texto «false» NO se interpreta como verdadero", async () => {
    const { status, body } = await listar(adminToken, { visibleInRegistrationPanels: "false", pageSize: 100 });
    expect(status).toBe(200);
    expect(ordenados(body.items.map((i) => i.name))).toEqual(nombresDe((c) => !c.visible));
    expect(body.total).toBe(nombresDe((c) => !c.visible).length);
    expect(body.items.some((i) => i.visibleInRegistrationPanels)).toBe(false);
  });

  it("cualquier otro texto se RECHAZA con 400 (nada se coacciona en silencio)", async () => {
    for (const valor of ["FALSE", "True", "0", "1", "si", "", "null", "undefined"]) {
      const res = await app.inject({ method: "GET", url: `/competitions?visibleInRegistrationPanels=${encodeURIComponent(valor)}`, headers: auth(adminToken) });
      expect(res.statusCode, `«${valor}» debe rechazarse`).toBe(400);
    }
  });
});

describe("el filtro SE SUMA a las restricciones por rol y estado", () => {
  it("personal de club, sin filtro: no ve Borrador ni Programada (regla previa) pero SÍ las ocultas de los paneles", async () => {
    const { body } = await listar(clubToken, { pageSize: 100 });
    expect(ordenados(body.items.map((i) => i.name))).toEqual(nombresDe((c) => c.estado !== "draft" && c.estado !== "scheduled"));
    expect(body.items.some((i) => !i.visibleInRegistrationPanels)).toBe(true);
  });

  it("personal de club, con visibleInRegistrationPanels=true: ni Borrador, ni Programada, ni ocultas", async () => {
    const { body } = await listar(clubToken, { visibleInRegistrationPanels: "true", pageSize: 100 });
    expect(ordenados(body.items.map((i) => i.name))).toEqual(nombresDe((c) => c.visible && c.estado !== "draft" && c.estado !== "scheduled"));
    expect(body.total).toBe(body.items.length);
  });

  it("con el filtro de estado: las dos condiciones se aplican a la vez (camino de estados auto-mutables)", async () => {
    const abiertasVisibles = await listar(adminToken, { status: "open", visibleInRegistrationPanels: "true", pageSize: 100 });
    expect(ordenados(abiertasVisibles.body.items.map((i) => i.name))).toEqual(nombresDe((c) => c.estado === "open" && c.visible));
    expect(abiertasVisibles.body.total).toBe(6);

    const abiertasOcultas = await listar(adminToken, { status: "open", visibleInRegistrationPanels: "false", pageSize: 100 });
    expect(ordenados(abiertasOcultas.body.items.map((i) => i.name))).toEqual(nombresDe((c) => c.estado === "open" && !c.visible));

    // Programada: el personal de club no la ve, con o sin el filtro.
    const programadasClub = await listar(clubToken, { status: "scheduled", visibleInRegistrationPanels: "true", pageSize: 100 });
    expect(programadasClub.body.items).toEqual([]);
    expect(programadasClub.body.total).toBe(0);

    // Borrador (estado que no se recalcula): también se combina con el filtro.
    const borradorVisible = await listar(adminToken, { status: "draft", visibleInRegistrationPanels: "true", pageSize: 100 });
    expect(borradorVisible.body.items.map((i) => i.name)).toEqual(["Borrador V"]);
  });
});

describe("resultados, total y paginación salen de la misma condición", () => {
  it("administrador + verdadero, páginas de 4: sin repetidos ni huecos y con el mismo total en todas", async () => {
    const esperado = nombresDe((c) => c.visible);
    const { nombres, totales } = await recorrer(adminToken, { visibleInRegistrationPanels: "true" }, 4);
    expect(ordenados(nombres)).toEqual(esperado);
    expect(new Set(nombres).size).toBe(nombres.length);
    expect(totales).toEqual([esperado.length]);
  });

  it("personal de club + verdadero (paginación en memoria por el ocultamiento de Borrador/Programada)", async () => {
    const esperado = nombresDe((c) => c.visible && c.estado !== "draft" && c.estado !== "scheduled");
    const { nombres, totales } = await recorrer(clubToken, { visibleInRegistrationPanels: "true" }, 3);
    expect(ordenados(nombres)).toEqual(esperado);
    expect(new Set(nombres).size).toBe(nombres.length);
    expect(totales).toEqual([esperado.length]);
  });

  it("estado auto-mutable + verdadero (también en memoria)", async () => {
    const esperado = nombresDe((c) => c.estado === "open" && c.visible);
    const { nombres, totales } = await recorrer(adminToken, { status: "open", visibleInRegistrationPanels: "true" }, 4);
    expect(ordenados(nombres)).toEqual(esperado);
    expect(totales).toEqual([esperado.length]);
  });

  it("falso, páginas de 3", async () => {
    const esperado = nombresDe((c) => !c.visible);
    const { nombres, totales } = await recorrer(adminToken, { visibleInRegistrationPanels: "false" }, 3);
    expect(ordenados(nombres)).toEqual(esperado);
    expect(totales).toEqual([esperado.length]);
  });

  it("omitido, páginas de 5: la paginación de siempre", async () => {
    const { nombres, totales } = await recorrer(adminToken, {}, 5);
    expect(ordenados(nombres)).toEqual(nombresDe(() => true));
    expect(totales).toEqual([CATALOGO.length]);
  });

  it("mezcla visibles y ocultas dentro de una misma página cuando NO se filtra", async () => {
    const { body } = await listar(adminToken, { pageSize: 100 });
    expect(new Set(body.items.map((i) => i.visibleInRegistrationPanels))).toEqual(new Set([true, false]));
  });
});

describe("alta y edición del campo", () => {
  const cuerpo = (nombre: string, extra: Record<string, unknown> = {}) => ({
    name: nombre,
    registrationStartAt: new Date(Date.now() + 5 * DIA).toISOString(),
    registrationEndAt: new Date(Date.now() + 15 * DIA).toISOString(),
    ageCutoffDate: new Date(Date.UTC(new Date().getUTCFullYear(), 11, 31)).toISOString(),
    maxIndividualEventsPerSwimmer: 3,
    ...extra,
  });
  const crear = (payload: unknown) => app.inject({ method: "POST", url: "/competitions", headers: auth(adminToken), payload: payload as object });

  it("un alta SIN el campo queda visible (valor predeterminado)", async () => {
    const res = await crear(cuerpo("Alta sin campo"));
    expect(res.statusCode).toBe(201);
    expect(res.json().visibleInRegistrationPanels).toBe(true);
    const guardada = await prisma.competition.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(guardada.visibleInRegistrationPanels).toBe(true);
  });

  it("un alta con false queda oculta; con true, visible", async () => {
    const oculta = await crear(cuerpo("Alta oculta", { visibleInRegistrationPanels: false }));
    expect(oculta.statusCode).toBe(201);
    expect(oculta.json().visibleInRegistrationPanels).toBe(false);
    const visible = await crear(cuerpo("Alta visible expresa", { visibleInRegistrationPanels: true }));
    expect(visible.json().visibleInRegistrationPanels).toBe(true);
  });

  it("el texto «false» NO es un booleano: el alta se rechaza con 400 y no crea nada", async () => {
    const antes = await prisma.competition.count();
    const res = await crear(cuerpo("Alta con texto", { visibleInRegistrationPanels: "false" }));
    expect(res.statusCode).toBe(400);
    expect(await prisma.competition.count()).toBe(antes);
  });

  it("MARCAR, guardar, volver a abrir y DESMARCAR (ida y vuelta por la API)", async () => {
    const creada = (await crear(cuerpo("Ida y vuelta"))).json();
    const put = (payload: unknown) => app.inject({ method: "PUT", url: `/competitions/${creada.id}`, headers: auth(adminToken), payload: payload as object });
    const leer = async () => (await app.inject({ method: "GET", url: `/competitions/${creada.id}`, headers: auth(adminToken) })).json();

    expect((await put({ visibleInRegistrationPanels: false })).statusCode).toBe(200);
    expect((await leer()).visibleInRegistrationPanels).toBe(false);

    // Editar OTRA cosa no la cambia: el campo omitido significa «no lo toques».
    expect((await put({ description: "otra edición" })).statusCode).toBe(200);
    expect((await leer()).visibleInRegistrationPanels).toBe(false);

    expect((await put({ visibleInRegistrationPanels: true })).statusCode).toBe(200);
    expect((await leer()).visibleInRegistrationPanels).toBe(true);

    expect((await put({ visibleInRegistrationPanels: "false" })).statusCode).toBe(400);
    expect((await leer()).visibleInRegistrationPanels).toBe(true);
  });

  it("la edición queda auditada con el valor anterior y el nuevo", async () => {
    const creada = (await crear(cuerpo("Auditada"))).json();
    await app.inject({ method: "PUT", url: `/competitions/${creada.id}`, headers: auth(adminToken), payload: { visibleInRegistrationPanels: false } });
    const fila = await prisma.auditLog.findFirstOrThrow({ where: { entityId: creada.id, action: "COMPETITION_UPDATED" } });
    expect((fila.before as { visibleInRegistrationPanels?: boolean }).visibleInRegistrationPanels).toBe(true);
    expect((fila.after as { visibleInRegistrationPanels?: boolean }).visibleInRegistrationPanels).toBe(false);
  });
});

describe("duplicar e importar", () => {
  const fechas = { registrationStartAt: new Date(Date.now() + 5 * DIA), registrationEndAt: new Date(Date.now() + 15 * DIA) };

  it("DUPLICAR hereda la visibilidad del origen: oculta -> oculta, visible -> visible", async () => {
    const oculta = await prisma.competition.findFirstOrThrow({ where: { name: "Abierta H1" } });
    const visible = await prisma.competition.findFirstOrThrow({ where: { name: "Abierta V1" } });

    const copiaOculta = await competitionsService.duplicateCompetition(oculta.id, { name: "Copia de oculta", ...fechas }, SYSTEM);
    const copiaVisible = await competitionsService.duplicateCompetition(visible.id, { name: "Copia de visible", ...fechas }, SYSTEM);

    expect(copiaOculta.visibleInRegistrationPanels).toBe(false);
    expect(copiaVisible.visibleInRegistrationPanels).toBe(true);
    // Y quedó guardado así, no solo en la respuesta.
    expect((await prisma.competition.findUniqueOrThrow({ where: { id: copiaOculta.id } })).visibleInRegistrationPanels).toBe(false);
  });

  it("el origen no cambia al duplicarlo", async () => {
    const origen = await prisma.competition.findFirstOrThrow({ where: { name: "Abierta H2" } });
    await competitionsService.duplicateCompetition(origen.id, { name: "Copia de H2", ...fechas }, SYSTEM);
    expect((await prisma.competition.findUniqueOrThrow({ where: { id: origen.id } })).visibleInRegistrationPanels).toBe(false);
  });

  it("una competencia creada por el camino de importación (sin indicar el campo) queda visible", async () => {
    // La importación de Meet Events llama a `createCompetition` con los datos del archivo, que no traen este campo.
    const importada = await competitionsService.createCompetition(
      {
        name: "Importada sin campo",
        registrationStartAt: new Date(Date.now() + DIA),
        registrationEndAt: new Date(Date.now() + 10 * DIA),
        ageCutoffDate: new Date(Date.UTC(new Date().getUTCFullYear(), 11, 31)),
        maxIndividualEventsPerSwimmer: 4,
        maxRelayEventsPerSwimmerPerSession: 1,
      },
      SYSTEM
    );
    expect(importada.visibleInRegistrationPanels).toBe(true);
  });
});

describe("ocultar es SOLO visibilidad: acceso directo, inscripciones, Reportes y asistentes no cambian", () => {
  /** Competencia ABIERTA con una prueba individual y una de relevo, y cuatro nadadores del club. */
  async function montar(nombre: string, oculta: boolean) {
    const individual = await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
    const relevo = await prisma.testType.upsert({ where: { name: "Relevo" }, update: {}, create: { name: "Relevo", swimmersCount: 4 } });
    const d50 = await prisma.distance.upsert({ where: { meters: 50 }, update: {}, create: { meters: 50 } });
    const d200 = await prisma.distance.upsert({ where: { meters: 200 }, update: {}, create: { meters: 200 } });
    const libre = await prisma.stroke.upsert({ where: { name: "Libre" }, update: {}, create: { name: "Libre" } });
    const jornadaTipo = await prisma.sessionType.upsert({ where: { name: "Mañana" }, update: {}, create: { name: "Mañana" } });

    const nadadores: { id: string }[] = [];
    const usuario = await prisma.user.findFirstOrThrow({ where: { username: "club_visibilidad" } });
    const base = Math.floor(Math.random() * 9_000_000) + 10_000_000;
    for (let i = 0; i < 4; i++) {
      const p = await createPerson({ run: `${base + i}`, username: `vis_${base}_${i}`, firstName: `Nadador${i}`, gender: i % 2 ? "male" : "female", birthYear: 1990 });
      await addActiveMembership(clubId, p.id, usuario.id);
      nadadores.push(p);
    }
    const catInd = await catalogsCategories.createCategory({ testTypeId: individual.id, name: `Cat ${nombre}`, minAge: 20, maxAge: 60 }, SYSTEM).catch(
      () => prisma.category.findFirstOrThrow({ where: { testTypeId: individual.id } })
    );
    const catRel = await catalogsCategories.createCategory({ testTypeId: relevo.id, name: `Rel ${nombre}`, minAge: 0, maxAge: 500 }, SYSTEM).catch(
      () => prisma.category.findFirstOrThrow({ where: { testTypeId: relevo.id } })
    );

    const competencia = await competitionsService.createCompetition(
      {
        name: nombre,
        registrationStartAt: new Date(Date.now() - DIA),
        registrationEndAt: new Date(Date.now() + DIA),
        ageCutoffDate: new Date(Date.UTC(new Date().getUTCFullYear(), 11, 31)),
        maxIndividualEventsPerSwimmer: 5,
        maxRelayEventsPerSwimmerPerSession: 1,
        visibleInRegistrationPanels: !oculta,
      },
      SYSTEM
    );
    await competitionsService.transitionCompetition(competencia.id, "schedule", SYSTEM);
    // Ya ABIERTA en la base. Si quedara «programada», cada lectura del listado tendría que «sanarla» a abierta
    // con una transacción propia, y varias a la vez (`Promise.all` en `listCompetitions`) agotan el pool de
    // conexiones de la base de ensayo: un fenómeno ajeno a esta prueba (ver el informe).
    await prisma.competition.update({ where: { id: competencia.id }, data: { status: "open" } });
    const fecha = await structureService.addCompetitionDate(competencia.id, new Date(), SYSTEM);
    const jornada = await structureService.addSession(fecha.id, jornadaTipo.id, SYSTEM);
    const evInd = await catalogsEvents.createEvent({ testTypeId: individual.id, distanceId: d50.id, strokeId: libre.id, gender: "mixed" }, SYSTEM).catch(
      () => prisma.event.findFirstOrThrow({ where: { testTypeId: individual.id } })
    );
    const evRel = await catalogsEvents.createEvent({ testTypeId: relevo.id, distanceId: d200.id, strokeId: libre.id, gender: "mixed" }, SYSTEM).catch(
      () => prisma.event.findFirstOrThrow({ where: { testTypeId: relevo.id } })
    );
    const ceInd = await competitionEventsService.addCompetitionEvent(competencia.id, { eventId: evInd.id, competitionSessionId: jornada.id, categoryIds: [catInd.id], displayOrder: 1 }, SYSTEM);
    const ceRel = await competitionEventsService.addCompetitionEvent(competencia.id, { eventId: evRel.id, competitionSessionId: jornada.id, categoryIds: [catRel.id], displayOrder: 2 }, SYSTEM);
    return { competencia, ceInd, ceRel, nadadores };
  }

  it("el detalle (acceso directo) sigue respondiendo 200, a administrador y a personal de club", async () => {
    const { competencia } = await montar("Acceso directo", true);
    for (const token of [adminToken, clubToken]) {
      const res = await app.inject({ method: "GET", url: `/competitions/${competencia.id}`, headers: auth(token) });
      expect(res.statusCode).toBe(200);
      expect(res.json().visibleInRegistrationPanels).toBe(false);
    }
  });

  it("la regla previa de Borrador/Programada para el personal de club sigue en pie, y es independiente del campo", async () => {
    const borradorVisible = await prisma.competition.findFirstOrThrow({ where: { name: "Borrador V" } });
    const borradorOculta = await prisma.competition.findFirstOrThrow({ where: { name: "Borrador H" } });
    for (const c of [borradorVisible, borradorOculta]) {
      expect((await app.inject({ method: "GET", url: `/competitions/${c.id}`, headers: auth(clubToken) })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/competitions/${c.id}`, headers: auth(adminToken) })).statusCode).toBe(200);
    }
  });

  it("las inscripciones individuales y de relevo se admiten IGUAL en una competencia oculta y en una visible", async () => {
    const resultados: Record<string, string[]> = {};
    for (const [etiqueta, oculta] of [["visible", false], ["oculta", true]] as const) {
      const { ceInd, ceRel, nadadores } = await montar(`Inscripción ${etiqueta}`, oculta);
      const salidas: string[] = [];

      // Individual: una por administrador y otra por personal de club (alcance de su club).
      const r1 = await registrationsService.createRegistration({ competitionEventId: ceInd.id, clubId, personId: nadadores[0]!.id, seedTimeCentiseconds: 3000 }, ADMIN);
      salidas.push(`admin:${r1.status}`);
      const r2 = await registrationsService.createRegistration({ competitionEventId: ceInd.id, clubId, personId: nadadores[1]!.id, seedTimeCentiseconds: 3100 }, CLUB_ACTOR);
      salidas.push(`club:${r2.status}`);
      for (const n of nadadores.slice(2)) await registrationsService.createRegistration({ competitionEventId: ceInd.id, clubId, personId: n.id, seedTimeCentiseconds: 3200 }, ADMIN);

      // Relevo, con los cuatro (todos con individual confirmada).
      const rel = await relayService.createRelayRegistration({ competitionEventId: ceRel.id, clubId, personIds: nadadores.map((n) => n.id) }, CLUB_ACTOR);
      salidas.push(`relevo:${rel.status}`);
      resultados[etiqueta] = salidas;

      // Las rutas de consulta con las que se inscribe, también sin cambios.
      const enabled = await app.inject({ method: "GET", url: `/competitions/${ceInd.competitionId}/enabled-events`, headers: auth(clubToken) });
      expect(enabled.statusCode, `enabled-events (${etiqueta})`).toBe(200);
    }
    expect(resultados["oculta"]).toEqual(resultados["visible"]);
    expect(resultados["oculta"]).toEqual(["admin:confirmed", "club:confirmed", "relevo:confirmed"]);
  });

  it("Reportes: el informe de una competencia oculta se genera con todo su contenido", async () => {
    const { competencia, ceInd, nadadores } = await montar("Reportes oculta", true);
    await registrationsService.createRegistration({ competitionEventId: ceInd.id, clubId, personId: nadadores[0]!.id, seedTimeCentiseconds: 3000 }, ADMIN);
    const informe = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN);
    expect(informe.individualRows).toHaveLength(1);
    expect(informe.competitionName).toBe("Reportes oculta");
  });

  it("Reportes y asistentes listan la oculta: piden /competitions sin el filtro (o con status=open) y la reciben", async () => {
    await montar("Asistente oculta", true);
    const sinFiltro = await listar(adminToken, { pageSize: 100 });
    expect(sinFiltro.status, JSON.stringify(sinFiltro.body)).toBe(200);
    expect(sinFiltro.body.items.some((i) => i.name === "Asistente oculta")).toBe(true);
    // El asistente pide solo las abiertas, sin el filtro de visibilidad.
    const abiertas = await listar(clubToken, { status: "open", pageSize: 100 });
    expect(abiertas.body.items.some((i) => i.name === "Asistente oculta")).toBe(true);
    // Y los dos paneles (con el filtro) no la reciben, para ningún rol.
    for (const token of [adminToken, clubToken]) {
      const panel = await listar(token, { visibleInRegistrationPanels: "true", pageSize: 100 });
      expect(panel.body.items.some((i) => i.name === "Asistente oculta")).toBe(false);
    }
  });
});
