/**
 * Una actualización parcial NO restablece lo que no envía (SEC-03 C).
 *
 * Zod 4 aplica los valores por omisión también dentro de campos opcionales, así que un esquema de actualización derivado del
 * de creación con `.partial()` rellenaría `isHeated`, `isCovered` y los indicadores de membresía con `false`. Aquí se comprueba
 * de punta a punta —HTTP, esquema, servicio y base— que editar sin esos campos conserva los valores ya guardados, y que enviarlos,
 * incluso en `false`, sí los cambia. Datos sintéticos, sobre la base desechable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { buildServer } from "../src/server";
import { seedRolesAndPermissions, createClub, createUser, TEST_PASSWORD } from "./helpers/seedRbac";

let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();
  await createUser({ username: "admin_actualizaciones", roleNames: ["admin"] });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin_actualizaciones", password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login devolvió ${res.statusCode}: ${res.body}`);
  token = res.json().accessToken as string;
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("piscinas: editar sin los indicadores los conserva", () => {
  it("cambiar solo el nombre deja isHeated e isCovered como estaban (true)", async () => {
    const piscina = await prisma.pool.create({ data: { name: "Piscina Sintética A", isHeated: true, isCovered: true, courseLength: "short_25m" } });

    const res = await app.inject({ method: "PUT", url: `/pools/${piscina.id}`, headers: auth(), payload: { name: "Piscina Sintética A2" } });
    expect(res.statusCode, res.body).toBe(200);

    const guardada = await prisma.pool.findUniqueOrThrow({ where: { id: piscina.id } });
    expect(guardada).toMatchObject({ name: "Piscina Sintética A2", isHeated: true, isCovered: true, courseLength: "short_25m" });
  });

  it("enviar un indicador en false SÍ lo cambia, y no arrastra al otro", async () => {
    const piscina = await prisma.pool.create({ data: { name: "Piscina Sintética B", isHeated: true, isCovered: true, courseLength: "long_50m" } });

    const res = await app.inject({ method: "PUT", url: `/pools/${piscina.id}`, headers: auth(), payload: { isHeated: false } });
    expect(res.statusCode, res.body).toBe(200);

    const guardada = await prisma.pool.findUniqueOrThrow({ where: { id: piscina.id } });
    expect(guardada).toMatchObject({ isHeated: false, isCovered: true, courseLength: "long_50m" });
  });
});

describe("clubes: editar sin los indicadores de membresía los conserva", () => {
  it("cambiar solo el nombre deja las cuatro membresías como estaban", async () => {
    const club = await createClub("Club Sintético Edición", "EDIC");
    await prisma.club.update({ where: { id: club.id }, data: { isAchmnMember: true, isFchmnCollaborator: true } });

    const res = await app.inject({ method: "PUT", url: `/clubs/${club.id}`, headers: auth(), payload: { hasLegalStatus: false, name: "Club Sintético Edición 2" } });
    expect(res.statusCode, res.body).toBe(200);

    const guardado = await prisma.club.findUniqueOrThrow({ where: { id: club.id } });
    expect(guardado).toMatchObject({
      name: "Club Sintético Edición 2",
      isAchmnMember: true,
      isAchmnCollaborator: false,
      isFchmnMember: false,
      isFchmnCollaborator: true,
    });
  });

  it("enviar una membresía en false SÍ la cambia, y no toca las demás", async () => {
    const club = await createClub("Club Sintético Cambio", "CAMB");
    await prisma.club.update({ where: { id: club.id }, data: { isAchmnMember: true, isFchmnMember: true } });

    const res = await app.inject({ method: "PUT", url: `/clubs/${club.id}`, headers: auth(), payload: { hasLegalStatus: false, isAchmnMember: false } });
    expect(res.statusCode, res.body).toBe(200);

    const guardado = await prisma.club.findUniqueOrThrow({ where: { id: club.id } });
    expect(guardado).toMatchObject({ isAchmnMember: false, isFchmnMember: true });
  });
});

describe("errores HTTP de validación en actualizaciones", () => {
  it("un cuerpo inválido responde 400 VALIDATION_ERROR con {formErrors, fieldErrors} y el mensaje personalizado", async () => {
    const club = await createClub("Club Sintético Error", "ERRO");
    const res = await app.inject({ method: "PUT", url: `/clubs/${club.id}`, headers: auth(), payload: { name: "Otro nombre" } });
    expect(res.statusCode).toBe(400);
    const cuerpo = res.json();
    expect(cuerpo.error).toBe("VALIDATION_ERROR");
    expect(cuerpo.details.formErrors).toEqual([]);
    expect(cuerpo.details.fieldErrors.hasLegalStatus[0]).toMatch(/^Indique si el club tiene personalidad jurídica/);
  });
});
