/**
 * AUD-C — alcance de los datos en tres puntos de la API.
 *
 *  - AUD-05: un usuario de club no obtiene datos de personas AJENAS a su club a través de los
 *    mensajes de error de inscripciones individuales y de relevos (crear y editar).
 *  - AUD-07: una competencia en Borrador o Programada es solo del administrador también en los
 *    endpoints que cuelgan de ella, en los reportes y en la exportación a Team Manager. El
 *    estado es el EFECTIVO y consultar no escribe nada. `visibleInRegistrationPanels` no
 *    interviene: solo gobierna los desplegables.
 *  - AUD-15: `GET /swimmer-assignments/current-club/:personId` devuelve solo el club.
 *
 * Datos sintéticos. Solo contra la base desechable (ver `helpers/testDb.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";
import * as assignmentService from "../src/modules/swimmer-assignment/assignment.service";

let app: FastifyInstance;

const DIA = 86_400_000;
const UUID_INEXISTENTE = "00000000-0000-4000-8000-0000000000aa";

interface Estructura {
  competitionId: string;
  ceIndividual: string;
  ceRelevo: string;
}

const ctx = {
  catalogos: { eventoIndividual: "", eventoRelevo: "", jornada: "" },
  clubAId: "",
  clubBId: "",
  adminId: "",
  catIndividual: "",
  catRelevo: "",
  a: [] as string[],
  b: [] as string[],
  sinClub: "",
  tokens: {} as Record<string, string>,
  competencias: {} as Record<string, Estructura>,
};

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username} devolvió ${res.statusCode}: ${res.body}`);
  return res.json().accessToken as string;
}

const get = (token: string, url: string) => app.inject({ method: "GET", url, headers: auth(token) });
const post = (token: string, url: string, payload: object) => app.inject({ method: "POST", url, headers: auth(token), payload });
const put = (token: string, url: string, payload: object) => app.inject({ method: "PUT", url, headers: auth(token), payload });

async function crearCompetencia(
  nombre: string,
  opciones: { status: "draft" | "scheduled" | "open" | "closed"; inicioEnDias: number; finEnDias: number; visibleEnPaneles?: boolean },
  catalogos: { eventoIndividual: string; eventoRelevo: string; jornada: string }
): Promise<Estructura> {
  const ahora = Date.now();
  const competencia = await prisma.competition.create({
    data: {
      name: nombre,
      status: opciones.status,
      registrationStartAt: new Date(ahora + opciones.inicioEnDias * DIA),
      registrationEndAt: new Date(ahora + opciones.finEnDias * DIA),
      visibleInRegistrationPanels: opciones.visibleEnPaneles ?? true,
    },
  });
  const fecha = await prisma.competitionDate.create({ data: { competitionId: competencia.id, date: new Date(ahora + 30 * DIA) } });
  const sesion = await prisma.competitionSession.create({
    data: { competitionDateId: fecha.id, sessionTypeId: catalogos.jornada, competitionId: competencia.id },
  });
  const ceIndividual = await prisma.competitionEvent.create({
    data: { competitionId: competencia.id, eventId: catalogos.eventoIndividual, competitionSessionId: sesion.id },
  });
  const ceRelevo = await prisma.competitionEvent.create({
    data: { competitionId: competencia.id, eventId: catalogos.eventoRelevo, competitionSessionId: sesion.id },
  });
  await prisma.competitionEventCategory.create({ data: { competitionEventId: ceIndividual.id, categoryId: ctx.catIndividual } });
  await prisma.competitionEventCategory.create({ data: { competitionEventId: ceRelevo.id, categoryId: ctx.catRelevo } });
  return { competitionId: competencia.id, ceIndividual: ceIndividual.id, ceRelevo: ceRelevo.id };
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();

  const tipoIndividual = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
  const tipoRelevo = await prisma.testType.create({ data: { name: "Relevo 4x", swimmersCount: 4 } });
  const distancia = await prisma.distance.create({ data: { meters: 50 } });
  const estilo = await prisma.stroke.create({ data: { name: "Libre" } });
  const jornada = await prisma.sessionType.create({ data: { name: "Mañana" } });
  const catIndividual = await prisma.category.create({ data: { testTypeId: tipoIndividual.id, name: "Todo competidor", minAge: 5, maxAge: 99 } });
  // La edad de un relevo es la SUMA de la de sus cuatro integrantes: el tope debe cubrir cuatro adultos.
  const catRelevo = await prisma.category.create({ data: { testTypeId: tipoRelevo.id, name: "Relevo libre", minAge: 5, maxAge: 400 } });
  ctx.catIndividual = catIndividual.id;
  ctx.catRelevo = catRelevo.id;
  const eventoIndividual = await prisma.event.create({ data: { testTypeId: tipoIndividual.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" } });
  const eventoRelevo = await prisma.event.create({ data: { testTypeId: tipoRelevo.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" } });
  const catalogos = { eventoIndividual: eventoIndividual.id, eventoRelevo: eventoRelevo.id, jornada: jornada.id };
  ctx.catalogos = catalogos;

  const clubA = await createClub("Club Alfa Sintético", "CAS", "club_a");
  const clubB = await createClub("Club Beta Sintético", "CBS", "club_b");
  ctx.clubAId = clubA.id;
  ctx.clubBId = clubB.id;

  const admin = await createUser({ username: "admin_auc", roleNames: ["admin"] });
  ctx.adminId = admin.id;
  await createUser({ username: "club_a", roleNames: ["club"], clubId: clubA.id });
  await createUser({ username: "club_b", roleNames: ["club"], clubId: clubB.id });

  for (const [letra, clubId, destino] of [["A", clubA.id, ctx.a], ["B", clubB.id, ctx.b]] as const) {
    for (let i = 1; i <= 4; i++) {
      const p = await createPerson({
        run: `${letra === "A" ? 31 : 41}00000${i}`,
        username: `nad_${letra.toLowerCase()}${i}`,
        firstName: `Nadador${letra}${i}`,
        gender: i % 2 === 0 ? "male" : "female",
      });
      await addActiveMembership(clubId, p.id, admin.id);
      destino.push(p.id);
    }
  }
  const sinClub = await createPerson({ run: "51000001", username: "nad_sin_club", firstName: "NadadorSinClub", gender: "female" });
  ctx.sinClub = sinClub.id;
  await createUser({ username: "nad_a1", roleNames: ["swimmer"], personId: ctx.a[0]! });

  ctx.competencias.abierta = await crearCompetencia("Abierta", { status: "open", inicioEnDias: -1, finEnDias: 5 }, catalogos);
  ctx.competencias.abiertaOculta = await crearCompetencia("Abierta oculta en paneles", { status: "open", inicioEnDias: -1, finEnDias: 5, visibleEnPaneles: false }, catalogos);
  ctx.competencias.borrador = await crearCompetencia("Borrador visible en paneles", { status: "draft", inicioEnDias: -1, finEnDias: 5, visibleEnPaneles: true }, catalogos);
  ctx.competencias.borradorOculto = await crearCompetencia("Borrador oculto en paneles", { status: "draft", inicioEnDias: -1, finEnDias: 5, visibleEnPaneles: false }, catalogos);
  ctx.competencias.programada = await crearCompetencia("Programada", { status: "scheduled", inicioEnDias: 3, finEnDias: 9 }, catalogos);
  // Guardada como «programada», pero su inscripción ya abrió por fecha: el estado EFECTIVO es «abierta».
  ctx.competencias.programadaYaAbierta = await crearCompetencia("Programada ya abierta por fecha", { status: "scheduled", inicioEnDias: -1, finEnDias: 5 }, catalogos);
  // Guardada como «abierta», pero su plazo venció: el estado efectivo es «cerrada», visible.
  ctx.competencias.abiertaVencida = await crearCompetencia("Abierta con plazo vencido", { status: "open", inicioEnDias: -9, finEnDias: -2 }, catalogos);

  ctx.tokens.admin = await login("admin_auc");
  ctx.tokens.clubA = await login("club_a");
  ctx.tokens.clubB = await login("club_b");
  ctx.tokens.nadadorA1 = await login("nad_a1");
});

afterAll(async () => {
  await app.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// AUD-05
// ---------------------------------------------------------------------------

const MARCADORES_DE_B = () => ["NadadorB1", "NadadorB2", "41000001", "41000002"];

function sinDatosDeB(texto: string) {
  for (const m of MARCADORES_DE_B()) expect(texto, `la respuesta contiene «${m}», dato de otro club`).not.toContain(m);
}

describe("AUD-05: inscripción individual con una persona ajena al club", () => {
  it("un usuario de club recibe el mismo 403 genérico por una persona de otro club que por una inexistente, sin datos", async () => {
    const ce = ctx.competencias.abierta!.ceIndividual;
    const ajena = await post(ctx.tokens.clubA!, "/registrations", { competitionEventId: ce, clubId: ctx.clubAId, personId: ctx.b[0] });
    const inexistente = await post(ctx.tokens.clubA!, "/registrations", { competitionEventId: ce, clubId: ctx.clubAId, personId: UUID_INEXISTENTE });

    expect(ajena.statusCode).toBe(403);
    expect(inexistente.statusCode).toBe(403);
    expect(ajena.json()).toEqual(inexistente.json());
    sinDatosDeB(ajena.body);
    expect(ajena.body).not.toMatch(/años|\bedad\b|inscripci[oó]n confirmada|género|máximo|no está activo/i);
    expect(await prisma.registration.count({ where: { personId: ctx.b[0] } })).toBe(0);
  });

  it("conserva el comportamiento válido: un integrante propio se inscribe", async () => {
    const res = await post(ctx.tokens.clubA!, "/registrations", { competitionEventId: ctx.competencias.abierta!.ceIndividual, clubId: ctx.clubAId, personId: ctx.a[0] });
    expect(res.statusCode).toBe(201);
    expect(res.json().personId).toBe(ctx.a[0]);
  });

  it("un integrante propio ya inscrito sigue recibiendo su mensaje detallado (es su propio dato)", async () => {
    const res = await post(ctx.tokens.clubA!, "/registrations", { competitionEventId: ctx.competencias.abierta!.ceIndividual, clubId: ctx.clubAId, personId: ctx.a[0] });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/inscripci[oó]n/i);
  });

  it("el nadador sigue limitado a sí mismo, con el mismo error de siempre", async () => {
    const res = await post(ctx.tokens.nadadorA1!, "/registrations", { competitionEventId: ctx.competencias.abierta!.ceIndividual, clubId: ctx.clubAId, personId: ctx.a[1] });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/a usted mismo/);
  });

  it("el administrador conserva los mensajes detallados para una persona fuera del club", async () => {
    const res = await post(ctx.tokens.admin!, "/registrations", { competitionEventId: ctx.competencias.abierta!.ceIndividual, clubId: ctx.clubAId, personId: ctx.b[1] });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toMatch(/pertenece/i);
  });
});

describe("AUD-05: relevos, crear y editar", () => {
  it("crear con un integrante de otro club: 403 genérico, igual que con uno inexistente, sin datos ni escritura", async () => {
    const ce = ctx.competencias.abierta!.ceRelevo;
    const ajeno = await post(ctx.tokens.clubA!, "/relay-registrations", { competitionEventId: ce, clubId: ctx.clubAId, personIds: [ctx.a[0], ctx.a[1], ctx.a[2], ctx.b[0]] });
    const inexistente = await post(ctx.tokens.clubA!, "/relay-registrations", { competitionEventId: ce, clubId: ctx.clubAId, personIds: [ctx.a[0], ctx.a[1], ctx.a[2], UUID_INEXISTENTE] });

    expect(ajeno.statusCode).toBe(403);
    expect(inexistente.statusCode).toBe(403);
    expect(ajeno.json()).toEqual(inexistente.json());
    sinDatosDeB(ajeno.body);
    expect(ajeno.body).not.toMatch(/años|\bedad\b|género|máximo|relevo\(s\)|no está activo/i);
    expect(await prisma.relayRegistration.count()).toBe(0);
  });

  it("también cuando TODOS los integrantes son ajenos", async () => {
    const res = await post(ctx.tokens.clubA!, "/relay-registrations", { competitionEventId: ctx.competencias.abierta!.ceRelevo, clubId: ctx.clubAId, personIds: ctx.b });
    expect(res.statusCode).toBe(403);
    sinDatosDeB(res.body);
  });

  it("conserva el comportamiento válido: un equipo propio se inscribe", async () => {
    // Un relevo exige que sus integrantes ya tengan una inscripción individual confirmada (el primero la tiene, de arriba).
    for (const personId of ctx.a.slice(1)) {
      await prisma.registration.create({
        data: {
          competitionEventId: ctx.competencias.abierta!.ceIndividual,
          personId,
          clubId: ctx.clubAId,
          categoryId: ctx.catIndividual,
          status: "confirmed",
          registeredByUserId: ctx.adminId,
        },
      });
    }
    const res = await post(ctx.tokens.clubA!, "/relay-registrations", { competitionEventId: ctx.competencias.abierta!.ceRelevo, clubId: ctx.clubAId, personIds: ctx.a });
    expect(res.statusCode, res.body).toBe(201);
    ctx.tokens.relayId = res.json().id;
  });

  it("un integrante propio repetido sigue recibiendo el mensaje detallado con su nombre (dato propio)", async () => {
    const res = await post(ctx.tokens.clubA!, "/relay-registrations", { competitionEventId: ctx.competencias.abiertaOculta!.ceRelevo, clubId: ctx.clubAId, personIds: [ctx.a[0], ctx.a[0], ctx.a[1], ctx.a[2]] });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/duplicado/i);
    expect(res.body).toContain("NadadorA1");
  });

  it("editar el equipo con un integrante ajeno: 403 genérico y el equipo no cambia", async () => {
    const antes = await prisma.relayRegistrationMember.findMany({ where: { relayRegistrationId: ctx.tokens.relayId! }, orderBy: { orderPosition: "asc" } });
    const res = await put(ctx.tokens.clubA!, `/relay-registrations/${ctx.tokens.relayId}`, { personIds: [ctx.a[0], ctx.a[1], ctx.a[2], ctx.b[1]] });
    expect(res.statusCode).toBe(403);
    sinDatosDeB(res.body);
    const despues = await prisma.relayRegistrationMember.findMany({ where: { relayRegistrationId: ctx.tokens.relayId! }, orderBy: { orderPosition: "asc" } });
    expect(despues.map((m) => m.personId)).toEqual(antes.map((m) => m.personId));
  });

  it("editar con integrantes propios funciona", async () => {
    const res = await put(ctx.tokens.clubA!, `/relay-registrations/${ctx.tokens.relayId}`, { personIds: [ctx.a[3], ctx.a[2], ctx.a[1], ctx.a[0]] });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("el administrador conserva los mensajes detallados con un integrante fuera del club", async () => {
    const res = await post(ctx.tokens.admin!, "/relay-registrations", { competitionEventId: ctx.competencias.abiertaOculta!.ceRelevo, clubId: ctx.clubAId, personIds: [ctx.a[0], ctx.a[1], ctx.a[2], ctx.b[0]] });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/no pertenece actualmente a este club/);
    expect(res.body).toContain("NadadorB1");
  });
});

// ---------------------------------------------------------------------------
// AUD-07
// ---------------------------------------------------------------------------

type Rutas = (e: Estructura) => { nombre: string; url: string; rol: "club" | "nadador" | "ambos" }[];

const RUTAS: Rutas = (e) => [
  { nombre: "pruebas de la competencia", url: `/competitions/${e.competitionId}/events`, rol: "ambos" },
  { nombre: "pruebas habilitadas", url: `/competitions/${e.competitionId}/enabled-events`, rol: "ambos" },
  { nombre: "capacidad", url: `/competitions/${e.competitionId}/capacity`, rol: "ambos" },
  { nombre: "pruebas disponibles de un nadador", url: `/registrations/available-events?competitionId=${e.competitionId}&personId=${ctx.a[0]}`, rol: "ambos" },
  { nombre: "matriz de elegibilidad del club", url: `/registrations/club-eligibility-matrix?competitionId=${e.competitionId}&clubId=${ctx.clubAId}`, rol: "club" },
  { nombre: "nadadores elegibles", url: `/registrations/eligible-swimmers?clubId=${ctx.clubAId}&competitionEventId=${e.ceIndividual}&categoryId=${ctx.catIndividual}`, rol: "club" },
  { nombre: "reporte de inscritos", url: `/reports/registrations?competitionId=${e.competitionId}`, rol: "ambos" },
  { nombre: "exportación a Team Manager", url: `/export/team-manager/zip?competitionId=${e.competitionId}&clubId=${ctx.clubAId}`, rol: "club" },
];

function aplicables(e: Estructura, quien: "club" | "nadador") {
  return RUTAS(e).filter((r) => r.rol === "ambos" || r.rol === quien);
}

describe("AUD-07: competencias en Borrador o Programada", () => {
  for (const clave of ["borrador", "borradorOculto", "programada"] as const) {
    it(`«${clave}»: para un usuario de club, todos los endpoints responden 404 como el detalle`, async () => {
      const e = ctx.competencias[clave]!;
      const detalle = await get(ctx.tokens.clubA!, `/competitions/${e.competitionId}`);
      expect(detalle.statusCode, "la referencia: el detalle ya respondía 404").toBe(404);
      for (const r of aplicables(e, "club")) {
        const res = await get(ctx.tokens.clubA!, r.url);
        expect(res.statusCode, `${r.nombre}: ${res.body.slice(0, 150)}`).toBe(404);
        expect(res.body).not.toContain("Borrador");
      }
    });

    it(`«${clave}»: para un nadador, también`, async () => {
      const e = ctx.competencias[clave]!;
      for (const r of aplicables(e, "nadador")) {
        const res = await get(ctx.tokens.nadadorA1!, r.url);
        expect(res.statusCode, `${r.nombre}: ${res.body.slice(0, 150)}`).toBe(404);
      }
    });

    it(`«${clave}»: el administrador conserva el acceso`, async () => {
      const e = ctx.competencias[clave]!;
      for (const r of RUTAS(e)) {
        const res = await get(ctx.tokens.admin!, r.url);
        expect(res.statusCode, `${r.nombre} (admin): ${res.body.slice(0, 150)}`, ).not.toBe(404);
      }
      expect((await get(ctx.tokens.admin!, `/competitions/${e.competitionId}/events`)).json()).toHaveLength(2);
    });
  }

  for (const clave of ["abierta", "abiertaOculta", "programadaYaAbierta", "abiertaVencida"] as const) {
    it(`«${clave}»: sigue accesible para un usuario de club (no 404 por visibilidad)`, async () => {
      const e = ctx.competencias[clave]!;
      for (const r of aplicables(e, "club")) {
        const res = await get(ctx.tokens.clubA!, r.url);
        // La exportación a Team Manager puede rechazar por otros motivos (la piscina); nunca por visibilidad.
        if (r.nombre === "exportación a Team Manager") expect(res.statusCode, res.body.slice(0, 150)).not.toBe(404);
        else expect(res.statusCode, `${r.nombre}: ${res.body.slice(0, 150)}`).toBe(200);
      }
    });
  }

  it("`visibleInRegistrationPanels` no decide: dos borradores, uno visible y otro oculto en los paneles, se comportan igual", async () => {
    const a = await get(ctx.tokens.clubA!, `/competitions/${ctx.competencias.borrador!.competitionId}/events`);
    const b = await get(ctx.tokens.clubA!, `/competitions/${ctx.competencias.borradorOculto!.competitionId}/events`);
    expect([a.statusCode, b.statusCode]).toEqual([404, 404]);
  });

  it("`visibleInRegistrationPanels` no decide: una abierta oculta en los paneles sigue accesible, y su filtro del listado sigue siendo del listado", async () => {
    const directa = await get(ctx.tokens.clubA!, `/competitions/${ctx.competencias.abiertaOculta!.competitionId}/capacity`);
    expect(directa.statusCode).toBe(200);

    const conTrue = await get(ctx.tokens.clubA!, "/competitions?visibleInRegistrationPanels=true&pageSize=100");
    const conFalse = await get(ctx.tokens.clubA!, "/competitions?visibleInRegistrationPanels=false&pageSize=100");
    const nombresTrue = (conTrue.json().items as { name: string }[]).map((c) => c.name);
    const nombresFalse = (conFalse.json().items as { name: string }[]).map((c) => c.name);
    expect(nombresTrue).toContain("Abierta");
    expect(nombresTrue).not.toContain("Abierta oculta en paneles");
    expect(nombresFalse).toEqual(["Abierta oculta en paneles"]);
    // Las que no son visibles para el club (borradores y programada) siguen fuera de ambos listados.
    for (const n of [...nombresTrue, ...nombresFalse]) expect(n).not.toMatch(/Borrador|^Programada$/);
  });

  it("una competencia inexistente: 404 para quien no es administrador; el administrador conserva su respuesta de siempre", async () => {
    const club = await get(ctx.tokens.clubA!, `/competitions/${UUID_INEXISTENTE}/events`);
    expect(club.statusCode).toBe(404);
    const admin = await get(ctx.tokens.admin!, `/competitions/${UUID_INEXISTENTE}/events`);
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toEqual([]);
  });

  it("consultar no escribe: el estado guardado y la auditoría no cambian", async () => {
    /**
     * Competencias PROPIAS de esta prueba, creadas aquí: otras pruebas de este archivo listan
     * competencias, y el listado SÍ persiste el avance automático de estado (`applyAutoStatus`,
     * que se conserva). Con estas, lo único que las toca son los endpoints que se comprueban.
     */
    const programadaYaAbierta = await crearCompetencia("Programada ya abierta (sin escritura)", { status: "scheduled", inicioEnDias: -1, finEnDias: 5 }, ctx.catalogos);
    const abiertaVencida = await crearCompetencia("Abierta vencida (sin escritura)", { status: "open", inicioEnDias: -9, finEnDias: -2 }, ctx.catalogos);
    const programadaFutura = await crearCompetencia("Programada futura (sin escritura)", { status: "scheduled", inicioEnDias: 3, finEnDias: 9 }, ctx.catalogos);
    const propias = [programadaYaAbierta, abiertaVencida, programadaFutura];
    const ids = propias.map((p) => p.competitionId);

    const antes = await prisma.competition.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
    const auditoriaAntes = await prisma.auditLog.count();

    for (const e of propias) {
      for (const r of aplicables(e, "club")) await get(ctx.tokens.clubA!, r.url);
      for (const r of aplicables(e, "nadador")) await get(ctx.tokens.nadadorA1!, r.url);
    }
    // Y el administrador, que no pasa por la comprobación.
    for (const e of propias) for (const r of RUTAS(e)) await get(ctx.tokens.admin!, r.url);

    const despues = await prisma.competition.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
    expect(despues.map((c) => [c.id, c.status, c.updatedAt.toISOString()])).toEqual(antes.map((c) => [c.id, c.status, c.updatedAt.toISOString()]));
    expect(await prisma.auditLog.count(), "ninguna lectura de estos endpoints deja auditoría").toBe(auditoriaAntes);
    expect(despues.find((c) => c.id === programadaYaAbierta.competitionId)!.status, "sigue guardada como programada aunque su estado efectivo sea abierta").toBe("scheduled");
    expect(despues.find((c) => c.id === abiertaVencida.competitionId)!.status, "sigue guardada como abierta aunque su plazo venció").toBe("open");
  });
});

