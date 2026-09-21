/**
 * Hallazgo 31, frente 6 — PANEL DE INSCRIPCIÓN.
 *
 * La pantalla tenía 0 % de cobertura, y es donde vive la operación central del
 * producto. Lo que se prueba aquí es lo que **le toca al frontend**: qué se pide
 * al servidor y cuándo, cómo se adapta a quien mira, qué escrituras se detienen
 * antes de salir, y qué pasa cuando una respuesta llega tarde. Las reglas de
 * negocio —cupos, categorías, elegibilidad— son del backend y allí se prueban;
 * repetirlas aquí solo daría porcentaje.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RegistrationWorkspacePage } from "./RegistrationWorkspacePage";

// --- Sesión, configurable por prueba ---------------------------------------
type Sesion = {
  ownerType: string;
  clubId: string | null;
  personId: string | null;
  roles: string[];
};
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

interface ToastCapturado {
  mensaje: string;
  tipo: string;
  accion?: { label: string; onClick: () => void };
}
const toasts: ToastCapturado[] = [];
vi.mock("../../shared/ToastProvider", async () => {
  const real = await vi.importActual<typeof import("../../shared/ToastProvider")>("../../shared/ToastProvider");
  return {
    ...real,
    useToast: () => ({
      // Se captura también la ACCIÓN del aviso: el «Deshacer» vive ahí, y sin
      // guardarla no se puede probar qué hace al pulsarlo.
      showToast: (mensaje: string, tipo: string, accion?: { label: string; onClick: () => void }) =>
        toasts.push({ mensaje, tipo, accion }),
    }),
  };
});

// --- Servidores de mentira --------------------------------------------------
const COMPETENCIAS = [
  { id: "comp-A", name: "Competencia A", status: "open", dates: [] },
  { id: "comp-B", name: "Competencia B", status: "open", dates: [] },
];
const CLUBES = [
  { id: "club-1", name: "Club Uno", code: "C1", status: "active" },
  { id: "club-2", name: "Club Dos", code: "C2", status: "active" },
];

const competitionsList = vi.fn(async () => ({ items: COMPETENCIAS, total: COMPETENCIAS.length, page: 1, pageSize: 100 }));
const clubsList = vi.fn(async () => ({ items: CLUBES, total: CLUBES.length, page: 1, pageSize: 100 }));
const clubsGet = vi.fn(async (id: string) => CLUBES.find((c) => c.id === id)!);
const getCurrentClub = vi.fn(async (_personId: string) => ({ club: { id: "club-1", name: "Club Uno" } }) as unknown);

const listEnabledEvents = vi.fn(async (_competitionId: string) => [] as unknown[]);
const listClubEligibilityMatrix = vi.fn(async (_competitionId: string, _clubId: string) => [] as unknown[]);
const registrationsList = vi.fn(async () => ({ items: [] as unknown[], total: 0, page: 1, pageSize: 50 }));
const create = vi.fn(async () => ({ id: "r-nueva" }));
const cancel = vi.fn(async () => undefined);
const update = vi.fn(async () => undefined);

vi.mock("../competitions/competitionsApi", () => ({ useCompetitionsApi: () => ({ list: competitionsList }) }));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => ({ list: clubsList, get: clubsGet }) }));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => ({ getCurrentClub }) }));
vi.mock("./registrationsApi", () => ({
  useRegistrationsApi: () => ({
    listEnabledEvents,
    listClubEligibilityMatrix,
    list: registrationsList,
    create,
    cancel,
    update,
  }),
}));

/** Un nadador elegible, con lo mínimo que la pantalla usa de él. */
function nadador(n: number) {
  return {
    personId: `p${n}`,
    fullName: `Nadador ${n}`,
    run: `${n}-${n}`,
    registeredEventIds: [] as string[],
    eligibleEvents: [] as unknown[],
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
  listClubEligibilityMatrix.mockResolvedValue([]);
  registrationsList.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
  // `clearAllMocks` borra las llamadas pero NO las implementaciones: sin esto, un
  // `mockReturnValue` de una prueba anterior seguía vivo en la siguiente.
  create.mockResolvedValue({ id: "r-nueva" });
  cancel.mockResolvedValue(undefined);
  update.mockResolvedValue(undefined);
});

const montar = () =>
  render(
    <MemoryRouter>
      <RegistrationWorkspacePage />
    </MemoryRouter>
  );

const elegir = (etiqueta: RegExp, valor: string) => {
  const select = screen.getAllByRole("combobox").find((s) => (s.previousElementSibling?.textContent ?? "").match(etiqueta))!;
  fireEvent.change(select, { target: { value: valor } });
};

/** Lee un contador de la barra de resumen: «Nadadores: 7» → "7". */
const contador = (etiqueta: string) =>
  (screen.getByText(new RegExp(`^${etiqueta}:`)).textContent ?? "").replace(`${etiqueta}:`, "").trim();

/** El nombre va dentro de un `span` con un icono delante, así que no es exacto. */
/**
 * El nombre del nadador puede aparecer DOS veces: en el plantel de la izquierda y
 * en la fila de una inscripción ya confirmada. `queryByText` lanza con varias
 * coincidencias, así que se toma la primera.
 */
const nadadorEnPlantel = (n: number) => screen.queryAllByText(new RegExp(`Nadador ${n}$`))[0] ?? null;

/**
 * QUIÉN MIRA DECIDE QUÉ SE VE. No es cosmética: si un delegado recibiera el
 * desplegable de clubes, la pantalla le ofrecería operar sobre planteles ajenos
 * —el servidor lo rechazaría con un 403, pero el usuario habría llegado hasta
 * ahí—. Y si un administrador lo perdiera, no podría trabajar.
 */
