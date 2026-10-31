import { describe, it, expect } from "vitest";
import { formatearFechaCalendario, claveOrdenFechaCalendario, esFechaCalendario } from "./fechaCalendario";

/**
 * La trampa que este módulo existe para cerrar, con números.
 *
 * La fecha efectiva vive en una columna `DATE` y Prisma la serializa como
 * medianoche UTC. Al oeste de Greenwich, medianoche UTC es la tarde del día
 * ANTERIOR, así que `new Date(...).toLocaleDateString("es-CL")` resta un día.
 */
describe("formatearFechaCalendario", () => {
  it("muestra el día que el servidor envió, no el de la zona del navegador", () => {
    expect(formatearFechaCalendario("2026-10-30T00:00:00.000Z")).toBe("30-10-2026");
  });

  it("NO se desplaza como lo haría toLocaleDateString", () => {
    const iso = "2026-10-30T00:00:00.000Z";
    const conLaTrampa = new Date(iso).toLocaleDateString("es-CL", { timeZone: "America/Santiago" });
    // La comparación es el documento: en Chile, el camino viejo da el 29.
    expect(conLaTrampa).toBe("29-10-2026");
    expect(formatearFechaCalendario(iso)).toBe("30-10-2026");
  });

  it("acepta la fecha sin hora", () => {
    expect(formatearFechaCalendario("2026-01-01")).toBe("01-01-2026");
  });

  it("no rompe ante algo que no tiene la forma esperada", () => {
    expect(formatearFechaCalendario("")).toBe("");
    expect(formatearFechaCalendario("vaya")).toBe("vaya");
  });

  it("conserva el primer y el último día del año", () => {
    expect(formatearFechaCalendario("2026-01-01T00:00:00.000Z")).toBe("01-01-2026");
    expect(formatearFechaCalendario("2026-12-31T00:00:00.000Z")).toBe("31-12-2026");
  });
});

describe("claveOrdenFechaCalendario", () => {
  it("ordena cronológicamente sin construir ningún Date", () => {
    const fechas = ["2026-10-30T00:00:00.000Z", "2026-01-15T00:00:00.000Z", "2026-12-01T00:00:00.000Z"];
    expect([...fechas].sort((a, b) => claveOrdenFechaCalendario(a).localeCompare(claveOrdenFechaCalendario(b)))).toEqual([
      "2026-01-15T00:00:00.000Z",
      "2026-10-30T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z",
    ]);
  });
});

describe("esFechaCalendario", () => {
  it("acepta lo que el servidor promete", () => {
    expect(esFechaCalendario("2026-10-30")).toBe(true);
    expect(esFechaCalendario("2026-10-30T00:00:00.000Z")).toBe(true);
  });

  it("rechaza lo que esta pantalla no sabe mostrar sin desplazar el día", () => {
    // `new Date()` sí sabría interpretar estos; el formateador, no.
    expect(esFechaCalendario("el martes")).toBe(false);
    expect(esFechaCalendario("30-10-2026")).toBe(false);
    expect(esFechaCalendario("2026/10/30")).toBe(false);
    expect(esFechaCalendario(null)).toBe(false);
    expect(esFechaCalendario(undefined)).toBe(false);
    expect(esFechaCalendario(20261030)).toBe(false);
  });
});
