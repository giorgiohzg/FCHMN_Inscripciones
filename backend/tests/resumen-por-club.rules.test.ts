/**
 * Reglas puras del resumen por club: totales y orden. Sin base de datos; datos sintéticos.
 * Las cifras por club (distintos, sexo, equipos) las calcula la base y se prueban en
 * `reportes-resumen-por-club.integration.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { computeAge, getDefaultAgeCutoffDate } from "../src/shared/age.util";
import { resumenPorClubQuerySchema } from "../src/modules/reports/reports.schemas";
import {
  compararFilasResumen,
  EDAD_MINIMA_MAXIMA,
  EDAD_MINIMA_POR_OMISION,
  esEdadMinimaValida,
  limiteDeNacimientoPorEdad,
  nacioHastaElLimite,
  sumarTotales,
  type FilaResumenClub,
} from "../src/modules/reports/resumenPorClub.rules";

const fila = (clubId: string, clubName: string, v: number, d: number, ind: number, rel: number, mayores = 0): FilaResumenClub => ({
  clubId,
  clubName,
  varones: v,
  damas: d,
  totalNadadores: v + d,
  nadadoresConEdadMinima: mayores,
  pruebasIndividuales: ind,
  relevos: rel,
  totalPruebas: ind + rel,
});

describe("sumarTotales", () => {
  it("sin filas: todo en cero", () => {
    expect(sumarTotales([])).toEqual({ varones: 0, damas: 0, totalNadadores: 0, nadadoresConEdadMinima: 0, pruebasIndividuales: 0, relevos: 0, totalPruebas: 0 });
  });

  it("suma cada columna sobre el conjunto completo", () => {
    const filas = [fila("c1", "Alfa", 2, 3, 3, 2, 2), fila("c2", "Beta", 0, 4, 0, 1, 0), fila("c3", "Gama", 5, 0, 9, 0, 1)];
    expect(sumarTotales(filas)).toEqual({ varones: 7, damas: 7, totalNadadores: 14, nadadoresConEdadMinima: 3, pruebasIndividuales: 12, relevos: 3, totalPruebas: 15 });
  });
});

describe("compararFilasResumen", () => {
  it("ordena por nombre del club con colación en español", () => {
    const filas = [fila("1", "Ñandú", 0, 0, 0, 0), fila("2", "Delfines", 0, 0, 0, 0), fila("3", "árbol", 0, 0, 0, 0)];
    expect([...filas].sort(compararFilasResumen).map((f) => f.clubName)).toEqual(["árbol", "Delfines", "Ñandú"]);
  });

  it("dos clubes homónimos no se fusionan y se desempatan por id, sin depender del orden de llegada", () => {
    const a = fila("id-b", "Club Homónimo", 1, 0, 1, 0);
    const b = fila("id-a", "Club Homónimo", 0, 2, 2, 0);
    expect([a, b].sort(compararFilasResumen).map((f) => f.clubId)).toEqual(["id-a", "id-b"]);
    expect([b, a].sort(compararFilasResumen).map((f) => f.clubId)).toEqual(["id-a", "id-b"]);
  });
});

describe("límite de nacimiento para la edad mínima (mismo criterio que computeAge)", () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const cumple70 = (nacimiento: string, corte: string) => nacioHastaElLimite(d(nacimiento), limiteDeNacimientoPorEdad(d(corte), EDAD_MINIMA_POR_OMISION));
  const cumple = (nacimiento: string, corte: string, edad: number) => nacioHastaElLimite(d(nacimiento), limiteDeNacimientoPorEdad(d(corte), edad));

  it("la edad mínima por omisión es 70", () => {
    expect(EDAD_MINIMA_POR_OMISION).toBe(70);
  });

  it.each([
    [65, "1960-06-15", true, "exactamente 65"],
    [65, "1960-06-16", false, "un día antes de cumplir 65"],
    [75, "1950-06-15", true, "exactamente 75"],
    [75, "1950-06-16", false, "un día antes de cumplir 75"],
    [0, "2025-06-15", true, "0: nacida el mismo día del corte"],
    [0, "2025-06-16", false, "0: nacida después del corte"],
  ])("umbral %i, nacimiento %s → %s (%s)", (edad, nacimiento, esperado) => {
    expect(cumple(nacimiento, "2025-06-15", edad)).toBe(esperado);
    expect(computeAge(d(nacimiento), d("2025-06-15")) >= edad).toBe(esperado);
  });

  it.each([
    [69, "1952-02-29", "2022-02-28", true],
    [70, "1952-02-29", "2022-02-28", false],
    [70, "1952-02-29", "2022-03-01", true],
    [71, "1952-02-29", "2022-03-01", false],
    [72, "1952-02-29", "2024-02-29", true],
    [73, "1952-02-29", "2024-02-29", false],
    [65, "1960-02-29", "2025-02-28", false],
    [65, "1960-02-29", "2025-03-01", true],
  ])("29 de febrero con umbral %i: nacida %s, corte %s → %s", (edad, nacimiento, corte, esperado) => {
    expect(cumple(nacimiento, corte, edad)).toBe(esperado);
    expect(computeAge(d(nacimiento), d(corte)) >= edad).toBe(esperado);
  });

  it.each([
    ["69 años: excluida", "1956-06-15", "2025-06-15", false],
    ["cumple exactamente 70 en la fecha de corte: incluida", "1955-06-15", "2025-06-15", true],
    ["cumple 70 al día siguiente del corte: excluida", "1955-06-16", "2025-06-15", false],
    ["mayor de 70: incluida", "1940-01-01", "2025-06-15", true],
    ["no basta restar años: mismo año, mes posterior al del corte", "1955-07-01", "2025-06-15", false],
    ["29 de febrero, corte el 28 de febrero de un año no bisiesto: todavía 69", "1952-02-29", "2022-02-28", false],
    ["29 de febrero, corte el 1 de marzo de un año no bisiesto: 70", "1952-02-29", "2022-03-01", true],
    ["corte el 29 de febrero de un año bisiesto: nacida el 28 de febrero, 70", "1954-02-28", "2024-02-29", true],
    ["corte el 29 de febrero de un año bisiesto: nacida el 1 de marzo, 69", "1954-03-01", "2024-02-29", false],
    ["29 de febrero, corte el 29 de febrero 72 años después: 72", "1952-02-29", "2024-02-29", true],
  ])("%s", (_caso, nacimiento, corte, esperado) => {
    expect(cumple70(nacimiento, corte)).toBe(esperado);
    expect(computeAge(d(nacimiento), d(corte)) >= 70).toBe(esperado);
  });

  it("equivale a computeAge(nacimiento, corte) >= edad en todos los días, con varios umbrales y años bisiestos", () => {
    // Cortes: cada día de 2023 (no bisiesto) y de 2024 (bisiesto), y el 31-dic de 2025.
    // Nacimientos: cada día de los cuatro años alrededor del umbral (siempre incluye un bisiesto).
    const dia = 86_400_000;
    const cortes: Date[] = [];
    for (let t = Date.UTC(2023, 0, 1); t <= Date.UTC(2024, 11, 31); t += dia) cortes.push(new Date(t));
    cortes.push(getDefaultAgeCutoffDate(d("2025-03-10")));
    let comparados = 0;
    for (const edad of [0, 1, 65, 70, 75, EDAD_MINIMA_MAXIMA]) {
      const desde = Date.UTC(2023 - edad - 2, 0, 1);
      const hasta = Date.UTC(2024 - edad + 1, 11, 31);
      for (const corte of cortes) {
        const limite = limiteDeNacimientoPorEdad(corte, edad);
        for (let t = desde; t <= hasta; t += dia) {
          const nacimiento = new Date(t);
          if (nacioHastaElLimite(nacimiento, limite) !== computeAge(nacimiento, corte) >= edad) {
            throw new Error(`Difiere con ${edad}: nacimiento ${nacimiento.toISOString()} corte ${corte.toISOString()}`);
          }
          comparados++;
        }
      }
    }
    expect(comparados).toBeGreaterThan(5_000_000);
  });

  it("usa los componentes UTC de la fecha de corte, como computeAge", () => {
    // 2025-06-15T23:30 en UTC: sigue siendo 15 de junio para computeAge.
    expect(limiteDeNacimientoPorEdad(new Date("2025-06-15T23:30:00.000Z"), 70)).toEqual({ anio: 1955, mes: 6, dia: 15 });
  });
});

describe("edad mínima: validación del parámetro del resumen", () => {
  const ID = "11111111-1111-4111-8111-111111111111";
  const leer = (edadMinima?: unknown) => resumenPorClubQuerySchema.safeParse(edadMinima === undefined ? { competitionId: ID } : { competitionId: ID, edadMinima });

  it("omitida: sin valor (el servicio usa 70)", () => {
    const r = leer();
    expect(r.success).toBe(true);
    expect(r.data?.edadMinima).toBeUndefined();
  });

  it.each([
    ["0", 0],
    ["7", 7],
    ["65", 65],
    ["70", 70],
    ["150", 150],
  ])("«%s» → %i", (texto, esperado) => {
    expect(leer(texto).data?.edadMinima).toBe(esperado);
  });

  it.each(["", " ", "70 ", " 70", "7.5", "70.0", "-1", "+70", "abc", "Infinity", "-Infinity", "NaN", "1e2", "0x46", "070", "00", "151", "1000", "99999999999999999999"])(
    "«%s» → rechazada",
    (texto) => {
      expect(leer(texto).success).toBe(false);
    }
  );

  it("un parámetro repetido (llega como lista) o un número sin texto → rechazado", () => {
    expect(leer(["70", "75"]).success).toBe(false);
    expect(leer(70).success).toBe(false);
  });

  it("esEdadMinimaValida: la barrera del servicio usa los mismos límites", () => {
    for (const v of [0, 70, 150]) expect(esEdadMinimaValida(v), String(v)).toBe(true);
    for (const v of [-1, 151, 7.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) expect(esEdadMinimaValida(v), String(v)).toBe(false);
  });
});
