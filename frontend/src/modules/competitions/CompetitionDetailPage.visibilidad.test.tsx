/**
 * Cambio 6 — la casilla de visibilidad en la EDICIÓN de la competencia:
 * marcar, guardar, volver a abrir y desmarcar.
 *
 * El «guardado» es el payload que sale hacia `update`; que el backend lo
 * persista y lo devuelva lo prueban las pruebas de integración. Aquí el
 * servidor de mentira devuelve lo que se le pida, así que el viaje de ida y
 * vuelta se simula en dos pasos (`get` cambia entre una apertura y la siguiente).
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

const ETIQUETA = "Ocultar esta competencia del panel de inscripción, del panel de relevos y de Reportes";

function competencia(visible: boolean | undefined) {
  return {
    id: "c-1",
    name: "Copa Visibilidad",
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
    ...(visible === undefined ? {} : { visibleInRegistrationPanels: visible }),
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
  await waitFor(() => expect(screen.getByText("Copa Visibilidad")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /^Editar$/i }));
  return screen.findByRole("checkbox", { name: ETIQUETA });
}

beforeEach(() => {
  get.mockReset().mockResolvedValue(competencia(true));
  update.mockReset().mockResolvedValue(competencia(true));
});

describe("edición de la visibilidad", () => {
  it("una competencia visible abre con la casilla DESMARCADA", async () => {
    montar();
    expect(await abrirEdicion()).not.toBeChecked();
  });

  it("guardar sin tocar la casilla reenvía visibleInRegistrationPanels: true", async () => {
    montar();
    await abrirEdicion();
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toMatchObject({ visibleInRegistrationPanels: true });
  });

  it("marcar y guardar envía false; al volver a abrir la casilla sigue marcada; desmarcar y guardar envía true", async () => {
    montar();
    const casilla = await abrirEdicion();
    fireEvent.click(casilla);
    expect(casilla).toBeChecked();
    // El servidor la guarda oculta: desde ese momento `get` la devuelve oculta (la pantalla recarga tras guardar).
    update.mockImplementationOnce(async () => {
      get.mockResolvedValue(competencia(false));
      return competencia(false);
    });
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toMatchObject({ visibleInRegistrationPanels: false });

    await waitFor(() => expect(screen.queryByRole("button", { name: /Guardar/i })).toBeNull());
    await waitFor(() => expect(screen.getByText(/oculta de esos selectores/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Editar$/i }));
    const reabierta = await screen.findByRole("checkbox", { name: ETIQUETA });
    expect(reabierta).toBeChecked();

    fireEvent.click(reabierta);
    expect(reabierta).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]![1]).toMatchObject({ visibleInRegistrationPanels: true });
  });

  it("el resumen de solo lectura dice Sí / No y, si está oculta, aclara que sigue accesible", async () => {
    montar();
    await waitFor(() => expect(screen.getByText("Copa Visibilidad")).toBeTruthy());
    expect(screen.getByText(/Visible en los selectores de Inscripción, Relevos y Reportes/i).textContent).toMatch(/Sí/);
    expect(screen.queryByText(/oculta de esos selectores/i)).toBeNull();
  });

  it("una competencia sin el campo (respuesta antigua) se trata como visible, no como oculta", async () => {
    get.mockResolvedValue(competencia(undefined));
    montar();
    expect(await abrirEdicion()).not.toBeChecked();
  });
});

/**
 * Guardar la casilla (u otro campo) NO debe mover las fechas de inscripción.
 *
 * El formulario carga cada fecha recortada a `AAAA-MM-DDTHH:mm` (sin zona horaria, sin
 * segundos ni milisegundos) y antes la reenviaba tal cual en cada guardado: el servidor
 * la reinterpretaba en su zona y el instante guardado cambiaba, aunque nadie hubiera
 * tocado la fecha. Ahora solo se envían las fechas modificadas.
 *
 * Los instantes elegidos caen junto al cambio de día (a ambos lados de la medianoche
 * chilena, con segundos y milisegundos que el recorte pierde), que es donde el
 * desplazamiento se nota como un día entero.
 */
