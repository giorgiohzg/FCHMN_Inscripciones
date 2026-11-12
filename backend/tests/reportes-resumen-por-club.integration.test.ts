/**
 * Reportes: resumen de inscripciones por club y opciones del selector de clubes.
 *
 * Por HTTP (`app.inject`) contra la base DESECHABLE: es la única forma de comprobar que
 * quien llame directamente a la API no se salta la restricción a administración.
 * Todos los datos son SINTÉTICOS.
 *
 * Escenario de la competencia principal (cifras esperadas por club):
 *
 *   Club Ambos          individuales y relevos
 *     a1 (V)  ind1, ind2, relevo1, relevo2   ← repetida: cuenta UNA vez en el club
 *     a2 (D)  ind1, relevo1
 *     a3 (V)  relevo1, relevo2
 *     a4 (D)  relevo1, relevo2
 *     a5 (D)  relevo2                         ← solo relevos
 *     a6 (V)  ind1 CANCELADA, relevo CANCELADO ← no cuenta
 *     → 5 nadadores (2 V, 3 D), 3 individuales, 2 relevos (mixtos), 5 pruebas
 *
 *   Club Solo Individuales
 *     b1 (D) ind1;  b2 (V) ind1, ind2;  b3 (V) ind1, con membresía ACTIVA en «Club Sin Inscritos»
 *     → 3 nadadores (2 V, 1 D), 4 individuales, 0 relevos, 4 pruebas
 *
 *   Club Solo Relevos
 *     c1..c4 (V, V, D, D) relevo1
 *     → 4 nadadores (2 V, 2 D), 0 individuales, 1 relevo, 1 prueba
 *
 *   «Club Homónimo» ×2, mismo nombre y distinto id
 *     h1: d1 (V) ind1                 → 1 nadador (1 V), 1 individual
 *     h2: d2 (D) ind1, d3 (D) ind2    → 2 nadadores (2 D), 2 individuales
 *
 *   Club Sin Inscritos (tiene miembros, sin inscripciones aquí; sí en OTRA competencia) → fuera
 *   Club Solo Canceladas (solo una individual cancelada)                               → fuera
 *
 *   Totales: 15 nadadores (7 V, 8 D), 10 individuales, 3 relevos, 13 pruebas.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addActiveMembership, addClubStaff, TEST_PASSWORD } from "./helpers/seedRbac";

let app: FastifyInstance;

const ctx = {
  competitionId: "",
  competenciaVaciaId: "",
  otraCompetenciaId: "",
  club: {} as Record<string, string>,
  tokens: {} as Record<string, string>,
  adminCombinadoUserId: "",
  /** RUN y nombres sembrados, para comprobar que el resumen no los entrega. */
  runs: [] as string[],
  nombres: [] as string[],
};

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username} devolvió ${res.statusCode}: ${res.body}`);
  return res.json().accessToken as string;
}

const resumen = (token: string | null, competitionId = ctx.competitionId) =>
  app.inject({ method: "GET", url: `/reports/clubs-summary?competitionId=${competitionId}`, headers: token ? auth(token) : {} });
const opciones = (token: string | null, competitionId = ctx.competitionId) =>
  app.inject({ method: "GET", url: `/reports/registrations/clubs?competitionId=${competitionId}`, headers: token ? auth(token) : {} });

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();

  // --- Catálogos mínimos ---------------------------------------------------
  const tipoIndividual = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
  const tipoRelevo = await prisma.testType.create({ data: { name: "Relevo 4x", swimmersCount: 4 } });
  const distancia = await prisma.distance.create({ data: { meters: 50 } });
  const libre = await prisma.stroke.create({ data: { name: "Libre" } });
  const espalda = await prisma.stroke.create({ data: { name: "Espalda" } });
  const jornada = await prisma.sessionType.create({ data: { name: "Mañana" } });
  const catInd = await prisma.category.create({ data: { testTypeId: tipoIndividual.id, name: "Todo competidor", minAge: 5, maxAge: 99 } });
  const catRel = await prisma.category.create({ data: { testTypeId: tipoRelevo.id, name: "Relevo libre", minAge: 5, maxAge: 99 } });

  const evInd1 = await prisma.event.create({ data: { testTypeId: tipoIndividual.id, distanceId: distancia.id, strokeId: libre.id, gender: "mixed" } });
  const evInd2 = await prisma.event.create({ data: { testTypeId: tipoIndividual.id, distanceId: distancia.id, strokeId: espalda.id, gender: "mixed" } });
  // Relevos MIXTOS: el género de la prueba no debe convertir a nadie en un tercer grupo.
  const evRel1 = await prisma.event.create({ data: { testTypeId: tipoRelevo.id, distanceId: distancia.id, strokeId: libre.id, gender: "mixed" } });
  const evRel2 = await prisma.event.create({ data: { testTypeId: tipoRelevo.id, distanceId: distancia.id, strokeId: espalda.id, gender: "mixed" } });

  const piscina = await prisma.pool.create({ data: { name: "Piscina sintética", courseLength: "long_50m" } });

  async function competencia(nombre: string, status: "open" | "draft") {
    const ahora = new Date();
    const c = await prisma.competition.create({
      data: {
        name: nombre,
        status,
        poolId: piscina.id,
        registrationStartAt: new Date(ahora.getTime() - 86_400_000),
        registrationEndAt: new Date(ahora.getTime() + 86_400_000),
      },
    });
    const fecha = await prisma.competitionDate.create({ data: { competitionId: c.id, date: ahora } });
    const sesion = await prisma.competitionSession.create({ data: { competitionDateId: fecha.id, sessionTypeId: jornada.id, competitionId: c.id } });
    const ce = async (eventId: string, displayOrder: number) =>
      (await prisma.competitionEvent.create({ data: { competitionId: c.id, eventId, competitionSessionId: sesion.id, displayOrder } })).id;
    return { id: c.id, ind1: await ce(evInd1.id, 1), ind2: await ce(evInd2.id, 2), rel1: await ce(evRel1.id, 3), rel2: await ce(evRel2.id, 4) };
  }

  const principal = await competencia("Competencia del resumen", "open");
  ctx.competitionId = principal.id;
  // Oculta (borrador) y sin inscripciones: administración la puede consultar.
  ctx.competenciaVaciaId = (await competencia("Competencia vacía", "draft")).id;
  const otra = await competencia("Otra competencia", "open");
  ctx.otraCompetenciaId = otra.id;

  // --- Clubes y cuentas ----------------------------------------------------
  const nuevoClub = async (clave: string, nombre: string, code: string) => {
    const c = await createClub(nombre, code, `club_${clave}`);
    ctx.club[clave] = c.id;
    return c.id;
  };
  await nuevoClub("ambos", "Club Ambos", "CAMB");
  await nuevoClub("individuales", "Club Solo Individuales", "CIND");
  await nuevoClub("relevos", "Club Solo Relevos", "CREL");
  await nuevoClub("homonimo1", "Club Homónimo", "CHO1");
  await nuevoClub("homonimo2", "Club Homónimo", "CHO2");
  await nuevoClub("sinInscritos", "Club Sin Inscritos", "CSIN");
  await nuevoClub("canceladas", "Club Solo Canceladas", "CCAN");

  const admin = await createUser({ username: "admin_resumen", roleNames: ["admin"] });
  const registrador = admin.id;
  await createUser({ username: "club_ambos", roleNames: ["club"], clubId: ctx.club.ambos });

  // --- Personas -------------------------------------------------------------
  let correlativo = 0;
  const persona = async (clave: string, gender: "male" | "female", clubDeMembresia: string) => {
    correlativo++;
    const run = `${80000000 + correlativo}`;
    const p = await createPerson({ run, username: `nadador_${clave}`, firstName: `Sintetico${clave.toUpperCase()}`, gender });
    await addActiveMembership(clubDeMembresia, p.id, registrador);
    ctx.runs.push(run);
    ctx.nombres.push(p.fullName);
    return p.id;
  };

  const individual = (competitionEventId: string, personId: string, clubId: string, status: "confirmed" | "cancelled" = "confirmed") =>
    prisma.registration.create({
      data: {
        competitionEventId,
        personId,
        clubId,
        categoryId: catInd.id,
        status,
        registeredByUserId: registrador,
        ...(status === "cancelled" ? { cancelledByUserId: registrador, cancelledAt: new Date() } : {}),
      },
    });
  const relevo = (competitionEventId: string, clubId: string, integrantes: string[], status: "confirmed" | "cancelled" = "confirmed") =>
    prisma.relayRegistration.create({
      data: {
        competitionEventId,
        clubId,
        categoryId: catRel.id,
        status,
        registeredByUserId: registrador,
        ...(status === "cancelled" ? { cancelledByUserId: registrador, cancelledAt: new Date() } : {}),
        members: { create: integrantes.map((personId, i) => ({ personId, orderPosition: i + 1 })) },
      },
    });

  // Club Ambos
  const A = ctx.club.ambos!;
  const a1 = await persona("a1", "male", A);
  const a2 = await persona("a2", "female", A);
  const a3 = await persona("a3", "male", A);
  const a4 = await persona("a4", "female", A);
  const a5 = await persona("a5", "female", A);
  const a6 = await persona("a6", "male", A);
  await individual(principal.ind1, a1, A);
  await individual(principal.ind2, a1, A);
  await individual(principal.ind1, a2, A);
  await individual(principal.ind1, a6, A, "cancelled");
  await relevo(principal.rel1, A, [a1, a2, a3, a4]);
  await relevo(principal.rel2, A, [a1, a3, a4, a5]);
  await relevo(principal.rel1, A, [a6, a2, a3, a4], "cancelled");

  // Club Solo Individuales (b3 con membresía en otro club: cuenta donde se inscribió)
  const B = ctx.club.individuales!;
  const b1 = await persona("b1", "female", B);
  const b2 = await persona("b2", "male", B);
  const b3 = await persona("b3", "male", ctx.club.sinInscritos!);
  await individual(principal.ind1, b1, B);
  await individual(principal.ind1, b2, B);
  await individual(principal.ind2, b2, B);
  await individual(principal.ind1, b3, B);

  // Club Solo Relevos
  const C = ctx.club.relevos!;
  const cs = [await persona("c1", "male", C), await persona("c2", "male", C), await persona("c3", "female", C), await persona("c4", "female", C)];
  await relevo(principal.rel1, C, cs);

  // Clubes homónimos
  const H1 = ctx.club.homonimo1!;
  const H2 = ctx.club.homonimo2!;
  await individual(principal.ind1, await persona("d1", "male", H1), H1);
  await individual(principal.ind1, await persona("d2", "female", H2), H2);
  await individual(principal.ind2, await persona("d3", "female", H2), H2);

  // Club Solo Canceladas
  const F = ctx.club.canceladas!;
  await individual(principal.ind1, await persona("f1", "female", F), F, "cancelled");

  // Club Sin Inscritos: SÍ tiene inscripciones, pero en OTRA competencia.
  const E = ctx.club.sinInscritos!;
  await individual(otra.ind1, await persona("e1", "male", E), E);

  // --- Cuentas por rol -----------------------------------------------------
  ctx.tokens.admin = await login("admin_resumen");
  ctx.tokens.club = await login("club_ambos");

  for (const [clave, rol] of [
    ["delegado", "delegate"],
    ["entrenador", "coach"],
    ["representante", "legal_representative"],
  ] as const) {
    const p = await createPerson({ run: `${81000000 + clave.length}`, username: `staff_${clave}`, firstName: `Staff${clave}`, gender: "female", roles: [] });
    await addClubStaff(A, p.id, rol);
    await createUser({ username: `staff_${clave}`, roleNames: [rol], personId: p.id });
    ctx.tokens[clave] = await login(`staff_${clave}`);
  }

  await createUser({ username: "nadador_a1", roleNames: ["swimmer"], personId: a1 });
  ctx.tokens.nadador = await login("nadador_a1");

  // Administración COMBINADA con un rol de club (persona que además es delegada).
  const combinada = await createPerson({ run: "82000001", username: "admin_delegada", firstName: "Combinada", gender: "female", roles: [] });
  await addClubStaff(C, combinada.id, "delegate");
  const usuarioCombinado = await createUser({ username: "admin_delegada", roleNames: ["admin", "delegate"], personId: combinada.id });
  ctx.adminCombinadoUserId = usuarioCombinado.id;
  ctx.tokens.adminCombinado = await login("admin_delegada");
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("acceso: exclusivo de administración, verificado en el servidor", () => {
  it.each([
    ["resumen", resumen],
    ["opciones del selector", opciones],
  ] as const)("%s sin autenticación → 401", async (_n, pedir) => {
    expect((await pedir(null)).statusCode).toBe(401);
  });

  it.each(["club", "delegado", "entrenador", "representante", "nadador"])("rol %s → 403 en el resumen y en las opciones, aunque tenga reports:read", async (clave) => {
    const r1 = await resumen(ctx.tokens[clave]!);
    const r2 = await opciones(ctx.tokens[clave]!);
    expect(r1.statusCode).toBe(403);
    expect(r2.statusCode).toBe(403);
    // La denegación no adelanta ninguna cifra ni nombre de club.
    expect(r1.body).not.toContain("Club Ambos");
    expect(r2.body).not.toContain("Club Ambos");
  });

  it("administración sola → 200", async () => {
    expect((await resumen(ctx.tokens.admin!)).statusCode).toBe(200);
    expect((await opciones(ctx.tokens.admin!)).statusCode).toBe(200);
  });

  it("administración combinada con otro rol → 200, con el conjunto completo (no acotado a su club)", async () => {
    const res = await resumen(ctx.tokens.adminCombinado!);
    expect(res.statusCode).toBe(200);
    expect(res.json().clubs).toHaveLength(5);
  });

  it("parámetros inválidos → 400; competencia inexistente → 404", async () => {
    expect((await app.inject({ method: "GET", url: "/reports/clubs-summary", headers: auth(ctx.tokens.admin!) })).statusCode).toBe(400);
    expect((await resumen(ctx.tokens.admin!, "no-es-un-uuid")).statusCode).toBe(400);
    expect((await resumen(ctx.tokens.admin!, "00000000-0000-0000-0000-000000000000")).statusCode).toBe(404);
    expect((await opciones(ctx.tokens.admin!, "00000000-0000-0000-0000-000000000000")).statusCode).toBe(404);
  });
});

describe("resumen: reglas de conteo", () => {
  type Fila = { clubId: string; clubName: string; varones: number; damas: number; totalNadadores: number; pruebasIndividuales: number; relevos: number; totalPruebas: number };
  let cuerpo: { competitionId: string; competitionName: string; clubs: Fila[]; totales: Omit<Fila, "clubId" | "clubName"> };
  const fila = (clave: string) => cuerpo.clubs.find((f) => f.clubId === ctx.club[clave]);

  beforeAll(async () => {
    const res = await resumen(ctx.tokens.admin!);
    expect(res.statusCode).toBe(200);
    cuerpo = res.json();
  });

  it("solo los clubes con al menos una inscripción confirmada de ESTA competencia", () => {
    expect(cuerpo.competitionName).toBe("Competencia del resumen");
    expect(cuerpo.clubs.map((f) => f.clubId).sort()).toEqual(
      [ctx.club.ambos, ctx.club.individuales, ctx.club.relevos, ctx.club.homonimo1, ctx.club.homonimo2].sort()
    );
    expect(fila("sinInscritos"), "club sin inscripciones en esta competencia").toBeUndefined();
    expect(fila("canceladas"), "club con solo canceladas").toBeUndefined();
  });

  it("club con individuales y relevos: persona repetida una vez, canceladas fuera, solo-relevos incluida, equipos una vez", () => {
    expect(fila("ambos")).toEqual({
      clubId: ctx.club.ambos,
      clubName: "Club Ambos",
      varones: 2,
      damas: 3,
      totalNadadores: 5,
      pruebasIndividuales: 3,
      relevos: 2,
      totalPruebas: 5,
    });
  });

  it("club solo con individuales: cada inscripción cuenta, y se usa el club de la inscripción, no la membresía", () => {
    expect(fila("individuales")).toMatchObject({ varones: 2, damas: 1, totalNadadores: 3, pruebasIndividuales: 4, relevos: 0, totalPruebas: 4 });
  });

  it("club solo con relevos: integrantes por su sexo y el equipo contado una vez", () => {
    expect(fila("relevos")).toMatchObject({ varones: 2, damas: 2, totalNadadores: 4, pruebasIndividuales: 0, relevos: 1, totalPruebas: 1 });
  });

  it("clubes homónimos: dos filas separadas por id, con el mismo nombre", () => {
    expect(fila("homonimo1")).toMatchObject({ clubName: "Club Homónimo", varones: 1, damas: 0, totalNadadores: 1, pruebasIndividuales: 1, relevos: 0 });
    expect(fila("homonimo2")).toMatchObject({ clubName: "Club Homónimo", varones: 0, damas: 2, totalNadadores: 2, pruebasIndividuales: 2, relevos: 0 });
  });

  it("varones + damas = total de nadadores en cada fila, y total de pruebas = individuales + relevos", () => {
    for (const f of cuerpo.clubs) {
      expect(f.varones + f.damas, f.clubName).toBe(f.totalNadadores);
      expect(f.pruebasIndividuales + f.relevos, f.clubName).toBe(f.totalPruebas);
    }
  });

  it("totales globales = suma de las columnas de todas las filas", () => {
    expect(cuerpo.totales).toEqual({ varones: 7, damas: 8, totalNadadores: 15, pruebasIndividuales: 10, relevos: 3, totalPruebas: 13 });
    const suma = (k: keyof typeof cuerpo.totales) => cuerpo.clubs.reduce((s, f) => s + f[k], 0);
    for (const k of Object.keys(cuerpo.totales) as (keyof typeof cuerpo.totales)[]) expect(cuerpo.totales[k], k).toBe(suma(k));
  });

  it("orden por nombre del club, con los homónimos desempatados por id", () => {
    const nombres = cuerpo.clubs.map((f) => f.clubName);
    expect(nombres).toEqual(["Club Ambos", "Club Homónimo", "Club Homónimo", "Club Solo Individuales", "Club Solo Relevos"]);
    const [h1, h2] = cuerpo.clubs.filter((f) => f.clubName === "Club Homónimo");
    expect(h1!.clubId < h2!.clubId).toBe(true);
  });

  it("sin datos personales: ni RUN, ni nombres de personas, ni fechas de nacimiento", () => {
    const texto = JSON.stringify(cuerpo);
    for (const run of ctx.runs) expect(texto).not.toContain(run);
    for (const nombre of ctx.nombres) expect(texto).not.toContain(nombre);
    expect(texto).not.toMatch(/birth|nacimiento|\brun\b|person/i);
    for (const f of cuerpo.clubs) expect(Object.keys(f).sort()).toEqual(["clubId", "clubName", "damas", "pruebasIndividuales", "relevos", "totalNadadores", "totalPruebas", "varones"]);
  });

  it("competencia sin inscripciones (y oculta): 200 con filas vacías y totales en cero", async () => {
    const res = await resumen(ctx.tokens.admin!, ctx.competenciaVaciaId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ clubs: [], totales: { varones: 0, damas: 0, totalNadadores: 0, pruebasIndividuales: 0, relevos: 0, totalPruebas: 0 } });
  });
});

describe("opciones del selector de clubes del reporte detallado", () => {
  it("clubes con al menos una confirmada (individual o relevo), incluidos homónimos y el de solo relevos", async () => {
    const res = await opciones(ctx.tokens.admin!);
    expect(res.statusCode).toBe(200);
    const clubs = res.json().clubs as { id: string; name: string }[];
    expect(clubs.map((c) => c.id).sort()).toEqual([ctx.club.ambos, ctx.club.individuales, ctx.club.relevos, ctx.club.homonimo1, ctx.club.homonimo2].sort());
    expect(Object.keys(clubs[0]!).sort()).toEqual(["id", "name"]);
  });

  it("cambian con la competencia", async () => {
    const otra = await opciones(ctx.tokens.admin!, ctx.otraCompetenciaId);
    expect(otra.json().clubs.map((c: { id: string }) => c.id)).toEqual([ctx.club.sinInscritos]);
    const vacia = await opciones(ctx.tokens.admin!, ctx.competenciaVaciaId);
    expect(vacia.json().clubs).toEqual([]);
  });
});

describe("regresiones de alcance en Reportes y Team Manager", () => {
  it("la cuenta de club sigue acotada a su club en el reporte detallado", async () => {
    const propio = await app.inject({ method: "GET", url: `/reports/registrations?competitionId=${ctx.competitionId}`, headers: auth(ctx.tokens.club!) });
    expect(propio.statusCode).toBe(200);
    expect(propio.json().groupedByClub.map((g: { clubName: string }) => g.clubName)).toEqual(["Club Ambos"]);

    const ajeno = await app.inject({
      method: "GET",
      url: `/reports/registrations?competitionId=${ctx.competitionId}&clubId=${ctx.club.relevos}`,
      headers: auth(ctx.tokens.club!),
    });
    expect(ajeno.statusCode).toBe(403);
  });

  it("el nadador sigue viendo solo su reporte personal", async () => {
    const res = await app.inject({ method: "GET", url: `/reports/registrations?competitionId=${ctx.competitionId}`, headers: auth(ctx.tokens.nadador!) });
    expect(res.statusCode).toBe(200);
    const grupos = res.json().groupedByClub as { swimmers: unknown[] }[];
    expect(grupos.flatMap((g) => g.swimmers)).toHaveLength(1);
  });

  it("Team Manager: administración descarga el ZIP de un club del resumen; la cuenta de club no puede pedir otro club", async () => {
    const zip = await app.inject({
      method: "GET",
      url: `/export/team-manager/zip?competitionId=${ctx.competitionId}&clubId=${ctx.club.homonimo2}`,
      headers: auth(ctx.tokens.admin!),
    });
    expect(zip.statusCode, zip.body.slice(0, 300)).toBe(200);
    expect(zip.headers["content-type"]).toBe("application/zip");

    const ajeno = await app.inject({
      method: "GET",
      url: `/export/team-manager/zip?competitionId=${ctx.competitionId}&clubId=${ctx.club.relevos}`,
      headers: auth(ctx.tokens.club!),
    });
    expect(ajeno.statusCode).toBe(403);
  });
});

describe("autorización VIGENTE: retirar el rol surte efecto con el mismo token", () => {
  it("la persona combinada pierde administración → 403 en el resumen y en las opciones", async () => {
    const rolAdmin = await prisma.role.findUniqueOrThrow({ where: { name: "admin" } });
    await prisma.userRole.deleteMany({ where: { userId: ctx.adminCombinadoUserId, roleId: rolAdmin.id } });

    expect((await resumen(ctx.tokens.adminCombinado!)).statusCode).toBe(403);
    expect((await opciones(ctx.tokens.adminCombinado!)).statusCode).toBe(403);
  });
});
