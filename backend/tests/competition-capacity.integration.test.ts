/**
 * Cupos de nadadores — camino REAL contra PostgreSQL.
 *
 * Las reglas puras ya están cubiertas en `competition-capacity.rules.test.ts`.
 * Lo que aquí se comprueba es lo que solo se ve con la base delante:
 *
 *   - que el conteo sea de NADADORES DISTINTOS y sume las dos vías de
 *     inscripción (individual y relevo);
 *   - que el alta por lotes que es un relevo respete el cupo como un todo;
 *   - que alcanzar el cupo global CIERRE la competencia, de forma atómica;
 *   - que dos solicitudes simultáneas no puedan superar el último cupo;
 *   - que reducir un cupo por debajo de lo inscrito NO borre inscripciones.
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
type FullActor = Actor & { isAdmin: true; scope: { kind: "admin" }; canRegisterPostClose: boolean };

let ADMIN: FullActor;
let SIMPLE: Actor;

const AYER = new Date(Date.now() - 86_400_000);
const MANANA = new Date(Date.now() + 86_400_000);

async function seedCatalogos() {
  await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
  await prisma.testType.upsert({ where: { name: "Relevo" }, update: {}, create: { name: "Relevo", swimmersCount: 4 } });
  for (const meters of [50, 200]) await prisma.distance.upsert({ where: { meters }, update: {}, create: { meters } });
  for (const name of ["Libre", "Espalda"]) await prisma.stroke.upsert({ where: { name }, update: {}, create: { name } });
  await prisma.sessionType.upsert({ where: { name: "Mañana" }, update: {}, create: { name: "Mañana" } });
}

/**
 * Monta una competencia ABIERTA con una prueba individual y una de relevo,
 * ambas con una categoría que admite a cualquier adulto.
 */
async function montarCompetencia(cupos: { maxSwimmers?: number | null; maxSwimmersPerClub?: number | null } = {}) {
  const competition = await competitionsService.createCompetition(
    {
      name: `Copa Cupos ${Math.random().toString(36).slice(2, 8)}`,
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

  // Las categorías son POR TIPO DE PRUEBA: una para individuales (por edad
  // de la nadadora) y otra para relevos (por edad combinada del equipo).
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

  /**
   * Las pruebas del catálogo son ÚNICAS por tipo+distancia+estilo+género, así
   * que montar dos competencias en la misma prueba no puede volver a crearlas:
   * se reutiliza la que ya exista, que es justo lo que hace la aplicación.
   */
  async function pruebaDelCatalogo(testTypeId: string, distanceId: string, strokeId: string) {
    const ya = await prisma.event.findFirst({ where: { testTypeId, distanceId, strokeId, gender: "female", deletedAt: null } });
    if (ya) return ya;
    return catalogsEvents.createEvent({ testTypeId, distanceId, strokeId, gender: "female" }, SIMPLE);
  }

  const eventoIndividual = await pruebaDelCatalogo(individual.id, d50.id, libre.id);
  const eventoRelevo = await pruebaDelCatalogo(relevo.id, d200.id, libre.id);

  const ceIndividual = await competitionEventsService.addCompetitionEvent(
    competition.id,
    { eventId: eventoIndividual.id, competitionSessionId: session.id, categoryIds: [categoria.id], displayOrder: 1 },
    SIMPLE
  );
  const ceRelevo = await competitionEventsService.addCompetitionEvent(
    competition.id,
    { eventId: eventoRelevo.id, competitionSessionId: session.id, categoryIds: [categoriaRelevo.id], displayOrder: 2 },
    SIMPLE
  );

  // Una segunda prueba individual, para comprobar que un nadador ya inscrito
  // puede añadir otra aunque la competencia esté llena.
  const espalda = await prisma.stroke.findFirstOrThrow({ where: { name: "Espalda" } });
  const eventoIndividual2 = await pruebaDelCatalogo(individual.id, d50.id, espalda.id);
  const ceIndividual2 = await competitionEventsService.addCompetitionEvent(
    competition.id,
    { eventId: eventoIndividual2.id, competitionSessionId: session.id, categoryIds: [categoria.id], displayOrder: 3 },
    SIMPLE
  );

  return { competition, ceIndividual, ceIndividual2, ceRelevo };
}

/**
 * Estado EFECTIVO, que es el que ve la aplicación.
 *
 * El estado guardado puede seguir siendo 'scheduled' mientras las fechas ya
 * la sitúan abierta: `computeEffectiveStatus` se aplica al leer, no se
 * persiste. El cierre por cupo, en cambio, SÍ se persiste — por eso estas
 * pruebas distinguen los dos.
 */
async function estadoEfectivo(id: string): Promise<string> {
  return (await competitionsService.getCompetitionById(id)).status;
}

/** Estado tal como está guardado en la fila. */
async function estadoGuardado(id: string): Promise<string> {
  return (await prisma.competition.findUniqueOrThrow({ where: { id } })).status;
}

/**
 * Actor de CLUB, sin permiso de excepción post-cierre.
 *
 * Vive en el ámbito del módulo porque desde que un administrador puede exceder
 * los cupos, cualquier prueba que quiera comprobar que un cupo SE RESPETA tiene
 * que usar este actor: con el administrador, el alta pasaría a propósito.
 */
function actorDeClub(clubId: string) {
  return { userId: SIMPLE.userId, isAdmin: false, scope: { kind: "club" as const, clubId }, canRegisterPostClose: false };
}

let contadorRun = 10_000_000;
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

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  await seedCatalogos();
  const admin = await createUser({ username: "admin_cupos", roleNames: ["admin"] });
  SIMPLE = { userId: admin.id };
  ADMIN = { userId: admin.id, isAdmin: true, scope: { kind: "admin" }, canRegisterPostClose: true };
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe("sin cupos configurados — el comportamiento histórico no cambia", () => {
  it("admite tantos nadadores como haga falta y no cierra la competencia", async () => {
    const { competition, ceIndividual } = await montarCompetencia();
    const club = await createClub("Club Sin Cupo", "CSC");

    for (let i = 0; i < 5; i++) {
      const n = await crearNadadora(club.id, `Nadadora${i}`);
      await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n.id, clubId: club.id }, ADMIN);
    }

    const despues = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
    expect(await estadoEfectivo(competition.id)).toBe("open");
    expect(despues.maxSwimmers).toBeNull();
  });
});

