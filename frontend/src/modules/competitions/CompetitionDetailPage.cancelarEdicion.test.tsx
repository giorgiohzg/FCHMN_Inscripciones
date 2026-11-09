/**
 * «Cancelar edición» vive junto a «Guardar cambios», dentro del formulario; fuera del modo edición solo está «Editar».
 * Pruebas simuladas (jsdom), no comprobación en navegador.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { CompetitionDetailPage } from "./CompetitionDetailPage";

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { username: "u" }, logout: vi.fn(), hasRole: () => true }),
}));
vi.mock("../../shared/AvisosTerceros", () => ({ AvisosTerceros: () => null }));

const get = vi.fn();
const update = vi.fn();
vi.mock("./competitionsApi", () => ({
  useCompetitionsApi: () => ({
    get,
    update,
    getCapacity: vi.fn().mockResolvedValue({ maxSwimmers: null, maxSwimmersPerClub: null, totalSwimmers: 0, remainingSwimmers: null, isFull: false, byClub: [] }),
    listSessionTypes: vi.fn().mockResolvedValue([]),
    listCompetitionEvents: vi.fn().mockResolvedValue([]),
    transition: vi.fn(),
    reopenRegistrations: vi.fn(),
    uncancel: vi.fn(),
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

const competencia = {
  id: "c-1", name: "Copa Edición", description: "", status: "draft",
  registrationStartAt: "2030-01-01T10:00:00.000Z", registrationEndAt: "2030-12-31T10:00:00.000Z", ageCutoffDate: "2030-12-31",
  maxIndividualEventsPerSwimmer: 5, maxRelayEventsPerSwimmerPerSession: 1, maxSwimmers: null, maxSwimmersPerClub: null,
  registrationsClosedReason: null, registrationsClosedAt: null, poolId: null, dates: [], visibleInRegistrationPanels: true,
};

function montar() {
  return render(
    <MemoryRouter initialEntries={["/competencias/c-1"]}>
      <Routes>
        <Route path="/competencias/:id" element={<CompetitionDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  get.mockReset().mockResolvedValue(competencia);
  update.mockReset().mockResolvedValue(competencia);
});

describe("«Cancelar edición»", () => {
  it("fuera de edición: solo «Editar», sin «Cancelar edición» ni «Guardar cambios»", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Copa Edición")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Editar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancelar edición" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar cambios" })).toBeNull();
  });

  it("en edición: un único «Cancelar edición», junto a «Guardar cambios», y «Editar» sale de la cabecera", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Copa Edición")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const guardar = await screen.findByRole("button", { name: "Guardar cambios" });
    expect(screen.getAllByRole("button", { name: "Cancelar edición" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    expect(within(guardar.parentElement as HTMLElement).getByRole("button", { name: "Cancelar edición" })).toBeTruthy();
  });

  it("cancelar no guarda ni llama a la API, cierra el formulario y devuelve «Editar»", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Copa Edición")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    await screen.findByRole("button", { name: "Guardar cambios" });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar edición" }));
    expect(update).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Guardar cambios" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancelar edición" })).toBeNull();
    expect(screen.getByRole("button", { name: "Editar" })).toBeTruthy();
  });

  it("guardar sigue llamando a la API y cierra la edición", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Copa Edición")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Guardar cambios" })).toBeNull());
    expect(screen.getByRole("button", { name: "Editar" })).toBeTruthy();
  });
});
