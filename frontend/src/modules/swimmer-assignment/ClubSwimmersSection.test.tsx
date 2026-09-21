/**
 * Fase 6, hallazgo 28 — la TABLA del plantel, navegada de verdad.
 *
 * El inventario afirmaba que su paginación estaba ejercitada, pero las pruebas
 * que existían mockeaban la lista con **cero filas**: no navegaban nada. Aquí se
 * usa un servidor con 45 membresías y se pulsa "Siguiente" de verdad.
 *
 * De paso queda cubierto un defecto que esto destapó: al cambiar de club, la
 * página no se reiniciaba, así que quien estuviera en la 3 y cambiara a un club
 * pequeño veía una tabla vacía sin ninguna pista de por qué.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ClubSwimmersSection } from "./ClubSwimmersSection";

const POR_PAGINA = 20;

/** Cuántas membresías tiene cada club en el servidor simulado. */
const TOTALES: Record<string, number> = { "club-grande": 45, "club-chico": 3 };

function membresia(club: string, n: number) {
  return {
    id: `${club}-m${n}`,
    status: "active",
    startDate: "2026-01-01",
    endDate: null,
    person: { id: `p-${n}`, fullName: `Nadador ${club} ${n}`, run: `R${n}`, firstName: null, paternalLastName: null },
    club: { id: club, name: club },
  };
}

/** Servidor por omisión: pagina de verdad. Cada prueba puede sustituirlo. */
const listaNormal = async (params: { clubId?: string; page?: number; pageSize?: number } = {}) => {
  const club = params.clubId ?? "club-grande";
  const total = TOTALES[club] ?? 0;
  const pageSize = params.pageSize ?? POR_PAGINA;
  const page = params.page ?? 1;
  const desde = (page - 1) * pageSize;
  return {
    items: Array.from({ length: Math.max(0, Math.min(pageSize, total - desde)) }, (_, i) => membresia(club, desde + i + 1)),
    total,
    page,
    pageSize,
  };
};

const assignmentsList = vi.fn(listaNormal);

/**
 * El mock refleja la API REAL (`assignmentApi.ts`): el método es `end`, no
 * `endMembership`. Con el nombre equivocado, `api.end` era `undefined` y
 * cualquier prueba de finalización habría fallado por un `TypeError` en vez de
 * por lo que pretendía comprobar.
 */
// Con la firma real: sin ella, `mock.calls` es una tupla vacía y no se puede
// comprobar con qué club se llamó.
const assignDirectly = vi.fn(async (_clubId: string, _personId: string) => undefined);
const end = vi.fn(async (_id: string) => undefined);

vi.mock("./assignmentApi", () => ({
  useSwimmerAssignmentApi: () => ({
    list: assignmentsList,
    assignDirectly,
    end,
    approve: vi.fn(),
    reject: vi.fn(),
  }),
}));

/** Buscador de personas: una coincidencia, suficiente para poder asignar. */
const personsList = vi.fn(async () => ({
  items: [{ id: "pp-1", fullName: "Persona 1", run: "RP1" }],
  total: 1,
  page: 1,
  pageSize: 20,
}));
vi.mock("../persons/personsApi", () => ({ usePersonsApi: () => ({ list: personsList }) }));

const siguiente = () => screen.getByRole("button", { name: "Siguiente" });
const anterior = () => screen.getByRole("button", { name: "Anterior" });