describe("el panel se adapta a quien lo abre", () => {
  it("ADMINISTRADOR: elige competencia y club de sendos desplegables", async () => {
    montar();

    await waitFor(() => expect(screen.getByRole("option", { name: "Competencia A" })).toBeInTheDocument());
    expect(screen.getAllByRole("combobox"), "dos desplegables: competencia y club").toHaveLength(2);
    expect(await screen.findByRole("option", { name: "Club Uno" })).toBeInTheDocument();
    expect(clubsList, "pide la lista de clubes").toHaveBeenCalled();
  });

  it("CUENTA DE CLUB o delegado: sin desplegable de clubes, y acotado al suyo", async () => {
    sesion = { ownerType: "club", clubId: "club-2", personId: null, roles: ["club"] };
    montar();

    expect(await screen.findByText("Club Dos")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox"), "solo el de competencia").toHaveLength(1);
    expect(clubsList, "ni siquiera pide la lista de clubes ajenos").not.toHaveBeenCalled();
    expect(clubsGet).toHaveBeenCalledWith("club-2");
  });

  it("NADADOR sin club asignado: lo explica en vez de dejar la pantalla muda", async () => {
    sesion = { ownerType: "person", clubId: null, personId: "p9", roles: ["swimmer"] };
    getCurrentClub.mockResolvedValue(null as never);
    montar();

    expect(await screen.findByText(/No tiene un club asignado/)).toBeInTheDocument();
    expect(screen.getByText("Sin club asignado")).toBeInTheDocument();
  });

  it("NADADOR con club: queda acotado a él sin poder elegir otro", async () => {
    sesion = { ownerType: "person", clubId: null, personId: "p9", roles: ["swimmer"] };
    montar();

    expect(await screen.findByText("Club Uno")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(getCurrentClub).toHaveBeenCalledWith("p9");
  });
});

describe("no se carga nada hasta tener competencia Y club", () => {
  it("con solo el club elegido no se pide el plantel", async () => {
    sesion = { ownerType: "club", clubId: "club-2", personId: null, roles: ["club"] };
    montar();

    await screen.findByText("Club Dos");
    expect(screen.getByText(/Elija una competencia y un club/)).toBeInTheDocument();
    expect(listClubEligibilityMatrix).not.toHaveBeenCalled();
    expect(listEnabledEvents).not.toHaveBeenCalled();
  });
});

/**
 * CARRERA ENTRE COMPETENCIAS. `loadWorkspace` lanza tres peticiones y aplica lo
 * que llegue, sin comprobar si sigue siendo la vista vigente. Cambiar de
 * competencia con una carga en vuelo deja que la respuesta vieja pinte el plantel
 * de la competencia anterior bajo el rótulo de la nueva — y los botones de
 * inscripción operarían sobre lo que se ve, que no es lo que se pidió.
 */
describe("una respuesta atrasada no puede pintar el plantel de otra competencia", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  it("cambiar de competencia descarta lo que llegue de la anterior", async () => {
    const deA = pendiente<unknown[]>();
    const deB = pendiente<unknown[]>();
    listClubEligibilityMatrix.mockImplementation(async (competitionId: string) =>
      competitionId === "comp-A" ? deA.promesa : deB.promesa
    );

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");

    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(listClubEligibilityMatrix).toHaveBeenCalledWith("comp-A", "club-1"));

    elegir(/Competencia/, "comp-B");
    await waitFor(() => expect(listClubEligibilityMatrix).toHaveBeenCalledWith("comp-B", "club-1"));

    // Llega, tarde, el plantel de la competencia A: siete nadadores.
    await act(async () => {
      deA.resolver([1, 2, 3, 4, 5, 6, 7].map(nadador));
    });

    expect(nadadorEnPlantel(7), "nada de la competencia A").not.toBeInTheDocument();
    expect(contador("Nadadores"), "ni su recuento").not.toBe("7");

    // Y cuando llega la de B, esa sí se pinta.
    await act(async () => {
      deB.resolver([nadador(8), nadador(9)]);
    });
    await waitFor(() => expect(nadadorEnPlantel(8)).toBeInTheDocument());
    expect(contador("Nadadores")).toBe("2");
  });

  it("cambiar de competencia descarta también las INSCRIPCIONES atrasadas", async () => {
    const deA = pendiente<{ items: unknown[]; total: number; page: number; pageSize: number }>();
    const deB = pendiente<{ items: unknown[]; total: number; page: number; pageSize: number }>();
    registrationsList.mockImplementation(async (params: { competitionId?: string } = {}) =>
      params.competitionId === "comp-A" ? deA.promesa : deB.promesa
    );

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");

    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(registrationsList).toHaveBeenCalled());
    elegir(/Competencia/, "comp-B");

    const inscripciones = (cuantas: number) => ({
      items: Array.from({ length: cuantas }, (_, i) => ({ id: `r${i}`, competitionEvent: null })),
      total: cuantas,
      page: 1,
      pageSize: 50,
    });

    // La de B llega primero; la de A, después. Es el orden que importa: si la
    // atrasada se aplicara, pisaría a la vigente.
    await act(async () => {
      deB.resolver(inscripciones(1));
    });
    await waitFor(() => expect(contador("Inscripciones")).toBe("1"));

    await act(async () => {
      deA.resolver(inscripciones(5));
    });
    expect(contador("Inscripciones"), "la de A no puede pisar a la de B").toBe("1");
  });
});

/**
 * Y LA OTRA MITAD: mientras la competencia nueva carga, lo que se ve no puede ser
 * el plantel de la anterior. No es solo estética — los botones de inscripción
 * operan con la competencia y el club ACTUALES, así que un clic sobre una fila
 * heredada inscribiría a alguien en una competencia que no es la suya.
 */
describe("mientras la vista nueva carga no se muestra el plantel de la anterior", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  it("el plantel de A desaparece en cuanto se elige B", async () => {
    const deB = pendiente<unknown[]>();
    listClubEligibilityMatrix.mockImplementation(async (competitionId: string) =>
      competitionId === "comp-A" ? [nadador(1), nadador(2), nadador(3)] : deB.promesa
    );

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");

    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
    expect(contador("Nadadores")).toBe("3");

    elegir(/Competencia/, "comp-B");

    expect(nadadorEnPlantel(1), "el plantel de A no puede quedarse bajo B").not.toBeInTheDocument();
    expect(contador("Nadadores"), "ni su recuento").toBe("0");

    await act(async () => {
      deB.resolver([nadador(9)]);
    });
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());
  });
});

/**
 * ESCRITURAS QUE NO DEBEN SALIR. El tiempo estimado es obligatorio y tiene
 * formato; validarlo en el cliente evita un viaje y un error del servidor, pero
 * lo que de verdad importa es que la petición **no se envíe**: una inscripción a
 * medias es un registro que alguien tendrá que corregir a mano.
 */
describe("el tiempo se valida ANTES de enviar la inscripción", () => {
  async function prepararConNadadorYPrueba() {
    listEnabledEvents.mockResolvedValue([
      {
        id: "ce-1",
        displayOrder: 1,
        event: {
          distance: { meters: 50 },
          stroke: { name: "Libre" },
          gender: "mixed",
          testType: { swimmersCount: 1 },
        },
        competitionSession: {
          sessionType: { name: "Mañana" },
          competitionDate: { date: "2026-03-01" },
        },
      },
    ]);
    listClubEligibilityMatrix.mockResolvedValue([
      { ...nadador(1), eligibleEvents: [{ competitionEventId: "ce-1" }] },
    ]);

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");
    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
    fireEvent.click(nadadorEnPlantel(1)!);
  }

  it("sin tiempo: avisa y NO llama al API", async () => {
    await prepararConNadadorYPrueba();

    const inscribir = await screen.findByRole("button", { name: "Inscribir" });
    fireEvent.click(inscribir);

    await waitFor(() => expect(toasts.some((t) => /Debe ingresar el tiempo/.test(t.mensaje))).toBe(true));
    expect(create, "no se envía una inscripción sin tiempo").not.toHaveBeenCalled();
  });

  it("con un tiempo ilegible: avisa y NO llama al API", async () => {
    await prepararConNadadorYPrueba();

    fireEvent.change(document.getElementById("time-input-ce-1")!, { target: { value: "no-es-un-tiempo" } });
    fireEvent.click(await screen.findByRole("button", { name: "Inscribir" }));

    await waitFor(() => expect(toasts.some((t) => t.tipo === "error")).toBe(true));
    expect(create).not.toHaveBeenCalled();
  });
});

/**
 * LA CARRERA QUE NO ERA DE LECTURA: UNA MUTACIÓN ANTIGUA CONTRA LA VISTA NUEVA.
 *
 * Un manejador de escritura conserva el `loadWorkspace` de la vista donde empezó.
 * Si se inscribe en A, se cambia a B y la inscripción termina después, ese
 * manejador dispara una recarga **de A**. Con un contador global de cargas, esa
 * recarga vieja pasa a ser la generación más reciente y **descarta las peticiones
 * de B que aún viajaban**: B se queda vacía, sin pruebas, sin plantel y sin
 * inscripciones, y sin ningún error que lo explique.
 */
