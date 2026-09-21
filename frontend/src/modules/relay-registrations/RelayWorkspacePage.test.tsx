/**
 * Hallazgo 31, frente 6 — PANEL DE RELEVOS.
 *
 * Misma pantalla que la de inscripciones individuales pero con un armador de
 * equipos encima, y con 0 % de cobertura. Se prueba lo que le toca al frontend:
 * el acotamiento por rol, la carrera entre vistas —que aquí pesa más, porque los
 * equipos heredados se pueden abrir para editar— y la puerta que impide guardar
 * un equipo incompleto. La composición válida (2+2, categorías, edad combinada)
 * es del backend.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RelayWorkspacePage } from "./RelayWorkspacePage";

type Sesion = { ownerType: string; clubId: string | null; personId: string | null; roles: string[] };
let sesion: Sesion = { ownerType: "system", clubId: null, personId: null, roles: ["admin"] };

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u1", username: "quien-sea", ...sesion },
      accessToken: "t",
      permissions: ["registrations:read", "registrations:write"],
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

const toasts: Array<{ mensaje: string; tipo: string }> = [];
vi.mock("../../shared/ToastProvider", async () => {
  const real = await vi.importActual<typeof import("../../shared/ToastProvider")>("../../shared/ToastProvider");
  return { ...real, useToast: () => ({ showToast: (mensaje: string, tipo: string) => toasts.push({ mensaje, tipo }) }) };
});

const COMPETENCIAS = [
  { id: "comp-A", name: "Competencia A", status: "open", dates: [], ageCutoffDate: "2026-12-31" },
  { id: "comp-B", name: "Competencia B", status: "open", dates: [], ageCutoffDate: "2026-12-31" },
];
const CLUBES = [
  { id: "club-1", name: "Club Uno", code: "C1", status: "active" },
  { id: "club-2", name: "Club Dos", code: "C2", status: "active" },
];

const competitionsList = vi.fn(async () => ({ items: COMPETENCIAS, total: 2, page: 1, pageSize: 100 }));
const clubsList = vi.fn(async () => ({ items: CLUBES, total: 2, page: 1, pageSize: 100 }));
const clubsGet = vi.fn(async (id: string) => CLUBES.find((c) => c.id === id)!);
const getCurrentClub = vi.fn(async (_personId: string) => ({ club: { id: "club-1", name: "Club Uno" } }) as unknown);

const listEnabledEvents = vi.fn(async (_competitionId: string) => [] as unknown[]);
const listClubSwimmers = vi.fn(async (_clubId: string) => [] as unknown[]);
const relayList = vi.fn(async (_params: { competitionId?: string; clubId?: string; status?: string; page?: number; pageSize?: number }) => ({ items: [] as unknown[], total: 0, page: 1, pageSize: 50 }));
const create = vi.fn(async (_payload: { competitionEventId?: string; clubId?: string; personIds?: string[]; seedTimeCentiseconds?: number }) => ({ id: "t-nuevo" }));
const cancel = vi.fn(async () => undefined);
const update = vi.fn(async () => undefined);

vi.mock("../competitions/competitionsApi", () => ({ useCompetitionsApi: () => ({ list: competitionsList }) }));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => ({ list: clubsList, get: clubsGet }) }));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => ({ getCurrentClub }) }));
vi.mock("../registrations/registrationsApi", () => ({
  useRegistrationsApi: () => ({ listEnabledEvents, listClubSwimmers }),
}));
vi.mock("./relayRegistrationsApi", () => ({
  useRelayRegistrationsApi: () => ({ list: relayList, create, cancel, update }),
}));

/** Una prueba de relevo habilitada, con lo mínimo que la pantalla usa. */
const PRUEBA_DE_RELEVO = {
  id: "ce-relevo",
  displayOrder: 1,
  event: {
    distance: { meters: 200 },
    stroke: { name: "Libre" },
    gender: "mixed",
    testType: { swimmersCount: 4 },
  },
  competitionSession: {
    sessionType: { name: "Mañana" },
    competitionDate: { date: "2026-03-01" },
  },
  enabledCategories: [{ category: { id: "cat", name: "Libre", minAge: 0, maxAge: 400 } }],
};

