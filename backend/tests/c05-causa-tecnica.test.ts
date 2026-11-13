/**
 * C-05: la causa de un fallo técnico de la postulación llega al registro SANEADA, y nada sensible
 * sale ni en el registro ni en la respuesta. Errores sintéticos con datos «sensibles» en todos los
 * lugares posibles (mensaje, `name`, `code`, `meta`, pila, causa anidada). Sin base de datos: el
 * singleton de Prisma está simulado y la transacción falla a voluntad.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { Prisma } from "@prisma/client";

const transaccion = vi.fn();
vi.mock("../src/shared/prisma.client", () => ({
  prisma: {
    club: { findFirst: vi.fn(async () => ({ status: "active" })) },
    $transaction: (...a: unknown[]) => transaccion(...a),
    $executeRaw: vi.fn(async () => 1),
  },
}));

import { causaSaneada, errorTecnico } from "../src/modules/incorporaciones/causaTecnica";
import { configurarIncorporaciones, postularComoClub, completarAlta } from "../src/modules/incorporaciones/postulacion.service";
import { opcionesDeRegistro, errorSeguro, ControladorDeRegistroSeguro } from "../src/shared/registro";
import { manejadorDeErrores } from "../src/shared/manejadorDeErrores";
import { resolveErrorResponse } from "../src/shared/httpErrorResponse";
import { AppError, ServiceUnavailableError } from "../src/shared/errors";
import type { ActorContext } from "../src/shared/actorContext";

const RUN = "12345678-5";
const NOMBRE = "Zzyxa Marcadora Sintetica";
const CORREO = "marcador.sintetico@ejemplo.invalid";
const CLAVE_SECRETA = "clave-sintetica-NO-debe-salir";
const CONSULTA = `SELECT * FROM persons WHERE run = '${RUN}'`;
const SENSIBLES = [RUN, "12345678", "123456785", NOMBRE, "Zzyxa", CORREO, CLAVE_SECRETA, CONSULTA, "persons WHERE"];

/** Un error «hostil»: datos sensibles en el mensaje, el nombre, el código, la pila y la causa. */
class Perez extends Error {
  code = RUN;
  meta = { valor: NOMBRE, consulta: CONSULTA };
  constructor() {
    super(`Fallo al guardar ${NOMBRE} (${RUN}) <${CORREO}> con ${CLAVE_SECRETA}: ${CONSULTA}`, { cause: new Error(`${NOMBRE} ${RUN}`) });
    this.name = NOMBRE;
    this.stack = `${NOMBRE}: ${RUN}\n    at ${NOMBRE} (${RUN}.js:1:1)`;
  }
}
const prismaHostil = () => {
  const e = new Prisma.PrismaClientKnownRequestError(`Invalid invocation ${CONSULTA} value ${RUN} ${NOMBRE}`, { code: "P2002", clientVersion: "5.22.0", meta: { target: [RUN], valor: NOMBRE } });
  return e;
};

const sinSensibles = (texto: string) => {
  for (const s of SENSIBLES) expect(texto, `«${s}» no debe aparecer`).not.toContain(s);
};

const actorDeClub: ActorContext = { userId: "u-1", isAdmin: false, scope: { kind: "club", clubId: "00000000-0000-4000-8000-000000000001" }, canRegisterPostClose: false };

beforeEach(() => {
  transaccion.mockReset();
  configurarIncorporaciones("s".repeat(40));
});

describe("causaSaneada: solo metadatos de listas permitidas", () => {
  it.each([
    ["error hostil con nombre y código inventados", () => new Perez(), { name: "Error" }],
    ["Prisma conocido: clase y código P####", prismaHostil, { name: "PrismaClientKnownRequestError", code: "P2002" }],
    ["error de sistema: código E…", () => Object.assign(new Error(`${RUN}`), { code: "ECONNREFUSED" }), { name: "Error", code: "ECONNREFUSED" }],
    ["error de sistema con código que no es de sistema", () => Object.assign(new Error("x"), { code: "E12345678-5" }), { name: "Error" }],
    // `INTERNAL_ERROR` no es un código de `AppError` (lo arma `httpErrorResponse` para errores desconocidos): no está en la lista.
    ["AppError con código de la aplicación", () => new AppError(409, "CONFLICT", `${RUN}`), { name: "AppError", code: "CONFLICT" }],
    ["AppError con INTERNAL_ERROR (no es un código de AppError)", () => new AppError(500, "INTERNAL_ERROR", `${RUN}`), { name: "AppError" }],
    ["AppError con dígitos en el código", () => new AppError(500, "RUN_12345678", "x"), { name: "AppError" }],
    ["TypeError nativo", () => new TypeError(`${NOMBRE}`), { name: "TypeError" }],
    ["un valor que no es un error", () => `${RUN} ${NOMBRE}`, { name: "NoEsError" }],
  ])("%s", (_caso, crear, esperado) => {
    const causa = causaSaneada(crear());
    expect({ ...causa }).toEqual(esperado);
    expect(Object.getPrototypeOf(causa), "sin prototipo: nada heredado").toBeNull();
    sinSensibles(JSON.stringify({ ...causa }));
  });
});