describe("una mutación que empezó en otra competencia no puede vaciar la actual", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  const PRUEBA = {
    id: "ce-1",
    displayOrder: 1,
    event: { distance: { meters: 50 }, stroke: { name: "Libre" }, gender: "mixed", testType: { swimmersCount: 1 } },
    competitionSession: { sessionType: { name: "Mañana" }, competitionDate: { date: "2026-03-01" } },
  };

  it("crear en A, cambiar a B y terminar A: B conserva pruebas, plantel e inscripciones", async () => {
    const creacion = pendiente<{ id: string }>();
    const eventosDeB = pendiente<unknown[]>();
    const plantelDeB = pendiente<unknown[]>();
    const inscripcionesDeB = pendiente<{ items: unknown[]; total: number; page: number; pageSize: number }>();

    listEnabledEvents.mockImplementation(async (competitionId: string) =>
      competitionId === "comp-A" ? [PRUEBA] : eventosDeB.promesa
    );
    listClubEligibilityMatrix.mockImplementation(async (competitionId: string) =>
      competitionId === "comp-A"
        ? [{ ...nadador(1), eligibleEvents: [{ competitionEventId: "ce-1" }] }]
        : plantelDeB.promesa
    );
    registrationsList.mockImplementation(async (params: { competitionId?: string } = {}) =>
      params.competitionId === "comp-A"
        ? { items: [], total: 0, page: 1, pageSize: 50 }
        : inscripcionesDeB.promesa
    );
    create.mockReturnValue(creacion.promesa as never);

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");

    // 1) La vista A, cargada del todo.
    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());

    // 2) Una inscripción en A, que queda pendiente.
    fireEvent.click(nadadorEnPlantel(1)!);
    fireEvent.change(document.getElementById("time-input-ce-1")!, { target: { value: "003045" } });
    fireEvent.click(await screen.findByRole("button", { name: "Inscribir" }));
    await waitFor(() => expect(create).toHaveBeenCalled());

    // 3) Se cambia a B, cuyas tres peticiones quedan en vuelo.
    elegir(/Competencia/, "comp-B");
    await waitFor(() => expect(listEnabledEvents).toHaveBeenCalledWith("comp-B"));

    // 4) Termina la inscripción de A: su manejador recarga la vista A.
    await act(async () => {
      creacion.resolver({ id: "r-nueva" });
    });

    // 5) Y ahora contestan las peticiones de B.
    await act(async () => {
      eventosDeB.resolver([{ ...PRUEBA, id: "ce-B", displayOrder: 7 }]);
      plantelDeB.resolver([nadador(9)]);
      inscripcionesDeB.resolver({
        items: [
          {
            id: "rB",
            person: { id: "p9", fullName: "Nadador 9", run: "9-9" },
            seedTimeCentiseconds: 3045,
            // Una prueba distinta de la que B muestra: no debe emparejarse.
            competitionEvent: {
              event: { distance: { meters: 100 }, stroke: { name: "Espalda" }, gender: "mixed" },
              competitionSession: { sessionType: { name: "Tarde" }, competitionDate: { date: "2026-03-02" } },
            },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
      });
    });

    // B tiene que estar completa: la recarga de A no puede haberla invalidado.
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());
    expect(contador("Nadadores"), "el plantel de B").toBe("1");
    expect(contador("Pruebas"), "las pruebas de B").toBe("1");
    expect(contador("Inscripciones"), "las inscripciones de B").toBe("1");
  });
});

/**
 * EL ERROR ES DE UNA VISTA, NO DEL COMPONENTE.
 *
 * `error` era una sola cadena para toda la pantalla. Un fallo al cargar la
 * competencia A seguía visible al pasar a la B aunque B cargara perfectamente, y
 * un fallo atrasado de A podía aparecer sobre una B correcta. En una pantalla que
 * decide inscripciones, un mensaje rojo que no corresponde a lo que se está
 * mirando es peor que ninguno.
 */
describe("el error de carga pertenece a la vista que lo produjo", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    let rechazar!: (e: unknown) => void;
    const promesa = new Promise<T>((res, rej) => {
      resolver = res;
      rechazar = rej;
    });
    return { promesa, resolver, rechazar };
  }

  it("al cambiar de competencia, el error de la anterior desaparece de inmediato", async () => {
    listClubEligibilityMatrix.mockImplementation(async (competitionId: string) => {
      if (competitionId === "comp-A") throw new Error("fallo al calcular la elegibilidad de A");
      return [nadador(9)];
    });

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");

    elegir(/Competencia/, "comp-A");
    expect(await screen.findByText(/fallo al calcular la elegibilidad de A/)).toBeInTheDocument();

    elegir(/Competencia/, "comp-B");

    expect(
      screen.queryByText(/fallo al calcular la elegibilidad de A/),
      "el error de A no puede sobrevivir al cambio"
    ).not.toBeInTheDocument();

    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());
    expect(screen.queryByText(/fallo al calcular/), "y B carga limpia").not.toBeInTheDocument();
  });

  it("un error ATRASADO de A tampoco puede aparecer sobre B", async () => {
    const deA = pendiente<unknown[]>();
    listClubEligibilityMatrix.mockImplementation(async (competitionId: string) =>
      competitionId === "comp-A" ? deA.promesa : [nadador(9)]
    );

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");

    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(listClubEligibilityMatrix).toHaveBeenCalledWith("comp-A", "club-1"));

    elegir(/Competencia/, "comp-B");
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());

    await act(async () => {
      deA.rechazar(new Error("fallo tardío de A"));
    });

    expect(screen.queryByText(/fallo tardío de A/), "no es un error de esta vista").not.toBeInTheDocument();
    expect(nadadorEnPlantel(9), "y B sigue entera").toBeInTheDocument();
  });
});

/**
 * EL GUARD DE IDENTIDAD DE VISTA: una recarga de una vista abandonada no sale.
 *
 * ADVERTENCIA SOBRE EL ALCANCE DE ESTA PRUEBA. Una versión anterior la presentaba
 * como si ejercitara la ventana entre el commit y los efectos pasivos, poniendo
 * `IS_REACT_ACT_ENVIRONMENT` a `false`. **No es cierto**: el `eventWrapper` de
 * Testing Library (`@testing-library/react/dist/pure.js`, ~105-113) envuelve
 * SIEMPRE `fireEvent` en `act`, y `act-compat` vuelve a poner esa bandera en
 * `true` mientras dura. La ventana real no se abre aquí, y se comprobó: la prueba
 * pasa igual con `useEffect` que con `useLayoutEffect`.
 *
 * Lo que sí demuestra —y no es poco— es el **guard de identidad**: una mutación
 * que empezó en la competencia A no dispara ninguna petición de A después de
 * cambiar a B. Retirando ese guard, esta prueba falla.
 *
 * `useLayoutEffect` se conserva por el ciclo de React —registrar la identidad
 * dentro del commit, antes de ceder el control—, no porque esta prueba lo
 * distinga. Diferenciarlo exigiría un navegador de verdad; queda para el E2E.
 */
describe("el guard de identidad descarta la recarga de una vista abandonada", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  const PRUEBA = {
    id: "ce-1",
    displayOrder: 1,
    event: { distance: { meters: 50 }, stroke: { name: "Libre" }, gender: "mixed", testType: { swimmersCount: 1 } },
    competitionSession: { sessionType: { name: "Mañana" }, competitionDate: { date: "2026-03-01" } },
  };

  it("la mutación de A resuelta tras el cambio no dispara ninguna petición de A", async () => {
    const creacion = pendiente<{ id: string }>();
    listEnabledEvents.mockImplementation(async () => [PRUEBA]);
    listClubEligibilityMatrix.mockImplementation(async (competitionId: string) => [
      { ...nadador(competitionId === "comp-A" ? 1 : 9), eligibleEvents: [{ competitionEventId: "ce-1" }] },
    ]);
    create.mockReturnValue(creacion.promesa as never);

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");

    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());

    // Una inscripción en A, que queda pendiente.
    fireEvent.click(nadadorEnPlantel(1)!);
    fireEvent.change(document.getElementById("time-input-ce-1")!, { target: { value: "003045" } });
    fireEvent.click(await screen.findByRole("button", { name: "Inscribir" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    const llamadasConA = () => listEnabledEvents.mock.calls.filter((c) => c[0] === "comp-A").length;

    elegir(/Competencia/, "comp-B");
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());
    const antes = llamadasConA();

    // Y AHORA termina la creación que empezó en A.
    await act(async () => {
      creacion.resolver({ id: "r-nueva" });
    });

    expect(llamadasConA(), "la mutación de A no puede recargar A").toBe(antes);
    expect(nadadorEnPlantel(9), "y B sigue entera").toBeInTheDocument();
    expect(nadadorEnPlantel(1), "sin nada del plantel de A").not.toBeInTheDocument();
  });
});

