/** C-05, fase 3: gestión de periodos de cambio (solo administración). API simulada, jsdom. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../../shared/apiClient";
import { PeriodosDeCambioPage } from "./PeriodosDeCambioPage";

vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const listarPeriodos = vi.fn();
const crearPeriodo = vi.fn();
const cerrarPeriodo = vi.fn();
vi.mock("./incorporacionesApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./incorporacionesApi")>()),
  useIncorporacionesApi: () => ({ listarPeriodos, crearPeriodo, cerrarPeriodo }),
}));

const P = (id: string, inicio: string, fin: string, extra: Record<string, unknown> = {}) => ({
  id,
  inicio,
  fin,
  motivo: `Motivo ${id}`,
  creadoEn: "2026-01-02T12:00:00.000Z",
  cerradoEn: null,
  ...extra,
});
const VIGENTE = P("vig", "2026-11-01", "2026-11-30");
const PROGRAMADO = P("prog", "2027-03-01", "2027-03-31");
const TERMINADO = P("term", "2026-08-01", "2026-08-31");
const CERRADO = P("cerr", "2026-10-01", "2026-12-31", { cerradoEn: "2026-10-15T15:00:00.000Z" });

function montar() {
  return render(
    <MemoryRouter>
      <PeriodosDeCambioPage />
    </MemoryRouter>
  );
}
const fila = (motivo: string) => screen.getByText(motivo).closest("tr")!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T15:00:00Z"));
  vi.resetAllMocks();
  listarPeriodos.mockResolvedValue([PROGRAMADO, VIGENTE, CERRADO, TERMINADO]);
});
afterEach(() => vi.useRealTimers());

describe("PeriodosDeCambioPage", () => {
  it("lista el historial y marca cuál está vigente; sin edición ni reapertura", async () => {
    montar();
    await screen.findByText("Motivo vig");
    expect(within(fila("Motivo vig")).getByText("Vigente")).toBeInTheDocument();
    expect(within(fila("Motivo prog")).getByText("Programado")).toBeInTheDocument();
    expect(within(fila("Motivo term")).getByText("Terminado")).toBeInTheDocument();
    expect(within(fila("Motivo cerr")).getByText("Cerrado anticipadamente")).toBeInTheDocument();
    expect(within(fila("Motivo cerr")).queryByRole("button"), "un cerrado no se reabre").not.toBeInTheDocument();
    expect(within(fila("Motivo term")).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Editar|Reabrir/ })).not.toBeInTheDocument();
    expect(screen.getByText(/no hay apertura automática, tampoco en marzo o agosto/)).toBeInTheDocument();
  });

  it("crear exige inicio, fin no anterior y motivo; envía las fechas inclusivas", async () => {
    crearPeriodo.mockResolvedValue(P("nuevo", "2027-08-01", "2027-08-31"));
    montar();
    await screen.findByText("Motivo vig");
    const crear = screen.getByRole("button", { name: "Crear periodo" });
    expect(crear).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Inicio/), { target: { value: "2027-08-31" } });
    fireEvent.change(screen.getByLabelText(/Fin/), { target: { value: "2027-08-01" } });
    expect(screen.getByText("El fin no puede ser anterior al inicio.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Inicio/), { target: { value: "2027-08-01" } });
    fireEvent.change(screen.getByLabelText(/Fin/), { target: { value: "2027-08-31" } });
    expect(crear, "sin motivo").toBeDisabled();
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "  Ventana de agosto  " } });
    fireEvent.click(crear);
    fireEvent.click(crear);
    await waitFor(() => expect(crearPeriodo).toHaveBeenCalledWith({ inicio: "2027-08-01", fin: "2027-08-31", motivo: "Ventana de agosto" }));
    expect(crearPeriodo, "un solo envío").toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Periodo creado.")).toBeInTheDocument();
  });

  it("un solape lo informa el servidor (código estructurado) y no se crea nada", async () => {
    crearPeriodo.mockRejectedValue(new ApiError("Ya existe un periodo abierto que se solapa con esas fechas.", 409, "PERIODO_SOLAPADO"));
    montar();
    await screen.findByText("Motivo vig");
    fireEvent.change(screen.getByLabelText(/Inicio/), { target: { value: "2026-11-20" } });
    fireEvent.change(screen.getByLabelText(/Fin/), { target: { value: "2026-12-10" } });
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Solapado" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear periodo" }));
    expect(await screen.findByText(/se solapa/)).toBeInTheDocument();
  });

  it("cerrar pide confirmación, explica que no elimina pendientes, y cancelar no envía", async () => {
    let resolver!: (v: unknown) => void;
    cerrarPeriodo.mockReturnValue(new Promise((r) => (resolver = r)));
    montar();
    await screen.findByText("Motivo vig");
    fireEvent.click(within(fila("Motivo vig")).getByRole("button", { name: "Cerrar anticipadamente" }));
    let dialogo = await screen.findByRole("dialog", { name: "Cerrar periodo anticipadamente" });
    expect(within(dialogo).getByText(/no elimina ni resuelve/)).toBeInTheDocument();
    fireEvent.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    expect(cerrarPeriodo).not.toHaveBeenCalled();

    fireEvent.click(within(fila("Motivo vig")).getByRole("button", { name: "Cerrar anticipadamente" }));
    dialogo = await screen.findByRole("dialog", { name: "Cerrar periodo anticipadamente" });
    const confirmar = within(dialogo).getByRole("button", { name: "Confirmar cierre" });
    fireEvent.click(confirmar);
    fireEvent.click(confirmar);
    expect(cerrarPeriodo).toHaveBeenCalledTimes(1);
    expect(cerrarPeriodo).toHaveBeenCalledWith("vig");
    listarPeriodos.mockResolvedValue([PROGRAMADO, { ...VIGENTE, cerradoEn: "2026-11-12T15:00:00.000Z" }, CERRADO, TERMINADO]);
    await act(async () => resolver({}));
    expect(await screen.findByText(/Las propuestas y solicitudes pendientes se conservan/)).toBeInTheDocument();
    await waitFor(() => expect(within(fila("Motivo vig")).getByText("Cerrado anticipadamente")).toBeInTheDocument());
  });

  it("PERIODO_YA_CERRADO (otro administrador lo cerró antes): se informa y la lista se recarga", async () => {
    cerrarPeriodo.mockRejectedValue(new ApiError("El periodo ya está cerrado.", 409, "PERIODO_YA_CERRADO"));
    montar();
    await screen.findByText("Motivo vig");
    const cargas = listarPeriodos.mock.calls.length;
    fireEvent.click(within(fila("Motivo vig")).getByRole("button", { name: "Cerrar anticipadamente" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirmar cierre" }));
    expect(await screen.findByText("El periodo ya está cerrado.")).toBeInTheDocument();
    await waitFor(() => expect(listarPeriodos.mock.calls.length).toBeGreaterThan(cargas));
  });
});
