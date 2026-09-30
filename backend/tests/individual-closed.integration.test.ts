/**
 * «Inscripciones individuales cerradas» — camino REAL contra PostgreSQL.
 *
 * Las reglas puras están en `individual-closed.rules.test.ts` y
 * `relay-membership.rules.test.ts`. Aquí se comprueba lo que solo se ve con la
 * base delante:
 *
 *   - que alcanzar el cupo deje la competencia en cierre PARCIAL y que los
 *     relevos sigan funcionando;
 *   - que un club no pueda tocar individuales ni siquiera de nadadores que ya
 *     ocupaban cupo, llamando al servicio directamente y no a la interfaz;
 *   - que la invariante de relevos se cumpla también para el administrador;
 *   - que las DOS carreras entre crear un relevo y cancelar la última
 *     individual terminen siempre en un estado admisible.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addActiveMembership } from "./helpers/seedRbac";
import * as competitionsService from "../src/modules/competitions/competitions.service";
import * as structureService from "../src/modules/competitions/competition-structure.service";
import * as competitionEventsService from "../src/modules/competitions/competition-events.service";
import * as registrationsService from "../src/modules/registrations/registrations.service";
import * as relayService from "../src/modules/relay-registrations/relay-registrations.service";
import * as catalogsCategories from "../src/modules/catalogs/categories.service";
import * as catalogsEvents from "../src/modules/catalogs/events.service";

type Actor = { userId: string; ipAddress?: string };
type ActorAdmin = Actor & { isAdmin: true; scope: { kind: "admin" }; canRegisterPostClose: boolean };
type ActorClub = Actor & { isAdmin: false; scope: { kind: "club"; clubId: string }; canRegisterPostClose: boolean };

let SIMPLE: Actor;
let ADMIN: ActorAdmin;

const AYER = new Date(Date.now() - 86_400_000);
const MANANA = new Date(Date.now() + 86_400_000);

async function seedCatalogos() {
  await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
  await prisma.testType.upsert({ where: { name: "Relevo" }, update: {}, create: { name: "Relevo", swimmersCount: 4 } });
  for (const meters of [50, 200]) await prisma.distance.upsert({ where: { meters }, update: {}, create: { meters } });
  for (const name of ["Libre", "Espalda"]) await prisma.stroke.upsert({ where: { name }, update: {}, create: { name } });
  await prisma.sessionType.upsert({ where: { name: "Mañana" }, update: {}, create: { name: "Mañana" } });
}

async function pruebaDelCatalogo(testTypeId: string, distanceId: string, strokeId: string) {
  const ya = await prisma.event.findFirst({ where: { testTypeId, distanceId, strokeId, gender: "female", deletedAt: null } });
  if (ya) return ya;
  return catalogsEvents.createEvent({ testTypeId, distanceId, strokeId, gender: "female" }, SIMPLE);
}

/** Competencia ABIERTA con dos pruebas individuales y una de relevo. */
async function montarCompetencia(cupos: { maxSwimmers?: number | null; maxSwimmersPerClub?: number | null } = {}) {
  const competition = await competitionsService.createCompetition(
    {
      name: `Copa Parcial ${Math.random().toString(36).slice(2, 8)}`,
      registrationStartAt: AYER,
      registrationEndAt: MANANA,
      ageCutoffDate: new Date("2026-12-31"),
      maxIndividualEventsPerSwimmer: 10,
      maxRelayEventsPerSwimmerPerSession: 5,
      maxSwimmers: cupos.maxSwimmers ?? null,
      maxSwimmersPerClub: cupos.maxSwimmersPerClub ?? null,
    },
    SIMPLE
  );
  await competitionsService.transitionCompetition(competition.id, "schedule", { ...SIMPLE, isAdmin: true });

  const fecha = await structureService.addCompetitionDate(competition.id, new Date(), SIMPLE);
  const sessionType = await prisma.sessionType.findFirstOrThrow({ where: { name: "Mañana" } });
  const session = await structureService.addSession(fecha.id, sessionType.id, SIMPLE);

  const individual = await prisma.testType.findFirstOrThrow({ where: { swimmersCount: 1 } });
  const relevo = await prisma.testType.findFirstOrThrow({ where: { swimmersCount: 4 } });

  const sufijo = Math.random().toString(36).slice(2, 6);
  const categoria = await catalogsCategories.createCategory(
    { testTypeId: individual.id, name: `Master ${sufijo}`, minAge: 18, maxAge: 99 },
    SIMPLE
  );
  const categoriaRelevo = await catalogsCategories.createCategory(
    { testTypeId: relevo.id, name: `Relevo ${sufijo}`, minAge: 0, maxAge: 500 },
    SIMPLE
  );

  const d50 = await prisma.distance.findFirstOrThrow({ where: { meters: 50 } });
  const d200 = await prisma.distance.findFirstOrThrow({ where: { meters: 200 } });
  const libre = await prisma.stroke.findFirstOrThrow({ where: { name: "Libre" } });
  const espalda = await prisma.stroke.findFirstOrThrow({ where: { name: "Espalda" } });

  const ceIndividual = await competitionEventsService.addCompetitionEvent(
    competition.id,
    { eventId: (await pruebaDelCatalogo(individual.id, d50.id, libre.id)).id, competitionSessionId: session.id, categoryIds: [categoria.id], displayOrder: 1 },
    SIMPLE
  );
  const ceIndividual2 = await competitionEventsService.addCompetitionEvent(
    competition.id,
    { eventId: (await pruebaDelCatalogo(individual.id, d50.id, espalda.id)).id, competitionSessionId: session.id, categoryIds: [categoria.id], displayOrder: 2 },
    SIMPLE
  );
  const ceRelevo = await competitionEventsService.addCompetitionEvent(
    competition.id,
    { eventId: (await pruebaDelCatalogo(relevo.id, d200.id, libre.id)).id, competitionSessionId: session.id, categoryIds: [categoriaRelevo.id], displayOrder: 3 },
    SIMPLE
  );

  return { competition, ceIndividual, ceIndividual2, ceRelevo };
}

