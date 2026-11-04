/**
 * Etapa 4 — máximo de nadadores POR CLUB en una PRUEBA individual, contra PostgreSQL real.
 *
 * UNIDAD DE CONTEO: inscripciones individuales CONFIRMADAS del club en ESA prueba de
 * competencia (equivale a nadadores distintos de ese club en esa prueba). Independiente de
 * los cupos de la competencia y de cuántas otras pruebas tenga cada nadador.
 *
 * Lo que solo se puede comprobar con la base: que el conteo y el alta comparten la
 * transacción serializable (dos altas sobre el último cupo no lo exceden), y que la
 * auditoría de la excepción del administrador comparte esa misma transacción (si falla,
 * el alta se revierte).
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
import * as catalogsCategories from "../src/modules/catalogs/categories.service";
import * as catalogsEvents from "../src/modules/catalogs/events.service";
import { ValidationError } from "../src/shared/errors";

const ACCION = "REGISTRATION_CREATED_OVER_EVENT_CLUB_LIMIT_BY_ADMIN";

type Admin = { userId: string; isAdmin: true; scope: { kind: "admin" }; canRegisterPostClose: boolean };
type DeClub = { userId: string; isAdmin: false; scope: { kind: "club"; clubId: string }; canRegisterPostClose: boolean };

let SYSTEM: { userId: string };
let ADMIN: Admin;
let app: FastifyInstance | undefined;
let contador = 0;

interface Escenario {
  competitionId: string;
  clubA: { id: string; name: string };
  clubB: { id: string; name: string };
  actorA: DeClub;
  /** Personal de club con el permiso posterior al cierre, pero sin ser administrador. */
  actorAConPermisoPostCierre: DeClub;
  actorB: DeClub;
  nadadoresA: { id: string }[];
  nadadoresB: { id: string }[];
  sessionId: string;
  categoryId: string;
  crearPrueba: (estilo: string, metros: number, maxSwimmersPerClub?: number | null) => Promise<{ id: string }>;
  inscribir: (competitionEventId: string, clubId: string, personId: string, actor: Admin | DeClub) => ReturnType<typeof registrationsService.createRegistration>;
}

