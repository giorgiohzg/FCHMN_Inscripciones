/**
 * Etapa 10a — el contrato público de la personalidad jurídica solo admite
 * booleanos, probado por HTTP contra la base real.
 *
 * `null` (el antiguo «pendiente de verificar»), la omisión del campo y el filtro
 * `pendiente` se rechazan con 400 y un mensaje comprensible, y SIN ninguna
 * escritura de negocio: ni el club, ni su personal, ni la auditoría.
 *
 * Solo corre contra la base desechable (`vitest.integration.config.ts`), con
 * datos sintéticos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, createPerson, TEST_PASSWORD } from "./helpers/seedRbac";

let app: FastifyInstance;
let token = "";
let contador = 0;

const auth = () => ({ authorization: `Bearer ${token}` });
/** RUT evidentemente sintéticos y distintos: el sistema no admite dos clubes con el mismo. */
const RUTS = ["11111111-1", "22222222-2", "33333333-3", "44444444-4", "55555555-5", "66666666-6"];
let siguienteRut = 0;
const rutNuevo = () => RUTS[siguienteRut++]!;

function cuerpo(extra: Record<string, unknown> = {}) {
  contador += 1;
  return {
    name: `Club Sin Pendiente ${contador}`,
    code: `P${contador}`,
    username: `club.sin.pendiente.${contador}`,
    isAchmnMember: false,
    isAchmnCollaborator: false,
    isFchmnMember: false,
    isFchmnCollaborator: false,
    ...extra,
  };
}

const crear = (extra: Record<string, unknown>) => app.inject({ method: "POST", url: "/clubs", headers: auth(), payload: cuerpo(extra) });
const editar = (id: string, payload: Record<string, unknown>) => app.inject({ method: "PUT", url: `/clubs/${id}`, headers: auth(), payload });

/** Foto de todo lo que una escritura de negocio podría tocar. */
async function estadoDelNegocio() {
  const [clubes, personal, auditoria, usuarios] = await Promise.all([
    prisma.club.findMany({ orderBy: { id: "asc" } }),
    prisma.clubStaff.count(),
    prisma.auditLog.count(),
    prisma.user.count(),
  ]);
  return JSON.stringify({ clubes, personal, auditoria, usuarios });
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  await truncateAllTables(prisma as unknown as Parameters<typeof truncateAllTables>[0]);
  await seedRolesAndPermissions();
  await createUser({ username: "admin_pj", roleNames: ["admin"] });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin_pj", password: TEST_PASSWORD } });
  token = res.json().accessToken;
});

afterAll(async () => {
  await truncateAllTables(prisma as unknown as Parameters<typeof truncateAllTables>[0]);
  await app?.close();
  await prisma.$disconnect();
});

describe("alta de un club", () => {
  it.each([[true, "con RUT"], [false, undefined]])("hasLegalStatus %j: se crea", async (estado, rut) => {
    const res = await crear({ hasLegalStatus: estado, rut: rut ? rutNuevo() : undefined });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().hasLegalStatus).toBe(estado);
  });

  it("hasLegalStatus: null → 400 comprensible, sin escribir nada", async () => {
    const antes = await estadoDelNegocio();
    const res = await crear({ hasLegalStatus: null });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/Sí o No/);
    expect(res.body).toMatch(/pendiente de verificar/);
    expect(await estadoDelNegocio()).toBe(antes);
  });

  it("omitir hasLegalStatus → 400, sin escribir nada", async () => {
    const antes = await estadoDelNegocio();
    const res = await crear({});
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/hasLegalStatus/);
    expect(await estadoDelNegocio()).toBe(antes);
  });

  it("null con representante legal: 400 y no queda club ni nombramiento", async () => {
    const persona = await createPerson({ run: "60000001", username: "rep_null", firstName: "Rita", gender: "female", roles: [] });
    const antes = await estadoDelNegocio();
    const res = await crear({ hasLegalStatus: null, legalRepresentativePersonId: persona.id });
    expect(res.statusCode).toBe(400);
    expect(await estadoDelNegocio()).toBe(antes);
  });
});

describe("edición de un club", () => {
  it("hasLegalStatus: null → 400, y el club conserva su estado y su RUT", async () => {
    const rut = rutNuevo();
    const id = (await crear({ hasLegalStatus: true, rut })).json().id as string;
    const antes = await estadoDelNegocio();

    const res = await editar(id, { hasLegalStatus: null });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/Sí o No/);

    expect(await estadoDelNegocio()).toBe(antes);
    const club = await prisma.club.findUniqueOrThrow({ where: { id } });
    expect(club.hasLegalStatus).toBe(true);
    expect(club.rut).toBe(rut.replace(/[.-]/g, ""));
  });

  it("omitir hasLegalStatus → 400 y nada cambia", async () => {
    const id = (await crear({ hasLegalStatus: false })).json().id as string;
    const antes = await estadoDelNegocio();
    const res = await editar(id, { name: "Otro nombre" });
    expect(res.statusCode).toBe(400);
    expect(await estadoDelNegocio()).toBe(antes);
  });

  it("true → false sigue descartando el RUT; el representante legal sigue bloqueando el cambio", async () => {
    const persona = await createPerson({ run: "60000002", username: "rep_ok", firstName: "Rocío", gender: "female", roles: [] });
    const conRep = (await crear({ hasLegalStatus: true, rut: rutNuevo(), legalRepresentativePersonId: persona.id })).json().id as string;
    const rechazo = await editar(conRep, { hasLegalStatus: false });
    expect(rechazo.statusCode).toBe(400);
    expect(rechazo.body).toMatch(/Retírelo expresamente/);
    expect(await prisma.clubStaff.count({ where: { clubId: conRep, roleType: "legal_representative" } })).toBe(1);

    const sinRep = (await crear({ hasLegalStatus: true, rut: rutNuevo() })).json().id as string;
    const ok = await editar(sinRep, { hasLegalStatus: false });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().rut).toBeNull();
  });
});

describe("filtro del listado", () => {
  it.each([["si"], ["no"]])("acepta %j", async (valor) => {
    const res = await app.inject({ method: "GET", url: `/clubs?personalidadJuridica=${valor}`, headers: auth() });
    expect(res.statusCode).toBe(200);
  });

  it("«pendiente» → 400 con un mensaje que explica que ya no existe", async () => {
    const res = await app.inject({ method: "GET", url: "/clubs?personalidadJuridica=pendiente", headers: auth() });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/solo admite/);
    expect(res.body).toMatch(/ya no existe/);
  });

  it("el listado devuelve solo booleanos en hasLegalStatus", async () => {
    const res = await app.inject({ method: "GET", url: "/clubs?pageSize=100", headers: auth() });
    const estados = (res.json().items as { hasLegalStatus: unknown }[]).map((c) => c.hasLegalStatus);
    expect(estados.length).toBeGreaterThan(0);
    for (const e of estados) expect(typeof e).toBe("boolean");
  });
});
