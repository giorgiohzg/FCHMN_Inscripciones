import { describe, it, expect } from "vitest";
import { parseSwimTimeInput, formatSwimTimeCentiseconds, formatSwimTimeReadable } from "../src/shared/swimTime.util";

describe("swimTime.util — parseSwimTimeInput", () => {
  it("parsea correctamente 1 minuto 25,67 segundos", () => {
    const result = parseSwimTimeInput("012567");
    expect(result.ok).toBe(true);
    expect(result.centiseconds).toBe((1 * 60 + 25) * 100 + 67);
  });

  it("parsea correctamente un tiempo bajo 1 minuto", () => {
    const result = parseSwimTimeInput("003510");
    expect(result.ok).toBe(true);
    expect(result.centiseconds).toBe(35 * 100 + 10);
  });

  it("parsea correctamente varios minutos", () => {
    const result = parseSwimTimeInput("123000");
    expect(result.ok).toBe(true);
    expect(result.centiseconds).toBe((12 * 60 + 30) * 100);
  });

  it("rechaza un formato con menos de 6 dígitos", () => {
    const result = parseSwimTimeInput("12567");
    expect(result.ok).toBe(false);
  });

  it("rechaza un formato con más de 6 dígitos", () => {
    const result = parseSwimTimeInput("0125670");
    expect(result.ok).toBe(false);
  });

  it("rechaza segundos mayores a 59", () => {
    const result = parseSwimTimeInput("016500");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/59/);
  });

  it("rechaza un tiempo de cero", () => {
    const result = parseSwimTimeInput("000000");
    expect(result.ok).toBe(false);
  });

  it("rechaza texto con letras", () => {
    const result = parseSwimTimeInput("ab1234");
    expect(result.ok).toBe(false);
  });

  it("acepta espacios en blanco alrededor", () => {
    const result = parseSwimTimeInput("  012567  ");
    expect(result.ok).toBe(true);
  });

  it("rechaza un formato con coma (formato anterior, ya no válido)", () => {
    const result = parseSwimTimeInput("0125,67");
    expect(result.ok).toBe(false);
  });
});

describe("swimTime.util — formatSwimTimeCentiseconds", () => {
  it("formatea de vuelta al mismo formato mmsscc", () => {
    expect(formatSwimTimeCentiseconds((1 * 60 + 25) * 100 + 67)).toBe("012567");
    expect(formatSwimTimeCentiseconds(35 * 100 + 10)).toBe("003510");
    expect(formatSwimTimeCentiseconds((12 * 60 + 30) * 100)).toBe("123000");
  });

  it("retorna cadena vacía para null", () => {
    expect(formatSwimTimeCentiseconds(null)).toBe("");
  });

  it("el parseo y el formateo son inversos entre sí", () => {
    const inputs = ["012567", "003510", "123000", "050005"];
    for (const input of inputs) {
      const parsed = parseSwimTimeInput(input);
      expect(parsed.ok).toBe(true);
      expect(formatSwimTimeCentiseconds(parsed.centiseconds!)).toBe(input);
    }
  });
});

describe("swimTime.util — formatSwimTimeReadable", () => {
  it("formatea de forma legible con dos puntos y coma decimal", () => {
    expect(formatSwimTimeReadable((1 * 60 + 25) * 100 + 67)).toBe("1:25,67");
    expect(formatSwimTimeReadable(35 * 100 + 10)).toBe("0:35,10");
  });

  it("retorna guion para null", () => {
    expect(formatSwimTimeReadable(null)).toBe("—");
  });
});