beforeEach(() => {
  // `mockReset` borra también la implementación: hay que reponerla.
  assignmentsList.mockReset();
  assignmentsList.mockImplementation(listaNormal);
  assignDirectly.mockReset();
  assignDirectly.mockResolvedValue(undefined);
  end.mockReset();
  end.mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("ClubSwimmersSection: paginación de la tabla", () => {
  it("muestra la página 1 y pide el tamaño que enseña", async () => {
    render(<ClubSwimmersSection clubId="club-grande" />);

    expect(await screen.findByText("Nadador club-grande 1 (R1)")).toBeInTheDocument();
    expect(screen.getByText("Nadador club-grande 20 (R20)")).toBeInTheDocument();
    expect(screen.queryByText("Nadador club-grande 21 (R21)"), "la 21 está en la página 2").not.toBeInTheDocument();

    /**
     * El `pageSize` pedido tiene que ser el mismo con el que el pie calcula
     * "Siguiente". Antes se pedían 100 y se calculaba con 20.
     */
    expect(assignmentsList.mock.calls[0]![0]).toMatchObject({ clubId: "club-grande", page: 1, pageSize: POR_PAGINA });
    expect(anterior(), "en la primera página no hay anterior").toBeDisabled();
    expect(siguiente()).toBeEnabled();
  });

  it("navega a la SEGUNDA página y muestra sus filas", async () => {
    render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");

    fireEvent.click(siguiente());

    expect(await screen.findByText("Nadador club-grande 21 (R21)")).toBeInTheDocument();
    expect(screen.getByText("Nadador club-grande 40 (R40)")).toBeInTheDocument();
    expect(screen.queryByText("Nadador club-grande 1 (R1)")).not.toBeInTheDocument();
    expect(anterior(), "ahora sí se puede volver").toBeEnabled();
    expect(siguiente(), "y aún queda una tercera").toBeEnabled();

    // Tercera y última: 45 = 20 + 20 + 5.
    fireEvent.click(siguiente());
    expect(await screen.findByText("Nadador club-grande 45 (R45)")).toBeInTheDocument();
    expect(siguiente(), "en la última no hay siguiente").toBeDisabled();

    expect(assignmentsList.mock.calls.map((c) => c[0]?.page)).toEqual([1, 2, 3]);
  });

  it("al CAMBIAR DE CLUB vuelve a la página 1", async () => {
    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");

    fireEvent.click(siguiente());
    await screen.findByText("Nadador club-grande 21 (R21)");

    /**
     * `club-chico` tiene 3 membresías: su página 2 está vacía. Sin reiniciar, la
     * tabla aparecía en blanco y el usuario no tenía forma de saber que bastaba
     * con pulsar "Anterior".
     */
    rerender(<ClubSwimmersSection clubId="club-chico" />);

    expect(await screen.findByText("Nadador club-chico 1 (R1)")).toBeInTheDocument();
    const ultima = assignmentsList.mock.calls[assignmentsList.mock.calls.length - 1]![0];
    expect(ultima).toMatchObject({ clubId: "club-chico", page: 1 });
  });
});

/**
 * CARRERAS DE LA TABLA.
 *
 * Reiniciar la página al cambiar de club no evita que la petición del club
 * ANTERIOR termine después que la del nuevo. Cuando eso pasaba, la tabla acababa
 * mostrando el plantel de A bajo el rótulo de B —y el botón "Finalizar
 * membresía" habría operado sobre membresías de otro club—.
 *
 * Estas pruebas controlan cuándo responde cada petición, en vez de confiar en
 * que el orden de llegada sea el conveniente.
 */
describe("respuestas antiguas no pueden pisar a las nuevas", () => {
  /** Promesa que resolvemos nosotros. */
  function diferida<T>() {
    let resolver!: (v: T) => void;
    let rechazar!: (e: unknown) => void;
    const promesa = new Promise<T>((res, rej) => {
      resolver = res;
      rechazar = rej;
    });
    return { promesa, resolver, rechazar };
  }

  const respuesta = (club: string, page: number, cuantos: number, total: number) => ({
    items: Array.from({ length: cuantos }, (_, i) => membresia(club, (page - 1) * POR_PAGINA + i + 1)),
    total,
    page,
    pageSize: POR_PAGINA,
  });

  it("A queda pendiente, se cambia a B, B responde primero y A después: manda B", async () => {
    const deA = diferida<any>();
    const deB = diferida<any>();
    assignmentsList.mockImplementation(async ({ clubId }: { clubId?: string } = {}) =>
      clubId === "club-grande" ? deA.promesa : deB.promesa
    );

    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);
    // (a) la petición de A está en vuelo, sin responder.
    await waitFor(() => expect(assignmentsList).toHaveBeenCalledTimes(1));

    // (b) el usuario cambia de club.
    rerender(<ClubSwimmersSection clubId="club-chico" />);
    await waitFor(() => expect(assignmentsList).toHaveBeenCalledTimes(2));

    // (c) B responde primero.
    await act(async () => {
      deB.resolver(respuesta("club-chico", 1, 3, 3));
    });
    expect(await screen.findByText("Nadador club-chico 1 (R1)")).toBeInTheDocument();

    // (d) y AHORA responde A, tarde.
    await act(async () => {
      deA.resolver(respuesta("club-grande", 1, 20, 45));
    });

    // (e) la interfaz sigue mostrando exclusivamente B.
    expect(screen.getByText("Nadador club-chico 1 (R1)")).toBeInTheDocument();
    expect(screen.queryByText("Nadador club-grande 1 (R1)"), "la respuesta atrasada se descarta").not.toBeInTheDocument();
    expect(screen.getByText(/3 registro\(s\)/), "ni su total").toBeInTheDocument();

    // Y nunca se pidió una página distinta de la 1 para el club nuevo.
    const paginasDeB = assignmentsList.mock.calls.filter((c) => c[0]?.clubId === "club-chico").map((c) => c[0]?.page);
    expect(paginasDeB).toEqual([1]);
  });

  it("las filas del club anterior NO son accionables durante la transición", async () => {
    const deB = diferida<any>();
    assignmentsList.mockImplementation(async ({ clubId }: { clubId?: string } = {}) =>
      clubId === "club-grande" ? respuesta("club-grande", 1, 20, 45) : deB.promesa
    );

    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");

    rerender(<ClubSwimmersSection clubId="club-chico" />);

    /**
     * En cuanto cambia el club, las filas viejas desaparecen: no basta con
     * deshabilitar el botón, porque una tabla que muestra el plantel de otro club
     * ya es información falsa.
     */
    expect(screen.queryByText("Nadador club-grande 1 (R1)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Finalizar membresía/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Cargando plantel/);

    await act(async () => {
      deB.resolver(respuesta("club-chico", 1, 3, 3));
    });
    expect(await screen.findByText("Nadador club-chico 1 (R1)")).toBeInTheDocument();
  });

  it("navegación superpuesta BLOQUEADA: no se puede pedir la 3 con la 2 en vuelo", async () => {
    const de2 = diferida<any>();
    const de3 = diferida<any>();
    assignmentsList.mockImplementation(async ({ page = 1 }: { page?: number } = {}) => {
      if (page === 1) return respuesta("club-grande", 1, 20, 45);
      if (page === 2) return de2.promesa;
      return de3.promesa;
    });

    render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");

    fireEvent.click(siguiente()); // -> página 2, queda pendiente
    await waitFor(() => expect(assignmentsList.mock.calls.some((c) => c[0]?.page === 2)).toBe(true));

    /**
     * Mientras carga, "Siguiente" está deshabilitado: es lo que impide encadenar
     * peticiones cuyas respuestas vuelvan desordenadas. Se libera resolviendo la
     * página 2 y solo entonces se puede pedir la 3.
     */
    expect(siguiente()).toBeDisabled();

    await act(async () => {
      de2.resolver(respuesta("club-grande", 2, 20, 45));
    });
    await screen.findByText("Nadador club-grande 21 (R21)");

    fireEvent.click(siguiente());
    await act(async () => {
      de3.resolver(respuesta("club-grande", 3, 5, 45));
    });

    expect(await screen.findByText("Nadador club-grande 45 (R45)")).toBeInTheDocument();
    expect(screen.queryByText("Nadador club-grande 21 (R21)")).not.toBeInTheDocument();
  });

  it("un ERROR se muestra, y un reintento correcto lo borra", async () => {
    let fallar = true;
    assignmentsList.mockImplementation(async ({ clubId, page = 1 }: { clubId?: string; page?: number } = {}) => {
      if (clubId === "club-grande" && fallar) {
        fallar = false;
        throw new Error("500 al cargar el plantel");
      }
      return clubId === "club-chico" ? respuesta("club-chico", 1, 3, 3) : respuesta("club-grande", page, 20, 45);
    });

    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);

    expect(await screen.findByText(/500 al cargar el plantel/)).toBeInTheDocument();
    // Sin filas: una tabla con datos junto a un error haría creer que son válidos.
    expect(screen.queryByRole("button", { name: /Finalizar membresía/ })).not.toBeInTheDocument();

    // El reintento llega por la vía normal: ir a otro club y volver.
    rerender(<ClubSwimmersSection clubId="club-chico" />);
    await screen.findByText("Nadador club-chico 1 (R1)");
    rerender(<ClubSwimmersSection clubId="club-grande" />);

    await screen.findByText("Nadador club-grande 1 (R1)");
    expect(screen.queryByText(/500 al cargar el plantel/), "el error viejo no sobrevive").not.toBeInTheDocument();
  });
});

/**
 * ESCRITURAS QUE TERMINAN EN OTRO CLUB.
 *
 * `handleAssign` y `handleEndMembership` capturaban el `clubId` y el `load` del
 * render donde empezaron. Si la mutación se resolvía después de cambiar de club,
 * escribían su mensaje de éxito sobre la vista nueva, limpiaban su buscador y
 * **recargaban la lista del club anterior**.
 */
describe("mutaciones que se resuelven después de cambiar de club", () => {
  function diferida<T>() {
    let resolver!: (v: T) => void;
    let rechazar!: (e: unknown) => void;
    const promesa = new Promise<T>((res, rej) => {
      resolver = res;
      rechazar = rej;
    });
    return { promesa, resolver, rechazar };
  }

  /** Busca una persona y devuelve el elemento de la sugerencia. */
  async function buscarYObtenerSugerencia() {
    const input = screen.getAllByRole("textbox")[0]!;
    fireEvent.change(input, { target: { value: "persona" } });
    return screen.findByText("Persona 1 (RP1)");
  }

  it("ASIGNACIÓN atrasada: no recarga A, no escribe sobre B, no limpia su buscador", async () => {
    const asignacion = diferida<undefined>();
    assignDirectly.mockReturnValue(asignacion.promesa as never);

    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");

    // (b) se inicia la asignación en A y queda pendiente.
    fireEvent.click(await buscarYObtenerSugerencia());
    await waitFor(() => expect(assignDirectly).toHaveBeenCalledWith("club-grande", "pp-1"));

    // (c) se cambia a B y carga bien.
    rerender(<ClubSwimmersSection clubId="club-chico" />);
    await screen.findByText("Nadador club-chico 1 (R1)");
    const llamadasAntes = assignmentsList.mock.calls.length;

    // (d) ahora resuelve la mutación de A.
    await act(async () => {
      asignacion.resolver(undefined);
    });

    // (e) nada de A se proyecta sobre B.
    expect(assignmentsList.mock.calls.length, "no se recarga ninguna lista").toBe(llamadasAntes);
    expect(screen.queryByText(/Nadador asignado directamente/), "ni su mensaje de éxito").not.toBeInTheDocument();
    expect(screen.getByText("Nadador club-chico 1 (R1)"), "B sigue visible").toBeInTheDocument();
    expect(screen.queryByText("Nadador club-grande 1 (R1)")).not.toBeInTheDocument();
    // El buscador de B conserva lo que el usuario tuviera escrito.
    expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe("persona");
  });

  it("ASIGNACIÓN atrasada que FALLA: su error tampoco aparece en B", async () => {
    const asignacion = diferida<undefined>();
    assignDirectly.mockReturnValue(asignacion.promesa as never);

    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");
    fireEvent.click(await buscarYObtenerSugerencia());
    await waitFor(() => expect(assignDirectly).toHaveBeenCalled());

    rerender(<ClubSwimmersSection clubId="club-chico" />);
    await screen.findByText("Nadador club-chico 1 (R1)");

    await act(async () => {
      asignacion.rechazar(new Error("el nadador ya pertenece a otro club"));
    });

    expect(screen.queryByText(/ya pertenece a otro club/), "un error de A no es un error de B").not.toBeInTheDocument();
  });

  it("FINALIZACIÓN atrasada: no recarga A ni escribe sobre B", async () => {
    const finalizacion = diferida<undefined>();
    end.mockReturnValue(finalizacion.promesa as never);

    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");

    fireEvent.click(screen.getAllByRole("button", { name: /Finalizar membresía/ })[0]!);
    await waitFor(() => expect(end).toHaveBeenCalledWith("club-grande-m1"));

    rerender(<ClubSwimmersSection clubId="club-chico" />);
    await screen.findByText("Nadador club-chico 1 (R1)");
    const llamadasAntes = assignmentsList.mock.calls.length;

    await act(async () => {
      finalizacion.resolver(undefined);
    });

    expect(assignmentsList.mock.calls.length).toBe(llamadasAntes);
    expect(screen.queryByText(/Membresía finalizada/)).not.toBeInTheDocument();
    expect(screen.getByText("Nadador club-chico 1 (R1)")).toBeInTheDocument();
  });

  it("la carga de A resuelta JUSTO DESPUÉS del cambio a B no se aplica", async () => {
    /**
     * La ventana más estrecha: entre que cambia la prop y arranca el efecto del
     * club nuevo. La limpieza del efecto anterior la cierra.
     */
    const deA = diferida<any>();
    const deB = diferida<any>();
    assignmentsList.mockImplementation(async ({ clubId }: { clubId?: string } = {}) =>
      clubId === "club-grande" ? deA.promesa : deB.promesa
    );

    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);
    await waitFor(() => expect(assignmentsList).toHaveBeenCalledTimes(1));

    rerender(<ClubSwimmersSection clubId="club-chico" />);

    // A responde INMEDIATAMENTE después del cambio, antes que B.
    await act(async () => {
      deA.resolver({ items: [membresia("club-grande", 1)], total: 1, page: 1, pageSize: POR_PAGINA });
    });

    expect(screen.queryByText("Nadador club-grande 1 (R1)"), "no puede pintarse").not.toBeInTheDocument();
    expect(screen.queryByText(/1 registro\(s\) — página 1/), "ni su total").not.toBeInTheDocument();

    await act(async () => {
      deB.resolver({ items: [membresia("club-chico", 1)], total: 1, page: 1, pageSize: POR_PAGINA });
    });
    expect(await screen.findByText("Nadador club-chico 1 (R1)")).toBeInTheDocument();
  });
});

describe("estados y recuperación de la tabla", () => {
  function diferida<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  it("el vacío NO se afirma mientras carga ni cuando falló", async () => {
    const carga = diferida<any>();
    assignmentsList.mockReturnValue(carga.promesa as never);

    render(<ClubSwimmersSection clubId="club-grande" />);

    // Durante la carga: ni filas ni la afirmación de que no hay nadie.
    expect(screen.queryByText(/aún no tiene nadadores asignados/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Cargando plantel/);

    await act(async () => {
      carga.resolver({ items: [], total: 0, page: 1, pageSize: POR_PAGINA });
    });
    // Con la carga terminada y de verdad vacío, sí se dice.
    expect(await screen.findByText(/aún no tiene nadadores asignados/)).toBeInTheDocument();
  });

  it("tras un ERROR no se afirma que el club esté vacío", async () => {
    assignmentsList.mockRejectedValueOnce(new Error("500 al cargar"));

    render(<ClubSwimmersSection clubId="club-grande" />);

    expect(await screen.findByText(/500 al cargar/)).toBeInTheDocument();
    expect(
      screen.queryByText(/aún no tiene nadadores asignados/),
      "no se sabe si tiene nadadores: la carga falló"
    ).not.toBeInTheDocument();
  });

  it("REINTENTAR recarga sin cambiar de club, y borra el error", async () => {
    assignmentsList.mockRejectedValueOnce(new Error("500 al cargar"));

    render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText(/500 al cargar/);

    fireEvent.click(screen.getByRole("button", { name: /Reintentar/ }));

    expect(await screen.findByText("Nadador club-grande 1 (R1)")).toBeInTheDocument();
    expect(screen.queryByText(/500 al cargar/), "el error desaparece tras la carga correcta").not.toBeInTheDocument();
  });

  it("DOBLE PULSACIÓN en finalizar: una sola petición", async () => {
    const finalizacion = diferida<undefined>();
    end.mockReturnValue(finalizacion.promesa as never);

    render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");

    const boton = screen.getAllByRole("button", { name: /Finalizar membresía/ })[0]!;
    fireEvent.click(boton);
    await waitFor(() => expect(boton).toBeDisabled());
    fireEvent.click(boton);

    expect(end, "el segundo clic no puede mandar otra petición").toHaveBeenCalledTimes(1);

    await act(async () => {
      finalizacion.resolver(undefined);
    });
  });

  it("la PÁGINA queda fuera de rango tras finalizar la última fila: vuelve a la última válida", async () => {
    /**
     * Estando en la página 3 con una sola fila, finalizarla deja esa página sin
     * contenido. Antes la tabla quedaba vacía con "Anterior" como única salida.
     */
    let total = 41;
    assignmentsList.mockImplementation(async ({ clubId = "club-grande", page = 1 }: { clubId?: string; page?: number } = {}) => {
      const desde = (page - 1) * POR_PAGINA;
      const cuantos = Math.max(0, Math.min(POR_PAGINA, total - desde));
      return {
        items: Array.from({ length: cuantos }, (_, i) => membresia(clubId, desde + i + 1)),
        total,
        page,
        pageSize: POR_PAGINA,
      };
    });

    render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");
    fireEvent.click(siguiente());
    await screen.findByText("Nadador club-grande 21 (R21)");
    fireEvent.click(siguiente());
    await screen.findByText("Nadador club-grande 41 (R41)");

    // Se finaliza la única fila de la página 3: el total baja a 40.
    total = 40;
    fireEvent.click(screen.getAllByRole("button", { name: /Finalizar membresía/ })[0]!);

    await waitFor(() => expect(screen.getByText(/40 registro\(s\) — página 2/)).toBeInTheDocument());
    expect(screen.getByText("Nadador club-grande 21 (R21)"), "se ve la última página válida").toBeInTheDocument();
  });
});

/**
 * LA VENTANA ANTERIOR A LOS EFECTOS PASIVOS.
 *
 * `useEffect` es pasivo: React lo programa para DESPUÉS del commit. Entre que el
 * commit del club B termina y su efecto pasivo corre, el bucle de eventos puede
 * procesar microtareas —la resolución de la petición del club A, por ejemplo—.
 * Si la identidad de la vista se registrara ahí, en esa ventana todavía diría "A"
 * y la respuesta atrasada se aplicaría.
 *
 * Por eso se registra en `useLayoutEffect`, que corre DENTRO del commit, de forma
 * síncrona. Estas pruebas encolan la resolución de A **antes** del cambio de club
 * para que se procese en cuanto React ceda el control: si la protección
 * dependiera del efecto pasivo, ese es el momento en que fallaría.
 */
describe("ventana entre el commit y los efectos pasivos", () => {
  function diferida<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  it("una microtarea encolada ANTES del cambio no puede aplicar la respuesta de A", async () => {
    const deA = diferida<any>();
    const deB = diferida<any>();
    assignmentsList.mockImplementation(async ({ clubId }: { clubId?: string } = {}) =>
      clubId === "club-grande" ? deA.promesa : deB.promesa
    );

    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);
    await waitFor(() => expect(assignmentsList).toHaveBeenCalledTimes(1));

    /**
     * La resolución de A queda ENCOLADA como microtarea antes de cambiar de
     * club. React procesa el render y el commit —con su `useLayoutEffect`— de
     * forma síncrona, sin ceder; cuando esta microtarea por fin corre, la clave
     * de vista ya es la de B. Con la identidad registrada en un efecto pasivo,
     * el orden podría ser el contrario.
     */
    const resolucionEncolada = Promise.resolve().then(() =>
      deA.resolver({ items: [membresia("club-grande", 1)], total: 1, page: 1, pageSize: POR_PAGINA })
    );

    await act(async () => {
      rerender(<ClubSwimmersSection clubId="club-chico" />);
      await resolucionEncolada;
    });

    expect(screen.queryByText("Nadador club-grande 1 (R1)"), "la respuesta de A no puede pintarse").not.toBeInTheDocument();
    expect(screen.queryByText(/Nadador club-grande/)).not.toBeInTheDocument();

    await act(async () => {
      deB.resolver({ items: [membresia("club-chico", 1)], total: 1, page: 1, pageSize: POR_PAGINA });
    });
    expect(await screen.findByText("Nadador club-chico 1 (R1)")).toBeInTheDocument();
  });
});

/**
 * EL BLOQUEO DE ESCRITURA, ATADO A SU CLUB.
 *
 * Un booleano global dejaba bloqueada la interfaz de todos los clubes mientras
 * una operación de otro siguiera en vuelo —y `fetch` no tiene tiempo de espera,
 * así que podía ser para siempre—. Y su `finally` desbloqueaba operaciones
 * posteriores que no eran suyas.
 */
describe("acción en curso: identidad por operación y por club", () => {
  function diferida<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  const botonFinalizar = () => screen.getAllByRole("button", { name: /Finalizar membresía/ })[0]!;

  it("una operación pendiente en A no bloquea B, y su final no desbloquea la de B", async () => {
    const enA = diferida<undefined>();
    const enB = diferida<undefined>();
    end.mockReturnValueOnce(enA.promesa as never).mockReturnValueOnce(enB.promesa as never);

    // (a) se inicia en A y queda pendiente.
    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");
    fireEvent.click(botonFinalizar());
    await waitFor(() => expect(end).toHaveBeenCalledTimes(1));
    expect(botonFinalizar(), "en A sí está bloqueado").toBeDisabled();

    // (b) se cambia a B.
    rerender(<ClubSwimmersSection clubId="club-chico" />);
    await screen.findByText("Nadador club-chico 1 (R1)");

    // (c) B puede iniciar SU operación: la de A no le afecta.
    expect(botonFinalizar(), "la operación de A no bloquea B").toBeEnabled();
    fireEvent.click(botonFinalizar());
    await waitFor(() => expect(end).toHaveBeenCalledTimes(2));
    expect(botonFinalizar()).toBeDisabled();

    // (d) resuelve la de A, tarde.
    await act(async () => {
      enA.resolver(undefined);
    });

    // (e) la de B sigue bloqueada: el `finally` de A solo limpia su propio id.
    expect(botonFinalizar(), "el final de A no puede desbloquear la de B").toBeDisabled();

    // (f) y al resolver la de B, se desbloquea.
    await act(async () => {
      enB.resolver(undefined);
    });
    await waitFor(() => expect(botonFinalizar()).toBeEnabled());
  });

  it("lo mismo para la ASIGNACIÓN, que tiene su propio camino", async () => {
    const enA = diferida<undefined>();
    const enB = diferida<undefined>();
    assignDirectly.mockReturnValueOnce(enA.promesa as never).mockReturnValueOnce(enB.promesa as never);

    async function sugerir() {
      const input = screen.getAllByRole("textbox")[0]!;
      fireEvent.change(input, { target: { value: "persona" } });
      return screen.findByText("Persona 1 (RP1)");
    }

    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");
    fireEvent.click(await sugerir());
    await waitFor(() => expect(assignDirectly).toHaveBeenCalledTimes(1));

    rerender(<ClubSwimmersSection clubId="club-chico" />);
    await screen.findByText("Nadador club-chico 1 (R1)");

    // B puede asignar aunque la de A siga en vuelo.
    fireEvent.click(await sugerir());
    await waitFor(() => expect(assignDirectly).toHaveBeenCalledTimes(2));
    expect(assignDirectly.mock.calls[1]![0], "y su club es el visible").toBe("club-chico");

    await act(async () => {
      enA.resolver(undefined);
    });
    // La de B sigue en curso: un tercer clic no manda nada.
    fireEvent.click(await sugerir());
    expect(assignDirectly).toHaveBeenCalledTimes(2);

    await act(async () => {
      enB.resolver(undefined);
    });
  });
});

/**
 * RESPUESTAS DE LA TABLA QUE NO ENCAJAN. Antes se aplicaban tal cual: una página
 * repetida hacía girar la navegación en el vacío y un `total` disparatado dejaba
 * el pie de página calculando sobre números sin sentido.
 */
describe("la tabla valida la respuesta antes de aplicarla", () => {
  const reintentar = () => screen.getByRole("button", { name: /Reintentar/ });

  it("PÁGINA distinta de la pedida: error, sin filas, con reintento", async () => {
    /**
     * El servidor ignora `page` y devuelve siempre la primera. La respuesta es
     * coherente en sí misma —20 de 45 en la página 1—, así que lo único que la
     * delata es el número de página.
     */
    assignmentsList.mockImplementation(async () => ({
      items: Array.from({ length: POR_PAGINA }, (_, i) => membresia("club-grande", i + 1)),
      total: 45,
      page: 1,
      pageSize: POR_PAGINA,
    }));

    render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");

    fireEvent.click(siguiente());

    expect(await screen.findByText(/Se pidió la página 2 del plantel y llegó la 1/)).toBeInTheDocument();
    expect(screen.queryByText("Nadador club-grande 1 (R1)"), "las filas se retiran").not.toBeInTheDocument();
    expect(reintentar()).toBeInTheDocument();
  });

  it("TOTAL inválido", async () => {
    assignmentsList.mockImplementation(async ({ page = 1 }: { page?: number } = {}) => ({
      items: [membresia("club-grande", 1)],
      total: Number.NaN,
      page,
      pageSize: POR_PAGINA,
    }));

    render(<ClubSwimmersSection clubId="club-grande" />);
    expect(await screen.findByText(/total inválido/)).toBeInTheDocument();
    expect(screen.queryByText("Nadador club-grande 1 (R1)")).not.toBeInTheDocument();
  });

  it("TAMAÑO de página inválido", async () => {
    assignmentsList.mockImplementation(async ({ page = 1 }: { page?: number } = {}) => ({
      items: [],
      total: 10,
      page,
      pageSize: 0,
    }));

    render(<ClubSwimmersSection clubId="club-grande" />);
    expect(await screen.findByText(/tamaño de página inválido/)).toBeInTheDocument();
  });

  it("MÁS filas de las que dice su tamaño", async () => {
    assignmentsList.mockImplementation(async ({ page = 1 }: { page?: number } = {}) => ({
      items: [membresia("club-grande", 1), membresia("club-grande", 2)],
      total: 2,
      page,
      pageSize: 1,
    }));

    render(<ClubSwimmersSection clubId="club-grande" />);
    expect(await screen.findByText(/más membresías de las que dice su tamaño/)).toBeInTheDocument();
  });

  it("`items` que no es una lista", async () => {
    // El tipo promete un array; se fuerza para probar qué pasa si el servidor
    // incumple su propio contrato.
    assignmentsList.mockImplementation(
      async ({ page = 1 }: { page?: number } = {}) =>
        ({ items: null, total: 5, page, pageSize: POR_PAGINA }) as never
    );

    render(<ClubSwimmersSection clubId="club-grande" />);
    expect(await screen.findByText(/no trae una lista de membresías/)).toBeInTheDocument();
  });
});

/**
 * DOS OPERACIONES EN VUELO, UNA POR CLUB.
 *
 * Con un único `{id, clubId}`, iniciar B1 **borraba** el registro de A1: al
 * volver a A, la interfaz creía que no había nada en curso y dejaba lanzar A2,
 * con dos escrituras simultáneas sobre el mismo club.
 */
describe("registro de operaciones POR CLUB", () => {
  function diferida<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  const botonFinalizar = () => screen.getAllByRole("button", { name: /Finalizar membresía/ })[0]!;

  it("A1 pendiente + B1 pendiente: al volver a A NO se puede lanzar A2", async () => {
    const a1 = diferida<undefined>();
    const b1 = diferida<undefined>();
    end.mockReturnValueOnce(a1.promesa as never).mockReturnValueOnce(b1.promesa as never);

    // A1 pendiente.
    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");
    fireEvent.click(botonFinalizar());
    await waitFor(() => expect(end).toHaveBeenCalledTimes(1));

    // Cambiar a B e iniciar B1: la de A no le afecta.
    rerender(<ClubSwimmersSection clubId="club-chico" />);
    await screen.findByText("Nadador club-chico 1 (R1)");
    expect(botonFinalizar()).toBeEnabled();
    fireEvent.click(botonFinalizar());
    await waitFor(() => expect(end).toHaveBeenCalledTimes(2));

    // Volver a A: A1 SIGUE en vuelo, así que A tiene que estar bloqueado.
    rerender(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");
    expect(botonFinalizar(), "A1 sigue pendiente: A está bloqueado").toBeDisabled();

    // Intentar A2 igualmente: ni siquiera con un clic forzado sale la petición.
    fireEvent.click(botonFinalizar());
    expect(end, "A2 no puede enviarse").toHaveBeenCalledTimes(2);

    // Resolver B1 no desbloquea A.
    await act(async () => {
      b1.resolver(undefined);
    });
    expect(botonFinalizar(), "resolver B no toca la entrada de A").toBeDisabled();

    // Resolver A1 sí.
    await act(async () => {
      a1.resolver(undefined);
    });
    await waitFor(() => expect(botonFinalizar()).toBeEnabled());
  });

  it("lo mismo con la ASIGNACIÓN", async () => {
    const a1 = diferida<undefined>();
    const b1 = diferida<undefined>();
    assignDirectly.mockReturnValueOnce(a1.promesa as never).mockReturnValueOnce(b1.promesa as never);

    async function sugerir() {
      const input = screen.getAllByRole("textbox")[0]!;
      fireEvent.change(input, { target: { value: "persona" } });
      return screen.findByText("Persona 1 (RP1)");
    }

    const { rerender } = render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");
    fireEvent.click(await sugerir());
    await waitFor(() => expect(assignDirectly).toHaveBeenCalledTimes(1));

    rerender(<ClubSwimmersSection clubId="club-chico" />);
    await screen.findByText("Nadador club-chico 1 (R1)");
    fireEvent.click(await sugerir());
    await waitFor(() => expect(assignDirectly).toHaveBeenCalledTimes(2));

    // De vuelta en A, con A1 aún en vuelo: no sale una segunda.
    rerender(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");
    fireEvent.click(await sugerir());
    expect(assignDirectly, "A2 no puede enviarse").toHaveBeenCalledTimes(2);

    await act(async () => {
      b1.resolver(undefined);
    });
    fireEvent.click(await sugerir());
    expect(assignDirectly, "resolver B tampoco libera A").toHaveBeenCalledTimes(2);

    // Al resolver A1 sí se libera la entrada de A.
    await act(async () => {
      a1.resolver(undefined);
    });

    /**
     * Y entonces A2 SÍ sale. La sugerencia hay que volver a generarla: una
     * asignación correcta limpia el buscador, así que el listado de personas ya
     * no está en pantalla.
     */
    fireEvent.click(await sugerir());
    await waitFor(() => expect(assignDirectly, "A2 ya puede enviarse").toHaveBeenCalledTimes(3));
    expect(assignDirectly.mock.calls[2]![0], "y va al club A").toBe("club-grande");
  });
});

/**
 * TRUNCACIÓN QUE EL VALIDADOR ANTERIOR DEJABA PASAR.
 */
describe("validación estricta de la página del plantel", () => {
  it("CASO CRÍTICO: se piden 20 y el servidor dice pageSize=100 con total=45", async () => {
    /**
     * Con 20 filas devueltas y `pageSize: 100`, el pie calcula `1 * 100 >= 45` y
     * **deshabilita "Siguiente"**: 25 membresías desaparecen sin aviso. Es
     * truncación silenciosa, exactamente lo que este hallazgo persigue.
     */
    assignmentsList.mockImplementation(async ({ page = 1 }: { page?: number } = {}) => ({
      items: Array.from({ length: 20 }, (_, i) => membresia("club-grande", i + 1)),
      total: 45,
      page,
      pageSize: 100,
    }));

    render(<ClubSwimmersSection clubId="club-grande" />);

    expect(await screen.findByText(/Se pidieron 20 membresías por página y el servidor informa 100/)).toBeInTheDocument();
    expect(screen.queryByText("Nadador club-grande 1 (R1)"), "no se pinta una tabla truncada").not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reintentar/ })).toBeInTheDocument();
  });

  it("TOTAL 0 con una fila", async () => {
    assignmentsList.mockImplementation(async ({ page = 1 }: { page?: number } = {}) => ({
      items: [membresia("club-grande", 1)],
      total: 0,
      page,
      pageSize: POR_PAGINA,
    }));

    render(<ClubSwimmersSection clubId="club-grande" />);
    expect(await screen.findByText(/informa 0 membresías y sin embargo devolvió 1/)).toBeInTheDocument();
  });

  it("FILA fuera del total declarado", async () => {
    // Página 1 con 5 filas y un total de 3: dos sobran.
    assignmentsList.mockImplementation(async ({ page = 1 }: { page?: number } = {}) => ({
      items: Array.from({ length: 5 }, (_, i) => membresia("club-grande", i + 1)),
      total: 3,
      page,
      pageSize: POR_PAGINA,
    }));

    render(<ClubSwimmersSection clubId="club-grande" />);
    expect(await screen.findByText(/solo quedaban 3/)).toBeInTheDocument();
  });

  it("PÁGINA INTERMEDIA corta", async () => {
    assignmentsList.mockImplementation(async ({ page = 1 }: { page?: number } = {}) => {
      if (page === 1) {
        return {
          items: Array.from({ length: POR_PAGINA }, (_, i) => membresia("club-grande", i + 1)),
          total: 45,
          page,
          pageSize: POR_PAGINA,
        };
      }
      // La 2 viene con 5 de 20 aunque el total dice que quedan 25.
      return {
        items: Array.from({ length: 5 }, (_, i) => membresia("club-grande", 20 + i + 1)),
        total: 45,
        page,
        pageSize: POR_PAGINA,
      };
    });

    render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");
    fireEvent.click(siguiente());

    expect(await screen.findByText(/llegó incompleta \(5 de 20\)/)).toBeInTheDocument();
  });

  it("ITEM nulo", async () => {
    assignmentsList.mockImplementation(
      async ({ page = 1 }: { page?: number } = {}) =>
        ({ items: [null], total: 1, page, pageSize: POR_PAGINA }) as never
    );

    render(<ClubSwimmersSection clubId="club-grande" />);
    expect(await screen.findByText(/membresía que no es un objeto/)).toBeInTheDocument();
  });

  it("ITEM sin `person`", async () => {
    assignmentsList.mockImplementation(
      async ({ page = 1 }: { page?: number } = {}) =>
        ({
          items: [{ id: "m1", status: "active", startDate: "2026-01-01", endDate: null }],
          total: 1,
          page,
          pageSize: POR_PAGINA,
        }) as never
    );

    render(<ClubSwimmersSection clubId="club-grande" />);
    expect(await screen.findByText(/no trae los datos del nadador/)).toBeInTheDocument();
  });

  it("ESTADO desconocido", async () => {
    assignmentsList.mockImplementation(
      async ({ page = 1 }: { page?: number } = {}) =>
        ({
          items: [{ ...membresia("club-grande", 1), status: "inventado" }],
          total: 1,
          page,
          pageSize: POR_PAGINA,
        }) as never
    );

    render(<ClubSwimmersSection clubId="club-grande" />);
    expect(await screen.findByText(/estado desconocido/)).toBeInTheDocument();
  });

  it("FECHA de inicio ilegible", async () => {
    assignmentsList.mockImplementation(
      async ({ page = 1 }: { page?: number } = {}) =>
        ({
          items: [{ ...membresia("club-grande", 1), startDate: "el martes" }],
          total: 1,
          page,
          pageSize: POR_PAGINA,
        }) as never
    );

    render(<ClubSwimmersSection clubId="club-grande" />);
    expect(await screen.findByText(/fecha de inicio ilegible/)).toBeInTheDocument();
  });
});