describe("cupo global", () => {
  it("cuenta NADADORES distintos, no pruebas", async () => {
    const { competition, ceIndividual, ceIndividual2 } = await montarCompetencia({ maxSwimmers: 2 });
    const club = await createClub("Club Conteo", "CCO");
    const n1 = await crearNadadora(club.id, "Una");

    // Una misma nadadora en DOS pruebas: sigue siendo un solo cupo.
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id }, ADMIN);
    await registrationsService.createRegistration({ competitionEventId: ceIndividual2.id, personId: n1.id, clubId: club.id }, ADMIN);

    const uso = await competitionsService.getCompetitionCapacity(competition.id, ADMIN);
    expect(uso.totalSwimmers).toBe(1);
    expect(uso.remainingSwimmers).toBe(1);
    expect(uso.isFull).toBe(false);
  });

  it("al alcanzarse, CIERRA las inscripciones automáticamente", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 2 });
    const club = await createClub("Club Cierre", "CCI");
    const n1 = await crearNadadora(club.id, "Una");
    const n2 = await crearNadadora(club.id, "Dos");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id }, ADMIN);
    expect(await estadoEfectivo(competition.id)).toBe("open");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n2.id, clubId: club.id }, ADMIN);
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");
  });

  it("una vez lleno, un nadador NUEVO ya no entra", async () => {
    const { ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub("Club Lleno", "CLL");
    const n1 = await crearNadadora(club.id, "Una");
    const n2 = await crearNadadora(club.id, "Dos");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id }, ADMIN);

    await expect(
      // Con un actor de CLUB: un administrador puede exceder el cupo a
      // propósito, así que usarlo aquí ya no probaría el cupo.
      registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n2.id, clubId: club.id }, actorDeClub(club.id))
    ).rejects.toThrow(/cerradas|cupo/i);
  });

  it("pero un nadador YA inscrito sigue pudiendo añadir otra prueba", async () => {
    const { competition, ceIndividual, ceIndividual2 } = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub("Club Gestion", "CGE");
    const n1 = await crearNadadora(club.id, "Una");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id }, ADMIN);
    // La competencia quedó cerrada por cupo: el administrador con permiso
    // post-cierre puede seguir gestionando, y el cupo no lo bloquea porque
    // esta nadadora no consume uno nuevo.
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");

    const segunda = await registrationsService.createRegistration(
      { competitionEventId: ceIndividual2.id, personId: n1.id, clubId: club.id },
      ADMIN
    );
    expect(segunda.id).toBeTruthy();
  });
});

describe("cupo por club", () => {
  it("impide inscribir un nadador NUEVO del club que llegó a su tope", async () => {
    const { ceIndividual } = await montarCompetencia({ maxSwimmersPerClub: 1 });
    const clubA = await createClub("Club A", "CLA");
    const a1 = await crearNadadora(clubA.id, "A1");
    const a2 = await crearNadadora(clubA.id, "A2");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: a1.id, clubId: clubA.id }, ADMIN);

    await expect(
      registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: a2.id, clubId: clubA.id }, actorDeClub(clubA.id))
    ).rejects.toThrow(/Club A.*cupo de 1 nadador/i);
  });

  it("no afecta a los demás clubes ni cierra la competencia", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmersPerClub: 1 });
    const clubA = await createClub("Club A", "CLA");
    const clubB = await createClub("Club B", "CLB");
    const a1 = await crearNadadora(clubA.id, "A1");
    const b1 = await crearNadadora(clubB.id, "B1");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: a1.id, clubId: clubA.id }, ADMIN);
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: b1.id, clubId: clubB.id }, ADMIN);

    expect(await estadoEfectivo(competition.id)).toBe("open");
    const uso = await competitionsService.getCompetitionCapacity(competition.id, ADMIN);
    expect(uso.totalSwimmers).toBe(2);
    expect(uso.byClub.every((c) => c.isFull)).toBe(true);
  });

  it("un nadador ya inscrito del club lleno puede seguir gestionando sus pruebas", async () => {
    const { ceIndividual, ceIndividual2 } = await montarCompetencia({ maxSwimmersPerClub: 1 });
    const clubA = await createClub("Club A", "CLA");
    const a1 = await crearNadadora(clubA.id, "A1");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: a1.id, clubId: clubA.id }, ADMIN);
    const segunda = await registrationsService.createRegistration(
      { competitionEventId: ceIndividual2.id, personId: a1.id, clubId: clubA.id },
      ADMIN
    );
    expect(segunda.id).toBeTruthy();
  });
});