async function montar(): Promise<Escenario> {
  const individual = await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
  const relevo = await prisma.testType.upsert({ where: { name: "Relevo" }, update: {}, create: { name: "Relevo", swimmersCount: 4 } });
  const sessionType = await prisma.sessionType.upsert({ where: { name: "Mañana" }, update: {}, create: { name: "Mañana" } });
  const categoria = await catalogsCategories.createCategory({ testTypeId: individual.id, name: "Master Limite", minAge: 20, maxAge: 60 }, SYSTEM);
  await catalogsCategories.createCategory({ testTypeId: relevo.id, name: "Relevo Limite", minAge: 0, maxAge: 500 }, SYSTEM);

  const clubA = await createClub("Club Alfa", "CLA", "club_alfa");
  const clubB = await createClub("Club Beta", "CLB", "club_beta");
  const userA = await createUser({ username: "club_alfa", roleNames: ["club"], clubId: clubA.id });
  const userB = await createUser({ username: "club_beta", roleNames: ["club"], clubId: clubB.id });

  const nuevosNadadores = async (club: { id: string }, userId: string, prefijo: string, n: number) => {
    const lista: { id: string }[] = [];
    for (let i = 0; i < n; i++) {
      contador++;
      const p = await createPerson({ run: `7${String(contador).padStart(7, "0")}`, username: `${prefijo}_${contador}`, firstName: `${prefijo}${i}`, gender: i % 2 ? "male" : "female", birthYear: 1990 });
      await addActiveMembership(club.id, p.id, userId);
      lista.push(p);
    }
    return lista;
  };
  const nadadoresA = await nuevosNadadores(clubA, userA.id, "alfa", 6);
  const nadadoresB = await nuevosNadadores(clubB, userB.id, "beta", 3);

  const ahora = new Date();
  const competencia = await competitionsService.createCompetition(
    {
      name: "Copa Límite por Club",
      registrationStartAt: new Date(ahora.getTime() - 86_400_000),
      registrationEndAt: new Date(ahora.getTime() + 86_400_000),
      ageCutoffDate: new Date(ahora.getFullYear(), 11, 31),
      maxIndividualEventsPerSwimmer: 10,
      maxRelayEventsPerSwimmerPerSession: 1,
    },
    SYSTEM
  );
  await competitionsService.transitionCompetition(competencia.id, "schedule", SYSTEM);
  const fecha = await structureService.addCompetitionDate(competencia.id, new Date(), SYSTEM);
  const jornada = await structureService.addSession(fecha.id, sessionType.id, SYSTEM);

  const crearPrueba = async (estilo: string, metros: number, maxSwimmersPerClub?: number | null) => {
    const distancia = await prisma.distance.upsert({ where: { meters: metros }, update: {}, create: { meters: metros } });
    const trazo = await prisma.stroke.upsert({ where: { name: estilo }, update: {}, create: { name: estilo } });
    const evento = await catalogsEvents.createEvent({ testTypeId: individual.id, distanceId: distancia.id, strokeId: trazo.id, gender: "mixed" }, SYSTEM);
    return competitionEventsService.addCompetitionEvent(
      competencia.id,
      { eventId: evento.id, competitionSessionId: jornada.id, categoryIds: [categoria.id], ...(maxSwimmersPerClub === undefined ? {} : { maxSwimmersPerClub }) },
      SYSTEM
    );
  };

  return {
    competitionId: competencia.id,
    clubA: { id: clubA.id, name: clubA.name },
    clubB: { id: clubB.id, name: clubB.name },
    actorA: { userId: userA.id, isAdmin: false, scope: { kind: "club", clubId: clubA.id }, canRegisterPostClose: false },
    actorAConPermisoPostCierre: { userId: userA.id, isAdmin: false, scope: { kind: "club", clubId: clubA.id }, canRegisterPostClose: true },
    actorB: { userId: userB.id, isAdmin: false, scope: { kind: "club", clubId: clubB.id }, canRegisterPostClose: false },
    nadadoresA,
    nadadoresB,
    sessionId: jornada.id,
    categoryId: categoria.id,
    crearPrueba,
    inscribir: (competitionEventId, clubId, personId, actor) =>
      registrationsService.createRegistration({ competitionEventId, clubId, personId, seedTimeCentiseconds: 3000 }, actor),
  };
}

const confirmadas = (competitionEventId: string, clubId?: string) =>
  prisma.registration.count({ where: { competitionEventId, status: "confirmed", ...(clubId ? { clubId } : {}) } });

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_limite", roleNames: ["admin"] });
  SYSTEM = { userId: admin.id };
  ADMIN = { userId: admin.id, isAdmin: true, scope: { kind: "admin" }, canRegisterPostClose: true };
});

