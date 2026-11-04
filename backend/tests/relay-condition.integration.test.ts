/**
 * Etapa 5 — condición configurable por competencia: «exigir al menos una inscripción
 * individual confirmada antes de participar en relevos» (`requireIndividualForRelay`),
 * contra PostgreSQL real.
 *
 * Activada (por omisión) rige la invariante de siempre, con sus dos lados: formar o
 * modificar un equipo exige la individual de todos los integrantes, y no se puede cancelar la
 * última individual de quien integra un relevo confirmado. Desactivada no se exige ninguno de
 * los dos. Activarla sobre equipos que no cumplen NO modifica nada: solo se informa cuántos son.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
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
import { ValidationError } from "../src/shared/errors";

type Admin = { userId: string; isAdmin: true; scope: { kind: "admin" }; canRegisterPostClose: boolean };
type DeClub = { userId: string; isAdmin: false; scope: { kind: "club"; clubId: string }; canRegisterPostClose: boolean };

let SYSTEM: { userId: string };
let ADMIN: Admin;
let app: FastifyInstance | undefined;
let contador = 0;

interface Escenario {
  competitionId: string;
  clubId: string;
  actor: DeClub;
  nadadores: { id: string }[];
  /** Individual de la competencia, con `inscribir(personId)`. */
  individualId: string;
  otraIndividualId: string;
  relevoA: string;
  relevoB: string;
  inscribir: (personId: string, competitionEventId?: string, actor?: Admin | DeClub) => Promise<{ id: string }>;
  equipo: (competitionEventId: string, personIds: string[], actor?: Admin | DeClub) => ReturnType<typeof relayService.createRelayRegistration>;
}

async function montar(opciones: { exigir?: boolean } = {}): Promise<Escenario> {
  const individual = await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
  const relevo = await prisma.testType.upsert({ where: { name: "Relevo" }, update: {}, create: { name: "Relevo", swimmersCount: 4 } });
  const sessionType = await prisma.sessionType.upsert({ where: { name: "Mañana" }, update: {}, create: { name: "Mañana" } });
  const catInd = await catalogsCategories.createCategory({ testTypeId: individual.id, name: "Master Rel", minAge: 20, maxAge: 60 }, SYSTEM);
  const catRel = await catalogsCategories.createCategory({ testTypeId: relevo.id, name: "Relevo Rel", minAge: 0, maxAge: 500 }, SYSTEM);

  const club = await createClub("Club Relevos", "CLR", "club_relevos");
  const user = await createUser({ username: "club_relevos", roleNames: ["club"], clubId: club.id });
  const nadadores: { id: string }[] = [];
  for (let i = 0; i < 12; i++) {
    contador++;
    const p = await createPerson({ run: `6${String(contador).padStart(7, "0")}`, username: `rel_${contador}`, firstName: `Nad${i}`, gender: i % 2 ? "male" : "female", birthYear: 1990 });
    await addActiveMembership(club.id, p.id, user.id);
    nadadores.push(p);
  }

  const ahora = new Date();
  const competencia = await competitionsService.createCompetition(
    {
      name: "Copa Condición Relevos",
      registrationStartAt: new Date(ahora.getTime() - 86_400_000),
      registrationEndAt: new Date(ahora.getTime() + 86_400_000),
      ageCutoffDate: new Date(ahora.getFullYear(), 11, 31),
      maxIndividualEventsPerSwimmer: 10,
      maxRelayEventsPerSwimmerPerSession: 1,
      ...(opciones.exigir === undefined ? {} : { requireIndividualForRelay: opciones.exigir }),
    },
    SYSTEM
  );
  await competitionsService.transitionCompetition(competencia.id, "schedule", SYSTEM);
  // Ya abierta en la base (evita que cada lectura tenga que «sanarla» con una transacción propia).
  await prisma.competition.update({ where: { id: competencia.id }, data: { status: "open" } });
  const fecha = await structureService.addCompetitionDate(competencia.id, new Date(), SYSTEM);
  const jornada = await structureService.addSession(fecha.id, sessionType.id, SYSTEM);

  const prueba = async (tipo: { id: string }, categoria: { id: string }, metros: number, estilo: string) => {
    const distancia = await prisma.distance.upsert({ where: { meters: metros }, update: {}, create: { meters: metros } });
    const trazo = await prisma.stroke.upsert({ where: { name: estilo }, update: {}, create: { name: estilo } });
    const evento = await catalogsEvents.createEvent({ testTypeId: tipo.id, distanceId: distancia.id, strokeId: trazo.id, gender: "mixed" }, SYSTEM);
    return competitionEventsService.addCompetitionEvent(competencia.id, { eventId: evento.id, competitionSessionId: jornada.id, categoryIds: [categoria.id] }, SYSTEM);
  };
  const ind1 = await prueba(individual, catInd, 50, "Libre");
  const ind2 = await prueba(individual, catInd, 50, "Espalda");
  const relA = await prueba(relevo, catRel, 200, "Libre");
  const relB = await prueba(relevo, catRel, 200, "Espalda");

  const actor: DeClub = { userId: user.id, isAdmin: false, scope: { kind: "club", clubId: club.id }, canRegisterPostClose: false };
  return {
    competitionId: competencia.id,
    clubId: club.id,
    actor,
    nadadores,
    individualId: ind1.id,
    otraIndividualId: ind2.id,
    relevoA: relA.id,
    relevoB: relB.id,
    inscribir: (personId, competitionEventId = ind1.id, quien = actor) =>
      registrationsService.createRegistration({ competitionEventId, clubId: club.id, personId, seedTimeCentiseconds: 3000 }, quien),
    equipo: (competitionEventId, personIds, quien = actor) => relayService.createRelayRegistration({ competitionEventId, clubId: club.id, personIds }, quien),
  };
}