describe("el 503 conserva la respuesta genérica y lleva la causa saneada al registro", () => {
  it("errorSeguro y la respuesta HTTP no contienen datos sensibles", () => {
    const e = errorTecnico(new Perez());
    expect(e).toBeInstanceOf(ServiceUnavailableError);
    const registro = errorSeguro(e);
    expect(registro).toMatchObject({ tipo: "ServiceUnavailableError", codigo: "SERVICE_UNAVAILABLE", estado: 503, tipoCausa: "Error" });
    sinSensibles(JSON.stringify(registro));
    const { status, body } = resolveErrorResponse(e);
    expect(status).toBe(503);
    expect(body).toEqual({ error: "SERVICE_UNAVAILABLE", message: new ServiceUnavailableError().message, details: undefined });
    sinSensibles(JSON.stringify(body));
  });

  it("por el canal real: UNA línea de error con tipoCausa y codigoCausa, y nada sensible en registro ni respuesta", async () => {
    const lineas: string[] = [];
    const flujo = new Writable({
      write(trozo, _c, listo) {
        lineas.push(...trozo.toString().split("\n").filter(Boolean));
        listo();
      },
    });
    const app = Fastify({ logger: opcionesDeRegistro(flujo), logController: new ControladorDeRegistroSeguro() });
    app.setErrorHandler(manejadorDeErrores);
    app.get("/falla", async () => {
      throw errorTecnico(prismaHostil());
    });
    const res = await app.inject({ method: "GET", url: "/falla" });
    await app.close();

    expect(res.statusCode).toBe(503);
    sinSensibles(res.body);
    sinSensibles(lineas.join("\n"));
    const errores = lineas.map((l) => JSON.parse(l)).filter((r) => r.err);
    expect(errores, "un solo registro del error: sin duplicados").toHaveLength(1);
    expect(errores[0].err).toMatchObject({ tipo: "ServiceUnavailableError", estado: 503, tipoCausa: "PrismaClientKnownRequestError", codigoCausa: "P2002" });
  });
});