/**
 * DESHACER, CON IDENTIDAD DE VISTA.
 *
 * `lastUndoRef` guardaba una función suelta: crear en A, cambiar a B y pulsar
 * Ctrl+Z —o el «Deshacer» del aviso, que sigue en pantalla— cancelaba la
 * inscripción de A mientras se miraba la B. Y sin cerrojo, dos pulsaciones
 * mandaban dos cancelaciones del mismo registro.
 */
describe("deshacer la última inscripción", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  const PRUEBA = {
    id: "ce-1",
    displayOrder: 1,
    event: { distance: { meters: 50 }, stroke: { name: "Libre" }, gender: "mixed", testType: { swimmersCount: 1 } },
    competitionSession: { sessionType: { name: "Mañana" }, competitionDate: { date: "2026-03-01" } },
  };

  /** Deja una inscripción recién creada en la competencia A, lista para deshacer. */
  async function inscribirEnA() {
    listEnabledEvents.mockImplementation(async () => [PRUEBA]);
    listClubEligibilityMatrix.mockImplementation(async (competitionId: string) => [
      { ...nadador(competitionId === "comp-A" ? 1 : 9), eligibleEvents: [{ competitionEventId: "ce-1" }] },
    ]);

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");
    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());

    fireEvent.click(nadadorEnPlantel(1)!);
    fireEvent.change(document.getElementById("time-input-ce-1")!, { target: { value: "003045" } });
    fireEvent.click(await screen.findByRole("button", { name: "Inscribir" }));
    await waitFor(() => expect(toasts.some((t) => t.accion?.label === "Deshacer")).toBe(true));
  }

  const accionDeshacer = () => toasts.find((t) => t.accion?.label === "Deshacer")!.accion!;
  /** El atajo dispara trabajo asíncrono: va envuelto en `act` para no dejar
   *  actualizaciones fuera de él —y sin avisos de React en la salida—. */
  const pulsarCtrlZ = async () => {
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });
  };

  it("crear en A, cambiar a B y pulsar Ctrl+Z: NO se cancela nada", async () => {
    /**
     * Esta prueba exigía antes el aviso «ya no corresponde a lo que está viendo»,
     * que era el síntoma de una referencia ÚNICA: el teclado recogía la acción de
     * A estando en B y había que rechazarla al comprobar la vista.
     *
     * Con la autoridad por vista el teclado ya no la recoge siquiera —consulta la
     * entrada de la vista vigente, que en B está vacía—, así que no hay nada que
     * rechazar ni mensaje que dar. La propiedad que importa es la misma y se
     * comprueba igual: desde B no se cancela lo de A.
     */
    await inscribirEnA();

    elegir(/Competencia/, "comp-B");
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());

    await pulsarCtrlZ();

    expect(cancel, "la inscripción de A no se toca desde B").not.toHaveBeenCalled();

    // Y sigue disponible al volver: la acción de A no se perdió.
    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
    await pulsarCtrlZ();
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it("lo mismo desde la ACCIÓN del aviso, que sigue en pantalla", async () => {
    await inscribirEnA();

    elegir(/Competencia/, "comp-B");
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());

    await act(async () => {
      accionDeshacer().onClick();
    });

    expect(cancel).not.toHaveBeenCalled();
  });

  it("dos activaciones rápidas producen UNA sola cancelación", async () => {
    await inscribirEnA();

    const cancelacion = pendiente<undefined>();
    cancel.mockReturnValue(cancelacion.promesa as never);

    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      accionDeshacer().onClick();
    });
    await waitFor(() => expect(cancel).toHaveBeenCalled());

    expect(cancel, "el cerrojo serializa las activaciones").toHaveBeenCalledTimes(1);

    await act(async () => {
      cancelacion.resolver(undefined);
    });
  });

  it("en su propia vista SÍ deshace, y deja una fotografía coherente", async () => {
    await inscribirEnA();
    const cargasAntes = listEnabledEvents.mock.calls.length;

    await act(async () => {
      accionDeshacer().onClick();
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toasts.some((t) => /Inscripción deshecha/.test(t.mensaje))).toBe(true));

    // Y la vista se recarga entera: la fotografía vuelve a estar completa.
    await waitFor(() => expect(listEnabledEvents.mock.calls.length).toBeGreaterThan(cargasAntes));
    // El nadador sigue seleccionado desde la inscripción, así que el control de
    // inscribir sigue en pantalla: lo que se comprueba es que vuelve a estar
    // OPERABLE, es decir, que la fotografía se completó.
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Inscribir" })).toBeEnabled());

    // Y un segundo intento ya no tiene nada que deshacer.
    cancel.mockClear();
    await pulsarCtrlZ();
    expect(cancel, "la acción se consumió").not.toHaveBeenCalled();
  });
});

/**
 * EL ERROR NO SE QUEDA GUARDADO. Vivía en un estado aparte que nadie limpiaba:
 * volver a una competencia que había fallado la mostraba en rojo aunque cargara
 * perfectamente. Ahora el error vive DENTRO de la fotografía, así que publicar una
 * nueva lo sustituye.
 */
describe("un error viejo no sobrevive a una carga posterior correcta", () => {
  it("A falla → B → volver a A, que ahora carga bien: el error ya no está", async () => {
    let fallaA = true;
    listClubEligibilityMatrix.mockImplementation(async (competitionId: string) => {
      if (competitionId === "comp-A" && fallaA) throw new Error("fallo pasajero de A");
      return [nadador(competitionId === "comp-A" ? 1 : 9)];
    });

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");

    elegir(/Competencia/, "comp-A");
    expect(await screen.findByText(/fallo pasajero de A/)).toBeInTheDocument();

    elegir(/Competencia/, "comp-B");
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());

    // A ya funciona; se vuelve.
    fallaA = false;
    elegir(/Competencia/, "comp-A");

    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
    expect(screen.queryByText(/fallo pasajero de A/), "el error viejo no puede reaparecer").not.toBeInTheDocument();
  });
});

/**
 * UNA FOTOGRAFÍA COHERENTE, O NINGUNA.
 *
 * Las tres fuentes se publicaban por separado. Con las pruebas y el plantel ya
 * pintados y las inscripciones aún en vuelo —o fallidas—, el botón «Inscribir»
 * estaba disponible sobre una lista de «ya inscrito» incompleta: inscribir ahí
 * duplica una inscripción que existe pero que la pantalla no conoce.
 */