const ids = (e: Escenario, ...indices: number[]) => indices.map((i) => e.nadadores[i]!.id);
const flag = async (competitionId: string) => (await prisma.competition.findUniqueOrThrow({ where: { id: competitionId } })).requireIndividualForRelay;
const individualesDe = (personId: string) => prisma.registration.count({ where: { personId, status: "confirmed" } });

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_relevos", roleNames: ["admin"] });
  SYSTEM = { userId: admin.id };
  ADMIN = { userId: admin.id, isAdmin: true, scope: { kind: "admin" }, canRegisterPostClose: true };
});

afterAll(async () => {
  await app?.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("valor inicial, persistencia y duplicación", () => {
  it("una competencia nueva nace con la condición ACTIVADA, también las que no indican el campo (importadas)", async () => {
    const e = await montar();
    expect(await flag(e.competitionId)).toBe(true);
  });

  it("alta con false queda desactivada; editar la cambia, y omitirla no la toca", async () => {
    const e = await montar({ exigir: false });
    expect(await flag(e.competitionId)).toBe(false);
    await competitionsService.updateCompetition(e.competitionId, { description: "otra cosa" }, SYSTEM);
    expect(await flag(e.competitionId), "omitido = no se toca").toBe(false);
    await competitionsService.updateCompetition(e.competitionId, { requireIndividualForRelay: true }, SYSTEM);
    expect(await flag(e.competitionId)).toBe(true);
    await competitionsService.updateCompetition(e.competitionId, { requireIndividualForRelay: false }, SYSTEM);
    expect(await flag(e.competitionId)).toBe(false);
  });

  it("DUPLICAR hereda el valor del origen, en los dos sentidos", async () => {
    const e = await montar({ exigir: false });
    const fechas = { registrationStartAt: new Date(Date.now() + 86_400_000), registrationEndAt: new Date(Date.now() + 5 * 86_400_000) };
    const copiaApagada = await competitionsService.duplicateCompetition(e.competitionId, { name: "Copia apagada", ...fechas }, SYSTEM);
    expect(copiaApagada.requireIndividualForRelay).toBe(false);
    await competitionsService.updateCompetition(e.competitionId, { requireIndividualForRelay: true }, SYSTEM);
    const copiaEncendida = await competitionsService.duplicateCompetition(e.competitionId, { name: "Copia encendida", ...fechas }, SYSTEM);
    expect(copiaEncendida.requireIndividualForRelay).toBe(true);
    expect(await flag(copiaApagada.id)).toBe(false);
  });

  it("por HTTP: se guarda y se lee; el texto «false» no es un booleano (400)", async () => {
    const e = await montar();
    app = await buildServer();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin_relevos", password: TEST_PASSWORD } });
    const auth = { authorization: `Bearer ${login.json().accessToken}` };

    const put = (payload: unknown) => app!.inject({ method: "PUT", url: `/competitions/${e.competitionId}`, headers: auth, payload: payload as object });
    expect((await put({ requireIndividualForRelay: "false" })).statusCode).toBe(400);
    expect((await put({ requireIndividualForRelay: false })).statusCode).toBe(200);
    const detalle = (await app.inject({ method: "GET", url: `/competitions/${e.competitionId}`, headers: auth })).json();
    expect(detalle.requireIndividualForRelay).toBe(false);
    expect(detalle.relayTeamsNotMeetingCondition).toBe(0);

    const post = await app.inject({
      method: "POST",
      url: "/competitions",
      headers: auth,
      payload: {
        name: "Alta por HTTP",
        registrationStartAt: new Date(Date.now() + 86_400_000).toISOString(),
        registrationEndAt: new Date(Date.now() + 9 * 86_400_000).toISOString(),
        ageCutoffDate: new Date(Date.UTC(new Date().getUTCFullYear(), 11, 31)).toISOString(),
        maxIndividualEventsPerSwimmer: 3,
      },
    });
    expect(post.json().requireIndividualForRelay).toBe(true);
  });
});

describe("condición ACTIVADA: la invariante de siempre", () => {
  it("crear: un integrante sin individual se rechaza (también al administrador); con las cuatro, se admite", async () => {
    const e = await montar();
    for (const n of ids(e, 0, 1, 2)) await e.inscribir(n);

    await expect(e.equipo(e.relevoA, ids(e, 0, 1, 2, 3))).rejects.toThrow(/solo puede formarse con nadadores que ya tengan una inscripción individual/);
    await expect(e.equipo(e.relevoA, ids(e, 0, 1, 2, 3), ADMIN)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.relayRegistration.count()).toBe(0);

    await e.inscribir(e.nadadores[3]!.id);
    await e.equipo(e.relevoA, ids(e, 0, 1, 2, 3));
    expect(await prisma.relayRegistration.count({ where: { status: "confirmed" } })).toBe(1);
  });

  it("modificar integrantes: cambiar a alguien sin individual se rechaza; a alguien con individual, se admite", async () => {
    const e = await montar();
    // (Relevo mixto: dos mujeres —índices pares— y dos hombres —impares—.)
    for (const n of ids(e, 0, 1, 2, 3, 5)) await e.inscribir(n);
    const equipo = await e.equipo(e.relevoA, ids(e, 0, 1, 2, 3));

    await expect(relayService.updateRelayRegistration(equipo.id, { personIds: ids(e, 0, 1, 2, 7) }, e.actor)).rejects.toBeInstanceOf(ValidationError);
    await relayService.updateRelayRegistration(equipo.id, { personIds: ids(e, 0, 1, 2, 5) }, e.actor);
    const miembros = await prisma.relayRegistrationMember.findMany({ where: { relayRegistrationId: equipo.id } });
    expect(miembros.map((m) => m.personId).sort()).toEqual(ids(e, 0, 1, 2, 5).sort());
  });

  it("cancelar la ÚLTIMA individual de quien integra un relevo confirmado se rechaza", async () => {
    const e = await montar();
    const regs = [];
    for (const n of ids(e, 0, 1, 2, 3)) regs.push(await e.inscribir(n));
    await e.equipo(e.relevoA, ids(e, 0, 1, 2, 3));

    await expect(registrationsService.cancelRegistration(regs[0]!.id, e.actor)).rejects.toThrow(/última inscripción individual confirmada/);
    expect(await individualesDe(e.nadadores[0]!.id)).toBe(1);
  });

  it("OTRA individual confirmada permite cancelar una de ellas; y cancelar el relevo permite cancelar la última", async () => {
    const e = await montar();
    const regs = [];
    for (const n of ids(e, 0, 1, 2, 3)) regs.push(await e.inscribir(n));
    const otra = await e.inscribir(e.nadadores[0]!.id, e.otraIndividualId);
    const equipo = await e.equipo(e.relevoA, ids(e, 0, 1, 2, 3));

    // Nadador 0 tiene dos: cancelar una se permite.
    await registrationsService.cancelRegistration(otra.id, e.actor);
    // Ahora solo le queda una: se rechaza.
    await expect(registrationsService.cancelRegistration(regs[0]!.id, e.actor)).rejects.toBeInstanceOf(ValidationError);
    // Cancelar el relevo sigue siendo posible, y entonces la individual ya se puede cancelar.
    await relayService.cancelRelayRegistration(equipo.id, e.actor);
    await registrationsService.cancelRegistration(regs[0]!.id, e.actor);
    expect(await individualesDe(e.nadadores[0]!.id)).toBe(0);
  });
});

describe("condición DESACTIVADA", () => {
  it("formar un relevo NO exige individual, ni modificarlo", async () => {
    const e = await montar({ exigir: false });
    const equipo = await e.equipo(e.relevoA, ids(e, 0, 1, 2, 3));
    expect(equipo.id).toBeTruthy();
    await relayService.updateRelayRegistration(equipo.id, { personIds: ids(e, 4, 5, 6, 7) }, e.actor);
    const miembros = await prisma.relayRegistrationMember.findMany({ where: { relayRegistrationId: equipo.id } });
    expect(miembros.map((m) => m.personId).sort()).toEqual(ids(e, 4, 5, 6, 7).sort());
    expect(await prisma.registration.count()).toBe(0);
  });

  it("cancelar la última individual de quien integra un relevo NO se bloquea, y el relevo queda como estaba", async () => {
    const e = await montar({ exigir: false });
    const regs = [];
    for (const n of ids(e, 0, 1, 2, 3)) regs.push(await e.inscribir(n));
    const equipo = await e.equipo(e.relevoA, ids(e, 0, 1, 2, 3));

    await registrationsService.cancelRegistration(regs[0]!.id, e.actor);
    expect(await individualesDe(e.nadadores[0]!.id)).toBe(0);
    const relevo = await prisma.relayRegistration.findUniqueOrThrow({ where: { id: equipo.id }, include: { members: true } });
    expect(relevo.status, "no se toca el relevo").toBe("confirmed");
    expect(relevo.members).toHaveLength(4);
  });

  it("apagarla con equipos ya formados no recalcula nada; encenderla de nuevo vuelve a exigir", async () => {
    const e = await montar();
    for (const n of ids(e, 0, 1, 2, 3)) await e.inscribir(n);
    await competitionsService.updateCompetition(e.competitionId, { requireIndividualForRelay: false }, SYSTEM);
    await e.equipo(e.relevoA, ids(e, 4, 5, 6, 7)); // sin individuales
    await competitionsService.updateCompetition(e.competitionId, { requireIndividualForRelay: true }, SYSTEM);
    await expect(e.equipo(e.relevoB, ids(e, 8, 9, 10, 11))).rejects.toBeInstanceOf(ValidationError);
  });

  it("NO relaja el resto: cupos, cierres y límite de relevos por nadador siguen valiendo", async () => {
    const e = await montar({ exigir: false });
    await e.equipo(e.relevoA, ids(e, 0, 1, 2, 3));
    // Límite de 1 relevo por nadador y jornada: el mismo grupo en otra prueba se rechaza.
    await expect(e.equipo(e.relevoB, ids(e, 0, 1, 2, 3))).rejects.toThrow(/relevo/i);
    // Un nadador que no es del club sigue sin poder integrarlo.
    const ajeno = await createPerson({ run: "69999999", username: "ajeno_rel", firstName: "Ajeno", gender: "male", birthYear: 1990 });
    await expect(e.equipo(e.relevoB, [e.nadadores[4]!.id, e.nadadores[5]!.id, e.nadadores[6]!.id, ajeno.id])).rejects.toBeInstanceOf(ValidationError);
    // Cierre total: sin permiso especial no se forma ningún equipo, con la condición apagada o no.
    await prisma.competition.update({ where: { id: e.competitionId }, data: { status: "closed", registrationsClosedReason: "manual", registrationsClosedAt: new Date() } });
    await expect(e.equipo(e.relevoB, ids(e, 4, 5, 6, 7))).rejects.toThrow(/cerradas/);
  });
});

describe("activarla sobre equipos que incumplen: aviso, sin tocar nada", () => {
  /** Dos equipos formados con la condición apagada: A incumple en tres integrantes; B incumple en uno. */
  async function conEquiposIncumplidores() {
    const e = await montar({ exigir: false });
    await e.inscribir(e.nadadores[0]!.id);
    for (const n of ids(e, 4, 5, 6)) await e.inscribir(n);
    await e.equipo(e.relevoA, ids(e, 0, 1, 2, 3)); // 1, 2, 3 sin individual
    await e.equipo(e.relevoB, ids(e, 4, 5, 6, 7)); // 7 sin individual
    return e;
  }

  const fotoDeInscripciones = async () => ({
    individuales: await prisma.registration.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, personId: true } }),
    relevos: await prisma.relayRegistration.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, members: { orderBy: { orderPosition: "asc" }, select: { personId: true } } } }),
  });

  it("el recuento cuenta EQUIPOS distintos (A con tres integrantes sin individual cuenta una vez): 2", async () => {
    const e = await conEquiposIncumplidores();
    const detalle = await competitionsService.getCompetitionDetail(e.competitionId);
    expect(detalle.relayTeamsNotMeetingCondition).toBe(2);
  });

  it("al GUARDAR la activación se informa el recuento, el guardado se permite y NO cambia ninguna inscripción", async () => {
    const e = await conEquiposIncumplidores();
    const antes = await fotoDeInscripciones();
    const filasDeAuditoria = await prisma.auditLog.count();

    const guardada = await competitionsService.updateCompetition(e.competitionId, { requireIndividualForRelay: true }, SYSTEM);

    expect(guardada.requireIndividualForRelay).toBe(true);
    expect(guardada.relayTeamsNotMeetingCondition).toBe(2);
    expect(await fotoDeInscripciones(), "ni modifica, ni cancela, ni retira a nadie").toEqual(antes);
    // Lo único que se escribió fue la competencia y su auditoría.
    expect(await prisma.auditLog.count()).toBeGreaterThan(filasDeAuditoria);
  });

  it("el recuento es de SOLO LECTURA: leer el detalle muchas veces no escribe nada", async () => {
    const e = await conEquiposIncumplidores();
    const antes = { ...(await fotoDeInscripciones()), auditoria: await prisma.auditLog.count(), competencia: await prisma.competition.findUniqueOrThrow({ where: { id: e.competitionId } }) };
    for (let i = 0; i < 3; i++) await competitionsService.getCompetitionDetail(e.competitionId);
    const despues = { ...(await fotoDeInscripciones()), auditoria: await prisma.auditLog.count(), competencia: await prisma.competition.findUniqueOrThrow({ where: { id: e.competitionId } }) };
    expect(despues).toEqual(antes);
  });

  it("las canceladas no cuentan, y regularizar a un integrante baja el recuento", async () => {
    const e = await conEquiposIncumplidores();
    // Regularizar al integrante 7 (equipo B) -> B cumple.
    await e.inscribir(e.nadadores[7]!.id);
    expect((await competitionsService.getCompetitionDetail(e.competitionId)).relayTeamsNotMeetingCondition).toBe(1);
    // Cancelar el equipo A -> ninguno incumple.
    const equipoA = await prisma.relayRegistration.findFirstOrThrow({ where: { competitionEventId: e.relevoA } });
    await relayService.cancelRelayRegistration(equipoA.id, e.actor);
    expect((await competitionsService.getCompetitionDetail(e.competitionId)).relayTeamsNotMeetingCondition).toBe(0);
  });

  it("con la condición activada, EDITAR un equipo incumplidor exige que el resultante cumpla; cancelarlo sigue siendo posible", async () => {
    const e = await conEquiposIncumplidores();
    await competitionsService.updateCompetition(e.competitionId, { requireIndividualForRelay: true }, SYSTEM);
    const equipoB = await prisma.relayRegistration.findFirstOrThrow({ where: { competitionEventId: e.relevoB } });

    // Un equipo resultante que aún incumple: rechazado.
    await expect(relayService.updateRelayRegistration(equipoB.id, { personIds: ids(e, 4, 5, 6, 8) }, e.actor)).rejects.toBeInstanceOf(ValidationError);
    // Regularizando a quien falta, la edición cumple.
    await e.inscribir(e.nadadores[7]!.id);
    await relayService.updateRelayRegistration(equipoB.id, { personIds: ids(e, 4, 5, 6, 7) }, e.actor);

    // El equipo A sigue incumpliendo y se puede cancelar.
    const equipoA = await prisma.relayRegistration.findFirstOrThrow({ where: { competitionEventId: e.relevoA } });
    await relayService.cancelRelayRegistration(equipoA.id, e.actor);
    expect((await prisma.relayRegistration.findUniqueOrThrow({ where: { id: equipoA.id } })).status).toBe("cancelled");
  });

  it("corregir solo el TIEMPO de un equipo incumplidor no es una modificación de integrantes y se permite", async () => {
    const e = await conEquiposIncumplidores();
    await competitionsService.updateCompetition(e.competitionId, { requireIndividualForRelay: true }, SYSTEM);
    const equipoA = await prisma.relayRegistration.findFirstOrThrow({ where: { competitionEventId: e.relevoA } });
    await relayService.updateRelayRegistration(equipoA.id, { seedTimeCentiseconds: 12345 }, e.actor);
    expect((await prisma.relayRegistration.findUniqueOrThrow({ where: { id: equipoA.id } })).seedTimeCentiseconds).toBe(12345);
  });
});

describe("el mensaje del cierre parcial refleja la configuración", () => {
  it("con la condición activada recuerda la individual previa; desactivada, no la afirma", async () => {
    for (const exigir of [true, false]) {
      const e = await montar({ exigir });
      await prisma.competition.update({ where: { id: e.competitionId }, data: { status: "individual_closed", registrationsClosedReason: "capacity", registrationsClosedAt: new Date() } });
      const rechazo = e.inscribir(e.nadadores[0]!.id);
      await expect(rechazo).rejects.toThrow(/Los relevos siguen disponibles/);
      if (exigir) await expect(rechazo).rejects.toThrow(/inscripción individual confirmada/);
      else await expect(rechazo).rejects.not.toThrow(/inscripción individual confirmada/);
      await truncateAllTables(prisma);
      await seedRolesAndPermissions();
      const admin = await createUser({ username: "admin_relevos", roleNames: ["admin"] });
      SYSTEM = { userId: admin.id };
    }
  });
});
