/**
 * Asignación de Nadadores a Clubes: cada nadador como «PATERNO MATERNO, NOMBRES (RUN)», RUN sin
 * puntos y con guion, y orden por apellidos pedido al SERVIDOR (antes de paginar), también al
 * invertirlo. API simulada, datos SINTÉTICOS, jsdom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../auth/AuthContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/AuthContext")>()),
  useTieneRol: () => true,
}));

type Persona = { id: string; fullName: string; run: string; firstName?: string | null; paternalLastName?: string | null; maternalLastName?: string | null };
const membresia = (id: string, club: string, person: Persona, status = "active") => ({
  id,
  clubId: `c-${club}`,
  personId: person.id,
  status,
  startDate: status === "pending" ? null : "2025-03-01T00:00:00.000Z",
  fechaTermino: null,
  endDate: null,
  club: { id: `c-${club}`, name: club },
  person,
});
/** Una página tal como la entrega el servidor (ya ordenada por apellidos). */
const PAGINA = [
  membresia("m1", "Club Beta", {
    id: "p1",
    run: "135792462",
    fullName: "Tomás Sintético Prueba",
    firstName: "Tomás",
    paternalLastName: "Sintético",
    maternalLastName: "Prueba",
  }),
  membresia("m2", "Club Alfa", {
    id: "p2",
    run: "10.000.013-k",
    fullName: "María José de la Fuente",
    firstName: "María José",
    paternalLastName: "de la Fuente",
    maternalLastName: null,
  }),
  membresia("m3", "Club Gama", { id: "p3", run: "012345678", fullName: "Iñaki  Zúñiga Ñuñoa", firstName: "Iñaki", paternalLastName: "Zúñiga", maternalLastName: "Ñuñoa" }),
  membresia("m4", "Club Delta", { id: "p4", run: "", fullName: "Registro Antiguo Sin Campos" }, "pending"),
];

const list = vi.fn(async (_p: Record<string, unknown>) => ({ items: PAGINA, total: 45, page: 1, pageSize: 20 }));
vi.mock("./assignmentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./assignmentApi")>()),
  useSwimmerAssignmentApi: () => ({ list, approve: vi.fn(), reject: vi.fn(), end: vi.fn(), editarFechas: vi.fn() }),
}));

import { SwimmerAssignmentsPage } from "./SwimmerAssignmentsPage";

const montar = () =>
  render(
    <MemoryRouter>
      <SwimmerAssignmentsPage />
    </MemoryRouter>
  );
/** Texto de la celda «Nadador» de cada fila de datos, en el orden visible. */
const nadadores = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((f) => (f as HTMLTableRowElement).cells[0]!.textContent);
const ultimaLlamada = () => list.mock.calls[list.mock.calls.length - 1]![0];

beforeEach(() => list.mockClear());

describe("Asignación de Nadadores: presentación", () => {
  it("PATERNO MATERNO, NOMBRES (RUN): mayúsculas con tildes y Ñ, RUN con guion, K mayúscula y ceros iniciales; sin datos no inventa", async () => {
    montar();
    await screen.findByText(/SINTÉTICO PRUEBA, TOMÁS/);
    expect(nadadores()).toEqual([
      "SINTÉTICO PRUEBA, TOMÁS (13579246-2)",
      "DE LA FUENTE, MARÍA JOSÉ (10000013-K)",
      "ZÚÑIGA ÑUÑOA, IÑAKI (01234567-8)",
      "REGISTRO ANTIGUO SIN CAMPOS",
    ]);
  });

  it("el RUN no se corta en el guion", async () => {
    montar();
    const run = await screen.findByText("(13579246-2)");
    expect(run).toHaveStyle({ whiteSpace: "nowrap" });
  });

  it("los diálogos de rechazo, baja y fechas muestran al nadador con el mismo formato", async () => {
    montar();
    await screen.findByText(/SINTÉTICO PRUEBA, TOMÁS/);

    fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
    const rechazo = screen.getByRole("dialog", { name: "Rechazar propuesta" });
    expect(rechazo.textContent).toContain("REGISTRO ANTIGUO SIN CAMPOS en Club Delta.");
    fireEvent.click(within(rechazo).getByRole("button", { name: "Cancelar" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Finalizar membresía" })[0]!);
    const baja = screen.getByRole("dialog", { name: "Baja de membresía" });
    expect(within(baja).getByText(/SINTÉTICO PRUEBA, TOMÁS/).closest("dd")!.textContent).toBe("SINTÉTICO PRUEBA, TOMÁS (13579246-2)");
    fireEvent.click(within(baja).getByRole("button", { name: "Cancelar" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Corregir fechas" })[1]!);
    const fechas = screen.getByRole("dialog", { name: "Corregir fechas de pertenencia" });
    expect(within(fechas).getByText(/DE LA FUENTE, MARÍA JOSÉ/).closest("dd")!.textContent).toBe("DE LA FUENTE, MARÍA JOSÉ (10000013-K)");
  });
});

describe("Asignación de Nadadores: orden en el servidor", () => {
  it("el orden inicial por apellidos se pide al servidor, con el filtro de estado de siempre", async () => {
    montar();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(ultimaLlamada()).toEqual({ status: "pending", orden: "nadador", page: 1 });
  });

  it("invertir «Nadador» pide el orden inverso al servidor y vuelve a la página 1; otra vez, ascendente", async () => {
    montar();
    await screen.findByText(/SINTÉTICO PRUEBA, TOMÁS/);
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(ultimaLlamada()).toMatchObject({ orden: "nadador", page: 2 }));

    fireEvent.click(screen.getByRole("columnheader", { name: /Nadador/ }));
    await waitFor(() => expect(ultimaLlamada()).toEqual({ status: "pending", orden: "nadador_desc", page: 1 }));
    // El servidor ya entrega la página en el orden pedido: la pantalla no la reordena.
    expect(nadadores()[0]).toBe("SINTÉTICO PRUEBA, TOMÁS (13579246-2)");

    fireEvent.click(screen.getByRole("columnheader", { name: /Nadador/ }));
    await waitFor(() => expect(ultimaLlamada()).toEqual({ status: "pending", orden: "nadador", page: 1 }));
  });

  it("cambiar el estado conserva el orden por nadador y vuelve a la página 1", async () => {
    montar();
    await screen.findByText(/SINTÉTICO PRUEBA, TOMÁS/);
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "active" } });
    await waitFor(() => expect(ultimaLlamada()).toEqual({ status: "active", orden: "nadador", page: 1 }));
  });

  it("«Club» ordena solo la página visible y no cambia el orden pedido al servidor", async () => {
    montar();
    await screen.findByText(/SINTÉTICO PRUEBA, TOMÁS/);
    const llamadas = list.mock.calls.length;
    fireEvent.click(screen.getByRole("columnheader", { name: /Club/ }));
    expect(nadadores()).toEqual([
      "DE LA FUENTE, MARÍA JOSÉ (10000013-K)",
      "SINTÉTICO PRUEBA, TOMÁS (13579246-2)",
      "REGISTRO ANTIGUO SIN CAMPOS",
      "ZÚÑIGA ÑUÑOA, IÑAKI (01234567-8)",
    ]);
    expect(list.mock.calls.length, "orden local: sin otra petición").toBe(llamadas);
  });
});
