import { describe, it, expect } from "vitest";
import { parseSwimTimeInput, formatSwimTimeCentiseconds, formatSwimTimeReadable } from "./swimTime";

describe("parseSwimTimeInput", () => {
  it("convierte mmsscc a centésimas totales", () => {
    expect(parseSwimTimeInput("012567")).toEqual({ ok: true, centiseconds: 8567 });
  });

  it("acepta espacios alrededor", () => {
    expect(parseSwimTimeInput("  003012  ").centiseconds).toBe(3012);
  });

  it("rechaza un formato que no sean 6 dígitos", () => {
    expect(parseSwimTimeInput("1:25,67").ok).toBe(false);
    expect(parseSwimTimeInput("12567").ok).toBe(false);
  });

  it("rechaza segundos mayores a 59", () => {
    expect(parseSwimTimeInput("016000").ok).toBe(false);
  });

  it("rechaza el tiempo cero", () => {
    expect(parseSwimTimeInput("000000").ok).toBe(false);
  });
});

describe("formato", () => {
  it("es la inversa exacta del parseo", () => {
    expect(formatSwimTimeCentiseconds(8567)).toBe("012567");
    expect(parseSwimTimeInput(formatSwimTimeCentiseconds(8567)).centiseconds).toBe(8567);
  });

  it("muestra un valor legible", () => {
    expect(formatSwimTimeReadable(8567)).toBe("1:25,67");
    expect(formatSwimTimeReadable(null)).toBe("—");
  });
});
