import { describe, it, expect } from "vitest";
import { computeAge, isAgeInCategoryRange, getDefaultAgeCutoffDate } from "../src/shared/age.util";

describe("age.util — computeAge", () => {
  it("calcula correctamente cuando ya pasó el cumpleaños en el año de corte", () => {
    // Nace 15-mar-2000, corte 31-dic-2026 -> ya cumplió años ese año -> 26
    expect(computeAge(new Date("2000-03-15"), new Date("2026-12-31"))).toBe(26);
  });

  it("calcula correctamente cuando el cumpleaños es exactamente la fecha de corte", () => {
    // Cumple años el mismo día de corte -> cuenta como cumplido
    expect(computeAge(new Date("2000-06-15"), new Date("2026-06-15"))).toBe(26);
  });

  it("resta un año cuando el cumpleaños aún no ha ocurrido a la fecha de corte", () => {
    // Nace 15-dic-2000, corte 30-jun-2026 -> aún no cumple ese año -> 25
    expect(computeAge(new Date("2000-12-15"), new Date("2026-06-30"))).toBe(25);
  });

  it("maneja correctamente el caso de nacimiento en año bisiesto (29 de febrero)", () => {
    expect(computeAge(new Date("2000-02-29"), new Date("2026-03-01"))).toBe(26);
    expect(computeAge(new Date("2000-02-29"), new Date("2026-02-28"))).toBe(25);
  });

  it("retorna 0 para un recién nacido a la fecha de corte", () => {
    expect(computeAge(new Date("2026-01-10"), new Date("2026-01-10"))).toBe(0);
  });
});

describe("age.util — isAgeInCategoryRange", () => {
  it("acepta una edad dentro del rango de la categoría", () => {
    // Nadador de 26 años, categoría 25-29
    expect(isAgeInCategoryRange(new Date("2000-03-15"), new Date("2026-12-31"), 25, 29)).toBe(true);
  });

  it("rechaza una edad menor al mínimo de la categoría", () => {
    // Nadador de 24 años, categoría 25-29
    expect(isAgeInCategoryRange(new Date("2002-03-15"), new Date("2026-01-01"), 25, 29)).toBe(false);
  });

  it("rechaza una edad mayor al máximo de la categoría", () => {
    // Nadador de 30 años, categoría 25-29
    expect(isAgeInCategoryRange(new Date("1996-01-01"), new Date("2026-12-31"), 25, 29)).toBe(false);
  });

  it("acepta el límite exacto inferior y superior del rango", () => {
    expect(isAgeInCategoryRange(new Date("2001-06-15"), new Date("2026-06-15"), 25, 29)).toBe(true); // exactamente 25
    expect(isAgeInCategoryRange(new Date("1997-06-15"), new Date("2026-06-15"), 25, 29)).toBe(true); // exactamente 29
  });
});

describe("age.util — getDefaultAgeCutoffDate", () => {
  it("retorna el 31 de diciembre del año de la fecha de referencia", () => {
    const result = getDefaultAgeCutoffDate(new Date(Date.UTC(2026, 5, 15))); // 15-jun-2026
    expect(result.getUTCFullYear()).toBe(2026);
    expect(result.getUTCMonth()).toBe(11); // diciembre (0-indexado)
    expect(result.getUTCDate()).toBe(31);
  });

  it("usa la fecha actual como referencia por defecto", () => {
    const result = getDefaultAgeCutoffDate();
    expect(result.getUTCFullYear()).toBe(new Date().getUTCFullYear());
  });

  it("funciona correctamente en combinación con computeAge (reemplaza a category.cutoffDate)", () => {
    // Nadador nacido en marzo de 2000, referencia = cualquier día de 2026
    // -> a fin de año 2026 cumple 26 años, sin importar el día exacto de referencia.
    const cutoff = getDefaultAgeCutoffDate(new Date(Date.UTC(2026, 2, 1)));
    expect(computeAge(new Date("2000-03-15"), cutoff)).toBe(26);
  });
});
