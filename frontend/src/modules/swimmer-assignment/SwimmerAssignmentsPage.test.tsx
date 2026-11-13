/**
 * C-05, fase 3: revisión de propuestas, traslado confirmado, baja con fecha y fechas de
 * pertenencia en la pantalla de asignaciones. API simulada, datos sintéticos, jsdom.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StrictMode } from "react";
import { ApiError } from "../../shared/apiClient";
import { SwimmerAssignmentsPage } from "./SwimmerAssignmentsPage";

vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const list = vi.fn();
const approve = vi.fn();
const reject = vi.fn();
const end = vi.fn();
vi.mock("./assignmentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./assignmentApi")>()),
  useSwimmerAssignmentApi: () => ({ list, approve, reject, end }),
}));

const CLUB_A = { id: "club-a", name: "Club Origen" };
const CLUB_B = { id: "club-b", name: "Club Destino" };
const PERSONA = { id: "p-1", fullName: "Nadador Sintético", run: "11111111-1" };

function fila(parcial: Record<string, unknown>) {
  return { id: "m", clubId: CLUB_B.id, personId: PERSONA.id, status: "pending", startDate: null, fechaTermino: null, endDate: null, club: CLUB_B, person: PERSONA, ...parcial };
}
const PROPUESTA = fila({ id: "prop-1" });
const VIGENTE = fila({ id: "vig-1", clubId: CLUB_A.id, club: CLUB_A, status: "active", startDate: "2026-01-10T00:00:00.000Z" });
const pagina = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20 });

/** Lista de la pantalla según el filtro; historial de la persona según `historial`. */
let historial: unknown[] = [VIGENTE];
let listaPrincipal: unknown[] = [PROPUESTA];
function servidor() {
  list.mockImplementation(async (p: { personId?: string } = {}) => (p.personId ? pagina(historial) : pagina(listaPrincipal)));
}

function montar() {
  return render(
    <MemoryRouter>
      <SwimmerAssignmentsPage />
    </MemoryRouter>
  );
}

async function abrirAprobacion() {
  montar();
  fireEvent.click(await screen.findByRole("button", { name: "Aprobar" }));
  const dialogo = await screen.findByRole("dialog", { name: "Aprobar propuesta" });
  await within(dialogo).findByText("Club de origen");
  return dialogo;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T15:00:00Z")); // 12:00 en Santiago
  vi.resetAllMocks();
  historial = [VIGENTE];
  listaPrincipal = [PROPUESTA];
  servidor();
});
afterEach(() => vi.useRealTimers());

describe("fechas de pertenencia", () => {
  it("«Hasta» es fecha_termino; si se desconoce, se dice; endDate nunca la sustituye", async () => {
    listaPrincipal = [
      fila({ id: "e1", status: "ended", startDate: "2025-01-01T00:00:00.000Z", fechaTermino: "2025-06-30T00:00:00.000Z", endDate: "2025-08-15T14:00:00.000Z" }),
      fila({ id: "e2", status: "ended", startDate: "2024-01-01T00:00:00.000Z", fechaTermino: null, endDate: "2024-09-09T14:00:00.000Z" }),
    ];
    servidor();
    montar();
    expect(await screen.findByText("30-06-2025")).toBeInTheDocument();
    expect(screen.getByText("Desconocido")).toBeInTheDocument();
    expect(screen.queryByText(/15-08-2025|09-09-2024/), "el instante de la operación no se muestra como término").not.toBeInTheDocument();
  });
});