describe("no se opera sobre una fotografía parcial", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    let rechazar!: (e: unknown) => void;
    const promesa = new Promise<T>((res, rej) => {
      resolver = res;
      rechazar = rej;
    });
    return { promesa, resolver, rechazar };
  }

  const PRUEBA = {
    id: "ce-1",
    displayOrder: 1,
    event: { distance: { meters: 50 }, stroke: { name: "Libre" }, gender: "mixed", testType: { swimmersCount: 1 } },
    competitionSession: { sessionType: { name: "Mañana" }, competitionDate: { date: "2026-03-01" } },
  };
  const PLANTEL = [{ ...nadador(1), eligibleEvents: [{ competitionEventId: "ce-1" }] }];

  async function montarConFuenteRota(cual: "pruebas" | "plantel" | "inscripciones") {
    listEnabledEvents.mockImplementation(async () => {
      if (cual === "pruebas") throw new Error("falló la carga de PRUEBAS");
      return [PRUEBA];
    });
    listClubEligibilityMatrix.mockImplementation(async () => {
      if (cual === "plantel") throw new Error("falló la carga del PLANTEL");
      return PLANTEL;
    });
    registrationsList.mockImplementation(async () => {
      if (cual === "inscripciones") throw new Error("falló la carga de INSCRIPCIONES");
      return { items: [], total: 0, page: 1, pageSize: 50 };
    });

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");
    elegir(/Competencia/, "comp-A");
  }

  it.each(["pruebas", "plantel", "inscripciones"] as const)(
    "si falla la carga de %s no se publica nada ni se puede operar",
    async (cual) => {
      await montarConFuenteRota(cual);

      expect(await screen.findByText(/falló la carga/), `el error de ${cual}`).toBeInTheDocument();

      // Ni una fila de las fuentes que SÍ llegaron.
      expect(nadadorEnPlantel(1), "no se publica el plantel de una foto rota").not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Inscribir" }), "ni el control de inscribir").not.toBeInTheDocument();
      expect(contador("Nadadores")).toBe("0");
      expect(contador("Pruebas")).toBe("0");
      expect(contador("Inscripciones")).toBe("0");
      expect(create, "y no sale ninguna escritura").not.toHaveBeenCalled();
    }
  );

  it("una recarga completa recupera la pantalla y borra el error", async () => {
    await montarConFuenteRota("inscripciones");
    await screen.findByText(/falló la carga de INSCRIPCIONES/);

    // El servidor se recupera y se vuelve a entrar en la competencia.
    registrationsList.mockImplementation(async () => ({ items: [], total: 0, page: 1, pageSize: 50 }));
    elegir(/Competencia/, "comp-B");
    elegir(/Competencia/, "comp-A");

    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
    expect(screen.queryByText(/falló la carga/), "el error se fue con la foto nueva").not.toBeInTheDocument();
    fireEvent.click(nadadorEnPlantel(1)!);
    expect(await screen.findByRole("button", { name: "Inscribir" })).toBeEnabled();
  });

  it("durante una RECARGA los datos anteriores quedan en solo lectura", async () => {
    const recarga = pendiente<{ items: unknown[]; total: number; page: number; pageSize: number }>();
    listEnabledEvents.mockImplementation(async () => [PRUEBA]);
    listClubEligibilityMatrix.mockImplementation(async () => PLANTEL);
    registrationsList.mockImplementation(async () => ({ items: [], total: 0, page: 1, pageSize: 50 }));

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");
    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());

    fireEvent.click(nadadorEnPlantel(1)!);
    fireEvent.change(document.getElementById("time-input-ce-1")!, { target: { value: "003045" } });

    // La inscripción termina y dispara una recarga que se queda a medias.
    registrationsList.mockReturnValue(recarga.promesa as never);
    fireEvent.click(await screen.findByRole("button", { name: "Inscribir" }));
    await waitFor(() => expect(create).toHaveBeenCalled());

    // Los datos anteriores siguen visibles, pero no se puede operar con ellos.
    await waitFor(() => expect(screen.getByRole("button", { name: "Inscribir" })).toBeDisabled());
    expect(nadadorEnPlantel(1), "no se vacía la pantalla en cada guardado").toBeInTheDocument();

    await act(async () => {
      recarga.resolver({ items: [], total: 0, page: 1, pageSize: 50 });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Inscribir" })).toBeEnabled());
  });
});

/**
 * IDENTIDAD DE CADA DESHACER, EXTREMO A EXTREMO.
 *
 * Los avisos con acción duran seis segundos, así que dos inscripciones seguidas
 * dejan **dos avisos vivos a la vez**. Con la función leyendo `deshacerRef.current`
 * en el momento de la pulsación, tocar el aviso de la primera cancelaba la
 * segunda: la inscripción equivocada, y sin que nada lo delatara.
 */
describe("cada aviso conserva su identidad y nunca deshace otra inscripción", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  const PRUEBA = {
    id: "ce-1",
    displayOrder: 1,
    event: { distance: { meters: 50 }, stroke: { name: "Libre" }, gender: "mixed", testType: { swimmersCount: 1 } },
    competitionSession: { sessionType: { name: "Mañana" }, competitionDate: { date: "2026-03-01" } },
  };

  async function inscribirEnA(idPrimera: string) {
    listEnabledEvents.mockImplementation(async () => [PRUEBA]);
    listClubEligibilityMatrix.mockImplementation(async () => [
      { ...nadador(1), eligibleEvents: [{ competitionEventId: "ce-1" }] },
    ]);
    create.mockResolvedValueOnce({ id: idPrimera });

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");
    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());

    fireEvent.click(nadadorEnPlantel(1)!);
    fireEvent.change(document.getElementById("time-input-ce-1")!, { target: { value: "003045" } });
    fireEvent.click(await screen.findByRole("button", { name: "Inscribir" }));
    await waitFor(() => expect(toasts.some((t) => t.accion?.label === "Deshacer")).toBe(true));
  }

  const accionesDeshacer = () => toasts.filter((t) => t.accion?.label === "Deshacer").map((t) => t.accion!);

  async function inscribirOtraVez(id: string) {
    create.mockResolvedValueOnce({ id });
    const antes = accionesDeshacer().length;
    fireEvent.change(document.getElementById("time-input-ce-1")!, { target: { value: "003100" } });
    fireEvent.click(screen.getByRole("button", { name: "Inscribir" }));
    await waitFor(() => expect(accionesDeshacer().length).toBe(antes + 1));
  }

  it("dos inscripciones: pulsar el aviso de la PRIMERA no cancela la segunda", async () => {
    await inscribirEnA("r1");
    await inscribirOtraVez("r2");

    const [avisoDeR1, avisoDeR2] = accionesDeshacer();
    expect(avisoDeR1, "los dos avisos coexisten").toBeDefined();
    expect(avisoDeR2).toBeDefined();

    await act(async () => {
      avisoDeR1!.onClick();
    });

    expect(cancel, "el aviso viejo no acciona nada").not.toHaveBeenCalled();
    expect(toasts.some((t) => /ya no está disponible/.test(t.mensaje))).toBe(true);

    // Y el aviso vigente sí deshace lo suyo.
    await act(async () => {
      avisoDeR2!.onClick();
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("r2");
  });

  it("deshacer r1 en vuelo + crear r2: al resolver r1 la acción de r2 SIGUE viva", async () => {
    const cancelacionDeR1 = pendiente<undefined>();

    await inscribirEnA("r1");
    const [avisoDeR1] = accionesDeshacer();

    cancel.mockReturnValueOnce(cancelacionDeR1.promesa as never);
    // Envuelto en `act`: el manejador actualiza estado antes de quedarse esperando
    // al servidor, y sin esto React avisa por consola.
    await act(async () => {
      avisoDeR1!.onClick();
    });
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("r1"));

    // Mientras esa cancelación viaja, se crea otra inscripción.
    await inscribirOtraVez("r2");

    // Y ahora termina la de r1: no puede llevarse por delante la acción de r2.
    await act(async () => {
      cancelacionDeR1.resolver(undefined);
    });

    // Ctrl+Z cancela EXACTAMENTE r2, y una sola vez.
    cancel.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });

    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(cancel, "la acción de r2 sobrevivió").toHaveBeenCalledWith("r2");
  });
});

/**
 * REGISTRO DE ESCRITURAS EN CURSO, POR IDENTIDAD.
 *
 * `busyEventId` era una sola identidad para todas las escrituras, y eso permitía
 * que la que terminaba primero desbloqueara a la que seguía en vuelo. Peor:
 * eliminar y editar no tenían ninguna autoridad mientras esperaban —`soloLectura`
 * solo se enciende cuando la escritura ya terminó y disparó la recarga—, así que
 * una segunda pulsación mandaba otra petición sobre la misma fila.
 */
