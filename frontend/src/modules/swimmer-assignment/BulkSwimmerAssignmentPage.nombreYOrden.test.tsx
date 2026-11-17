/**
 * Asignación masiva: nadadores como «PATERNO MATERNO, NOMBRES» con RUN sin puntos y con guion, en el
 * orden por apellidos que entrega el servidor (lista completa, sin paginar); invertirlo invierte la
 * lista completa. API simulada, datos SINTÉTICOS, jsdom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../clubs/clubsApi", () => ({
  useClubsApi: () => ({ list: async () => ({ items: [{ id: "club-d", name: "Club Destino" }], total: 1, page: 1, pageSize: 100 }) }),
}));
const listSwimmersByClub = vi.fn();
const bulkAssign = vi.fn();
vi.mock("./assignmentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./assignmentApi")>()),
  useSwimmerAssignmentApi: () => ({ listSwimmersByClub, bulkAssign }),
}));

import { BulkSwimmerAssignmentPage } from "./BulkSwimmerAssignmentPage";

const base = { gender: "male", birthDate: "1980-01-01" };
/** En el orden del servidor (apellidos; incompletos al final). */
const NADADORES = [
  { ...base, id: "n1", run: "10000013k", fullName: "María José de la Fuente", firstName: "María José", paternalLastName: "de la Fuente", maternalLastName: null },
  { ...base, id: "n2", run: "135792462", fullName: "Tomás Sintético Prueba", firstName: "Tomás", paternalLastName: "Sintético", maternalLastName: "Prueba" },
  { ...base, id: "n3", run: "012345678", fullName: "Iñaki Zúñiga Ñuñoa", firstName: "Iñaki", paternalLastName: "Zúñiga", maternalLastName: "Ñuñoa" },
  { ...base, id: "n4", run: "76543216", fullName: "Registro Antiguo Sin Campos" },
];

const filas = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((f) => [(f as HTMLTableRowElement).cells[1]!.textContent, (f as HTMLTableRowElement).cells[2]!.textContent]);

async function montar() {
  render(
    <MemoryRouter>
      <BulkSwimmerAssignmentPage />
    </MemoryRouter>
  );
  await screen.findByText("SINTÉTICO PRUEBA, TOMÁS");
}

beforeEach(() => {
  vi.resetAllMocks();
  listSwimmersByClub.mockResolvedValue(NADADORES);
});

describe("Asignación masiva: nombre, RUN y orden", () => {
  it("conserva el orden del servidor y presenta nombre y RUN estandarizados, sin inventar datos", async () => {
    await montar();
    expect(filas()).toEqual([
      ["DE LA FUENTE, MARÍA JOSÉ", "10000013-K"],
      ["SINTÉTICO PRUEBA, TOMÁS", "13579246-2"],
      ["ZÚÑIGA ÑUÑOA, IÑAKI", "01234567-8"],
      ["REGISTRO ANTIGUO SIN CAMPOS", "7654321-6"],
    ]);
    expect(screen.getByRole("checkbox", { name: "Seleccionar a SINTÉTICO PRUEBA, TOMÁS (13579246-2)" })).toBeInTheDocument();
  });

  it("«Nadador» invierte la lista completa; «RUN» ordena por RUN", async () => {
    await montar();
    fireEvent.click(screen.getByRole("columnheader", { name: /Nadador/ }));
    expect(filas().map((f) => f[0])).toEqual(["REGISTRO ANTIGUO SIN CAMPOS", "ZÚÑIGA ÑUÑOA, IÑAKI", "SINTÉTICO PRUEBA, TOMÁS", "DE LA FUENTE, MARÍA JOSÉ"]);
    fireEvent.click(screen.getByRole("columnheader", { name: /RUN/ }));
    expect(filas().map((f) => f[1])).toEqual(["01234567-8", "10000013-K", "13579246-2", "7654321-6"]);
  });

  it("la búsqueda y el filtro se siguen enviando al servidor igual que antes", async () => {
    await montar();
    expect(listSwimmersByClub).toHaveBeenLastCalledWith("none", undefined);
    fireEvent.change(screen.getByLabelText(/Buscar por nombre o RUN/), { target: { value: "Prueba" } });
    await waitFor(() => expect(listSwimmersByClub).toHaveBeenLastCalledWith("none", "Prueba"));
  });

  it("el resultado de la tanda muestra a cada nadador con el mismo formato, aunque la lista se recargue", async () => {
    bulkAssign.mockResolvedValue({
      totalCount: 2,
      assignedCount: 1,
      errorCount: 1,
      results: [
        { personId: "n2", fullName: "Tomás Sintético Prueba", status: "assigned" },
        { personId: "n1", fullName: "María José de la Fuente", status: "error", error: "Conflicto", codigo: "CONFLICTO_DE_FECHAS" },
      ],
    });
    await montar();
    await screen.findAllByRole("option", { name: "Club Destino" });
    fireEvent.click(screen.getByRole("checkbox", { name: /SINTÉTICO PRUEBA, TOMÁS/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /DE LA FUENTE, MARÍA JOSÉ/ }));
    fireEvent.change(screen.getByLabelText("Club de destino"), { target: { value: "club-d" } });
    listSwimmersByClub.mockResolvedValue([]); // tras asignar, la lista ya no los trae
    fireEvent.click(screen.getByRole("button", { name: /Asignar 2/ }));
    await screen.findByRole("heading", { name: "Resultado" });
    const resultado = screen.getAllByRole("table")[screen.getAllByRole("table").length - 1]!;
    const celdas = [...resultado.querySelectorAll("tbody td:first-child")];
    expect(celdas.map((c) => c.textContent)).toEqual(["SINTÉTICO PRUEBA, TOMÁS (13579246-2)", "DE LA FUENTE, MARÍA JOSÉ (10000013-K)"]);
    // El RUN no se corta en el guion tampoco en el resultado.
    expect(within(celdas[0] as HTMLElement).getByText("(13579246-2)")).toHaveStyle({ whiteSpace: "nowrap" });
  });
});
