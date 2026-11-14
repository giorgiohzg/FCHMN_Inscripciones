import { describe, it, expect } from "vitest";
import { parseSwimTimeInput, formatSwimTimeCentiseconds, formatSwimTimeReadable } from "./swimTime";

describe("parseSwimTimeInput", () => {
  it("convierte mmsscc a centésimas totales", () => {
    expect(parseSwimTimeInput("012567")).toEqual({ ok: true, centiseconds: 8567 });
  });

  it("acepta espacios alrededor", () => {
    expect(parseSwimTimeInput("  003012  ").centiseconds).toBe(3012);
  });

  it("rechaza separadores: solo dígitos", () => {
    expect(parseSwimTimeInput("1:25,67").ok).toBe(false);
  });

  it("rechaza segundos mayores a 59", () => {
    expect(parseSwimTimeInput("016000").ok).toBe(false);
  });

  it("rechaza el tiempo cero", () => {
    expect(parseSwimTimeInput("000000").ok).toBe(false);
  });
});

/**
 * ENTRADA DE DERECHA A IZQUIERDA (regla confirmada): los dos últimos dígitos son centésimas, los
 * dos anteriores segundos y los restantes minutos; lo que falta a la izquierda vale cero. No hace
 * falta escribir seis dígitos ni ceros iniciales.
 */
describe("parseSwimTimeInput: entrada corta, de derecha a izquierda", () => {
  it.each([
    ["13236", 9236], // 1:32,36
    ["2356", 2356], // 0:23,56
    ["023600", 15600], // 2:36,00
    ["10000", 6000], // 1:00,00
    ["1", 1], // 0:00,01
    ["12", 12], // 0:00,12
    ["123", 123], // 0:01,23
    ["5999", 5999], // 0:59,99
    ["995999", 599999], // 99:59,99, máximo actual
    ["032000", 20000], // 3:20,00
    ["32000", 20000], // 3:20,00 sin el cero inicial
  ])("«%s» → %i centésimas", (entrada, centesimas) => {
    expect(parseSwimTimeInput(entrada)).toEqual({ ok: true, centiseconds: centesimas });
  });

  it("la entrada manual 20000 es 2:00,00 (no el número almacenado 20000, que es 3:20,00)", () => {
    expect(parseSwimTimeInput("20000").centiseconds).toBe(12000);
  });

  it("conserva el tratamiento de los espacios exteriores", () => {
    expect(parseSwimTimeInput("  2356 ").centiseconds).toBe(2356);
    expect(parseSwimTimeInput("23 56").ok).toBe(false);
  });

  it.each(["6000", "016000", "9960", "999999"])("segundos mayores a 59 se rechazan, sin pasarlos a minutos: «%s»", (entrada) => {
    expect(parseSwimTimeInput(entrada)).toEqual({ ok: false, error: "Los segundos no pueden ser mayores a 59." });
  });

  it.each(["0", "00", "0000", "000000"])("el tiempo cero se rechaza: «%s»", (entrada) => {
    expect(parseSwimTimeInput(entrada)).toEqual({ ok: false, error: "El tiempo debe ser mayor a cero." });
  });

  it.each(["", "   ", "1234567", "-2356", "+2356", "23.56", "23,56", "1e3", "0x1F", "２３５６", "12:34"])(
    "rechaza «%s»: vacío, más de seis dígitos, signos, decimales, exponentes, otros dígitos o separadores",
    (entrada) => {
      expect(parseSwimTimeInput(entrada).ok).toBe(false);
    }
  );
});

describe("formato", () => {
  it("es la inversa exacta del parseo", () => {
    expect(formatSwimTimeCentiseconds(8567)).toBe("012567");
    expect(parseSwimTimeInput(formatSwimTimeCentiseconds(8567)).centiseconds).toBe(8567);
  });

  it.each([3456, 5999, 6000, 8567, 20000, 599999])("ida y vuelta de un tiempo almacenado: %i", (centesimas) => {
    expect(parseSwimTimeInput(formatSwimTimeCentiseconds(centesimas)).centiseconds).toBe(centesimas);
  });

  it("muestra un valor legible", () => {
    expect(formatSwimTimeReadable(8567)).toBe("1:25,67");
    expect(formatSwimTimeReadable(null)).toBe("—");
  });
});
