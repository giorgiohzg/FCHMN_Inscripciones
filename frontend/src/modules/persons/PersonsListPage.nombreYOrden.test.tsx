/**
 * Personas: «Nombre completo» como PATERNO MATERNO, NOMBRES; RUN sin puntos y con guion; orden por
 * apellidos pedido al SERVIDOR (antes de paginar), también al invertirlo. Datos sintéticos, jsdom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const persona = (id: string, extra: Record<string, unknown>) => ({
  id,
  username: null,
  birthDate: "1980-01-01T00:00:00.000Z",
  gender: "female",
  email: null,
  phone: null,
  status: "active",
  adminAccess: false,
  roles: [],
  firstName: null,
  paternalLastName: null,
  maternalLastName: null,
  ...extra,
});
const PAGINA = [
  persona("p1", {
    run: "13.579.246-2",
    fullName: "Tomás Sintético Prueba",
    firstName: "Tomás",
    paternalLastName: "Sintético",
    maternalLastName: "Prueba",
  }),
  persona("p2", { run: "10000013K", fullName: "Iñaki Núñez", firstName: "Iñaki", paternalLastName: "Núñez", maternalLastName: null }),
  persona("p3", { run: "", fullName: "Registro Antiguo Sin Campos" }),
];
const list = vi.fn(async (_p: Record<string, unknown>) => ({ items: PAGINA, total: 45, page: 1, pageSize: 20 }));
vi.mock("./personsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./personsApi")>()),
  usePersonsApi: () => ({ list, update: vi.fn(), block: vi.fn(), disable: vi.fn(), reactivate: vi.fn(), remove: vi.fn() }),
}));
vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { PersonsListPage } from "./PersonsListPage";

const montar = () =>
  render(
    <MemoryRouter>
      <PersonsListPage />
    </MemoryRouter>
  );

beforeEach(() => list.mockClear());

describe("PersonsListPage: nombre, RUN y orden", () => {
  it("muestra PATERNO MATERNO, NOMBRES y el RUN sin puntos con guion; sin datos, no inventa", async () => {
    montar();
    const fila = (nombre: string) => screen.getByRole("link", { name: nombre }).closest("tr")!;
    expect(await screen.findByRole("link", { name: "SINTÉTICO PRUEBA, TOMÁS" })).toBeInTheDocument();
    expect(within(fila("SINTÉTICO PRUEBA, TOMÁS")).getByText("13579246-2")).toBeInTheDocument();
    expect(within(fila("NÚÑEZ, IÑAKI")).getByText("10000013-K")).toBeInTheDocument();
    expect((fila("REGISTRO ANTIGUO SIN CAMPOS") as HTMLTableRowElement).cells[0]!.textContent).toBe("—");
  });

  it("el orden inicial lo pide al servidor por apellidos ascendente", async () => {
    montar();
    await screen.findByRole("link", { name: "SINTÉTICO PRUEBA, TOMÁS" });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ orden: "apellidos", page: 1 }));
  });

  it("invertir «Nombre completo» pide el orden descendente al servidor desde la página 1, sin reordenar la página", async () => {
    montar();
    await screen.findByRole("link", { name: "SINTÉTICO PRUEBA, TOMÁS" });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ orden: "apellidos", page: 2 })));
    fireEvent.click(screen.getByText(/Nombre completo/));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ orden: "apellidos_desc", page: 1 })));
    // La página llega en el orden del servidor y se muestra tal cual.
    const nombres = screen
      .getAllByRole("link")
      .map((a) => a.textContent)
      .filter((t) => t && t.includes(","));
    expect(nombres).toEqual(["SINTÉTICO PRUEBA, TOMÁS", "NÚÑEZ, IÑAKI"]);
  });

  it("las demás columnas siguen ordenando la página visible, sin pedir otro orden al servidor", async () => {
    montar();
    await screen.findByRole("link", { name: "SINTÉTICO PRUEBA, TOMÁS" });
    const llamadas = list.mock.calls.length;
    fireEvent.click(screen.getByText(/^RUN/));
    // Ordena la página por el RUN almacenado, como antes: NÚÑEZ (10000013K) antes que SINTÉTICO (13.579.246-2).
    await waitFor(() => {
      const orden = screen
        .getAllByRole("link")
        .map((a) => a.textContent)
        .filter((t) => t && t.includes(","));
      expect(orden).toEqual(["NÚÑEZ, IÑAKI", "SINTÉTICO PRUEBA, TOMÁS"]);
    });
    expect(list.mock.calls.length).toBe(llamadas);
  });
});
