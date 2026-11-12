/**
 * Reportes: el selector de clubes de ADMINISTRACIÓN sigue a la competencia.
 *
 *  - Muestra solo los clubes con inscripciones confirmadas en la competencia (los entrega la
 *    API; aquí se comprueba que la pantalla usa esa lista y no el catálogo completo).
 *  - Al cambiar de competencia limpia la selección si deja de ser válida.
 *  - Una respuesta tardía de la competencia anterior no sustituye las opciones ni el reporte.
 *  - No muestra el reporte anterior como si fuera de la nueva selección.
 *
 * Interacción simulada con jsdom y servicios simulados, datos sintéticos; no es un navegador real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ReportsPage } from "./ReportsPage";

type Actor = { user: Record<string, unknown>; roles: string[] };
const ADMIN: Actor = { user: { id: "u-admin", username: "admin", ownerType: "system", personId: null, clubId: null, roles: ["admin"] }, roles: ["admin"] };
const DELEGADO: Actor = {
  user: { id: "u-del", username: "deleg", ownerType: "person", personId: "p1", clubId: "club-a", roles: ["delegate"] },
  roles: ["delegate"],
};
let actual: Actor = ADMIN;

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: actual.user,
      accessToken: "t",
      permissions: ["reports:read", "export:team-manager"],
      mustChangePassword: false,
      hasRole: (r: string) => actual.roles.includes(r),
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

const COMPETENCIAS = [
  { id: "comp-1", name: "Competencia Uno", status: "open", dates: [] },
  { id: "comp-2", name: "Competencia Dos", status: "open", dates: [] },
  { id: "comp-3", name: "Competencia Tres", status: "open", dates: [] },
];
const OPCIONES: Record<string, { id: string; name: string }[]> = {
  "comp-1": [
    { id: "club-a", name: "Club Alfa" },
    { id: "club-b", name: "Club Beta" },
  ],
  "comp-2": [{ id: "club-c", name: "Club Gama (solo relevos)" }],
  "comp-3": [
    { id: "club-a", name: "Club Alfa" },
    { id: "club-c", name: "Club Gama (solo relevos)" },
  ],
};

const competitionsList = vi.fn(async () => ({ items: COMPETENCIAS, total: COMPETENCIAS.length, page: 1, pageSize: 100 }));
// El catálogo completo de clubes: administración ya NO lo usa para este selector.
const clubsList = vi.fn(async () => ({ items: [{ id: "club-z", name: "Club Sin Inscritos" }], total: 1, page: 1, pageSize: 100 }));
const clubsGet = vi.fn(async () => ({ id: "club-a", name: "Club Alfa" }));
const getClubesConInscripciones = vi.fn(async (competitionId: string) => ({ clubs: OPCIONES[competitionId] ?? [] }));
const getRegistrationsReport = vi.fn();

vi.mock("../competitions/competitionsApi", () => ({ useCompetitionsApi: () => ({ list: competitionsList }) }));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => ({ list: clubsList, get: clubsGet }) }));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => ({ getCurrentClub: vi.fn(async () => null) }) }));
vi.mock("./reportsApi", () => ({
  useReportsApi: () => ({ getRegistrationsReport, downloadExport: vi.fn(), downloadTeamManagerExport: vi.fn(), getClubesConInscripciones }),
}));

function diferida<T>() {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((res) => {
    resolver = res;
  });
  return { promesa, resolver };
}

const informe = (competitionName: string) => ({
  competitionName,
  individualRows: [],
  relayRows: [],
  groupedByClub: [{ clubName: "Club Alfa", totalNadadores: 0, totalPruebasIndividuales: 0, totalRelevos: 0, swimmers: [] }],
});

const selectorCompetencia = () => screen.getAllByRole("combobox")[0] as HTMLSelectElement;
const selectorClub = () => screen.getByRole("combobox", { name: "Club" }) as HTMLSelectElement;
const opcionesVisibles = () => Array.from(selectorClub().options).map((o) => o.textContent);
const botonGenerar = () => screen.getByRole("button", { name: /Generar reporte|Generando/ });

async function montar(actor: Actor = ADMIN) {
  actual = actor;
  render(
    <MemoryRouter>
      <ReportsPage />
    </MemoryRouter>
  );
  await screen.findByRole("option", { name: "Competencia Uno" });
}

async function elegirCompetencia(id: string) {
  fireEvent.change(selectorCompetencia(), { target: { value: id } });
  await waitFor(() => expect(botonGenerar()).toBeEnabled());
}

beforeEach(() => {
  vi.clearAllMocks();
  getClubesConInscripciones.mockImplementation(async (competitionId: string) => ({ clubs: OPCIONES[competitionId] ?? [] }));
});

describe("opciones según la competencia", () => {
  it("sin competencia: el selector no ofrece clubes y no usa el catálogo completo", async () => {
    await montar();
    expect(selectorClub()).toBeDisabled();
    expect(opcionesVisibles()).toEqual(["Todos"]);
    expect(clubsList).not.toHaveBeenCalled();
    expect(getClubesConInscripciones).not.toHaveBeenCalled();
  });

  it("muestra solo los clubes con inscripciones de la competencia elegida, incluido el de solo relevos", async () => {
    await montar();
    await elegirCompetencia("comp-1");
    expect(getClubesConInscripciones).toHaveBeenCalledWith("comp-1");
    expect(opcionesVisibles()).toEqual(["Todos", "Club Alfa", "Club Beta"]);

    await elegirCompetencia("comp-2");
    expect(opcionesVisibles()).toEqual(["Todos", "Club Gama (solo relevos)"]);
    expect(screen.queryByRole("option", { name: "Club Sin Inscritos" })).not.toBeInTheDocument();
  });

  it("mientras llegan las opciones, el club y las acciones esperan", async () => {
    const pendiente = diferida<{ clubs: { id: string; name: string }[] }>();
    getClubesConInscripciones.mockReturnValueOnce(pendiente.promesa);
    await montar();
    fireEvent.change(selectorCompetencia(), { target: { value: "comp-1" } });

    expect(selectorClub()).toBeDisabled();
    expect(opcionesVisibles()).toEqual(["Cargando clubes..."]);
    expect(botonGenerar()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Exportar a Team Manager (.zip)" })).toBeDisabled();

    await act(async () => pendiente.resolver({ clubs: OPCIONES["comp-1"]! }));
    expect(botonGenerar()).toBeEnabled();
  });

  it("si las opciones fallan, se informa y no queda un club sin validar", async () => {
    getClubesConInscripciones.mockRejectedValueOnce(new Error("No se pudieron cargar los clubes de la competencia"));
    await montar();
    fireEvent.change(selectorCompetencia(), { target: { value: "comp-1" } });
    expect(await screen.findByText("No se pudieron cargar los clubes de la competencia")).toBeInTheDocument();
    expect(selectorClub().value).toBe("");
  });
});

describe("selección de club al cambiar de competencia", () => {
  it("se limpia si el club deja de ser válido", async () => {
    await montar();
    await elegirCompetencia("comp-1");
    fireEvent.change(selectorClub(), { target: { value: "club-b" } });
    expect(selectorClub().value).toBe("club-b");

    await elegirCompetencia("comp-2");
    expect(selectorClub().value).toBe("");

    fireEvent.click(botonGenerar());
    await waitFor(() => expect(getRegistrationsReport).toHaveBeenCalledWith({ competitionId: "comp-2", clubId: undefined }));
  });

  it("se conserva si el club sigue siendo válido", async () => {
    await montar();
    await elegirCompetencia("comp-1");
    fireEvent.change(selectorClub(), { target: { value: "club-a" } });

    await elegirCompetencia("comp-3");
    expect(selectorClub().value).toBe("club-a");
  });
});

describe("respuestas tardías y resultados anteriores", () => {
  it("las opciones tardías de la competencia anterior no sustituyen las actuales", async () => {
    const tardia = diferida<{ clubs: { id: string; name: string }[] }>();
    getClubesConInscripciones.mockImplementation(async (id: string) => (id === "comp-1" ? tardia.promesa : { clubs: OPCIONES[id] ?? [] }));
    await montar();

    fireEvent.change(selectorCompetencia(), { target: { value: "comp-1" } });
    await elegirCompetencia("comp-2");
    expect(opcionesVisibles()).toEqual(["Todos", "Club Gama (solo relevos)"]);

    await act(async () => tardia.resolver({ clubs: OPCIONES["comp-1"]! }));
    expect(opcionesVisibles(), "llegó tarde: se descarta").toEqual(["Todos", "Club Gama (solo relevos)"]);
  });

  it("al cambiar de competencia se retira el reporte anterior", async () => {
    getRegistrationsReport.mockResolvedValue(informe("Competencia Uno"));
    await montar();
    await elegirCompetencia("comp-1");
    fireEvent.click(botonGenerar());
    expect(await screen.findByRole("heading", { name: "Competencia Uno" })).toBeInTheDocument();

    fireEvent.change(selectorCompetencia(), { target: { value: "comp-2" } });
    expect(screen.queryByRole("heading", { name: "Competencia Uno" })).not.toBeInTheDocument();
  });

  it("al cambiar de club también se retira el reporte anterior", async () => {
    getRegistrationsReport.mockResolvedValue(informe("Competencia Uno"));
    await montar();
    await elegirCompetencia("comp-1");
    fireEvent.click(botonGenerar());
    expect(await screen.findByRole("heading", { name: "Competencia Uno" })).toBeInTheDocument();

    fireEvent.change(selectorClub(), { target: { value: "club-a" } });
    expect(screen.queryByRole("heading", { name: "Competencia Uno" })).not.toBeInTheDocument();
  });

  it("un reporte que llega después de cambiar la competencia no se muestra", async () => {
    const tardio = diferida<ReturnType<typeof informe>>();
    getRegistrationsReport.mockReturnValueOnce(tardio.promesa);
    await montar();
    await elegirCompetencia("comp-1");
    fireEvent.click(botonGenerar());
    expect(botonGenerar()).toHaveTextContent("Generando...");

    await elegirCompetencia("comp-2");
    await act(async () => tardio.resolver(informe("Competencia Uno")));
    expect(screen.queryByRole("heading", { name: "Competencia Uno" })).not.toBeInTheDocument();
    expect(botonGenerar()).toHaveTextContent("Generar reporte");
  });
});

describe("alcances que no cambian", () => {
  it("el delegado conserva su club fijo y no consulta las opciones de administración", async () => {
    await montar(DELEGADO);
    expect(await screen.findByText("Club Alfa")).toBeInTheDocument();
    fireEvent.change(selectorCompetencia(), { target: { value: "comp-1" } });
    expect(screen.queryByRole("combobox", { name: "Club" })).not.toBeInTheDocument();
    expect(getClubesConInscripciones).not.toHaveBeenCalled();
    expect(botonGenerar()).toBeEnabled();
  });

  it("las pestañas de Reportes son solo de administración", async () => {
    await montar();
    expect(screen.getByRole("link", { name: "Resumen por club" })).toHaveAttribute("href", "/reportes/resumen-por-club");
  });

  it("el delegado no ve el acceso al resumen por club", async () => {
    await montar(DELEGADO);
    expect(screen.queryByRole("link", { name: "Resumen por club" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Tipos de reporte" })).not.toBeInTheDocument();
  });
});
