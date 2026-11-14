/**
 * COMPETENCIA POR DEFECTO en Reportes: «Generar reporte» (reporte detallado) y «Resumen por club».
 *
 * El mismo criterio de Inscripción y Relevos (`competenciaPreseleccionada`):
 *  - se preselecciona solo si está en la lista que esa cuenta puede elegir (el servidor de mentira
 *    imita el filtro: con `visibleInRegistrationPanels: true` no devuelve las ocultas);
 *  - administración conserva su excepción para las ocultas;
 *  - sin predeterminada accesible el selector queda vacío;
 *  - una elección manual (incluido volver a «Seleccionar...») no la pisa una carga posterior;
 *  - una selección que deja de estar disponible se vacía y retira sus resultados, sin sustituirla.
 * Además, la preselección pasa por las mismas preparaciones que una elección normal: en el reporte
 * detallado NO genera el informe y deja pendientes las opciones de club; en el resumen, carga como
 * siempre y reinicia las exportaciones por fila.
 *
 * El «Resumen por club» es solo de administración: el caso «oculta para otros roles» no aplica.
 * Interacción simulada con jsdom y servicios simulados, datos sintéticos; no es un navegador real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ReportsPage } from "./ReportsPage";
import { ClubSummaryReportPage } from "./ClubSummaryReportPage";

type Sesion = { ownerType: string; clubId: string | null; personId: string | null; roles: string[] };
let sesion: Sesion;

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u1", username: "quien-sea", ...sesion },
      accessToken: "t",
      permissions: ["reports:read", "export:team-manager"],
      mustChangePassword: false,
      hasRole: (r: string) => sesion.roles.includes(r),
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

interface Comp {
  id: string;
  name: string;
  status: string;
  visibleInRegistrationPanels: boolean;
  esPredeterminada: boolean;
}
let competencias: Comp[] = [];
let retrasar: Promise<void> | null = null;
const competitionsList = vi.fn(async (params: { visibleInRegistrationPanels?: boolean; page?: number; pageSize?: number }) => {
  if (retrasar) await retrasar;
  const items = competencias.filter((c) => params.visibleInRegistrationPanels === undefined || c.visibleInRegistrationPanels === params.visibleInRegistrationPanels);
  return { items, total: items.length, page: 1, pageSize: 100 };
});

const OPCIONES_DE_CLUB: Record<string, { id: string; name: string }[]> = {
  A: [{ id: "club-1", name: "Club Uno" }],
  B: [{ id: "club-1", name: "Club Uno" }, { id: "club-2", name: "Club Dos" }],
  O: [{ id: "club-2", name: "Club Dos" }],
};
const getClubesConInscripciones = vi.fn(async (id: string) => ({ clubs: OPCIONES_DE_CLUB[id] ?? [] }));
const getRegistrationsReport = vi.fn(async (f: { competitionId: string }) => ({
  competitionName: `Informe de ${f.competitionId}`,
  individualRows: [],
  relayRows: [],
  groupedByClub: [],
}));
const resumen = (id: string, edad: number) => ({
  competitionId: id,
  competitionName: `Resumen de ${id}`,
  edadMinima: edad,
  clubs: [{ clubId: "club-1", clubName: "Club Uno", varones: 1, damas: 0, totalNadadores: 1, nadadoresConEdadMinima: 0, pruebasIndividuales: 1, relevos: 0, totalPruebas: 1 }],
  totales: { varones: 1, damas: 0, totalNadadores: 1, nadadoresConEdadMinima: 0, pruebasIndividuales: 1, relevos: 0, totalPruebas: 1 },
});
const getResumenPorClub = vi.fn(async (id: string, edad: number) => resumen(id, edad));
const downloadExport = vi.fn(async () => undefined);
const downloadTeamManagerExport = vi.fn(async (_c: string, _club: string) => undefined);

vi.mock("../competitions/competitionsApi", () => ({ useCompetitionsApi: () => ({ list: competitionsList }) }));
vi.mock("../clubs/clubsApi", () => ({
  useClubsApi: () => ({ list: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 100 })), get: vi.fn(async () => ({ id: "club-1", name: "Club Uno" })) }),
}));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => ({ getCurrentClub: vi.fn(async () => null) }) }));
vi.mock("./reportsApi", () => ({
  useReportsApi: () => ({ getRegistrationsReport, getClubesConInscripciones, getResumenPorClub, downloadExport, downloadTeamManagerExport }),
}));

const comp = (id: string, o: Partial<Comp> = {}): Comp => ({ id, name: `Competencia ${id}`, status: "open", visibleInRegistrationPanels: true, esPredeterminada: false, ...o });
const ADMIN: Sesion = { ownerType: "system", clubId: null, personId: null, roles: ["admin"] };
const DELEGADO: Sesion = { ownerType: "person", clubId: "club-1", personId: "p-1", roles: ["delegate"] };
const ADMIN_CON_CLUB: Sesion = { ownerType: "person", clubId: "club-1", personId: "p-1", roles: ["admin", "delegate"] };

function diferida<T>() {
  let resolver!: (v: T) => void;
  let rechazar!: (e: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

/** Espera a que la lista de competencias responda y se procese. */
async function soltarLista(soltar: () => void, indice: number) {
  await act(async () => {
    soltar();
    await competitionsList.mock.results[indice]!.value;
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sesion = ADMIN;
  retrasar = null;
  competencias = [];
  getClubesConInscripciones.mockImplementation(async (id: string) => ({ clubs: OPCIONES_DE_CLUB[id] ?? [] }));
  getResumenPorClub.mockImplementation(async (id: string, edad: number) => resumen(id, edad));
  downloadTeamManagerExport.mockImplementation(async () => undefined);
});

// ---------------------------------------------------------------------------------------------
describe("Generar reporte (reporte detallado)", () => {
  const vista = () => (
    <MemoryRouter>
      <ReportsPage />
    </MemoryRouter>
  );
  const selector = () => screen.getAllByRole("combobox")[0] as HTMLSelectElement;
  const selectorClub = () => screen.getByRole("combobox", { name: "Club" }) as HTMLSelectElement;
  const opcionesDeClub = () => Array.from(selectorClub().options).map((o) => o.textContent);
  const botonGenerar = () => screen.getByRole("button", { name: /Generar reporte|Generando/ });
  const cambiarSesion = (rerender: (ui: React.ReactElement) => void, s: Sesion) => {
    sesion = s;
    rerender(vista());
  };

  it("preselecciona la predeterminada visible para quien no administra, sin generar el informe", async () => {
    sesion = DELEGADO;
    competencias = [comp("A"), comp("B", { esPredeterminada: true })];
    render(vista());
    await waitFor(() => expect(selector().value).toBe("B"));
    expect(botonGenerar()).toBeEnabled();
    expect(getRegistrationsReport, "preseleccionar no genera").not.toHaveBeenCalled();

    fireEvent.click(botonGenerar());
    await waitFor(() => expect(getRegistrationsReport).toHaveBeenCalledWith({ competitionId: "B", clubId: "club-1" }));
    expect(await screen.findByRole("heading", { name: "Informe de B" })).toBeInTheDocument();
  });

  it("predeterminada OCULTA: el delegado queda sin elección; administración la ve preseleccionada", async () => {
    competencias = [comp("A"), comp("O", { visibleInRegistrationPanels: false, esPredeterminada: true })];
    sesion = DELEGADO;
    const { unmount } = render(vista());
    await waitFor(() => expect(selector().options).toHaveLength(2));
    expect(selector().value).toBe("");
    expect(botonGenerar()).toBeDisabled();
    unmount();

    sesion = ADMIN;
    render(vista());
    await waitFor(() => expect(selector().value).toBe("O"));
    expect(getRegistrationsReport).not.toHaveBeenCalled();
  });

  it("sin predeterminada accesible el selector queda vacío y no se puede generar ni exportar", async () => {
    competencias = [comp("A"), comp("B")];
    render(vista());
    await waitFor(() => expect(selector().options).toHaveLength(3));
    expect(selector().value).toBe("");
    expect(botonGenerar()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Exportar CSV" })).toBeDisabled();
  });

  it("tras la preselección, las opciones de club esperan su respuesta (sin club sin validar) y luego se cargan", async () => {
    const pendiente = diferida<{ clubs: { id: string; name: string }[] }>();
    getClubesConInscripciones.mockReturnValueOnce(pendiente.promesa);
    competencias = [comp("A"), comp("B", { esPredeterminada: true })];
    render(vista());
    await waitFor(() => expect(selector().value).toBe("B"));

    expect(getClubesConInscripciones).toHaveBeenCalledWith("B");
    expect(opcionesDeClub()).toEqual(["Cargando clubes..."]);
    expect(selectorClub()).toBeDisabled();
    expect(botonGenerar()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Exportar a Team Manager (.zip)" })).toBeDisabled();

    await act(async () => pendiente.resolver({ clubs: OPCIONES_DE_CLUB.B! }));
    expect(opcionesDeClub()).toEqual(["Todos", "Club Uno", "Club Dos"]);
    expect(botonGenerar()).toBeEnabled();
  });

  it("las opciones tardías de la competencia preseleccionada no reemplazan las de la elegida a mano", async () => {
    const tardia = diferida<{ clubs: { id: string; name: string }[] }>();
    getClubesConInscripciones.mockImplementation(async (id: string) => (id === "B" ? tardia.promesa : { clubs: OPCIONES_DE_CLUB[id] ?? [] }));
    competencias = [comp("A"), comp("B", { esPredeterminada: true })];
    render(vista());
    await waitFor(() => expect(selector().value).toBe("B"));

    fireEvent.change(selector(), { target: { value: "A" } });
    await waitFor(() => expect(opcionesDeClub()).toEqual(["Todos", "Club Uno"]));
    await act(async () => tardia.resolver({ clubs: OPCIONES_DE_CLUB.B! }));
    expect(opcionesDeClub(), "llegó tarde: se descarta").toEqual(["Todos", "Club Uno"]);
  });

  it("la elección manual sobrevive a una carga posterior, también si eligió «Seleccionar...»", async () => {
    sesion = DELEGADO;
    competencias = [comp("A"), comp("B", { esPredeterminada: true })];
    const { rerender } = render(vista());
    await waitFor(() => expect(selector().value).toBe("B"));
    fireEvent.change(selector(), { target: { value: "" } });

    let soltar!: () => void;
    retrasar = new Promise<void>((r) => (soltar = r));
    cambiarSesion(rerender, ADMIN_CON_CLUB);
    await waitFor(() => expect(competitionsList).toHaveBeenCalledTimes(2));
    await soltarLista(soltar, 1);
    expect(selector().value, "no se reaplica la predeterminada").toBe("");

    fireEvent.change(selector(), { target: { value: "A" } });
    expect(selector().value).toBe("A");
  });

  it("una selección que deja de estar disponible se vacía y retira su informe, sin sustituirla", async () => {
    competencias = [comp("A"), comp("B", { esPredeterminada: true }), comp("O", { visibleInRegistrationPanels: false })];
    sesion = ADMIN_CON_CLUB;
    const { rerender } = render(vista());
    await waitFor(() => expect(selector().value).toBe("B"));
    fireEvent.change(selector(), { target: { value: "O" } });
    await waitFor(() => expect(botonGenerar()).toBeEnabled());
    fireEvent.click(botonGenerar());
    expect(await screen.findByRole("heading", { name: "Informe de O" })).toBeInTheDocument();

    cambiarSesion(rerender, DELEGADO);
    await waitFor(() => expect(competitionsList).toHaveBeenCalledTimes(2));
    await waitFor(() => expect([...selector().options].map((o) => o.value)).toEqual(["", "A", "B"]));
    expect(selector().value, "ni la predeterminada la reemplaza").toBe("");
    expect(screen.queryByRole("heading", { name: "Informe de O" })).not.toBeInTheDocument();
    expect(botonGenerar()).toBeDisabled();
  });

  it("un informe que llega después de vaciarse la selección no se muestra", async () => {
    const tardio = diferida<Awaited<ReturnType<typeof getRegistrationsReport>>>();
    competencias = [comp("A"), comp("O", { visibleInRegistrationPanels: false, esPredeterminada: true })];
    sesion = ADMIN_CON_CLUB;
    const { rerender } = render(vista());
    await waitFor(() => expect(selector().value).toBe("O"));
    await waitFor(() => expect(botonGenerar()).toBeEnabled());
    getRegistrationsReport.mockReturnValueOnce(tardio.promesa);
    fireEvent.click(botonGenerar());

    cambiarSesion(rerender, DELEGADO);
    await waitFor(() => expect(selector().value).toBe(""));
    await act(async () => tardio.resolver({ competitionName: "Informe de O", individualRows: [], relayRows: [], groupedByClub: [] }));
    expect(screen.queryByRole("heading", { name: "Informe de O" })).not.toBeInTheDocument();
  });

  it("una lista TARDÍA de la carga administrativa no restaura la selección descartada", async () => {
    competencias = [comp("A"), comp("O", { visibleInRegistrationPanels: false, esPredeterminada: true })];
    let soltarAdmin!: () => void;
    const esperaAdmin = new Promise<void>((r) => (soltarAdmin = r));
    competitionsList.mockImplementationOnce(async (params: { visibleInRegistrationPanels?: boolean }) => {
      await esperaAdmin;
      const items = competencias.filter((c) => params.visibleInRegistrationPanels === undefined || c.visibleInRegistrationPanels);
      return { items, total: items.length, page: 1, pageSize: 100 };
    });
    sesion = ADMIN_CON_CLUB;
    const { rerender } = render(vista());
    await waitFor(() => expect(competitionsList).toHaveBeenCalledTimes(1));

    cambiarSesion(rerender, DELEGADO);
    await waitFor(() => expect([...selector().options].map((o) => o.value)).toEqual(["", "A"]));
    await soltarLista(soltarAdmin, 0);
    expect([...selector().options].map((o) => o.value)).toEqual(["", "A"]);
    expect(selector().value).toBe("");
  });

  it("recorre todas las páginas de competencias y conserva el filtro de visibilidad", async () => {
    sesion = DELEGADO;
    competencias = [comp("A"), comp("B", { esPredeterminada: true })];
    render(vista());
    await waitFor(() => expect(selector().value).toBe("B"));
    expect(competitionsList.mock.calls[0]![0]).toMatchObject({ visibleInRegistrationPanels: true, page: 1 });
  });

  it("las exportaciones siguen con sus llamadas de siempre, con la competencia preseleccionada", async () => {
    competencias = [comp("A"), comp("B", { esPredeterminada: true })];
    render(vista());
    await waitFor(() => expect(selector().value).toBe("B"));
    await waitFor(() => expect(botonGenerar()).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Exportar CSV" }));
    await waitFor(() => expect(downloadExport).toHaveBeenCalledWith({ competitionId: "B", clubId: undefined }, "csv"));

    fireEvent.change(selectorClub(), { target: { value: "club-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Exportar a Team Manager (.zip)" }));
    await waitFor(() => expect(downloadTeamManagerExport).toHaveBeenCalledWith("B", "club-2"));
    expect(getRegistrationsReport).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
describe("Resumen por club", () => {
  const vista = () => (
    <MemoryRouter>
      <ClubSummaryReportPage />
    </MemoryRouter>
  );
  const selector = () => screen.getByLabelText("Competencia") as HTMLSelectElement;
  const cambiarSesion = (rerender: (ui: React.ReactElement) => void, s: Sesion) => {
    sesion = s;
    rerender(vista());
  };

  it("preselecciona la predeterminada, también oculta (excepción de administración), y la carga como siempre", async () => {
    competencias = [comp("A"), comp("O", { visibleInRegistrationPanels: false, esPredeterminada: true })];
    render(vista());
    await waitFor(() => expect(selector().value).toBe("O"));
    expect(competitionsList.mock.calls[0]![0]).not.toHaveProperty("visibleInRegistrationPanels");
    await waitFor(() => expect(getResumenPorClub).toHaveBeenCalledWith("O", 70));
    expect(await screen.findByRole("heading", { name: "Resumen de O" })).toBeInTheDocument();
  });

  it("sin predeterminada queda sin elección y no consulta", async () => {
    competencias = [comp("A"), comp("B")];
    render(vista());
    await waitFor(() => expect(selector().options).toHaveLength(3));
    expect(selector().value).toBe("");
    expect(getResumenPorClub).not.toHaveBeenCalled();
    expect(screen.getByText("Seleccione una competencia para ver el resumen.")).toBeInTheDocument();
  });

  it("la elección manual (también «Seleccionar...») sobrevive a una carga posterior", async () => {
    competencias = [comp("A"), comp("B", { esPredeterminada: true })];
    const { rerender } = render(vista());
    await waitFor(() => expect(selector().value).toBe("B"));
    fireEvent.change(selector(), { target: { value: "" } });

    // La sesión pierde y recupera administración: la lista se vuelve a cargar, con la marca.
    cambiarSesion(rerender, DELEGADO);
    cambiarSesion(rerender, ADMIN);
    await waitFor(() => expect(competitionsList).toHaveBeenCalledTimes(2));
    await act(async () => {
      await competitionsList.mock.results[1]!.value;
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(selector().value).toBe("");
  });

  it("una selección que deja de estar en la lista se vacía y retira su resumen, sin sustituirla", async () => {
    competencias = [comp("A"), comp("B", { esPredeterminada: true }), comp("X")];
    const { rerender } = render(vista());
    await waitFor(() => expect(selector().value).toBe("B"));
    fireEvent.change(selector(), { target: { value: "X" } });
    expect(await screen.findByRole("heading", { name: "Resumen de X" })).toBeInTheDocument();

    // Al volver a cargarse la lista, X ya no está (por ejemplo, se eliminó).
    competencias = [comp("A"), comp("B", { esPredeterminada: true })];
    cambiarSesion(rerender, DELEGADO);
    cambiarSesion(rerender, ADMIN);
    await waitFor(() => expect([...selector().options].map((o) => o.value)).toEqual(["", "A", "B"]));
    expect(selector().value).toBe("");
    expect(screen.queryByRole("heading", { name: "Resumen de X" })).not.toBeInTheDocument();
    expect(screen.getByText("Seleccione una competencia para ver el resumen.")).toBeInTheDocument();
  });

  it("el resumen tardío de la competencia preseleccionada no reemplaza al de la elegida a mano", async () => {
    const tardio = diferida<ReturnType<typeof resumen>>();
    getResumenPorClub.mockImplementation(async (id: string, edad: number) => (id === "B" ? tardio.promesa : resumen(id, edad)));
    competencias = [comp("A"), comp("B", { esPredeterminada: true })];
    render(vista());
    await waitFor(() => expect(selector().value).toBe("B"));
    fireEvent.change(selector(), { target: { value: "A" } });
    expect(await screen.findByRole("heading", { name: "Resumen de A" })).toBeInTheDocument();

    await act(async () => tardio.resolver(resumen("B", 70)));
    expect(screen.queryByRole("heading", { name: "Resumen de B" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Resumen de A" })).toBeInTheDocument();
  });

  it("exportación por fila: la operación vieja de la preseleccionada no toca a la nueva tras A → B → A", async () => {
    competencias = [comp("A", { esPredeterminada: true }), comp("B")];
    const vieja = diferida<undefined>();
    downloadTeamManagerExport.mockReturnValueOnce(vieja.promesa);
    render(vista());
    await waitFor(() => expect(selector().value).toBe("A"));
    const botonDe = () => within(screen.getByRole("table")).getByRole("button", { name: "Exportar a Team Manager (.zip): Club Uno" });
    fireEvent.click(await waitFor(() => botonDe()));
    expect(botonDe()).toHaveTextContent("Generando...");

    fireEvent.change(selector(), { target: { value: "B" } });
    fireEvent.change(selector(), { target: { value: "A" } });
    await waitFor(() => expect(botonDe()).toHaveTextContent("Exportar a Team Manager (.zip)"));

    await act(async () => vieja.rechazar(new Error("Error viejo sintético")));
    expect(screen.queryByText("Error viejo sintético")).not.toBeInTheDocument();
    expect(downloadTeamManagerExport).toHaveBeenCalledWith("A", "club-1");
  });
});
