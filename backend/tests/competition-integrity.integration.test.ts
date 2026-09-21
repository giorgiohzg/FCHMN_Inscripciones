/**
 * Fase 2 — integridad de competencias e inscripciones, verificada contra
 * PostgreSQL real. Estas reglas NO se pueden comprobar con funciones puras:
 * dependen de índices, claves foráneas y del comportamiento del motor bajo
 * concurrencia.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addActiveMembership } from "./helpers/seedRbac";
import * as competitionsService from "../src/modules/competitions/competitions.service";
import * as structureService from "../src/modules/competitions/competition-structure.service";
import * as competitionEventsService from "../src/modules/competitions/competition-events.service";
import * as registrationsService from "../src/modules/registrations/registrations.service";
import * as catalogsCategories from "../src/modules/catalogs/categories.service";
import * as catalogsEvents from "../src/modules/catalogs/events.service";
import * as categoryGroupsService from "../src/modules/catalogs/category-groups.service";
import * as relayService from "../src/modules/relay-registrations/relay-registrations.service";
import { ValidationError, ConflictError, AppError } from "../src/shared/errors";

/**
 * El actor apunta a un usuario REAL de la base.
 *
 * Desde el hallazgo 23 la auditoría de las escrituras de negocio comparte
 * transacción con el cambio, así que un `userId` inventado hace fallar la
 * clave foránea de `audit_logs.user_id` y REVIERTE la operación entera. Antes
 * el fallo se tragaba en silencio y el fixture funcionaba igual; ahora no, y
 * está bien que no: es la garantía haciendo su trabajo.
 */
let SYSTEM_ACTOR: { userId: string };
let ADMIN_ACTOR: { userId: string; isAdmin: true; scope: { kind: "admin" }; canRegisterPostClose: boolean };

interface Escenario {
  competitionId: string;
  clubId: string;
  personId: string;
  sessionId: string;
  competitionEventId: string;
  individualTestTypeId: string;
  distanceId: string;
  strokeId: string;
  categoryId: string;
}

