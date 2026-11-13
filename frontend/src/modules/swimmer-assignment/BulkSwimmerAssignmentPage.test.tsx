/** C-05, fase 3: asignación masiva con fecha explícita y códigos por fila. API simulada, jsdom. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BulkSwimmerAssignmentPage } from "./BulkSwimmerAssignmentPage";

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

const NADADORES = [
  { id: "n1", fullName: "Uno Sintético", run: "1-9", gender: "male", birthDate: "1980-01-01" },
  { id: "n2", fullName: "Dos Sintética", run: "2-7", gender: "female", birthDate: "1981-01-01" },
  { id: "n3", fullName: "Tres Sintético", run: "3-5", gender: "male", birthDate: "1982-01-01" },
];

async function preparar() {
  render(
    <MemoryRouter>
      <BulkSwimmerAssignmentPage />
    </MemoryRouter>
  );
  await screen.findByText("Uno Sintético");
  await screen.findAllByRole("option", { name: "Club Destino" }); // figura en el filtro y en el destino
  fireEvent.click(screen.getByRole("button", { name: "Seleccionar todos" }));
  fireEvent.change(screen.getByLabelText("Club de destino"), { target: { value: "club-d" } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T15:00:00Z"));
  vi.resetAllMocks();
  listSwimmersByClub.mockResolvedValue(NADADORES);
});
afterEach(() => vi.useRealTimers());

describe("BulkSwimmerAssignmentPage", () => {
  it("envía la fecha efectiva EXPRESAMENTE y no acepta una futura", async () => {
    bulkAssign.mockResolvedValue({ totalCount: 3, assignedCount: 3, errorCount: 0, results: NADADORES.map((n) => ({ personId: n.id, fullName: n.fullName, status: "assigned" })) });
    await preparar();
    const fecha = screen.getByLabelText(/Fecha efectiva/) as HTMLInputElement;
    expect(fecha.max).toBe("2026-11-12");
    fireEvent.change(fecha, { target: { value: "2026-11-13" } });
    const asignar = screen.getByRole("button", { name: /Asignar 3/ });
    expect(asignar).toBeDisabled();
    fireEvent.change(fecha, { target: { value: "2026-10-01" } });
    fireEvent.click(asignar);
    fireEvent.click(asignar);
    await waitFor(() => expect(bulkAssign).toHaveBeenCalledWith("club-d", ["n1", "n2", "n3"], { fechaEfectiva: "2026-10-01" }));
    expect(bulkAssign, "un solo envío").toHaveBeenCalledTimes(1);
  });

  it("solo las filas HISTORIAL_INCOMPLETO se reintentan, con aceptación sin marcar y la misma fecha y club", async () => {
    bulkAssign.mockResolvedValueOnce({
      totalCount: 3,
      assignedCount: 1,
      errorCount: 2,
      results: [
        { personId: "n1", fullName: "Uno Sintético", status: "assigned" },
        { personId: "n2", fullName: "Dos Sintética", status: "error", error: "Historial incompleto", codigo: "HISTORIAL_INCOMPLETO" },
        { personId: "n3", fullName: "Tres Sintético", status: "error", error: "Conflicto", codigo: "CONFLICTO_DE_FECHAS" },
      ],
    });
    await preparar();
    fireEvent.change(screen.getByLabelText(/Fecha efectiva/), { target: { value: "2026-09-01" } });
    fireEvent.click(screen.getByRole("button", { name: /Asignar 3/ }));

    const casilla = await screen.findByRole("checkbox", { name: /historial incompleto de esos 1/ });
    expect(casilla).not.toBeChecked();
    const reintentar = screen.getByRole("button", { name: "Reintentar 1 con aceptación" });
    expect(reintentar).toBeDisabled();
    expect(screen.getByText(/conflictos de fechas conocidos no se pueden aceptar/)).toBeInTheDocument();

    let resolver!: (v: unknown) => void;
    bulkAssign.mockReturnValueOnce(new Promise((r) => (resolver = r)));
    fireEvent.click(casilla);
    fireEvent.click(reintentar);
    fireEvent.click(reintentar);
    expect(bulkAssign).toHaveBeenCalledTimes(2);
    expect(bulkAssign).toHaveBeenLastCalledWith("club-d", ["n2"], { fechaEfectiva: "2026-09-01", aceptarHistorialIncompleto: true });
    await act(async () => resolver({ totalCount: 1, assignedCount: 1, errorCount: 0, results: [{ personId: "n2", fullName: "Dos Sintética", status: "assigned" }] }));
  });

  it("el rechazo de quien está activo en otro club se conserva y no ofrece aceptación", async () => {
    bulkAssign.mockResolvedValue({
      totalCount: 3,
      assignedCount: 2,
      errorCount: 1,
      results: [
        { personId: "n1", fullName: "Uno Sintético", status: "assigned" },
        { personId: "n2", fullName: "Dos Sintética", status: "assigned" },
        { personId: "n3", fullName: "Tres Sintético", status: "error", error: 'Tiene una membresía activa en "Club Otro"', codigo: "VALIDATION_ERROR" },
      ],
    });
    await preparar();
    fireEvent.click(screen.getByRole("button", { name: /Asignar 3/ }));
    expect(await screen.findByText(/membresía activa en "Club Otro"/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /historial incompleto/ })).not.toBeInTheDocument();
  });
});
