/**
 * Cambio 6 — visibilidad de competencias en los desplegables de inscripción y relevos.
 *
 * Lo que le toca a la tabla y al formulario de ALTA de Administración:
 *   - la columna final «Mostrar en competencia», con ese título exacto y `Sí`/`No`;
 *   - la competencia oculta PERMANECE en la tabla (ocultar no la quita de aquí);
 *   - la casilla «Ocultar esta competencia del panel de inscripción y del panel de
 *     relevos» nace DESMARCADA, y lo que se envía es el sentido positivo guardado.
 *
 * El filtro de los dos paneles se prueba en `visibilidadEnConsumidores.test.tsx`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CompetitionsListPage } from "./CompetitionsListPage";

const competencia = (id: string, nombre: string, visible: boolean) => ({
  id,
  name: nombre,
  description: "",
  status: "open",
  registrationStartAt: "2026-01-01T00:00:00.000Z",
  registrationEndAt: "2026-02-01T00:00:00.000Z",
  ageCutoffDate: "2026-12-31",
  maxIndividualEventsPerSwimmer: null,
  maxRelayEventsPerSwimmerPerSession: 1,
  visibleInRegistrationPanels: visible,
  pool: null,
  dates: [],
});

const list = vi.fn();
const create = vi.fn();

vi.mock("./competitionsApi", () => ({
  useCompetitionsApi: () => ({ list, create, remove: vi.fn() }),
}));
vi.mock("../pools/poolsApi", () => ({ usePoolsApi: () => ({ list: vi.fn(async () => []) }) }));
vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u1", username: "admin", ownerType: "system", personId: null, clubId: null, roles: ["admin"] },
      accessToken: "t",
      permissions: [],
      mustChangePassword: false,
      hasRole: () => true,
      hasPermission: () => true,
      restaurando: false,
      restauracionFallida: false,
      login: vi.fn(),
      logout: vi.fn(),
      changePassword: vi.fn(),
      reintentarRestauracion: vi.fn(),
    }),
  };
});

const montar = () =>
  render(
    <MemoryRouter>
      <CompetitionsListPage />
    </MemoryRouter>
  );

beforeEach(() => {
  list.mockReset().mockResolvedValue({
    items: [competencia("c-1", "Copa Visible", true), competencia("c-2", "Copa Oculta", false)],
    total: 2,
    page: 1,
    pageSize: 20,
  });
  create.mockReset().mockResolvedValue({ id: "c-nueva" });
});

describe("la tabla de administración", () => {
  it("la ÚLTIMA columna se titula exactamente «Mostrar en competencia»", async () => {
    montar();
    await screen.findByText("Copa Visible");

    const encabezados = screen.getAllByRole("columnheader");
    expect(encabezados[encabezados.length - 1]!.textContent).toBe("Mostrar en competencia");
    expect(screen.getByRole("columnheader", { name: "Mostrar en competencia" })).toBeInTheDocument();
  });

  it("muestra Sí para la visible y No para la oculta, y la oculta PERMANECE en la tabla", async () => {
    montar();
    const filaVisible = (await screen.findByText("Copa Visible")).closest("tr")!;
    const filaOculta = screen.getByText("Copa Oculta").closest("tr")!;

    const celdas = (fila: HTMLElement) => within(fila).getAllByRole("cell");
    expect(celdas(filaVisible)[celdas(filaVisible).length - 1]!.textContent).toBe("Sí");
    expect(celdas(filaOculta)[celdas(filaOculta).length - 1]!.textContent).toBe("No");
  });

  it("el listado de administración NO envía el filtro: ve todas las competencias", async () => {
    montar();
    await screen.findByText("Copa Oculta");
    for (const llamada of list.mock.calls) expect(llamada[0]).not.toHaveProperty("visibleInRegistrationPanels");
  });

  it("la fila vacía ocupa las cinco columnas", async () => {
    list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    montar();
    const aviso = await screen.findByText("No hay competencias con este filtro.");
    expect(aviso.closest("td")!.getAttribute("colspan")).toBe("5");
  });
});

describe("el formulario de alta", () => {
  async function abrirAlta() {
    montar();
    await screen.findByText("Copa Visible");
    fireEvent.click(screen.getByRole("button", { name: "+ Nueva competencia" }));
    return screen.getByRole("checkbox", { name: "Ocultar esta competencia del panel de inscripción, del panel de relevos y de Reportes" });
  }
  const completar = () => {
    const [nombre] = screen.getAllByRole("textbox");
    fireEvent.change(nombre!, { target: { value: "Copa Nueva" } });
    for (const input of document.querySelectorAll('input[type="datetime-local"]')) fireEvent.change(input, { target: { value: "2026-05-01T10:00" } });
    fireEvent.change(document.querySelector('input[type="date"]')!, { target: { value: "2026-12-31" } });
    fireEvent.change(screen.getAllByRole("spinbutton")[0]!, { target: { value: "5" } });
  };

  it("la casilla «Ocultar…» nace DESMARCADA", async () => {
    expect(await abrirAlta()).not.toBeChecked();
  });

  it("sin tocar la casilla se envía visibleInRegistrationPanels: true", async () => {
    await abrirAlta();
    completar();
    fireEvent.click(screen.getByRole("button", { name: /Crear \(borrador\)/ }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ visibleInRegistrationPanels: true });
  });

  it("marcarla envía visibleInRegistrationPanels: false", async () => {
    const casilla = await abrirAlta();
    completar();
    fireEvent.click(casilla);
    expect(casilla).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /Crear \(borrador\)/ }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ visibleInRegistrationPanels: false });
  });

  it("aclara que ocultar NO es una medida de protección", async () => {
    await abrirAlta();
    expect(screen.getByText(/No es una medida de protección/i)).toBeInTheDocument();
  });
});

describe("Etapa 5 — condición de relevos en el formulario de alta", () => {
  const ETIQUETA = "Exigir al menos una inscripción individual confirmada antes de participar en relevos";
  const abrir = async () => {
    montar();
    await screen.findByText("Copa Visible");
    fireEvent.click(screen.getByRole("button", { name: "+ Nueva competencia" }));
    return screen.getByRole("checkbox", { name: ETIQUETA });
  };
  const completar = () => {
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "Copa Nueva" } });
    for (const input of document.querySelectorAll('input[type="datetime-local"]')) fireEvent.change(input, { target: { value: "2026-05-01T10:00" } });
    fireEvent.change(document.querySelector('input[type="date"]')!, { target: { value: "2026-12-31" } });
    fireEvent.change(screen.getAllByRole("spinbutton")[0]!, { target: { value: "5" } });
  };

  it("nace MARCADA y se envía true", async () => {
    const casilla = await abrir();
    expect(casilla).toBeChecked();
    completar();
    fireEvent.click(screen.getByRole("button", { name: /Crear \(borrador\)/ }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ requireIndividualForRelay: true });
  });

  it("desmarcada se envía false", async () => {
    const casilla = await abrir();
    fireEvent.click(casilla);
    completar();
    fireEvent.click(screen.getByRole("button", { name: /Crear \(borrador\)/ }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ requireIndividualForRelay: false });
  });
});
