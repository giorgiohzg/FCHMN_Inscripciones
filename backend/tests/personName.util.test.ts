import { describe, it, expect } from "vitest";
import { formatPersonFullName } from "../src/shared/personName.util";

describe("personName.util — formatPersonFullName", () => {
  it("arma el nombre completo con los 3 campos", () => {
    expect(formatPersonFullName("Juan", "Pérez", "González")).toBe("Juan Pérez González");
  });

  it("omite el apellido materno si no se entrega", () => {
    expect(formatPersonFullName("Juan", "Pérez", undefined)).toBe("Juan Pérez");
    expect(formatPersonFullName("Juan", "Pérez", null)).toBe("Juan Pérez");
    expect(formatPersonFullName("Juan", "Pérez", "")).toBe("Juan Pérez");
  });

  it("recorta espacios en blanco de cada campo", () => {
    expect(formatPersonFullName("  Juan  ", " Pérez ", " González ")).toBe("Juan Pérez González");
  });
});