describe("altas por lotes — el relevo incorpora hasta cuatro nadadores de una vez", () => {
  it("un relevo cuyos integrantes NO caben se rechaza ENTERO, sin inscribir a ninguno", async () => {
    const { competition, ceIndividual, ceRelevo } = await montarCompetencia({ maxSwimmers: 3 });
    const club = await createClub("Club Relevo", "CRE");
    const yaInscrita = await crearNadadora(club.id, "Ya");
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: yaInscrita.id, clubId: club.id }, ADMIN);

    // Quedan 2 cupos y el equipo trae 3 integrantes nuevos + 1 ya inscrita.
    const nuevas = [];
    for (let i = 0; i < 3; i++) nuevas.push(await crearNadadora(club.id, `Nueva${i}`));

    /**
     * PREMISA CADUCADA, y el cambio es informativo.
     *
     * Esta prueba comprobaba que un relevo con integrantes NUEVOS se rechazara
     * entero si no cabían. Desde que un integrante necesita una inscripción
     * individual confirmada en la misma competencia, **un relevo ya no puede
     * aportar nadadores nuevos**: todos están contados antes de formarlo. El
     * escenario original no es alcanzable por la API.
     *
     * Lo que sí sigue siendo cierto —y es lo que se comprueba ahora— es que el
     * rechazo es ENTERO y no deja nada a medias.
     */
    await expect(
      relayService.createRelayRegistration(
        { competitionEventId: ceRelevo.id, clubId: club.id, personIds: [yaInscrita.id, ...nuevas.map((n) => n.id)] },
        ADMIN
      )
    ).rejects.toThrow(/inscripción individual confirmada/i);

    // Ni el equipo ni ninguno de sus integrantes quedó registrado.
    expect(await prisma.relayRegistration.count()).toBe(0);
    expect(await prisma.relayRegistrationMember.count()).toBe(0);
    const uso = await competitionsService.getCompetitionCapacity(competition.id, ADMIN);
    expect(uso.totalSwimmers).toBe(1);
  });

  it("el cupo lo llenan las individuales previas; el relevo posterior no suma más", async () => {
    const { competition, ceIndividual, ceRelevo } = await montarCompetencia({ maxSwimmers: 4 });
    const club = await createClub("Club Justo", "CJU");
    const equipo = [];
    for (let i = 0; i < 4; i++) equipo.push(await crearNadadora(club.id, `E${i}`));

    // Las cuatro se inscriben individualmente: eso es lo que llena el cupo y
    // deja la competencia en cierre PARCIAL.
    for (const n of equipo) {
      await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n.id, clubId: club.id }, ADMIN);
    }
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");

    // Y el relevo se admite igualmente: no incorpora a nadie nuevo.
    await relayService.createRelayRegistration(
      { competitionEventId: ceRelevo.id, clubId: club.id, personIds: equipo.map((n) => n.id) },
      ADMIN
    );

    const uso = await competitionsService.getCompetitionCapacity(competition.id, ADMIN);
    expect(uso.totalSwimmers, "no se cuentan dos veces").toBe(4);
    expect(uso.isFull).toBe(true);
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");
  });

  it("los integrantes de un relevo no se cuentan dos veces", async () => {
    const { competition, ceIndividual, ceRelevo } = await montarCompetencia({ maxSwimmers: 10 });
    const club = await createClub("Club Solo Relevo", "CSR");
    const equipo = [];
    for (let i = 0; i < 4; i++) equipo.push(await crearNadadora(club.id, `R${i}`));
    for (const n of equipo) {
      await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n.id, clubId: club.id }, ADMIN);
    }

    await relayService.createRelayRegistration(
      { competitionEventId: ceRelevo.id, clubId: club.id, personIds: equipo.map((n) => n.id) },
      ADMIN
    );

    const uso = await competitionsService.getCompetitionCapacity(competition.id, ADMIN);
    expect(uso.totalSwimmers, "cuatro nadadores distintos, no ocho").toBe(4);
    expect(await prisma.registration.count(), "cada uno con su individual previa").toBe(4);
  });
});

describe("concurrencia — dos solicitudes simultáneas sobre el último cupo", () => {
  it("solo una prospera; la otra falla y el cupo no se supera", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub("Club Carrera", "CCA");
    const n1 = await crearNadadora(club.id, "Primera");
    const n2 = await crearNadadora(club.id, "Segunda");

    /**
     * Las dos altas salen a la vez. La transacción SERIALIZABLE que envuelve
     * conteo e inserción hace que PostgreSQL detecte el conflicto y aborte
     * una: sin ella, ambas contarían "0 de 1 usado" y ambas insertarían.
     */
    const resultados = await Promise.allSettled([
      registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id }, ADMIN),
      registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n2.id, clubId: club.id }, ADMIN),
    ]);

    const exitos = resultados.filter((r) => r.status === "fulfilled").length;
    expect(exitos).toBe(1);

    const uso = await competitionsService.getCompetitionCapacity(competition.id, ADMIN);
    expect(uso.totalSwimmers).toBe(1);
    expect(uso.totalSwimmers).toBeLessThanOrEqual(1);
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");
  });

  it("cuatro solicitudes simultáneas sobre dos cupos dejan como mucho dos nadadores", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 2 });
    const club = await createClub("Club Carrera 4", "CC4");
    const nadadoras = [];
    for (let i = 0; i < 4; i++) nadadoras.push(await crearNadadora(club.id, `C${i}`));

    await Promise.allSettled(
      nadadoras.map((n) =>
        registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n.id, clubId: club.id }, ADMIN)
      )
    );

    const uso = await competitionsService.getCompetitionCapacity(competition.id, ADMIN);
    expect(uso.totalSwimmers).toBeLessThanOrEqual(2);
  });
});

