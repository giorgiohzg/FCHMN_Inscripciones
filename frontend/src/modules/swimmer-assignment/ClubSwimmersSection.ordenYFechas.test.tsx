/**
 * Plantel de Editar Club: pide el orden por apellidos al servidor (que ordena antes de paginar) y
 * ofrece «Corregir fechas» SOLO a administración. Datos sintéticos, jsdom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

const list = vi.fn(async (params: { page?: number; pageSize?: number } = {}) => ({
  items: [
    {
      id: "m1",
      clubId: "c1",
      personId: "p1",
      status: "active",
      startDate: "2025-02-01T00:00:00.000Z",
      fechaTermino: null,
      endDate: null,
      person: { id: "p1", fullName: "Ana Sintética", run: "R1" },
      club: { id: "c1", name: "Club Prueba" },
    },
  ],
  total: 1,
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
const esAdmin = { valor: false };
vi.mock("../auth/AuthContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/AuthContext")>()),
  useTieneRol: (rol: string) => rol === "admin" && esAdmin.valor,
}));

import { ClubSwimmersSection } from "./ClubSwimmersSection";

beforeEach(() => {
  list.mockClear();
});

describe("ClubSwimmersSection", () => {
  it("pide el plantel activo ordenado por apellidos, con la página visible", async () => {
    esAdmin.valor = false;
    render(<ClubSwimmersSection clubId="c1" clubName="Club Prueba" />);
    await screen.findByText(/Ana Sintética/);
    expect(list).toHaveBeenCalledWith({ clubId: "c1", status: "active", orden: "apellidos", page: 1, pageSize: 20 });
  });

  it("sin administración no ofrece corregir fechas (aunque vea el plantel)", async () => {
    esAdmin.valor = false;
    render(<ClubSwimmersSection clubId="c1" clubName="Club Prueba" />);
    await screen.findByText(/Ana Sintética/);
    expect(screen.queryByRole("button", { name: "Corregir fechas" })).not.toBeInTheDocument();
  });

  it("administración abre el diálogo de la membresía activa (solo DESDE)", async () => {
    esAdmin.valor = true;
    render(<ClubSwimmersSection clubId="c1" clubName="Club Prueba" />);
    const fila = (await screen.findByText(/Ana Sintética/)).closest("tr")!;
    fireEvent.click(within(fila).getByRole("button", { name: "Corregir fechas" }));
    const dialogo = screen.getByRole("dialog", { name: "Corregir fechas de pertenencia" });
    expect(within(dialogo).getByLabelText(/DESDE/)).toHaveValue("2025-02-01");
    expect(within(dialogo).queryByLabelText(/HASTA/)).not.toBeInTheDocument();
  });
});
