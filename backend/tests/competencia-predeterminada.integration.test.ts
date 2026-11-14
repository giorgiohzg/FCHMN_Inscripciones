/**
 * Competencia por defecto de los paneles de Inscripción y de Relevos
 * (`competencia-predeterminada.service.ts`, migración `20261114000000_competencia_predeterminada`).
 *
 * Qué se comprueba, por HTTP salvo la restricción de la base:
 *  - la migración: columna `false` por omisión e índice único parcial (la base rechaza dos marcadas);
 *  - marcar una desmarca la anterior; repetir no audita; quitar es idempotente y nunca desmarca otra;
 *  - con marcas SIMULTÁNEAS de competencias distintas queda exactamente una;
 *  - auditoría `COMPETITION_DEFAULT_SET` / `COMPETITION_DEFAULT_CLEARED` con la anterior y la nueva;
 *  - marcar no cambia estado, fechas, visibilidad ni `updated_at`;
 *  - solo administración: delegado y nadador reciben 403, también por llamada directa;
 *  - la visibilidad no cambia: quien no administra no recibe una predeterminada en Borrador;
 *  - duplicar no hereda la marca.
 *
 * Datos sintéticos. Solo contra la base desechable (ver `helpers/testDb.ts`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addClubStaff, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";

let app: FastifyInstance;
const DIA = 86_400_000;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username} devolvió ${res.statusCode}`);
  return res.json().accessToken as string;
}
const marcar = (token: string, id: string) => app.inject({ method: "PUT", url: `/competitions/${id}/predeterminada`, headers: auth(token) });
const quitar = (token: string, id: string) => app.inject({ method: "DELETE", url: `/competitions/${id}/predeterminada`, headers: auth(token) });

async function crearCompetencia(nombre: string, status: "draft" | "open" = "open", visible = true) {
  const ahora = Date.now();
  return prisma.competition.create({
    data: { name: nombre, status, registrationStartAt: new Date(ahora - DIA), registrationEndAt: new Date(ahora + 10 * DIA), visibleInRegistrationPanels: visible },
  });
}
async function marcadas(): Promise<string[]> {
  const filas = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM competitions WHERE es_predeterminada ORDER BY id`;
  return filas.map((f) => f.id);
}

let tokens: { admin: string; delegado: string; nadador: string };

beforeAll(async () => {
  app = await buildServer();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_pred", roleNames: ["admin"] });
  const club = await createClub("Club Predeterminada Sintético", "PRD");
  const delegado = await createPerson({ run: "30000101", username: "deleg_pred", firstName: "Delfina", gender: "female", roles: ["delegate"] });
  await addClubStaff(club.id, delegado.id, "delegate");
  await createUser({ username: "deleg_pred", roleNames: ["delegate"], personId: delegado.id });
  const nadador = await createPerson({ run: "30000102", username: "nad_pred", firstName: "Nicanor", gender: "male", roles: ["swimmer"] });
  await addActiveMembership(club.id, nadador.id, admin.id);
  await createUser({ username: "nad_pred", roleNames: ["swimmer"], personId: nadador.id });
  tokens = { admin: await login("admin_pred"), delegado: await login("deleg_pred"), nadador: await login("nad_pred") };
});

afterAll(async () => {
  await app.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("migración", () => {
  it("la columna nace en false y el índice parcial impide dos predeterminadas en la base", async () => {
    const a = await crearCompetencia("A sintética");
    const b = await crearCompetencia("B sintética");
    expect(await marcadas()).toEqual([]);
    const indice = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE indexname = 'competitions_una_predeterminada'`;
    expect(indice).toHaveLength(1);
    expect(indice[0]!.indexdef).toMatch(/UNIQUE/);
    expect(indice[0]!.indexdef).toMatch(/WHERE es_predeterminada/);

    await prisma.$executeRaw`UPDATE competitions SET es_predeterminada = true WHERE id = ${a.id}`;
    await expect(prisma.$executeRaw`UPDATE competitions SET es_predeterminada = true WHERE id = ${b.id}`).rejects.toThrow();
    expect(await marcadas()).toEqual([a.id]);
  });
});

describe("marcar y quitar", () => {
  it("marcar desmarca la anterior y audita ambas en el cambio; repetir no audita", async () => {
    const a = await crearCompetencia("A sintética");
    const b = await crearCompetencia("B sintética");

    const r1 = await marcar(tokens.admin, a.id);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ competenciaPredeterminadaId: a.id, cambio: true });
    const r2 = await marcar(tokens.admin, b.id);
    expect(r2.json()).toEqual({ competenciaPredeterminadaId: b.id, cambio: true });
    expect(await marcadas()).toEqual([b.id]);

    const repetida = await marcar(tokens.admin, b.id);
    expect(repetida.json()).toEqual({ competenciaPredeterminadaId: b.id, cambio: false });

    const auditoria = await prisma.auditLog.findMany({ where: { action: "COMPETITION_DEFAULT_SET" }, orderBy: { createdAt: "asc" } });
    expect(auditoria.map((f) => [f.entityId, f.before, f.after])).toEqual([
      [a.id, { competenciaPredeterminadaId: null }, { competenciaPredeterminadaId: a.id }],
      [b.id, { competenciaPredeterminadaId: a.id }, { competenciaPredeterminadaId: b.id }],
    ]);

    // La lista la expone por competencia.
    const lista = (await app.inject({ method: "GET", url: "/competitions?pageSize=50", headers: auth(tokens.admin) })).json();
    expect(lista.items.find((c: any) => c.id === b.id).esPredeterminada).toBe(true);
    expect(lista.items.find((c: any) => c.id === a.id).esPredeterminada).toBe(false);
  });

  it("quitar es idempotente y nunca desmarca una competencia distinta de la pedida", async () => {
    const a = await crearCompetencia("A sintética");
    const b = await crearCompetencia("B sintética");
    await marcar(tokens.admin, b.id);

    // Pide quitar A, que no es la predeterminada: no cambia nada.
    const ajena = await quitar(tokens.admin, a.id);
    expect(ajena.json()).toEqual({ competenciaPredeterminadaId: b.id, cambio: false });
    expect(await marcadas()).toEqual([b.id]);

    const propia = await quitar(tokens.admin, b.id);
    expect(propia.json()).toEqual({ competenciaPredeterminadaId: null, cambio: true });
    expect((await quitar(tokens.admin, b.id)).json()).toEqual({ competenciaPredeterminadaId: null, cambio: false });
    expect(await marcadas()).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: "COMPETITION_DEFAULT_CLEARED", entityId: b.id } })).toBe(1);
  });

  it("una competencia inexistente responde 404 y no cambia la marca", async () => {
    const a = await crearCompetencia("A sintética");
    await marcar(tokens.admin, a.id);
    const r = await marcar(tokens.admin, "00000000-0000-4000-8000-00000000abcd");
    expect(r.statusCode).toBe(404);
    expect(await marcadas()).toEqual([a.id]);
  });

  it("con marcas SIMULTÁNEAS de competencias distintas queda exactamente una, y la auditoría encadena", async () => {
    const competencias = await Promise.all(Array.from({ length: 8 }, (_, i) => crearCompetencia(`Simultánea ${i} sintética`)));
    // Pool precalentado: en este equipo abrir una conexión nueva tarda ~2 s, lo mismo que el
    // `maxWait` de Prisma (observación del entorno documentada en C-05, ajena a esta prueba).
    await Promise.all(Array.from({ length: 8 }, () => prisma.$queryRaw`SELECT 1`));
    const respuestas = await Promise.all(competencias.map((c) => marcar(tokens.admin, c.id)));
    expect(respuestas.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    const finales = await marcadas();
    expect(finales).toHaveLength(1);

    // Cada cambio auditado parte de la marca que dejó el anterior (el bloqueo los ordenó): la
    // cadena anterior → nueva recorre los 8 cambios desde «ninguna» hasta la que quedó.
    const auditoria = await prisma.auditLog.findMany({ where: { action: "COMPETITION_DEFAULT_SET" } });
    expect(auditoria).toHaveLength(8);
    const porAnterior = new Map(auditoria.map((f) => [(f.before as any).competenciaPredeterminadaId as string | null, f]));
    expect(porAnterior.size, "ninguna marca anterior se repite").toBe(8);
    let actual: string | null = null;
    let pasos = 0;
    while (porAnterior.has(actual) && pasos < 20) {
      actual = (porAnterior.get(actual)!.after as any).competenciaPredeterminadaId;
      pasos++;
    }
    expect(pasos).toBe(8);
    expect(actual).toBe(finales[0]);
  });

  it("marcar no cambia estado, fechas, visibilidad ni updated_at", async () => {
    const a = await crearCompetencia("A sintética", "draft", false);
    const antes = await prisma.competition.findUniqueOrThrow({ where: { id: a.id } });
    await marcar(tokens.admin, a.id);
    const despues = await prisma.competition.findUniqueOrThrow({ where: { id: a.id } });
    expect({ ...despues, esPredeterminada: false }).toEqual({ ...antes, esPredeterminada: false });
    expect(despues.esPredeterminada).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "COMPETITION_STATUS" } } })).toBe(0);
  });

  it("duplicar una predeterminada no hereda la marca", async () => {
    const a = await crearCompetencia("A sintética");
    await marcar(tokens.admin, a.id);
    const copia = await app.inject({
      method: "POST",
      url: `/competitions/${a.id}/duplicate`,
      headers: auth(tokens.admin),
      payload: { name: "Copia sintética", registrationStartAt: new Date(Date.now() + DIA).toISOString(), registrationEndAt: new Date(Date.now() + 5 * DIA).toISOString() },
    });
    expect(copia.statusCode).toBe(201);
    expect(copia.json().esPredeterminada).toBe(false);
    expect(await marcadas()).toEqual([a.id]);
  });
});

describe("solo administración, y la visibilidad no cambia", () => {
  it("delegado y nadador reciben 403 al marcar o quitar, y nada cambia", async () => {
    const a = await crearCompetencia("A sintética");
    for (const token of [tokens.delegado, tokens.nadador]) {
      expect((await marcar(token, a.id)).statusCode).toBe(403);
      expect((await quitar(token, a.id)).statusCode).toBe(403);
    }
    expect(await marcadas()).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "COMPETITION_DEFAULT" } } })).toBe(0);
  });

  it("una predeterminada en Borrador no llega a quien no administra; una abierta sí, con su marca", async () => {
    const borrador = await crearCompetencia("Borrador sintético", "draft");
    const abierta = await crearCompetencia("Abierta sintética", "open");
    await marcar(tokens.admin, borrador.id);

    const listaDelegado = (await app.inject({ method: "GET", url: "/competitions?visibleInRegistrationPanels=true&pageSize=50", headers: auth(tokens.delegado) })).json();
    expect(listaDelegado.items.map((c: any) => c.id)).toEqual([abierta.id]);
    expect(listaDelegado.items.some((c: any) => c.esPredeterminada)).toBe(false);

    await marcar(tokens.admin, abierta.id);
    const otra = (await app.inject({ method: "GET", url: "/competitions?visibleInRegistrationPanels=true&pageSize=50", headers: auth(tokens.nadador) })).json();
    expect(otra.items.find((c: any) => c.id === abierta.id).esPredeterminada).toBe(true);
  });
});
