/**
 * Fase 6, hallazgo 28 — NINGUNA PERSONA PUEDE QUEDAR FUERA DE ALCANCE.
 *
 * Avisar de que hay 137 coincidencias y mostrar 20 informa del problema pero no
 * lo resuelve: la persona nº 21 seguía siendo inalcanzable. Ahora se acumulan
 * páginas a petición, y estas pruebas lo comprueban **llegando de verdad hasta la
 * tercera página y seleccionando a alguien de allí**.
 *
 * Se prueban los tres buscadores —`PersonPicker`, `PersonMultiPicker` y el del
 * plantel en `ClubSwimmersSection`— porque los tres tenían el mismo defecto y
 * ahora comparten el mismo hook.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { PersonPicker } from "../modules/clubs/PersonPicker";
import { PersonMultiPicker } from "../modules/clubs/PersonMultiPicker";
import { ClubSwimmersSection } from "../modules/swimmer-assignment/ClubSwimmersSection";

/** 41 coincidencias con páginas de 20: hacen falta TRES páginas. */
const TOTAL = 41;
const POR_PAGINA = 20;

const personas = Array.from({ length: TOTAL }, (_, i) => ({
  id: `p-${i + 1}`,
  fullName: `Persona ${i + 1}`,
  run: `R${i + 1}`,
}));

/** Servidor por omisión: pagina de verdad. Cada prueba puede sustituirlo. */
const paginaNormal = async ({ page = 1 }: { search?: string; page?: number } = {}) => {
  const desde = (page - 1) * POR_PAGINA;
  return { items: personas.slice(desde, desde + POR_PAGINA), total: TOTAL, page, pageSize: POR_PAGINA };
};

const personsList = vi.fn(paginaNormal);
const personsGet = vi.fn(async (id: string) => personas.find((p) => p.id === id)!);

vi.mock("../modules/persons/personsApi", () => ({
  usePersonsApi: () => ({ list: personsList, get: personsGet }),
}));

const assignDirectly = vi.fn(async () => undefined);
vi.mock("../modules/swimmer-assignment/assignmentApi", () => ({
  useSwimmerAssignmentApi: () => ({
    list: vi.fn(async (p: { page?: number } = {}) => ({ items: [], total: 0, page: p.page ?? 1, pageSize: 20 })),
    assignDirectly,
    endMembership: vi.fn(),
  }),
}));

/** Teclea y deja pasar el retardo de la búsqueda. */
async function buscar(texto: string) {
  const input = screen.getAllByRole("textbox")[0]!;
  fireEvent.change(input, { target: { value: texto } });
  await act(() => new Promise((r) => setTimeout(r, 300)));
}

const cargarMas = () => fireEvent.click(screen.getByRole("button", { name: /Cargar más resultados/ }));

beforeEach(() => {
  // `mockClear` NO restaura la implementación: sin esto, el servidor que una
  // prueba sustituye se filtra a las siguientes.
  personsList.mockReset();
  personsList.mockImplementation(paginaNormal);
  assignDirectly.mockClear();
});