describe("reducir un cupo por debajo de lo ya inscrito", () => {
  it("NO borra inscripciones: solo bloquea altas nuevas y cierra", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 10 });
    const club = await createClub("Club Reduccion", "CRD");
    const inscritas = [];
    for (let i = 0; i < 3; i++) {
      const n = await crearNadadora(club.id, `I${i}`);
      inscritas.push(n);
      await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n.id, clubId: club.id }, ADMIN);
    }
    expect(await prisma.registration.count()).toBe(3);

    // Se baja el cupo a 1, con 3 ya inscritas.
    await competitionsService.updateCompetition(competition.id, { maxSwimmers: 1 }, SIMPLE);

    // Las tres inscripciones SIGUEN ahí.
    expect(await prisma.registration.count()).toBe(3);
    const uso = await competitionsService.getCompetitionCapacity(competition.id, ADMIN);
    expect(uso.totalSwimmers).toBe(3);
    expect(uso.isFull).toBe(true);
    expect(uso.remainingSwimmers).toBe(0);

    // Y la competencia quedó con las individuales cerradas.
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");

    /**
     * Un nadador nuevo ya no entra — para un CLUB.
     *
     * Antes esta comprobación usaba el actor administrador, y ahora eso no
     * probaría el cupo: un administrador con permiso de excepción puede
     * inscribir por encima del máximo, que es justo lo que se añadió. Con un
     * actor de club el cupo vuelve a ser obligatorio, que es lo que esta
     * prueba quiere verificar.
     */
    const nueva = await crearNadadora(club.id, "Tarde");
    await expect(
      registrationsService.createRegistration(
        { competitionEventId: ceIndividual.id, personId: nueva.id, clubId: club.id },
        actorDeClub(club.id)
      )
    ).rejects.toThrow(/cupo de nadadores/i);
  });

  it("quitar el cupo (null) NO reabre por sí solo: hay que pedir la reapertura", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub("Club Reapertura", "CRA");
    const n1 = await crearNadadora(club.id, "Una");
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id }, ADMIN);
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");

    // Se quita el cupo y se reenvían las fechas, como hace el formulario.
    await competitionsService.updateCompetition(
      competition.id,
      { maxSwimmers: null, registrationStartAt: AYER, registrationEndAt: MANANA },
      SIMPLE
    );

    const trasGuardar = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
    expect(trasGuardar.maxSwimmers).toBeNull();
    expect(trasGuardar.status, "guardar nunca reabre").toBe("individual_closed");

    // La acción explícita sí, y ahora nada se lo impide.
    await competitionsService.reopenRegistrations(competition.id, SIMPLE);
    expect(await estadoGuardado(competition.id)).toBe("open");

    const n2 = await crearNadadora(club.id, "Dos");
    expect((await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n2.id, clubId: club.id }, ADMIN)).id).toBeTruthy();
  });

  /**
   * CONTRATO DE REAPERTURA.
   *
   *   1. El paso del tiempo NUNCA reabre: `computeEffectiveStatus` trata
   *      'closed' como terminal.
   *   2. EDITAR TAMPOCO, en ningún caso y sea cual sea la causa del cierre.
   *   3. Reabrir es una acción propia, `reopenRegistrations`, que exige que
   *      las fechas sigan vigentes y que el cupo no esté alcanzado.
   *
   * El punto 2 salió de dos fallos reales: el formulario envía siempre las
   * fechas y el cupo, así que "trae fechas" y "hay cupo libre" no distinguen
   * nada. Ver `competitions.rules.ts`.
   */
  it("mientras el cupo siga alcanzado, editar la competencia NO la reabre", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub("Club Sigue Lleno", "CSL");
    const n1 = await crearNadadora(club.id, "Una");
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id }, ADMIN);
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");

    // Una edición cualquiera, con las fechas todavía vigentes: sin el
    // refuerzo por cupo, `recomputeStatusAfterEdit` la devolvería a 'open'.
    await competitionsService.updateCompetition(competition.id, { name: "Copa Cupos renombrada" }, SIMPLE);

    expect(await estadoGuardado(competition.id)).toBe("individual_closed");
    expect(await estadoEfectivo(competition.id)).toBe("individual_closed");
  });

  it("ampliar el cupo deja la reapertura POSIBLE, pero no la ejecuta", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub("Club Subida", "CSU");
    const n1 = await crearNadadora(club.id, "Una");
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id }, ADMIN);
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");

    await competitionsService.updateCompetition(competition.id, { maxSwimmers: 50 }, SIMPLE);

    const despues = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
    expect(despues.maxSwimmers).toBe(50);
    expect(despues.status, "ampliar el cupo no es la orden de reabrir").toBe("individual_closed");

    // Pero ya no hay impedimento: la acción explícita ahora prospera.
    await competitionsService.reopenRegistrations(competition.id, SIMPLE);
    expect(await estadoGuardado(competition.id)).toBe("open");

    const n2 = await crearNadadora(club.id, "Dos");
    expect((await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n2.id, clubId: club.id }, ADMIN)).id).toBeTruthy();
  });
});

/**
 * DOS CASOS QUE EL RESTO DE LA SUITE NO CUBRÍA.
 *
 * Los dos se miden aquí tal como el sistema se comporta HOY, no como
 * quisiéramos que se comportara: el primero confirma una consecuencia del
 * diseño, el segundo documenta un hueco pendiente de decisión.
 */