describe("los tres puntos de la postulación adjuntan la causa saneada", () => {
  it("T1 (cobro): el fallo antes de confirmar responde el 503 genérico con causa saneada", async () => {
    transaccion.mockRejectedValueOnce(new Perez());
    const err = await postularComoClub({ run: "11111111-1" }, actorDeClub, "clave-de-prueba-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect({ ...(err as { cause: object }).cause }).toEqual({ name: "Error" });
    sinSensibles(JSON.stringify(errorSeguro(err)));
  });

  it("T2 (resolución): el fallo tras cobrar conserva el intento y lleva la causa saneada", async () => {
    transaccion.mockResolvedValueOnce({ tipo: "cobrado", intentoId: "i-1", token: "00000000-0000-4000-8000-000000000009", cuota: { usados: 1, limite: 30, dia: "2026-11-12" } });
    transaccion.mockRejectedValueOnce(prismaHostil());
    const err = await postularComoClub({ run: "11111111-1" }, actorDeClub, "clave-de-prueba-2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect({ ...(err as { cause: object }).cause }).toEqual({ name: "PrismaClientKnownRequestError", code: "P2002" });
    sinSensibles(JSON.stringify(errorSeguro(err)));
    sinSensibles(JSON.stringify(resolveErrorResponse(err).body));
  });

  it("segundo paso: el fallo de la transacción responde el 503 genérico con causa saneada", async () => {
    transaccion.mockRejectedValueOnce(Object.assign(new Error(`${NOMBRE} ${RUN}`), { code: "ETIMEDOUT" }));
    const err = await completarAlta({ intentoId: "00000000-0000-4000-8000-000000000002", nombres: NOMBRE, apellidos: "Sintetica" }, actorDeClub).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect({ ...(err as { cause: object }).cause }).toEqual({ name: "Error", code: "ETIMEDOUT" });
    sinSensibles(JSON.stringify(errorSeguro(err)));
  });
});

describe("códigos NO reconocidos: se omiten aunque tengan forma de código", () => {
  /** Marcadores alfabéticos que la forma de un código (mayúsculas, «E…») no basta para rechazar. */
  const MARCADORES = ["CLAVE_SECRETA_SINTETICA", "ESECRETOALFABETICO", "EZZYXAMARCADORA", "RUN_DE_PERSONA_SINTETICA", "P9999"];

  it.each([
    ["AppError con código inventado", () => new AppError(500, "CLAVE_SECRETA_SINTETICA", "x"), "AppError"],
    ["AppError con otro marcador", () => new AppError(503, "RUN_DE_PERSONA_SINTETICA", "x"), "AppError"],
    ["error de sistema con código inventado", () => Object.assign(new Error("x"), { code: "ESECRETOALFABETICO" }), "Error"],
    ["TypeError con código inventado con forma de sistema", () => Object.assign(new TypeError("x"), { code: "EZZYXAMARCADORA" }), "TypeError"],
    ["Prisma con código P inexistente", () => new Prisma.PrismaClientKnownRequestError("x", { code: "P9999", clientVersion: "5.22.0" }), "PrismaClientKnownRequestError"],
  ])("%s → solo la clase", (_caso, crear, clase) => {
    const causa = causaSaneada(crear());
    expect({ ...causa }).toEqual({ name: clase });
    for (const m of MARCADORES) expect(JSON.stringify({ ...causa })).not.toContain(m);
  });

  it("por el canal real: el marcador no aparece en la causa, el registro ni la respuesta HTTP", async () => {
    const lineas: string[] = [];
    const flujo = new Writable({
      write(trozo, _c, listo) {
        lineas.push(...trozo.toString().split("\n").filter(Boolean));
        listo();
      },
    });
    const app = Fastify({ logger: opcionesDeRegistro(flujo), logController: new ControladorDeRegistroSeguro() });
    app.setErrorHandler(manejadorDeErrores);
    app.get("/falla-app", async () => {
      throw errorTecnico(new AppError(500, "CLAVE_SECRETA_SINTETICA", "x"));
    });
    app.get("/falla-sistema", async () => {
      throw errorTecnico(Object.assign(new Error("x"), { code: "ESECRETOALFABETICO" }));
    });
    const r1 = await app.inject({ method: "GET", url: "/falla-app" });
    const r2 = await app.inject({ method: "GET", url: "/falla-sistema" });
    await app.close();
    for (const texto of [r1.body, r2.body, lineas.join("\n")]) {
      expect(texto).not.toContain("CLAVE_SECRETA_SINTETICA");
      expect(texto).not.toContain("ESECRETOALFABETICO");
    }
    const errores = lineas.map((l) => JSON.parse(l)).filter((r) => r.err);
    expect(errores).toHaveLength(2);
    expect(errores[0].err.tipoCausa).toBe("AppError");
    expect(errores[0].err.codigoCausa).toBeUndefined();
    expect(errores[1].err.tipoCausa).toBe("Error");
    expect(errores[1].err.codigoCausa).toBeUndefined();
  });

  it.each([
    ["P2002", () => new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "5.22.0" }), { name: "PrismaClientKnownRequestError", code: "P2002" }],
    ["P2034", () => new Prisma.PrismaClientKnownRequestError("x", { code: "P2034", clientVersion: "5.22.0" }), { name: "PrismaClientKnownRequestError", code: "P2034" }],
    ["P1001", () => new Prisma.PrismaClientInitializationError("x", "5.22.0", "P1001"), { name: "PrismaClientInitializationError", code: "P1001" }],
    ["ECONNRESET", () => Object.assign(new Error("x"), { code: "ECONNRESET" }), { name: "Error", code: "ECONNRESET" }],
    ["SERVICE_UNAVAILABLE", () => new ServiceUnavailableError(), { name: "AppError", code: "SERVICE_UNAVAILABLE" }],
    ["CONFLICTO_DE_FECHAS", () => new AppError(409, "CONFLICTO_DE_FECHAS", "x"), { name: "AppError", code: "CONFLICTO_DE_FECHAS" }],
  ])("código legítimo %s: se conserva", (_c, crear, esperado) => {
    expect({ ...causaSaneada(crear()) }).toEqual(esperado);
  });
});