afterAll(async () => {
  await app?.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("valor predeterminado y bordes", () => {
  it("una prueba nueva nace SIN LÍMITE (NULL) y admite tantas inscripciones del club como se quiera", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50);
    expect((await prisma.competitionEvent.findUniqueOrThrow({ where: { id: prueba.id } })).maxSwimmersPerClub).toBeNull();
    for (const n of e.nadadoresA) await e.inscribir(prueba.id, e.clubA.id, n.id, e.actorA);
    expect(await confirmadas(prueba.id, e.clubA.id)).toBe(6);
  });

  it("LÍMITE 1: la primera cabe y la siguiente se rechaza con un mensaje claro para el club", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 1);
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA);

    const rechazo = e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[1]!.id, e.actorA);
    await expect(rechazo).rejects.toBeInstanceOf(ValidationError);
    await expect(rechazo).rejects.toThrow(/Club Alfa.*máximo de 1.*«50m Libre».*No quedan cupos/s);
    expect(await confirmadas(prueba.id, e.clubA.id)).toBe(1);
  });

  it("JUSTO EN EL LÍMITE (3): las tres caben, la cuarta se rechaza", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 3);
    for (const n of e.nadadoresA.slice(0, 3)) await e.inscribir(prueba.id, e.clubA.id, n.id, e.actorA);
    await expect(e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[3]!.id, e.actorA)).rejects.toBeInstanceOf(ValidationError);
    expect(await confirmadas(prueba.id, e.clubA.id)).toBe(3);
  });

  it("OTRO CLUB y OTRA PRUEBA no consumen ese cupo", async () => {
    const e = await montar();
    const limitada = await e.crearPrueba("Libre", 50, 1);
    const otra = await e.crearPrueba("Espalda", 50, 1);
    const sinLimite = await e.crearPrueba("Pecho", 50);

    await e.inscribir(limitada.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA);
    // El club B tiene su propio cupo en la misma prueba.
    await e.inscribir(limitada.id, e.clubB.id, e.nadadoresB[0]!.id, e.actorB);
    await expect(e.inscribir(limitada.id, e.clubB.id, e.nadadoresB[1]!.id, e.actorB)).rejects.toBeInstanceOf(ValidationError);
    // El club A en OTRA prueba (con su propio límite) y en una sin límite.
    await e.inscribir(otra.id, e.clubA.id, e.nadadoresA[1]!.id, e.actorA);
    for (const n of e.nadadoresA.slice(0, 4)) await e.inscribir(sinLimite.id, e.clubA.id, n.id, e.actorA);

    expect(await confirmadas(limitada.id, e.clubA.id)).toBe(1);
    expect(await confirmadas(limitada.id, e.clubB.id)).toBe(1);
  });

  it("no importa en cuántas otras pruebas esté el nadador: solo cuenta SU club en ESTA prueba", async () => {
    const e = await montar();
    const a = await e.crearPrueba("Libre", 50);
    const b = await e.crearPrueba("Espalda", 50);
    const limitada = await e.crearPrueba("Pecho", 50, 2);
    // Los dos primeros nadadores ya están en otras dos pruebas cada uno.
    for (const n of e.nadadoresA.slice(0, 2)) {
      await e.inscribir(a.id, e.clubA.id, n.id, e.actorA);
      await e.inscribir(b.id, e.clubA.id, n.id, e.actorA);
    }
    // Eso no gasta nada del cupo de la prueba limitada.
    await e.inscribir(limitada.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA);
    await e.inscribir(limitada.id, e.clubA.id, e.nadadoresA[1]!.id, e.actorA);
    await expect(e.inscribir(limitada.id, e.clubA.id, e.nadadoresA[2]!.id, e.actorA)).rejects.toBeInstanceOf(ValidationError);
  });

  it("es INDEPENDIENTE de los cupos de la competencia: no los toca ni los consulta", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 2);
    await prisma.competition.update({ where: { id: e.competitionId }, data: { maxSwimmers: 100, maxSwimmersPerClub: 100 } });
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA);
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[1]!.id, e.actorA);
    // Los cupos de la competencia sobran, y aun así el límite por prueba rechaza.
    await expect(e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[2]!.id, e.actorA)).rejects.toThrow(/máximo de 2/);
    // Y a la inversa: sin límite por prueba, los cupos de la competencia siguen mandando.
    const sinLimite = await e.crearPrueba("Espalda", 50);
    await prisma.competition.update({ where: { id: e.competitionId }, data: { maxSwimmersPerClub: 2 } });
    await e.inscribir(sinLimite.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA);
    await expect(e.inscribir(sinLimite.id, e.clubA.id, e.nadadoresA[5]!.id, e.actorA)).rejects.toThrow(/cupo/);
  });
});

