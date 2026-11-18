/**
 * ELIMINACIÓN COMPLETA DE COMPETENCIAS (interfaz): la misma advertencia en el listado y en la
 * competencia seleccionada, el resumen con los recuentos REALES que devuelve el servidor, ningún
 * anuncio de éxito si falla, y ante una respuesta INCIERTA (red, 5xx, cuerpo ilegible) una
 * comprobación por lectura sin repetir el DELETE. No existe eliminación de varias a la vez.
 *
 * Pruebas SIMULADAS (jsdom, API espiada). Lo que de verdad se elimina y se conserva está en
 * `backend/tests/competition-deletion.integration.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { CompetitionsListPage } from "./CompetitionsListPage";
import { CompetitionDetailPage } from "./CompetitionDetailPage";
import { advertenciaDeEliminacion, esResultadoDeEliminacion, resumenDeEliminacion, type ResultadoDeEliminacion } from "./eliminacionDeCompetencia";
import { ApiError } from "../../shared/apiClient";

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { username: "admin", roles: ["admin"] }, logout: vi.fn(), hasRole: () => true, hasPermission: () => true }),
}));
vi.mock("../../shared/AvisosTerceros", () => ({ AvisosTerceros: () => null }));

const competencia = {
  id: "c-1", name: "Copa Sintética", description: "", status: "draft",
  registrationStartAt: "2030-01-01T10:00:00.000Z", registrationEndAt: "2030-12-31T10:00:00.000Z", ageCutoffDate: "2030-12-31",
  maxIndividualEventsPerSwimmer: 5, maxRelayEventsPerSwimmerPerSession: 1, maxSwimmers: null, maxSwimmersPerClub: null,
  registrationsClosedReason: null, registrationsClosedAt: null, poolId: null, pool: null, dates: [], visibleInRegistrationPanels: true,
  esPredeterminada: false,
};

const list = vi.fn();
const get = vi.fn();
const remove = vi.fn();
vi.mock("./competitionsApi", () => ({
  useCompetitionsApi: () => ({
    list,
    get,
    remove,
    create: vi.fn(),
    update: vi.fn(),
    getCapacity: vi.fn().mockResolvedValue({ maxSwimmers: null, maxSwimmersPerClub: null, totalSwimmers: 0, remainingSwimmers: null, isFull: false, byClub: [] }),
    listSessionTypes: vi.fn().mockResolvedValue([]),
    listCompetitionEvents: vi.fn().mockResolvedValue([]),
    marcarPredeterminada: vi.fn(),
    quitarPredeterminada: vi.fn(),
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

const resultado: ResultadoDeEliminacion = {
  competitionId: "c-1",
  nombre: "Copa Sintética",
  eraPredeterminada: true,
  eliminados: {
    inscripcionesIndividuales: 5,
    inscripcionesIndividualesConfirmadas: 3,
    inscripcionesIndividualesCanceladas: 2,
    equiposDeRelevo: 2,
    equiposDeRelevoConfirmados: 1,
    equiposDeRelevoCancelados: 1,
    integrantesDeRelevo: 8,
    pruebasAsignadas: 4,
    categoriasHabilitadas: 6,
    limitesDeJornada: 1,
    jornadas: 2,
    fechas: 1,
  },
};

let confirmar: ReturnType<typeof vi.spyOn>;
let alerta: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ items: [competencia], total: 1, page: 1, pageSize: 20 });
  get.mockResolvedValue(competencia);
  confirmar = vi.spyOn(window, "confirm").mockReturnValue(true);
  alerta = vi.spyOn(window, "alert").mockImplementation(() => undefined);
});
afterEach(() => {
  confirmar.mockRestore();
  alerta.mockRestore();
});

function Sonda() {
  const location = useLocation();
  return <p data-testid="sonda">{(location.state as { eliminacion?: string } | null)?.eliminacion ?? "SIN ESTADO"}</p>;
}

describe("advertencia común", () => {
  it("advierte que también se eliminan inscripciones (incluso canceladas) y relevos, y qué se conserva", () => {
    const t = advertenciaDeEliminacion("Copa Sintética");
    expect(t).toContain("«Copa Sintética»");
    expect(t).toContain("NO se puede deshacer");
    expect(t).toMatch(/TODAS sus inscripciones individuales, confirmadas o canceladas/);
    expect(t).toMatch(/TODOS sus equipos de relevo, confirmados o cancelados, con sus integrantes/);
    expect(t).toMatch(/pruebas asignadas, jornadas, fechas y límites/);
    expect(t).toMatch(/Se conservan las pruebas de Catálogos/);
  });

  it("el resumen informa los recuentos devueltos y la predeterminada", () => {
    const r = resumenDeEliminacion(resultado);
    expect(r).toContain("5 inscripciones individuales (3 confirmadas, 2 canceladas)");
    expect(r).toContain("2 equipos de relevo (1 confirmado, 1 cancelado) con 8 integrantes");
    expect(r).toContain("4 pruebas asignadas, 2 jornadas y 1 fecha");
    expect(r).toContain("Era la competencia por defecto");
  });
});

describe("respuesta válida del servidor", () => {
  it("solo acepta los recuentos de ESTA competencia, completos y no negativos", () => {
    expect(esResultadoDeEliminacion(resultado, "c-1")).toBe(true);
    expect(esResultadoDeEliminacion(resultado, "otra")).toBe(false);
    expect(esResultadoDeEliminacion({ ...resultado, eliminados: { ...resultado.eliminados, fechas: -1 } }, "c-1")).toBe(false);
    const { fechas: _omitida, ...incompletos } = resultado.eliminados;
    expect(esResultadoDeEliminacion({ ...resultado, eliminados: incompletos }, "c-1")).toBe(false);
    expect(esResultadoDeEliminacion(undefined, "c-1")).toBe(false);
  });
});

describe("listado", () => {
  const montar = () =>
    render(
      <MemoryRouter>
        <CompetitionsListPage />
      </MemoryRouter>
    );
  const eliminar = async () => fireEvent.click(await screen.findByRole("button", { name: "Eliminar" }));

  it("confirma con la advertencia común y muestra los recuentos reales", async () => {
    remove.mockResolvedValue(resultado);
    montar();
    await eliminar();
    expect(confirmar).toHaveBeenCalledWith(advertenciaDeEliminacion("Copa Sintética"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("c-1"));
    expect(await screen.findByRole("status")).toHaveTextContent("Se eliminó «Copa Sintética»: 5 inscripciones individuales");
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("si se cancela la confirmación no llama a la API", async () => {
    confirmar.mockReturnValue(false);
    montar();
    await eliminar();
    expect(remove).not.toHaveBeenCalled();
  });

  it("un rechazo conocido del servidor dice que NO se eliminó, sin comprobar ni anunciar éxito", async () => {
    remove.mockRejectedValue(new ApiError("Conflicto sintético", 409));
    montar();
    await eliminar();
    expect(await screen.findByRole("alert")).toHaveTextContent("No se eliminó «Copa Sintética»: Conflicto sintético");
    expect(get).not.toHaveBeenCalled();
    expect(screen.queryByText(/Se eliminó/)).toBeNull();
  });

  it("el servidor eliminó pero se perdió la respuesta: comprueba, dice que ya no existe y no inventa recuentos", async () => {
    let borrada = false;
    remove.mockImplementation(async () => {
      borrada = true;
      throw new TypeError("Failed to fetch");
    });
    get.mockImplementation(async () => {
      if (borrada) throw new ApiError("Competencia no encontrada", 404);
      return competencia;
    });
    montar();
    await eliminar();
    const aviso = await screen.findByRole("alert");
    expect(aviso).toHaveTextContent("No se pudo confirmar la respuesta del servidor");
    expect(aviso).toHaveTextContent("la competencia «Copa Sintética» ya no existe");
    expect(aviso).not.toHaveTextContent(/inscripciones|Se eliminó|No se eliminó/);
    expect(get).toHaveBeenCalledWith("c-1");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("si tras la incertidumbre la competencia sigue existiendo, lo dice sin afirmar que se eliminó", async () => {
    remove.mockRejectedValue(new TypeError("Failed to fetch"));
    get.mockResolvedValue(competencia);
    montar();
    await eliminar();
    const aviso = await screen.findByRole("alert");
    expect(aviso).toHaveTextContent("No se pudo confirmar la respuesta del servidor");
    expect(aviso).toHaveTextContent("la competencia «Copa Sintética» todavía existe");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("si la comprobación también falla, conserva la incertidumbre y ofrece comprobar después, sin repetir el DELETE", async () => {
    remove.mockRejectedValue(new TypeError("Failed to fetch"));
    get.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockRejectedValueOnce(new ApiError("Competencia no encontrada", 404));
    montar();
    await eliminar();
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo confirmar si «Copa Sintética» se eliminó ni comprobar su estado");
    fireEvent.click(screen.getByRole("button", { name: "Comprobar de nuevo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("la competencia «Copa Sintética» ya no existe");
    expect(screen.queryByRole("button", { name: "Comprobar de nuevo" })).toBeNull();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["un error 502 del proxy", () => Promise.reject(new ApiError("Error 502", 502))],
    ["una respuesta 2xx con otra forma", () => Promise.resolve({ ok: true })],
    ["una respuesta 2xx ilegible", () => Promise.reject(new SyntaxError("Unexpected token"))],
  ])("%s es incierto: comprueba en vez de afirmar un resultado", async (_caso, respuesta) => {
    remove.mockImplementation(respuesta);
    get.mockRejectedValue(new ApiError("Competencia no encontrada", 404));
    montar();
    await eliminar();
    const aviso = await screen.findByRole("alert");
    expect(aviso).toHaveTextContent("No se pudo confirmar la respuesta del servidor");
    expect(aviso).toHaveTextContent("ya no existe");
    expect(screen.queryByText(/Se eliminó «/)).toBeNull();
  });

  it("un 404 directo dice que ya no existe, sin recuentos ni atribuírselo", async () => {
    remove.mockRejectedValue(new ApiError("Competencia no encontrada", 404));
    montar();
    await eliminar();
    const aviso = await screen.findByRole("alert");
    expect(aviso).toHaveTextContent("La competencia «Copa Sintética» ya no existe");
    expect(aviso).not.toHaveTextContent(/No se pudo confirmar|inscripciones/);
  });

  it("mientras se elimina, el botón queda deshabilitado y un segundo clic no envía otra solicitud", async () => {
    let terminar!: (v: ResultadoDeEliminacion) => void;
    remove.mockImplementation(() => new Promise((r) => (terminar = r)));
    montar();
    const boton = await screen.findByRole("button", { name: "Eliminar" });
    fireEvent.click(boton);
    await waitFor(() => expect(boton).toBeDisabled());
    fireEvent.click(boton);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(confirmar).toHaveBeenCalledTimes(1);
    terminar(resultado);
    expect(await screen.findByRole("status")).toHaveTextContent("Se eliminó «Copa Sintética»");
  });

  it("muestra el resultado que llega desde la competencia seleccionada", async () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: "/competencias", state: { eliminacion: "Se eliminó «X»: resumen sintético." } }]}>
        <CompetitionsListPage />
      </MemoryRouter>
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Se eliminó «X»: resumen sintético.");
  });
});

describe("competencia seleccionada", () => {
  const montar = () =>
    render(
      <MemoryRouter initialEntries={["/competencias/c-1"]}>
        <Routes>
          <Route path="/competencias/:id" element={<CompetitionDetailPage />} />
          <Route path="/competencias" element={<Sonda />} />
        </Routes>
      </MemoryRouter>
    );
  const eliminar = async () => {
    await waitFor(() => expect(screen.getByText("Copa Sintética")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
  };

  it("usa la misma advertencia y entrega el resumen real al volver al listado", async () => {
    remove.mockResolvedValue(resultado);
    montar();
    await eliminar();
    expect(confirmar).toHaveBeenCalledWith(advertenciaDeEliminacion("Copa Sintética"));
    expect(await screen.findByTestId("sonda")).toHaveTextContent(resumenDeEliminacion(resultado));
  });

  it("un rechazo conocido se queda en la competencia y dice que NO se eliminó", async () => {
    remove.mockRejectedValue(new ApiError("Conflicto sintético", 409));
    montar();
    await eliminar();
    expect(await screen.findByText("No se eliminó «Copa Sintética»: Conflicto sintético")).toBeInTheDocument();
    expect(screen.queryByTestId("sonda")).toBeNull();
  });

  it("el servidor eliminó pero se perdió la respuesta: vuelve al listado diciendo que ya no existe, sin recuentos", async () => {
    let borrada = false;
    get.mockImplementation(async () => {
      if (borrada) throw new ApiError("Competencia no encontrada", 404);
      return competencia;
    });
    remove.mockImplementation(async () => {
      borrada = true;
      throw new TypeError("Failed to fetch");
    });
    montar();
    await eliminar();
    const sonda = await screen.findByTestId("sonda");
    expect(sonda).toHaveTextContent("No se pudo confirmar la respuesta del servidor");
    expect(sonda).toHaveTextContent("ya no existe");
    expect(sonda).not.toHaveTextContent(/inscripciones|Se eliminó/);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("si no puede comprobarse, se queda con la incertidumbre y permite comprobar después", async () => {
    let lecturas = 0;
    get.mockImplementation(async () => {
      lecturas++;
      if (lecturas === 1) return competencia; // la carga de la pantalla
      if (lecturas === 2) throw new TypeError("Failed to fetch"); // la comprobación
      return competencia; // la comprobación posterior: sigue existiendo
    });
    remove.mockRejectedValue(new TypeError("Failed to fetch"));
    montar();
    await eliminar();
    expect(await screen.findByText(/No se pudo confirmar si «Copa Sintética» se eliminó ni comprobar su estado/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Comprobar de nuevo" }));
    expect(await screen.findByText(/la competencia «Copa Sintética» todavía existe/)).toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("sonda")).toBeNull();
  });

  it("mientras se elimina, un segundo clic no envía otra solicitud", async () => {
    remove.mockImplementation(() => new Promise(() => undefined));
    montar();
    await eliminar();
    const boton = screen.getByRole("button", { name: "Eliminar" });
    await waitFor(() => expect(boton).toBeDisabled());
    fireEvent.click(boton);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
