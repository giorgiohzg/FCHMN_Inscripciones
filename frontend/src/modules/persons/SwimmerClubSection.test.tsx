/** C-05, fase 3: club de la persona, historial de pertenencia y traslado revisado. API simulada, jsdom. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { SwimmerClubSection } from "./SwimmerClubSection";

vi.mock("../clubs/clubsApi", () => ({
  useClubsApi: () => ({
    list: async () => ({ items: [{ id: "club-a", name: "Club Actual" }, { id: "club-n", name: "Club Nuevo" }], total: 2, page: 1, pageSize: 100 }),
  }),
}));
const list = vi.fn();
const reassign = vi.fn();
vi.mock("../swimmer-assignment/assignmentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../swimmer-assignment/assignmentApi")>()),
  useSwimmerAssignmentApi: () => ({ list, reassign }),
}));

const PERSONA = { id: "p-1", fullName: "Nadadora Sintética", run: "1-9" };
const m = (id: string, club: { id: string; name: string }, extra: Record<string, unknown>) => ({
  id,
  clubId: club.id,
  personId: PERSONA.id,
  club,
  person: PERSONA,
  endDate: null,
  fechaTermino: null,
  startDate: null,
  ...extra,
});
const VIGENTE = m("m-a", { id: "club-a", name: "Club Actual" }, { status: "active", startDate: "2026-02-01T00:00:00.000Z" });
const CONOCIDA = m("m-1", { id: "club-x", name: "Club Antiguo" }, { status: "ended", startDate: "2024-01-01T00:00:00.000Z", fechaTermino: "2025-12-31T00:00:00.000Z", endDate: "2026-01-20T10:00:00.000Z" });
const DESCONOCIDA = m("m-0", { id: "club-y", name: "Club Muy Antiguo" }, { status: "ended", startDate: "2020-01-01T00:00:00.000Z", endDate: "2021-03-03T10:00:00.000Z" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T15:00:00Z"));
  vi.resetAllMocks();
  list.mockResolvedValue({ items: [VIGENTE, CONOCIDA, DESCONOCIDA], total: 3, page: 1, pageSize: 100 });
});
afterEach(() => vi.useRealTimers());

describe("SwimmerClubSection", () => {
  it("muestra el club vigente y el historial con fecha_termino; un término desconocido se dice", async () => {
    render(<SwimmerClubSection personId={PERSONA.id} />);
    expect(await screen.findByText(/desde el 01-02-2026/)).toBeInTheDocument();
    const tabla = screen.getByRole("table");
    expect(within(tabla).getByText("31-12-2025")).toBeInTheDocument();
    expect(within(tabla).getByText("Desconocido")).toBeInTheDocument();
    expect(within(tabla).queryByText(/20-01-2026|03-03-2021/), "endDate no es una fecha de pertenencia").not.toBeInTheDocument();
  });

  it("cambiar de club: revisa origen y destino, exige confirmar la vigente y envía la fecha", async () => {
    reassign.mockResolvedValue({});
    render(<SwimmerClubSection personId={PERSONA.id} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cambiar de club" }));
    fireEvent.change(screen.getByLabelText("Nuevo club"), { target: { value: "club-n" } });
    const casilla = await screen.findByRole("checkbox", { name: /Confirmo finalizar la membresía vigente en Club Actual/ });
    const confirmar = screen.getByRole("button", { name: "Confirmar cambio de club" });
    expect(confirmar).toBeDisabled();
    fireEvent.click(casilla);
    fireEvent.click(confirmar);
    await waitFor(() => expect(reassign).toHaveBeenCalledWith("p-1", "club-n", { fechaEfectiva: "2026-11-12", confirmarFinDeMembresiaId: "m-a" }));
    expect(await screen.findByText("Club actualizado correctamente.")).toBeInTheDocument();
  });

  it("cancelar no envía nada", async () => {
    render(<SwimmerClubSection personId={PERSONA.id} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cambiar de club" }));
    fireEvent.change(screen.getByLabelText("Nuevo club"), { target: { value: "club-n" } });
    await screen.findByRole("checkbox", { name: /Confirmo finalizar/ });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(reassign).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cambiar de club" })).toBeInTheDocument();
  });
});

describe("historial completo y una sola reasignación en curso", () => {
  /** 130 membresías en el orden del backend; la activa es la 120 (página 2). */
  const largo = Array.from({ length: 130 }, (_, i) =>
    i === 119
      ? m("m-vig2", { id: "club-a", name: "Club Actual" }, { status: "active", startDate: "2026-02-01T00:00:00.000Z" })
      : m(`m-h${i}`, { id: `club-h${i}`, name: `Club Histórico ${i}` }, { status: "ended", startDate: "2010-01-01T00:00:00.000Z", fechaTermino: "2010-12-31T00:00:00.000Z" })
  );
  const paginado = async ({ page = 1, pageSize = 20 }: { page?: number; pageSize?: number }) => {
    const tam = Math.min(pageSize, 100);
    return { items: largo.slice((page - 1) * tam, page * tam), total: largo.length, page, pageSize: tam };
  };

  it("con la activa en la página 2: identifica el club vigente y muestra el historial entero", async () => {
    list.mockImplementation(paginado);
    render(<SwimmerClubSection personId={PERSONA.id} />);
    expect(await screen.findByText(/desde el 01-02-2026/)).toBeInTheDocument();
    expect(screen.getByText("Club Actual", { selector: "strong" })).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(131); // cabecera + 130
    expect(list.mock.calls.map((c) => c[0].page)).toEqual([1, 2]);
  });

  it("si falla una página, no afirma «no tiene club» ni un historial incompleto", async () => {
    list.mockImplementation(async (p: { page?: number; pageSize?: number }) => {
      if (p.page === 2) throw new Error("Error 503");
      return paginado(p);
    });
    render(<SwimmerClubSection personId={PERSONA.id} />);
    expect(await screen.findByText(/Error 503/)).toBeInTheDocument();
    expect(screen.queryByText("No tiene club asignado.")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("al cambiar de persona, la carga atrasada de la anterior no se aplica y el formulario se reinicia", async () => {
    let resolverA!: (v: unknown) => void;
    list.mockImplementation((p: { personId: string }) =>
      p.personId === "p-a"
        ? new Promise((r) => (resolverA = r))
        : Promise.resolve({ items: [m("m-b", { id: "club-n", name: "Club Nuevo" }, { status: "active", startDate: "2026-03-03T00:00:00.000Z" })], total: 1, page: 1, pageSize: 100 })
    );
    const { rerender } = render(<SwimmerClubSection personId="p-a" />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    rerender(<SwimmerClubSection personId="p-b" />);
    expect(await screen.findByText(/desde el 03-03-2026/)).toBeInTheDocument();
    await act(async () => resolverA({ items: [VIGENTE], total: 1, page: 1, pageSize: 100 }));
    expect(screen.queryByText(/desde el 01-02-2026/), "lo de la persona anterior no aparece").not.toBeInTheDocument();
  });

  it("reasignación en curso: el destino no cambia, no se cancela, una sola escritura; tras el error se reintenta", async () => {
    let rechazar!: (e: unknown) => void;
    reassign.mockImplementationOnce(() => new Promise((_, rej) => (rechazar = rej)));
    render(<SwimmerClubSection personId={PERSONA.id} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cambiar de club" }));
    fireEvent.change(screen.getByLabelText("Nuevo club"), { target: { value: "club-n" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: /Confirmo finalizar/ }));
    const confirmar = screen.getByRole("button", { name: "Confirmar cambio de club" });
    fireEvent.click(confirmar);
    fireEvent.click(confirmar);

    const destino = screen.getByLabelText("Nuevo club") as HTMLSelectElement;
    await waitFor(() => expect(destino).toBeDisabled());
    fireEvent.change(destino, { target: { value: "" } });
    expect(destino.value, "el destino de la operación enviada no cambia").toBe("club-n");
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    expect(reassign).toHaveBeenCalledTimes(1);

    await act(async () => rechazar(new Error("Error 500 sintético")));
    expect(await screen.findByText("Error 500 sintético")).toBeInTheDocument();
    expect(destino).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeEnabled();

    reassign.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cambio de club" }));
    await waitFor(() => expect(reassign).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Club actualizado correctamente.")).toBeInTheDocument();
  });
});
