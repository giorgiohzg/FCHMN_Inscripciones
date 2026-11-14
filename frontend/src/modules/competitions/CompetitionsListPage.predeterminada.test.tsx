/**
 * Columna «Por defecto» de Competencias (solo administración usa esta pantalla; la API exige el
 * rol `admin`). Se fija: marcar y quitar llaman a su endpoint y recargan la lista (la anterior
 * puede estar en otra página), una sola escritura a la vez, el aviso cuando otra persona la
 * cambió entretanto y el error del servidor. API simulada; datos sintéticos.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CompetitionsListPage } from "./CompetitionsListPage";

const competencia = (id: string, nombre: string, predeterminada: boolean) => ({
  id,
  name: nombre,
  description: "",
  status: "open",
  registrationStartAt: "2026-01-01T00:00:00.000Z",
  registrationEndAt: "2026-02-01T00:00:00.000Z",
  ageCutoffDate: "2026-12-31",
  maxIndividualEventsPerSwimmer: null,
  maxRelayEventsPerSwimmerPerSession: 1,
  visibleInRegistrationPanels: true,
  esPredeterminada: predeterminada,
  pool: null,
  dates: [],
});

let marcada = "c-1";
const list = vi.fn(async () => ({
  items: [competencia("c-1", "Copa Uno", marcada === "c-1"), competencia("c-2", "Copa Dos", marcada === "c-2")],
  total: 2,
  page: 1,
  pageSize: 20,
}));
const marcarPredeterminada = vi.fn();
const quitarPredeterminada = vi.fn();

vi.mock("./competitionsApi", () => ({
  useCompetitionsApi: () => ({ list, create: vi.fn(), remove: vi.fn(), marcarPredeterminada, quitarPredeterminada }),
}));
vi.mock("../pools/poolsApi", () => ({ usePoolsApi: () => ({ list: vi.fn(async () => []) }) }));
vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const montar = () =>
  render(
    <MemoryRouter>
      <CompetitionsListPage />
    </MemoryRouter>
  );

beforeEach(() => {
  marcada = "c-1";
  list.mockClear();
  marcarPredeterminada.mockReset().mockImplementation(async (id: string) => {
    marcada = id;
    return { competenciaPredeterminadaId: id, cambio: true };
  });
  quitarPredeterminada.mockReset().mockImplementation(async (id: string) => {
    const cambio = marcada === id;
    if (cambio) marcada = "";
    return { competenciaPredeterminadaId: cambio ? null : marcada || null, cambio };
  });
});

describe("columna «Por defecto»", () => {
  it("muestra la predeterminada y permite marcar otra: llama al endpoint y recarga", async () => {
    montar();
    expect(await screen.findByText("Predeterminada")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Marcar «Copa Dos» como competencia por defecto" }));
    await waitFor(() => expect(marcarPredeterminada).toHaveBeenCalledWith("c-2"));
    await screen.findByRole("button", { name: "Quitar «Copa Dos» como competencia por defecto" });
    expect(screen.getByRole("button", { name: "Marcar «Copa Uno» como competencia por defecto" })).toBeInTheDocument();
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("una sola escritura a la vez: el doble clic y los demás botones no envían otra", async () => {
    let soltar!: (v: unknown) => void;
    marcarPredeterminada.mockImplementation(() => new Promise((r) => (soltar = r)));
    montar();
    const boton = await screen.findByRole("button", { name: "Marcar «Copa Dos» como competencia por defecto" });
    fireEvent.click(boton);
    fireEvent.click(boton);
    fireEvent.click(screen.getByRole("button", { name: "Quitar «Copa Uno» como competencia por defecto" }));
    expect(marcarPredeterminada).toHaveBeenCalledTimes(1);
    expect(quitarPredeterminada).not.toHaveBeenCalled();
    await waitFor(() => expect(boton).toBeDisabled());
    soltar({ competenciaPredeterminadaId: "c-2", cambio: true });
    marcada = "c-2";
    await screen.findByRole("button", { name: "Quitar «Copa Dos» como competencia por defecto" });
  });

  it("si al quitar ya no era la predeterminada (otra persona la cambió), lo avisa tras recargar", async () => {
    quitarPredeterminada.mockImplementation(async () => {
      marcada = "c-2";
      return { competenciaPredeterminadaId: "c-2", cambio: false };
    });
    montar();
    fireEvent.click(await screen.findByRole("button", { name: "Quitar «Copa Uno» como competencia por defecto" }));
    expect(await screen.findByText(/otra persona la cambió/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quitar «Copa Dos» como competencia por defecto" })).toBeInTheDocument();
  });

  it("un error del servidor se muestra y la lista se recarga", async () => {
    marcarPredeterminada.mockRejectedValue(new Error("Requiere uno de los siguientes roles: admin"));
    montar();
    fireEvent.click(await screen.findByRole("button", { name: "Marcar «Copa Dos» como competencia por defecto" }));
    expect(await screen.findByText(/Requiere uno de los siguientes roles: admin/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quitar «Copa Uno» como competencia por defecto" })).toBeInTheDocument();
  });
});