describe("aprobación con traslado", () => {
  it("muestra origen, destino y fechas, y exige confirmar EXPRESAMENTE la vigente", async () => {
    const dialogo = await abrirAprobacion();
    expect(within(dialogo).getByText(CLUB_A.name)).toBeInTheDocument();
    expect(within(dialogo).getAllByText(CLUB_B.name).length).toBeGreaterThan(0);
    expect(within(dialogo).getByText("10-01-2026"), "inicio en el origen").toBeInTheDocument();
    expect(within(dialogo).getByText("11-11-2026"), "último día en el origen: el anterior a hoy").toBeInTheDocument();

    const aprobar = within(dialogo).getByRole("button", { name: "Aprobar" });
    const casilla = within(dialogo).getByRole("checkbox", { name: /Confirmo finalizar la membresía vigente/ });
    expect(casilla, "no viene marcada").not.toBeChecked();
    expect(aprobar).toBeDisabled();

    fireEvent.click(casilla);
    approve.mockResolvedValue({});
    fireEvent.click(aprobar);
    await waitFor(() => expect(approve).toHaveBeenCalledWith("prop-1", { fechaEfectiva: "2026-11-12", confirmarFinDeMembresiaId: "vig-1" }));
  });

  it("la fecha efectiva no puede ser futura; cambiarla obliga a confirmar otra vez", async () => {
    const dialogo = await abrirAprobacion();
    const fecha = within(dialogo).getByLabelText(/Fecha efectiva/) as HTMLInputElement;
    expect(fecha.max).toBe("2026-11-12");
    fireEvent.click(within(dialogo).getByRole("checkbox", { name: /Confirmo finalizar/ }));
    fireEvent.change(fecha, { target: { value: "2026-11-13" } });
    expect(within(dialogo).getByRole("checkbox", { name: /Confirmo finalizar/ }), "la confirmación se retira").not.toBeChecked();
    expect(within(dialogo).getByRole("button", { name: "Aprobar" })).toBeDisabled();
    expect(within(dialogo).getByText(/no puede ser posterior a hoy/)).toBeInTheDocument();
  });

  it("REVISAR_DE_NUEVO: recarga, desmarca y NO reintenta solo", async () => {
    const dialogo = await abrirAprobacion();
    fireEvent.click(within(dialogo).getByRole("checkbox", { name: /Confirmo finalizar/ }));
    approve.mockRejectedValueOnce(new ApiError("cambió", 409, "REVISAR_DE_NUEVO", { membresiaVigente: { id: "vig-2" } }));
    const otraVigente = fila({ id: "vig-2", clubId: "club-c", club: { id: "club-c", name: "Club Tercero" }, status: "active", startDate: "2026-05-01T00:00:00.000Z" });
    historial = [otraVigente];
    const cargasAntes = list.mock.calls.filter((c) => c[0]?.personId).length;
    fireEvent.click(within(dialogo).getByRole("button", { name: "Aprobar" }));

    expect(await within(dialogo).findByText(/cambió desde que se cargó esta revisión/)).toBeInTheDocument();
    expect(await within(dialogo).findByText("Club Tercero"), "muestra la vigente NUEVA, recargada").toBeInTheDocument();
    expect(list.mock.calls.filter((c) => c[0]?.personId).length).toBeGreaterThan(cargasAntes);
    const casilla = within(dialogo).getByRole("checkbox", { name: /Confirmo finalizar/ });
    expect(casilla).not.toBeChecked();
    expect(approve, "sin reintento automático").toHaveBeenCalledTimes(1);

    fireEvent.click(casilla);
    approve.mockResolvedValueOnce({});
    fireEvent.click(within(dialogo).getByRole("button", { name: "Aprobar" }));
    await waitFor(() => expect(approve).toHaveBeenLastCalledWith("prop-1", { fechaEfectiva: "2026-11-12", confirmarFinDeMembresiaId: "vig-2" }));
  });

  it("HISTORIAL_INCOMPLETO: muestra la membresía afectada y exige una aceptación NO preseleccionada", async () => {
    const antigua = fila({ id: "ant-1", clubId: "club-c", club: { id: "club-c", name: "Club Antiguo" }, status: "ended", startDate: "2020-01-01T00:00:00.000Z", fechaTermino: null });
    historial = [VIGENTE, antigua];
    const dialogo = await abrirAprobacion();
    fireEvent.click(within(dialogo).getByRole("checkbox", { name: /Confirmo finalizar/ }));
    approve.mockRejectedValueOnce(new ApiError("incompleto", 409, "HISTORIAL_INCOMPLETO", { membresias: ["ant-1"] }));
    fireEvent.click(within(dialogo).getByRole("button", { name: "Aprobar" }));

    expect(await within(dialogo).findByText(/Club Antiguo: inicio 01-01-2020, término desconocido/)).toBeInTheDocument();
    const acepta = within(dialogo).getByRole("checkbox", { name: /Acepto, como administración, el historial incompleto/ });
    expect(acepta).not.toBeChecked();
    expect(within(dialogo).getByRole("button", { name: "Aprobar" })).toBeDisabled();

    fireEvent.click(acepta);
    approve.mockResolvedValueOnce({});
    fireEvent.click(within(dialogo).getByRole("button", { name: "Aprobar" }));
    await waitFor(() =>
      expect(approve).toHaveBeenLastCalledWith("prop-1", { fechaEfectiva: "2026-11-12", confirmarFinDeMembresiaId: "vig-1", aceptarHistorialIncompleto: true })
    );
  });

  it("CONFLICTO_DE_FECHAS: se muestra y NO ofrece aceptación para eludirlo", async () => {
    const dialogo = await abrirAprobacion();
    fireEvent.click(within(dialogo).getByRole("checkbox", { name: /Confirmo finalizar/ }));
    approve.mockRejectedValue(
      new ApiError("conflicto", 409, "CONFLICTO_DE_FECHAS", { conflictos: [{ membresiaId: "vig-1", motivo: "la membresía vigente empezó el 2026-01-10" }] })
    );
    fireEvent.click(within(dialogo).getByRole("button", { name: "Aprobar" }));
    expect(await within(dialogo).findByText(/no se puede aceptar: elija otra fecha/)).toBeInTheDocument();
    expect(within(dialogo).queryByRole("checkbox", { name: /historial incompleto/ })).not.toBeInTheDocument();
    for (const llamada of approve.mock.calls) expect(llamada[1]).not.toHaveProperty("aceptarHistorialIncompleto");
  });

  it("DOBLE clic en aprobar: una sola petición", async () => {
    const dialogo = await abrirAprobacion();
    fireEvent.click(within(dialogo).getByRole("checkbox", { name: /Confirmo finalizar/ }));
    let resolver!: (v: unknown) => void;
    approve.mockReturnValue(new Promise((r) => (resolver = r)));
    const boton = within(dialogo).getByRole("button", { name: "Aprobar" });
    fireEvent.click(boton);
    fireEvent.click(boton);
    expect(approve).toHaveBeenCalledTimes(1);
    await act(async () => resolver({}));
  });
});

