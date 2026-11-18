/**
 * MENSAJE DEL LOGIN editable por administración (`parametros.service.ts`, migración
 * `20261118000000_parametros_sistema`), por HTTP contra la base desechable.
 *
 *  - Lectura PÚBLICA sin sesión: responde solo `{ texto }`; sin fila, el texto por defecto.
 *  - Edición SOLO administrativa: sin token 401; delegado y nadador 403, también por llamada directa.
 *  - Persistencia: lo guardado lo lee el login en la siguiente solicitud, con sus saltos de línea.
 *  - Validación: vacío, largo, tipo y campos extra se rechazan sin escribir ni auditar.
 *  - Auditoría `LOGIN_MESSAGE_UPDATED` en la misma transacción; repetir el texto no audita, y la
 *    respuesta pública no expone quién ni cuándo.
 *  - La base exige por su cuenta un texto no vacío y acotado.
 *
 * Datos sintéticos. Solo contra la base desechable (ver `helpers/testDb.ts`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addClubStaff, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";
import { MENSAJE_LOGIN_POR_DEFECTO } from "../src/modules/parametros/parametros.service";

let app: FastifyInstance;
let tokens: { admin: string; delegado: string; nadador: string };
let adminId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username} devolvió ${res.statusCode}`);
  return res.json().accessToken as string;
}
const leerPublico = () => app.inject({ method: "GET", url: "/mensaje-de-acceso" });
const leerAdmin = (token?: string) => app.inject({ method: "GET", url: "/administracion/mensaje-de-acceso", headers: token ? auth(token) : {} });
const guardar = (payload: unknown, token?: string) =>
  app.inject({ method: "PUT", url: "/administracion/mensaje-de-acceso", headers: token ? auth(token) : {}, payload: payload as object });
const auditorias = () => prisma.auditLog.findMany({ where: { action: "LOGIN_MESSAGE_UPDATED" }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  app = await buildServer();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_msg", roleNames: ["admin"] });
  adminId = admin.id;
  const club = await createClub("Club Mensaje Sintético", "MSJ");
  const delegado = await createPerson({ run: "30000201", username: "deleg_msg", firstName: "Delia", gender: "female", roles: ["delegate"] });
  await addClubStaff(club.id, delegado.id, "delegate");
  await createUser({ username: "deleg_msg", roleNames: ["delegate"], personId: delegado.id });
  const nadador = await createPerson({ run: "30000202", username: "nad_msg", firstName: "Nolberto", gender: "male", roles: ["swimmer"] });
  await addActiveMembership(club.id, nadador.id, admin.id);
  await createUser({ username: "nad_msg", roleNames: ["swimmer"], personId: nadador.id });
  tokens = { admin: await login("admin_msg"), delegado: await login("deleg_msg"), nadador: await login("nad_msg") };
});

afterAll(async () => {
  await app.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("migración", () => {
  it("crea la tabla vacía: sin fila rige el texto por defecto", async () => {
    expect(await prisma.parametroSistema.count()).toBe(0);
    const columnas = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'parametros_sistema' ORDER BY ordinal_position`;
    expect(columnas.map((c) => c.column_name)).toEqual(["clave", "valor", "actualizado_en"]);
  });

  it("la base rechaza por su cuenta un valor vacío o de más de 4000 caracteres", async () => {
    await expect(prisma.$executeRaw`INSERT INTO parametros_sistema (clave, valor) VALUES ('login.mensaje', '   ')`).rejects.toThrow();
    await expect(prisma.$executeRaw`INSERT INTO parametros_sistema (clave, valor) VALUES ('login.mensaje', ${"x".repeat(4001)})`).rejects.toThrow();
    expect(await prisma.parametroSistema.count()).toBe(0);
  });
});

describe("lectura pública", () => {
  it("sin sesión responde 200 solo con el texto por defecto, sin almacenar en caché", async () => {
    const r = await leerPublico();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ texto: MENSAJE_LOGIN_POR_DEFECTO });
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("tras guardar, expone SOLO el texto: ni la fecha ni quién lo cambió", async () => {
    await guardar({ texto: "Nuevo mensaje sintético" }, tokens.admin);
    const r = await leerPublico();
    expect(r.json()).toEqual({ texto: "Nuevo mensaje sintético" });
    expect(Object.keys(r.json())).toEqual(["texto"]);
    expect(r.body).not.toContain(adminId);
    expect(r.body).not.toContain("admin_msg");
  });

  it("ignora un token inválido: la lectura no depende de la sesión", async () => {
    const r = await app.inject({ method: "GET", url: "/mensaje-de-acceso", headers: auth("token-invalido") });
    expect(r.statusCode).toBe(200);
  });
});

describe("edición solo administrativa", () => {
  it("sin token: 401 al leer y al guardar, sin escribir", async () => {
    expect((await leerAdmin()).statusCode).toBe(401);
    expect((await guardar({ texto: "Intento sin sesión" })).statusCode).toBe(401);
    expect(await prisma.parametroSistema.count()).toBe(0);
  });

  it.each(["delegado", "nadador"] as const)("%s: 403 al leer y al guardar, sin escribir ni auditar", async (rol) => {
    expect((await leerAdmin(tokens[rol])).statusCode).toBe(403);
    const r = await guardar({ texto: "Intento sin permiso" }, tokens[rol]);
    expect(r.statusCode).toBe(403);
    expect(await prisma.parametroSistema.count()).toBe(0);
    expect(await auditorias()).toHaveLength(0);
    expect((await leerPublico()).json().texto).toBe(MENSAJE_LOGIN_POR_DEFECTO);
  });

  it("administración lee el estado completo y guarda; el login lo lee en la siguiente solicitud", async () => {
    const antes = (await leerAdmin(tokens.admin)).json();
    expect(antes).toMatchObject({ texto: MENSAJE_LOGIN_POR_DEFECTO, porDefecto: true, maximo: 1000, actualizadoEn: null });

    const r = await guardar({ texto: "  Primera línea\r\nSegunda línea  " }, tokens.admin);
    expect(r.statusCode).toBe(200);
    expect(r.json().cambio).toBe(true);
    expect(r.json().mensaje).toMatchObject({ texto: "Primera línea\nSegunda línea", porDefecto: false });

    expect((await leerPublico()).json()).toEqual({ texto: "Primera línea\nSegunda línea" });
    const fila = await prisma.parametroSistema.findUniqueOrThrow({ where: { clave: "login.mensaje" } });
    expect(fila.valor).toBe("Primera línea\nSegunda línea");
  });
});

describe("validación", () => {
  it.each([
    ["vacío", { texto: "" }],
    ["solo espacios", { texto: "  \n  " }],
    ["demasiado largo", { texto: "x".repeat(1001) }],
    ["no es texto", { texto: 123 }],
    ["sin el campo", {}],
    ["con campos extra", { texto: "Válido", porDefecto: true }],
  ])("rechaza un mensaje %s con 400, sin escribir ni auditar", async (_caso, cuerpo) => {
    const r = await guardar(cuerpo, tokens.admin);
    expect(r.statusCode).toBe(400);
    expect(await prisma.parametroSistema.count()).toBe(0);
    expect(await auditorias()).toHaveLength(0);
  });

  it("un rechazo posterior conserva el texto guardado", async () => {
    await guardar({ texto: "Texto vigente" }, tokens.admin);
    expect((await guardar({ texto: "" }, tokens.admin)).statusCode).toBe(400);
    expect((await leerPublico()).json().texto).toBe("Texto vigente");
  });
});

describe("auditoría", () => {
  it("registra el texto anterior y el nuevo, con el autor; repetir el mismo texto no escribe ni audita", async () => {
    await guardar({ texto: "Versión uno" }, tokens.admin);
    await guardar({ texto: "Versión dos" }, tokens.admin);
    const repetido = await guardar({ texto: "Versión dos" }, tokens.admin);
    expect(repetido.json().cambio).toBe(false);

    const filas = await auditorias();
    expect(filas.map((f) => [f.userId, f.entityType, f.entityId, f.before, f.after])).toEqual([
      [adminId, "ParametroSistema", "login.mensaje", { texto: MENSAJE_LOGIN_POR_DEFECTO, porDefecto: true }, { texto: "Versión uno" }],
      [adminId, "ParametroSistema", "login.mensaje", { texto: "Versión uno", porDefecto: false }, { texto: "Versión dos" }],
    ]);
  });

  it("dos guardados simultáneos dejan uno de los dos textos y dos auditorías encadenadas", async () => {
    const [a, b] = await Promise.all([guardar({ texto: "Simultáneo A" }, tokens.admin), guardar({ texto: "Simultáneo B" }, tokens.admin)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const filas = await auditorias();
    expect(filas).toHaveLength(2);
    const final = (await leerPublico()).json().texto;
    expect(["Simultáneo A", "Simultáneo B"]).toContain(final);
    // La segunda auditoría parte del texto que dejó la primera: no hay una «anterior» perdida.
    const [primera, segunda] = filas as [(typeof filas)[number], (typeof filas)[number]];
    expect((segunda.before as { texto: string }).texto).toBe((primera.after as { texto: string }).texto);
    expect((segunda.after as { texto: string }).texto).toBe(final);
  });
});