describe("caso 1 — un usuario de CLUB tras el cierre por cupo", () => {
  it("NO puede añadir otra prueba a un nadador ya inscrito: el cierre es un cierre de verdad", async () => {
    const { competition, ceIndividual, ceIndividual2 } = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub("Club Cerrado", "CCE");
    const n1 = await crearNadadora(club.id, "Una");

    // Con la competencia abierta, el club inscribe sin problema.
    await registrationsService.createRegistration(
      { competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id },
      actorDeClub(club.id)
    );
    // Ese alta llenó el cupo y cerró la competencia.
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");

    /**
     * Y ahora el club ya NO puede seguir gestionando, ni siquiera para una
     * nadadora que YA está inscrita y que por tanto no consume cupo.
     *
     * No lo detiene el cupo —`evaluateCapacity` la dejaría pasar— sino la
     * ventana de inscripción: en 'individual_closed' las individuales solo
     * admiten operaciones de un administrador con permiso post-cierre. Los
     * relevos, en cambio, siguen abiertos para el club.
     */
    await expect(
      registrationsService.createRegistration(
        { competitionEventId: ceIndividual2.id, personId: n1.id, clubId: club.id },
        actorDeClub(club.id)
      )
    ).rejects.toThrow(/cupo de nadadores.*inscripciones individuales están cerradas/is);
  });

  it("el administrador con excepción post-cierre SÍ puede, y por eso el contraste importa", async () => {
    const { competition, ceIndividual, ceIndividual2 } = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub("Club Contraste", "CCT");
    const n1 = await crearNadadora(club.id, "Una");

    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id }, ADMIN);
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");

    const segunda = await registrationsService.createRegistration(
      { competitionEventId: ceIndividual2.id, personId: n1.id, clubId: club.id },
      ADMIN
    );
    expect(segunda.isPostCloseException, "queda marcada como excepción post-cierre").toBe(true);
  });

  it("con cupo POR CLUB agotado —que no cierra la competencia— el club sí sigue gestionando", async () => {
    // El contraste que aclara la diferencia entre los dos cupos: el de club
    // no cierra nada, así que la ventana sigue abierta para el club.
    const { competition, ceIndividual, ceIndividual2 } = await montarCompetencia({ maxSwimmersPerClub: 1 });
    const club = await createClub("Club Tope", "CTO");
    const n1 = await crearNadadora(club.id, "Una");

    await registrationsService.createRegistration(
      { competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id },
      actorDeClub(club.id)
    );
    expect(await estadoEfectivo(competition.id)).toBe("open");

    const segunda = await registrationsService.createRegistration(
      { competitionEventId: ceIndividual2.id, personId: n1.id, clubId: club.id },
      actorDeClub(club.id)
    );
    expect(segunda.id).toBeTruthy();

    // Pero un nadador NUEVO de ese club sigue bloqueado por el cupo.
    const n2 = await crearNadadora(club.id, "Dos");
    await expect(
      registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n2.id, clubId: club.id }, actorDeClub(club.id))
    ).rejects.toThrow(/cupo de 1 nadador/i);
  });
});