/**
 * Un nadador tal como lo devuelve `listClubSwimmers`: el contrato es
 * `EligibleSwimmer`, con `id` —no `personId`, que es el del panel individual—.
 * Equivocarlo dejaba las filas sin `key` y React avisaba por consola.
 */
function nadador(n: number) {
  return {
    id: `p${n}`,
    fullName: `Nadador ${n}`,
    run: `${n}-${n}`,
    gender: n % 2 === 0 ? "male" : "female",
    birthDate: "2000-01-01",
  };
}

beforeEach(() => {
  sesion = { ownerType: "system", clubId: null, personId: null, roles: ["admin"] };
  toasts.length = 0;
  vi.clearAllMocks();
  competitionsList.mockResolvedValue({ items: COMPETENCIAS, total: 2, page: 1, pageSize: 100 });
  clubsList.mockResolvedValue({ items: CLUBES, total: 2, page: 1, pageSize: 100 });
  clubsGet.mockImplementation(async (id: string) => CLUBES.find((c) => c.id === id)!);
  getCurrentClub.mockResolvedValue({ club: { id: "club-1", name: "Club Uno" } });
  listEnabledEvents.mockResolvedValue([]);
  listClubSwimmers.mockResolvedValue([]);
  relayList.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
});

const montar = () =>
  render(
    <MemoryRouter>
      <RelayWorkspacePage />
    </MemoryRouter>
  );

const elegir = (etiqueta: RegExp, valor: string) => {
  const select = screen.getAllByRole("combobox").find((s) => (s.previousElementSibling?.textContent ?? "").match(etiqueta))!;
  fireEvent.change(select, { target: { value: valor } });
};

const nadadorEnPlantel = (n: number) => screen.queryByText(new RegExp(`Nadador ${n}$`));

/**
 * La tarjeta de la prueba: su texto va partido entre el número en círculo y la
 * etiqueta, así que se busca por el elemento que las contiene a las dos.
 */
const seleccionarPrueba = () =>
  screen.getAllByText((_t, el) => el?.tagName === "STRONG" && (el.textContent ?? "").includes("Relevo 4x50m"))[0]!;

describe("el panel de relevos se adapta a quien lo abre", () => {
  it("ADMINISTRADOR: elige competencia y club", async () => {
    montar();

    await waitFor(() => expect(screen.getByRole("option", { name: "Competencia A" })).toBeInTheDocument());
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(await screen.findByRole("option", { name: "Club Uno" })).toBeInTheDocument();
  });

  it("CUENTA DE CLUB: sin desplegable de clubes y sin pedir los ajenos", async () => {
    sesion = { ownerType: "club", clubId: "club-2", personId: null, roles: ["club"] };
    montar();

    expect(await screen.findByText("Club Dos")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(clubsList).not.toHaveBeenCalled();
  });

  it("NADADOR sin club: lo explica", async () => {
    sesion = { ownerType: "person", clubId: null, personId: "p9", roles: ["swimmer"] };
    getCurrentClub.mockResolvedValue(null as never);
    montar();

    expect(await screen.findByText(/No tiene un club asignado/)).toBeInTheDocument();
  });
});

/**
 * CARRERA ENTRE VISTAS. Aquí el daño potencial es mayor que en el panel
 * individual: un equipo heredado de otra competencia se puede abrir para editar,
 * y el guardado usa la competencia y el club ACTUALES.
 */
describe("una respuesta atrasada no puede pintar los nadadores de otro club", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  it("cambiar de club descarta el plantel del anterior", async () => {
    const de1 = pendiente<unknown[]>();
    const de2 = pendiente<unknown[]>();
    listClubSwimmers.mockImplementation(async (clubId: string) => (clubId === "club-1" ? de1.promesa : de2.promesa));

    montar();
    await waitFor(() => expect(screen.getByRole("option", { name: "Club Uno" })).toBeInTheDocument());

    elegir(/Competencia/, "comp-A");
    elegir(/Club/, "club-1");
    await waitFor(() => expect(listClubSwimmers).toHaveBeenCalledWith("club-1"));

    elegir(/Club/, "club-2");
    await waitFor(() => expect(listClubSwimmers).toHaveBeenCalledWith("club-2"));

    // El del club 2 llega primero; el del club 1, tarde.
    await act(async () => {
      de2.resolver([nadador(8)]);
    });
    await waitFor(() => expect(nadadorEnPlantel(8)).toBeInTheDocument());

    await act(async () => {
      de1.resolver([nadador(1), nadador(2), nadador(3)]);
    });

    expect(nadadorEnPlantel(1), "el plantel del club 1 no puede aparecer bajo el club 2").not.toBeInTheDocument();
    expect(nadadorEnPlantel(8), "y el vigente sigue ahí").toBeInTheDocument();
  });

  it("el plantel anterior desaparece en cuanto se cambia de club", async () => {
    const de2 = pendiente<unknown[]>();
    listClubSwimmers.mockImplementation(async (clubId: string) =>
      clubId === "club-1" ? [nadador(1), nadador(2)] : de2.promesa
    );

    montar();
    await waitFor(() => expect(screen.getByRole("option", { name: "Club Uno" })).toBeInTheDocument());

    elegir(/Competencia/, "comp-A");
    elegir(/Club/, "club-1");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());

    elegir(/Club/, "club-2");

    expect(nadadorEnPlantel(1), "no puede quedarse el del club anterior").not.toBeInTheDocument();

    await act(async () => {
      de2.resolver([nadador(9)]);
    });
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());
  });
});

