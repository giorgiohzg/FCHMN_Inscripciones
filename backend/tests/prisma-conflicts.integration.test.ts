/**
 * Fase 5 (adelantado) — traducción de P2002 verificada contra PostgreSQL.
 *
 * El defecto: `UNIQUE_CONFLICT_MESSAGES` y los `overrides` estaban indexados
 * por NOMBRE DE ÍNDICE (`persons_run_unique_active`, …), pero Prisma informa
 * el modelo y las COLUMNAS. Ninguna de las ocho entradas coincidía nunca, así
 * que toda violación de índice único —nadador inscrito dos veces, RUN
 * repetido, membresía activa duplicada— salía con el texto genérico "Ya existe
 * un registro con esos datos.". El 409 sí era correcto; el mensaje no.
 *
 * No se detectó antes porque la prueba unitaria construía el error a mano con
 * el nombre del índice: verificaba el mapa contra sí mismo. Aquí cada conflicto
 * se provoca DE VERDAD contra la base desechable, y se comprueba el mensaje que
 * recibiría el usuario. Si un índice cambia de columnas, esta prueba lo dice.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";
import { translatePrismaError, withTranslatedPrismaErrors, uniqueConflictKeys } from "../src/shared/prismaErrors";
import * as categoryGroupsService from "../src/modules/catalogs/category-groups.service";
import { AppError, ConflictError } from "../src/shared/errors";

let ADMIN_USER_ID: string;

/**
 * Provoca el conflicto y devuelve el error de dominio que produciría el
 * manejador global. Falla la prueba si la operación NO choca: eso significaría
 * que el índice ya no existe o que dejó de cubrir este caso.
 */
async function conflictoReal(fn: () => Promise<unknown>): Promise<AppError> {
  let capturado: unknown;
  try {
    await fn();
  } catch (err) {
    capturado = err;
  }
  expect(capturado, "se esperaba un conflicto de índice único y la operación no falló").toBeDefined();

  const traducido = translatePrismaError(capturado);
  expect(traducido, `el error no se reconoció como error de Prisma: ${String(capturado)}`).not.toBeNull();
  return traducido!;
}

const PERSONA_BASE = {
  firstName: "X",
  paternalLastName: "P",
  fullName: "X P",
  birthDate: new Date("1990-01-01"),
  gender: "female" as const,
  status: "active" as const,
};

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_conflictos", roleNames: ["admin"] });
  ADMIN_USER_ID = admin.id;
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("P2002 real — claves naturales del catálogo", () => {
  it("persons_run_unique_active → mensaje sobre el RUN", async () => {
    await prisma.person.create({ data: { ...PERSONA_BASE, run: "10000001", username: "p_uno" } });

    const error = await conflictoReal(() => prisma.person.create({ data: { ...PERSONA_BASE, run: "10000001", username: "p_dos" } }));

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.statusCode).toBe(409);
    expect(error.message).toMatch(/ese RUN/i);
    expect(error.details).toMatchObject({ constraint: "Person.run" });
  });

  it("persons_username_unique_active → mensaje sobre el nombre de usuario", async () => {
    await prisma.person.create({ data: { ...PERSONA_BASE, run: "10000002", username: "p_uno" } });

    const error = await conflictoReal(() => prisma.person.create({ data: { ...PERSONA_BASE, run: "10000003", username: "p_uno" } }));

    expect(error.message).toMatch(/persona con ese nombre de usuario/i);
  });

  it("clubs_username_unique_active → mensaje sobre el club", async () => {
    const club = await createClub("Club A", "CA");

    const error = await conflictoReal(() =>
      prisma.club.create({ data: { name: "Club B", username: club.username, code: "CB", email: "cb@test.local", status: "active" } })
    );

    expect(error.message).toMatch(/club con ese nombre de usuario/i);
  });

  it("categories_unique_active_name → mensaje sobre la categoría y su tipo de prueba", async () => {
    const tt = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
    await prisma.category.create({ data: { testTypeId: tt.id, name: "Master A", minAge: 20, maxAge: 99 } });

    const error = await conflictoReal(() => prisma.category.create({ data: { testTypeId: tt.id, name: "Master A", minAge: 20, maxAge: 99 } }));

    expect(error.message).toMatch(/categoría con ese nombre para ese tipo de prueba/i);
  });

  it("events_unique_active_definition → mensaje sobre la combinación de la prueba", async () => {
    const tt = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
    const distancia = await prisma.distance.create({ data: { meters: 50 } });
    const estilo = await prisma.stroke.create({ data: { name: "Libre" } });
    const definicion = { testTypeId: tt.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" as const };
    await prisma.event.create({ data: definicion });

    const error = await conflictoReal(() => prisma.event.create({ data: definicion }));

    expect(error.message).toMatch(/combinación de tipo, distancia, estilo y género/i);
  });
});

