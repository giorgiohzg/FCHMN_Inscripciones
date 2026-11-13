/**
 * C-05, fase 2: reglas PURAS del protocolo de membresías y de las huellas. Sin base de datos.
 */
import { describe, it, expect } from "vitest";
import { decidirActivacion, evaluarHistorial, fechaEfectivaValida, type FilaMembresia } from "../src/modules/swimmer-assignment/membresias.protocolo";
import { claveDe } from "../src/modules/auth/limitadorClaves";
import { huellaDeAlta, huellaDePostulacion, FORMATO_CLAVE_IDEMPOTENCIA, CUOTA_DIARIA_POR_CLUB } from "../src/modules/incorporaciones/incorporaciones.claves";

const SECRETO = "s".repeat(40);
const fila = (campos: Partial<FilaMembresia> & Pick<FilaMembresia, "id" | "status">): FilaMembresia => ({
  club_id: "club-a",
  start_date: null,
  end_date: null,
  fecha_termino: null,
  ...campos,
});

describe("fecha efectiva", () => {
  const ahora = new Date("2026-11-12T15:00:00Z"); // 12:00 en Santiago
  it("sin fecha usa hoy en Santiago; hoy y fechas pasadas se aceptan", () => {
    expect(fechaEfectivaValida(undefined, ahora)).toBe("2026-11-12");
    expect(fechaEfectivaValida("2026-11-12", ahora)).toBe("2026-11-12");
    expect(fechaEfectivaValida("2020-02-29", ahora)).toBe("2020-02-29");
  });
  it("una fecha futura en Santiago se rechaza, aunque en UTC ya sea ese día", () => {
    expect(() => fechaEfectivaValida("2026-11-13", ahora)).toThrow(/posterior a hoy/);
    // 2026-11-13T01:00Z es aún el 12 en Santiago (UTC-3): el 13 sigue siendo futuro.
    expect(() => fechaEfectivaValida("2026-11-13", new Date("2026-11-13T01:00:00Z"))).toThrow(/posterior a hoy/);
  });
});

describe("evaluación del historial", () => {
  it("membresía vigente: debe haber empezado antes; con inicio desconocido queda incompleta", () => {
    expect(evaluarHistorial([], "2026-03-10", fila({ id: "v", status: "active", start_date: "2026-03-10" })).conflictos).toHaveLength(1);
    expect(evaluarHistorial([], "2026-03-10", fila({ id: "v", status: "active", start_date: "2026-03-09" }))).toEqual({ conflictos: [], incompletas: [] });
    expect(evaluarHistorial([], "2026-03-10", fila({ id: "v", status: "active" })).incompletas).toEqual(["v"]);
  });
  it("finalizada con término conocido: la fecha nueva debe ser posterior", () => {
    const h = [fila({ id: "f", status: "ended", start_date: "2025-01-01", fecha_termino: "2025-06-30" })];
    expect(evaluarHistorial(h, "2025-06-30").conflictos).toHaveLength(1);
    expect(evaluarHistorial(h, "2025-07-01")).toEqual({ conflictos: [], incompletas: [] });
  });
  it("finalizada con término desconocido: SIEMPRE incompleta, aunque la operación (end_date) sea anterior a la fecha nueva", () => {
    const h = [fila({ id: "d", status: "ended", start_date: "2025-01-01", end_date: new Date("2025-08-01T03:30:00Z") })];
    expect(evaluarHistorial(h, "2025-07-31").incompletas).toEqual(["d"]);
    expect(evaluarHistorial(h, "2025-09-01").incompletas, "una operación anterior no acredita el término").toEqual(["d"]);
    expect(evaluarHistorial(h, "2030-01-01").incompletas).toEqual(["d"]);
    expect(evaluarHistorial([fila({ id: "n", status: "ended" })], "2025-08-01").incompletas, "sin end_date tampoco").toEqual(["n"]);
  });
  it("una membresía anterior que empezó el mismo día o después es un conflicto conocido", () => {
    expect(evaluarHistorial([fila({ id: "x", status: "ended", start_date: "2026-05-01" })], "2026-04-01").conflictos).toHaveLength(1);
  });
  it("pendientes y rechazadas no cuentan como historial", () => {
    expect(evaluarHistorial([fila({ id: "p", status: "pending" }), fila({ id: "r", status: "rejected" })], "2026-01-01")).toEqual({ conflictos: [], incompletas: [] });
  });
});