describe("dos escrituras no se desbloquean entre sí", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  const prueba = (n: number) => ({
    id: `ce-${n}`,
    displayOrder: n,
    event: { distance: { meters: 50 * n }, stroke: { name: "Libre" }, gender: "mixed", testType: { swimmersCount: 1 } },
    competitionSession: { sessionType: { name: "Mañana" }, competitionDate: { date: "2026-03-01" } },
  });

  /** Una inscripción confirmada, para poder editarla y eliminarla. */
  const inscripcion = (id: string, ce: ReturnType<typeof prueba>) => ({
    id,
    person: { id: "p1", fullName: "Nadador 1", run: "1-1" },
    seedTimeCentiseconds: 3045,
    competitionEvent: {
      event: { distance: ce.event.distance, stroke: ce.event.stroke, gender: ce.event.gender },
      competitionSession: ce.competitionSession,
    },
  });

  async function montarConPruebas(pruebas: ReturnType<typeof prueba>[], confirmadas: unknown[] = []) {
    listEnabledEvents.mockImplementation(async () => pruebas);
    listClubEligibilityMatrix.mockImplementation(async () => [
      { ...nadador(1), eligibleEvents: pruebas.map((ce) => ({ competitionEventId: ce.id })) },
    ]);
    registrationsList.mockImplementation(async () => ({
      items: confirmadas,
      total: confirmadas.length,
      page: 1,
      pageSize: 50,
    }));

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");
    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
  }

  const botonesInscribir = () => screen.getAllByRole("button", { name: "Inscribir" });

  it("1. dos «Inscribir» sobre la MISMA persona y prueba: una sola llamada", async () => {
    const creacion = pendiente<{ id: string }>();
    create.mockReturnValue(creacion.promesa as never);
    await montarConPruebas([prueba(1)]);

    fireEvent.click(nadadorEnPlantel(1)!);
    fireEvent.change(document.getElementById("time-input-ce-1")!, { target: { value: "003045" } });

    const boton = await screen.findByRole("button", { name: "Inscribir" });

    /**
     * Tres pulsaciones DENTRO DEL MISMO `act`, con eventos nativos. Es una prueba
     * **adversarial** del guard síncrono, no la reproducción literal de un doble
     * clic normal: se agrupan a propósito para que React no repinte entre ellas,
     * de modo que el atributo `disabled` no llegue al DOM y las tres alcancen al
     * manejador. Lo único que puede detenerlas entonces es la `ref`.
     *
     * Con `fireEvent` no serviría: Testing Library lo envuelve en `act` y vacía el
     * estado entre pulsaciones, así que `disabled` absorbería la segunda y la
     * prueba pasaría aunque el guard no existiera. Se comprobó retirándolo.
     */
    await act(async () => {
      boton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      boton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      boton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(create, "el guard es síncrono: no espera a que React repinte").toHaveBeenCalledTimes(1);
    await waitFor(() => expect(botonesInscribir()[0]!).toBeDisabled());

    await act(async () => {
      creacion.resolver({ id: "r1" });
    });
  });

  it("2. A y B en paralelo: al terminar A, B sigue bloqueada hasta resolver la suya", async () => {
    const deA = pendiente<{ id: string }>();
    const deB = pendiente<{ id: string }>();
    create.mockReturnValueOnce(deA.promesa as never).mockReturnValueOnce(deB.promesa as never);

    await montarConPruebas([prueba(1), prueba(2)]);
    fireEvent.click(nadadorEnPlantel(1)!);

    // Inscribir en la prueba 1 y en la 2, ambas en vuelo.
    fireEvent.change(document.getElementById("time-input-ce-1")!, { target: { value: "003045" } });
    fireEvent.click(botonesInscribir()[0]!);
    fireEvent.change(document.getElementById("time-input-ce-2")!, { target: { value: "010000" } });
    fireEvent.click(botonesInscribir()[1]!);

    expect(create, "operaciones distintas SÍ pueden ir en paralelo").toHaveBeenCalledTimes(2);
    await waitFor(() => expect(botonesInscribir()[0]!).toBeDisabled());
    expect(botonesInscribir()[1]!).toBeDisabled();

    // Termina la de la prueba 1.
    await act(async () => {
      deA.resolver({ id: "rA" });
    });

    expect(botonesInscribir()[1]!, "la de la prueba 2 sigue en vuelo").toBeDisabled();
    const llamadasAntes = create.mock.calls.length;
    fireEvent.click(botonesInscribir()[1]!);
    expect(create, "y su control no manda nada").toHaveBeenCalledTimes(llamadasAntes);

    await act(async () => {
      deB.resolver({ id: "rB" });
    });
  });

  it("3. doble guardado de una edición: una sola llamada a `update`", async () => {
    const guardado = pendiente<undefined>();
    update.mockReturnValue(guardado.promesa as never);
    const ce = prueba(1);
    await montarConPruebas([ce], [inscripcion("r1", ce)]);

    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    // Tres pulsaciones en el MISMO `act`: ver la nota de la prueba 1.
    const guardar = await screen.findByRole("button", { name: "✓" });
    await act(async () => {
      guardar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      guardar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      guardar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => {
      guardado.resolver(undefined);
    });
  });

  it("4. doble eliminación: una sola llamada a `cancel`", async () => {
    const cancelacion = pendiente<undefined>();
    cancel.mockReturnValue(cancelacion.promesa as never);
    const ce = prueba(1);
    await montarConPruebas([ce], [inscripcion("r1", ce)]);

    const eliminar = await screen.findByRole("button", { name: "×" });
    await act(async () => {
      eliminar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      eliminar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      eliminar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("r1");

    await act(async () => {
      cancelacion.resolver(undefined);
    });
  });

  it("5. una identidad ocupada no admite otra operación, ni forzando el control", async () => {
    /**
     * La versión anterior de esta prueba pretendía demostrar que el `finally` de
     * una operación vieja no libera el token de otra posterior con la misma
     * clave. **No lo demostraba**: se comprobó retirando la comparación de token
     * y la prueba seguía en verde. La razón es que ese entrelazado no es
     * alcanzable por la interfaz —mientras la primera viaja, el control de esa
     * identidad está deshabilitado, así que no puede haber una segunda—.
     *
     * La comparación de token se conserva como defensa en profundidad y así queda
     * dicho; lo que esta prueba fija es la propiedad que sí es alcanzable y sí
     * importa: **una identidad ocupada no acepta nada más**, ni siquiera con un
     * clic forzado sobre el control deshabilitado, y al terminar se libera
     * exactamente una vez.
     */
    const cancelacion = pendiente<undefined>();
    cancel.mockReturnValue(cancelacion.promesa as never);

    const ce = prueba(1);
    await montarConPruebas([ce], [inscripcion("r1", ce)]);

    const eliminar = await screen.findByRole("button", { name: "×" });
    fireEvent.click(eliminar);
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "×" })).toBeDisabled());

    /**
     * Pulsar el control deshabilitado no manda nada. Dicho con precisión: esto
     * demuestra el **bloqueo visual** —el evento no llega al manejador porque el
     * botón está `disabled`—, no que el manejador lo reciba y lo rechace. Esa otra
     * mitad la cubre la prueba 1, con eventos nativos agrupados.
     */
    fireEvent.click(screen.getByRole("button", { name: "×" }));
    expect(cancel, "la identidad sigue ocupada").toHaveBeenCalledTimes(1);

    await act(async () => {
      cancelacion.resolver(undefined);
    });

    // Liberada, y una sola vez: el control vuelve, y una segunda eliminación sí
    // sale porque es una operación nueva.
    await waitFor(() => expect(screen.getByRole("button", { name: "×" })).toBeEnabled());
    cancel.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "×" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
  });
});