describe("StrictMode (desarrollo)", () => {
  it("con el montaje doble de StrictMode, la revisión aplica su carga y muestra el traslado", async () => {
    render(
      <StrictMode>
        <MemoryRouter>
          <SwimmerAssignmentsPage />
        </MemoryRouter>
      </StrictMode>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Aprobar" }));
    const dialogo = await screen.findByRole("dialog", { name: "Aprobar propuesta" });
    expect(await within(dialogo).findByText("Club de origen")).toBeInTheDocument();
  });
});

describe("rechazo y baja", () => {
  it("rechazar: cancelar no envía; confirmar envía el motivo", async () => {
    montar();
    fireEvent.click(await screen.findByRole("button", { name: "Rechazar" }));
    let dialogo = await screen.findByRole("dialog", { name: "Rechazar propuesta" });
    fireEvent.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    expect(reject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
    dialogo = await screen.findByRole("dialog", { name: "Rechazar propuesta" });
    fireEvent.change(within(dialogo).getByLabelText(/Motivo/), { target: { value: "Duplicada (sintético)" } });
    reject.mockResolvedValue({});
    fireEvent.click(within(dialogo).getByRole("button", { name: "Confirmar rechazo" }));
    await waitFor(() => expect(reject).toHaveBeenCalledWith("prop-1", "Duplicada (sintético)"));
  });

  it("baja: envía la fecha elegida; MEMBRESIA_NO_ACTIVA cierra el diálogo, informa y recarga", async () => {
    listaPrincipal = [VIGENTE];
    servidor();
    montar();
    fireEvent.click(await screen.findByRole("button", { name: "Finalizar membresía" }));
    const dialogo = await screen.findByRole("dialog", { name: "Baja de membresía" });
    fireEvent.change(within(dialogo).getByLabelText(/Fecha de término/), { target: { value: "2026-04-30" } });
    end.mockRejectedValueOnce(new ApiError("La membresía ya no está activa: otra operación la cambió.", 409, "MEMBRESIA_NO_ACTIVA"));
    const cargasAntes = list.mock.calls.length;
    fireEvent.click(within(dialogo).getByRole("button", { name: "Confirmar baja" }));

    await waitFor(() => expect(end).toHaveBeenCalledWith("vig-1", { fechaTermino: "2026-04-30" }));
    expect(await screen.findByText(/ya no está activa/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(cargasAntes));
  });
});

describe("respuestas obsoletas", () => {
  it("la lista de un filtro anterior que llega tarde no pisa la del filtro actual", async () => {
    let resolverVieja!: (v: unknown) => void;
    list.mockImplementationOnce(() => new Promise((r) => (resolverVieja = r)));
    list.mockImplementation(async () => pagina([fila({ id: "act-1", status: "active", startDate: "2026-02-02T00:00:00.000Z", person: { ...PERSONA, fullName: "Activa Actual" } })]));
    montar();
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "active" } });
    expect(await screen.findByText(/Activa Actual/)).toBeInTheDocument();
    await act(async () => resolverVieja(pagina([fila({ id: "vieja", person: { ...PERSONA, fullName: "Pendiente Vieja" } })])));
    expect(screen.queryByText(/Pendiente Vieja/)).not.toBeInTheDocument();
  });
});