/**
 * LA PUERTA DEL EQUIPO INCOMPLETO. Un relevo son cuatro nadadores en orden; con
 * menos, la petición no tiene sentido y el backend la rechazaría.
 *
 * La versión anterior de esta prueba **no probaba nada**: buscaba el botón con
 * `queryByRole` dentro de un `if`, así que pasaba también cuando el control no
 * existía —y no existía, porque el ayudante nunca seleccionaba una prueba de
 * relevo y el armador no llegaba a abrirse—. Ahora se exige con `getByRole`, que
 * falla si no está.
 */
describe("no se puede guardar un equipo incompleto", () => {
  /**
   * Suelta un nadador en el PRIMER cupo libre. Los cupos ocupados dejan de decir
   * "Arrastre aquí", así que llamar cuatro veces los llena en orden 1→4.
   */
  function soltarEnSiguienteCupo(personId: string) {
    const cupo = screen.getAllByText("Arrastre aquí")[0]!.parentElement!;
    fireEvent.drop(cupo, {
      dataTransfer: {
        getData: (tipo: string) => (tipo === "application/x-roster-swimmer" ? personId : ""),
      },
    });
  }

  async function abrirArmador() {
    listEnabledEvents.mockResolvedValue([PRUEBA_DE_RELEVO]);
    listClubSwimmers.mockResolvedValue([1, 2, 3, 4].map(nadador));

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");
    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());

    // SELECCIONAR LA PRUEBA: sin esto el armador no se abre y no hay botón que
    // comprobar. Es lo que le faltaba a la versión anterior.
    fireEvent.click(seleccionarPrueba());
    await screen.findByRole("button", { name: /Confirmar equipo/ });
  }

  const botonConfirmar = () => screen.getByRole("button", { name: /Confirmar equipo/ });

  it("el botón EXISTE y está deshabilitado con 0, 1, 2 y 3 integrantes", async () => {
    await abrirArmador();

    expect(botonConfirmar(), "con el armador vacío").toBeDisabled();

    for (const [i, persona] of ["p1", "p2", "p3"].entries()) {
      soltarEnSiguienteCupo(persona);
      await waitFor(() => expect(screen.getAllByText("Arrastre aquí").length).toBe(3 - i));
      expect(botonConfirmar(), `con ${i + 1} integrante(s)`).toBeDisabled();
    }

    fireEvent.click(botonConfirmar());
    expect(create, "ninguna petición con el equipo a medias").not.toHaveBeenCalled();
  });

  it("con los CUATRO se habilita, y la petición lleva los cuatro en su orden", async () => {
    await abrirArmador();

    for (const persona of ["p1", "p2", "p3", "p4"]) {
      soltarEnSiguienteCupo(persona);
      await waitFor(() => expect(screen.queryAllByText("Arrastre aquí").length).toBeLessThan(4));
    }

    await waitFor(() => expect(botonConfirmar()).toBeEnabled());
    fireEvent.click(botonConfirmar());

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({
      competitionEventId: "ce-relevo",
      clubId: "club-1",
      personIds: ["p1", "p2", "p3", "p4"],
    });
  });

  it("la pantalla carga sus tres fuentes y ninguna más", async () => {
    await abrirArmador();

    expect(listEnabledEvents).toHaveBeenCalledWith("comp-A");
    expect(listClubSwimmers).toHaveBeenCalledWith("club-1");
    expect(relayList.mock.calls[0]![0]).toMatchObject({
      competitionId: "comp-A",
      clubId: "club-1",
      status: "confirmed",
    });
  });
});