describe("caso 2 — ampliar el cupo frente a otros motivos de cierre", () => {
  it("NO reabre una competencia cuya fecha de cierre ya venció", async () => {
    // Aquí el sistema ya hace lo correcto: manda la fecha.
    const { competition } = await montarCompetencia({ maxSwimmers: 1 });
    const anteayer = new Date(Date.now() - 2 * 86_400_000);
    const ayer = new Date(Date.now() - 86_400_000);
    await competitionsService.updateCompetition(
      competition.id,
      { registrationStartAt: anteayer, registrationEndAt: ayer },
      SIMPLE
    );
    expect(await estadoGuardado(competition.id)).toBe("closed");

    await competitionsService.updateCompetition(competition.id, { maxSwimmers: 100 }, SIMPLE);

    expect(await estadoGuardado(competition.id), "una fecha vencida no se reabre por ampliar el cupo").toBe("closed");
    expect(await estadoEfectivo(competition.id)).toBe("closed");
  });

  /** Causa del cierre tal como quedó guardada. */
  async function causaDeCierre(id: string) {
    const c = await prisma.competition.findUniqueOrThrow({ where: { id } });
    return { causa: c.registrationsClosedReason, cuando: c.registrationsClosedAt };
  }

  /**
   * EL PAYLOAD REAL DEL FORMULARIO.
   *
   * Reproduce exactamente lo que envía `CompetitionDetailPage.handleSaveDetails`:
   * TODOS los campos en cada guardado, incluidas las dos fechas y los dos
   * cupos, se hayan tocado o no.
   *
   * Es la diferencia que hacía pasar unas pruebas que no valían: llamar al
   * servicio con `{ name: "x" }` no ejercita el camino que recorre la
   * aplicación, y era precisamente la presencia de las fechas lo que reabría
   * una competencia cerrada.
   */
  function payloadDelFormulario(
    actual: { name: string; description: string | null; registrationStartAt: Date; registrationEndAt: Date;
              ageCutoffDate: Date | null; maxIndividualEventsPerSwimmer: number | null;
              maxRelayEventsPerSwimmerPerSession: number; maxSwimmers: number | null;
              maxSwimmersPerClub: number | null; poolId: string | null },
    cambios: { name?: string; maxSwimmers?: number | null } = {}
  ) {
    return {
      name: cambios.name ?? actual.name,
      description: actual.description ?? "",
      registrationStartAt: actual.registrationStartAt,
      registrationEndAt: actual.registrationEndAt,
      ageCutoffDate: actual.ageCutoffDate ?? undefined,
      maxIndividualEventsPerSwimmer: actual.maxIndividualEventsPerSwimmer ?? undefined,
      maxRelayEventsPerSwimmerPerSession: actual.maxRelayEventsPerSwimmerPerSession,
      maxSwimmers: cambios.maxSwimmers !== undefined ? cambios.maxSwimmers : actual.maxSwimmers,
      maxSwimmersPerClub: actual.maxSwimmersPerClub,
      poolId: actual.poolId,
    };
  }

  const leer = (id: string) => prisma.competition.findUniqueOrThrow({ where: { id } });

  it("CASO 1 — cerrada a mano y se cambia solo el NOMBRE con el payload real: sigue cerrada", async () => {
    const { competition } = await montarCompetencia({ maxSwimmers: 10 });
    await competitionsService.transitionCompetition(competition.id, "closeRegistrations", { ...SIMPLE, isAdmin: true });
    expect(await estadoGuardado(competition.id)).toBe("closed");
    expect((await causaDeCierre(competition.id)).causa).toBe("manual");

    // El formulario reenvía las dos fechas SIN cambios, que es lo que antes
    // la reabría.
    const actual = await leer(competition.id);
    await competitionsService.updateCompetition(competition.id, payloadDelFormulario(actual, { name: "Copa renombrada" }), SIMPLE);

    const despues = await leer(competition.id);
    expect(despues.name).toBe("Copa renombrada");
    expect(despues.status, "guardar no reabre").toBe("closed");
    expect(despues.registrationsClosedReason).toBe("manual");
  });

  it("CASO 2 — cerrada por cupo, baja la ocupación y se cambia solo el NOMBRE: tampoco reabre", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub("Club Baja", "CBA");
    const n1 = await crearNadadora(club.id, "Una");
    const inscripcion = await registrationsService.createRegistration(
      { competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id },
      ADMIN
    );
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");
    expect((await causaDeCierre(competition.id)).causa).toBe("capacity");

    // Se cancela la inscripción: AHORA SOBRA SITIO, pero nadie amplió el cupo.
    await registrationsService.cancelRegistration(inscripcion.id, ADMIN);
    expect((await competitionsService.getCompetitionCapacity(competition.id, ADMIN)).totalSwimmers).toBe(0);

    const actual = await leer(competition.id);
    await competitionsService.updateCompetition(competition.id, payloadDelFormulario(actual, { name: "Otro nombre" }), SIMPLE);

    const despues = await leer(competition.id);
    expect(despues.name).toBe("Otro nombre");
    expect(despues.status, "que sobre sitio no es una orden de reapertura").toBe("individual_closed");
    expect(despues.registrationsClosedReason).toBe("capacity");
  });

  it("ampliar el cupo con el payload real TAMPOCO reabre por sí solo", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub("Club Amplia", "CAM");
    const n1 = await crearNadadora(club.id, "Una");
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id }, ADMIN);

    const actual = await leer(competition.id);
    await competitionsService.updateCompetition(competition.id, payloadDelFormulario(actual, { maxSwimmers: 100 }), SIMPLE);

    const despues = await leer(competition.id);
    expect(despues.maxSwimmers).toBe(100);
    expect(despues.status, "hay que pedir la reapertura explícitamente").toBe("individual_closed");
  });

  it("reabrir es una acción aparte, y entonces sí", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub("Club Reab", "CRB");
    const n1 = await crearNadadora(club.id, "Una");
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id }, ADMIN);

    /**
     * CAMBIO DE COMPORTAMIENTO. Con el cupo todavía alcanzado, la reapertura ya
     * no se niega: deja la competencia en cierre PARCIAL —relevos habilitados,
     * individuales cerradas— y explica que hay que ampliar el cupo para
     * habilitarlas. Sigue sin ser automática.
     */
    const parcial = await competitionsService.reopenRegistrations(competition.id, SIMPLE);
    expect(parcial.status).toBe("individual_closed");

    const actual = await leer(competition.id);
    await competitionsService.updateCompetition(competition.id, payloadDelFormulario(actual, { maxSwimmers: 100 }), SIMPLE);
    await competitionsService.reopenRegistrations(competition.id, SIMPLE);

    const despues = await leer(competition.id);
    expect(despues.status).toBe("open");
    expect(despues.registrationsClosedReason, "reabrir limpia la causa").toBeNull();
    expect(despues.registrationsClosedAt).toBeNull();

    // Y vuelve a admitir nadadores nuevos.
    const n2 = await crearNadadora(club.id, "Dos");
    expect((await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n2.id, clubId: club.id }, ADMIN)).id).toBeTruthy();
  });

  it("reabrir con la fecha vencida se niega y pide extenderla", async () => {
    const { competition } = await montarCompetencia({ maxSwimmers: 10 });
    const anteayer = new Date(Date.now() - 2 * 86_400_000);
    const ayer = new Date(Date.now() - 86_400_000);
    await prisma.competition.update({
      where: { id: competition.id },
      data: { status: "closed", registrationStartAt: anteayer, registrationEndAt: ayer, registrationsClosedReason: "schedule", registrationsClosedAt: new Date() },
    });

    await expect(competitionsService.reopenRegistrations(competition.id, SIMPLE)).rejects.toThrow(/Extienda la fecha de fin/i);
    expect(await estadoGuardado(competition.id)).toBe("closed");
  });

  it("una fila antigua con causa NULA tampoco se reabre al guardar, y sí con la acción", async () => {
    const { competition } = await montarCompetencia({ maxSwimmers: 10 });
    await prisma.competition.update({
      where: { id: competition.id },
      data: { status: "closed", registrationsClosedReason: null, registrationsClosedAt: null },
    });

    const actual = await leer(competition.id);
    await competitionsService.updateCompetition(competition.id, payloadDelFormulario(actual, { name: "Renombrada" }), SIMPLE);
    expect(await estadoGuardado(competition.id)).toBe("closed");

    await competitionsService.reopenRegistrations(competition.id, SIMPLE);
    expect(await estadoGuardado(competition.id)).toBe("open");
  });

  it("el cierre por CUPO y el automático por FECHA guardan su causa", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub("Club Causa", "CCU");
    const n1 = await crearNadadora(club.id, "Una");
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: n1.id, clubId: club.id }, ADMIN);
    const porCupo = await causaDeCierre(competition.id);
    expect(porCupo.causa).toBe("capacity");
    expect(porCupo.cuando).toBeInstanceOf(Date);

    // Cierre automático por vencimiento: `applyAutoStatus` lo persiste al leer.
    const otra = await montarCompetencia();
    await prisma.competition.update({
      where: { id: otra.competition.id },
      data: { status: "open", registrationStartAt: new Date(Date.now() - 2 * 86_400_000), registrationEndAt: new Date(Date.now() - 86_400_000) },
    });
    expect(await estadoEfectivo(otra.competition.id)).toBe("closed");
    expect((await causaDeCierre(otra.competition.id)).causa).toBe("schedule");
  });

  it("la base impide una fila abierta que conserve causa de cierre", async () => {
    // La restricción `competitions_close_reason_coherente` es la red que
    // atrapa cualquier camino que actualice el estado sin mover la causa.
    const { competition } = await montarCompetencia();
    await expect(
      prisma.competition.update({
        where: { id: competition.id },
        data: { status: "open", registrationsClosedReason: "manual", registrationsClosedAt: new Date() },
      })
    ).rejects.toThrow();
  });
});

