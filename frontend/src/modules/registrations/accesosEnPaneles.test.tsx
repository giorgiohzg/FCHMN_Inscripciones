/**
 * ACCESOS POR ROL en los paneles: los controles de cada acción apagada se ocultan; los demás
 * siguen igual. Sin restricciones, los paneles se ven como siempre. Solo es presentación: el
 * servidor deniega igual (`accesos-por-rol.integration.test.ts`). API simulada; datos sintéticos.
 *
 * También cubre los EDITORES de tiempo de ambos paneles: la precarga de un tiempo guardado (en
 * centésimas totales) y lo que se envía al guardar sin cambios o con un tiempo escrito.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RegistrationWorkspacePage } from "./RegistrationWorkspacePage";
import { RelayWorkspacePage } from "../relay-registrations/RelayWorkspacePage";
import { ReportsPage } from "../reports/ReportsPage";
import { IncorporacionesClubPage } from "../swimmer-assignment/IncorporacionesClubPage";

/**
 * Funciones apagadas, REACTIVAS: cambiarlas con `fijarApagadas` vuelve a dibujar la pantalla ya
 * montada, como cuando llegan funciones efectivas nuevas (renovación o denegación).
 */
const almacen = vi.hoisted(() => ({ apagadas: [] as string[], oyentes: new Set<() => void>() }));
function fijarApagadas(lista: string[]) {
  almacen.apagadas = lista;
  for (const oyente of almacen.oyentes) oyente();
}
vi.mock("../auth/AccesosContext", async () => {
  const { useSyncExternalStore } = await import("react");
  const suscribir = (oyente: () => void) => {
    almacen.oyentes.add(oyente);
    return () => almacen.oyentes.delete(oyente);
  };
  return {
    useAccesos: () => {
      const apagadas = useSyncExternalStore(suscribir, () => almacen.apagadas);
      return { deshabilitada: (f: string) => apagadas.includes(f), estado: "cargado", version: 1, refrescar: vi.fn() };
    },
  };
});
/** Tiempos guardados de la inscripción `r1` y del equipo `t1`, en centésimas totales (o sin tiempo). */
const datos = vi.hoisted(() => ({ tiempoInscripcion: 3000 as number | null, tiempoEquipo: 20000 as number | null }));
/** Avisos (toasts) emitidos por los paneles. */
const avisos = vi.hoisted(() => ({ mostrar: vi.fn() }));
/** Escrituras simuladas: se inspeccionan para comprobar que NO se envía nada indebido. */
const escrituras = vi.hoisted(() => ({
  crearInscripcion: vi.fn(),
  actualizarInscripcion: vi.fn(),
  cancelarInscripcion: vi.fn(),
  crearEquipo: vi.fn(),
  actualizarEquipo: vi.fn(),
  cancelarEquipo: vi.fn(),
}));

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u1", username: "delegado", ownerType: "person", clubId: "club-1", personId: "p-del", roles: ["delegate"] },
      accessToken: "t",
      permissions: ["registrations:read", "registrations:write", "reports:read", "export:team-manager", "swimmer-assignment:write"],
      mustChangePassword: false,
      hasRole: (r: string) => r === "delegate",
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
vi.mock("../../shared/ToastProvider", async () => {
  const real = await vi.importActual<typeof import("../../shared/ToastProvider")>("../../shared/ToastProvider");
  return { ...real, useToast: () => ({ showToast: avisos.mostrar }) };
});