let contadorRun = 20_000_000;
async function crearNadadora(clubId: string, nombre: string) {
  contadorRun++;
  const persona = await createPerson({
    run: `${contadorRun}-1`,
    username: `nad_${contadorRun}`,
    firstName: nombre,
    gender: "female",
    birthYear: 1985,
    roles: ["swimmer"],
  });
  await addActiveMembership(clubId, persona.id, SIMPLE.userId);
  return persona;
}

const estado = async (id: string) => (await prisma.competition.findUniqueOrThrow({ where: { id } })).status;

function actorDeClub(clubId: string): ActorClub {
  return { userId: SIMPLE.userId, isAdmin: false, scope: { kind: "club", clubId }, canRegisterPostClose: false };
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  await seedCatalogos();
  const admin = await createUser({ username: "admin_parcial", roleNames: ["admin"] });
  SIMPLE = { userId: admin.id };
  ADMIN = { userId: admin.id, isAdmin: true, scope: { kind: "admin" }, canRegisterPostClose: true };
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe("alcanzar el cupo deja la competencia en cierre PARCIAL", () => {
  it("el estado guardado es 'individual_closed', con causa 'capacity'", async () => {
    const club = await createClub("Club Cupo", "CUP");
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 2 });
    const a = await crearNadadora(club.id, "Ana");
    const b = await crearNadadora(club.id, "Bea");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: a.id, clubId: club.id }, ADMIN);
    // El estado GUARDADO sigue siendo el de la transición explícita: el
    // auto-estado se calcula al leer y solo se persiste en esa lectura. Por
    // eso aquí se comprueba el efectivo, que es el que ve la aplicación.
    expect((await competitionsService.getCompetitionById(competition.id)).status).toBe("open");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: b.id, clubId: club.id }, ADMIN);

    const fila = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
    expect(fila.status).toBe("individual_closed");
    expect(fila.registrationsClosedReason).toBe("capacity");
    expect(fila.registrationsClosedAt).not.toBeNull();
  });

  it("un CLUB no puede añadir otra prueba a un nadador que YA ocupaba cupo", async () => {
    /**
     * Es el caso que más fácil se cuela: el nadador ya está dentro, así que no
     * consume cupo nuevo y la regla de cupos lo dejaría pasar. Lo que lo frena
     * es el estado, y esta prueba llama al servicio directamente — la interfaz
     * no es una barrera de seguridad.
     */
    const club = await createClub("Club Cupo", "CUP");
    const { ceIndividual, ceIndividual2 } = await montarCompetencia({ maxSwimmers: 1 });
    const a = await crearNadadora(club.id, "Ana");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: a.id, clubId: club.id }, ADMIN);

    await expect(
      registrationsService.createRegistration({ competitionEventId: ceIndividual2.id, personId: a.id, clubId: club.id }, actorDeClub(club.id))
    ).rejects.toThrow(/cupo de nadadores/i);
  });

  it("un CLUB tampoco puede cancelar una inscripción individual", async () => {
    const club = await createClub("Club Cupo", "CUP");
    const { ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const a = await crearNadadora(club.id, "Ana");
    const insc = await registrationsService.createRegistration(
      { competitionEventId: ceIndividual.id, personId: a.id, clubId: club.id },
      ADMIN
    );

    await expect(registrationsService.cancelRegistration(insc.id, actorDeClub(club.id))).rejects.toThrow(/cupo de nadadores/i);
  });

  it("un ADMINISTRADOR sí puede, y su alta por encima del cupo queda auditada aparte", async () => {
    const club = await createClub("Club Cupo", "CUP");
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const a = await crearNadadora(club.id, "Ana");
    const b = await crearNadadora(club.id, "Bea");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: a.id, clubId: club.id }, ADMIN);
    expect(await estado(competition.id)).toBe("individual_closed");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: b.id, clubId: club.id }, ADMIN);

    // El conteo real se muestra aunque exceda el máximo, y el máximo se conserva.
    const fila = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
    expect(fila.maxSwimmers).toBe(1);
    const inscritos = await prisma.registration.count({ where: { status: "confirmed", competitionEvent: { competitionId: competition.id } } });
    expect(inscritos).toBe(2);

    // Rastro específico del exceso, distinto de la excepción por cierre.
    const exceso = await prisma.auditLog.findFirst({ where: { action: "REGISTRATION_CREATED_OVER_CAPACITY_BY_ADMIN" } });
    expect(exceso).not.toBeNull();
    const datos = exceso!.after as Record<string, unknown>;
    expect(datos.maxSwimmers).toBe(1);
    expect(datos.totalSwimmersDespues).toBe(2);
    expect(datos.excedente).toBe(1);

    // Y la operación administrativa NO reabrió nada para los demás.
    expect(await estado(competition.id)).toBe("individual_closed");
  });

  it("una operación administrativa no vuelve a 'cerrar' lo ya cerrado", async () => {
    const club = await createClub("Club Cupo", "CUP");
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const a = await crearNadadora(club.id, "Ana");
    const b = await crearNadadora(club.id, "Bea");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: a.id, clubId: club.id }, ADMIN);
    const marca = (await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } })).registrationsClosedAt;

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: b.id, clubId: club.id }, ADMIN);

    const despues = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
    expect(despues.registrationsClosedAt?.getTime()).toBe(marca?.getTime());
    const cierres = await prisma.auditLog.count({ where: { action: "COMPETITION_REGISTRATIONS_AUTO_CLOSED_BY_CAPACITY" } });
    expect(cierres, "un solo cierre, no uno por cada alta administrativa").toBe(1);
  });
});