describe("decisión de activación", () => {
  const activa = fila({ id: "act", status: "active", club_id: "club-b", start_date: "2026-01-01" });
  const opciones = { fechaEfectiva: "2026-03-01" };
  it("sin traslado permitido rechaza a quien está activo en otro club", () => {
    expect(() => decidirActivacion([activa], [], "club-a", opciones, { permiteTraslado: false, mensajeSinTraslado: () => "no" })).toThrow("no");
  });
  it("con traslado: exige la confirmación exacta y la rechaza si ya no hay membresía vigente", () => {
    expect(() => decidirActivacion([activa], [], "club-a", opciones, { permiteTraslado: true })).toThrow(expect.objectContaining({ code: "CONFIRMACION_REQUERIDA" }));
    expect(() => decidirActivacion([activa], [], "club-a", { ...opciones, confirmarFinDeMembresiaId: "otra" }, { permiteTraslado: true })).toThrow(
      expect.objectContaining({ code: "REVISAR_DE_NUEVO" })
    );
    expect(() => decidirActivacion([], [], "club-a", { ...opciones, confirmarFinDeMembresiaId: "act" }, { permiteTraslado: true })).toThrow(
      expect.objectContaining({ code: "REVISAR_DE_NUEVO" })
    );
    expect(decidirActivacion([activa], [], "club-a", { ...opciones, confirmarFinDeMembresiaId: "act" }, { permiteTraslado: true }).vigente?.id).toBe("act");
  });
  it("activa en el mismo club: ya pertenece", () => {
    expect(() => decidirActivacion([fila({ id: "m", status: "active" })], [], "club-a", opciones, { permiteTraslado: true })).toThrow(
      expect.objectContaining({ code: "YA_PERTENECE" })
    );
  });
  it("historial incompleto exige aceptación; un conflicto conocido no se acepta", () => {
    const desconocida = fila({ id: "d", status: "ended" });
    expect(() => decidirActivacion([], [desconocida], "club-a", opciones, { permiteTraslado: true })).toThrow(expect.objectContaining({ code: "HISTORIAL_INCOMPLETO" }));
    expect(decidirActivacion([], [desconocida], "club-a", { ...opciones, aceptarHistorialIncompleto: true }, { permiteTraslado: true }).historialIncompletoAceptado).toEqual(["d"]);
    const conocida = fila({ id: "c", status: "ended", fecha_termino: "2026-03-01" });
    expect(() => decidirActivacion([], [conocida], "club-a", { ...opciones, aceptarHistorialIncompleto: true }, { permiteTraslado: true })).toThrow(
      expect.objectContaining({ code: "CONFLICTO_DE_FECHAS" })
    );
  });
});

describe("huellas con propósito propio", () => {
  it("son de 32 bytes, deterministas y distinguen club, RUN y operación", () => {
    const h = huellaDePostulacion(SECRETO, "club-a", "123456785");
    expect(h).toHaveLength(32);
    expect(huellaDePostulacion(SECRETO, "club-a", "123456785").equals(h)).toBe(true);
    expect(huellaDePostulacion(SECRETO, "club-b", "123456785").equals(h)).toBe(false);
    expect(huellaDePostulacion(SECRETO, "club-a", "123456793").equals(h)).toBe(false);
    expect(huellaDeAlta(SECRETO, "club-a", "123456785", "").equals(h), "otra operación con los mismos textos").toBe(false);
  });
  it("nunca coinciden con una clave del limitador de login con el mismo secreto", () => {
    const h = huellaDePostulacion(SECRETO, "club-a", "123456785");
    for (const tipo of ["origen", "cuenta", "par"] as const) expect(claveDe(SECRETO, tipo, ["club-a", "123456785"]).equals(h)).toBe(false);
  });
  it("parámetros funcionales y formato de la clave de idempotencia", () => {
    expect(CUOTA_DIARIA_POR_CLUB).toBe(30);
    expect(FORMATO_CLAVE_IDEMPOTENCIA.test("abcdefgh")).toBe(true);
    expect(FORMATO_CLAVE_IDEMPOTENCIA.test("abc")).toBe(false);
    expect(FORMATO_CLAVE_IDEMPOTENCIA.test("x".repeat(65))).toBe(false);
    expect(FORMATO_CLAVE_IDEMPOTENCIA.test("con espacio")).toBe(false);
  });
});