// ---------------------------------------------------------------------------
// AUD-15
// ---------------------------------------------------------------------------

describe("AUD-15: club actual", () => {
  it("devuelve exactamente { club: { id, name } }, sin la membresía", async () => {
    const res = await get(ctx.tokens.clubA!, `/swimmer-assignments/current-club/${ctx.a[0]}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ club: { id: ctx.clubAId, name: "Club Alfa Sintético" } });
    expect(res.body).not.toMatch(/requestedByUserId|reviewedByUserId|rejectionReason|startDate|status|personId/);
  });

  it("las reglas de acceso no cambian: un club consulta a una persona de otro club; un nadador solo a sí mismo", async () => {
    const deOtroClub = await get(ctx.tokens.clubA!, `/swimmer-assignments/current-club/${ctx.b[0]}`);
    expect(deOtroClub.statusCode).toBe(200);
    expect(deOtroClub.json()).toEqual({ club: { id: ctx.clubBId, name: "Club Beta Sintético" } });

    const propio = await get(ctx.tokens.nadadorA1!, `/swimmer-assignments/current-club/${ctx.a[0]}`);
    expect(propio.statusCode).toBe(200);
    expect(propio.json()).toEqual({ club: { id: ctx.clubAId, name: "Club Alfa Sintético" } });

    const ajeno = await get(ctx.tokens.nadadorA1!, `/swimmer-assignments/current-club/${ctx.a[1]}`);
    expect(ajeno.statusCode).toBe(403);
  });

  it("una persona sin club responde 200 con null", async () => {
    const res = await get(ctx.tokens.clubA!, `/swimmer-assignments/current-club/${ctx.sinClub}`);
    expect(res.statusCode).toBe(200);
    expect(res.body === "" || res.body === "null").toBe(true);
  });

  it("la función interna sigue entregando la membresía completa", async () => {
    const interna = await assignmentService.getCurrentClubForPerson(ctx.a[0]!);
    expect(interna).toMatchObject({ personId: ctx.a[0], clubId: ctx.clubAId, status: "active", requestedByUserId: ctx.adminId });
    expect(interna!.club).toEqual({ id: ctx.clubAId, name: "Club Alfa Sintético" });
  });
});