describe("P2002 real — reglas de negocio con índice parcial", () => {
  it("club_swimmers_unique_active_person → mensaje sobre la membresía activa", async () => {
    const clubA = await createClub("Club A", "CA");
    const clubB = await createClub("Club B", "CB");
    const persona = await createPerson({ run: "20000001", username: "nad_uno", firstName: "N", gender: "female" });
    await addActiveMembership(clubA.id, persona.id, ADMIN_USER_ID);

    const error = await conflictoReal(() => addActiveMembership(clubB.id, persona.id, ADMIN_USER_ID));

    expect(error.message).toMatch(/membresía activa/i);
  });

  it("registrations_unique_confirmed_person_event → mensaje sobre el nadador ya inscrito", async () => {
    const escenario = await montarPruebaDeCompetencia();
    const datos = {
      competitionEventId: escenario.competitionEventId,
      personId: escenario.personId,
      clubId: escenario.clubId,
      categoryId: escenario.categoryId,
      status: "confirmed" as const,
      registeredByUserId: ADMIN_USER_ID,
    };
    await prisma.registration.create({ data: datos });

    const error = await conflictoReal(() => prisma.registration.create({ data: datos }));

    expect(error.message).toMatch(/ya está inscrito en esta prueba/i);
    expect(error.details).toMatchObject({ constraint: "Registration.competition_event_id,person_id" });
  });

  it("relay_registrations_unique_confirmed_team → mensaje sobre el equipo del club", async () => {
    const escenario = await montarPruebaDeCompetencia();
    const datos = {
      competitionEventId: escenario.competitionEventId,
      clubId: escenario.clubId,
      categoryId: escenario.categoryId,
      status: "confirmed" as const,
      registeredByUserId: ADMIN_USER_ID,
    };
    await prisma.relayRegistration.create({ data: datos });

    const error = await conflictoReal(() => prisma.relayRegistration.create({ data: datos }));

    expect(error.message).toMatch(/ya tiene un equipo inscrito/i);
  });
});

describe("P2002 real — override del llamador", () => {
  /**
   * El camino del override NO se puede alcanzar llamando al servicio de forma
   * secuencial: su comprobación previa (`findFirst` con `deleted_at IS NULL`)
   * cubre exactamente las mismas filas que el índice parcial, así que atrapa
   * el duplicado antes. En producción el índice solo entra en juego bajo
   * concurrencia, que no es reproducible de forma determinista.
   *
   * Lo que sí se puede —y es lo que falta— es ejecutar el duplicado REAL
   * dentro de `withTranslatedPrismaErrors` con el mismo override que registra
   * el servicio, para comprobar que ese override efectivamente se aplica.
   */
  it("un duplicado real dentro de withTranslatedPrismaErrors recibe el override del llamador", async () => {
    await prisma.categoryGroup.create({ data: { name: "Grupo Único" } });

    const propio = new ConflictError("Ya existe un grupo de categorías con ese nombre");
    const error = await withTranslatedPrismaErrors(() => prisma.categoryGroup.create({ data: { name: "Grupo Único" } }), {
      "CategoryGroup.name": propio,
    })
      .then(() => null)
      .catch((e) => e as AppError);

    // Es exactamente el objeto entregado, no una traducción genérica.
    expect(error).toBe(propio);
    expect(error!.statusCode).toBe(409);
  });

  it("la clave que registra el servicio es la que produce el conflicto real", async () => {
    await prisma.categoryGroup.create({ data: { name: "Grupo Único" } });

    let metaReal: unknown;
    try {
      await prisma.categoryGroup.create({ data: { name: "Grupo Único" } });
    } catch (err) {
      metaReal = (err as { meta?: unknown }).meta;
    }

    // `category-groups.service.ts` registra el override bajo "CategoryGroup.name".
    expect(uniqueConflictKeys(metaReal as { target?: string[]; modelName?: string })).toContain("CategoryGroup.name");
  });

  it("sin override, el mismo conflicto sale como 409 con la clave correcta", async () => {
    await categoryGroupsService.createCategoryGroup("Grupo Único", { userId: ADMIN_USER_ID });

    const error = await conflictoReal(() => prisma.categoryGroup.create({ data: { name: "Grupo Único" } }));

    expect(error.statusCode).toBe(409);
    expect(error.details).toMatchObject({ constraint: "CategoryGroup.name" });
  });
});

