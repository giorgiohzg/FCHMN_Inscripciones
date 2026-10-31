import { describe, it, expect } from "vitest";
import {
  hoyEnZonaDelNegocio,
  fechaCalendarioAUtc,
  utcAFechaCalendario,
  esFechaCalendarioValida,
} from "../src/shared/fecha.util";

/**
 * Estas pruebas defienden una sola propiedad: **una fecha de calendario no se
 * desplaza**. Ni por la zona del servidor, ni al guardarla, ni al leerla.
 *
 * El defecto que originó este módulo se medía así: una asignación hecha en
 * Chile a las 23:58 del 30 de octubre quedaba guardada como el 31, porque el
 * servidor corre en UTC y `new Date()` captura el instante.
 */
describe("hoyEnZonaDelNegocio", () => {
  it("devuelve el día CHILENO, no el del reloj del proceso", () => {
    // 02:58 UTC del 31 son las 23:58 del 30 en Chile (UTC-3 en verano austral).
    expect(hoyEnZonaDelNegocio(new Date("2026-10-31T02:58:24.031Z"))).toBe("2026-10-30");
  });

  it("no se adelanta cuando en Chile todavía es el día anterior", () => {
    // Un minuto antes de la medianoche chilena.
    expect(hoyEnZonaDelNegocio(new Date("2026-10-31T02:59:59.999Z"))).toBe("2026-10-30");
  });

  it("cambia de día exactamente en la medianoche chilena", () => {
    expect(hoyEnZonaDelNegocio(new Date("2026-10-31T03:00:00.000Z"))).toBe("2026-10-31");
  });

  it("aplica el horario de verano austral y no un desplazamiento fijo", () => {
    // Invierno austral: Chile en UTC-4. 03:30 UTC son las 23:30 del día ANTERIOR.
    // Con un -3 fijo daría el 15, que es el error que esto descarta.
    expect(hoyEnZonaDelNegocio(new Date("2026-07-15T03:30:00.000Z"))).toBe("2026-07-14");
    // Verano austral: Chile en UTC-3. El MISMO reloj UTC cae en el día siguiente.
    // Con un -4 fijo daría el 14.
    expect(hoyEnZonaDelNegocio(new Date("2026-01-15T03:30:00.000Z"))).toBe("2026-01-15");
  });

  it("devuelve siempre el formato AAAA-MM-DD", () => {
    expect(hoyEnZonaDelNegocio()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("fechaCalendarioAUtc", () => {
  it("construye la medianoche UTC del día pedido, que es lo que guarda una columna DATE", () => {
    expect(fechaCalendarioAUtc("2026-10-30").toISOString()).toBe("2026-10-30T00:00:00.000Z");
  });

  it("conserva el día en el viaje de ida y vuelta", () => {
    for (const f of ["2026-01-01", "2026-10-30", "2026-12-31", "2024-02-29"]) {
      expect(utcAFechaCalendario(fechaCalendarioAUtc(f))).toBe(f);
    }
  });

  it("rechaza lo que no es una fecha de calendario", () => {
    expect(() => fechaCalendarioAUtc("30-10-2026")).toThrow();
    expect(() => fechaCalendarioAUtc("2026-10-30T12:00:00Z")).toThrow();
    expect(() => fechaCalendarioAUtc("")).toThrow();
  });
});

describe("utcAFechaCalendario", () => {
  it("lee los componentes UTC y no los locales", () => {
    // Si leyera los componentes locales, en Chile esto daría el 29.
    expect(utcAFechaCalendario(new Date("2026-10-30T00:00:00.000Z"))).toBe("2026-10-30");
  });

  it("acepta la cadena que sirve la API para una columna DATE", () => {
    expect(utcAFechaCalendario("2026-10-30T00:00:00.000Z")).toBe("2026-10-30");
    expect(utcAFechaCalendario("2026-10-30")).toBe("2026-10-30");
  });

  it("devuelve null para lo ausente o ilegible", () => {
    expect(utcAFechaCalendario(null)).toBeNull();
    expect(utcAFechaCalendario(undefined)).toBeNull();
    expect(utcAFechaCalendario("el martes")).toBeNull();
    expect(utcAFechaCalendario(new Date("no es una fecha"))).toBeNull();
  });
});

describe("esFechaCalendarioValida", () => {
  it("acepta días que existen", () => {
    expect(esFechaCalendarioValida("2026-10-30")).toBe(true);
    expect(esFechaCalendarioValida("2024-02-29")).toBe(true); // bisiesto
  });

  it("rechaza días que NO existen, aunque cumplan el formato", () => {
    // `new Date` los normalizaría en silencio al día siguiente del mes.
    expect(esFechaCalendarioValida("2026-02-30")).toBe(false);
    expect(esFechaCalendarioValida("2026-13-01")).toBe(false);
    expect(esFechaCalendarioValida("2025-02-29")).toBe(false); // no bisiesto
  });

  it("rechaza otras formas de escribir una fecha", () => {
    expect(esFechaCalendarioValida("30-10-2026")).toBe(false);
    expect(esFechaCalendarioValida("2026-10-30T00:00:00Z")).toBe(false);
  });
});
