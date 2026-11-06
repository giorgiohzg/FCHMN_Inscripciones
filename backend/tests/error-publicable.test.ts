/**
 * Fase 2 — qué texto de un error puede leer quien usa el sistema, sin base de datos ni `.env`.
 *
 * `mensajePublicable` es lo que usan la carga masiva de personas y la asignación masiva para
 * anotar el fallo de UNA fila. Solo se publica lo que el sistema escribió para ese fin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mensajePublicable, MENSAJE_FILA_INTERNA } from "../src/shared/errorPublicable";
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError, ValidationError } from "../src/shared/errors";

let registro: string[];

beforeEach(() => {
  registro = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    registro.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CRUDO = 'Invalid `prisma.person.create()` invocation: INSERT INTO "persons" VALUES (\'hunter2\') en /srv/app/dist/x.js';

describe("lo previsto se publica tal cual", () => {
  it.each([
    ["ValidationError", new ValidationError("El RUN no es válido"), "El RUN no es válido"],
    ["ConflictError", new ConflictError("Ya existe una solicitud pendiente"), "Ya existe una solicitud pendiente"],
    ["NotFoundError", new NotFoundError("Club"), "Club no encontrado"],
    ["ForbiddenError", new ForbiddenError("Sin permiso para esto"), "Sin permiso para esto"],
    ["ServiceUnavailableError", new ServiceUnavailableError("Intente de nuevo en unos instantes"), "Intente de nuevo en unos instantes"],
  ])("%s", (_nombre, error, esperado) => {
    expect(mensajePublicable(error, "prueba")).toBe(esperado);
    expect(registro, "un error previsto no se registra como fallo").toHaveLength(0);
  });

  it("un error de Prisma que el sistema traduce: su mensaje redactado, no el del motor", () => {
    const duplicado = Object.assign(new Error(CRUDO), { code: "P2002", meta: { modelName: "Person", target: ["run"] } });

    expect(mensajePublicable(duplicado, "prueba")).toBe("Ya existe una persona registrada con ese RUN.");
    expect(registro).toHaveLength(0);
  });
});

describe("lo inesperado responde genérico y se registra sin su texto", () => {
  it.each([
    ["Error corriente", new Error(CRUDO)],
    ["TypeError", new TypeError("Cannot read properties of undefined (reading 'hunter2')")],
    ["error de Prisma sin traducción", Object.assign(new Error(CRUDO), { code: "P9999" })],
    ["valor que no es un Error", CRUDO],
    ["null", null],
  ])("%s", (_nombre, error) => {
    expect(mensajePublicable(error, "carga-masiva-personas", 7)).toBe(MENSAJE_FILA_INTERNA);

    const linea = registro.join("\n");
    for (const secreto of ["INSERT INTO", "hunter2", "/srv/app", "prisma.person", "Cannot read"]) {
      expect(linea).not.toContain(secreto);
    }
    const evento = JSON.parse(registro[0]!);
    expect(evento).toMatchObject({ event: "fila_fallo_inesperado", level: "error", contexto: "carga-masiva-personas", referencia: 7 });
  });

  it("anota la clase y el código del error, no su mensaje", () => {
    mensajePublicable(Object.assign(new RangeError(CRUDO), { code: "P9999" }), "asignacion-masiva", "persona-1");

    expect(JSON.parse(registro[0]!)).toMatchObject({ errorName: "RangeError", errorCode: "P9999", referencia: "persona-1" });
  });

  it("el mensaje genérico no contiene ningún dato del error", () => {
    expect(MENSAJE_FILA_INTERNA).not.toMatch(/prisma|sql|select|insert|\/|\\|:\d+/i);
  });
});