describe("validación de los cupos al configurarlos", () => {
  it("el cupo por club no puede superar el global", async () => {
    await expect(
      competitionsService.updateCompetition(
        (await montarCompetencia({ maxSwimmers: 10 })).competition.id,
        { maxSwimmersPerClub: 20 },
        SIMPLE
      )
    ).rejects.toThrow(/no puede superar el cupo total/i);
  });

  it("el detalle por club se recorta al alcance del actor", async () => {
    const { competition, ceIndividual } = await montarCompetencia({ maxSwimmersPerClub: 5 });
    const clubA = await createClub("Club A", "CLA");
    const clubB = await createClub("Club B", "CLB");
    const a1 = await crearNadadora(clubA.id, "A1");
    const b1 = await crearNadadora(clubB.id, "B1");
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: a1.id, clubId: clubA.id }, ADMIN);
    await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, personId: b1.id, clubId: clubB.id }, ADMIN);

    const comoAdmin = await competitionsService.getCompetitionCapacity(competition.id, ADMIN);
    expect(comoAdmin.byClub).toHaveLength(2);

    const comoClubA = await competitionsService.getCompetitionCapacity(competition.id, {
      userId: ADMIN.userId,
      isAdmin: false,
      scope: { kind: "club", clubId: clubA.id },
      canRegisterPostClose: false,
    });
    expect(comoClubA.byClub).toHaveLength(1);
    expect(comoClubA.byClub[0]!.clubId).toBe(clubA.id);
    // El total global sí se ve: es lo que necesita para saber si hay sitio.
    expect(comoClubA.totalSwimmers).toBe(2);
  });
});

