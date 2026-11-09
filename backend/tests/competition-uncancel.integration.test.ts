/**
 * «Descancelar» (`POST /competitions/:id/uncancel`): `cancelada → borrador`, siempre, y solo para el rol administrativo.
 *
 * Datos sintéticos; solo la base desechable de `docker-compose.test.yml` (el guard de `testDb.ts` lo exige).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createUser, createPerson, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";

let app: FastifyInstance;
const tokens = { admin_unc: "", club_unc: "", nad_unc: "", gestor_unc: "" };
const ids = { admin: "", competencia: "" };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username}: ${res.statusCode} ${res.body}`);
  return res.json().accessToken as string;
}
const descancelar = (id: string, token?: string) =>
  app.inject({ method: "POST", url: `/competitions/${id}/uncancel`, headers: token ? auth(token) : {} });

const auditorias = (id: string) => prisma.auditLog.findMany({ where: { entityId: id, action: "COMPETITION_UNCANCEL" } });

/** Huella de TODO lo que no debe cambiar al descancelar: la competencia (salvo estado y cierre), sus pruebas, fechas, jornadas, inscripciones y relevos. */
async function huella(id: string) {
  const c = await prisma.competition.findUniqueOrThrow({ where: { id } });
  const { status: _s, registrationsClosedReason: _r, registrationsClosedAt: _a, updatedAt: _u, updatedBy: _b, ...resto } = c;
  return {
    resto,
    fechas: await prisma.competitionDate.findMany({ where: { competitionId: id }, orderBy: { id: "asc" } }),
    jornadas: await prisma.competitionSession.findMany({ where: { competitionId: id }, orderBy: { id: "asc" } }),
    pruebas: await prisma.competitionEvent.findMany({ where: { competitionId: id }, orderBy: { id: "asc" } }),
    inscripciones: await prisma.registration.findMany({ where: { competitionEvent: { competitionId: id } }, orderBy: { id: "asc" } }),
    relevos: await prisma.relayRegistration.findMany({ where: { competitionEvent: { competitionId: id } }, include: { members: true }, orderBy: { id: "asc" } }),
  };
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();

  const admin = await createUser({ username: "admin_unc", roleNames: ["admin"] });
  ids.admin = admin.id;
  const club = await createClub("Club Unc", "CUN", "club_unc");
  await createUser({ username: "club_unc", roleNames: ["club"], clubId: club.id });
  const nadador = await createPerson({ run: "60000001", username: "nad_unc", firstName: "Nadador", gender: "male" });
  await createUser({ username: "nad_unc", roleNames: ["swimmer"], personId: nadador.id });
  // Perfil NO administrativo que SÍ tiene `competitions:write`: demuestra que el permiso solo no basta.
  const rol = await prisma.role.create({ data: { name: "gestor_unc" } });
  const permiso = await prisma.permission.findUniqueOrThrow({ where: { code: "competitions:write" } });
  await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
  await createUser({ username: "gestor_unc", roleNames: ["gestor_unc"] });

  for (const u of ["admin_unc", "club_unc", "nad_unc", "gestor_unc"] as const) tokens[u] = await login(u);

  // Competencia con estructura, una individual y un relevo, para comprobar que nada se recrea ni cambia.
  const ti = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
  const tr = await prisma.testType.create({ data: { name: "Relevo 4x", swimmersCount: 4 } });
  const dist = await prisma.distance.create({ data: { meters: 50 } });
  const estilo = await prisma.stroke.create({ data: { name: "Libre" } });
  const jornada = await prisma.sessionType.create({ data: { name: "Mañana" } });
  const catI = await prisma.category.create({ data: { testTypeId: ti.id, name: "Todo competidor", minAge: 5, maxAge: 99 } });
  const catR = await prisma.category.create({ data: { testTypeId: tr.id, name: "Relevo libre", minAge: 5, maxAge: 99 } });
  const pI = await prisma.event.create({ data: { testTypeId: ti.id, distanceId: dist.id, strokeId: estilo.id, gender: "mixed" } });
  const pR = await prisma.event.create({ data: { testTypeId: tr.id, distanceId: dist.id, strokeId: estilo.id, gender: "mixed" } });
  const ahora = Date.now();
  const comp = await prisma.competition.create({
    data: {
      name: "Copa Descancelar",
      // Fechas de inscripción que abarcan HOY: si algo abriera la competencia al leerla, se vería.
      registrationStartAt: new Date(ahora - 86_400_000),
      registrationEndAt: new Date(ahora + 86_400_000),
      status: "cancelled",
    },
  });
  ids.competencia = comp.id;
  const fecha = await prisma.competitionDate.create({ data: { competitionId: comp.id, date: new Date(ahora) } });
  const sesion = await prisma.competitionSession.create({ data: { competitionDateId: fecha.id, sessionTypeId: jornada.id, competitionId: comp.id } });
  const ceI = await prisma.competitionEvent.create({ data: { competitionId: comp.id, eventId: pI.id, competitionSessionId: sesion.id } });
  const ceR = await prisma.competitionEvent.create({ data: { competitionId: comp.id, eventId: pR.id, competitionSessionId: sesion.id } });
  const nadadores = [nadador];
  for (let i = 2; i <= 4; i++) nadadores.push(await createPerson({ run: `6000000${i}`, username: `nad_unc${i}`, firstName: `Nadador${i}`, gender: "female" }));
  for (const p of nadadores) await addActiveMembership(club.id, p.id, admin.id);
  await prisma.registration.create({ data: { competitionEventId: ceI.id, personId: nadador.id, clubId: club.id, categoryId: catI.id, status: "confirmed", registeredByUserId: admin.id } });
  await prisma.relayRegistration.create({
    data: {
      competitionEventId: ceR.id, clubId: club.id, categoryId: catR.id, status: "cancelled", registeredByUserId: admin.id,
      cancelledByUserId: admin.id, cancelledAt: new Date(),
      members: { create: nadadores.map((p, i) => ({ personId: p.id, orderPosition: i + 1 })) },
    },
  });
});