const vacia = async () => ({ items: [] as unknown[], total: 0, page: 1, pageSize: 100 });
const COMPETENCIA = { id: "comp-A", name: "Competencia A", status: "open", ageCutoffDate: "2027-12-31T00:00:00.000Z", esPredeterminada: true };
const evento = (id: string, swimmersCount: number) => ({
  id,
  displayOrder: 1,
  event: { id: `e-${id}`, distance: { meters: 50 }, stroke: { name: "Libre" }, testType: { name: swimmersCount === 1 ? "Individual" : "Relevo", swimmersCount }, gender: "female" },
  competitionSession: { id: "s1", sessionType: { name: "Mañana" }, competitionDate: { date: "2027-01-15" } },
  enabledCategories: [{ category: { id: "cat-r", name: "Relevo 120", minAge: 0, maxAge: 999 } }],
});
const persona = (id: string, nombre: string) => ({ id, firstName: nombre, paternalLastName: "Sintética", maternalLastName: null, fullName: `${nombre} Sintética` });
const PERSONAS = [persona("p1", "Ana"), persona("p2", "Bea"), persona("p3", "Cata"), persona("p4", "Dora")];

vi.mock("../competitions/competitionsApi", () => ({ useCompetitionsApi: () => ({ list: vi.fn(async () => ({ items: [COMPETENCIA], total: 1, page: 1, pageSize: 100 })) }) }));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => ({ list: vi.fn(vacia), get: vi.fn(async () => ({ id: "club-1", name: "Club Uno" })) }) }));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => ({ getCurrentClub: vi.fn(async () => null) }) }));
vi.mock("./registrationsApi", () => ({
  useRegistrationsApi: () => ({
    listEnabledEvents: vi.fn(async () => [evento("ce-1", 1), evento("ce-r", 4)]),
    listClubEligibilityMatrix: vi.fn(async () =>
      PERSONAS.map((p, i) => ({ personId: p.id, fullName: p.fullName, firstName: p.firstName, paternalLastName: p.paternalLastName, maternalLastName: null, edadAlCorte: 40, run: `${p.id}-1`, gender: "female", eligibleEvents: i === 3 ? [{ competitionEventId: "ce-1", categoryId: "c", categoryName: "Máster" }] : [], registeredEventIds: i === 0 ? ["ce-1"] : [] }))
    ),
    listClubSwimmers: vi.fn(async () => PERSONAS.map((p) => ({ ...p, edadAlCorte: 40, run: `${p.id}-1`, gender: "female", birthDate: "1987-01-01T00:00:00.000Z" }))),
    list: vi.fn(async () => ({
      items: [
        {
          id: "r1",
          status: "confirmed",
          seedTimeCentiseconds: datos.tiempoInscripcion,
          edadAlCorte: 40,
          person: { ...PERSONAS[0]!, run: "p1-1" },
          club: { id: "club-1", name: "Club Uno" },
          category: { id: "c", name: "Máster" },
          competitionEvent: { competition: { id: "comp-A", name: "A", isRegistrationOpen: true }, event: evento("ce-1", 1).event, competitionSession: evento("ce-1", 1).competitionSession },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    })),
    create: escrituras.crearInscripcion,
    cancel: escrituras.cancelarInscripcion,
    update: escrituras.actualizarInscripcion,
  }),
}));
vi.mock("../relay-registrations/relayRegistrationsApi", () => ({
  useRelayRegistrationsApi: () => ({
    list: vi.fn(async () => ({
      items: [
        {
          id: "t1",
          status: "confirmed",
          seedTimeCentiseconds: datos.tiempoEquipo,
          club: { id: "club-1", name: "Club Uno" },
          category: { id: "cat-r", name: "Relevo 120" },
          competitionEvent: { competition: { id: "comp-A", name: "A" }, event: evento("ce-r", 4).event, competitionSession: evento("ce-r", 4).competitionSession },
          members: PERSONAS.map((p, i) => ({ orderPosition: i + 1, personId: p.id, person: { ...p, run: `${p.id}-1` } })),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    })),
    create: escrituras.crearEquipo,
    update: escrituras.actualizarEquipo,
    cancel: escrituras.cancelarEquipo,
  }),
}));
vi.mock("../reports/reportsApi", () => ({
  useReportsApi: () => ({ getRegistrationsReport: vi.fn(), getClubesConInscripciones: vi.fn(async () => ({ clubs: [] })), downloadExport: vi.fn(), downloadTeamManagerExport: vi.fn() }),
}));
const cuota = vi.fn(async () => ({ dia: "2026-11-15", usados: 1, limite: 30, restantes: 29 }));
vi.mock("../swimmer-assignment/postulacionApi", async () => {
  const real = await vi.importActual<typeof import("../swimmer-assignment/postulacionApi")>("../swimmer-assignment/postulacionApi");
  return {
    ...real,
    usePostulacionApi: () => ({
      cuota,
      periodoVigente: vi.fn(async () => ({ vigente: false })),
      postular: vi.fn(),
      completarAlta: vi.fn(),
      propuestas: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
      solicitudes: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
    }),
  };
});

const montar = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

function diferida<T>() {
  let resolver!: (v: T) => void;
  let rechazar!: (e: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

beforeEach(() => {
  fijarApagadas([]);
  datos.tiempoInscripcion = 3000;
  datos.tiempoEquipo = 20000;
  avisos.mostrar.mockReset();
  cuota.mockClear();
  for (const f of Object.values(escrituras)) f.mockReset();
  escrituras.crearInscripcion.mockResolvedValue({ id: "r-nueva" });
  escrituras.actualizarInscripcion.mockResolvedValue({});
  escrituras.crearEquipo.mockResolvedValue({ id: "t-nuevo" });
  escrituras.actualizarEquipo.mockResolvedValue({});
});

describe("Panel de Inscripción", () => {
  async function abrir() {
    montar(<RegistrationWorkspacePage />);
    const zona = await screen.findByRole("region", { name: "Pruebas por día" });
    await waitFor(() => expect(within(zona).getByText("SINTÉTICA, ANA (40)")).toBeInTheDocument());
    return zona;
  }

  it("sin restricciones: Editar, ×, Inscribir e historial, como siempre", async () => {
    const zona = await abrir();
    expect(within(zona).getByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(within(zona).getByRole("button", { name: "×" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ver historial/ })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("region", { name: "Nadadores del plantel" })).getByText(/SINTÉTICA, DORA/));
    expect(await within(zona).findByRole("button", { name: "Inscribir" })).toBeInTheDocument();
  });

  it("acciones apagadas: se ocultan sus controles; el resto sigue", async () => {
    fijarApagadas(["inscripciones.crear", "inscripciones.editar_tiempo", "inscripciones.historial"]);
    const zona = await abrir();
    expect(within(zona).queryByRole("button", { name: "Editar" })).not.toBeInTheDocument();
    expect(within(zona).getByRole("button", { name: "×" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ver historial/ })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("region", { name: "Nadadores del plantel" })).getByText(/SINTÉTICA, DORA/));
    await new Promise((r) => setTimeout(r, 0));
    expect(within(zona).queryByRole("button", { name: "Inscribir" })).not.toBeInTheDocument();
  });

  it("cancelar apagado: sin × (y sin deshacer, que también es una cancelación)", async () => {
    fijarApagadas(["inscripciones.cancelar"]);
    const zona = await abrir();
    expect(within(zona).queryByRole("button", { name: "×" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Ctrl\+Z/, { selector: "kbd" })).not.toBeInTheDocument();
  });
});

describe("Panel de Relevos", () => {
  async function abrir() {
    montar(<RelayWorkspacePage />);
    const zona = await screen.findByRole("region", { name: "Pruebas de relevo por día" });
    await waitFor(() => expect(within(zona).getByText(/Relevo 120/)).toBeInTheDocument());
    return zona;
  }

  it("sin restricciones: Editar y × en cada equipo, e historial", async () => {
    const zona = await abrir();
    expect(within(zona).getByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(within(zona).getByRole("button", { name: "×" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ver historial/ })).toBeInTheDocument();
  });

  it("editar, cancelar e historial apagados: se ocultan", async () => {
    fijarApagadas(["relevos.editar", "relevos.cancelar", "relevos.historial"]);
    const zona = await abrir();
    expect(within(zona).queryByRole("button", { name: "Editar" })).not.toBeInTheDocument();
    expect(within(zona).queryByRole("button", { name: "×" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ver historial/ })).not.toBeInTheDocument();
  });

  it("armar apagado: elegir la prueba no abre el constructor de un equipo nuevo", async () => {
    fijarApagadas(["relevos.armar"]);
    const zona = await abrir();
    fireEvent.click(within(zona).getByText(/50m Libre/));
    await new Promise((r) => setTimeout(r, 0));
    expect(within(zona).queryByText("Nuevo equipo")).not.toBeInTheDocument();
  });
});

/**
 * EDITOR YA ABIERTO cuando llegan funciones efectivas nuevas que apagan su acción (la pantalla no
 * se desmonta). El editor se cierra, sin enviar nada, y se avisa. «Cancelar edición» solo cierra
 * el editor: no es cancelar la inscripción y no depende de ese permiso. Las acciones son
 * independientes: apagar una no impide la otra.
 */
describe("Panel de Inscripción: editor abierto", () => {
  async function abrir() {
    montar(<RegistrationWorkspacePage />);
    const zona = await screen.findByRole("region", { name: "Pruebas por día" });
    await waitFor(() => expect(within(zona).getByText("SINTÉTICA, ANA (40)")).toBeInTheDocument());
    return zona;
  }

  it("editando el tiempo, se apaga editar_tiempo: el campo y el guardar desaparecen, se avisa y no se envía nada", async () => {
    const zona = await abrir();
    fireEvent.click(within(zona).getByRole("button", { name: "Editar" }));
    expect(within(zona).getByDisplayValue("003000")).toBeInTheDocument();

    act(() => fijarApagadas(["inscripciones.editar_tiempo"]));

    expect(within(zona).queryByDisplayValue("003000"), "el campo editable no sigue operativo").not.toBeInTheDocument();
    const guardar = within(zona).queryByRole("button", { name: /Guardar tiempo|✓/ });
    if (guardar) fireEvent.click(guardar);
    expect(guardar, "sin botón de guardar que aparente funcionar").toBeNull();
    expect(screen.getByText(/se deshabilitó para su cuenta/)).toHaveTextContent("sin enviar cambios");
    expect(escrituras.actualizarInscripcion).not.toHaveBeenCalled();
  });

  it("editar permitido con crear apagado: la edición del tiempo funciona", async () => {
    fijarApagadas(["inscripciones.crear"]);
    const zona = await abrir();
    fireEvent.click(within(zona).getByRole("button", { name: "Editar" }));
    fireEvent.change(within(zona).getByDisplayValue("003000"), { target: { value: "003500" } });
    fireEvent.click(within(zona).getByRole("button", { name: /Guardar tiempo|✓/ }));
    await waitFor(() => expect(escrituras.actualizarInscripcion).toHaveBeenCalledWith("r1", { seedTimeCentiseconds: 3500 }));
  });

  it("crear permitido con editar apagado: inscribir funciona", async () => {
    fijarApagadas(["inscripciones.editar_tiempo"]);
    const zona = await abrir();
    fireEvent.click(within(screen.getByRole("region", { name: "Nadadores del plantel" })).getByText(/SINTÉTICA, DORA/));
    fireEvent.change(await within(zona).findByPlaceholderText("mmsscc"), { target: { value: "003100" } });
    fireEvent.click(within(zona).getByRole("button", { name: "Inscribir" }));
    await waitFor(() =>
      expect(escrituras.crearInscripcion).toHaveBeenCalledWith(expect.objectContaining({ competitionEventId: "ce-1", personId: "p4", seedTimeCentiseconds: 3100 }))
    );
  });

  it("«Cancelar edición» cierra el editor aunque cancelar esté apagado, sin cancelar la inscripción", async () => {
    fijarApagadas(["inscripciones.cancelar"]);
    const zona = await abrir();
    fireEvent.click(within(zona).getByRole("button", { name: "Editar" }));
    fireEvent.click(within(zona).getByRole("button", { name: /Cancelar edición|✕/ }));
    expect(within(zona).queryByDisplayValue("003000")).not.toBeInTheDocument();
    expect(within(zona).getByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(escrituras.cancelarInscripcion).not.toHaveBeenCalled();
  });
});

describe("Panel de Relevos: constructor abierto", () => {
  async function abrir() {
    montar(<RelayWorkspacePage />);
    const zona = await screen.findByRole("region", { name: "Pruebas de relevo por día" });
    await waitFor(() => expect(within(zona).getByText(/Relevo 120/)).toBeInTheDocument());
    return zona;
  }
  /** Suelta un nadador del plantel en el primer puesto libre (arrastre simulado). */
  function soltarEnPuestoLibre(zona: HTMLElement, personId: string) {
    const libre = within(zona).getAllByText("Arrastre aquí")[0]!;
    fireEvent.drop(libre, { dataTransfer: { getData: (tipo: string) => (tipo === "application/x-roster-swimmer" ? personId : "") } });
  }

  it("editando un equipo, se apaga relevos.editar: el constructor se cierra, se avisa y no se envía nada", async () => {
    const zona = await abrir();
    fireEvent.click(within(zona).getByRole("button", { name: "Editar" }));
    expect(within(zona).getByText("Editando equipo")).toBeInTheDocument();

    act(() => fijarApagadas(["relevos.editar"]));

    expect(within(zona).queryByText("Editando equipo"), "el constructor no sigue abierto").not.toBeInTheDocument();
    expect(within(zona).queryByRole("button", { name: "Guardar cambios" })).not.toBeInTheDocument();
    expect(screen.getByText(/se deshabilitó para su cuenta/)).toHaveTextContent("sin enviar cambios");
    expect(escrituras.actualizarEquipo).not.toHaveBeenCalled();
  });

  it("armando un equipo nuevo con un nadador puesto, se apaga relevos.armar: el constructor se cierra y no se envía nada", async () => {
    const zona = await abrir();
    fireEvent.click(within(zona).getByText(/50m Libre/));
    expect(within(zona).getByText("Nuevo equipo")).toBeInTheDocument();
    soltarEnPuestoLibre(zona, "p1");
    expect(within(zona).getAllByText("Arrastre aquí")).toHaveLength(3);

    act(() => fijarApagadas(["relevos.armar"]));

    expect(within(zona).queryByText("Nuevo equipo"), "el constructor no sigue abierto").not.toBeInTheDocument();
    expect(within(zona).queryByRole("button", { name: "Confirmar equipo" })).not.toBeInTheDocument();
    expect(screen.getByText(/se deshabilitó para su cuenta/)).toHaveTextContent("sin enviar cambios");
    expect(escrituras.crearEquipo).not.toHaveBeenCalled();
  });

  it("editar permitido con armar apagado: la edición de un equipo funciona", async () => {
    fijarApagadas(["relevos.armar"]);
    const zona = await abrir();
    fireEvent.click(within(zona).getByRole("button", { name: "Editar" }));
    const guardar = within(zona).getByRole("button", { name: "Guardar cambios" });
    expect(guardar).toBeEnabled();
    fireEvent.click(guardar);
    // Solo se comprueba QUE se envía la edición con sus integrantes; el tiempo precargado no es
    // materia de esta prueba.
    await waitFor(() => expect(escrituras.actualizarEquipo).toHaveBeenCalledWith("t1", expect.objectContaining({ personIds: ["p1", "p2", "p3", "p4"] })));
    expect(screen.queryByText(/se deshabilitó para su cuenta/), "cerrar tras guardar no es una deshabilitación").not.toBeInTheDocument();
  });

  it("armar permitido con editar apagado: confirmar un equipo nuevo funciona", async () => {
    fijarApagadas(["relevos.editar"]);
    const zona = await abrir();
    fireEvent.click(within(zona).getByText(/50m Libre/));
    for (const id of ["p1", "p2", "p3", "p4"]) soltarEnPuestoLibre(zona, id);
    const confirmar = within(zona).getByRole("button", { name: "Confirmar equipo" });
    expect(confirmar).toBeEnabled();
    fireEvent.click(confirmar);
    await waitFor(() => expect(escrituras.crearEquipo).toHaveBeenCalledWith(expect.objectContaining({ competitionEventId: "ce-r", personIds: ["p1", "p2", "p3", "p4"] })));
  });
});

/**
 * GUARDADO YA EN CURSO cuando llegan accesos que apagan la acción. El editor se cierra (no admite
 * nuevas operaciones), pero el aviso NO afirma que no se guardó ni que se canceló: la petición ya
 * salió y el servidor puede confirmarla. La respuesta posterior se procesa como siempre, sin otra
 * petición.
 */
const AFIRMA_QUE_NO_SE_GUARDO = /sin guardar|sin enviar|no se guard|cancel|revirt/i;

describe("guardado en curso al apagarse la acción", () => {
  it("Inscripción: editar el tiempo con el guardado pendiente; responde bien", async () => {
    const pendiente = diferida<unknown>();
    escrituras.actualizarInscripcion.mockReturnValueOnce(pendiente.promesa);
    montar(<RegistrationWorkspacePage />);
    const zona = await screen.findByRole("region", { name: "Pruebas por día" });
    fireEvent.click(await within(zona).findByRole("button", { name: "Editar" }));
    fireEvent.change(within(zona).getByRole("textbox"), { target: { value: "003500" } });
    fireEvent.click(within(zona).getByRole("button", { name: "Guardar tiempo" }));
    expect(escrituras.actualizarInscripcion).toHaveBeenCalledTimes(1);

    act(() => fijarApagadas(["inscripciones.editar_tiempo"]));

    expect(within(zona).queryByRole("button", { name: "Guardar tiempo" }), "no admite nuevas operaciones").not.toBeInTheDocument();
    const aviso = screen.getByText(/se deshabilitó para su cuenta/);
    expect(aviso.textContent).not.toMatch(AFIRMA_QUE_NO_SE_GUARDO);
    expect(aviso).toHaveTextContent("ya se había enviado");

    await act(async () => pendiente.resolver({}));
    expect(avisos.mostrar).toHaveBeenCalledWith("Inscripción actualizada.", "success");
    expect(escrituras.actualizarInscripcion).toHaveBeenCalledTimes(1);
  });

  it("Relevos: editar un equipo con el guardado pendiente; el servidor lo rechaza", async () => {
    const pendiente = diferida<unknown>();
    escrituras.actualizarEquipo.mockReturnValueOnce(pendiente.promesa);
    montar(<RelayWorkspacePage />);
    const zona = await screen.findByRole("region", { name: "Pruebas de relevo por día" });
    fireEvent.click(await within(zona).findByRole("button", { name: "Editar" }));
    fireEvent.click(within(zona).getByRole("button", { name: "Guardar cambios" }));
    expect(escrituras.actualizarEquipo).toHaveBeenCalledTimes(1);

    act(() => fijarApagadas(["relevos.editar"]));

    expect(within(zona).queryByText("Editando equipo"), "no admite nuevas operaciones").not.toBeInTheDocument();
    const aviso = screen.getByText(/se deshabilitó para su cuenta/);
    expect(aviso.textContent).not.toMatch(AFIRMA_QUE_NO_SE_GUARDO);
    expect(aviso).toHaveTextContent("ya se había enviado");

    const { ApiError } = await import("../../shared/apiClient");
    await act(async () => pendiente.rechazar(new ApiError("Esta función está deshabilitada para su cuenta.", 403, "FUNCION_DESHABILITADA")));
    expect(avisos.mostrar).toHaveBeenCalledWith("Esta función está deshabilitada para su cuenta.", "error");
    expect(escrituras.actualizarEquipo).toHaveBeenCalledTimes(1);
  });

  it("Relevos: confirmar un equipo nuevo con la inscripción pendiente; responde bien", async () => {
    const pendiente = diferida<unknown>();
    escrituras.crearEquipo.mockReturnValueOnce(pendiente.promesa);
    montar(<RelayWorkspacePage />);
    const zona = await screen.findByRole("region", { name: "Pruebas de relevo por día" });
    await waitFor(() => expect(within(zona).getByText(/Relevo 120/)).toBeInTheDocument());
    fireEvent.click(within(zona).getByText(/50m Libre/));
    for (const id of ["p1", "p2", "p3", "p4"]) {
      fireEvent.drop(within(zona).getAllByText("Arrastre aquí")[0]!, { dataTransfer: { getData: (t: string) => (t === "application/x-roster-swimmer" ? id : "") } });
    }
    fireEvent.click(within(zona).getByRole("button", { name: "Confirmar equipo" }));
    expect(escrituras.crearEquipo).toHaveBeenCalledTimes(1);

    act(() => fijarApagadas(["relevos.armar"]));

    expect(within(zona).queryByText("Nuevo equipo"), "no admite nuevas operaciones").not.toBeInTheDocument();
    const aviso = screen.getByText(/se deshabilitó para su cuenta/);
    expect(aviso.textContent).not.toMatch(AFIRMA_QUE_NO_SE_GUARDO);
    expect(aviso).toHaveTextContent("ya se había enviado");

    await act(async () => pendiente.resolver({ id: "t-nuevo" }));
    expect(avisos.mostrar).toHaveBeenCalledWith("Equipo de relevo inscrito.", "success");
    expect(escrituras.crearEquipo).toHaveBeenCalledTimes(1);
  });
});

/**
 * PRECARGA DEL TIEMPO GUARDADO al editar. Lo guardado son centésimas TOTALES (20000 = 3:20,00); el
 * campo se escribe de derecha a izquierda (la entrada manual 20000 es 2:00,00). Al abrir la
 * edición el campo debe mostrar el MISMO tiempo, y guardar sin tocarlo debe enviar exactamente lo
 * guardado.
 */
const CASOS_DE_PRECARGA: [string, number | null, string][] = [
  ["menos de un minuto, con centésimas", 3456, "003456"],
  ["59,99 segundos", 5999, "005999"],
  ["un minuto exacto", 6000, "010000"],
  ["1:25,67", 8567, "012567"],
  ["3:20,00", 20000, "032000"],
  ["99:59,99", 599999, "995999"],
  ["sin tiempo", null, ""],
];

describe("Panel de Inscripción: precarga del tiempo al editar", () => {
  async function abrirEditor() {
    montar(<RegistrationWorkspacePage />);
    const zona = await screen.findByRole("region", { name: "Pruebas por día" });
    fireEvent.click(await within(zona).findByRole("button", { name: "Editar" }));
    return zona;
  }

  it.each(CASOS_DE_PRECARGA)("%s: el campo lo muestra y guardar sin cambios envía lo mismo", async (_caso, guardado, campo) => {
    datos.tiempoInscripcion = guardado;
    const zona = await abrirEditor();
    expect(within(zona).getByRole("textbox")).toHaveValue(campo);
    fireEvent.click(within(zona).getByRole("button", { name: "Guardar tiempo" }));
    await waitFor(() => expect(escrituras.actualizarInscripcion).toHaveBeenCalledWith("r1", { seedTimeCentiseconds: guardado }));
    expect(escrituras.actualizarInscripcion).toHaveBeenCalledTimes(1);
  });

  it("modificación expresa: «13236» (1:32,36) envía 9236", async () => {
    datos.tiempoInscripcion = 20000;
    const zona = await abrirEditor();
    fireEvent.change(within(zona).getByRole("textbox"), { target: { value: "13236" } });
    fireEvent.click(within(zona).getByRole("button", { name: "Guardar tiempo" }));
    await waitFor(() => expect(escrituras.actualizarInscripcion).toHaveBeenCalledWith("r1", { seedTimeCentiseconds: 9236 }));
  });
});

describe("Panel de Relevos: precarga del tiempo al editar un equipo", () => {
  async function abrirEditor() {
    montar(<RelayWorkspacePage />);
    const zona = await screen.findByRole("region", { name: "Pruebas de relevo por día" });
    fireEvent.click(await within(zona).findByRole("button", { name: "Editar" }));
    return zona;
  }
  const INTEGRANTES = ["p1", "p2", "p3", "p4"];

  it.each(CASOS_DE_PRECARGA)("%s: el campo lo muestra y guardar sin cambios envía lo mismo", async (_caso, guardado, campo) => {
    datos.tiempoEquipo = guardado;
    const zona = await abrirEditor();
    expect(within(zona).getByRole("textbox")).toHaveValue(campo);
    fireEvent.click(within(zona).getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(escrituras.actualizarEquipo).toHaveBeenCalledWith("t1", { personIds: INTEGRANTES, seedTimeCentiseconds: guardado }));
    expect(escrituras.actualizarEquipo).toHaveBeenCalledTimes(1);
  });

  it("modificación expresa: «2356» (0:23,56) envía 2356", async () => {
    datos.tiempoEquipo = 20000;
    const zona = await abrirEditor();
    fireEvent.change(within(zona).getByRole("textbox"), { target: { value: "2356" } });
    fireEvent.click(within(zona).getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(escrituras.actualizarEquipo).toHaveBeenCalledWith("t1", { personIds: INTEGRANTES, seedTimeCentiseconds: 2356 }));
  });
});

describe("Reportes", () => {
  it("generar y exportar apagados: se ocultan; Team Manager conserva su botón", async () => {
    fijarApagadas(["reportes.generar", "reportes.exportar"]);
    montar(<ReportsPage />);
    await screen.findByRole("option", { name: "Competencia A" });
    expect(screen.queryByRole("button", { name: "Generar reporte" })).not.toBeInTheDocument();
    for (const n of ["Exportar CSV", "Exportar Excel", "Exportar PDF"]) expect(screen.queryByRole("button", { name: n })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exportar a Team Manager (.zip)" })).toBeInTheDocument();
  });

  it("sin restricciones: todos los botones de siempre", async () => {
    montar(<ReportsPage />);
    await screen.findByRole("option", { name: "Competencia A" });
    for (const n of ["Generar reporte", "Exportar CSV", "Exportar Excel", "Exportar PDF", "Exportar a Team Manager (.zip)"]) expect(screen.getByRole("button", { name: n })).toBeInTheDocument();
  });
});

describe("Incorporaciones", () => {
  it("postular y listados apagados: sin formulario, sin listados y sin consultar cuota ni periodo", async () => {
    fijarApagadas(["incorporaciones.postular", "incorporaciones.listados"]);
    montar(<IncorporacionesClubPage />);
    expect(await screen.findByText("La postulación por RUN está deshabilitada para su cuenta.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Propuestas del club" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Cuota y periodo" })).not.toBeInTheDocument();
    expect(cuota).not.toHaveBeenCalled();
  });

  it("sin restricciones: cuota, formulario y listados", async () => {
    montar(<IncorporacionesClubPage />);
    expect(await screen.findByRole("region", { name: "Cuota y periodo" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Propuestas del club" })).toBeInTheDocument();
    expect(cuota).toHaveBeenCalled();
  });
});