/**
 * Punto ciego que las pruebas anteriores no cubrían: todas llamaban a
 * `translatePrismaError` a mano, así que habrían seguido en verde aunque el
 * servidor no lo usara — y no lo usaba. El manejador global respondía 500 a
 * cualquier P2002 que el servicio no hubiera traducido explícitamente.
 *
 * Este caso recorre el camino completo: petición HTTP real contra la
 * aplicación de `buildServer()`, un servicio que NO llama a
 * `withTranslatedPrismaErrors`, y la respuesta que recibiría el cliente.
 */
describe("manejador global de errores — P2002 no previsto por el servicio", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Este escenario nació como la prueba de extremo a extremo del traductor en
   * el manejador global: `POST /persons` con `roles: ["swimmer","swimmer"]`
   * chocaba contra el índice único de `person_roles` y salía como 500.
   *
   * Al corregir el hallazgo 20 los roles se deduplicaban en el esquema y el
   * disparador desapareció. Con el hallazgo 32 desapareció el campo entero: los
   * roles son DERIVADOS, y enviarlos **se rechaza** en vez de ignorarse, para
   * que un cliente antiguo no reciba un 201 por una operación que no ocurrió.
   *
   * La prueba se conserva —invertida dos veces— porque sigue cubriendo algo que
   * importa: qué pasa con un `roles` que llega de fuera. La cobertura del
   * manejador global con un P2002 real vive en el caso siguiente.
   */
  it("un alta de persona con roles en el payload se RECHAZA, sin crear nada", async () => {
    await createUser({ username: "admin_http", roleNames: ["admin"] });

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin_http", password: TEST_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cabeceras = { authorization: `Bearer ${login.json().accessToken}` };

    const respuesta = await app.inject({
      method: "POST",
      url: "/persons",
      headers: cabeceras,
      payload: {
        run: "11111111-1",
        username: "persona.dup",
        firstName: "Persona",
        paternalLastName: "Duplicada",
        birthDate: "1990-01-01",
        gender: "female",
        roles: ["swimmer", "swimmer"],
      },
    });

    expect(respuesta.statusCode, respuesta.body).toBe(400);
    expect(
      JSON.stringify(respuesta.json().details),
      "el mensaje dice dónde se obtiene el rol de verdad"
    ).toMatch(/plantel|ficha del club/);

    expect(await prisma.person.count({ where: { username: "persona.dup" } }), "no se crea a medias").toBe(0);
    expect(await prisma.personRole.count(), "ningún rol fabricado").toBe(0);
  });

  /**
   * Cobertura del manejador global con un P2002 REAL, no construido a mano:
   * se provoca contra la base y se resuelve con la MISMA función que usa
   * `server.ts` para decidir la respuesta.
   *
   * Sustituye al escenario HTTP anterior, que dejó de producir un error al
   * deduplicarse los roles. Lo que se comprueba es lo mismo: un conflicto de
   * índice que ningún servicio previó sale como 409 con su mensaje, y se
   * registra como aviso, no como falla del sistema.
   */
  it("un P2002 real capturado de la base se resuelve como 409 en el manejador global", async () => {
    const { resolveErrorResponse } = await import("../src/shared/httpErrorResponse");

    await prisma.person.create({ data: { ...PERSONA_BASE, run: "10000009", username: "p_manejador" } });

    let capturado: unknown;
    try {
      await prisma.person.create({ data: { ...PERSONA_BASE, run: "10000009", username: "p_manejador_dos" } });
    } catch (err) {
      capturado = err;
    }
    expect(capturado, "se esperaba el conflicto de RUN repetido").toBeDefined();

    const resuelto = resolveErrorResponse(capturado);

    expect(resuelto.status).toBe(409);
    expect(resuelto.body.error).toBe("CONFLICT");
    expect(resuelto.body.message).toMatch(/ese RUN/i);
    expect(resuelto.body.details).toMatchObject({ constraint: "Person.run" });
    expect(resuelto.log, "un conflicto de datos no es una falla del sistema").toBe("warn");
  });

  it("un error sin traducción posible sigue saliendo como 500", async () => {
    // El traductor es el ÚLTIMO filtro, no un cajón de sastre: lo que no es un
    // error conocido de Prisma se sigue tratando como falla del sistema.
    const { resolveErrorResponse } = await import("../src/shared/httpErrorResponse");
    const resuelto = resolveErrorResponse(new Error("algo inesperado"));
    expect(resuelto.status).toBe(500);
    expect(resuelto.log).toBe("error");
  });

  it("un error con estado 4xx propio (rate limit, payload grande) conserva su estado", async () => {
    const { resolveErrorResponse } = await import("../src/shared/httpErrorResponse");
    const resuelto = resolveErrorResponse({ statusCode: 429, code: "RATE_LIMIT_EXCEEDED", message: "Demasiadas solicitudes" });
    expect(resuelto.status).toBe(429);
    expect(resuelto.body.error).toBe("RATE_LIMIT_EXCEEDED");
    expect(resuelto.log).toBeNull();
  });
});

