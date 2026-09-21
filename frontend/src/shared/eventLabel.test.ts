import { describe, it, expect } from "vitest";
import { formatEventLabel } from "./eventLabel";

describe("formatEventLabel", () => {
  it("una prueba individual muestra su distancia tal cual", () => {
    expect(formatEventLabel({ distanceMeters: 50, strokeName: "Libre", gender: "male", isRelay: false })).toBe("50m Libre (Varones)");
  });

  /**
   * Hallazgo 14: la distancia guardada es la TOTAL, así que un 4×50 llega
   * como 200. Antes se imprimía "Relevo 200m", que no es como se nombra un
   * relevo.
   */
  it("un relevo descompone el total en postas", () => {
    expect(formatEventLabel({ distanceMeters: 200, strokeName: "Libre", gender: "mixed", isRelay: true, swimmersCount: 4 })).toBe(
      "Relevo 4x50m Libre (Mixto)"
    );
    expect(formatEventLabel({ distanceMeters: 400, strokeName: "Combinado", gender: "female", isRelay: true, swimmersCount: 4 })).toBe(
      "Relevo 4x100m Combinado (Damas)"
    );
  });

  it("sin swimmersCount asume 4, el único tipo de relevo del catálogo", () => {
    expect(formatEventLabel({ distanceMeters: 200, strokeName: "Libre", gender: "mixed", isRelay: true })).toBe("Relevo 4x50m Libre (Mixto)");
  });

  it("si el total no es divisible entre las postas, muestra el total sin inventar", () => {
    expect(formatEventLabel({ distanceMeters: 150, strokeName: "Libre", gender: "mixed", isRelay: true, swimmersCount: 4 })).toBe(
      "Relevo 150m Libre (Mixto)"
    );
  });
});