describe("guardar sin tocar las fechas no las mueve", () => {
  const INICIO = "2030-03-10T02:58:24.031Z"; // 23:58 del 9 en Chile (UTC-3 en verano austral)
  const FIN = "2030-03-11T03:00:00.000Z"; // la medianoche chilena exacta

  /** Un «servidor» con memoria: aplica el payload como lo hace el backend (omitido = no se toca). */
  function servidorConMemoria() {
    const guardada = { ...competencia(true), registrationStartAt: INICIO, registrationEndAt: FIN };
    get.mockImplementation(async () => ({ ...guardada }));
    update.mockImplementation(async (_id: string, payload: Record<string, unknown>) => {
      if (payload.registrationStartAt !== undefined) guardada.registrationStartAt = new Date(payload.registrationStartAt as string).toISOString();
      if (payload.registrationEndAt !== undefined) guardada.registrationEndAt = new Date(payload.registrationEndAt as string).toISOString();
      if (payload.visibleInRegistrationPanels !== undefined) (guardada as Record<string, unknown>).visibleInRegistrationPanels = payload.visibleInRegistrationPanels;
      if (payload.name !== undefined) guardada.name = payload.name as string;
      return { ...guardada };
    });
    return guardada;
  }

  it("marcar, guardar, recargar y desmarcar conserva EXACTAMENTE ambos instantes", async () => {
    const guardada = servidorConMemoria();
    montar();
    const casilla = await abrirEdicion();

    fireEvent.click(casilla); // marcar
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const primero = update.mock.calls[0]![1] as Record<string, unknown>;
    expect(primero).toMatchObject({ visibleInRegistrationPanels: false });
    expect(primero.registrationStartAt).toBeUndefined();
    expect(primero.registrationEndAt).toBeUndefined();
    expect(guardada.registrationStartAt).toBe(INICIO);
    expect(guardada.registrationEndAt).toBe(FIN);

    // Recargar y reabrir: la casilla está marcada; se desmarca y se guarda otra vez.
    await waitFor(() => expect(screen.getByText(/oculta de esos selectores/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Editar$/i }));
    const reabierta = await screen.findByRole("checkbox", { name: ETIQUETA });
    expect(reabierta).toBeChecked();
    fireEvent.click(reabierta); // desmarcar
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    const segundo = update.mock.calls[1]![1] as Record<string, unknown>;
    expect(segundo).toMatchObject({ visibleInRegistrationPanels: true });
    expect(segundo.registrationStartAt).toBeUndefined();
    expect(segundo.registrationEndAt).toBeUndefined();

    // Los dos instantes, al milisegundo, igual que al principio.
    expect(guardada.registrationStartAt).toBe(INICIO);
    expect(guardada.registrationEndAt).toBe(FIN);
  });

  it("guardar otro campo (el nombre) sin tocar fechas las conserva", async () => {
    const guardada = servidorConMemoria();
    montar();
    await abrirEdicion();
    fireEvent.change(await screen.findByDisplayValue("Copa Visibilidad"), { target: { value: "Copa Renombrada" } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const payload = update.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.name).toBe("Copa Renombrada");
    expect(payload.registrationStartAt).toBeUndefined();
    expect(payload.registrationEndAt).toBeUndefined();
    expect(guardada.registrationStartAt).toBe(INICIO);
    expect(guardada.registrationEndAt).toBe(FIN);
  });

  it("EDITAR una fecha a propósito sigue funcionando: viaja solo la que se cambió, tal como se escribió", async () => {
    servidorConMemoria();
    montar();
    await abrirEdicion();
    const [inicio, fin] = Array.from(document.querySelectorAll('input[type="datetime-local"]')) as HTMLInputElement[];

    fireEvent.change(fin!, { target: { value: "2030-04-01T10:30" } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const solo = update.mock.calls[0]![1] as Record<string, unknown>;
    expect(solo.registrationEndAt).toBe("2030-04-01T10:30");
    expect(solo.registrationStartAt, "el inicio no se tocó").toBeUndefined();
    expect(inicio).toBeTruthy();
  });

  it("editar las dos fechas envía las dos", async () => {
    servidorConMemoria();
    montar();
    await abrirEdicion();
    const [inicio, fin] = Array.from(document.querySelectorAll('input[type="datetime-local"]')) as HTMLInputElement[];

    fireEvent.change(inicio!, { target: { value: "2030-03-05T08:00" } });
    fireEvent.change(fin!, { target: { value: "2030-04-01T10:30" } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toMatchObject({ registrationStartAt: "2030-03-05T08:00", registrationEndAt: "2030-04-01T10:30" });
  });

  it("escribir una fecha y volver al valor original equivale a no tocarla", async () => {
    servidorConMemoria();
    montar();
    await abrirEdicion();
    const [inicio] = Array.from(document.querySelectorAll('input[type="datetime-local"]')) as HTMLInputElement[];
    const original = inicio!.value;

    fireEvent.change(inicio!, { target: { value: "2030-03-05T08:00" } });
    fireEvent.change(inicio!, { target: { value: original } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect((update.mock.calls[0]![1] as Record<string, unknown>).registrationStartAt).toBeUndefined();
  });
});
