/**
 * MENSAJE DEL LOGIN — validación y texto por defecto, como funciones puras (sin base de datos).
 *
 *  - La normalización conserva los saltos de línea interiores y unifica `\r\n`.
 *  - Rechaza lo vacío, lo que supera el máximo, lo que no es texto y los caracteres de control.
 *  - El texto por defecto es el mensaje vigente completo, y coincide EXACTAMENTE con el respaldo
 *    de la interfaz (`frontend/src/modules/auth/mensajeDeAcceso.ts`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAXIMO_MENSAJE_LOGIN, MENSAJE_LOGIN_POR_DEFECTO, normalizarMensajeLogin } from "../src/modules/parametros/parametros.service";

describe("normalizarMensajeLogin", () => {
  it("conserva los saltos interiores, unifica \\r\\n y recorta los extremos", () => {
    expect(normalizarMensajeLogin("  Línea uno\r\nLínea dos\r\rTres\n\n")).toBe("Línea uno\nLínea dos\n\nTres");
  });

  it("conserva el HTML como texto: no lo interpreta ni lo quita", () => {
    expect(normalizarMensajeLogin("<b>hola</b>")).toBe("<b>hola</b>");
  });

  it.each([
    ["vacío", ""],
    ["solo espacios y saltos", "  \n\t \r\n "],
  ])("rechaza un mensaje %s", (_caso, valor) => {
    expect(() => normalizarMensajeLogin(valor)).toThrow("El mensaje no puede quedar vacío.");
  });

  it("acepta exactamente el máximo y rechaza uno más", () => {
    expect(normalizarMensajeLogin("a".repeat(MAXIMO_MENSAJE_LOGIN))).toHaveLength(MAXIMO_MENSAJE_LOGIN);
    expect(() => normalizarMensajeLogin("a".repeat(MAXIMO_MENSAJE_LOGIN + 1))).toThrow(/no puede superar los 1000 caracteres/);
  });

  it("cuenta caracteres, no unidades UTF-16: 1000 emojis caben", () => {
    expect(() => normalizarMensajeLogin("🏊".repeat(MAXIMO_MENSAJE_LOGIN))).not.toThrow();
  });

  it.each([null, 5, { texto: "x" }])("rechaza lo que no es texto (%s)", (valor) => {
    expect(() => normalizarMensajeLogin(valor)).toThrow("El mensaje debe ser texto.");
  });

  it("rechaza caracteres de control, salvo el salto de línea y el tabulador", () => {
    expect(() => normalizarMensajeLogin("hola\u0000")).toThrow("caracteres no permitidos");
    expect(() => normalizarMensajeLogin("hola\u001b[31m")).toThrow("caracteres no permitidos");
    expect(normalizarMensajeLogin("a\tb\nc")).toBe("a\tb\nc");
  });
});

describe("texto por defecto", () => {
  it("es el mensaje vigente completo, con su pregunta inicial", () => {
    expect(MENSAJE_LOGIN_POR_DEFECTO).toBe(
      "¿Olvidó su contraseña? Solicite a un administrador de la Federación que restablezca su acceso: recibirá una contraseña temporal y el sistema le pedirá definir una nueva al ingresar."
    );
    expect(normalizarMensajeLogin(MENSAJE_LOGIN_POR_DEFECTO)).toBe(MENSAJE_LOGIN_POR_DEFECTO);
  });

  it("coincide con el respaldo de la interfaz", () => {
    const fuente = readFileSync(join(__dirname, "..", "..", "frontend", "src", "modules", "auth", "mensajeDeAcceso.ts"), "utf8");
    const m = fuente.match(/export const MENSAJE_DE_ACCESO_POR_DEFECTO =\s*"([^"]+)";/);
    expect(m, "no se encontró MENSAJE_DE_ACCESO_POR_DEFECTO en la interfaz").not.toBeNull();
    expect(m![1]).toBe(MENSAJE_LOGIN_POR_DEFECTO);
  });
});