/**
 * CONFLICTOS POR RECURSO: la fila es el recurso, no el verbo.
 *
 * Con `editar:<id>` y `cancelar:<id>` separados, dos operaciones incompatibles
 * podían solaparse sobre la misma inscripción. Y una cancelación manual no
 * consumía el «Deshacer» que la ofrecía, así que Ctrl+Z mandaba una segunda
 * cancelación de algo ya cancelado.
 */
describe("una sola operación por inscripción a la vez", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    let rechazar!: (e: unknown) => void;
    const promesa = new Promise<T>((res, rej) => {
      resolver = res;
      rechazar = rej;
    });
    return { promesa, resolver, rechazar };
  }

  const prueba = (n: number) => ({
    id: `ce-${n}`,
    displayOrder: n,
    event: { distance: { meters: 50 * n }, stroke: { name: "Libre" }, gender: "mixed", testType: { swimmersCount: 1 } },
    competitionSession: { sessionType: { name: "Mañana" }, competitionDate: { date: "2026-03-01" } },
  });

  const inscripcion = (id: string, ce: ReturnType<typeof prueba>, quien = "Nadador 1") => ({
    id,
    person: { id: "p1", fullName: quien, run: "1-1" },
    seedTimeCentiseconds: 3045,
    competitionEvent: {
      event: { distance: ce.event.distance, stroke: ce.event.stroke, gender: ce.event.gender },
      competitionSession: ce.competitionSession,
    },
  });

  async function montarCon(pruebas: ReturnType<typeof prueba>[], confirmadas: unknown[]) {
    listEnabledEvents.mockImplementation(async () => pruebas);
    listClubEligibilityMatrix.mockImplementation(async () => [
      { ...nadador(1), eligibleEvents: pruebas.map((ce) => ({ competitionEventId: ce.id })) },
    ]);
    registrationsList.mockImplementation(async () => ({
      items: confirmadas,
      total: confirmadas.length,
      page: 1,
      pageSize: 50,
    }));

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");
    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
  }

  it("1. `update(r1)` pendiente → salir del editor → intentar eliminar: no se cancela", async () => {
    const guardado = pendiente<undefined>();
    update.mockReturnValue(guardado.promesa as never);
    const ce = prueba(1);
    await montarCon([ce], [inscripcion("r1", ce)]);

    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    fireEvent.click(await screen.findByRole("button", { name: "✓" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));

    // La «✕» local solo cierra el formulario; el guardado sigue viajando.
    fireEvent.click(screen.getByRole("button", { name: "✕" }));

    const eliminar = await screen.findByRole("button", { name: "×" });
    expect(eliminar, "la fila está ocupada por el guardado").toBeDisabled();
    fireEvent.click(eliminar);
    expect(cancel, "no se cancela algo que se está guardando").not.toHaveBeenCalled();

    await act(async () => {
      guardado.resolver(undefined);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "×" })).toBeEnabled());
  });

  it("2. `cancel(r1)` pendiente → intentar editar y guardar: no se actualiza", async () => {
    const cancelacion = pendiente<undefined>();
    cancel.mockReturnValue(cancelacion.promesa as never);
    const ce = prueba(1);
    await montarCon([ce], [inscripcion("r1", ce)]);

    fireEvent.click(await screen.findByRole("button", { name: "×" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));

    const editar = screen.getByRole("button", { name: "Editar" });
    expect(editar, "no se abre el editor de algo que se está cancelando").toBeDisabled();
    fireEvent.click(editar);
    expect(screen.queryByRole("button", { name: "✓" }), "el editor no se abrió").not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();

    await act(async () => {
      cancelacion.resolver(undefined);
    });
  });

  /**
   * Deja `r1` creada —con su aviso de deshacer instalado— y luego cancelada a mano
   * desde la «×» de la fila. Es el punto de partida de las pruebas 3 y 4.
   */
  async function crearYCancelarR1() {
    const ce = prueba(1);
    listEnabledEvents.mockImplementation(async () => [ce]);
    listClubEligibilityMatrix.mockImplementation(async () => [
      { ...nadador(1), eligibleEvents: [{ competitionEventId: "ce-1" }] },
    ]);
    // Tras crearla, la recarga la devuelve ya confirmada.
    let confirmadas: unknown[] = [];
    registrationsList.mockImplementation(async () => ({
      items: confirmadas,
      total: confirmadas.length,
      page: 1,
      pageSize: 50,
    }));
    create.mockResolvedValue({ id: "r1" });

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");
    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());

    fireEvent.click(nadadorEnPlantel(1)!);
    fireEvent.change(document.getElementById("time-input-ce-1")!, { target: { value: "003045" } });
    confirmadas = [inscripcion("r1", ce)];
    fireEvent.click(await screen.findByRole("button", { name: "Inscribir" }));
    await waitFor(() => expect(toasts.some((t) => t.accion?.label === "Deshacer")).toBe(true));

    fireEvent.click(await screen.findByRole("button", { name: "×" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    cancel.mockClear();
  }

  it("3. crear `r1` → cancelarla desde la fila → Ctrl+Z no manda otra cancelación", async () => {
    await crearYCancelarR1();

    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });

    expect(cancel, "la acción quedó consumida por la eliminación").not.toHaveBeenCalled();
  });

  it("4. el callback ANTIGUO del aviso tampoco vuelve a cancelar", async () => {
    await crearYCancelarR1();

    // El aviso sigue en pantalla seis segundos: su botón puede pulsarse.
    const accion = toasts.find((t) => t.accion?.label === "Deshacer")!.accion!;
    await act(async () => {
      accion.onClick();
    });

    expect(cancel, "ni desde el aviso que sigue en pantalla").not.toHaveBeenCalled();
  });

  it("5. si la eliminación manual FALLA, el deshacer sigue disponible", async () => {
    const ce = prueba(1);
    listEnabledEvents.mockImplementation(async () => [ce]);
    listClubEligibilityMatrix.mockImplementation(async () => [
      { ...nadador(1), eligibleEvents: [{ competitionEventId: "ce-1" }] },
    ]);
    let confirmadas: unknown[] = [];
    registrationsList.mockImplementation(async () => ({
      items: confirmadas,
      total: confirmadas.length,
      page: 1,
      pageSize: 50,
    }));
    create.mockResolvedValue({ id: "r1" });

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");
    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());

    fireEvent.click(nadadorEnPlantel(1)!);
    fireEvent.change(document.getElementById("time-input-ce-1")!, { target: { value: "003045" } });
    confirmadas = [inscripcion("r1", ce)];
    fireEvent.click(await screen.findByRole("button", { name: "Inscribir" }));
    await waitFor(() => expect(toasts.some((t) => t.accion?.label === "Deshacer")).toBe(true));

    // La eliminación falla.
    cancel.mockRejectedValueOnce(new Error("500 al cancelar"));
    fireEvent.click(await screen.findByRole("button", { name: "×" }));
    await waitFor(() => expect(toasts.some((t) => /500 al cancelar/.test(t.mensaje))).toBe(true));

    // El deshacer NO se consumió: sigue pudiendo cancelar.
    cancel.mockResolvedValue(undefined);
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("r1"));
    expect(cancel, "la fallida más la del deshacer").toHaveBeenCalledTimes(2);
  });

  it("6. una operación sobre `r1` no bloquea otra sobre `r2`", async () => {
    const deR1 = pendiente<undefined>();
    cancel.mockReturnValueOnce(deR1.promesa as never);
    const ce = prueba(1);
    await montarCon([ce], [inscripcion("r1", ce, "Nadador 1"), inscripcion("r2", ce, "Nadador 2")]);

    const eliminar = await screen.findAllByRole("button", { name: "×" });
    expect(eliminar).toHaveLength(2);

    fireEvent.click(eliminar[0]!);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("r1"));

    // La otra fila es otro recurso: no queda bloqueada.
    const trasPrimera = screen.getAllByRole("button", { name: "×" });
    expect(trasPrimera[0]!, "r1 ocupada").toBeDisabled();
    expect(trasPrimera[1]!, "r2 libre").toBeEnabled();

    fireEvent.click(trasPrimera[1]!);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("r2"));

    await act(async () => {
      deR1.resolver(undefined);
    });
  });
});