describe("PersonPicker: se puede llegar a la página 3 y elegir a alguien de allí", () => {
  it(`con ${TOTAL} coincidencias, acumula hasta la última y la selección funciona`, async () => {
    const onChange = vi.fn();
    render(<PersonPicker label="Persona" value={null} onChange={onChange} />);

    await buscar("persona");

    // Primera página: 20 de 41, y el botón para seguir.
    expect(await screen.findByText(/Se muestran 20 de 41 coincidencias/)).toBeInTheDocument();
    expect(screen.queryByText("Persona 41 (R41)")).not.toBeInTheDocument();

    cargarMas();
    await waitFor(() => expect(screen.getByText(/Se muestran 40 de 41/)).toBeInTheDocument());

    cargarMas();
    await waitFor(() => expect(screen.getByText(/Se muestran 41 de 41/)).toBeInTheDocument());

    // La 41 estaba en la TERCERA página: antes era inalcanzable.
    fireEvent.click(screen.getByText("Persona 41 (R41)"));
    expect(onChange).toHaveBeenCalledWith("p-41");

    // Con todo cargado, el botón desaparece.
    expect(screen.queryByRole("button", { name: /Cargar más resultados/ })).not.toBeInTheDocument();
    expect(personsList.mock.calls.map((c) => c[0]?.page)).toEqual([1, 2, 3]);
  });

  it("acumula SIN duplicados aunque el servidor repita un registro", async () => {
    // Desplazamiento por un borrado concurrente: `p-20` vuelve en la página 2.
    personsList.mockImplementation(async ({ page = 1 } = {}) => {
      if (page === 1) return { items: personas.slice(0, 20), total: 41, page, pageSize: 20 };
      return { items: [personas[19]!, ...personas.slice(20, 39)], total: 41, page, pageSize: 20 };
    });

    render(<PersonPicker label="Persona" value={null} onChange={vi.fn()} />);
    await buscar("persona");
    cargarMas();

    await waitFor(() => expect(screen.getByText(/Se muestran 39 de 41/)).toBeInTheDocument());
    expect(screen.getAllByText("Persona 20 (R20)"), "sin repetidos").toHaveLength(1);
  });

  it("una respuesta LENTA de una consulta anterior no pisa la nueva", async () => {
    /**
     * Al teclear se disparan búsquedas sucesivas y las respuestas no vuelven en
     * orden. Sin descartar las viejas, en pantalla quedaban los resultados de una
     * consulta que el usuario ya no estaba escribiendo.
     */
    let resolverLenta: ((v: unknown) => void) | null = null;
    personsList.mockImplementation(async ({ search }: { search?: string; page?: number } = {}) => {
      if (search === "lenta") {
        return new Promise((r) => {
          resolverLenta = r as (v: unknown) => void;
        }) as never;
      }
      return { items: [{ id: "nueva", fullName: "Resultado Nuevo", run: "1-9" }], total: 1, page: 1, pageSize: 20 };
    });

    render(<PersonPicker label="Persona" value={null} onChange={vi.fn()} />);
    await buscar("lenta");
    await buscar("rapida");
    await screen.findByText("Resultado Nuevo (1-9)");

    // Ahora contesta la vieja, tarde.
    await act(async () => {
      resolverLenta?.({
        items: [{ id: "vieja", fullName: "Resultado Viejo", run: "1-1" }],
        total: 1,
        page: 1,
        pageSize: 20,
      });
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.getByText("Resultado Nuevo (1-9)")).toBeInTheDocument();
    expect(screen.queryByText("Resultado Viejo (1-1)"), "la respuesta atrasada se descarta").not.toBeInTheDocument();
  });

  it("al BORRAR la consulta se limpian resultados y contador", async () => {
    render(<PersonPicker label="Persona" value={null} onChange={vi.fn()} />);
    await buscar("persona");
    await screen.findByText(/Se muestran 20 de 41/);

    await buscar("p"); // menos de dos caracteres

    expect(screen.queryByText(/Se muestran/), "el contador no puede sobrevivir").not.toBeInTheDocument();
    expect(screen.queryByText("Persona 1 (R1)"), "ni las opciones de la consulta anterior").not.toBeInTheDocument();
  });

  it("un ERROR en una página posterior se muestra y no deja opciones a medias", async () => {
    personsList.mockImplementation(async ({ page = 1 } = {}) => {
      if (page === 1) return { items: personas.slice(0, 20), total: 41, page, pageSize: 20 };
      throw new Error("500 al pedir la página 2");
    });

    render(<PersonPicker label="Persona" value={null} onChange={vi.fn()} />);
    await buscar("persona");
    await screen.findByText(/Se muestran 20 de 41/);

    cargarMas();

    /**
     * Conservar las 20 de la primera página junto al aviso "hay más" haría creer
     * que la lista está truncada, cuando lo que pasó es que la búsqueda falló.
     */
    expect(await screen.findByText(/500 al pedir la página 2/)).toBeInTheDocument();
    expect(screen.queryByText(/Se muestran/)).not.toBeInTheDocument();
  });
});

describe("PersonMultiPicker: acumula y descuenta a los ya seleccionados", () => {
  it("llega a la página 3 y no reofrece a quien ya está elegido", async () => {
    const onChange = vi.fn();
    render(<PersonMultiPicker label="Delegados" values={["p-1"]} onChange={onChange} />);

    await buscar("persona");

    // 20 traídos, pero `p-1` ya está elegido: se muestran 19.
    expect(await screen.findByText(/Se muestran 19 de 41 coincidencias/)).toBeInTheDocument();
    // Aparece arriba como seleccionado (un `span`), pero NO entre las sugerencias.
    const sugerencias = () => screen.queryAllByRole("listitem").map((li) => li.textContent);
    expect(sugerencias(), "el ya elegido no se reofrece").not.toContain("Persona 1 (R1)");

    cargarMas();
    await waitFor(() => expect(screen.getByText(/Se muestran 39 de 41/)).toBeInTheDocument());
    cargarMas();
    await waitFor(() => expect(screen.getByText(/Se muestran 40 de 41/)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Persona 41 (R41)"));
    expect(onChange).toHaveBeenCalledWith(["p-1", "p-41"]);
  });
});

describe("ClubSwimmersSection: el buscador del plantel también acumula", () => {
  it("llega a la página 3 y asigna a un nadador de allí", async () => {
    render(<ClubSwimmersSection clubId="club-1" />);

    await buscar("persona");
    expect(await screen.findByText(/Se muestran 20 de 41 coincidencias/)).toBeInTheDocument();

    cargarMas();
    await waitFor(() => expect(screen.getByText(/Se muestran 40 de 41/)).toBeInTheDocument());
    cargarMas();
    await waitFor(() => expect(screen.getByText(/Se muestran 41 de 41/)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Persona 41 (R41)"));
    await waitFor(() => expect(assignDirectly).toHaveBeenCalledWith("club-1", "p-41"));
  });
});

/**
 * FAIL-CLOSED del hook. Cada uno de estos casos dejaba antes el botón "Cargar
 * más" activo indefinidamente: el usuario pulsaba y no pasaba nada, sin ninguna
 * explicación de por qué.
 */
describe("respuestas rotas: se detiene la navegación y se puede reintentar", () => {
  const reintentar = () => fireEvent.click(screen.getByRole("button", { name: /Reintentar/ }));

  async function primeraPaginaYLuego(segunda: () => Promise<any>) {
    personsList.mockImplementation(async ({ page = 1 } = {}) => {
      if (page === 1) return { items: personas.slice(0, 20), total: TOTAL, page, pageSize: POR_PAGINA };
      return segunda();
    });
    render(<PersonPicker label="Persona" value={null} onChange={vi.fn()} />);
    await buscar("persona");
    await screen.findByText(/Se muestran 20 de 41/);
    cargarMas();
  }

  it("PÁGINA REPETIDA: avisa de que no avanza y retira 'Cargar más'", async () => {
    await primeraPaginaYLuego(async () => ({ items: personas.slice(0, 20), total: TOTAL, page: 2, pageSize: POR_PAGINA }));

    expect(await screen.findByText(/La búsqueda no avanza/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cargar más resultados/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reintentar/ })).toBeInTheDocument();
  });

  it("PÁGINA VACÍA con resultados pendientes: la señala como incompleta", async () => {
    await primeraPaginaYLuego(async () => ({ items: [], total: TOTAL, page: 2, pageSize: POR_PAGINA }));

    /**
     * Una página que no se llena es la última por definición. Si además dice que
     * faltan 21 de 41, el reparto no cuadra: se detiene y se pide reiniciar,
     * porque reintentar la misma página no arreglaría un total que miente.
     */
    expect(await screen.findByText(/llegó incompleta \(0 de 20\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reiniciar búsqueda/ })).toBeInTheDocument();
  });

  it("PAGE INCORRECTO: rechaza la respuesta", async () => {
    // Un proxy que sirve de caché la página 1 haría girar en el vacío.
    await primeraPaginaYLuego(async () => ({ items: personas.slice(20, 40), total: TOTAL, page: 1, pageSize: POR_PAGINA }));

    expect(await screen.findByText(/Se pidió la página 2 y llegó la 1/)).toBeInTheDocument();
  });

  it("TOTAL inválido (NaN)", async () => {
    await primeraPaginaYLuego(async () => ({ items: personas.slice(20, 40), total: Number.NaN, page: 2, pageSize: POR_PAGINA }));

    expect(await screen.findByText(/total inválido/)).toBeInTheDocument();
  });

  it("TOTAL negativo", async () => {
    await primeraPaginaYLuego(async () => ({ items: personas.slice(20, 40), total: -3, page: 2, pageSize: POR_PAGINA }));

    expect(await screen.findByText(/total inválido/)).toBeInTheDocument();
  });

  it("ELEMENTO SIN ID: no se cuela una persona que no se puede deduplicar", async () => {
    await primeraPaginaYLuego(async () => ({
      items: [{ fullName: "Sin identificador", run: "X" }],
      total: TOTAL,
      page: 2,
      pageSize: POR_PAGINA,
    }));

    expect(await screen.findByText(/sin identificador/i)).toBeInTheDocument();
  });

  it("REINTENTAR después del error continúa donde estaba", async () => {
    /**
     * Sin esta acción la búsqueda quedaba bloqueada: el error retira "Cargar
     * más" y la única salida era volver a teclear la consulta entera.
     */
    let fallar = true;
    personsList.mockImplementation(async ({ page = 1 } = {}) => {
      if (page === 1) return { items: personas.slice(0, 20), total: TOTAL, page, pageSize: POR_PAGINA };
      if (fallar) {
        fallar = false;
        throw new Error("500 pasajero");
      }
      return { items: personas.slice(20, 40), total: TOTAL, page, pageSize: POR_PAGINA };
    });

    render(<PersonPicker label="Persona" value={null} onChange={vi.fn()} />);
    await buscar("persona");
    await screen.findByText(/Se muestran 20 de 41/);

    cargarMas();
    expect(await screen.findByText(/500 pasajero/)).toBeInTheDocument();

    reintentar();

    // Vuelve a pedir la MISMA página 2 y sigue acumulando desde donde estaba.
    await waitFor(() => expect(screen.getByText(/Se muestran 40 de 41/)).toBeInTheDocument());
    expect(screen.queryByText(/500 pasajero/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cargar más resultados/ })).toBeInTheDocument();
  });
});

/**
 * INVARIANTES DEL REPARTO. Un `total` que baja, un `pageSize` que cambia o más
 * personas de las declaradas significan que la paginación por desplazamiento se
 * movió bajo los pies: alguien insertó o borró mientras se recorría. Seguir
 * sumando páginas de dos repartos distintos produce una lista que no corresponde
 * a ningún estado real, y el contador lo delata («40 de 30»).
 */
describe("incoherencias del reparto: se detiene y se pide REINICIAR", () => {
  async function primeraYSegunda(segunda: () => Promise<any>) {
    personsList.mockImplementation(async ({ page = 1 } = {}) => {
      if (page === 1) return { items: personas.slice(0, 20), total: 30, page, pageSize: POR_PAGINA };
      return segunda();
    });
    render(<PersonPicker label="Persona" value={null} onChange={vi.fn()} />);
    await buscar("persona");
    await screen.findByText(/Se muestran 20 de 30/);
    cargarMas();
  }

  const botonReiniciar = () => screen.getByRole("button", { name: /Reiniciar búsqueda/ });

  it("40 acumulados con total=30: no acepta más de los declarados", async () => {
    await primeraYSegunda(async () => ({ items: personas.slice(20, 40), total: 30, page: 2, pageSize: POR_PAGINA }));

    expect(await screen.findByText(/devolvió 40 personas para un total declarado de 30/)).toBeInTheDocument();
    expect(botonReiniciar()).toBeInTheDocument();
    // Y el contador NO puede anunciar una lista completa que no lo es.
    expect(screen.queryByText(/Se muestran 40/)).not.toBeInTheDocument();
  });

  it("el total AUMENTA entre páginas", async () => {
    await primeraYSegunda(async () => ({ items: personas.slice(20, 40), total: 41, page: 2, pageSize: POR_PAGINA }));

    expect(await screen.findByText(/cambiaron mientras se cargaban \(antes 30, ahora 41\)/)).toBeInTheDocument();
    expect(botonReiniciar()).toBeInTheDocument();
  });

  it("el total DISMINUYE entre páginas", async () => {
    await primeraYSegunda(async () => ({ items: personas.slice(20, 25), total: 25, page: 2, pageSize: POR_PAGINA }));

    expect(await screen.findByText(/cambiaron mientras se cargaban \(antes 30, ahora 25\)/)).toBeInTheDocument();
  });

  it("el pageSize CAMBIA entre páginas", async () => {
    await primeraYSegunda(async () => ({ items: personas.slice(20, 30), total: 30, page: 2, pageSize: 10 }));

    expect(await screen.findByText(/tamaño de página cambió durante la búsqueda \(antes 20, ahora 10\)/)).toBeInTheDocument();
  });

  it("fullName inválido", async () => {
    personsList.mockImplementation(async () => ({
      items: [{ id: "p-1", fullName: "", run: "1-1" }],
      total: 1,
      page: 1,
      pageSize: 20,
    }));
    render(<PersonPicker label="Persona" value={null} onChange={vi.fn()} />);
    await buscar("persona");

    expect(await screen.findByText(/sin nombre/)).toBeInTheDocument();
  });

  it("run inválido", async () => {
    personsList.mockImplementation(async () => ({
      // El tipo dice `string`; se fuerza a propósito para probar qué pasa cuando
      // el servidor incumple su propio contrato.
      items: [{ id: "p-1", fullName: "Alguien", run: 12345 as unknown as string }],
      total: 1,
      page: 1,
      pageSize: 20,
    }));
    render(<PersonPicker label="Persona" value={null} onChange={vi.fn()} />);
    await buscar("persona");

    expect(await screen.findByText(/sin RUN/)).toBeInTheDocument();
  });

it("valores de SOLO ESPACIOS: id, nombre y RUN se rechazan igual que si faltaran", async () => {
    /**
     * `"   "` no es vacío para `!== ""`, pero en pantalla es un hueco. Un id de
     * espacios además rompería la deduplicación de forma silenciosa.
     */
    for (const [campo, item] of [
      ["identificador", { id: "   ", fullName: "Alguien", run: "1-1" }],
      ["nombre", { id: "p-1", fullName: "   ", run: "1-1" }],
      ["RUN", { id: "p-1", fullName: "Alguien", run: "  " }],
    ] as const) {
      personsList.mockImplementation(async () => ({ items: [item], total: 1, page: 1, pageSize: 20 }));
      const { unmount } = render(<PersonPicker label="Persona" value={null} onChange={vi.fn()} />);
      await buscar("persona");

      expect(await screen.findByText(new RegExp(`sin ${campo}`)), campo).toBeInTheDocument();
      unmount();
    }
  });

  it("REINICIAR tras la incoherencia empieza de cero y funciona", async () => {
    let primeraVez = true;
    personsList.mockImplementation(async ({ page = 1 } = {}) => {
      if (page === 1) return { items: personas.slice(0, 20), total: 30, page, pageSize: POR_PAGINA };
      if (primeraVez) {
        primeraVez = false;
        return { items: personas.slice(20, 40), total: 30, page: 2, pageSize: POR_PAGINA }; // 40 de 30
      }
      return { items: personas.slice(20, 30), total: 30, page: 2, pageSize: POR_PAGINA };
    });

    render(<PersonPicker label="Persona" value={null} onChange={vi.fn()} />);
    await buscar("persona");
    await screen.findByText(/Se muestran 20 de 30/);
    cargarMas();
    await screen.findByText(/para un total declarado de 30/);

    fireEvent.click(botonReiniciar());

    /**
     * Vuelve a la página 1 y descarta lo acumulado: no se conserva nada del
     * recorrido incoherente. Desde ahí se puede seguir con normalidad.
     */
    await waitFor(() => expect(screen.getByText(/Se muestran 20 de 30/)).toBeInTheDocument());
    expect(screen.queryByText(/total declarado/)).not.toBeInTheDocument();

    cargarMas();
    await waitFor(() => expect(screen.getByText(/Se muestran 30 de 30/)).toBeInTheDocument());
  });
});
