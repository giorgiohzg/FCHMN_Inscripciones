/**
 * Reglas puras del resumen por club: totales y orden. Sin base de datos; datos sintéticos.
 * Las cifras por club (distintos, sexo, equipos) las calcula la base y se prueban en
 * `reportes-resumen-por-club.integration.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { compararFilasResumen, sumarTotales, type FilaResumenClub } from "../src/modules/reports/resumenPorClub.rules";

const fila = (clubId: string, clubName: string, v: number, d: number, ind: number, rel: number): FilaResumenClub => ({
  clubId,
  clubName,
  varones: v,
  damas: d,
  totalNadadores: v + d,
  pruebasIndividuales: ind,
  relevos: rel,
  totalPruebas: ind + rel,
});

describe("sumarTotales", () => {
  it("sin filas: todo en cero", () => {
    expect(sumarTotales([])).toEqual({ varones: 0, damas: 0, totalNadadores: 0, pruebasIndividuales: 0, relevos: 0, totalPruebas: 0 });
  });

  it("suma cada columna sobre el conjunto completo", () => {
    const filas = [fila("c1", "Alfa", 2, 3, 3, 2), fila("c2", "Beta", 0, 4, 0, 1), fila("c3", "Gama", 5, 0, 9, 0)];
    expect(sumarTotales(filas)).toEqual({ varones: 7, damas: 7, totalNadadores: 14, pruebasIndividuales: 12, relevos: 3, totalPruebas: 15 });
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