/**
 * LA AUTORIDAD DE DESHACER ES POR VISTA, NO UNA SOLA GLOBAL.
 *
 * Cada creación terminada instalaba su acción en una única referencia, sin mirar
 * de qué vista venía. Con una creación de la competencia A todavía en vuelo, se
 * cambia a B, se inscribe allí, y cuando A termina **pisa la acción de B**: el
 * aviso de B pasa a considerarse obsoleto, Ctrl+Z recoge la acción de A —que no
 * corresponde a la vista— y la inscripción recién hecha en B se queda sin poder
 * deshacerse. Los controles de carga impedían que A repintara B, pero no
 * protegían esta referencia.
 */
describe("la autoridad de deshacer no se pisa entre competencias", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  const pruebaDe = (comp: "A" | "B") => ({
    id: `ce-${comp}`,
    displayOrder: 1,
    event: { distance: { meters: 50 }, stroke: { name: "Libre" }, gender: "mixed", testType: { swimmersCount: 1 } },
    competitionSession: { sessionType: { name: "Mañana" }, competitionDate: { date: "2026-03-01" } },
  });

  const accionesDeshacer = () => toasts.filter((t) => t.accion?.label === "Deshacer").map((t) => t.accion!);
  const pulsarCtrlZ = async () => {
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });
  };

  /** Monta el panel acotado a un club, con una prueba por competencia. */
  async function montarDosCompetencias() {
    listEnabledEvents.mockImplementation(async (competitionId: string) => [
      pruebaDe(competitionId === "comp-A" ? "A" : "B"),
    ]);
    listClubEligibilityMatrix.mockImplementation(async (competitionId: string) => [
      {
        ...nadador(competitionId === "comp-A" ? 1 : 9),
        eligibleEvents: [{ competitionEventId: competitionId === "comp-A" ? "ce-A" : "ce-B" }],
      },
    ]);

    sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
    montar();
    await screen.findByText("Club Uno");
  }

  /** Inscribe en la competencia visible y devuelve cuántos avisos hay ya. */
  async function inscribirEnLaVistaActual(nadadorN: number, ceId: string) {
    fireEvent.click(nadadorEnPlantel(nadadorN)!);
    fireEvent.change(document.getElementById(`time-input-${ceId}`)!, { target: { value: "003045" } });
    fireEvent.click(await screen.findByRole("button", { name: "Inscribir" }));
  }

  /**
   * Deja el escenario del hallazgo: `create(A)` en vuelo, vista en B, `create(B)`
   * ya resuelto con su aviso instalado. Devuelve el resolvedor de A.
   */
  async function escenario() {
    const deA = pendiente<{ id: string }>();
    create.mockImplementation(async (payload: { competitionEventId?: string } = {}) =>
      payload.competitionEventId === "ce-A" ? deA.promesa : { id: "rB" }
    );

    await montarDosCompetencias();

    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
    await inscribirEnLaVistaActual(1, "ce-A");
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    elegir(/Competencia/, "comp-B");
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());
    await inscribirEnLaVistaActual(9, "ce-B");
    await waitFor(() => expect(accionesDeshacer()).toHaveLength(1));

    return deA;
  }

  it("1. A termina tarde: Ctrl+Z en B cancela EXACTAMENTE B", async () => {
    const deA = await escenario();

    await act(async () => {
      deA.resolver({ id: "rA" });
    });

    await pulsarCtrlZ();

    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(cancel, "la acción de A no puede haber desplazado a la de B").toHaveBeenCalledWith("rB");
  });

  it("2. el aviso de B sigue vigente tras la llegada tardía de A", async () => {
    const deA = await escenario();
    const avisoDeB = accionesDeshacer()[0]!;

    await act(async () => {
      deA.resolver({ id: "rA" });
    });

    await act(async () => {
      avisoDeB.onClick();
    });

    await waitFor(() => expect(cancel).toHaveBeenCalledWith("rB"));
    expect(toasts.some((t) => /ya no está disponible/.test(t.mensaje)), "no es obsoleto").toBe(false);
  });

  it("3. el aviso ATRASADO de A no cancela B ni le quita su autoridad", async () => {
    const deA = await escenario();

    await act(async () => {
      deA.resolver({ id: "rA" });
    });

    /**
     * Ahora hay dos avisos: el de B y, detrás, el de A, que llegó después. Se
     * exige que existan los dos ANTES de pulsar: si el de A no llegara a
     * instalarse, la prueba debe fallar, no seguir adelante sin haber ejecutado
     * aquello que su título promete.
     */
    await waitFor(() => expect(accionesDeshacer()).toHaveLength(2));
    const [, avisoDeA] = accionesDeshacer();
    expect(avisoDeA).toBeDefined();

    await act(async () => {
      avisoDeA!.onClick();
    });
    expect(cancel, "el aviso de A no cancela nada estando en B").not.toHaveBeenCalled();

    // Y B conserva la suya.
    await pulsarCtrlZ();
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("rB"));
  });

  it("4. volviendo a A se puede deshacer A, sin tocar lo de B", async () => {
    const deA = await escenario();

    await act(async () => {
      deA.resolver({ id: "rA" });
    });

    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());

    await pulsarCtrlZ();

    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(cancel, "en A se deshace lo de A").toHaveBeenCalledWith("rA");

    // Y al volver a B, la suya sigue ahí.
    elegir(/Competencia/, "comp-B");
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());
    await pulsarCtrlZ();
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
    expect(cancel).toHaveBeenCalledWith("rB");
  });

  it("5. el resultado no depende del ORDEN de las respuestas", async () => {
    /**
     * Mismo escenario con el orden invertido: A resuelve ANTES de que B llegue a
     * inscribirse. Si el resultado dependiera del orden, esta y la primera
     * diferirían.
     */
    const deA = pendiente<{ id: string }>();
    const deB = pendiente<{ id: string }>();
    create.mockImplementation(async (payload: { competitionEventId?: string } = {}) =>
      payload.competitionEventId === "ce-A" ? deA.promesa : deB.promesa
    );

    await montarDosCompetencias();

    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());
    await inscribirEnLaVistaActual(1, "ce-A");
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    elegir(/Competencia/, "comp-B");
    await waitFor(() => expect(nadadorEnPlantel(9)).toBeInTheDocument());
    await inscribirEnLaVistaActual(9, "ce-B");
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    // A PRIMERO, con B todavía en vuelo.
    await act(async () => {
      deA.resolver({ id: "rA" });
    });
    await act(async () => {
      deB.resolver({ id: "rB" });
    });

    await pulsarCtrlZ();

    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(cancel, "en B se deshace lo de B, resuelva quien resuelva primero").toHaveBeenCalledWith("rB");

    /**
     * La otra mitad del orden inverso: A terminó **mientras se miraba B**, y su
     * acción tiene que haber quedado guardada bajo su propia vista. Sin esta
     * comprobación pasaría una implementación que preserve la de B pero descarte
     * la de A por no ser la vigente al llegar.
     */
    elegir(/Competencia/, "comp-A");
    await waitFor(() => expect(nadadorEnPlantel(1)).toBeInTheDocument());

    await pulsarCtrlZ();

    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
    expect(cancel, "en A se deshace exactamente lo de A").toHaveBeenLastCalledWith("rA");
  });
});