describe("concurrencia de la REAPERTURA frente a una inscripción post-cierre", () => {
  /**
   * EL ESTADO PROHIBIDO: competencia ABIERTA con el cupo ya alcanzado.
   *
   * Es alcanzable si la reapertura comprueba la ocupación fuera de la
   * operación que escribe el estado. Entre el conteo y el `update`, un
   * administrador con permiso post-cierre puede inscribir al nadador que
   * completa el cupo; la reapertura, que contó de menos, se confirma igual y
   * deja la competencia abierta y llena.
   *
   * Lo impide ejecutar conteo, evaluación y actualización dentro de una misma
   * transacción SERIALIZABLE, accediendo en el MISMO orden que la vía de
   * inscripción —primero `registrations`/`relay_registrations`, después
   * `competitions`— para no cerrar un ciclo de espera entre las dos.
   */
  async function prepararCasiLlena() {
    // Cupo 1 con una inscrita: se cierra sola por cupo.
    const montaje = await montarCompetencia({ maxSwimmers: 1 });
    const club = await createClub(`Club Carrera ${Math.random().toString(36).slice(2, 6)}`, `C${Math.floor(Math.random() * 900 + 100)}`);
    const primera = await crearNadadora(club.id, "Primera");
    await registrationsService.createRegistration(
      { competitionEventId: montaje.ceIndividual.id, personId: primera.id, clubId: club.id },
      ADMIN
    );
    expect(await estadoGuardado(montaje.competition.id)).toBe("individual_closed");

    // Se amplía el cupo a 2: la reapertura pasa a ser posible, y queda
    // exactamente UN cupo libre — el que las dos operaciones se disputan.
    await competitionsService.updateCompetition(montaje.competition.id, { maxSwimmers: 2 }, SIMPLE);
    // Ampliar el cupo NO reabre: sigue en cierre parcial hasta que alguien lo
    // pida explícitamente, que es justo lo que la carrera de abajo disputa.
    expect(await estadoGuardado(montaje.competition.id)).toBe("individual_closed");

    const segunda = await crearNadadora(club.id, "Segunda");
    return { ...montaje, club, segunda };
  }

  /** La invariante que nunca puede romperse, sea cual sea el orden. */
  async function comprobarInvariante(competitionId: string) {
    const fila = await prisma.competition.findUniqueOrThrow({ where: { id: competitionId } });
    const uso = await competitionsService.getCompetitionCapacity(competitionId, ADMIN);
    if (fila.status === "open") {
      expect(
        uso.totalSwimmers,
        `competencia ABIERTA con ${uso.totalSwimmers} nadador(es) y cupo ${fila.maxSwimmers}: estado prohibido`
      ).toBeLessThan(fila.maxSwimmers!);
    }
    // En ningún caso puede superarse el cupo.
    expect(uso.totalSwimmers).toBeLessThanOrEqual(fila.maxSwimmers!);
    return { status: fila.status, totalSwimmers: uso.totalSwimmers, maxSwimmers: fila.maxSwimmers };
  }

  it("reabrir y una inscripción post-cierre simultáneas nunca dejan una competencia abierta y llena", async () => {
    const { competition, ceIndividual, club, segunda } = await prepararCasiLlena();

    /**
     * Las dos salen a la vez y se disputan el último cupo:
     *   - la inscripción administrativa post-cierre, permitida porque la
     *     competencia está cerrada y el actor tiene esa excepción;
     *   - la reapertura, que ve 1 de 2 ocupados y querría abrir.
     */
    const resultados = await Promise.allSettled([
      registrationsService.createRegistration(
        { competitionEventId: ceIndividual.id, personId: segunda.id, clubId: club.id },
        ADMIN
      ),
      competitionsService.reopenRegistrations(competition.id, SIMPLE),
    ]);

    const final = await comprobarInvariante(competition.id);

    // Al menos una de las dos tiene que haber prosperado: un conflicto de
    // serialización aborta una, no las dos.
    expect(resultados.some((r) => r.status === "fulfilled")).toBe(true);

    /**
     * Los desenlaces legítimos:
     *   a) la inscripción ganó -> 2 de 2 y sigue en cierre PARCIAL (la
     *      reapertura vio el cupo alcanzado, o fue abortada por conflicto);
     *   b) la reapertura ganó -> ABIERTA con 1 de 2, y la inscripción fue
     *      abortada por conflicto.
     *
     * Lo prohibido, que es lo que de verdad se vigila, sigue siendo lo mismo:
     * ABIERTA con el cupo ya alcanzado.
     */
    const desenlaceValido =
      (final.status === "individual_closed" && final.totalSwimmers <= 2) ||
      (final.status === "closed" && final.totalSwimmers <= 2) ||
      (final.status === "open" && final.totalSwimmers === 1);
    expect(desenlaceValido, `desenlace inesperado: ${JSON.stringify(final)}`).toBe(true);
  });

  it("repetido varias veces, la invariante aguanta siempre", async () => {
    // Una sola pasada puede serializarse por suerte; varias hacen mucho más
    // probable que las dos transacciones se solapen de verdad.
    for (let intento = 0; intento < 5; intento++) {
      const { competition, ceIndividual, club, segunda } = await prepararCasiLlena();

      await Promise.allSettled([
        registrationsService.createRegistration(
          { competitionEventId: ceIndividual.id, personId: segunda.id, clubId: club.id },
          ADMIN
        ),
        competitionsService.reopenRegistrations(competition.id, SIMPLE),
      ]);

      await comprobarInvariante(competition.id);
    }
  });

  it("dos reaperturas simultáneas no dejan un estado incoherente", async () => {
    const { competition } = await prepararCasiLlena();

    const resultados = await Promise.allSettled([
      competitionsService.reopenRegistrations(competition.id, SIMPLE),
      competitionsService.reopenRegistrations(competition.id, SIMPLE),
    ]);

    // Reabrir dos veces no es un error de negocio: la segunda encuentra la
    // competencia ya abierta y la rechaza por estado, no por cupo.
    expect(resultados.some((r) => r.status === "fulfilled")).toBe(true);
    const fila = await prisma.competition.findUniqueOrThrow({ where: { id: competition.id } });
    expect(fila.status).toBe("open");
    expect(fila.registrationsClosedReason, "abierta no conserva causa").toBeNull();
    await comprobarInvariante(competition.id);
  });

  it("si el cupo se completa ANTES, la reapertura deja el cierre PARCIAL y lo explica", async () => {
    // El mismo escenario resuelto en serie: es el desenlace (a) forzado.
    const { competition, ceIndividual, club, segunda } = await prepararCasiLlena();

    await registrationsService.createRegistration(
      { competitionEventId: ceIndividual.id, personId: segunda.id, clubId: club.id },
      ADMIN
    );

    // Ya no se niega: habilita los relevos y deja dicho que para las
    // individuales hay que ampliar el cupo y volver a reabrir.
    const resultado = await competitionsService.reopenRegistrations(competition.id, SIMPLE);
    expect(resultado.status).toBe("individual_closed");
    expect(await estadoGuardado(competition.id)).toBe("individual_closed");
  });
});
