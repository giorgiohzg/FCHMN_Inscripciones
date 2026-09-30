/**
 * El formulario de edición y la reapertura de inscripciones.
 *
 * POR QUÉ EXISTE ESTA PRUEBA.
 *
 * El backend llegó a intentar deducir la intención del administrador a partir
 * de la solicitud: "si trae fechas, es que quiere reabrir". Esa deducción era
 * falsa por culpa de este formulario, que envía TODOS los campos en cada
 * guardado —incluidas las dos fechas y los dos cupos— se hayan tocado o no.
 * Con esa señal, renombrar una competencia cerrada a mano la reabría.
 *
 * Aquí se fija el hecho que lo provocaba —el payload completo— y el contrato
 * que lo resuelve: guardar llama a `update` y nunca a `reopenRegistrations`;
 * reabrir es un botón aparte que solo aparece con la competencia cerrada.
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
const reopenRegistrations = vi.fn();
const getCapacity = vi.fn();
const transition = vi.fn();

vi.mock("./competitionsApi", () => ({
  useCompetitionsApi: () => ({
    get,
    update,
    reopenRegistrations,
    getCapacity,
    transition,
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
    // `listEvents` y `listCategories` devuelven `{ items }`, no un arreglo:
    // la página lee `ev.items`. Devolver `[]` dejaba el estado en undefined y
    // la página no llegaba a pintarse.
    listEvents: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listCategories: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listCategoryGroups: vi.fn().mockResolvedValue([]),
  }),
}));
vi.mock("../pools/poolsApi", () => ({ usePoolsApi: () => ({ list: vi.fn().mockResolvedValue([]) }) }));

function competencia(over: Record<string, unknown> = {}) {
  return {
    id: "c-1",
    name: "Copa Cerrada",
    description: "",
    status: "closed",
    registrationStartAt: "2030-01-01T10:00:00.000Z",
    registrationEndAt: "2030-12-31T10:00:00.000Z",
    ageCutoffDate: "2030-12-31",
    maxIndividualEventsPerSwimmer: 5,
    maxRelayEventsPerSwimmerPerSession: 1,
    maxSwimmers: 10,
    maxSwimmersPerClub: null,
    registrationsClosedReason: "manual",
    registrationsClosedAt: "2030-06-01T00:00:00.000Z",
    poolId: null,
    dates: [],
    ...over,
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

beforeEach(() => {
  get.mockReset().mockResolvedValue(competencia());
  update.mockReset().mockResolvedValue(competencia());
  reopenRegistrations.mockReset().mockResolvedValue(competencia({ status: "open" }));
  getCapacity.mockReset().mockResolvedValue({
    maxSwimmers: 10,
    maxSwimmersPerClub: null,
    totalSwimmers: 10,
    remainingSwimmers: 0,
    isFull: true,
    byClub: [],
  });
  transition.mockReset();
});

describe("el payload de guardado — el hecho que rompía la deducción del backend", () => {
  it("guardar envía SIEMPRE las dos fechas, aunque solo se cambie el nombre", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Copa Cerrada")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^Editar$/i }));
    const nombre = await screen.findByDisplayValue("Copa Cerrada");
    fireEvent.change(nombre, { target: { value: "Copa Renombrada" } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const payload = update.mock.calls[0]![1] as Record<string, unknown>;

    expect(payload.name).toBe("Copa Renombrada");
    // Esto es lo que hacía inútil la señal "trae fechas".
    expect(payload.registrationStartAt, "el formulario reenvía el inicio sin tocarlo").toBeTruthy();
    expect(payload.registrationEndAt, "y también el fin").toBeTruthy();
    // Y lo mismo con el cupo: viaja aunque no se haya modificado.
    expect(payload).toHaveProperty("maxSwimmers");
  });

  it("guardar NO llama a reabrir: son actos distintos", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Copa Cerrada")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^Editar$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Guardar/i }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(reopenRegistrations).not.toHaveBeenCalled();
  });
});

describe("la acción explícita de reapertura", () => {
  it("el botón aparece con la competencia cerrada y llama al endpoint propio", async () => {
    montar();
    const boton = await screen.findByRole("button", { name: /Reabrir inscripciones/i });

    fireEvent.click(boton);

    await waitFor(() => expect(reopenRegistrations).toHaveBeenCalledWith("c-1"));
    expect(update, "reabrir no guarda la competencia").not.toHaveBeenCalled();
  });

  it("NO aparece si las inscripciones están abiertas", async () => {
    get.mockResolvedValue(competencia({ status: "open", registrationsClosedReason: null, registrationsClosedAt: null }));
    montar();
    await waitFor(() => expect(screen.getByText("Copa Cerrada")).toBeTruthy());

    expect(screen.queryByRole("button", { name: /Reabrir inscripciones/i })).toBeNull();
  });

  it("muestra el motivo del cierre y avisa de que guardar no reabre", async () => {
    montar();
    // "Inscripciones cerradas" aparece también en el aviso de cupo completo,
    // así que se ancla en el fragmento que solo pertenece a este mensaje.
    await waitFor(() => expect(screen.getByText(/por decisión de un administrador/i)).toBeTruthy());

    expect(screen.getByText(/Editar y guardar no las reabre/i)).toBeTruthy();
    expect(screen.getAllByText(/Inscripciones cerradas/i).length).toBeGreaterThan(0);
  });

  it("con cierre por cupo, el motivo es el cupo", async () => {
    get.mockResolvedValue(competencia({ registrationsClosedReason: "capacity" }));
    montar();
    await waitFor(() => expect(screen.getByText(/se alcanzó el cupo de nadadores/i)).toBeTruthy());
  });

  it("si el backend rechaza la reapertura, el motivo se muestra", async () => {
    reopenRegistrations.mockRejectedValue(new Error("Amplíe el cupo —o quítelo— antes de reabrir"));
    montar();

    fireEvent.click(await screen.findByRole("button", { name: /Reabrir inscripciones/i }));

    await waitFor(() => expect(screen.getByText(/Amplíe el cupo/i)).toBeTruthy());
  });
});