/** Competencia ABIERTA, con una fecha, una jornada y una prueba individual. */
async function montarEscenario(opts: { maxIndividualEventsPerSwimmer?: number } = {}): Promise<Escenario> {
  const testType = await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
  await prisma.testType.upsert({ where: { name: "Relevo" }, update: {}, create: { name: "Relevo", swimmersCount: 4 } });
  const distance = await prisma.distance.upsert({ where: { meters: 50 }, update: {}, create: { meters: 50 } });
  const stroke = await prisma.stroke.upsert({ where: { name: "Libre" }, update: {}, create: { name: "Libre" } });
  const sessionType = await prisma.sessionType.upsert({ where: { name: "Mañana" }, update: {}, create: { name: "Mañana" } });

  const club = await createClub("Club Integridad", "CLBI", "club_integridad");
  const persona = await createPerson({ run: "90000001", username: "nadador_integridad", firstName: "Nadadora", gender: "female", birthYear: 1990 });
  const user = await createUser({ username: "club_integridad", roleNames: ["club"], clubId: club.id });
  await addActiveMembership(club.id, persona.id, user.id);

  const category = await catalogsCategories.createCategory({ testTypeId: testType.id, name: "Master Test", minAge: 20, maxAge: 60 }, SYSTEM_ACTOR);

  const ahora = new Date();
  const competition = await competitionsService.createCompetition(
    {
      name: "Competencia Integridad",
      registrationStartAt: new Date(ahora.getTime() - 86_400_000),
      registrationEndAt: new Date(ahora.getTime() + 86_400_000),
      ageCutoffDate: new Date(ahora.getFullYear(), 11, 31),
      maxIndividualEventsPerSwimmer: opts.maxIndividualEventsPerSwimmer ?? 10,
      maxRelayEventsPerSwimmerPerSession: 1,
    },
    SYSTEM_ACTOR
  );
  // Debe estar ABIERTA para admitir inscripciones (hallazgo 10).
  await competitionsService.transitionCompetition(competition.id, "schedule", SYSTEM_ACTOR);

  const fecha = await structureService.addCompetitionDate(competition.id, new Date(), SYSTEM_ACTOR);
  const session = await structureService.addSession(fecha.id, sessionType.id, SYSTEM_ACTOR);

  const event = await catalogsEvents.createEvent(
    { testTypeId: testType.id, distanceId: distance.id, strokeId: stroke.id, gender: "mixed" },
    SYSTEM_ACTOR
  );
  const ce = await competitionEventsService.addCompetitionEvent(
    competition.id,
    { eventId: event.id, competitionSessionId: session.id, categoryIds: [category.id] },
    SYSTEM_ACTOR
  );

  return {
    competitionId: competition.id,
    clubId: club.id,
    personId: persona.id,
    sessionId: session.id,
    competitionEventId: ce.id,
    individualTestTypeId: testType.id,
    distanceId: distance.id,
    strokeId: stroke.id,
    categoryId: category.id,
  };
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();

  const admin = await createUser({ username: "admin_integridad", roleNames: ["admin"] });
  SYSTEM_ACTOR = { userId: admin.id };
  ADMIN_ACTOR = { userId: admin.id, isAdmin: true, scope: { kind: "admin" }, canRegisterPostClose: true };
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("hallazgo 6 — la jornada debe pertenecer a la competencia", () => {
  it("RECHAZA asignar una prueba a la jornada de OTRA competencia", async () => {
    const a = await montarEscenario();

    // Segunda competencia con su propia fecha y jornada.
    const otra = await competitionsService.createCompetition(
      {
        name: "Otra competencia",
        registrationStartAt: new Date(Date.now() - 86_400_000),
        registrationEndAt: new Date(Date.now() + 86_400_000),
        ageCutoffDate: new Date(),
        maxIndividualEventsPerSwimmer: 5,
        maxRelayEventsPerSwimmerPerSession: 1,
      },
      SYSTEM_ACTOR
    );
    const fechaAjena = await structureService.addCompetitionDate(otra.id, new Date(), SYSTEM_ACTOR);
    const tipoTarde = await prisma.sessionType.upsert({ where: { name: "Tarde" }, update: {}, create: { name: "Tarde" } });
    const jornadaAjena = await structureService.addSession(fechaAjena.id, tipoTarde.id, SYSTEM_ACTOR);

    const evento = await prisma.event.findFirstOrThrow({});

    await expect(
      competitionEventsService.addCompetitionEvent(
        a.competitionId,
        { eventId: evento.id, competitionSessionId: jornadaAjena.id, categoryIds: [a.categoryId] },
        SYSTEM_ACTOR
      )
    ).rejects.toThrow(/pertenece a otra competencia/i);
  });

  it("la base de datos también lo impide, no solo el servicio", async () => {
    const a = await montarEscenario();
    const otra = await competitionsService.createCompetition(
      {
        name: "Otra competencia BD",
        registrationStartAt: new Date(Date.now() - 86_400_000),
        registrationEndAt: new Date(Date.now() + 86_400_000),
        ageCutoffDate: new Date(),
        maxIndividualEventsPerSwimmer: 5,
        maxRelayEventsPerSwimmerPerSession: 1,
      },
      SYSTEM_ACTOR
    );
    const fechaAjena = await structureService.addCompetitionDate(otra.id, new Date(), SYSTEM_ACTOR);
    const tipoNoche = await prisma.sessionType.upsert({ where: { name: "Noche" }, update: {}, create: { name: "Noche" } });
    const jornadaAjena = await structureService.addSession(fechaAjena.id, tipoNoche.id, SYSTEM_ACTOR);
    const evento = await prisma.event.findFirstOrThrow({});

    // Escritura directa, saltándose el servicio: la clave foránea compuesta
    // (competition_session_id, competition_id) debe rechazarla.
    await expect(
      prisma.competitionEvent.create({
        data: { competitionId: a.competitionId, eventId: evento.id, competitionSessionId: jornadaAjena.id },
      })
    ).rejects.toThrow();
  });
});

describe("hallazgo 7 — eliminar una prueba no destruye inscripciones", () => {
  it("RECHAZA eliminar una prueba con inscripciones y las conserva", async () => {
    const e = await montarEscenario();
    await registrationsService.createRegistration({ competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId }, ADMIN_ACTOR);

    await expect(competitionEventsService.removeCompetitionEvent(e.competitionEventId, SYSTEM_ACTOR)).rejects.toThrow(/no se puede eliminar/i);

    // Lo importante: la inscripción sigue existiendo.
    expect(await prisma.registration.count()).toBe(1);
  });

  it("conserva también las inscripciones CANCELADAS (son historial)", async () => {
    const e = await montarEscenario();
    const reg = await registrationsService.createRegistration(
      { competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId },
      ADMIN_ACTOR
    );
    await registrationsService.cancelRegistration(reg.id, ADMIN_ACTOR);

    await expect(competitionEventsService.removeCompetitionEvent(e.competitionEventId, SYSTEM_ACTOR)).rejects.toThrow(/historial/i);
    expect(await prisma.registration.count()).toBe(1);
  });

  it("PERMITE eliminar una prueba sin inscripciones", async () => {
    const e = await montarEscenario();
    await competitionEventsService.removeCompetitionEvent(e.competitionEventId, SYSTEM_ACTOR);
    expect(await prisma.competitionEvent.count()).toBe(0);
  });

  it("la base de datos rechaza el borrado aunque se llame directo a Prisma", async () => {
    const e = await montarEscenario();
    await registrationsService.createRegistration({ competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId }, ADMIN_ACTOR);

    await expect(prisma.competitionEvent.delete({ where: { id: e.competitionEventId } })).rejects.toThrow();
    expect(await prisma.registration.count()).toBe(1);
  });
});

describe("hallazgo 8 — coherencia con el tipo de prueba", () => {
  it("RECHAZA inscribir a un solo nadador en una prueba de RELEVO", async () => {
    const e = await montarEscenario();

    const relevoTipo = await prisma.testType.findUniqueOrThrow({ where: { name: "Relevo" } });
    const categoriaRelevo = await catalogsCategories.createCategory(
      { testTypeId: relevoTipo.id, name: "Relevo Test", minAge: 80, maxAge: 400 },
      SYSTEM_ACTOR
    );
    const eventoRelevo = await catalogsEvents.createEvent(
      { testTypeId: relevoTipo.id, distanceId: e.distanceId, strokeId: e.strokeId, gender: "mixed" },
      SYSTEM_ACTOR
    );
    const ceRelevo = await competitionEventsService.addCompetitionEvent(
      e.competitionId,
      { eventId: eventoRelevo.id, competitionSessionId: e.sessionId, categoryIds: [categoriaRelevo.id] },
      SYSTEM_ACTOR
    );

    await expect(
      registrationsService.createRegistration({ competitionEventId: ceRelevo.id, clubId: e.clubId, personId: e.personId }, ADMIN_ACTOR)
    ).rejects.toThrow(/no admite una inscripción individual/i);
  });
});

describe("hallazgo 9 — concurrencia real", () => {
  it("dos inscripciones SIMULTÁNEAS del mismo nadador en la misma prueba: solo una queda", async () => {
    const e = await montarEscenario();

    const resultados = await Promise.allSettled([
      registrationsService.createRegistration({ competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId }, ADMIN_ACTOR),
      registrationsService.createRegistration({ competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId }, ADMIN_ACTOR),
    ]);

    const exitosas = resultados.filter((r) => r.status === "fulfilled");
    expect(exitosas).toHaveLength(1);
    expect(await prisma.registration.count({ where: { status: "confirmed" } })).toBe(1);

    const fallida = resultados.find((r) => r.status === "rejected") as PromiseRejectedResult;
    // El rechazo debe ser comprensible (409 o validación), nunca un 500.
    expect(fallida.reason).toSatisfy?.((err: unknown) => err instanceof ConflictError || err instanceof ValidationError);
  });

  it("el LÍMITE por competencia se respeta bajo concurrencia", async () => {
    // Límite de 1 prueba individual por nadador en toda la competencia.
    const e = await montarEscenario({ maxIndividualEventsPerSwimmer: 1 });

    // Segunda prueba en la misma competencia y jornada.
    const stroke2 = await prisma.stroke.upsert({ where: { name: "Espalda" }, update: {}, create: { name: "Espalda" } });
    const evento2 = await catalogsEvents.createEvent(
      { testTypeId: e.individualTestTypeId, distanceId: e.distanceId, strokeId: stroke2.id, gender: "mixed" },
      SYSTEM_ACTOR
    );
    const ce2 = await competitionEventsService.addCompetitionEvent(
      e.competitionId,
      { eventId: evento2.id, competitionSessionId: e.sessionId, categoryIds: [e.categoryId] },
      SYSTEM_ACTOR
    );

    // Dos pruebas DISTINTAS a la vez: ningún índice único las separa, la
    // regla es agregada y solo la transacción serializable puede protegerla.
    const resultados = await Promise.allSettled([
      registrationsService.createRegistration({ competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId }, ADMIN_ACTOR),
      registrationsService.createRegistration({ competitionEventId: ce2.id, clubId: e.clubId, personId: e.personId }, ADMIN_ACTOR),
    ]);

    const confirmadas = await prisma.registration.count({ where: { status: "confirmed" } });
    expect(confirmadas, "el límite de 1 prueba por nadador no puede superarse por concurrencia").toBe(1);
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("la regla de un solo club activo la garantiza un índice, no solo el servicio", async () => {
    const e = await montarEscenario();
    const otroClub = await createClub("Club Rival", "CLBR");
    const user = await prisma.user.findFirstOrThrow({ where: { clubId: e.clubId } });

    await expect(
      prisma.clubSwimmer.create({
        data: { clubId: otroClub.id, personId: e.personId, status: "active", requestedByUserId: user.id, startDate: new Date() },
      })
    ).rejects.toThrow();
  });
});

describe("hallazgo 10 — estados que admiten operar", () => {
  it("RECHAZA inscribir en una competencia en BORRADOR, incluso con permiso post-cierre", async () => {
    const e = await montarEscenario();
    await prisma.competition.update({ where: { id: e.competitionId }, data: { status: "draft" } });

    await expect(
      registrationsService.createRegistration({ competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId }, ADMIN_ACTOR)
    ).rejects.toThrow(/borrador/i);
  });

  it("RECHAZA cancelar dos veces la misma inscripción", async () => {
    const e = await montarEscenario();
    const reg = await registrationsService.createRegistration(
      { competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId },
      ADMIN_ACTOR
    );
    await registrationsService.cancelRegistration(reg.id, ADMIN_ACTOR);

    await expect(registrationsService.cancelRegistration(reg.id, ADMIN_ACTOR)).rejects.toThrow(/ya está cancelada/i);
  });

  it("tras cancelar, el mismo nadador PUEDE volver a inscribirse (el índice es parcial)", async () => {
    const e = await montarEscenario();
    const reg = await registrationsService.createRegistration(
      { competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId },
      ADMIN_ACTOR
    );
    await registrationsService.cancelRegistration(reg.id, ADMIN_ACTOR);

    const nueva = await registrationsService.createRegistration(
      { competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId },
      ADMIN_ACTOR
    );
    expect(nueva.status).toBe("confirmed");
  });
});

describe("la invariante del rango de inscripción vive en el servicio, no solo en Zod", () => {
  const rangoInvalido = (inicio: Date, fin: Date) => ({
    name: "Competencia con rango imposible",
    registrationStartAt: inicio,
    registrationEndAt: fin,
    ageCutoffDate: new Date(),
    maxIndividualEventsPerSwimmer: 5,
    maxRelayEventsPerSwimmerPerSession: 1,
  });

  it("RECHAZA crear una competencia con fin ANTERIOR al inicio, sin persistir nada", async () => {
    const antes = await prisma.competition.count();

    await expect(
      competitionsService.createCompetition(
        rangoInvalido(new Date("2026-06-10T00:00:00Z"), new Date("2026-06-01T00:00:00Z")),
        SYSTEM_ACTOR
      )
    ).rejects.toThrow(/posterior a la de inicio/i);

    expect(await prisma.competition.count(), "no debe quedar la competencia creada").toBe(antes);
  });

  it("RECHAZA fin IGUAL al inicio (rango de duración cero)", async () => {
    const mismoInstante = new Date("2026-06-01T00:00:00Z");
    await expect(competitionsService.createCompetition(rangoInvalido(mismoInstante, mismoInstante), SYSTEM_ACTOR)).rejects.toThrow(
      /posterior a la de inicio/i
    );
  });

  it("el mensaje indica las dos fechas recibidas", async () => {
    const error = await competitionsService
      .createCompetition(rangoInvalido(new Date("2026-06-10T00:00:00Z"), new Date("2026-06-01T00:00:00Z")), SYSTEM_ACTOR)
      .then(() => null)
      .catch((e) => e as ValidationError);

    expect(error!.message).toContain("2026-06-10");
    expect(error!.message).toContain("2026-06-01");
  });

  it("ACEPTA un rango válido", async () => {
    const creada = await competitionsService.createCompetition(
      rangoInvalido(new Date("2026-06-01T00:00:00Z"), new Date("2026-06-10T00:00:00Z")),
      SYSTEM_ACTOR
    );
    expect(creada.id).toBeTruthy();
  });
});

describe("hallazgo 12 — revalidación de rangos en ediciones parciales", () => {
  it("RECHAZA mover solo la fecha de inicio más allá del fin ya guardado", async () => {
    const e = await montarEscenario();

    await expect(
      competitionsService.updateCompetition(e.competitionId, { registrationStartAt: new Date(Date.now() + 30 * 86_400_000) }, SYSTEM_ACTOR)
    ).rejects.toThrow(/posterior a la de inicio/i);
  });

  it("RECHAZA subir solo la edad mínima por encima de la máxima ya guardada", async () => {
    const e = await montarEscenario();

    await expect(catalogsCategories.updateCategory(e.categoryId, { minAge: 80 }, SYSTEM_ACTOR)).rejects.toThrow(/mayor o igual a la mínima/i);
  });
});

describe("hallazgo 9 (reapertura) — concurrencia de RELEVOS", () => {
  /** Escenario: dos pruebas de relevo distintas que comparten un nadador. */
  async function montarDosRelevos() {
    const e = await montarEscenario();
    const relevoTipo = await prisma.testType.findUniqueOrThrow({ where: { name: "Relevo" } });
    const categoriaRelevo = await catalogsCategories.createCategory(
      { testTypeId: relevoTipo.id, name: "Relevo Libre", minAge: 0, maxAge: 500 },
      SYSTEM_ACTOR
    );

    const nadadores = [e.personId];
    const club = await prisma.club.findUniqueOrThrow({ where: { id: e.clubId } });
    const user = await prisma.user.findFirstOrThrow({ where: { clubId: club.id } });
    for (let i = 2; i <= 4; i++) {
      const p = await createPerson({ run: `9100000${i}`, username: `relevista_${i}`, firstName: `Relevista ${i}`, gender: i % 2 === 0 ? "male" : "female", birthYear: 1990 });
      await addActiveMembership(club.id, p.id, user.id);
      nadadores.push(p.id);
    }

    const crearPruebaRelevo = async (strokeName: string) => {
      const stroke = await prisma.stroke.upsert({ where: { name: strokeName }, update: {}, create: { name: strokeName } });
      const ev = await catalogsEvents.createEvent(
        { testTypeId: relevoTipo.id, distanceId: e.distanceId, strokeId: stroke.id, gender: "mixed" },
        SYSTEM_ACTOR
      );
      return competitionEventsService.addCompetitionEvent(
        e.competitionId,
        { eventId: ev.id, competitionSessionId: e.sessionId, categoryIds: [categoriaRelevo.id] },
        SYSTEM_ACTOR
      );
    };

    return { e, nadadores, relevoA: await crearPruebaRelevo("Libre relevo"), relevoB: await crearPruebaRelevo("Espalda relevo") };
  }

  it("dos equipos SIMULTÁNEOS que comparten un nadador no superan el límite por jornada", async () => {
    const { e, nadadores, relevoA, relevoB } = await montarDosRelevos();
    // La competencia permite 1 relevo por nadador y jornada (valor por defecto).

    const resultados = await Promise.allSettled([
      relayService.createRelayRegistration({ competitionEventId: relevoA.id, clubId: e.clubId, personIds: nadadores }, ADMIN_ACTOR),
      relayService.createRelayRegistration({ competitionEventId: relevoB.id, clubId: e.clubId, personIds: nadadores }, ADMIN_ACTOR),
    ]);

    const confirmados = await prisma.relayRegistration.count({ where: { status: "confirmed" } });
    expect(confirmados, "el mismo nadador no puede quedar en dos relevos de la misma jornada").toBe(1);
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("con el límite configurado en 2, los dos equipos SÍ se aceptan", async () => {
    const { e, nadadores, relevoA, relevoB } = await montarDosRelevos();
    await prisma.competition.update({ where: { id: e.competitionId }, data: { maxRelayEventsPerSwimmerPerSession: 2 } });

    await relayService.createRelayRegistration({ competitionEventId: relevoA.id, clubId: e.clubId, personIds: nadadores }, ADMIN_ACTOR);
    await relayService.createRelayRegistration({ competitionEventId: relevoB.id, clubId: e.clubId, personIds: nadadores }, ADMIN_ACTOR);

    expect(await prisma.relayRegistration.count({ where: { status: "confirmed" } })).toBe(2);
  });
});

describe("hallazgos 5 y 6 (reapertura) — historial completo e integridad de la jornada", () => {
  it("una inscripción CANCELADA también impide mover la prueba de jornada", async () => {
    const e = await montarEscenario();
    const reg = await registrationsService.createRegistration(
      { competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId },
      ADMIN_ACTOR
    );
    await registrationsService.cancelRegistration(reg.id, ADMIN_ACTOR);

    const tipoTarde = await prisma.sessionType.upsert({ where: { name: "Tarde" }, update: {}, create: { name: "Tarde" } });
    const fecha = await prisma.competitionDate.findFirstOrThrow({ where: { competitionId: e.competitionId } });
    const otraJornada = await structureService.addSession(fecha.id, tipoTarde.id, SYSTEM_ACTOR);

    await expect(
      competitionEventsService.updateCompetitionEvent(e.competitionEventId, { competitionSessionId: otraJornada.id }, SYSTEM_ACTOR)
    ).rejects.toThrow(/incluidas las canceladas/i);
  });

  /**
   * Reapertura 2, punto 1: mover una fecha a otra competencia arrastraba sus
   * jornadas, pruebas e inscripciones por la cascada de la clave foránea.
   */
  it("PROHÍBE cambiar la competencia de una fecha, y nada se mueve", async () => {
    const e = await montarEscenario();
    const reg = await registrationsService.createRegistration(
      { competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId },
      ADMIN_ACTOR
    );

    const otra = await competitionsService.createCompetition(
      {
        name: "Competencia destino",
        registrationStartAt: new Date(Date.now() - 86_400_000),
        registrationEndAt: new Date(Date.now() + 86_400_000),
        ageCutoffDate: new Date(),
        maxIndividualEventsPerSwimmer: 5,
        maxRelayEventsPerSwimmerPerSession: 1,
      },
      SYSTEM_ACTOR
    );
    const fecha = await prisma.competitionDate.findFirstOrThrow({ where: { competitionId: e.competitionId } });

    await expect(
      prisma.$executeRawUnsafe(`UPDATE competition_dates SET competition_id = '${otra.id}' WHERE id = '${fecha.id}'`)
    ).rejects.toThrow(/No se puede cambiar la competencia de una fecha/i);

    // Nada se movió: fecha, jornada, prueba e inscripción siguen donde estaban.
    const fechaDespues = await prisma.competitionDate.findUniqueOrThrow({ where: { id: fecha.id } });
    expect(fechaDespues.competitionId).toBe(e.competitionId);

    const jornada = await prisma.competitionSession.findUniqueOrThrow({ where: { id: e.sessionId } });
    expect(jornada.competitionId).toBe(e.competitionId);

    const prueba = await prisma.competitionEvent.findUniqueOrThrow({ where: { id: e.competitionEventId } });
    expect(prueba.competitionId).toBe(e.competitionId);

    const inscripcion = await prisma.registration.findUniqueOrThrow({
      where: { id: reg.id },
      include: { competitionEvent: true },
    });
    expect(inscripcion.competitionEvent.competitionId).toBe(e.competitionId);

    // La competencia destino sigue vacía.
    expect(await prisma.competitionDate.count({ where: { competitionId: otra.id } })).toBe(0);
    expect(await prisma.competitionEvent.count({ where: { competitionId: otra.id } })).toBe(0);
  });

  it("el disparador impide adulterar competition_id con un UPDATE directo", async () => {
    const e = await montarEscenario();
    const otra = await competitionsService.createCompetition(
      {
        name: "Competencia ajena",
        registrationStartAt: new Date(Date.now() - 86_400_000),
        registrationEndAt: new Date(Date.now() + 86_400_000),
        ageCutoffDate: new Date(),
        maxIndividualEventsPerSwimmer: 5,
        maxRelayEventsPerSwimmerPerSession: 1,
      },
      SYSTEM_ACTOR
    );

    await prisma.$executeRawUnsafe(`UPDATE competition_sessions SET competition_id = '${otra.id}' WHERE id = '${e.sessionId}'`);

    const sesion = await prisma.competitionSession.findUniqueOrThrow({
      where: { id: e.sessionId },
      include: { competitionDate: true },
    });
    expect(sesion.competitionId, "el disparador debe recalcular el valor desde la fecha").toBe(sesion.competitionDate.competitionId);
    expect(sesion.competitionId).toBe(e.competitionId);
  });
});

describe("hallazgo 13 (reapertura) — catálogos retirados no admiten operaciones nuevas", () => {
  it("una CATEGORÍA eliminada deja de resolver inscripciones nuevas", async () => {
    const e = await montarEscenario();
    await catalogsCategories.softDeleteCategory(e.categoryId, SYSTEM_ACTOR);

    await expect(
      registrationsService.createRegistration({ competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId }, ADMIN_ACTOR)
    ).rejects.toThrow(/categorías habilitadas .* fueron eliminadas|no hay ninguna categoría/i);
  });

  it("una PRUEBA MAESTRA eliminada deja de admitir inscripciones aunque siga asignada", async () => {
    const e = await montarEscenario();
    const ce = await prisma.competitionEvent.findUniqueOrThrow({ where: { id: e.competitionEventId } });
    await catalogsEvents.softDeleteEvent(ce.eventId, SYSTEM_ACTOR);

    await expect(
      registrationsService.createRegistration({ competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId }, ADMIN_ACTOR)
    ).rejects.toThrow(/eliminada del catálogo/i);
  });

  it("una prueba eliminada tampoco puede asignarse a una competencia nueva", async () => {
    const e = await montarEscenario();
    const ce = await prisma.competitionEvent.findUniqueOrThrow({ where: { id: e.competitionEventId } });
    await catalogsEvents.softDeleteEvent(ce.eventId, SYSTEM_ACTOR);

    const tipoTarde = await prisma.sessionType.upsert({ where: { name: "Tarde" }, update: {}, create: { name: "Tarde" } });
    const fecha = await prisma.competitionDate.findFirstOrThrow({ where: { competitionId: e.competitionId } });
    const otraJornada = await structureService.addSession(fecha.id, tipoTarde.id, SYSTEM_ACTOR);

    await expect(
      competitionEventsService.addCompetitionEvent(
        e.competitionId,
        { eventId: ce.eventId, competitionSessionId: otraJornada.id, categoryIds: [e.categoryId] },
        SYSTEM_ACTOR
      )
    ).rejects.toThrow();
  });

  it("el HISTORIAL con catálogos retirados se conserva y se sigue leyendo", async () => {
    const e = await montarEscenario();
    const reg = await registrationsService.createRegistration(
      { competitionEventId: e.competitionEventId, clubId: e.clubId, personId: e.personId },
      ADMIN_ACTOR
    );
    await catalogsCategories.softDeleteCategory(e.categoryId, SYSTEM_ACTOR);

    const listado = await registrationsService.listRegistrations({ competitionId: e.competitionId, page: 1, pageSize: 20 }, ADMIN_ACTOR);
    expect(listado.items.map((i) => i.id)).toContain(reg.id);
    expect(listado.items[0]!.category.name).toBe("Master Test");
  });

  it("permite recrear un GRUPO de categorías con el mismo nombre tras eliminarlo", async () => {
    const grupo = await categoryGroupsService.createCategoryGroup("Master FINA", SYSTEM_ACTOR);
    await categoryGroupsService.deleteCategoryGroup(grupo.id, SYSTEM_ACTOR);

    const recreado = await categoryGroupsService.createCategoryGroup("Master FINA", SYSTEM_ACTOR);
    expect(recreado.name).toBe("Master FINA");
  });

  it("dos grupos con el MISMO nombre creados a la vez: queda uno solo y el otro recibe un error de dominio, nunca un 500", async () => {
    const resultados = await Promise.allSettled([
      categoryGroupsService.createCategoryGroup("Grupo Concurrente", SYSTEM_ACTOR),
      categoryGroupsService.createCategoryGroup("Grupo Concurrente", SYSTEM_ACTOR),
    ]);

    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.categoryGroup.count({ where: { name: "Grupo Concurrente", deletedAt: null } })).toBe(1);

    const rechazada = resultados.find((r) => r.status === "rejected") as PromiseRejectedResult;
    /**
     * Cuál de las dos defensas atrapa el segundo intento depende del
     * entrelazado real: si la comprobación previa alcanza a ver la fila recién
     * insertada, responde 400; si no, lo ataja el índice parcial y su P2002 se
     * traduce a 409. Lo que NO puede pasar —y es lo que se afirma aquí— es que
     * queden dos grupos, o que el usuario reciba un error interno.
     *
     * La traducción P2002 → 409 se verifica de forma determinista en
     * `tests/prismaErrors.test.ts`, sin depender del entrelazado.
     */
    const error = rechazada.reason as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect([400, 409], "debe ser un error de dominio, nunca un 500").toContain(error.statusCode);
    expect(error.message).toMatch(/ya existe un grupo/i);
  });

  it("renombrar dos grupos al mismo nombre a la vez: ninguno lo consigue y el nombre queda con un solo dueño", async () => {
    await categoryGroupsService.createCategoryGroup("Grupo A", SYSTEM_ACTOR);
    const b = await categoryGroupsService.createCategoryGroup("Grupo B", SYSTEM_ACTOR);
    const c = await categoryGroupsService.createCategoryGroup("Grupo C", SYSTEM_ACTOR);

    // Ambos intentan renombrarse a "Grupo A" a la vez.
    const resultados = await Promise.allSettled([
      categoryGroupsService.updateCategoryGroup(b.id, "Grupo A", SYSTEM_ACTOR),
      categoryGroupsService.updateCategoryGroup(c.id, "Grupo A", SYSTEM_ACTOR),
    ]);

    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(0);
    expect(await prisma.categoryGroup.count({ where: { name: "Grupo A", deletedAt: null } })).toBe(1);
  });
});

describe("listEligibleSwimmers rechaza catálogos y pruebas no utilizables", () => {
  it("RECHAZA una prueba de competencia DESHABILITADA", async () => {
    const e = await montarEscenario();
    await prisma.competitionEvent.update({ where: { id: e.competitionEventId }, data: { status: "disabled" } });

    await expect(
      registrationsService.listEligibleSwimmers({ clubId: e.clubId, competitionEventId: e.competitionEventId, categoryId: e.categoryId }, ADMIN_ACTOR)
    ).rejects.toThrow(/deshabilitada/i);
  });

  it("RECHAZA una CATEGORÍA retirada del catálogo", async () => {
    const e = await montarEscenario();
    await catalogsCategories.softDeleteCategory(e.categoryId, SYSTEM_ACTOR);

    await expect(
      registrationsService.listEligibleSwimmers({ clubId: e.clubId, competitionEventId: e.competitionEventId, categoryId: e.categoryId }, ADMIN_ACTOR)
    ).rejects.toThrow(/eliminad/i);
  });

  it("RECHAZA una PRUEBA MAESTRA retirada del catálogo", async () => {
    const e = await montarEscenario();
    const ce = await prisma.competitionEvent.findUniqueOrThrow({ where: { id: e.competitionEventId } });
    await catalogsEvents.softDeleteEvent(ce.eventId, SYSTEM_ACTOR);

    await expect(
      registrationsService.listEligibleSwimmers({ clubId: e.clubId, competitionEventId: e.competitionEventId, categoryId: e.categoryId }, ADMIN_ACTOR)
    ).rejects.toThrow(/eliminada del catálogo/i);
  });

  it("EXCLUYE a las personas eliminadas lógicamente", async () => {
    const e = await montarEscenario();

    const antes = await registrationsService.listEligibleSwimmers(
      { clubId: e.clubId, competitionEventId: e.competitionEventId, categoryId: e.categoryId },
      ADMIN_ACTOR
    );
    expect(antes.map((s) => s.id)).toContain(e.personId);

    await prisma.person.update({ where: { id: e.personId }, data: { deletedAt: new Date() } });

    const despues = await registrationsService.listEligibleSwimmers(
      { clubId: e.clubId, competitionEventId: e.competitionEventId, categoryId: e.categoryId },
      ADMIN_ACTOR
    );
    expect(despues.map((s) => s.id)).not.toContain(e.personId);
  });
});

describe("hallazgo 13 — claves naturales de registros eliminados", () => {
  it("permite recrear una categoría con el mismo nombre tras eliminarla", async () => {
    const e = await montarEscenario();
    await catalogsCategories.softDeleteCategory(e.categoryId, SYSTEM_ACTOR);

    const recreada = await catalogsCategories.createCategory(
      { testTypeId: e.individualTestTypeId, name: "Master Test", minAge: 20, maxAge: 60 },
      SYSTEM_ACTOR
    );
    expect(recreada.name).toBe("Master Test");
  });

  it("sigue impidiendo dos categorías VIGENTES con el mismo nombre", async () => {
    const e = await montarEscenario();
    await expect(
      catalogsCategories.createCategory({ testTypeId: e.individualTestTypeId, name: "Master Test", minAge: 20, maxAge: 60 }, SYSTEM_ACTOR)
    ).rejects.toThrow();
  });
});
