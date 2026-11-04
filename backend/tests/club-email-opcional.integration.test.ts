/**
 * Etapa 8 — el correo del club es OPCIONAL, probado por HTTP contra la base real.
 *
 * La ausencia es `NULL`, nunca una cadena vacía ni un correo provisional. En la
 * edición, omitir el campo conserva el valor y enviar `null`, vacío o solo
 * espacios lo elimina. Un correo informado debe tener formato válido.
 *
 * Solo corre contra la base desechable (`vitest.integration.config.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, TEST_PASSWORD } from "./helpers/seedRbac";

let app: FastifyInstance;
let token = "";
let contador = 0;

const auth = () => ({ authorization: `Bearer ${token}` });

/** Cuerpo de alta SIN el campo `email`: cada prueba agrega el suyo. */
function cuerpo(extra: Record<string, unknown> = {}) {
  contador += 1;
  return {
    name: `Club Correo ${contador}`,
    code: `E${contador}`,
    username: `club.correo.${contador}`,
    hasLegalStatus: false,
    isAchmnMember: false,
    isAchmnCollaborator: false,
    isFchmnMember: false,
    isFchmnCollaborator: false,
    ...extra,
  };
}

const crear = (extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/clubs", headers: auth(), payload: cuerpo(extra) });
const editar = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: `/clubs/${id}`, headers: auth(), payload: { hasLegalStatus: false, ...payload } });
const leer = (id: string) => app.inject({ method: "GET", url: `/clubs/${id}`, headers: auth() });
const emailEnBase = async (id: string) => (await prisma.club.findUniqueOrThrow({ where: { id } })).email;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  await truncateAllTables(prisma as unknown as Parameters<typeof truncateAllTables>[0]);
  await seedRolesAndPermissions();
  await createUser({ username: "admin_correo", roleNames: ["admin"] });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin_correo", password: TEST_PASSWORD } });
  token = res.json().accessToken;
});

afterAll(async () => {
  await truncateAllTables(prisma as unknown as Parameters<typeof truncateAllTables>[0]);
  await app?.close();
  await prisma.$disconnect();
});

describe("alta de un club", () => {
  it("SIN el campo email: se crea y queda NULL", async () => {
    const res = await crear();
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().email).toBeNull();
    expect(await emailEnBase(res.json().id)).toBeNull();
  });

  it.each([[null], [""], ["   "]])("con email %j: se crea y queda NULL, nunca una cadena vacía", async (email) => {
    const res = await crear({ email });
    expect(res.statusCode, res.body).toBe(201);
    expect(await emailEnBase(res.json().id)).toBeNull();
  });

  it("con un correo válido: se guarda recortado", async () => {
    const res = await crear({ email: "  contacto@club.example.invalid  " });
    expect(res.statusCode, res.body).toBe(201);
    expect(await emailEnBase(res.json().id)).toBe("contacto@club.example.invalid");
  });

  it("con un correo mal formado: 400 y no se crea el club", async () => {
    const antes = await prisma.club.count();
    const res = await crear({ email: "no-es-un-correo" });
    expect(res.statusCode).toBe(400);
    expect(await prisma.club.count()).toBe(antes);
  });
});

describe("lectura de un club sin correo", () => {
  it("el detalle y el listado devuelven email null sin fallar", async () => {
    const creado = await crear();
    const id = creado.json().id as string;

    const detalle = await leer(id);
    expect(detalle.statusCode).toBe(200);
    expect(detalle.json().email).toBeNull();

    const lista = await app.inject({ method: "GET", url: "/clubs?pageSize=100", headers: auth() });
    expect(lista.statusCode).toBe(200);
    expect((lista.json().items as { id: string; email: string | null }[]).find((c) => c.id === id)?.email).toBeNull();
  });
});

describe("edición", () => {
  it("OMITIR el campo conserva el correo", async () => {
    const id = (await crear({ email: "queda@club.example.invalid" })).json().id as string;
    const res = await editar(id, { name: "Nombre cambiado" });
    expect(res.statusCode, res.body).toBe(200);
    expect(await emailEnBase(id)).toBe("queda@club.example.invalid");
    expect((await prisma.club.findUniqueOrThrow({ where: { id } })).name).toBe("Nombre cambiado");
  });

  it.each([[null], [""], ["   "]])("enviar email %j lo ELIMINA (NULL)", async (email) => {
    const id = (await crear({ email: "se.va@club.example.invalid" })).json().id as string;
    const res = await editar(id, { email });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().email).toBeNull();
    expect(await emailEnBase(id)).toBeNull();
  });

  it("agregar el correo a un club que no lo tenía", async () => {
    const id = (await crear()).json().id as string;
    const res = await editar(id, { email: "nuevo@club.example.invalid" });
    expect(res.statusCode, res.body).toBe(200);
    expect(await emailEnBase(id)).toBe("nuevo@club.example.invalid");
  });

  it("un correo mal formado se rechaza y NO modifica el existente", async () => {
    const id = (await crear({ email: "intacto@club.example.invalid" })).json().id as string;
    const res = await editar(id, { email: "roto" });
    expect(res.statusCode).toBe(400);
    expect(await emailEnBase(id)).toBe("intacto@club.example.invalid");
  });
});

describe("la base impide la cadena vacía aunque se salte la API", () => {
  it("SQL directo con '' o espacios es rechazado por clubs_email_no_vacio", async () => {
    const id = (await crear({ email: "sql@club.example.invalid" })).json().id as string;
    for (const vacio of ["", "   "]) {
      await expect(prisma.$executeRawUnsafe(`UPDATE clubs SET email = $1 WHERE id = $2`, vacio, id)).rejects.toThrow(/clubs_email_no_vacio/);
    }
    expect(await emailEnBase(id)).toBe("sql@club.example.invalid");
  });
});