describe("cancelación, reducción del límite y edición", () => {
  it("una CANCELACIÓN libera el cupo y la siguiente inscripción cabe", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 1);
    const primera = await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA);
    await expect(e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[1]!.id, e.actorA)).rejects.toBeInstanceOf(ValidationError);

    await registrationsService.cancelRegistration(primera.id, e.actorA);
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[1]!.id, e.actorA);
    expect(await confirmadas(prueba.id, e.clubA.id)).toBe(1);
    // La cancelada no cuenta, pero queda registrada.
    expect(await prisma.registration.count({ where: { competitionEventId: prueba.id, status: "cancelled" } })).toBe(1);
  });

  it("REDUCIR el límite por debajo de lo ya inscrito NO elimina ni cancela nada: solo restringe las altas", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 4);
    for (const n of e.nadadoresA.slice(0, 3)) await e.inscribir(prueba.id, e.clubA.id, n.id, e.actorA);

    await competitionEventsService.updateCompetitionEvent(prueba.id, { maxSwimmersPerClub: 1 }, SYSTEM);

    expect(await confirmadas(prueba.id, e.clubA.id), "las tres siguen confirmadas").toBe(3);
    await expect(e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[3]!.id, e.actorA)).rejects.toThrow(/ya tiene 3 nadador\(es\) inscrito\(s\) y el máximo por club se fijó en 1/);
    // Hasta que bajen de 1 no entra nadie: cancelar dos no basta (quedaría 1 de 1).
    const vigentes = await prisma.registration.findMany({ where: { competitionEventId: prueba.id, status: "confirmed" }, orderBy: { createdAt: "asc" } });
    await registrationsService.cancelRegistration(vigentes[0]!.id, e.actorA);
    await registrationsService.cancelRegistration(vigentes[1]!.id, e.actorA);
    await expect(e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[3]!.id, e.actorA)).rejects.toBeInstanceOf(ValidationError);
    await registrationsService.cancelRegistration(vigentes[2]!.id, e.actorA);
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[3]!.id, e.actorA);
  });

  it("AMPLIAR o QUITAR el límite (null) vuelve a admitir altas", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 1);
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA);
    await competitionEventsService.updateCompetitionEvent(prueba.id, { maxSwimmersPerClub: 2 }, SYSTEM);
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[1]!.id, e.actorA);
    await competitionEventsService.updateCompetitionEvent(prueba.id, { maxSwimmersPerClub: null }, SYSTEM);
    expect((await prisma.competitionEvent.findUniqueOrThrow({ where: { id: prueba.id } })).maxSwimmersPerClub).toBeNull();
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[2]!.id, e.actorA);
  });

  it("editar OTRO campo de la prueba sin enviar el límite no lo cambia", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 3);
    await competitionEventsService.updateCompetitionEvent(prueba.id, { displayOrder: 7 }, SYSTEM);
    expect((await prisma.competitionEvent.findUniqueOrThrow({ where: { id: prueba.id } })).maxSwimmersPerClub).toBe(3);
  });
});

describe("valores inválidos y relevos", () => {
  it("la base rechaza 0 y negativos aunque se salte la API (CHECK)", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50);
    for (const malo of [0, -1]) {
      await expect(prisma.competitionEvent.update({ where: { id: prueba.id }, data: { maxSwimmersPerClub: malo } })).rejects.toThrow(/competition_events_max_swimmers_per_club_positivo|check/i);
    }
  });

  it("una prueba de RELEVO rechaza el campo, en el alta y en la edición, con un mensaje claro", async () => {
    const e = await montar();
    const relevo = await prisma.testType.findUniqueOrThrow({ where: { name: "Relevo" } });
    const categoria = await prisma.category.findFirstOrThrow({ where: { testTypeId: relevo.id } });
    const distancia = await prisma.distance.upsert({ where: { meters: 200 }, update: {}, create: { meters: 200 } });
    const trazo = await prisma.stroke.upsert({ where: { name: "Libre" }, update: {}, create: { name: "Libre" } });
    const evento = await catalogsEvents.createEvent({ testTypeId: relevo.id, distanceId: distancia.id, strokeId: trazo.id, gender: "mixed" }, SYSTEM);

    await expect(
      competitionEventsService.addCompetitionEvent(e.competitionId, { eventId: evento.id, competitionSessionId: e.sessionId, categoryIds: [categoria.id], maxSwimmersPerClub: 2 }, SYSTEM)
    ).rejects.toThrow(/solo se configura en pruebas individuales/);
    expect(await prisma.competitionEvent.count({ where: { eventId: evento.id } }), "no se creó nada").toBe(0);

    // Sin límite sí se puede crear; y después, ni asignarle uno ni «quitarlo» da error (null no es un valor).
    const creada = await competitionEventsService.addCompetitionEvent(e.competitionId, { eventId: evento.id, competitionSessionId: e.sessionId, categoryIds: [categoria.id] }, SYSTEM);
    await expect(competitionEventsService.updateCompetitionEvent(creada.id, { maxSwimmersPerClub: 3 }, SYSTEM)).rejects.toThrow(/solo se configura en pruebas individuales/);
    await competitionEventsService.updateCompetitionEvent(creada.id, { maxSwimmersPerClub: null }, SYSTEM);
    expect((await prisma.competitionEvent.findUniqueOrThrow({ where: { id: creada.id } })).maxSwimmersPerClub).toBeNull();
  });

  it("por HTTP: 0, negativo, decimal y texto responden 400; un entero válido se guarda", async () => {
    const e = await montar();
    app = await buildServer();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin_limite", password: TEST_PASSWORD } });
    const token = login.json().accessToken as string;
    const auth = { authorization: `Bearer ${token}` };
    const prueba = await e.crearPrueba("Libre", 50);

    for (const malo of [0, -3, 1.5, "abc"]) {
      const r = await app.inject({ method: "PUT", url: `/competition-events/${prueba.id}`, headers: auth, payload: { maxSwimmersPerClub: malo } });
      expect(r.statusCode, `«${String(malo)}»`).toBe(400);
    }
    const ok = await app.inject({ method: "PUT", url: `/competition-events/${prueba.id}`, headers: auth, payload: { maxSwimmersPerClub: 4 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().maxSwimmersPerClub).toBe(4);
    const lista = await app.inject({ method: "GET", url: `/competitions/${e.competitionId}/events`, headers: auth });
    expect(lista.json().find((x: { id: string }) => x.id === prueba.id).maxSwimmersPerClub).toBe(4);
  });
});

