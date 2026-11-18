/**
 * PANEL DE ADMINISTRACIÓN — totales por género (`dashboard.service.ts`), contra la base desechable.
 *
 * Resumen general: «Nadadores registrados» conserva su universo (personas no eliminadas con rol de
 * nadador activo) y se desglosa en varones y damas que suman el total.
 *
 * Por competencia: PERSONAS distintas con al menos una inscripción individual confirmada o
 * integrando un relevo confirmado, por el sexo de la persona:
 *  - quien tiene varias pruebas cuenta una vez; quien nada individual y relevo, una vez;
 *  - quien solo nada relevos cuenta; lo cancelado no cuenta;
 *  - una prueba mixta no crea una tercera categoría;
 *  - una competencia vacía da ceros;
 *  - las columnas de inscripciones y equipos siguen contando inscripciones;
 *  - el conjunto coincide con el de los cupos (`readCapacityUsage`).
 *
 * Datos sintéticos. Solo contra la base desechable (ver `helpers/testDb.ts`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addClubStaff, TEST_PASSWORD } from "./helpers/seedRbac";
import { readCapacityUsage } from "../src/modules/competitions/competition-capacity.service";

let app: FastifyInstance;
const DIA = 86_400_000;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
let adminToken: string;
let delegadoToken: string;
let adminId: string;
let clubId: string;
let cat: { ind: string; rel: string; evInd: string; evInd2: string; evRel: string; tipoJornada: string };

async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username} devolvió ${res.statusCode}`);
  return res.json().accessToken as string;
}
const stats = async () => {
  const r = await app.inject({ method: "GET", url: "/dashboard/stats", headers: auth(adminToken) });
  expect(r.statusCode).toBe(200);
  return r.json();
};

async function persona(i: number, gender: "male" | "female", opciones: { nadador?: boolean; eliminada?: boolean; rolInactivo?: boolean } = {}) {
  const p = await createPerson({ run: String(30000500 + i), username: `p_dash_${i}`, firstName: `Sintético${i}`, gender, roles: opciones.nadador === false ? [] : ["swimmer"] });
  if (opciones.eliminada) await prisma.person.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
  if (opciones.rolInactivo) await prisma.personRole.updateMany({ where: { personId: p.id, roleType: "swimmer" }, data: { active: false } });
  return p.id;
}

async function competencia(nombre: string) {
  const ahora = Date.now();
  const c = await prisma.competition.create({ data: { name: nombre, status: "open", registrationStartAt: new Date(ahora - DIA), registrationEndAt: new Date(ahora + 10 * DIA) } });
  const fecha = await prisma.competitionDate.create({ data: { competitionId: c.id, date: new Date("2030-03-01T00:00:00.000Z") } });
  const jornada = await prisma.competitionSession.create({ data: { competitionDateId: fecha.id, sessionTypeId: cat.tipoJornada, competitionId: c.id } });
  const crear = (eventId: string, displayOrder: number) => prisma.competitionEvent.create({ data: { competitionId: c.id, eventId, competitionSessionId: jornada.id, displayOrder } });
  return { id: c.id, ind: (await crear(cat.evInd, 1)).id, ind2: (await crear(cat.evInd2, 2)).id, rel: (await crear(cat.evRel, 3)).id };
}

const individual = (competitionEventId: string, personId: string, status: "confirmed" | "cancelled" = "confirmed") =>
  prisma.registration.create({ data: { competitionEventId, personId, clubId, categoryId: cat.ind, registeredByUserId: adminId, status } });
const relevo = (competitionEventId: string, personas: string[], status: "confirmed" | "cancelled" = "confirmed") =>
  prisma.relayRegistration.create({
    data: { competitionEventId, clubId, categoryId: cat.rel, registeredByUserId: adminId, status, members: { create: personas.map((personId, j) => ({ personId, orderPosition: j + 1 })) } },
  });

beforeAll(async () => {
  app = await buildServer();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_dash", roleNames: ["admin"] });
  adminId = admin.id;
  const club = await createClub("Club Panel Sintético", "PAN");
  clubId = club.id;
  const delegado = await createPerson({ run: "30000599", username: "deleg_dash", firstName: "Delegado", gender: "male", roles: ["delegate"] });
  await addClubStaff(club.id, delegado.id, "delegate");
  await createUser({ username: "deleg_dash", roleNames: ["delegate"], personId: delegado.id });

  const tInd = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
  const tRel = await prisma.testType.create({ data: { name: "Relevo", swimmersCount: 4 } });
  const d50 = await prisma.distance.create({ data: { meters: 50 } });
  const d200 = await prisma.distance.create({ data: { meters: 200 } });
  const libre = await prisma.stroke.create({ data: { name: "Libre" } });
  const espalda = await prisma.stroke.create({ data: { name: "Espalda" } });
  const tipoJornada = await prisma.sessionType.create({ data: { name: "Mañana" } });
  cat = {
    ind: (await prisma.category.create({ data: { testTypeId: tInd.id, name: "Master sintética", minAge: 18, maxAge: 99 } })).id,
    rel: (await prisma.category.create({ data: { testTypeId: tRel.id, name: "Relevo sintético", minAge: 100, maxAge: 500 } })).id,
    evInd: (await prisma.event.create({ data: { testTypeId: tInd.id, distanceId: d50.id, strokeId: libre.id, gender: "female" } })).id,
    evInd2: (await prisma.event.create({ data: { testTypeId: tInd.id, distanceId: d50.id, strokeId: espalda.id, gender: "male" } })).id,
    // Relevo MIXTO: sus integrantes cuentan por su propio sexo.
    evRel: (await prisma.event.create({ data: { testTypeId: tRel.id, distanceId: d200.id, strokeId: libre.id, gender: "mixed" } })).id,
    tipoJornada: tipoJornada.id,
  };
  adminToken = await login("admin_dash");
  delegadoToken = await login("deleg_dash");
});

afterAll(async () => {
  await app.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("resumen general", () => {
  it("conserva el universo de «Nadadores registrados» y lo desglosa en varones y damas", async () => {
    await persona(1, "male");
    await persona(2, "male");
    await persona(3, "female");
    await persona(4, "female", { eliminada: true }); // no cuenta
    await persona(5, "male", { rolInactivo: true }); // no cuenta
    await persona(6, "female", { nadador: false }); // no es nadadora: no cuenta
    const s = await stats();
    // El delegado sembrado tampoco es nadador.
    expect([s.swimmerCount, s.maleSwimmerCount, s.femaleSwimmerCount]).toEqual([3, 2, 1]);
    expect(s.maleSwimmerCount + s.femaleSwimmerCount).toBe(s.swimmerCount);
  });

  it("es exclusivo de administración", async () => {
    expect((await app.inject({ method: "GET", url: "/dashboard/stats", headers: auth(delegadoToken) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/dashboard/stats" })).statusCode).toBe(401);
  });
});

describe("por competencia", () => {
  it("cuenta personas distintas por su sexo, sin duplicar, con quien solo nada relevos", async () => {
    const h1 = await persona(1, "male");
    const h2 = await persona(2, "male");
    const h3 = await persona(3, "male");
    const m1 = await persona(4, "female");
    const m2 = await persona(5, "female");
    const m3 = await persona(6, "female");
    const soloCancelada = await persona(7, "female");
    const c = await competencia("Copa Totales sintética");

    await individual(c.ind, h1); // h1: dos pruebas individuales
    await individual(c.ind2, h1);
    await individual(c.ind, m1); // m1: individual y relevo
    await individual(c.ind, soloCancelada, "cancelled"); // cancelada: no cuenta
    await relevo(c.rel, [h1, m1, h2, m2]); // relevo mixto confirmado; h2 y m2 solo nadan relevos
    await relevo(c.rel, [h3, m3, h2, m2], "cancelled"); // cancelado: h3 y m3 no cuentan

    const s = await stats();
    const fila = s.registrationsByCompetition.find((x: { competitionId: string }) => x.competitionId === c.id);
    expect(fila).toMatchObject({ maleSwimmersCount: 2, femaleSwimmersCount: 2, swimmersCount: 4, individualCount: 3, relayTeamsCount: 1 });
    expect(fila.maleSwimmersCount + fila.femaleSwimmersCount).toBe(fila.swimmersCount);

    // El mismo conjunto que los cupos.
    const usoCupos = await readCapacityUsage(prisma, c.id);
    expect(usoCupos.swimmerIds.size).toBe(fila.swimmersCount);
    expect([...usoCupos.swimmerIds].sort()).toEqual([h1, h2, m1, m2].sort());
  });

  it("una competencia vacía da ceros y no mezcla personas de otra competencia", async () => {
    const h1 = await persona(1, "male");
    const llena = await competencia("Copa con inscritos sintética");
    const vacia = await competencia("Copa vacía sintética");
    await individual(llena.ind, h1);

    const s = await stats();
    const filaVacia = s.registrationsByCompetition.find((x: { competitionId: string }) => x.competitionId === vacia.id);
    const filaLlena = s.registrationsByCompetition.find((x: { competitionId: string }) => x.competitionId === llena.id);
    expect(filaVacia).toMatchObject({ swimmersCount: 0, maleSwimmersCount: 0, femaleSwimmersCount: 0, individualCount: 0, relayTeamsCount: 0 });
    expect(filaLlena).toMatchObject({ swimmersCount: 1, maleSwimmersCount: 1, femaleSwimmersCount: 0, individualCount: 1 });
  });

  it("una persona inscrita en dos competencias cuenta en cada una", async () => {
    const m1 = await persona(1, "female");
    const a = await competencia("Copa A sintética");
    const b = await competencia("Copa B sintética");
    await individual(a.ind, m1);
    await relevo(b.rel, [m1, await persona(2, "male"), await persona(3, "male"), await persona(4, "female")]);

    const s = await stats();
    const fa = s.registrationsByCompetition.find((x: { competitionId: string }) => x.competitionId === a.id);
    const fb = s.registrationsByCompetition.find((x: { competitionId: string }) => x.competitionId === b.id);
    expect([fa.swimmersCount, fa.femaleSwimmersCount, fa.maleSwimmersCount]).toEqual([1, 1, 0]);
    expect([fb.swimmersCount, fb.femaleSwimmersCount, fb.maleSwimmersCount]).toEqual([4, 2, 2]);
  });
});