/**
 * LA CARRERA QUE NO ERA DE LECTURA: una mutación antigua contra la vista nueva.
 * El manejador conserva el `loadWorkspace` de la vista donde empezó; con un
 * contador global de cargas, esa recarga vieja pasaba a ser la generación más
 * reciente y **descartaba las peticiones de la vista actual**.
 */
describe("una cancelación que empezó en otra competencia no puede vaciar la actual", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  const equipo = (id: string) => ({
    id,
    club: { id: "club-1", name: "Club Uno" },
    // `category` la usa la fila del equipo confirmado; sin ella el render lanza.
    category: { id: "cat", name: "Libre" },
    seedTimeCentiseconds: 12000,
    members: [1, 2, 3, 4].map((n, i) => ({ orderPosition: i + 1, person: { id: `p${n}`, fullName: `Nadador ${n}` } })),
    competitionEvent: {
      event: { distance: { meters: 200 }, stroke: { name: "Libre" }, gender: "mixed" },
      competitionSession: { sessionType: { name: "Mañana" }, competitionDate: { date: "2026-03-01" } },
    },
  });

  it("cancelar en A, cambiar a B y terminar A: B conserva pruebas, nadadores y equipos", async () => {
    const cancelacion = pendiente<undefined>();
    const eventosDeB = pendiente<unknown[]>();
    const nadadoresDeB = pendiente<unknown[]>();
    const equiposDeB = pendiente<{ items: unknown[]; total: number; page: number; pageSize: number }>();

    listEnabledEvents.mockImplementation(async (competitionId: string) =>
      competitionId === "comp-A" ? [PRUEBA_DE_RELEVO] : eventosDeB.promesa
    );
    listClubSwimmers.mockImplementation(async () => [1, 2, 3, 4].map(nadador));
    relayList.mockImplementation(async (params: { competitionId?: string } = {}) =>
      params.competitionId === "comp-A"
        ? { items: [equipo("t-A")], total: 1, page: 1, pageSize: 50 }
        : equiposDeB.promesa
    );
    cancel.mockReturnValue(cancelacion.promesa as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");

    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());

    // Cancelar el equipo de A, y dejarlo pendiente.
    fireEvent.click(seleccionarPrueba());
    const borrar = await screen.findByRole("button", { name: "×" });
    fireEvent.click(borrar);
    await waitFor(() => expect(cancel).toHaveBeenCalled());

    // Cambiar a B, con sus peticiones en vuelo.
    listClubSwimmers.mockImplementation(async () => nadadoresDeB.promesa as never);
    elegir(/Competencia/, "comp-B");
    await waitFor(() => expect(listEnabledEvents).toHaveBeenCalledWith("comp-B"));

    // Termina la cancelación de A: su manejador recarga la vista A.
    await act(async () => {
      cancelacion.resolver(undefined);
    });

    // Y ahora contestan las de B.
    await act(async () => {
      eventosDeB.resolver([{ ...PRUEBA_DE_RELEVO, id: "ce-B" }]);
      nadadoresDeB.resolver([nadador(9)]);
      equiposDeB.resolver({ items: [equipo("t-B")], total: 1, page: 1, pageSize: 50 });
    });

    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());
    expect(seleccionarPrueba(), "las pruebas de B").toBeInTheDocument();
    expect(screen.queryByText(/Nadador 1$/), "y nada del plantel de A").not.toBeInTheDocument();
  });
});