describe("duplicar e importar", () => {
  it("DUPLICAR hereda el límite de cada prueba (con y sin límite)", async () => {
    const e = await montar();
    const conLimite = await e.crearPrueba("Libre", 50, 3);
    const sinLimite = await e.crearPrueba("Espalda", 50);
    const copia = await competitionsService.duplicateCompetition(
      e.competitionId,
      { name: "Copia con límites", registrationStartAt: new Date(Date.now() + 86_400_000), registrationEndAt: new Date(Date.now() + 5 * 86_400_000) },
      SYSTEM
    );
    const eventos = await prisma.competitionEvent.findMany({ where: { competitionId: copia.id } });
    const porEvento = new Map(eventos.map((c) => [c.eventId, c.maxSwimmersPerClub]));
    const origen = await prisma.competitionEvent.findMany({ where: { id: { in: [conLimite.id, sinLimite.id] } } });
    for (const o of origen) expect(porEvento.get(o.eventId), `prueba ${o.eventId}`).toBe(o.maxSwimmersPerClub);
    expect([...porEvento.values()].sort()).toEqual([3, null]);
  });

  it("una prueba creada SIN indicar el límite —el camino de la importación de Meet Events— queda sin límite", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50);
    expect(prueba).toMatchObject({ maxSwimmersPerClub: null });
  });
});

describe("protección contra altas simultáneas (transacción serializable)", () => {
  it("dos altas sobre el ÚLTIMO cupo: nunca quedan dos, en ninguna de varias rondas", async () => {
    const e = await montar();
    for (let ronda = 0; ronda < 4; ronda++) {
      const prueba = await e.crearPrueba(`Estilo${ronda}`, 50 + ronda * 50, 1);
      const resultados = await Promise.allSettled([
        e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA),
        e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[1]!.id, e.actorA),
      ]);
      const aceptadas = resultados.filter((r) => r.status === "fulfilled").length;
      expect(await confirmadas(prueba.id, e.clubA.id), `ronda ${ronda}`).toBeLessThanOrEqual(1);
      expect(aceptadas, `ronda ${ronda}: lo aceptado coincide con lo guardado`).toBe(await confirmadas(prueba.id, e.clubA.id));
      // La rechazada falla con el mensaje del límite o con el conflicto de serialización (reintentable).
      for (const r of resultados.filter((x) => x.status === "rejected")) expect(String((r as PromiseRejectedResult).reason?.message ?? r)).toMatch(/máximo de 1|No quedan cupos|Otra operación modificó estos datos/i);
    }
  });

  it("tres altas simultáneas con 2 cupos: nunca más de 2", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 2);
    await Promise.allSettled(e.nadadoresA.slice(0, 3).map((n) => e.inscribir(prueba.id, e.clubA.id, n.id, e.actorA)));
    expect(await confirmadas(prueba.id, e.clubA.id)).toBeLessThanOrEqual(2);
  });

  it("un club y otro compiten por separado: ambos entran aunque lleguen a la vez", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 1);
    for (let i = 0; i < 3; i++) {
      // Reintenta solo si la base pidió reintentar: el punto es que cada club puede tener su cupo.
      await Promise.allSettled([e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA), e.inscribir(prueba.id, e.clubB.id, e.nadadoresB[0]!.id, e.actorB)]);
      if ((await confirmadas(prueba.id, e.clubA.id)) === 1 && (await confirmadas(prueba.id, e.clubB.id)) === 1) break;
    }
    expect(await confirmadas(prueba.id, e.clubA.id)).toBe(1);
    expect(await confirmadas(prueba.id, e.clubB.id)).toBe(1);
  });
});

