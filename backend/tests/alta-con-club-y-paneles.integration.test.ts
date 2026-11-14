/**
 * 1. «Asignación a club» en el alta de persona (`createPersonWithOptionalClub`).
 * 2. Nombres separados y edad a la fecha de corte en los datos de los paneles
 *    (`/registrations/club-eligibility-matrix` y `/registrations/club-swimmers?competitionId=`).
 *
 * Alta: sin club (como antes), con club activo (persona, membresía activa desde hoy en Santiago,
 * rol derivado, dos auditorías, plantel), y reversión COMPLETA con un club inactivo, inexistente o
 * si la asignación falla dentro de la transacción. Nunca crea credenciales.
 *
 * Datos sintéticos. Solo contra la base desechable (ver `helpers/testDb.ts`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addClubStaff, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";
import { runValido } from "./helpers/run";

let app: FastifyInstance;
const DIA = 86_400_000;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username} devolvió ${res.statusCode}`);
  return res.json().accessToken as string;
}
const get = (token: string, url: string) => app.inject({ method: "GET", url, headers: auth(token) });

/** Día de hoy en Santiago, calculado aquí sin importar el código que se prueba. */
const hoySantiago = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());

let admin: string;
let adminId: string;
let club: { id: string; name: string };

beforeAll(async () => {
  app = await buildServer();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const cuenta = await createUser({ username: "admin_alta", roleNames: ["admin"] });
  adminId = cuenta.id;
  club = await createClub("Club Alta Sintético", "ALT");
  admin = await login("admin_alta");
});

afterAll(async () => {
  await app.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

const datos = (cuerpo: number, extra: object = {}) => ({
  run: runValido(cuerpo),
  firstName: "Persona",
  paternalLastName: "Sintética",
  maternalLastName: "Alta",
  birthDate: "1980-05-05",
  gender: "female",
  ...extra,
});
const crear = (payload: object) => app.inject({ method: "POST", url: "/persons", headers: auth(admin), payload });

describe("alta de persona con «Asignación a club»", () => {
  it("sin club: crea solo la persona, sin membresía, sin rol ni credenciales (como antes)", async () => {
    for (const payload of [datos(31000001), datos(31000002, { clubId: null })]) {
      const r = await crear(payload);
      expect(r.statusCode).toBe(201);
      const id = r.json().id;
      expect(await prisma.clubSwimmer.count({ where: { personId: id } })).toBe(0);
      expect(await prisma.personRole.count({ where: { personId: id } })).toBe(0);
      expect(await prisma.user.count({ where: { personId: id } })).toBe(0);
    }
    expect(await prisma.auditLog.count({ where: { action: "SWIMMER_ASSIGNMENT_DIRECT" } })).toBe(0);
  });

  it("con un club activo: persona, membresía activa desde hoy en Santiago, rol de nadador, auditorías y plantel; sin credenciales", async () => {
    const r = await crear(datos(31000003, { clubId: club.id }));
    expect(r.statusCode).toBe(201);
    const persona = r.json();
    expect(persona.roles.filter((x: any) => x.active).map((x: any) => x.roleType)).toEqual(["swimmer"]);

    const membresias = await prisma.$queryRaw<{ club_id: string; status: string; start_date: string }[]>`
      SELECT club_id, status::text AS status, start_date::text AS start_date FROM club_swimmers WHERE person_id = ${persona.id}`;
    expect(membresias).toEqual([{ club_id: club.id, status: "active", start_date: hoySantiago() }]);
    expect(await prisma.user.count({ where: { personId: persona.id } })).toBe(0);

    const acciones = (await prisma.auditLog.findMany({ where: { OR: [{ entityId: persona.id }, { action: "SWIMMER_ASSIGNMENT_DIRECT" }] } })).map((f) => f.action).sort();
    expect(acciones).toEqual(["PERSON_CREATED", "SWIMMER_ASSIGNMENT_DIRECT"]);

    const plantel = (await get(admin, `/registrations/club-swimmers?clubId=${club.id}`)).json();
    expect(plantel.map((p: any) => p.id)).toEqual([persona.id]);
  });

  it("con un club INACTIVO, inexistente o en el que la persona ya no cabe: 4xx y no queda NADA", async () => {
    const inactivo = await createClub("Club Inactivo Sintético", "INA");
    await prisma.club.update({ where: { id: inactivo.id }, data: { status: "disabled" } });
    const casos = [
      { payload: datos(31000004, { clubId: inactivo.id }), estado: 400 },
      { payload: datos(31000005, { clubId: "00000000-0000-4000-8000-00000000abcd" }), estado: 404 },
    ];
    for (const { payload, estado } of casos) {
      const r = await crear(payload);
      expect(r.statusCode).toBe(estado);
      expect(await prisma.person.count({ where: { run: payload.run } }), "la persona no se creó").toBe(0);
    }
    expect(await prisma.clubSwimmer.count()).toBe(0);
    expect(await prisma.personRole.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: { in: ["PERSON_CREATED", "SWIMMER_ASSIGNMENT_DIRECT"] } } })).toBe(0);
  });

  it("si la asignación falla DENTRO de la transacción, también se revierte la persona", async () => {
    // Un disparador sintético (solo en la base desechable, retirado al terminar) hace fallar la
    // inserción de la membresía DESPUÉS de crear la persona en la misma transacción.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.prueba_falla_membresia() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fallo sintético de la asignación'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER prueba_falla_membresia BEFORE INSERT ON club_swimmers FOR EACH ROW EXECUTE FUNCTION public.prueba_falla_membresia()`);
    try {
      const payload = datos(31000006, { clubId: club.id });
      const r = await crear(payload);
      expect(r.statusCode).toBeGreaterThanOrEqual(500);
      expect(await prisma.person.count({ where: { run: payload.run } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: "PERSON_CREATED" } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS prueba_falla_membresia ON club_swimmers`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.prueba_falla_membresia()`);
    }
  });

  it("un RUN ya registrado no crea otra persona ni una membresía", async () => {
    await crear(datos(31000007));
    const r = await crear(datos(31000007, { clubId: club.id }));
    expect(r.statusCode).toBe(400);
    expect(await prisma.person.count({ where: { run: runValido(31000007) } })).toBe(1);
    expect(await prisma.clubSwimmer.count()).toBe(0);
  });

  it("la edición no acepta clubId como traslado (se descarta y no cambia membresías)", async () => {
    const creada = (await crear(datos(31000008))).json();
    const r = await app.inject({ method: "PUT", url: `/persons/${creada.id}`, headers: auth(admin), payload: { phone: "123", clubId: club.id } });
    expect(r.statusCode).toBe(200);
    expect(await prisma.clubSwimmer.count({ where: { personId: creada.id } })).toBe(0);
  });
});