describe("la página se corrige también cuando el total pasa a CERO", () => {
  it("desde la página 3, una respuesta vacía con total 0 devuelve a la 1", async () => {
    /**
     * Exigir `total > 0` dejaba a quien estuviera en la página 3 atrapado: tabla
     * vacía y **sin pie de navegación**, porque el pie solo se pinta con
     * `total > 0`. No había forma de volver.
     */
    let total = 45;
    assignmentsList.mockImplementation(async ({ clubId = "club-grande", page = 1 }: { clubId?: string; page?: number } = {}) => {
      const desde = (page - 1) * POR_PAGINA;
      const cuantos = Math.max(0, Math.min(POR_PAGINA, total - desde));
      return {
        items: Array.from({ length: cuantos }, (_, i) => membresia(clubId, desde + i + 1)),
        total,
        page,
        pageSize: POR_PAGINA,
      };
    });

    render(<ClubSwimmersSection clubId="club-grande" />);
    await screen.findByText("Nadador club-grande 1 (R1)");
    fireEvent.click(siguiente());
    await screen.findByText("Nadador club-grande 21 (R21)");
    fireEvent.click(siguiente());
    await screen.findByText("Nadador club-grande 41 (R41)");

    // El club se queda sin membresías activas mientras se está en la página 3.
    total = 0;
    fireEvent.click(screen.getAllByRole("button", { name: /Finalizar membresía/ })[0]!);

    await waitFor(() => expect(screen.getByText(/aún no tiene nadadores asignados/)).toBeInTheDocument());
    // Y la última petición fue de la página 1: no quedó atrapada en la 3.
    const ultima = assignmentsList.mock.calls[assignmentsList.mock.calls.length - 1]![0];
    expect(ultima).toMatchObject({ page: 1 });
  });
});