beforeEach(async () => {
  // Cada prueba parte de «cancelada» y sin auditorías de descancelar.
  await prisma.competition.update({ where: { id: ids.competencia }, data: { status: "cancelled", registrationsClosedReason: null, registrationsClosedAt: null } });
  await prisma.auditLog.deleteMany({ where: { action: "COMPETITION_UNCANCEL" } });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("Descancelar — administrador", () => {
  it("cancelada → borrador, con respuesta, base y lectura posterior en borrador (sin abrir inscripciones)", async () => {
    const res = await descancelar(ids.competencia, tokens.admin_unc);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("draft");

    const fila = await prisma.competition.findUniqueOrThrow({ where: { id: ids.competencia } });
    expect(fila.status).toBe("draft");
    expect(fila.registrationsClosedReason).toBeNull();
    expect(fila.registrationsClosedAt).toBeNull();
    expect(fila.updatedBy).toBe(ids.admin);

    // Aunque las fechas de inscripción abarcan hoy, leerla NO la abre ni la programa.
    for (const url of [`/competitions/${ids.competencia}`, "/competitions"]) {
      const lectura = await app.inject({ method: "GET", url, headers: auth(tokens.admin_unc) });
      expect(lectura.statusCode).toBe(200);
      const estado = url === "/competitions" ? (lectura.json().items ?? lectura.json()).find((c: { id: string }) => c.id === ids.competencia).status : lectura.json().status;
      expect(estado).toBe("draft");
    }
    expect((await prisma.competition.findUniqueOrThrow({ where: { id: ids.competencia } })).status).toBe("draft");
  });

  it("conserva pruebas, fechas, jornadas, configuración, inscripciones y relevos (mismos ids y estados)", async () => {
    const antes = await huella(ids.competencia);
    expect(antes.inscripciones).toHaveLength(1);
    expect(antes.relevos).toHaveLength(1);
    expect(antes.relevos[0]!.status).toBe("cancelled");

    expect((await descancelar(ids.competencia, tokens.admin_unc)).statusCode).toBe(200);
    expect(await huella(ids.competencia)).toEqual(antes);
  });

  it("audita en la misma operación: autor, competencia, estado anterior y nuevo; una sola fila", async () => {
    await descancelar(ids.competencia, tokens.admin_unc);
    const filas = await auditorias(ids.competencia);
    expect(filas).toHaveLength(1);
    const a = filas[0]!;
    expect(a.userId).toBe(ids.admin);
    expect(a.entityType).toBe("Competition");
    expect(a.entityId).toBe(ids.competencia);
    expect((a.before as { status: string }).status).toBe("cancelled");
    expect((a.after as { status: string }).status).toBe("draft");
  });

  it("no hay cambio sin auditoría: si la auditoría falla, la competencia sigue cancelada", async () => {
    // Fuerza el fallo de la auditoría con un usuario inexistente (clave foránea): la transacción completa debe revertirse.
    const { uncancelCompetition } = await import("../src/modules/competitions/competitions.service");
    await expect(uncancelCompetition(ids.competencia, { userId: "00000000-0000-0000-0000-000000000000", ipAddress: "127.0.0.1" })).rejects.toThrow();
    expect((await prisma.competition.findUniqueOrThrow({ where: { id: ids.competencia } })).status).toBe("cancelled");
    expect(await auditorias(ids.competencia)).toHaveLength(0);
  });

  it("competencia inexistente → 404", async () => {
    const res = await descancelar("00000000-0000-4000-8000-000000000000", tokens.admin_unc);
    expect(res.statusCode).toBe(404);
  });
});

describe("Descancelar — el resto de perfiles", () => {
  for (const [nombre, token] of [["club", "club_unc"], ["nadador", "nad_unc"], ["gestor con competitions:write pero sin rol de administración", "gestor_unc"]] as const) {
    it(`rechaza (403) a ${nombre} y no cambia nada`, async () => {
      const antes = await prisma.competition.findUniqueOrThrow({ where: { id: ids.competencia } });
      const res = await descancelar(ids.competencia, tokens[token]);
      expect(res.statusCode).toBe(403);
      expect((await prisma.competition.findUniqueOrThrow({ where: { id: ids.competencia } })).status).toBe(antes.status);
      expect(await auditorias(ids.competencia)).toHaveLength(0);
    });
  }

  it("sin sesión → 401", async () => {
    expect((await descancelar(ids.competencia)).statusCode).toBe(401);
    expect((await prisma.competition.findUniqueOrThrow({ where: { id: ids.competencia } })).status).toBe("cancelled");
  });
});

describe("Descancelar — solo desde «cancelada», sin caminos alternativos", () => {
  for (const estado of ["draft", "scheduled", "open", "individual_closed", "closed", "in_progress", "finished"] as const) {
    it(`rechaza desde «${estado}» (400), sin cambios ni auditoría`, async () => {
      await prisma.competition.update({
        where: { id: ids.competencia },
        data:
          estado === "closed" ? { status: estado, registrationsClosedReason: "manual", registrationsClosedAt: new Date() }
          : estado === "individual_closed" ? { status: estado, registrationsClosedReason: "capacity", registrationsClosedAt: new Date() }
          : { status: estado },
      });
      const res = await descancelar(ids.competencia, tokens.admin_unc);
      expect(res.statusCode).toBe(400);
      expect((await prisma.competition.findUniqueOrThrow({ where: { id: ids.competencia } })).status).toBe(estado);
      expect(await auditorias(ids.competencia)).toHaveLength(0);
    });
  }

  it("la repetición se rechaza y no duplica transición ni auditoría", async () => {
    expect((await descancelar(ids.competencia, tokens.admin_unc)).statusCode).toBe(200);
    expect((await descancelar(ids.competencia, tokens.admin_unc)).statusCode).toBe(400);
    expect(await auditorias(ids.competencia)).toHaveLength(1);
    expect((await prisma.competition.findUniqueOrThrow({ where: { id: ids.competencia } })).status).toBe("draft");
  });

  it("solicitudes concurrentes: exactamente una cambia el estado y audita", async () => {
    const respuestas = await Promise.all(Array.from({ length: 8 }, () => descancelar(ids.competencia, tokens.admin_unc)));
    const codigos = respuestas.map((r) => r.statusCode).sort();
    expect(codigos.filter((c) => c === 200)).toHaveLength(1);
    expect(codigos.filter((c) => c === 400)).toHaveLength(7);
    expect(await auditorias(ids.competencia)).toHaveLength(1);
    expect((await prisma.competition.findUniqueOrThrow({ where: { id: ids.competencia } })).status).toBe("draft");
  });

  it("ningún otro camino saca a la competencia de «cancelada»: PUT con status y transiciones genéricas", async () => {
    const put = await app.inject({ method: "PUT", url: `/competitions/${ids.competencia}`, headers: auth(tokens.admin_unc), payload: { status: "draft", name: "Copa Descancelar" } });
    expect((await prisma.competition.findUniqueOrThrow({ where: { id: ids.competencia } })).status, `PUT devolvió ${put.statusCode}`).toBe("cancelled");
    for (const accion of ["schedule", "closeRegistrations", "start", "finish", "cancel", "reopenRegistrations"]) {
      const res = await app.inject({ method: "POST", url: `/competitions/${ids.competencia}/${accion}`, headers: auth(tokens.admin_unc) });
      expect(res.statusCode, accion).toBeGreaterThanOrEqual(400);
    }
    expect((await prisma.competition.findUniqueOrThrow({ where: { id: ids.competencia } })).status).toBe("cancelled");
  });

  it("programar es otra acción explícita, con las reglas de siempre: tras descancelar se puede programar", async () => {
    await descancelar(ids.competencia, tokens.admin_unc);
    const programar = await app.inject({ method: "POST", url: `/competitions/${ids.competencia}/schedule`, headers: auth(tokens.admin_unc) });
    expect(programar.statusCode).toBe(200);
    expect(programar.json().status).toBe("scheduled");
  });
});