describe("la excepción del administrador y su auditoría", () => {
  it("el ADMINISTRADOR excede el límite y queda UNA fila de auditoría con autor, club, competencia, prueba, límite y cantidad", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 1);
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA);

    const extra = await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[1]!.id, ADMIN);
    expect(await confirmadas(prueba.id, e.clubA.id)).toBe(2);

    const filas = await prisma.auditLog.findMany({ where: { action: ACCION } });
    expect(filas).toHaveLength(1);
    const fila = filas[0]!;
    expect(fila.userId).toBe(ADMIN.userId);
    expect(fila.entityType).toBe("Registration");
    expect(fila.entityId).toBe(extra.id);
    expect(fila.after).toMatchObject({
      autor: ADMIN.userId,
      clubId: e.clubA.id,
      clubName: "Club Alfa",
      competitionId: e.competitionId,
      competitionEventId: prueba.id,
      maxSwimmersPerClub: 1,
      cantidadResultante: 2,
      excedente: 1,
    });
    // La alta normal sigue dejando su propia auditoría.
    expect(await prisma.auditLog.count({ where: { action: "REGISTRATION_CREATED", entityId: extra.id } })).toBe(1);
  });

  it("el administrador que NO excede no deja fila de excepción", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 3);
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[0]!.id, ADMIN);
    expect(await prisma.auditLog.count({ where: { action: ACCION } })).toBe(0);
  });

  it("quien NO es administrador no excede, ni siquiera con el permiso posterior al cierre", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 1);
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA);

    await expect(e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[1]!.id, e.actorAConPermisoPostCierre)).rejects.toThrow(/máximo de 1/);
    expect(await confirmadas(prueba.id, e.clubA.id)).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: ACCION } })).toBe(0);
  });

  it("FALLO DE AUDITORÍA: la excepción se revierte entera, no queda la inscripción sin rastro", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 1);
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA);

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION _sabotaje_limite() RETURNS trigger AS $BODY$
      BEGIN
        IF NEW.action = '${ACCION}' THEN RAISE EXCEPTION 'sabotaje de prueba: falla la auditoría de la excepción'; END IF;
        RETURN NEW;
      END; $BODY$ LANGUAGE plpgsql;`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER _sabotaje_limite BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION _sabotaje_limite();`);
    try {
      await expect(e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[1]!.id, ADMIN)).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS _sabotaje_limite ON audit_logs;`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS _sabotaje_limite();`);
    }

    expect(await confirmadas(prueba.id, e.clubA.id), "la inscripción excedente no quedó").toBe(1);
    expect(await prisma.auditLog.count({ where: { action: ACCION } })).toBe(0);
    expect(await prisma.registration.count({ where: { personId: e.nadadoresA[1]!.id } })).toBe(0);
  });

  it("NO relaja otras reglas: el administrador sigue sin poder inscribir a un nadador de otro club ni pasar el máximo por nadador", async () => {
    const e = await montar();
    const prueba = await e.crearPrueba("Libre", 50, 1);
    await e.inscribir(prueba.id, e.clubA.id, e.nadadoresA[0]!.id, e.actorA);

    // Un nadador del club B inscrito «por» el club A: la pertenencia al club se sigue exigiendo.
    await expect(e.inscribir(prueba.id, e.clubA.id, e.nadadoresB[0]!.id, ADMIN)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.auditLog.count({ where: { action: ACCION } })).toBe(0);

    // El máximo de pruebas por nadador de la competencia también sigue valiendo.
    await prisma.competition.update({ where: { id: e.competitionId }, data: { maxIndividualEventsPerSwimmer: 1 } });
    const otra = await e.crearPrueba("Espalda", 50);
    await expect(e.inscribir(otra.id, e.clubA.id, e.nadadoresA[0]!.id, ADMIN)).rejects.toBeInstanceOf(ValidationError);
  });
});
