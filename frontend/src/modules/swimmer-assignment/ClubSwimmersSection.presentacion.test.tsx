/**
 * Plantel de Editar Club: cada nadador como «PATERNO MATERNO, NOMBRES (RUN)», en el orden que
 * entrega el servidor (`orden=apellidos`, antes de paginar). Datos sintéticos, jsdom.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fila = (id: string, person: Record<string, unknown>) => ({
  id,
  clubId: "c1",
  personId: `p-${id}`,
  status: "active",
  startDate: "2025-02-01T00:00:00.000Z",
  fechaTermino: null,
  endDate: null,
  person: { id: `p-${id}`, ...person },
  club: { id: "c1", name: "Club Prueba" },
});
// Ya ordenadas como las entrega el servidor.
const FILAS = [
  fila("m1", { fullName: "x", run: "10.000.013-k", firstName: "María José", paternalLastName: "de la Fuente", maternalLastName: "Ñuñoa" }),
  fila("m2", { fullName: "x", run: "13579246-2", firstName: "Tomás", paternalLastName: "Sintético", maternalLastName: "Prueba" }),
  fila("m3", { fullName: "x", run: "135792462", firstName: "Ana", paternalLastName: "Zúñiga", maternalLastName: null }),
  fila("m4", { fullName: "Registro Antiguo", run: "7654321-6", firstName: null, paternalLastName: null, maternalLastName: null }),
];
const list = vi.fn(async (params: { page?: number; pageSize?: number } = {}) => ({
  items: FILAS,
  total: 4,
  page: params.page ?? 1,
  pageSize: params.pageSize ?? 20,
}));
vi.mock("./assignmentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./assignmentApi")>()),
  useSwimmerAssignmentApi: () => ({ list, end: vi.fn(), assignDirectly: vi.fn(), editarFechas: vi.fn() }),
}));
vi.mock("../persons/personsApi", () => ({
  usePersonsApi: () => ({ list: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })) }),
}));

import { ClubSwimmersSection } from "./ClubSwimmersSection";

/** La celda del nadador cuyo texto completo es `texto`: el RUN va en su propio elemento, para no cortarse en el guion. */
const celdaDeNadador = (texto: string) => (_: string, el: Element | null) => el?.tagName === "TD" && el.textContent === texto;

describe("ClubSwimmersSection: presentación de cada nadador", () => {
  it("PATERNO MATERNO, NOMBRES (RUN sin puntos, con guion y K mayúscula), en el orden del servidor", async () => {
    render(<ClubSwimmersSection clubId="c1" clubName="Club Prueba" />);
    await screen.findByText(celdaDeNadador("DE LA FUENTE ÑUÑOA, MARÍA JOSÉ (10000013-K)"));
    const celdas = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => (r as HTMLTableRowElement).cells[0]!.textContent);
    expect(celdas).toEqual([
      "DE LA FUENTE ÑUÑOA, MARÍA JOSÉ (10000013-K)",
      "SINTÉTICO PRUEBA, TOMÁS (13579246-2)",
      "ZÚÑIGA, ANA (13579246-2)",
      "REGISTRO ANTIGUO (7654321-6)",
    ]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ orden: "apellidos" }));
  });
});