/** Competencia mínima con una prueba asignada, un club, un nadador y una categoría. */
async function montarPruebaDeCompetencia() {
  const tt = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
  const distancia = await prisma.distance.create({ data: { meters: 50 } });
  const estilo = await prisma.stroke.create({ data: { name: "Libre" } });
  const sessionType = await prisma.sessionType.create({ data: { name: "Mañana" } });
  const categoria = await prisma.category.create({ data: { testTypeId: tt.id, name: "Master A", minAge: 20, maxAge: 99 } });
  const evento = await prisma.event.create({ data: { testTypeId: tt.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" } });

  const club = await createClub("Club Conflictos", "CCF");
  const persona = await createPerson({ run: "30000001", username: "nad_conf", firstName: "N", gender: "female" });

  const competition = await prisma.competition.create({
    data: {
      name: "Competencia Conflictos",
      status: "open",
      registrationStartAt: new Date(Date.now() - 86_400_000),
      registrationEndAt: new Date(Date.now() + 86_400_000),
      ageCutoffDate: new Date(),
      maxIndividualEventsPerSwimmer: 10,
      maxRelayEventsPerSwimmerPerSession: 5,
      createdBy: ADMIN_USER_ID,
      updatedBy: ADMIN_USER_ID,
    },
  });
  const fecha = await prisma.competitionDate.create({ data: { competitionId: competition.id, date: new Date() } });
  const session = await prisma.competitionSession.create({
    data: { competitionDateId: fecha.id, sessionTypeId: sessionType.id, competitionId: competition.id },
  });
  const competitionEvent = await prisma.competitionEvent.create({
    data: { competitionId: competition.id, eventId: evento.id, competitionSessionId: session.id },
  });

  return { competitionEventId: competitionEvent.id, clubId: club.id, personId: persona.id, categoryId: categoria.id };
}