/**
 * EL ERROR PERTENECE A LA VISTA QUE LO PRODUJO, no al componente.
 */
describe("el error de carga no sobrevive al cambio de vista", () => {
  it("el error de A desaparece al pasar a B, y B carga limpia", async () => {
    listClubSwimmers.mockImplementation(async (clubId: string) => {
      if (clubId === "club-1") throw new Error("fallo al cargar el plantel del club 1");
      return [nadador(9)];
    });

    montar();
    await waitFor(() => expect(screen.getByRole("option", { name: "Club Uno" })).toBeInTheDocument());

    elegir(/Competencia/, "comp-A");
    elegir(/Club/, "club-1");
    expect(await screen.findByText(/fallo al cargar el plantel del club 1/)).toBeInTheDocument();

    elegir(/Club/, "club-2");

    expect(screen.queryByText(/fallo al cargar el plantel del club 1/), "no sobrevive").not.toBeInTheDocument();
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());
    expect(screen.queryByText(/fallo al cargar/)).not.toBeInTheDocument();
  });
});

/**
 * EL GUARD DE IDENTIDAD DE VISTA: una recarga de una vista abandonada no sale.
 *
 * ADVERTENCIA SOBRE EL ALCANCE. Una versión anterior presentaba esta prueba como
 * si ejercitara la ventana entre el commit y los efectos pasivos, poniendo
 * `IS_REACT_ACT_ENVIRONMENT` a `false`. **No es cierto**: el `eventWrapper` de
 * Testing Library (`@testing-library/react/dist/pure.js`, ~105-113) envuelve
 * SIEMPRE `fireEvent` en `act`, y `act-compat` repone esa bandera mientras dura.
 * Se comprobó: la prueba pasa igual con `useEffect` que con `useLayoutEffect`.
 *
 * Lo que sí demuestra es el **guard de identidad**: una cancelación que empezó en
 * la competencia A no dispara ninguna petición de A tras cambiar a B.
 * `useLayoutEffect` se conserva por el ciclo de React, no porque esta prueba lo
 * distinga; diferenciarlo queda para el E2E.
 */
