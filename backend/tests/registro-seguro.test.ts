/**
 * AUD-03 — lo que se escribe en los registros de la API.
 *
 * Sin base de datos y sin configuración: se monta un Fastify mínimo con las MISMAS opciones de
 * registro (`opcionesDeRegistro`) y el MISMO manejador de errores (`manejadorDeErrores`) que usa
 * `server.ts`, y se captura todo lo que escribe en un flujo en memoria. Lo que se simula son las
 * rutas y los errores (clases con la forma de los de Prisma); el registrador es el real.
 *
 * Marcadores sintéticos: ninguna persona real. Si algún marcador aparece en una línea del
 * registro, la prueba falla.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { opcionesDeRegistro, errorSeguro, urlSinConsulta, ControladorDeRegistroSeguro } from "../src/shared/registro";
import { manejadorDeErrores } from "../src/shared/manejadorDeErrores";
import { ValidationError, NotFoundError } from "../src/shared/errors";

const RUN_SINTETICO = "77123456-K";
const NOMBRE_SINTETICO = "Zzyxa Marcadora Sintetica";
const CORREO_SINTETICO = "marcador.sintetico@ejemplo.invalid";
const VALOR_DE_PRISMA = "VALOR-SECRETO-SINTETICO-1234";

/** Imita a `PrismaClientKnownRequestError`: nombre, código, versión, `meta` y un mensaje con valores en varias líneas. */
class PrismaClientKnownRequestError extends Error {
  code = "P2002";
  clientVersion = "5.22.0";
  meta = { modelName: "Person", target: ["run"], valor: VALOR_DE_PRISMA };
  constructor() {
    super(
      [
        "",
        "Invalid `prisma.person.create()` invocation in /app/dist/modules/persons/persons.service.js:42:30",
        "",
        `  41 data: { run: "${RUN_SINTETICO}", fullName: "${NOMBRE_SINTETICO}", email: "${CORREO_SINTETICO}" },`,
        "  42 await tx.person.create({",
        `Unique constraint failed on the fields: (\`run\`) with value ${VALOR_DE_PRISMA}`,
      ].join("\n")
    );
    this.name = "PrismaClientKnownRequestError";
  }
}

class PrismaClientValidationError extends Error {
  clientVersion = "5.22.0";
  constructor() {
    super(`Argument \`run\` is missing. Received: { run: "${RUN_SINTETICO}", email: "${CORREO_SINTETICO}" }`);
    this.name = "PrismaClientValidationError";
  }
}

function capturar() {
  const lineas: string[] = [];
  const flujo = new Writable({
    write(trozo, _codificacion, listo) {
      lineas.push(...trozo.toString().split("\n").filter(Boolean));
      listo();
    },
  });
  return { lineas, flujo };
}

async function appConRegistro() {
  const { lineas, flujo } = capturar();
  const app = Fastify({ logger: opcionesDeRegistro(flujo), logController: new ControladorDeRegistroSeguro() });
  app.setErrorHandler(manejadorDeErrores);

  app.get("/persons", async () => ({ items: [] }));
  app.get("/falla-prisma-conocido", async () => {
    throw new PrismaClientKnownRequestError();
  });
  app.get("/falla-prisma-validacion", async () => {
    throw new PrismaClientValidationError();
  });
  app.get("/falla-desconocida", async () => {
    throw new TypeError(`no se puede leer 'x' de ${NOMBRE_SINTETICO} (${RUN_SINTETICO})`);
  });
  app.get("/falla-con-causa", async () => {
    throw new Error("externo", { cause: Object.assign(new Error(`causa con ${CORREO_SINTETICO}`), { code: "ECONNREFUSED" }) });
  });
  app.get("/error-de-aplicacion", async () => {
    throw new ValidationError(`dato inválido de ${NOMBRE_SINTETICO}`);
  });
  app.get("/no-encontrado", async () => {
    throw new NotFoundError("Persona");
  });
  await app.ready();
  return { app, lineas };
}

const MARCADORES = [RUN_SINTETICO, NOMBRE_SINTETICO, CORREO_SINTETICO, VALOR_DE_PRISMA, "77123456", "Zzyxa", "marcador.sintetico"];

function sinMarcadores(lineas: string[]) {
  const todo = lineas.join("\n");
  for (const m of MARCADORES) expect(todo, `el registro contiene el marcador «${m}»`).not.toContain(m);
}

