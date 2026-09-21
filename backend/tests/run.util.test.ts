import { describe, it, expect } from "vitest";
import { validateRun, normalizeRun, formatRun } from "../src/shared/run.util";

describe("run.util — validateRun", () => {
  // RUNs reales de prueba (formato genérico, dígito verificador correcto)
  it.each([
    "11.111.111-1",
    "7.897.235-1",
    "20.578.512-4",
    "205785124",
    "11111111-1",
  ])("acepta un RUN válido: %s", (run) => {
    expect(validateRun(run).valid).toBe(true);
  });

  it("rechaza un RUN con dígito verificador incorrecto", () => {
    const result = validateRun("11.111.111-2");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("CHECK_DIGIT");
  });

  it("rechaza un RUN con formato inválido (letras en el cuerpo)", () => {
    const result = validateRun("ABCDEFGH-9");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("FORMAT");
  });

  it("rechaza un RUN demasiado corto", () => {
    const result = validateRun("123-4");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("FORMAT");
  });

  it("rechaza un RUN vacío", () => {
    expect(validateRun("").valid).toBe(false);
  });

  it("acepta el dígito verificador K en mayúscula o minúscula", () => {
    expect(validateRun("10.000.013-K").valid).toBe(true);
    expect(validateRun("10.000.013-k").valid).toBe(true);
  });
});

describe("run.util — normalizeRun", () => {
  it("quita puntos y guión, y pone el DV en mayúscula", () => {
    expect(normalizeRun("20.578.512-k")).toBe("20578512K");
  });
});

describe("run.util — formatRun", () => {
  it("formatea un RUN normalizado con puntos y guión", () => {
    expect(formatRun("205785128")).toBe("20.578.512-8");
  });

  it("formatea un RUN de 8 dígitos en el cuerpo correctamente", () => {
    expect(formatRun("111111111")).toBe("11.111.111-1");
  });
});
