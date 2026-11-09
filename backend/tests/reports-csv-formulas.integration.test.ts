/**
 * AUD-V (integración): el CSV COMPLETO que entrega el flujo real de exportación
 * (`GET /reports/registrations/export?format=csv`) no deja ninguna celda posible con aspecto de fórmula,
 * ni con coma ni con otro separador de lista como `;`, y conserva sus secciones, columnas y orden.
 *
 * Datos sintéticos; solo la base desechable de `docker-compose.test.yml` (el guard de `testDb.ts` lo exige).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createUser, createPerson, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";

let app: FastifyInstance;
let token = "";
let competitionId = "";

const CLUB_HOSTIL = "Club;=1+1;Z";
const NOMBRES = ["Hugo;=1+1;x", "Ines;+1+1;x", "Juan;-1+1;x", "Kira ;=2*3;x"];

/** Peor caso: parte por `;`, `|` y tabulador ignorando comillas, y quita espacios y comillas del inicio de cada celda. */
const celdasPosibles = (texto: string): string[] => texto.split(/[;|\t\r\n]/).map((c) => c.replace(/^[ "]+/, ""));

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();

  await createUser({ username: "admin_csv", roleNames: ["admin"] });
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin_csv", password: TEST_PASSWORD } });
  token = login.json().accessToken as string;
  const admin = await prisma.user.findFirstOrThrow({ where: { username: "admin_csv" } });

  const tipo = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
  const distancia = await prisma.distance.create({ data: { meters: 50 } });
  const estilo = await prisma.stroke.create({ data: { name: "Libre" } });
  const jornada = await prisma.sessionType.create({ data: { name: "Mañana" } });
  const categoria = await prisma.category.create({ data: { testTypeId: tipo.id, name: "Todo competidor", minAge: 5, maxAge: 99 } });
  const prueba = await prisma.event.create({ data: { testTypeId: tipo.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" } });
  const ahora = new Date();
  const competencia = await prisma.competition.create({
    data: { name: "Copa CSV", status: "open", registrationStartAt: new Date(ahora.getTime() - 86_400_000), registrationEndAt: new Date(ahora.getTime() + 86_400_000) },
  });
  competitionId = competencia.id;
  const fecha = await prisma.competitionDate.create({ data: { competitionId, date: ahora } });
  const sesion = await prisma.competitionSession.create({ data: { competitionDateId: fecha.id, sessionTypeId: jornada.id, competitionId } });
  const ce = await prisma.competitionEvent.create({ data: { competitionId, eventId: prueba.id, competitionSessionId: sesion.id } });

  const club = await createClub(CLUB_HOSTIL, "CSV1");
  let i = 0;
  for (const nombre of [...NOMBRES, "Ana-María", "Pérez, Soto"]) {
    i++;
    const p = await createPerson({ run: `5000000${i}`, username: `csv_${i}`, firstName: nombre, gender: i % 2 ? "male" : "female" });
    await addActiveMembership(club.id, p.id, admin.id);
    await prisma.registration.create({ data: { competitionEventId: ce.id, personId: p.id, clubId: club.id, categoryId: categoria.id, status: "confirmed", registeredByUserId: admin.id } });
  }
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("exportación CSV completa (flujo real)", () => {
  it("ninguna celda posible empieza como fórmula y los valores legítimos se conservan", async () => {
    const res = await app.inject({ method: "GET", url: `/reports/registrations/export?competitionId=${competitionId}&format=csv`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const csv = res.body;

    for (const celda of celdasPosibles(csv)) expect(/^[=+\-@]/.test(celda), `celda «${celda}»`).toBe(false);

    // Los valores se conservan salvo la comilla simple que neutraliza el trozo peligroso.
    expect(csv).toContain("Club;'=1+1;Z");
    expect(csv).toContain("Hugo;'=1+1;x Prueba");
    expect(csv).toContain("Ana-María Prueba");
    expect(csv).toContain('"Pérez, Soto Prueba"');
  });

  it("conserva secciones, encabezados, número de columnas y una fila por inscripción", async () => {
    const res = await app.inject({ method: "GET", url: `/reports/registrations/export?competitionId=${competitionId}&format=csv`, headers: { authorization: `Bearer ${token}` } });
    const lineas = res.body.split("\r\n");
    expect(lineas[0]).toBe("INDIVIDUALES");
    expect(lineas[1]).toBe("Competencia,Club,Nombre completo,Fecha de nacimiento,Categoría,Prueba,Distancia,Estilo,Género,Fecha,Jornada,Tipo de prueba");
    const filas = lineas.slice(2, lineas.indexOf(""));
    expect(filas).toHaveLength(NOMBRES.length + 2);
    // Sin comas dentro de los valores (la de «Pérez, Soto» va entrecomillada): 12 columnas.
    for (const fila of filas.filter((f) => !f.includes('"'))) expect(fila.split(",")).toHaveLength(12);
    expect(lineas).toContain("RELEVOS");
  });

  it("no cambia los permisos: sin sesión, 401", async () => {
    const res = await app.inject({ method: "GET", url: `/reports/registrations/export?competitionId=${competitionId}&format=csv` });
    expect(res.statusCode).toBe(401);
  });
});