describe("nombres separados y edad a la fecha de corte en los paneles", () => {
  async function competencia(ageCutoffDate: Date | null, status: "open" | "draft" = "open") {
    return prisma.competition.create({
      data: { name: `Competencia sintética ${status}`, status, ageCutoffDate, registrationStartAt: new Date(Date.now() - DIA), registrationEndAt: new Date(Date.now() + 10 * DIA) },
    });
  }
  async function nadador(cuerpo: number, nacimiento: string, nombres: { first: string | null; pat: string | null; mat: string | null; full: string }) {
    const p = await prisma.person.create({
      data: { run: runValido(cuerpo), firstName: nombres.first, paternalLastName: nombres.pat, maternalLastName: nombres.mat, fullName: nombres.full, birthDate: new Date(`${nacimiento}T00:00:00.000Z`), gender: "female", status: "active" },
    });
    await prisma.personRole.create({ data: { personId: p.id, roleType: "swimmer", active: true } });
    await addActiveMembership(club.id, p.id, adminId);
    return p;
  }

  it("la matriz y el plantel traen los campos separados y la edad al corte, incluido el cumpleaños el mismo día", async () => {
    const comp = await competencia(new Date("2027-03-15T00:00:00.000Z"));
    const cumple = await nadador(31000011, "1973-03-15", { first: "Ana", pat: "Zeta", mat: "Uno", full: "Ana Zeta Uno" });
    const manana = await nadador(31000012, "1973-03-16", { first: "Bea", pat: "Ye", mat: null, full: "Bea Ye" });
    const historico = await nadador(31000013, "1990-01-01", { first: null, pat: null, mat: null, full: "Registro Histórico Sintético" });

    const matriz = (await get(admin, `/registrations/club-eligibility-matrix?competitionId=${comp.id}&clubId=${club.id}`)).json();
    const porId = new Map(matriz.map((e: any) => [e.personId, e]));
    expect(porId.get(cumple.id)).toMatchObject({ firstName: "Ana", paternalLastName: "Zeta", maternalLastName: "Uno", edadAlCorte: 54 });
    expect(porId.get(manana.id)).toMatchObject({ firstName: "Bea", paternalLastName: "Ye", maternalLastName: null, edadAlCorte: 53 });
    expect(porId.get(historico.id)).toMatchObject({ firstName: null, paternalLastName: null, fullName: "Registro Histórico Sintético", edadAlCorte: 37 });

    const plantel = (await get(admin, `/registrations/club-swimmers?clubId=${club.id}&competitionId=${comp.id}`)).json();
    expect(new Map(plantel.map((p: any) => [p.id, p.edadAlCorte]))).toEqual(new Map([[cumple.id, 54], [manana.id, 53], [historico.id, 37]]));
    // Sin competencia, el plantel no inventa una edad.
    const sinCompetencia = (await get(admin, `/registrations/club-swimmers?clubId=${club.id}`)).json();
    expect(sinCompetencia.every((p: any) => !("edadAlCorte" in p))).toBe(true);
  });

  it("sin fecha de corte se usa el mismo respaldo que las reglas: el 31 de diciembre del año en curso", async () => {
    const comp = await competencia(null);
    const anio = new Date().getUTCFullYear();
    const p = await nadador(31000014, "1980-12-31", { first: "Cata", pat: "Equis", mat: null, full: "Cata Equis" });
    const q = await nadador(31000015, "1981-01-01", { first: "Dora", pat: "Equis", mat: null, full: "Dora Equis" });
    const matriz = (await get(admin, `/registrations/club-eligibility-matrix?competitionId=${comp.id}&clubId=${club.id}`)).json();
    const edades = new Map(matriz.map((e: any) => [e.personId, e.edadAlCorte]));
    expect(edades.get(p.id)).toBe(anio - 1980);
    expect(edades.get(q.id)).toBe(anio - 1981);
  });

  it("con competitionId, el plantel exige que la competencia sea visible: un delegado recibe 404 para un Borrador", async () => {
    const borrador = await competencia(null, "draft");
    const delegado = await createPerson({ run: "30000201", username: "deleg_alta", firstName: "Delia", gender: "female", roles: ["delegate"] });
    await addClubStaff(club.id, delegado.id, "delegate");
    await createUser({ username: "deleg_alta", roleNames: ["delegate"], personId: delegado.id });
    const token = await login("deleg_alta");
    expect((await get(token, `/registrations/club-swimmers?clubId=${club.id}&competitionId=${borrador.id}`)).statusCode).toBe(404);
    expect((await get(token, `/registrations/club-swimmers?clubId=${club.id}`)).statusCode).toBe(200);
  });
});