describe("urlSinConsulta", () => {
  it("quita la cadena de consulta y el fragmento, y conserva la ruta", () => {
    expect(urlSinConsulta("/persons?search=ABC&page=2")).toBe("/persons");
    expect(urlSinConsulta("/persons/5b1c?x=1#y")).toBe("/persons/5b1c");
    expect(urlSinConsulta("/persons")).toBe("/persons");
    expect(urlSinConsulta("/?search=a")).toBe("/");
    expect(urlSinConsulta("/p?")).toBe("/p");
  });
});

describe("registro de la petición", () => {
  it("la búsqueda por nombre, RUN o correo NO queda escrita, y la ruta sí", async () => {
    const { app, lineas } = await appConRegistro();
    const url = `/persons?search=${encodeURIComponent(RUN_SINTETICO)}&nombre=${encodeURIComponent(NOMBRE_SINTETICO)}&correo=${CORREO_SINTETICO}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    await app.close();

    expect(lineas.length, "se registró algo: la prueba captura de verdad").toBeGreaterThanOrEqual(2);
    sinMarcadores(lineas);
    const registros = lineas.map((l) => JSON.parse(l));
    const entrada = registros.find((r) => r.req)!;
    expect(entrada.req.url).toBe("/persons");
    expect(entrada.req.method).toBe("GET");
    expect(JSON.stringify(registros)).not.toContain("search=");
  });

  it("también en una ruta inexistente (404): la consulta no aparece", async () => {
    const { app, lineas } = await appConRegistro();
    await app.inject({ method: "GET", url: `/no-existe?search=${encodeURIComponent(NOMBRE_SINTETICO)}` });
    await app.close();
    sinMarcadores(lineas);
  });

  it("las cabeceras de la petición no se escriben (no lo hacían ni lo hacen)", async () => {
    const { app, lineas } = await appConRegistro();
    await app.inject({ method: "GET", url: "/persons", headers: { authorization: "Bearer TOKEN-SINTETICO", cookie: "fchmn_refresh=COOKIE-SINTETICA" } });
    await app.close();
    const todo = lineas.join("\n");
    expect(todo).not.toContain("TOKEN-SINTETICO");
    expect(todo).not.toContain("COOKIE-SINTETICA");
  });
});

describe("registro de errores: lista explícita de campos", () => {
  it("un error de Prisma (P2002) deja tipo, código, versión, modelo y columnas; nada de valores, mensaje ni pila", async () => {
    const { app, lineas } = await appConRegistro();
    const res = await app.inject({ method: "GET", url: `/falla-prisma-conocido?search=${RUN_SINTETICO}` });
    await app.close();

    expect(res.statusCode, "el contrato HTTP no cambia: Prisma se traduce a 409").toBe(409);
    sinMarcadores(lineas);
    const registro = lineas.map((l) => JSON.parse(l)).find((r) => r.err);
    expect(registro, "el error se registró").toBeDefined();
    expect(registro.err).toEqual({
      tipo: "PrismaClientKnownRequestError",
      codigo: "P2002",
      versionDelCliente: "5.22.0",
      modelo: "Person",
      destino: ["run"],
    });
    expect(Object.keys(registro.err)).not.toContain("pila");
    expect(Object.keys(registro.err)).not.toContain("message");
    expect(Object.keys(registro.err)).not.toContain("meta");
  });

  it("un error de validación de Prisma (cuyo mensaje trae los valores recibidos) no deja ni el mensaje ni la pila", async () => {
    const { app, lineas } = await appConRegistro();
    const res = await app.inject({ method: "GET", url: "/falla-prisma-validacion" });
    await app.close();

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    sinMarcadores(lineas);
    const registro = lineas.map((l) => JSON.parse(l)).find((r) => r.err);
    expect(registro.err).toEqual({ tipo: "PrismaClientValidationError", versionDelCliente: "5.22.0" });
  });

  it("un error desconocido (500) deja la clase y los marcos de la pila, pero no su mensaje", async () => {
    const { app, lineas } = await appConRegistro();
    const res = await app.inject({ method: "GET", url: "/falla-desconocida" });
    await app.close();

    expect(res.statusCode).toBe(500);
    expect(res.json().message).not.toContain(NOMBRE_SINTETICO);
    sinMarcadores(lineas);
    const registro = lineas.map((l) => JSON.parse(l)).find((r) => r.err);
    expect(registro.err.tipo).toBe("TypeError");
    expect(Array.isArray(registro.err.pila)).toBe(true);
    expect(registro.err.pila.length).toBeGreaterThan(0);
    for (const marco of registro.err.pila as string[]) expect(marco).toMatch(/^at .*:\d+:\d+\)?$/);
  });

  it("la causa se reduce a su clase y su código, sin su mensaje", async () => {
    const { app, lineas } = await appConRegistro();
    await app.inject({ method: "GET", url: "/falla-con-causa" });
    await app.close();
    sinMarcadores(lineas);
    const registro = lineas.map((l) => JSON.parse(l)).find((r) => r.err);
    expect(registro.err).toMatchObject({ tipo: "Error", tipoCausa: "Error", codigoCausa: "ECONNREFUSED" });
  });

  it("los errores de aplicación esperados (400, 404) no se registran: no cambia", async () => {
    const { app, lineas } = await appConRegistro();
    const a = await app.inject({ method: "GET", url: "/error-de-aplicacion" });
    const b = await app.inject({ method: "GET", url: "/no-encontrado" });
    await app.close();
    expect([a.statusCode, b.statusCode]).toEqual([400, 404]);
    expect(lineas.map((l) => JSON.parse(l)).filter((r) => r.err)).toHaveLength(0);
    sinMarcadores(lineas);
  });

  it("el cuerpo de la respuesta HTTP conserva su contrato (código, mensaje y detalles)", async () => {
    const { app } = await appConRegistro();
    const res = await app.inject({ method: "GET", url: "/error-de-aplicacion" });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.any(String), message: expect.stringContaining("dato inválido") });
  });
});

describe("correlación", () => {
  it("la línea del error lleva el mismo reqId que las líneas de acceso de esa petición", async () => {
    const { app, lineas } = await appConRegistro();
    await app.inject({ method: "GET", url: "/falla-prisma-conocido" });
    await app.close();

    const registros = lineas.map((l) => JSON.parse(l));
    const error = registros.find((r) => r.err);
    expect(error.reqId, "el error se registra con el registro de la petición").toBeTruthy();
    const delMismoReqId = registros.filter((r) => r.reqId === error.reqId);
    expect(delMismoReqId.length, "entrada, error y respuesta de una misma petición").toBeGreaterThanOrEqual(3);
    expect(delMismoReqId.some((r) => r.req)).toBe(true);
    expect(delMismoReqId.some((r) => r.res)).toBe(true);
  });
});

describe("errorSeguro", () => {
  it("no es un volcado: valores que no son errores se reducen al tipo", () => {
    expect(errorSeguro("texto con RUN 77123456-K")).toEqual({ tipo: "string" });
    expect(errorSeguro(null)).toEqual({ tipo: "object" });
    expect(errorSeguro(42)).toEqual({ tipo: "number" });
  });

  it("descarta códigos y destinos que no son identificadores", () => {
    const e = Object.assign(new Error("x"), { code: "con espacios y RUN 77123456-K", statusCode: 99_999 });
    expect(errorSeguro(e)).toMatchObject({ tipo: "Error" });
    expect(errorSeguro(e)).not.toHaveProperty("codigo");
    expect(errorSeguro(e)).not.toHaveProperty("estado");

    const p = new PrismaClientKnownRequestError();
    p.meta = { modelName: "Person", target: ["run", "valor con espacios"], valor: VALOR_DE_PRISMA } as typeof p.meta;
    expect(errorSeguro(p)).not.toHaveProperty("destino");
    expect(JSON.stringify(errorSeguro(p))).not.toContain(VALOR_DE_PRISMA);
  });

  it("solo toma de la pila las líneas con forma de marco de llamada", () => {
    const e = new Error("mensaje");
    e.stack = [
      "Error: mensaje con 77123456-K",
      `    algo que no es un marco ${NOMBRE_SINTETICO}`,
      "    at funcionA (/app/dist/a.js:10:5)",
      `  at con dos espacios ${CORREO_SINTETICO}`,
      "    at async funcionB (/app/dist/b.js:20:7)",
    ].join("\n");
    const salida = errorSeguro(e);
    expect(salida.pila).toEqual(["at funcionA (/app/dist/a.js:10:5)", "at async funcionB (/app/dist/b.js:20:7)"]);
    expect(JSON.stringify(salida)).not.toContain("77123456");
  });
});
