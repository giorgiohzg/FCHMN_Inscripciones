/** Selección de competencia al llegar la lista (`competenciaPredeterminada.ts`). */
import { describe, it, expect } from "vitest";
import { competenciaPreseleccionada } from "./competenciaPredeterminada";

const lista = [{ id: "a" }, { id: "b", esPredeterminada: true }, { id: "c", esPredeterminada: false }];
const sel = (competitionId: string, invalidada = false) => ({ competitionId, invalidada });

describe("competenciaPreseleccionada", () => {
  it("elige la marcada si está en la lista que la cuenta puede ver y no hay elección", () => {
    expect(competenciaPreseleccionada(lista, "", false)).toEqual(sel("b"));
  });

  it("si la predeterminada no está entre las visibles, deja el selector sin elección", () => {
    expect(competenciaPreseleccionada([{ id: "a" }, { id: "c", esPredeterminada: false }], "", false)).toEqual(sel(""));
    expect(competenciaPreseleccionada([], "", false)).toEqual(sel(""));
  });

  it("no pisa una elección DISPONIBLE ni el regreso manual a «Seleccionar...»", () => {
    expect(competenciaPreseleccionada(lista, "a", false)).toEqual(sel("a"));
    expect(competenciaPreseleccionada(lista, "c", true)).toEqual(sel("c"));
    expect(competenciaPreseleccionada(lista, "", true)).toEqual(sel(""));
  });

  it("una elección que YA NO está en la lista se invalida y queda vacía, sin sustituirla por la predeterminada", () => {
    expect(competenciaPreseleccionada(lista, "oculta", false)).toEqual(sel("", true));
    expect(competenciaPreseleccionada(lista, "oculta", true)).toEqual(sel("", true));
    expect(competenciaPreseleccionada([], "a", false)).toEqual(sel("", true));
  });

  it("tolera respuestas sin el campo (anteriores a la migración)", () => {
    expect(competenciaPreseleccionada([{ id: "a" }, { id: "b" }], "", false)).toEqual(sel(""));
  });
});