describe("el guard de identidad descarta la recarga de una vista abandonada", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  const equipo = (id: string) => ({
    id,
    club: { id: "club-1", name: "Club Uno" },
    category: { id: "cat", name: "Libre" },
    seedTimeCentiseconds: 12000,
    members: [1, 2, 3, 4].map((n, i) => ({ orderPosition: i + 1, person: { id: `p${n}`, fullName: `Nadador ${n}` } })),
    competitionEvent: {
      event: { distance: { meters: 200 }, stroke: { name: "Libre" }, gender: "mixed" },
      competitionSession: { sessionType: { name: "Mañana" }, competitionDate: { date: "2026-03-01" } },
    },
  });

  it("la cancelación de A resuelta tras el cambio no dispara ninguna petición de A", async () => {
    const cancelacion = pendiente<undefined>();
    listEnabledEvents.mockImplementation(async () => [PRUEBA_DE_RELEVO]);
    listClubSwimmers.mockImplementation(async (clubId: string) => [nadador(clubId === "club-1" ? 1 : 9)]);
    relayList.mockImplementation(async (params: { competitionId?: string } = {}) =>
      params.competitionId === "comp-A"
        ? { items: [equipo("t-A")], total: 1, page: 1, pageSize: 50 }
        : { items: [], total: 0, page: 1, pageSize: 50 }
    );
    cancel.mockReturnValue(cancelacion.promesa as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");

    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
    fireEvent.click(seleccionarPrueba());

    fireEvent.click(await screen.findByRole("button", { name: "×" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));

    const llamadasConA = () => listEnabledEvents.mock.calls.filter((c) => c[0] === "comp-A").length;

    elegir(/Competencia/, "comp-B");
    await waitFor(() => expect(listEnabledEvents.mock.calls.some((c) => c[0] === "comp-B")).toBe(true));
    const antes = llamadasConA();

    await act(async () => {
      cancelacion.resolver(undefined);
    });

    expect(llamadasConA(), "la cancelación de A no puede recargar A").toBe(antes);
  });
});

describe("un error viejo no sobrevive a una carga posterior correcta", () => {
  it("club 1 falla → club 2 → volver al club 1, que ahora carga bien", async () => {
    let falla = true;
    listClubSwimmers.mockImplementation(async (clubId: string) => {
      if (clubId === "club-1" && falla) throw new Error("fallo pasajero del club 1");
      return [nadador(clubId === "club-1" ? 1 : 9)];
    });

    montar();
    await waitFor(() => expect(screen.getByRole("option", { name: "Club Uno" })).toBeInTheDocument());

    elegir(/Competencia/, "comp-A");
    elegir(/Club/, "club-1");
    expect(await screen.findByText(/fallo pasajero del club 1/)).toBeInTheDocument();

    elegir(/Club/, "club-2");
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());

    falla = false;
    elegir(/Club/, "club-1");

    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
    expect(screen.queryByText(/fallo pasajero/), "el error viejo no reaparece").not.toBeInTheDocument();
  });
});

/**
 * UNA FOTOGRAFÍA COHERENTE, O NINGUNA. Con las pruebas y los nadadores pintados
 * pero los equipos confirmados en vuelo o fallidos, el armador dejaba montar un
 * relevo sobre una prueba que **ya tenía equipo**: el backend lo rechaza por
 * unicidad, pero el usuario llega hasta el final para descubrirlo.
 */
describe("no se opera sobre una fotografía parcial", () => {
  async function montarConFuenteRota(cual: "pruebas" | "nadadores" | "equipos") {
    listEnabledEvents.mockImplementation(async () => {
      if (cual === "pruebas") throw new Error("falló la carga de las pruebas de relevo");
      return [PRUEBA_DE_RELEVO];
    });
    listClubSwimmers.mockImplementation(async () => {
      if (cual === "nadadores") throw new Error("falló la carga de los nadadores");
      return [1, 2, 3, 4].map(nadador);
    });
    relayList.mockImplementation(async () => {
      if (cual === "equipos") throw new Error("falló la carga de los equipos");
      return { items: [], total: 0, page: 1, pageSize: 50 };
    });

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");
    elegir(/Competencia/, "comp-A");
  }

  it.each(["pruebas", "nadadores", "equipos"] as const)(
    "si falla la carga de %s no se publica nada ni se puede armar un equipo",
    async (cual) => {
      await montarConFuenteRota(cual);

      expect(await screen.findByText(/falló la carga/), `el error de ${cual}`).toBeInTheDocument();

      expect(nadadorEnPlantel(1), "no se publica el plantel de una foto rota").not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Confirmar equipo/ }), "ni el armador").not.toBeInTheDocument();
      expect(screen.queryAllByText("Arrastre aquí"), "ni sus cupos").toHaveLength(0);
      expect(create, "y no sale ninguna escritura").not.toHaveBeenCalled();
    }
  );

  it("una recarga completa recupera la pantalla y borra el error", async () => {
    await montarConFuenteRota("equipos");
    await screen.findByText(/falló la carga de los equipos/);

    relayList.mockImplementation(async () => ({ items: [], total: 0, page: 1, pageSize: 50 }));
    elegir(/Competencia/, "comp-B");
    elegir(/Competencia/, "comp-A");

    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
    expect(screen.queryByText(/falló la carga/)).not.toBeInTheDocument();

    fireEvent.click(seleccionarPrueba());
    expect(await screen.findByRole("button", { name: /Confirmar equipo/ })).toBeInTheDocument();
  });
});
