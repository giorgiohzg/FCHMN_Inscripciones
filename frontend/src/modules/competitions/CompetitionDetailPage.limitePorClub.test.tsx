/**
 * Etapa 4 — máximo de nadadores por club en una PRUEBA individual, en el tablero de
 * «Pruebas de la competencia».
 *
 * Lo que le toca a la pantalla: el campo existe SOLO en pruebas individuales, vacío significa
 * «Sin límite» (`null` al editar, omitido al agregar), con valor viaja un entero positivo, lo
 * inválido no sale hacia la API, y la tarjeta muestra el valor vigente. Que el servidor lo
 * aplique y audite la excepción lo prueban las pruebas de integración del backend.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { CompetitionDetailPage } from "./CompetitionDetailPage";
import { parseMaxSwimmersPerClub } from "./maxSwimmersPerClub";

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { username: "admin" }, logout: vi.fn(), hasRole: () => true }),
}));
vi.mock("../../shared/AvisosTerceros", () => ({ AvisosTerceros: () => null }));

const get = vi.fn();
const addCompetitionEvent = vi.fn();
const updateCompetitionEvent = vi.fn();
const listCompetitionEvents = vi.fn();

vi.mock("./competitionsApi", () => ({
  useCompetitionsApi: () => ({
    get,
    update: vi.fn(),
    reopenRegistrations: vi.fn(),
    getCapacity: vi.fn().mockResolvedValue(null),
    transition: vi.fn(),
    listSessionTypes: vi.fn().mockResolvedValue([]),
    listCompetitionEvents,
    addDate: vi.fn(),
    removeDate: vi.fn(),
    addSession: vi.fn(),
    removeSession: vi.fn(),
    setSessionLimit: vi.fn(),
    addCompetitionEvent,
    removeCompetitionEvent: vi.fn(),
    updateCompetitionEvent,
    reorderCompetitionEvents: vi.fn(),
    remove: vi.fn(),
  }),
}));

const individual = { id: "ev-ind", testTypeId: "tt-ind", distance: { meters: 50 }, stroke: { name: "Libre" }, gender: "mixed", testType: { id: "tt-ind", name: "Individual", swimmersCount: 1 } };
const relevo = { id: "ev-rel", testTypeId: "tt-rel", distance: { meters: 200 }, stroke: { name: "Libre" }, gender: "mixed", testType: { id: "tt-rel", name: "Relevo", swimmersCount: 4 } };
const nuevaIndividual = { id: "ev-nueva", testTypeId: "tt-ind", distance: { meters: 100 }, stroke: { name: "Espalda" }, gender: "mixed", testType: { id: "tt-ind", name: "Individual", swimmersCount: 1 } };
const nuevoRelevo = { id: "ev-nuevo-rel", testTypeId: "tt-rel", distance: { meters: 400 }, stroke: { name: "Combinado" }, gender: "mixed", testType: { id: "tt-rel", name: "Relevo", swimmersCount: 4 } };

const grupo = { id: "g1", name: "Máster" };
const categoriaInd = { id: "cat-ind", testTypeId: "tt-ind", categoryGroupId: "g1", name: "20-60", minAge: 20, maxAge: 60, testType: { id: "tt-ind", name: "Individual" }, categoryGroup: grupo };
const categoriaRel = { id: "cat-rel", testTypeId: "tt-rel", categoryGroupId: "g1", name: "Relevo", minAge: 0, maxAge: 500, testType: { id: "tt-rel", name: "Relevo" }, categoryGroup: grupo };

vi.mock("../catalogs/catalogsApi", () => ({
  useCatalogsApi: () => ({
    listEvents: vi.fn().mockResolvedValue({ items: [individual, relevo, nuevaIndividual, nuevoRelevo], total: 4 }),
    listCategories: vi.fn().mockResolvedValue({ items: [categoriaInd, categoriaRel], total: 2 }),
    listCategoryGroups: vi.fn().mockResolvedValue([grupo]),
  }),
}));
vi.mock("../pools/poolsApi", () => ({ usePoolsApi: () => ({ list: vi.fn().mockResolvedValue([]) }) }));

const sesion = { id: "s1", sessionTypeId: "st1", sessionType: { id: "st1", name: "Mañana" }, limit: null };
const competencia = {
  id: "c-1",
  name: "Copa Tablero",
  description: "",
  status: "open",
  registrationStartAt: "2030-01-01T10:00:00.000Z",
  registrationEndAt: "2030-12-31T10:00:00.000Z",
  ageCutoffDate: "2030-12-31",
  maxIndividualEventsPerSwimmer: 5,
  maxRelayEventsPerSwimmerPerSession: 1,
  maxSwimmers: null,
  maxSwimmersPerClub: null,
  registrationsClosedReason: null,
  registrationsClosedAt: null,
  visibleInRegistrationPanels: true,
  poolId: null,
  dates: [{ id: "d1", date: "2030-06-01T00:00:00.000Z", sessions: [sesion] }],
};

const ce = (id: string, ev: typeof individual, orden: number, maxSwimmersPerClub: number | null) => ({
  id,
  eventId: ev.id,
  competitionSessionId: "s1",
  status: "enabled",
  displayOrder: orden,
  maxSwimmersPerClub,
  event: ev,
  competitionSession: { id: "s1", sessionType: { name: "Mañana" }, competitionDate: { date: "2030-06-01T00:00:00.000Z" } },
  enabledCategories: [{ category: { id: ev.testTypeId === "tt-ind" ? "cat-ind" : "cat-rel", name: "x", categoryGroup: grupo } }],
});

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
  listCompetitionEvents.mockReset().mockResolvedValue([ce("ce-ind", individual, 1, 3), ce("ce-rel", relevo, 2, null)]);
  addCompetitionEvent.mockReset().mockResolvedValue({});
  updateCompetitionEvent.mockReset().mockResolvedValue({});
});

describe("la tarjeta de la prueba", () => {
  it("muestra el valor vigente en las pruebas individuales y nada en los relevos", async () => {
    listCompetitionEvents.mockResolvedValue([ce("ce-ind", individual, 1, 3), ce("ce-ind2", nuevaIndividual, 3, null), ce("ce-rel", relevo, 2, null)]);
    montar();
    await waitFor(() => expect(screen.getAllByText(/Máx\. por club:/).length).toBe(2));
    expect(screen.getByText("Máx. por club: 3")).toBeInTheDocument();
    expect(screen.getByText("Máx. por club: Sin límite")).toBeInTheDocument();
  });
});

describe("edición de una prueba ya asignada", () => {
  it("INDIVIDUAL: el campo trae el valor vigente y guardar envía el número", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Máx. por club: 3")).toBeInTheDocument());
    fireEvent.click(within(screen.getByText("Máx. por club: 3").closest("div[draggable]") as HTMLElement).getByRole("button", { name: "Editar" }));

    const campo = (await screen.findByLabelText("Máximo de nadadores por club")) as HTMLInputElement;
    expect(campo.value).toBe("3");
    expect(campo.placeholder).toBe("Sin límite");
    fireEvent.change(campo, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(updateCompetitionEvent).toHaveBeenCalledTimes(1));
    expect(updateCompetitionEvent.mock.calls[0]![0]).toBe("ce-ind");
    expect(updateCompetitionEvent.mock.calls[0]![1]).toMatchObject({ maxSwimmersPerClub: 5 });
  });

  it("vaciar el campo envía null: QUITA el límite", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Máx. por club: 3")).toBeInTheDocument());
    fireEvent.click(within(screen.getByText("Máx. por club: 3").closest("div[draggable]") as HTMLElement).getByRole("button", { name: "Editar" }));
    fireEvent.change(await screen.findByLabelText("Máximo de nadadores por club"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(updateCompetitionEvent).toHaveBeenCalledTimes(1));
    expect(updateCompetitionEvent.mock.calls[0]![1].maxSwimmersPerClub).toBeNull();
  });

  it("entrada inválida o incompleta: se conserva lo escrito, se avisa, Guardar se bloquea y la API NO se llama (ni con null)", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Máx. por club: 3")).toBeInTheDocument());
    fireEvent.click(within(screen.getByText("Máx. por club: 3").closest("div[draggable]") as HTMLElement).getByRole("button", { name: "Editar" }));
    const campo = (await screen.findByLabelText("Máximo de nadadores por club")) as HTMLInputElement;
    const guardar = screen.getByRole("button", { name: "Guardar" });

    for (const malo of ["abc", "1e", "-", "e", "0", "-2", "1.5", "2,5", "3x", " 4 5"]) {
      fireEvent.change(campo, { target: { value: malo } });
      expect(campo.value, "lo escrito se conserva, no se convierte en vacío").toBe(malo);
      expect(screen.getByRole("alert").textContent).toMatch(/número entero positivo/);
      expect(guardar).toBeDisabled();
      fireEvent.click(guardar);
    }
    expect(updateCompetitionEvent).not.toHaveBeenCalled();

    // Corregir la entrada vuelve a habilitar el guardado.
    fireEvent.change(campo, { target: { value: "4" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(guardar);
    await waitFor(() => expect(updateCompetitionEvent).toHaveBeenCalledTimes(1));
    expect(updateCompetitionEvent.mock.calls[0]![1].maxSwimmersPerClub).toBe(4);
  });

  it("RELEVO: no hay campo y la edición no envía el límite", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Máx. por club: 3")).toBeInTheDocument());
    const botonRelevo = screen.getAllByRole("button", { name: "Editar" }).find((b) => {
      const card = b.closest("div[draggable]");
      return card !== null && !card.textContent!.includes("Máx. por club");
    })!;
    fireEvent.click(botonRelevo);
    await screen.findByRole("button", { name: "Guardar" });
    expect(screen.queryByLabelText("Máximo de nadadores por club")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(updateCompetitionEvent).toHaveBeenCalledTimes(1));
    expect(updateCompetitionEvent.mock.calls[0]![1]).not.toHaveProperty("maxSwimmersPerClub");
  });
});

describe("alta por arrastre", () => {
  function arrastrarAFecha(etiquetaCatalogo: RegExp) {
    const datos = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => datos.set(k, v), getData: (k: string) => datos.get(k) ?? "", effectAllowed: "move", dropEffect: "move" };
    const item = screen.getAllByText(etiquetaCatalogo).map((x) => x.closest("div[draggable]")).find((x) => x && x.textContent?.includes("☰ "))!;
    fireEvent.dragStart(item, { dataTransfer });
    const encabezado = screen.getByRole("heading", { level: 3 });
    fireEvent.drop(encabezado, { dataTransfer });
  }

  it("INDIVIDUAL: el mini-formulario ofrece el campo; vacío → no se envía (sin límite)", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Máx. por club: 3")).toBeInTheDocument());
    arrastrarAFecha(/100m Espalda|Espalda/);

    const campo = (await screen.findByLabelText("Máximo de nadadores por club")) as HTMLInputElement;
    expect(campo.value).toBe("");
    fireEvent.click(screen.getByLabelText("Máster"));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(addCompetitionEvent).toHaveBeenCalledTimes(1));
    expect(addCompetitionEvent.mock.calls[0]![1]).not.toHaveProperty("maxSwimmersPerClub");
  });

  it("INDIVIDUAL con entrada inválida: Confirmar se bloquea, se avisa y la API no se llama", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Máx. por club: 3")).toBeInTheDocument());
    arrastrarAFecha(/100m Espalda|Espalda/);
    const campo = (await screen.findByLabelText("Máximo de nadadores por club")) as HTMLInputElement;
    fireEvent.click(screen.getByLabelText("Máster"));
    const confirmar = screen.getByRole("button", { name: "Confirmar" });
    expect(confirmar).toBeEnabled();

    for (const malo of ["abc", "1e", "-", "0", "-1", "1.5"]) {
      fireEvent.change(campo, { target: { value: malo } });
      expect(campo.value).toBe(malo);
      expect(screen.getByRole("alert").textContent).toMatch(/número entero positivo/);
      expect(confirmar).toBeDisabled();
      fireEvent.click(confirmar);
    }
    expect(addCompetitionEvent).not.toHaveBeenCalled();

    // Vaciar a propósito sí es «sin límite»: se habilita y no se envía el campo.
    fireEvent.change(campo, { target: { value: "" } });
    expect(confirmar).toBeEnabled();
    fireEvent.click(confirmar);
    await waitFor(() => expect(addCompetitionEvent).toHaveBeenCalledTimes(1));
    expect(addCompetitionEvent.mock.calls[0]![1]).not.toHaveProperty("maxSwimmersPerClub");
  });

  it("INDIVIDUAL con valor: viaja el entero", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Máx. por club: 3")).toBeInTheDocument());
    arrastrarAFecha(/100m Espalda|Espalda/);

    fireEvent.change(await screen.findByLabelText("Máximo de nadadores por club"), { target: { value: "2" } });
    fireEvent.click(screen.getByLabelText("Máster"));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(addCompetitionEvent).toHaveBeenCalledTimes(1));
    expect(addCompetitionEvent.mock.calls[0]![1]).toMatchObject({ eventId: "ev-nueva", maxSwimmersPerClub: 2 });
  });

  it("RELEVO: el mini-formulario no ofrece el campo", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Máx. por club: 3")).toBeInTheDocument());
    arrastrarAFecha(/Combinado/);
    await screen.findByRole("button", { name: "Confirmar" });
    expect(screen.queryByLabelText("Máximo de nadadores por club")).toBeNull();
  });
});

describe("parseMaxSwimmersPerClub", () => {
  it("vacío = sin límite; entero positivo = valor; el resto es inválido", () => {
    expect(parseMaxSwimmersPerClub("")).toBeNull();
    expect(parseMaxSwimmersPerClub("   ")).toBeNull();
    expect(parseMaxSwimmersPerClub("1")).toBe(1);
    expect(parseMaxSwimmersPerClub(" 12 ")).toBe(12);
    for (const malo of ["0", "-1", "1.5", "1e3", "abc", "2,5", "99999999999999999999"]) expect(parseMaxSwimmersPerClub(malo), malo).toBe("invalido");
  });
});