describe("con el cupo lleno, los relevos siguen funcionando", () => {
  async function competenciaLlenaConCuatroInscritas() {
    const club = await createClub("Club Relevo", "REL");
    const { competition, ceIndividual, ceRelevo } = await montarCompetencia({ maxSwimmers: 4 });
    const nadadoras = [];
    for (const nombre of ["Ana", "Bea", "Cata", "Dana"]) {
      const p = await crearNadadora(club.id, nombre);
      await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: p.id, clubId: club.id }, ADMIN);
      nadadoras.push(p);
    }
    expect(await estado(competition.id)).toBe("individual_closed");
    return { club, competition, ceIndividual, ceRelevo, nadadoras };
  }

  it("un CLUB puede crear un relevo con las cuatro ya inscritas", async () => {
    const { club, ceRelevo, nadadoras } = await competenciaLlenaConCuatroInscritas();

    const equipo = await relayService.createRelayRegistration(
      { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
      actorDeClub(club.id)
    );

    expect(equipo.id).toBeTruthy();
    // Y NO queda marcado como excepción: es operación normal de este estado.
    const fila = await prisma.relayRegistration.findUniqueOrThrow({ where: { id: equipo.id } });
    expect(fila.isPostCloseException).toBe(false);
    const auditoria = await prisma.auditLog.findFirst({ where: { action: "RELAY_REGISTRATION_CREATED", entityId: equipo.id } });
    expect(auditoria, "se audita como alta normal, no como excepción").not.toBeNull();
  });

  it("un club puede cancelar su relevo con el cupo lleno", async () => {
    const { club, ceRelevo, nadadoras } = await competenciaLlenaConCuatroInscritas();
    const equipo = await relayService.createRelayRegistration(
      { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
      actorDeClub(club.id)
    );

    await relayService.cancelRelayRegistration(equipo.id, actorDeClub(club.id));
    expect((await prisma.relayRegistration.findUniqueOrThrow({ where: { id: equipo.id } })).status).toBe("cancelled");
  });

  it("en cierre TOTAL el club ya no puede crear relevos", async () => {
    const { club, competition, ceRelevo, nadadoras } = await competenciaLlenaConCuatroInscritas();
    await competitionsService.transitionCompetition(competition.id, "closeRegistrations", { ...SIMPLE, isAdmin: true });
    expect(await estado(competition.id)).toBe("closed");

    await expect(
      relayService.createRelayRegistration(
        { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
        actorDeClub(club.id)
      )
    ).rejects.toThrow(/cerradas/i);
  });
});

describe("invariante: los integrantes necesitan inscripción individual", () => {
  async function escenario() {
    const club = await createClub("Club Inv", "INV");
    const { ceIndividual, ceRelevo } = await montarCompetencia({ maxSwimmers: null });
    const nadadoras = [];
    for (const nombre of ["Ana", "Bea", "Cata", "Dana"]) nadadoras.push(await crearNadadora(club.id, nombre));
    return { club, ceIndividual, ceRelevo, nadadoras };
  }

  async function inscribirIndividual(ceId: string, clubId: string, personId: string) {
    return registrationsService.createRegistration({ competitionEventId: ceId, personId, clubId }, ADMIN);
  }

  it("RECHAZA el relevo si una integrante no está inscrita individualmente", async () => {
    const { club, ceIndividual, ceRelevo, nadadoras } = await escenario();
    for (const n of nadadoras.slice(0, 3)) await inscribirIndividual(ceIndividual.id, club.id, n.id);

    await expect(
      relayService.createRelayRegistration(
        { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
        actorDeClub(club.id)
      )
    ).rejects.toThrow(/inscripción individual confirmada/i);
  });

  it("lo rechaza TAMBIÉN para un administrador: su excepción no cubre esto", async () => {
    const { club, ceIndividual, ceRelevo, nadadoras } = await escenario();
    for (const n of nadadoras.slice(0, 3)) await inscribirIndividual(ceIndividual.id, club.id, n.id);

    await expect(
      relayService.createRelayRegistration(
        { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
        ADMIN
      )
    ).rejects.toThrow(/inscripción individual confirmada/i);
  });

  it("una individual CANCELADA no habilita: tiene que estar confirmada", async () => {
    const { club, ceIndividual, ceRelevo, nadadoras } = await escenario();
    for (const n of nadadoras) await inscribirIndividual(ceIndividual.id, club.id, n.id);
    const deLaCuarta = await prisma.registration.findFirstOrThrow({ where: { personId: nadadoras[3]!.id } });
    await registrationsService.cancelRegistration(deLaCuarta.id, ADMIN);

    await expect(
      relayService.createRelayRegistration(
        { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
        ADMIN
      )
    ).rejects.toThrow(/inscripción individual confirmada/i);
  });

  it("ACEPTA el relevo cuando las cuatro están inscritas", async () => {
    const { club, ceIndividual, ceRelevo, nadadoras } = await escenario();
    for (const n of nadadoras) await inscribirIndividual(ceIndividual.id, club.id, n.id);

    const equipo = await relayService.createRelayRegistration(
      { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
      actorDeClub(club.id)
    );
    expect(equipo.id).toBeTruthy();
  });

  it("al CAMBIAR integrantes también se comprueba", async () => {
    const { club, ceIndividual, ceRelevo, nadadoras } = await escenario();
    for (const n of nadadoras) await inscribirIndividual(ceIndividual.id, club.id, n.id);
    const equipo = await relayService.createRelayRegistration(
      { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
      actorDeClub(club.id)
    );

    const sinInscripcion = await crearNadadora(club.id, "Elsa");
    await expect(
      relayService.updateRelayRegistration(
        equipo.id,
        { personIds: [nadadoras[0]!.id, nadadoras[1]!.id, nadadoras[2]!.id, sinInscripcion.id] },
        actorDeClub(club.id)
      )
    ).rejects.toThrow(/inscripción individual confirmada/i);
  });

  it("IMPIDE cancelar la última individual de quien integra un relevo", async () => {
    const { club, ceIndividual, ceRelevo, nadadoras } = await escenario();
    for (const n of nadadoras) await inscribirIndividual(ceIndividual.id, club.id, n.id);
    await relayService.createRelayRegistration(
      { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
      actorDeClub(club.id)
    );

    const suUnica = await prisma.registration.findFirstOrThrow({ where: { personId: nadadoras[0]!.id, status: "confirmed" } });
    await expect(registrationsService.cancelRegistration(suUnica.id, ADMIN)).rejects.toThrow(/última inscripción individual/i);

    // Y el relevo sigue intacto: el sistema no lo modifica por su cuenta.
    const relevos = await prisma.relayRegistration.count({ where: { status: "confirmed" } });
    expect(relevos).toBe(1);
    expect((await prisma.registration.findUniqueOrThrow({ where: { id: suUnica.id } })).status).toBe("confirmed");
  });

  it("PERMITE cancelar una de dos, porque le queda otra", async () => {
    const { club, ceIndividual, ceRelevo, nadadoras } = await escenario();
    for (const n of nadadoras) await inscribirIndividual(ceIndividual.id, club.id, n.id);
    // La primera se inscribe en una segunda prueba.
    const { ceIndividual2 } = await montarCompetencia();
    void ceIndividual2;
    const segunda = await prisma.competitionEvent.findFirstOrThrow({
      where: { competitionId: (await prisma.competitionEvent.findUniqueOrThrow({ where: { id: ceIndividual.id } })).competitionId, displayOrder: 2 },
    });
    await inscribirIndividual(segunda.id, club.id, nadadoras[0]!.id);

    await relayService.createRelayRegistration(
      { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
      actorDeClub(club.id)
    );

    const una = await prisma.registration.findFirstOrThrow({ where: { personId: nadadoras[0]!.id, competitionEventId: ceIndividual.id } });
    await registrationsService.cancelRegistration(una.id, ADMIN);
    expect((await prisma.registration.findUniqueOrThrow({ where: { id: una.id } })).status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// LAS DOS CARRERAS
// ---------------------------------------------------------------------------

/**
 * El resultado prohibido es el mismo en ambas: un relevo CONFIRMADO con un
 * integrante SIN inscripción individual confirmada. Da igual cuál de las dos
 * operaciones gane —las dos salidas son admisibles—; lo que no puede pasar es
 * que ganen las dos.
 */
async function integrantesSinIndividual(competitionId: string): Promise<number> {
  const relevos = await prisma.relayRegistration.findMany({
    where: { status: "confirmed", competitionEvent: { competitionId } },
    include: { members: true },
  });
  let malos = 0;
  for (const rr of relevos) {
    for (const m of rr.members) {
      const tiene = await prisma.registration.count({
        where: { personId: m.personId, status: "confirmed", competitionEvent: { competitionId } },
      });
      if (tiene === 0) malos++;
    }
  }
  return malos;
}

describe("concurrencia entre crear un relevo y cancelar la última individual", () => {
  async function escenarioDeCarrera() {
    // Código único por escenario: la prueba que repite la carrera monta varios
    // clubes dentro del MISMO caso, y el nombre de usuario de un club es único.
    const sufijoClub = Math.random().toString(36).slice(2, 7).toUpperCase();
    const club = await createClub(`Club Carrera ${sufijoClub}`, sufijoClub);
    const { competition, ceIndividual, ceRelevo } = await montarCompetencia({ maxSwimmers: null });
    const nadadoras = [];
    for (const nombre of ["Ana", "Bea", "Cata", "Dana"]) {
      const p = await crearNadadora(club.id, nombre);
      await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: p.id, clubId: club.id }, ADMIN);
      nadadoras.push(p);
    }
    const laDeAna = await prisma.registration.findFirstOrThrow({ where: { personId: nadadoras[0]!.id, status: "confirmed" } });
    return { club, competition, ceRelevo, nadadoras, laDeAna };
  }

  it("carrera A: se crea el relevo mientras se cancela la última individual", async () => {
    const { club, competition, ceRelevo, nadadoras, laDeAna } = await escenarioDeCarrera();

    const resultados = await Promise.allSettled([
      relayService.createRelayRegistration(
        { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
        actorDeClub(club.id)
      ),
      registrationsService.cancelRegistration(laDeAna.id, ADMIN),
    ]);

    // Al menos una tiene que fallar, o quedaría el estado prohibido.
    const fallidas = resultados.filter((r) => r.status === "rejected");
    expect(fallidas.length, `resultados: ${resultados.map((r) => r.status).join(", ")}`).toBeGreaterThanOrEqual(1);
    expect(await integrantesSinIndividual(competition.id)).toBe(0);
  });

  it("carrera B: se cancela la última individual mientras se crea el relevo (orden inverso)", async () => {
    const { club, competition, ceRelevo, nadadoras, laDeAna } = await escenarioDeCarrera();

    const resultados = await Promise.allSettled([
      registrationsService.cancelRegistration(laDeAna.id, ADMIN),
      relayService.createRelayRegistration(
        { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
        actorDeClub(club.id)
      ),
    ]);

    const fallidas = resultados.filter((r) => r.status === "rejected");
    expect(fallidas.length, `resultados: ${resultados.map((r) => r.status).join(", ")}`).toBeGreaterThanOrEqual(1);
    expect(await integrantesSinIndividual(competition.id)).toBe(0);
  });

  it("repetida varias veces, NUNCA deja un integrante sin inscripción individual", async () => {
    // Una carrera que sale bien una vez puede salir mal a la siguiente: lo que
    // importa es que el estado prohibido no aparezca en ninguna repetición.
    for (let i = 0; i < 5; i++) {
      const { club, competition, ceRelevo, nadadoras, laDeAna } = await escenarioDeCarrera();
      await Promise.allSettled([
        relayService.createRelayRegistration(
          { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadoras.map((n) => n.id) },
          actorDeClub(club.id)
        ),
        registrationsService.cancelRegistration(laDeAna.id, ADMIN),
      ]);
      expect(await integrantesSinIndividual(competition.id), `repetición ${i + 1}`).toBe(0);
    }
  });
});

describe("reapertura desde el cierre parcial", () => {
  it("con el cupo lleno, reabrir una 'closed' aterriza en cierre parcial y conserva la causa", async () => {
    const club = await createClub("Club Reab", "REA");
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const a = await crearNadadora(club.id, "Ana");
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: a.id, clubId: club.id }, ADMIN);
    await competitionsService.transitionCompetition(competition.id, "closeRegistrations", { ...SIMPLE, isAdmin: true });
    expect(await estado(competition.id)).toBe("closed");

    await competitionsService.reopenRegistrations(competition.id, SIMPLE);

    const fila = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
    expect(fila.status).toBe("individual_closed");
    // La restricción de la base exige causa para este estado, y tiene sentido:
    // explica por qué las individuales siguen cerradas.
    expect(fila.registrationsClosedReason).toBe("capacity");
    expect(fila.registrationsClosedAt).not.toBeNull();
  });

  it("ampliar el cupo NO reabre solo: hace falta la acción explícita", async () => {
    const club = await createClub("Club Reab", "REA");
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const a = await crearNadadora(club.id, "Ana");
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: a.id, clubId: club.id }, ADMIN);
    expect(await estado(competition.id)).toBe("individual_closed");

    await competitionsService.updateCompetition(competition.id, { maxSwimmers: 50 }, { ...SIMPLE, isAdmin: true });
    expect(await estado(competition.id), "editar el cupo no reabre").toBe("individual_closed");

    await competitionsService.reopenRegistrations(competition.id, SIMPLE);
    const fila = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
    expect(fila.status).toBe("open");
    expect(fila.registrationsClosedReason).toBeNull();
  });

  it("cancelar una inscripción tampoco reabre sola", async () => {
    const club = await createClub("Club Reab", "REA");
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const a = await crearNadadora(club.id, "Ana");
    const insc = await registrationsService.createRegistration(
      { competitionEventId: ceIndividual.id, personId: a.id, clubId: club.id },
      ADMIN
    );
    expect(await estado(competition.id)).toBe("individual_closed");

    await registrationsService.cancelRegistration(insc.id, ADMIN);
    expect(await estado(competition.id)).toBe("individual_closed");
  });
});