describe("una sola operación en curso (promesas controladas)", () => {
  it("aprobando: Escape y el fondo no cierran, no se puede rechazar, una sola escritura; tras el error se reintenta", async () => {
    const dialogo = await abrirAprobacion();
    fireEvent.click(within(dialogo).getByRole("checkbox", { name: /Confirmo finalizar/ }));
    let rechazarAprobacion!: (e: unknown) => void;
    approve.mockImplementationOnce(() => new Promise((_, rej) => (rechazarAprobacion = rej)));
    const aprobar = within(dialogo).getByRole("button", { name: "Aprobar" });
    fireEvent.click(aprobar);
    fireEvent.click(aprobar);

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".dialogo-fondo")!);
    expect(screen.getByRole("dialog", { name: "Aprobar propuesta" }), "el flujo sigue montado").toBeInTheDocument();
    expect(within(dialogo).getByRole("button", { name: "Cancelar" })).toBeDisabled();

    // La acción exterior de la misma fila no puede abrirse mientras tanto.
    const rechazarFila = screen.getAllByRole("button", { name: "Rechazar" })[0]!;
    expect(rechazarFila).toBeDisabled();
    fireEvent.click(rechazarFila);
    expect(screen.queryByRole("dialog", { name: "Rechazar propuesta" })).not.toBeInTheDocument();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();

    await act(async () => rechazarAprobacion(new ApiError("Error 500 sintético", 500)));
    expect(await within(dialogo).findByText("Error 500 sintético")).toBeInTheDocument();
    expect(within(dialogo).getByRole("button", { name: "Cancelar" })).toBeEnabled();
    expect(rechazarFila).toBeEnabled();

    approve.mockResolvedValueOnce({});
    fireEvent.click(within(dialogo).getByRole("button", { name: "Aprobar" }));
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("rechazando: Escape no cierra y una sola escritura", async () => {
    montar();
    fireEvent.click(await screen.findByRole("button", { name: "Rechazar" }));
    const dialogo = await screen.findByRole("dialog", { name: "Rechazar propuesta" });
    let resolver!: (v: unknown) => void;
    reject.mockImplementationOnce(() => new Promise((r) => (resolver = r)));
    fireEvent.click(within(dialogo).getByRole("button", { name: "Confirmar rechazo" }));
    fireEvent.click(within(dialogo).getByRole("button", { name: /Confirmar rechazo|Enviando/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Rechazar propuesta" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Aprobar" })[0]).toBeDisabled();
    expect(reject).toHaveBeenCalledTimes(1);
    await act(async () => resolver({}));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
