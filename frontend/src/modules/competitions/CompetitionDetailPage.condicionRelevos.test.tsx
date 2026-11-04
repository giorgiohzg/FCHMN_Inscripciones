/**
 * Etapa 5 — la casilla «Exigir al menos una inscripción individual confirmada antes de
 * participar en relevos»: valor inicial, edición, aviso de equipos incumplidores y resumen.
 *
 * El recuento (`relayTeamsNotMeetingCondition`) lo calcula el servidor; aquí se prueba qué hace
 * la pantalla con él: avisar al activar, no impedir el guardado y no inventar nada si es 0.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { CompetitionDetailPage } from "./CompetitionDetailPage";

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { username: "admin" }, logout: vi.fn(), hasRole: () => true }),
}));
vi.mock("../../shared/AvisosTerceros", () => ({ AvisosTerceros: () => null }));

const get = vi.fn();
const update = vi.fn();

vi.mock("./competitionsApi", () => ({
  useCompetitionsApi: () => ({
    get,
    update,
    reopenRegistrations: vi.fn(),
    getCapacity: vi.fn().mockResolvedValue(null),
    transition: vi.fn(),
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

const ETIQUETA = "Exigir al menos una inscripción individual confirmada antes de participar en relevos";

function competencia(exigir: boolean | undefined, incumplidores?: number) {
  return {
    id: "c-1",
    name: "Copa Condición",
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
    ...(exigir === undefined ? {} : { requireIndividualForRelay: exigir }),
    ...(incumplidores === undefined ? {} : { relayTeamsNotMeetingCondition: incumplidores }),
    poolId: null,
    dates: [],
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

async function abrirEdicion() {
  await waitFor(() => expect(screen.getByText("Copa Condición")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /^Editar$/i }));
  return screen.findByRole("checkbox", { name: ETIQUETA });
}

beforeEach(() => {
  get.mockReset().mockResolvedValue(competencia(true, 0));
  update.mockReset().mockResolvedValue(competencia(true, 0));
});

describe("valor inicial y resumen", () => {
  it("activada: la casilla abre MARCADA y el resumen dice Sí, sin avisos si no hay equipos incumplidores", async () => {
    montar();
    await waitFor(() => expect(screen.getByText(/Exigir una inscripción individual confirmada antes de participar en relevos:/)).toBeInTheDocument());
    expect(screen.queryByRole("status"), "sin equipos incumplidores no hay aviso").toBeNull();
    expect(await abrirEdicion()).toBeChecked();
  });

  it("una respuesta antigua sin el campo se trata como ACTIVADA (el valor por defecto)", async () => {
    get.mockResolvedValue(competencia(undefined));
    montar();
    expect(await abrirEdicion()).toBeChecked();
  });

  it("desactivada: la casilla abre desmarcada y el resumen lo explica", async () => {
    get.mockResolvedValue(competencia(false, 0));
    montar();
    await waitFor(() => expect(screen.getByText(/Exigir una inscripción individual confirmada antes de participar en relevos:/)).toBeInTheDocument());
    expect(screen.getByText(/los relevos se forman y se modifican sin ese requisito/)).toBeInTheDocument();
    expect(await abrirEdicion()).not.toBeChecked();
  });

  it("la ayuda explica el SEGUNDO lado: no se podrá cancelar la última individual", async () => {
    montar();
    await abrirEdicion();
    expect(screen.getByText(/no se podrá cancelar la última inscripción individual/)).toBeInTheDocument();
  });
});

describe("guardar", () => {
  it("desmarcar y guardar envía requireIndividualForRelay: false; sin tocarla, reenvía true", async () => {
    montar();
    const casilla = await abrirEdicion();
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toMatchObject({ requireIndividualForRelay: true });

    fireEvent.click(await screen.findByRole("button", { name: /^Editar$/i }));
    const otra = await screen.findByRole("checkbox", { name: ETIQUETA });
    expect(casilla).toBeTruthy();
    fireEvent.click(otra);
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]![1]).toMatchObject({ requireIndividualForRelay: false });
  });
});

describe("activarla sobre equipos que incumplen", () => {
  it("al MARCAR la casilla avisa cuántos equipos quedarían afectados y NO impide guardar", async () => {
    get.mockResolvedValue(competencia(false, 3));
    montar();
    const casilla = await abrirEdicion();
    expect(screen.queryByRole("alert")).toBeNull(); // todavía desmarcada: nada que avisar

    fireEvent.click(casilla);
    const aviso = screen.getByRole("alert");
    expect(aviso.textContent).toMatch(/3.*equipo\(s\) de relevo confirmado\(s\).*sin inscripción individual confirmada/);
    expect(aviso.textContent).toMatch(/no se modifica, cancela ni retira a nadie/);
    expect(screen.getByRole("button", { name: /Guardar/i })).toBeEnabled();

    // Y al volver a desmarcar, el aviso desaparece.
    fireEvent.click(casilla);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("con recuento 0 no hay aviso al marcar", async () => {
    get.mockResolvedValue(competencia(false, 0));
    montar();
    fireEvent.click(await abrirEdicion());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("al GUARDAR la activación, el recuento del servidor queda a la vista en el resumen; las inscripciones no se tocan", async () => {
    get.mockResolvedValue(competencia(false, 2));
    // El servidor guarda y, al recargar, devuelve la condición activada y el recuento recalculado (puede haber cambiado: 4).
    update.mockImplementation(async () => {
      get.mockResolvedValue(competencia(true, 4));
      return competencia(true, 4);
    });
    montar();
    fireEvent.click(await abrirEdicion());
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toMatchObject({ requireIndividualForRelay: true });
    const aviso = await screen.findByRole("status");
    expect(aviso.textContent).toMatch(/Condición activada\./);
    expect(aviso.textContent).toMatch(/4.*equipo\(s\) de relevo confirmado\(s\)/);
    expect(aviso.textContent).toMatch(/No se modificaron ni se cancelaron/);
  });

  it("con la condición YA activada, el detalle sigue mostrando los equipos incumplidores heredados", async () => {
    get.mockResolvedValue(competencia(true, 1));
    montar();
    const aviso = await screen.findByRole("status");
    expect(aviso.textContent).toMatch(/1.*equipo\(s\)/);
    expect(aviso.textContent).not.toMatch(/Condición activada\./);
  });
});
