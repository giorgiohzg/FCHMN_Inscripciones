/**
 * Jornada de una prueba importada.
 *
 * La regla: si el archivo no permite identificar la jornada, la prueba NO se
 * asigna a Mañana ni a Tarde. Va a una jornada con nombre propio y visible,
 * `JORNADA_SIN_ESPECIFICAR`, y la importación avisa de que hay que repartirla
 * a mano.
 *
 * Antes se usaba el nombre genérico "Sesión" y no se avisaba nada, así que una
 * competencia importada con la hora ilegible quedaba indistinguible de una
 * bien configurada.
 */
import { describe, it, expect } from "vitest";
import { inferSessionTypeName, JORNADA_SIN_ESPECIFICAR } from "../src/modules/meet-import/meet-import.service";

describe("inferSessionTypeName — horas que SÍ se pueden interpretar", () => {
  const casos: Array<[string, string]> = [
    ["12:00AM", "Mañana"], // medianoche
    ["09:15AM", "Mañana"], // hora real de la muestra, primer día
    ["08:50AM", "Mañana"], // hora real de la muestra, segundo día
    ["11:59AM", "Mañana"],
    ["12:00PM", "Tarde"], // mediodía: no es "Mañana"
    ["05:59PM", "Tarde"],
    ["06:00PM", "Noche"],
    ["11:30PM", "Noche"],
    ["9:15AM", "Mañana"], // una sola cifra en la hora
    ["  09:15 AM  ", "Mañana"], // espacios sobrantes
    ["09:15am", "Mañana"], // minúsculas
  ];

  for (const [entrada, esperado] of casos) {
    it(`"${entrada}" → ${esperado}`, () => {
      expect(inferSessionTypeName(entrada)).toEqual({ nombre: esperado, especificada: true });
    });
  }
});

describe("inferSessionTypeName — cuando no se puede saber la jornada", () => {
  const ilegibles = [
    "", // el caso del .hyv: el formato no trae la hora
    "   ",
    "09:15", // sin AM/PM: no se puede situar en el día
    "mañana",
    "9AM",
    "09:15AM extra",
    // Horas con la FORMA correcta pero imposibles en un reloj de 12 horas.
    // "25:00AM" pasaba el patrón y, como 25 ≥ 18, salía clasificada como
    // "Noche": una jornada inventada a partir de un dato inválido.
    "25:00AM",
    "00:30AM",
    "13:00PM",
    "99:99PM",
    "10:75AM",
  ];

  for (const entrada of ilegibles) {
    it(`"${entrada}" → jornada sin especificar`, () => {
      expect(inferSessionTypeName(entrada)).toEqual({ nombre: JORNADA_SIN_ESPECIFICAR, especificada: false });
    });
  }

  it("nunca cae en Mañana, Tarde ni Noche por omisión", () => {
    for (const entrada of ilegibles) {
      const { nombre } = inferSessionTypeName(entrada);
      expect(["Mañana", "Tarde", "Noche"], entrada).not.toContain(nombre);
    }
  });

  it("ya no devuelve el nombre genérico anterior", () => {
    // "Sesión" se confundía con una jornada legítima y el pendiente se perdía.
    expect(inferSessionTypeName("").nombre).not.toBe("Sesión");
  });

  it("el nombre dice por sí solo que falta trabajo", () => {
    expect(JORNADA_SIN_ESPECIFICAR).toBe("Jornada sin especificar (importada)");
  });
});
