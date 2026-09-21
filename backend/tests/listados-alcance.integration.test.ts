/**
 * Hallazgo 31 — ALCANCE DE LOS LISTADOS DE INSCRIPCIONES, por HTTP.
 *
 * La política existe en `shared/actorContext.ts` y los dos servicios la aplican,
 * pero hasta ahora **nada la comprobaba sobre estos dos endpoints**. Lo que había
 * era: `authorization.integration.test.ts`, que prueba el aislamiento sobre
 * `/registrations/club-swimmers`, `/reports/registrations` y `/clubs`; y
 * `orden-determinista.test.ts`, que invoca `listRegistrations` con un actor
 * administrador para inspeccionar el `orderBy`. Ninguno toca `GET /registrations`
 * ni `GET /relay-registrations` con actores acotados.
 *
 * Importa porque son justo los que alimentan el panel de historial, y porque el
 * historial incluye las CANCELADAS: si el acotamiento se aplicara solo al camino
 * de las confirmadas, pedir `status=cancelled` sería una vía para ver lo ajeno.
 *
 * Se prueba por HTTP (`app.inject`), no llamando a los servicios: es la única
 * forma de verificar que quien llame directamente a la API no se salta nada. Y se
 * comprueban los CONJUNTOS DE IDENTIFICADORES devueltos, no solo el código de
 * estado: un 200 con filas ajenas dentro es peor que un 403.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";

let app: FastifyInstance;

const ctx = {
  clubAId: "",
  clubBId: "",
  competitionId: "",
  nadadorAId: "",
  nadadorBId: "",
  tokens: {} as Record<string, string>,
  /** Inscripciones individuales sembradas, por club y estado. */
  ind: {} as Record<string, string>,
  /** Relevos sembrados, por club y estado. */
  rel: {} as Record<string, string>,
};

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username} devolvió ${res.statusCode}: ${res.body}`);
  return res.json().accessToken as string;
}

/** Pide un listado y devuelve el estado y el conjunto de ids del cuerpo. */
async function listar(
  ruta: "/registrations" | "/relay-registrations",
  token: string,
  params: Record<string, string>
): Promise<{ status: number; ids: string[]; clubIds: string[]; total: number; body: any }> {
  const query = new URLSearchParams({ competitionId: ctx.competitionId, pageSize: "200", ...params }).toString();
  const res = await app.inject({ method: "GET", url: `${ruta}?${query}`, headers: auth(token) });
  if (res.statusCode !== 200) return { status: res.statusCode, ids: [], clubIds: [], total: 0, body: res.json() };
  const body = res.json();
  return {
    status: res.statusCode,
    ids: (body.items as { id: string }[]).map((i) => i.id).sort(),
    clubIds: [...new Set((body.items as { club: { id: string } }[]).map((i) => i.club.id))].sort(),
    total: body.total as number,
    body,
  };
}

const ordenados = (...ids: string[]) => [...ids].sort();

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();

  // --- Catálogos mínimos ---------------------------------------------------
  const tipoIndividual = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
  const tipoRelevo = await prisma.testType.create({ data: { name: "Relevo 4x", swimmersCount: 4 } });
  const distancia = await prisma.distance.create({ data: { meters: 50 } });
  const estilo = await prisma.stroke.create({ data: { name: "Libre" } });
  const jornada = await prisma.sessionType.create({ data: { name: "Mañana" } });

  const catIndividual = await prisma.category.create({
    data: { testTypeId: tipoIndividual.id, name: "Todo competidor", minAge: 5, maxAge: 99 },
  });
  const catRelevo = await prisma.category.create({
    data: { testTypeId: tipoRelevo.id, name: "Relevo libre", minAge: 5, maxAge: 99 },
  });
  /**
   * Segunda categoría de relevo, no por capricho: la base impone un relevo único
   * por (prueba de competencia, club, categoría), así que los dos equipos de un
   * mismo club tienen que competir en categorías distintas.
   */
  const catRelevo2 = await prisma.category.create({
    data: { testTypeId: tipoRelevo.id, name: "Relevo libre B", minAge: 5, maxAge: 99 },
  });

  const pruebaIndividual = await prisma.event.create({
    data: { testTypeId: tipoIndividual.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" },
  });
  const pruebaRelevo = await prisma.event.create({
    data: { testTypeId: tipoRelevo.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" },
  });

  // --- Competencia con una fecha, una jornada y dos pruebas ----------------
  const ahora = new Date();
  const competencia = await prisma.competition.create({
    data: {
      name: "Competencia de alcance",
      status: "open",
      registrationStartAt: new Date(ahora.getTime() - 86_400_000),
      registrationEndAt: new Date(ahora.getTime() + 86_400_000),
    },
  });
  ctx.competitionId = competencia.id;

  const fecha = await prisma.competitionDate.create({ data: { competitionId: competencia.id, date: ahora } });
  const sesion = await prisma.competitionSession.create({
    data: { competitionDateId: fecha.id, sessionTypeId: jornada.id, competitionId: competencia.id },
  });
  const ceIndividual = await prisma.competitionEvent.create({
    data: { competitionId: competencia.id, eventId: pruebaIndividual.id, competitionSessionId: sesion.id },
  });
  const ceRelevo = await prisma.competitionEvent.create({
    data: { competitionId: competencia.id, eventId: pruebaRelevo.id, competitionSessionId: sesion.id },
  });

  // --- Dos clubes, con su gente y sus cuentas ------------------------------
  const clubA = await createClub("Club A", "CLBA", "club_a");
  const clubB = await createClub("Club B", "CLBB", "club_b");
  ctx.clubAId = clubA.id;
  ctx.clubBId = clubB.id;

  const usuarioClubA = await createUser({ username: "club_a", roleNames: ["club"], clubId: clubA.id });
  await createUser({ username: "club_b", roleNames: ["club"], clubId: clubB.id });
  const admin = await createUser({ username: "admin_alcance", roleNames: ["admin"] });

  /** Cuatro nadadores por club: un relevo necesita equipo. */
  const nadadores: Record<string, string[]> = { A: [], B: [] };
  for (const [letra, clubId] of [["A", clubA.id], ["B", clubB.id]] as const) {
    for (let i = 1; i <= 4; i++) {
      const p = await createPerson({
        run: `${letra === "A" ? 3 : 4}000000${i}`,
        username: `nadador_${letra.toLowerCase()}${i}`,
        firstName: `Nadador ${letra}${i}`,
        gender: i % 2 === 0 ? "male" : "female",
      });
      await addActiveMembership(clubId, p.id, usuarioClubA.id);
      nadadores[letra]!.push(p.id);
    }
  }
  ctx.nadadorAId = nadadores.A![0]!;
  ctx.nadadorBId = nadadores.B![0]!;

  // Cuenta de NADADOR para el primero de cada club. La del club B existe para
  // poder demostrar que cada uno solo ve lo suyo, no "lo del club".
  await createUser({ username: "nadador_a1", roleNames: ["swimmer"], personId: ctx.nadadorAId });
  await createUser({ username: "nadador_b1", roleNames: ["swimmer"], personId: ctx.nadadorBId });

  // --- Filas sembradas: cada club, cada estado ----------------------------
  for (const [letra, clubId] of [["A", clubA.id], ["B", clubB.id]] as const) {
    for (const estado of ["confirmed", "cancelled"] as const) {
      /**
       * Individual del PRIMER nadador del club, y otra de un COMPAÑERO: así se
       * puede exigir que un nadador no vea ni siquiera las de su propio club.
       */
      const propia = await prisma.registration.create({
        data: {
          competitionEventId: ceIndividual.id,
          personId: nadadores[letra]![0]!,
          clubId,
          categoryId: catIndividual.id,
          status: estado,
          registeredByUserId: usuarioClubA.id,
          ...(estado === "cancelled" ? { cancelledByUserId: usuarioClubA.id, cancelledAt: new Date() } : {}),
        },
      });
      const deCompanero = await prisma.registration.create({
        data: {
          competitionEventId: ceIndividual.id,
          personId: nadadores[letra]![1]!,
          clubId,
          categoryId: catIndividual.id,
          status: estado,
          registeredByUserId: usuarioClubA.id,
          ...(estado === "cancelled" ? { cancelledByUserId: usuarioClubA.id, cancelledAt: new Date() } : {}),
        },
      });
      ctx.ind[`${letra}-${estado}-propia`] = propia.id;
      ctx.ind[`${letra}-${estado}-companero`] = deCompanero.id;

      /**
       * Relevo con los cuatro del club, y OTRO relevo del mismo club SIN el
       * primer nadador —lo forman los cuatro pero empezando por el segundo, así
       * que el 1 queda fuera—: es lo que permite exigir que un nadador solo vea
       * los equipos en los que participa, no todos los de su club.
       */
      const conEl1 = await prisma.relayRegistration.create({
        data: {
          competitionEventId: ceRelevo.id,
          clubId,
          categoryId: catRelevo.id,
          status: estado,
          registeredByUserId: usuarioClubA.id,
          ...(estado === "cancelled" ? { cancelledByUserId: usuarioClubA.id, cancelledAt: new Date() } : {}),
          members: {
            create: nadadores[letra]!.map((personId, i) => ({ personId, orderPosition: i + 1 })),
          },
        },
      });
      const sinEl1 = await prisma.relayRegistration.create({
        data: {
          competitionEventId: ceRelevo.id,
          clubId,
          categoryId: catRelevo2.id,
          status: estado,
          registeredByUserId: usuarioClubA.id,
          ...(estado === "cancelled" ? { cancelledByUserId: usuarioClubA.id, cancelledAt: new Date() } : {}),
          members: {
            // Solo tres integrantes, y ninguno es el nadador 1.
            create: nadadores[letra]!.slice(1).map((personId, i) => ({ personId, orderPosition: i + 1 })),
          },
        },
      });
      ctx.rel[`${letra}-${estado}-con1`] = conEl1.id;
      ctx.rel[`${letra}-${estado}-sin1`] = sinEl1.id;
    }
  }

  void admin;
  for (const username of ["admin_alcance", "club_a", "club_b", "nadador_a1", "nadador_b1"]) {
    ctx.tokens[username] = await login(username);
  }
});

afterAll(async () => {
  await app?.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

/**
 * Las cuatro exigencias se comprueban para CADA estado. El bucle no es adorno:
 * el punto del hallazgo es que pedir `cancelled` no puede ser un atajo para ver
 * lo ajeno, y eso solo se demuestra ejecutando lo mismo con los dos valores.
 */
for (const estado of ["confirmed", "cancelled"] as const) {
  describe(`GET /registrations — alcance con status=${estado}`, () => {
    it("A. un actor de CLUB sin clubId recibe solo el suyo, no todo lo que existe", async () => {
      const r = await listar("/registrations", ctx.tokens.club_a!, { status: estado });

      expect(r.status).toBe(200);
      expect(r.clubIds, "ni un solo club ajeno").toEqual([ctx.clubAId]);
      expect(r.ids).toEqual(ordenados(ctx.ind[`A-${estado}-propia`]!, ctx.ind[`A-${estado}-companero`]!));
      // Y no basta con que la interfaz no las pida: las del club B no llegan.
      expect(r.ids).not.toContain(ctx.ind[`B-${estado}-propia`]);
      expect(r.total, "el total tampoco cuenta las ajenas").toBe(2);
    });

    it("B. un actor de CLUB pidiendo OTRO club recibe 403", async () => {
      const r = await listar("/registrations", ctx.tokens.club_a!, { status: estado, clubId: ctx.clubBId });

      expect(r.status, "se rechaza, no se corrige en silencio").toBe(403);
      expect(JSON.stringify(r.body)).toMatch(/otro club/i);
    });

    it("C. un NADADOR solo obtiene lo suyo, ni siquiera lo de su club", async () => {
      const r = await listar("/registrations", ctx.tokens.nadador_a1!, { status: estado });

      expect(r.status).toBe(200);
      expect(r.ids).toEqual([ctx.ind[`A-${estado}-propia`]!]);
      expect(r.ids, "la de su compañero de club tampoco").not.toContain(ctx.ind[`A-${estado}-companero`]);
      expect(r.total).toBe(1);
    });

    it("C-bis. un NADADOR que envía el personId de OTRO sigue viendo solo lo suyo", async () => {
      /**
       * El acotamiento se aplica DESPUÉS de leer el `personId` de la consulta,
       * así que lo sobrescribe. Si se aplicara antes, este parámetro sería una
       * suplantación en un solo paso.
       */
      const r = await listar("/registrations", ctx.tokens.nadador_a1!, { status: estado, personId: ctx.nadadorBId });

      expect(r.status).toBe(200);
      expect(r.ids, "no puede ver las del nadador B").toEqual([ctx.ind[`A-${estado}-propia`]!]);
    });

    it("D. un ADMINISTRADOR ve varios clubes, y filtrado ve solo el pedido", async () => {
      const todos = await listar("/registrations", ctx.tokens.admin_alcance!, { status: estado });

      expect(todos.status).toBe(200);
      expect(todos.clubIds, "los dos clubes").toEqual(ordenados(ctx.clubAId, ctx.clubBId));
      expect(todos.ids).toEqual(
        ordenados(
          ctx.ind[`A-${estado}-propia`]!,
          ctx.ind[`A-${estado}-companero`]!,
          ctx.ind[`B-${estado}-propia`]!,
          ctx.ind[`B-${estado}-companero`]!
        )
      );

      const soloB = await listar("/registrations", ctx.tokens.admin_alcance!, { status: estado, clubId: ctx.clubBId });
      expect(soloB.clubIds).toEqual([ctx.clubBId]);
      expect(soloB.ids).toEqual(ordenados(ctx.ind[`B-${estado}-propia`]!, ctx.ind[`B-${estado}-companero`]!));
    });
  });

  describe(`GET /relay-registrations — alcance con status=${estado}`, () => {
    it("A. un actor de CLUB sin clubId recibe solo los suyos", async () => {
      const r = await listar("/relay-registrations", ctx.tokens.club_a!, { status: estado });

      expect(r.status).toBe(200);
      expect(r.clubIds).toEqual([ctx.clubAId]);
      expect(r.ids).toEqual(ordenados(ctx.rel[`A-${estado}-con1`]!, ctx.rel[`A-${estado}-sin1`]!));
      expect(r.ids).not.toContain(ctx.rel[`B-${estado}-con1`]);
      expect(r.total).toBe(2);
    });

    it("B. un actor de CLUB pidiendo OTRO club recibe 403", async () => {
      const r = await listar("/relay-registrations", ctx.tokens.club_a!, { status: estado, clubId: ctx.clubBId });

      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).toMatch(/otro club/i);
    });

    it("C. un NADADOR solo obtiene los relevos en los que PARTICIPA", async () => {
      const r = await listar("/relay-registrations", ctx.tokens.nadador_a1!, { status: estado });

      expect(r.status).toBe(200);
      expect(r.ids, "solo el equipo que lo incluye").toEqual([ctx.rel[`A-${estado}-con1`]!]);
      expect(r.ids, "el otro equipo de su club no lo incluye a él").not.toContain(ctx.rel[`A-${estado}-sin1`]);
      expect(r.ids).not.toContain(ctx.rel[`B-${estado}-con1`]);
      expect(r.total).toBe(1);
    });

    it("D. un ADMINISTRADOR ve varios clubes, y filtrado ve solo el pedido", async () => {
      const todos = await listar("/relay-registrations", ctx.tokens.admin_alcance!, { status: estado });

      expect(todos.status).toBe(200);
      expect(todos.clubIds).toEqual(ordenados(ctx.clubAId, ctx.clubBId));
      expect(todos.ids).toEqual(
        ordenados(
          ctx.rel[`A-${estado}-con1`]!,
          ctx.rel[`A-${estado}-sin1`]!,
          ctx.rel[`B-${estado}-con1`]!,
          ctx.rel[`B-${estado}-sin1`]!
        )
      );

      const soloB = await listar("/relay-registrations", ctx.tokens.admin_alcance!, { status: estado, clubId: ctx.clubBId });
      expect(soloB.clubIds).toEqual([ctx.clubBId]);
      expect(soloB.ids).toEqual(ordenados(ctx.rel[`B-${estado}-con1`]!, ctx.rel[`B-${estado}-sin1`]!));
    });
  });
}

/**
 * Y la propiedad que ata las dos mitades: pedir las canceladas NO amplía nada.
 * Sin filtro de estado, cada actor ve exactamente la unión de lo que ve con cada
 * uno de los dos, y nada más.
 */
describe("pedir un estado no ensancha el alcance", () => {
  it("sin filtro, un club ve la unión de sus confirmadas y sus canceladas, y solo eso", async () => {
    const r = await listar("/registrations", ctx.tokens.club_a!, {});

    expect(r.clubIds).toEqual([ctx.clubAId]);
    expect(r.ids).toEqual(
      ordenados(
        ctx.ind["A-confirmed-propia"]!,
        ctx.ind["A-confirmed-companero"]!,
        ctx.ind["A-cancelled-propia"]!,
        ctx.ind["A-cancelled-companero"]!
      )
    );
  });

  it("sin filtro, un nadador ve sus dos individuales y sus dos relevos, y solo eso", async () => {
    const ind = await listar("/registrations", ctx.tokens.nadador_a1!, {});
    expect(ind.ids).toEqual(ordenados(ctx.ind["A-confirmed-propia"]!, ctx.ind["A-cancelled-propia"]!));

    const rel = await listar("/relay-registrations", ctx.tokens.nadador_a1!, {});
    expect(rel.ids).toEqual(ordenados(ctx.rel["A-confirmed-con1"]!, ctx.rel["A-cancelled-con1"]!));
  });
});
