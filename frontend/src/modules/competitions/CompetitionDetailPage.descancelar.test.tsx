/**
 * Botón «Descancelar»: `cancelada → borrador`, solo para administración.
 *
 * Ocultar el botón NO es la protección (la API vuelve a comprobar el rol); esto fija la interfaz: cuándo se
 * ofrece, qué confirmación pide, que cancelar el diálogo no hace nada y que un error de la API se muestra.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { CompetitionDetailPage } from "./CompetitionDetailPage";

let esAdmin = true;
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { username: "u" }, logout: vi.fn(), hasRole: (r: string) => (r === "admin" ? esAdmin : false) }),
}));
vi.mock("../../shared/AvisosTerceros", () => ({ AvisosTerceros: () => null }));

const get = vi.fn();
const uncancel = vi.fn();
const transition = vi.fn();
const reopenRegistrations = vi.fn();
const update = vi.fn();

vi.mock("./competitionsApi", () => ({
  useCompetitionsApi: () => ({
    get,
    uncancel,
    transition,
    reopenRegistrations,
    update,
    getCapacity: vi.fn().mockResolvedValue({ maxSwimmers: null, maxSwimmersPerClub: null, totalSwimmers: 0, remainingSwimmers: null, isFull: false, byClub: [] }),
    listSessionTypes: vi.fn().mockResolvedValue([]),
    listCompetitionEvents: vi.fn().mockResolvedValue([]),
    addDate: vi.fn(),
    removeDate: vi.fn(),
    addSession: vi.fn(),
    removeSession: vi.fn(),
    setSessionLimit: vi.fn(),
    addCompetitionEvent: vi.fn(),
    removeCompetitionEvent: vi.fn(),
    updateCompetitionEvent: vi.fn(),
    reorderCompetitionEvents: vi.fn(),
    remove: vi.fn(),
  }),
}));
vi.mock("../catalogs/catalogsApi", () => ({
  useCatalogsApi: () => ({
    listEvents: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listCategories: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listCategoryGroups: vi.fn().mockResolvedValue([]),
  }),
}));
vi.mock("../pools/poolsApi", () => ({ usePoolsApi: () => ({ list: vi.fn().mockResolvedValue([]) }) }));

function competencia(status: string) {
  return {
    id: "c-1", name: "Copa Cancelada", description: "", status,
    registrationStartAt: "2030-01-01T10:00:00.000Z", registrationEndAt: "2030-12-31T10:00:00.000Z", ageCutoffDate: "2030-12-31",
    maxIndividualEventsPerSwimmer: 5, maxRelayEventsPerSwimmerPerSession: 1, maxSwimmers: null, maxSwimmersPerClub: null,
    registrationsClosedReason: null, registrationsClosedAt: null, poolId: null, dates: [],
  };
}

function montar() {
  return render(
    <MemoryRouter initialEntries={["/competencias/c-1"]}>
      <Routes>
        <Route path="/competencias/:id" element={<CompetitionDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}
const boton = () => screen.queryByRole("button", { name: /^Descancelar$/ });

beforeEach(() => {
  esAdmin = true;
  get.mockReset().mockResolvedValue(competencia("cancelled"));
  uncancel.mockReset().mockResolvedValue(competencia("draft"));
  transition.mockReset();
  reopenRegistrations.mockReset();
  update.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("visibilidad del botón «Descancelar»", () => {
  it("administración y competencia cancelada: se ofrece", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Copa Cancelada")).toBeTruthy());
    expect(boton()).not.toBeNull();
  });

  for (const estado of ["draft", "scheduled", "open", "closed", "in_progress", "finished"]) {
    it(`no se ofrece con la competencia en «${estado}»`, async () => {
      get.mockResolvedValue(competencia(estado));
      montar();
      await waitFor(() => expect(screen.getByText("Copa Cancelada")).toBeTruthy());
      expect(boton()).toBeNull();
    });
  }

  it("no se ofrece a un perfil que no es de administración, aunque la competencia esté cancelada", async () => {
    esAdmin = false;
    montar();
    await waitFor(() => expect(screen.getByText("Copa Cancelada")).toBeTruthy());
    expect(boton()).toBeNull();
  });
});

describe("confirmación y resultado", () => {
  it("la confirmación dice que volverá a Borrador, conservará sus datos y no abrirá inscripciones", async () => {
    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(false);
    montar();
    await waitFor(() => expect(boton()).not.toBeNull());
    fireEvent.click(boton()!);
    const texto = String(confirmar.mock.calls[0]![0]);
    expect(texto).toMatch(/Borrador/);
    expect(texto).toMatch(/conservar[áa] todos sus datos/i);
    expect(texto).toMatch(/No abrir[áa] las inscripciones/i);
  });

  it("cancelar el diálogo no llama a la API ni cambia nada", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    montar();
    await waitFor(() => expect(boton()).not.toBeNull());
    fireEvent.click(boton()!);
    expect(uncancel).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("confirmar llama a la acción explícita una sola vez, recarga y muestra Borrador sin abrir ni programar", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    montar();
    await waitFor(() => expect(boton()).not.toBeNull());
    get.mockResolvedValue(competencia("draft"));
    fireEvent.click(boton()!);
    await waitFor(() => expect(uncancel).toHaveBeenCalledWith("c-1"));
    expect(uncancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("Borrador")).toBeTruthy());
    expect(boton()).toBeNull();
    // No pasa por la edición genérica ni por las otras transiciones, y no abre ni programa.
    expect(update).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(reopenRegistrations).not.toHaveBeenCalled();
  });

  it("un error de la API se muestra y la competencia sigue cancelada", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    uncancel.mockRejectedValue(new Error("Requiere uno de los siguientes roles: admin"));
    montar();
    await waitFor(() => expect(boton()).not.toBeNull());
    fireEvent.click(boton()!);
    await waitFor(() => expect(screen.getByText("Requiere uno de los siguientes roles: admin")).toBeTruthy());
    expect(screen.getByText("Cancelada")).toBeTruthy();
    expect(boton()).not.toBeNull();
  });

  it("un fallo sin mensaje usa el texto por omisión", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    uncancel.mockRejectedValue("falló");
    montar();
    await waitFor(() => expect(boton()).not.toBeNull());
    fireEvent.click(boton()!);
    await waitFor(() => expect(screen.getByText("No se pudo descancelar la competencia")).toBeTruthy());
  });
});