/**
 * 3. EDAD AL CORTE DE INSCRITOS QUE YA NO ESTÁN EN EL PLANTEL ACTIVO (corrección antes de publicar).
 *
 * La inscripción individual y el relevo confirmados se conservan aunque la membresía termine. La
 * edad que presentan los paneles debe venir de los datos de la inscripción o del integrante,
 * calculada por el servidor para ESA competencia, sin exponer la fecha de nacimiento ni ampliar el
 * RUN (un nadador sigue sin recibir el de sus compañeros, y tampoco su edad).
 */
describe("edad al corte en inscripciones y relevos de quien salió del plantel", () => {
  async function escenario() {
    const tipoInd = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
    const tipoRel = await prisma.testType.create({ data: { name: "Relevo 4x", swimmersCount: 4 } });
    const distancia = await prisma.distance.create({ data: { meters: 50 } });
    const estilo = await prisma.stroke.create({ data: { name: "Libre" } });
    const jornada = await prisma.sessionType.create({ data: { name: "Mañana" } });
    const catInd = await prisma.category.create({ data: { testTypeId: tipoInd.id, name: "Todo competidor", minAge: 5, maxAge: 120 } });
    const catRel = await prisma.category.create({ data: { testTypeId: tipoRel.id, name: "Relevo libre", minAge: 5, maxAge: 480 } });
    const evInd = await prisma.event.create({ data: { testTypeId: tipoInd.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" } });
    const evRel = await prisma.event.create({ data: { testTypeId: tipoRel.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" } });

    const comp = await prisma.competition.create({
      data: { name: "Competencia corte sintética", status: "open", ageCutoffDate: new Date("2027-03-15T00:00:00.000Z"), registrationStartAt: new Date(Date.now() - DIA), registrationEndAt: new Date(Date.now() + 10 * DIA) },
    });
    const fecha = await prisma.competitionDate.create({ data: { competitionId: comp.id, date: new Date(Date.now() + 20 * DIA) } });
    const sesion = await prisma.competitionSession.create({ data: { competitionDateId: fecha.id, sessionTypeId: jornada.id, competitionId: comp.id } });
    const ceInd = await prisma.competitionEvent.create({ data: { competitionId: comp.id, eventId: evInd.id, competitionSessionId: sesion.id } });
    const ceRel = await prisma.competitionEvent.create({ data: { competitionId: comp.id, eventId: evRel.id, competitionSessionId: sesion.id } });

    // Nacimientos con edad al 2027-03-15: 54 (cumple ese día), 53, 40 y 30.
    const nacimientos = ["1973-03-15", "1973-03-16", "1986-06-01", "1996-12-31"];
    const personas = [];
    for (const [i, nac] of nacimientos.entries()) {
      const p = await createPerson({ run: `3200000${i + 1}`, username: `nad_corte${i + 1}`, firstName: `Corte${i + 1}`, gender: i % 2 ? "male" : "female", roles: ["swimmer"] });
      await prisma.person.update({ where: { id: p.id }, data: { birthDate: new Date(`${nac}T00:00:00.000Z`) } });
      await addActiveMembership(club.id, p.id, adminId);
      personas.push(p);
    }
    const [saliente, p2, p3, p4] = personas as [typeof personas[number], typeof personas[number], typeof personas[number], typeof personas[number]];
    await prisma.registration.create({ data: { competitionEventId: ceInd.id, personId: saliente.id, clubId: club.id, categoryId: catInd.id, status: "confirmed", registeredByUserId: adminId } });
    await prisma.relayRegistration.create({
      data: {
        competitionEventId: ceRel.id, clubId: club.id, categoryId: catRel.id, status: "confirmed", registeredByUserId: adminId,
        // Puestos en un orden distinto del de creación de las personas.
        members: { create: [p3, saliente, p4, p2].map((p, i) => ({ personId: p.id, orderPosition: i + 1 })) },
      },
    });
    // La membresía del saliente TERMINA: sus inscripciones se conservan.
    await prisma.clubSwimmer.updateMany({ where: { personId: saliente.id }, data: { status: "ended", endDate: new Date(), fechaTermino: new Date(`${hoySantiago()}T00:00:00.000Z`) } });
    return { comp, saliente, p2, p3, p4 };
  }

  it("la inscripción individual trae la edad al corte aunque la persona ya no esté en el plantel, sin fecha de nacimiento", async () => {
    const { comp, saliente } = await escenario();
    const plantel = (await get(admin, `/registrations/club-swimmers?clubId=${club.id}&competitionId=${comp.id}`)).json();
    expect(plantel.map((p: any) => p.id)).not.toContain(saliente.id);

    const lista = (await get(admin, `/registrations?competitionId=${comp.id}&clubId=${club.id}&status=confirmed`)).json();
    expect(lista.items).toHaveLength(1);
    expect(lista.items[0].person.id).toBe(saliente.id);
    expect(lista.items[0].edadAlCorte).toBe(54);
    expect(lista.items[0].person).not.toHaveProperty("birthDate");
    expect(JSON.stringify(lista)).not.toMatch(/1973-03-15/);
  });

  it("el relevo trae la edad al corte de cada integrante, también del que salió, en el orden de los puestos", async () => {
    const { comp, saliente, p2, p3, p4 } = await escenario();
    const lista = (await get(admin, `/relay-registrations?competitionId=${comp.id}&clubId=${club.id}&status=confirmed`)).json();
    expect(lista.items).toHaveLength(1);
    const miembros = lista.items[0].members;
    expect(miembros.map((m: any) => [m.orderPosition, m.person.id, m.edadAlCorte])).toEqual([
      [1, p3.id, 40],
      [2, saliente.id, 54],
      [3, p4.id, 30],
      [4, p2.id, 53],
    ]);
    for (const m of miembros) expect(m.person).not.toHaveProperty("birthDate");
    expect(JSON.stringify(lista)).not.toMatch(/1973-03-1[56]|1986-06-01|1996-12-31/);
  });

  it("un nadador recibe su propia edad en el relevo, pero no la edad ni el RUN de sus compañeros", async () => {
    const { comp, saliente, p2 } = await escenario();
    await createUser({ username: "nad_corte2", roleNames: ["swimmer"], personId: p2.id });
    const token = await login("nad_corte2");
    const lista = (await get(token, `/relay-registrations?competitionId=${comp.id}&status=confirmed`)).json();
    const miembros = lista.items[0].members;
    const propio = miembros.find((m: any) => m.person.id === p2.id);
    expect(propio.edadAlCorte).toBe(53);
    for (const m of miembros.filter((x: any) => x.person.id !== p2.id)) {
      expect(m).not.toHaveProperty("edadAlCorte");
      expect(m.person).not.toHaveProperty("run");
    }
    expect(miembros.some((m: any) => m.person.id === saliente.id)).toBe(true);
  });
});
