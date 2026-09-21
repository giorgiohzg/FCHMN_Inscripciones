/**
 * Fase 6, hallazgo 31 — EQUIVALENCIA FUNCIONAL antes de retirar las páginas, y
 * PAGINACIÓN VISIBLE del panel que las sustituyó.
 *
 * `RegistrationsListPage` y `RelayRegistrationsListPage` no tenían ruta, pero sí
 * tenían algo que ninguna pantalla accesible ofrecía: consultar inscripciones
 * **canceladas**. Estas pruebas fijan que esa capacidad existe ahora en el panel
 * que vive dentro de los Workspace, para poder borrar aquellos archivos sin
 * perder nada.
 *
 * Lo que se comprueba es el CONTRATO del panel, no su decoración: qué pide al
 * servidor, cómo navega, qué respuestas rechaza y que no ofrezca acciones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { PanelDeHistorial, TAMANO_DE_PAGINA, type FilaDeHistorial, type PaginaDeHistorial } from "./PanelDeHistorial";

const filaDe = (id: string, cancelada: boolean): FilaDeHistorial => ({
  id,
  cancelada,
  celdas: [`Nadador ${id}`, "Club Uno"],
});

/** Una página coherente de `n` filas dentro de un conjunto de `total`. */
function paginaDe(page: number, total: number, cancelada = true): PaginaDeHistorial {
  const desde = (page - 1) * TAMANO_DE_PAGINA;
  const cuantas = Math.max(0, Math.min(TAMANO_DE_PAGINA, total - desde));
  return {
    filas: Array.from({ length: cuantas }, (_, i) => filaDe(`r${desde + i + 1}`, cancelada)),
    total,
    page,
    pageSize: TAMANO_DE_PAGINA,
  };
}

type Cargar = (
  estado: "confirmed" | "cancelled" | undefined,
  page: number,
  pageSize: number
) => Promise<PaginaDeHistorial>;

function montar(cargar: Cargar, dependencias: unknown[] = ["comp-1", "club-1"]) {
  return render(
    <PanelDeHistorial
      nombrePlural="inscripciones"
      dependencias={dependencias}
      encabezados={["Nadador", "Club"]}
      cargar={cargar}
    />
  );
}

const abrir = () => fireEvent.click(screen.getByRole("button", { name: /Ver historial/ }));
const siguiente = () => screen.getByRole("button", { name: "Siguiente" });
const anterior = () => screen.getByRole("button", { name: "Anterior" });

describe("el historial recupera la consulta de canceladas", () => {
  it("al abrirlo pide las CANCELADAS y las muestra", async () => {
    const cargar = vi.fn(async () => paginaDe(1, 2));
    montar(cargar);

    abrir();

    // Por omisión pregunta justo por lo que no se podía ver en ningún sitio.
    await waitFor(() => expect(cargar).toHaveBeenCalledWith("cancelled", 1, TAMANO_DE_PAGINA));
    expect(await screen.findByText("Nadador r1")).toBeInTheDocument();
    expect(screen.getAllByText("Cancelada")).toHaveLength(2);
  });

  it("permite cambiar a Confirmadas y a Todas", async () => {
    const cargar = vi.fn(async () => paginaDe(1, 1, false));
    montar(cargar);
    abrir();
    await waitFor(() => expect(cargar).toHaveBeenCalledWith("cancelled", 1, TAMANO_DE_PAGINA));

    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "confirmed" } });
    await waitFor(() => expect(cargar).toHaveBeenCalledWith("confirmed", 1, TAMANO_DE_PAGINA));

    // "Todas" se traduce en NO enviar filtro de estado, como hacía la página
    // sin ruta con su opción vacía.
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "todas" } });
    await waitFor(() => expect(cargar).toHaveBeenCalledWith(undefined, 1, TAMANO_DE_PAGINA));
  });

  it("es de SOLO LECTURA: sin botones de acción sobre las filas", async () => {
    const cargar = vi.fn(async () => paginaDe(1, 1));
    montar(cargar);
    abrir();
    await screen.findByText("Nadador r1");

    /**
     * Una inscripción cancelada no se edita ni se vuelve a cancelar. Los únicos
     * controles del panel son el de abrir/cerrar, el selector de estado y la
     * navegación.
     */
    const botones = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(botones.filter((t) => /cancelar|editar|eliminar/i.test(t))).toEqual([]);
  });

  it("no carga nada hasta que se abre: no penaliza al Workspace", async () => {
    const cargar = vi.fn(async () => paginaDe(1, 0));
    montar(cargar);

    expect(cargar).not.toHaveBeenCalled();
    abrir();
    await waitFor(() => expect(cargar).toHaveBeenCalledTimes(1));
  });

  it("MUESTRA el error si la página no se puede dar por buena", async () => {
    /**
     * El cargador lanza cuando la página recibida no es la pedida o no encaja.
     * Ese error tiene que verse: una página equivocada de un historial es peor
     * que ninguna, porque quien consulta concluye que la inscripción no existió.
     */
    const cargar = vi.fn(async () => {
      throw new Error("Se pidió la página 2 y el servidor devolvió la 1.");
    });
    montar(cargar);
    abrir();

    expect(await screen.findByText(/el servidor devolvió la 1/)).toBeInTheDocument();
    expect(screen.queryByRole("table"), "no se pinta una tabla dudosa").not.toBeInTheDocument();
  });

  it("con cero resultados lo dice, en vez de dejar la tabla en blanco", async () => {
    montar(async () => paginaDe(1, 0));
    abrir();
    expect(await screen.findByText(/Sin inscripciones para este filtro/)).toBeInTheDocument();
  });
});

/**
 * PAGINACIÓN VISIBLE. La primera versión traía el historial ENTERO con
 * `traerTodasLasPaginas`, que su propio archivo reserva para selectores y
 * conjuntos de decisión, **no para tablas** (`paginacion.ts:16-20`): hasta 100
 * peticiones por apertura, hasta 10 000 filas en el DOM, y fallo completo por
 * encima de esa cifra en vez de mostrar la primera página.
 */
describe("el historial pagina como una tabla", () => {
  it("abrirlo pide UNA sola página: la primera", async () => {
    const cargar = vi.fn(async (_e: unknown, page: number) => paginaDe(page, 45));
    montar(cargar as never);
    abrir();

    await waitFor(() => expect(screen.getByText("Mostrando 1–20 de 45")).toBeInTheDocument());

    expect(cargar, "una petición, no tres").toHaveBeenCalledTimes(1);
    expect(cargar.mock.calls[0]![1]).toBe(1);
    expect(screen.getAllByText("Cancelada"), "solo las filas de esta página").toHaveLength(TAMANO_DE_PAGINA);
  });

  it("«Siguiente» pide exactamente la página siguiente, y «Anterior» vuelve", async () => {
    const cargar = vi.fn(async (_e: unknown, page: number) => paginaDe(page, 45));
    montar(cargar as never);
    abrir();
    await screen.findByText("Nadador r1");

    fireEvent.click(siguiente());
    expect(await screen.findByText("Nadador r21")).toBeInTheDocument();
    expect(cargar.mock.calls.map((c) => c[1])).toEqual([1, 2]);

    fireEvent.click(siguiente());
    expect(await screen.findByText("Nadador r41")).toBeInTheDocument();
    expect(cargar.mock.calls.map((c) => c[1])).toEqual([1, 2, 3]);

    fireEvent.click(anterior());
    expect(await screen.findByText("Nadador r21")).toBeInTheDocument();
    expect(cargar.mock.calls.map((c) => c[1])).toEqual([1, 2, 3, 2]);
  });

  it("los controles respetan `total` y `pageSize`", async () => {
    const cargar = vi.fn(async (_e: unknown, page: number) => paginaDe(page, 45));
    montar(cargar as never);
    abrir();
    await screen.findByText("Nadador r1");

    // 45 en páginas de 20 son tres páginas.
    expect(screen.getByText("Página 1 de 3")).toBeInTheDocument();
    expect(anterior(), "en la primera no hay anterior").toBeDisabled();
    expect(siguiente()).toBeEnabled();

    fireEvent.click(siguiente());
    await screen.findByText("Nadador r21");
    expect(anterior()).toBeEnabled();
    expect(siguiente()).toBeEnabled();

    fireEvent.click(siguiente());
    await screen.findByText("Nadador r41");
    expect(screen.getByText("Mostrando 41–45 de 45")).toBeInTheDocument();
    expect(siguiente(), "en la última no hay siguiente").toBeDisabled();
  });

  it("NO pide todas las páginas por su cuenta", async () => {
    const cargar = vi.fn(async (_e: unknown, page: number) => paginaDe(page, 1000));
    montar(cargar as never);
    abrir();
    await screen.findByText("Nadador r1");

    // Con 1000 registros, el recorrido completo habría hecho 10 peticiones de 100
    // —o 50 de 20— antes de pintar nada. Aquí solo se pide lo que se muestra.
    expect(cargar).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Cancelada")).toHaveLength(TAMANO_DE_PAGINA);
    expect(screen.getByText("Página 1 de 50")).toBeInTheDocument();
  });

  it("cambiar de ESTADO vuelve a la página 1", async () => {
    const cargar = vi.fn(async (_e: unknown, page: number) => paginaDe(page, 45));
    montar(cargar as never);
    abrir();
    await screen.findByText("Nadador r1");
    fireEvent.click(siguiente());
    await screen.findByText("Nadador r21");

    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "confirmed" } });

    await waitFor(() => expect(cargar).toHaveBeenCalledWith("confirmed", 1, TAMANO_DE_PAGINA));
    expect(await screen.findByText("Nadador r1")).toBeInTheDocument();
    expect(screen.getByText("Página 1 de 3")).toBeInTheDocument();
  });

  /**
   * Las DOS dependencias, no solo la competencia: la versión anterior de esta
   * prueba solo cambiaba `comp-1` → `comp-2` y dejaba el club sin ejercitar.
   */
  it.each([
    ["COMPETENCIA", ["comp-2", "club-1"]],
    ["CLUB", ["comp-1", "club-2"]],
  ])("cambiar de %s vuelve a la página 1", async (_que, nuevasDependencias) => {
    const cargar = vi.fn(async (_e: unknown, page: number) => paginaDe(page, 45));
    const { rerender } = montar(cargar as never, ["comp-1", "club-1"]);
    abrir();
    await screen.findByText("Nadador r1");
    fireEvent.click(siguiente());
    await screen.findByText("Nadador r21");
    const llamadasAntes = cargar.mock.calls.length;

    rerender(
      <PanelDeHistorial
        nombrePlural="inscripciones"
        dependencias={nuevasDependencias as unknown[]}
        encabezados={["Nadador", "Club"]}
        cargar={cargar as never}
      />
    );

    await waitFor(() => expect(cargar.mock.calls.length).toBeGreaterThan(llamadasAntes));
    expect(cargar.mock.calls[cargar.mock.calls.length - 1]![1], "lo nuevo empieza en la 1").toBe(1);
    expect(await screen.findByText("Página 1 de 3")).toBeInTheDocument();
  });

  it("si el conjunto ENCOGE, no deja al usuario en una página inexistente", async () => {
    /**
     * Sin esta corrección quedaría una tabla vacía y **sin pie de navegación**
     * —el pie solo se pinta con `total > 0`—: sin forma de volver.
     */
    let total = 45;
    const cargar = vi.fn(async (_e: unknown, page: number) => paginaDe(page, total));
    montar(cargar as never);
    abrir();
    await screen.findByText("Nadador r1");
    fireEvent.click(siguiente());
    await screen.findByText("Nadador r21");

    // Alguien cancela en masa mientras se navega: la página 3 deja de existir.
    total = 15;
    fireEvent.click(siguiente());

    // La respuesta de la 3 llega vacía, y el panel vuelve a la última válida.
    await waitFor(() => expect(screen.getByText("Página 1 de 1")).toBeInTheDocument());
    expect(cargar.mock.calls.map((c) => c[1]), "pidió la 3, se corrigió y pidió la 1").toEqual([1, 2, 3, 1]);
    expect(screen.getByText("Mostrando 1–15 de 15")).toBeInTheDocument();
  });
});

/**
 * CARRERAS ENTRE VISTAS. Una respuesta que llega tarde no puede alterar lo que se
 * está mirando. El diseño vigente lo resuelve en tres piezas, ninguna de las
 * cuales depende del momento en que corran los efectos:
 *
 *   1. La `key` del contenido separa CONJUNTOS —competencia, club, estado—:
 *      cambiar de conjunto desmonta la instancia anterior con su página, su
 *      petición y su resultado.
 *   2. La etiqueta `page` del desenlace separa PÁGINAS dentro de un conjunto: un
 *      resultado solo se pinta si su etiqueta es la página actual.
 *   3. La limpieza del efecto (`vigente = false`) impide actualizar una instancia
 *      desmontada o cuyo efecto ya dejó de estar vigente.
 */
describe("una respuesta atrasada no puede escribir en la vista actual", () => {
  function diferida<T>() {
    let resolver!: (v: T) => void;
    let rechazar!: (e: unknown) => void;
    const promesa = new Promise<T>((res, rej) => {
      resolver = res;
      rechazar = rej;
    });
    return { promesa, resolver, rechazar };
  }

  const filaUnica = (id: string, total = 1): PaginaDeHistorial => ({
    filas: [filaDe(id, true)],
    total,
    page: 1,
    pageSize: TAMANO_DE_PAGINA,
  });

  it("(a) la respuesta de la competencia A no pinta filas en la competencia B", async () => {
    const deA = diferida<PaginaDeHistorial>();
    const deB = diferida<PaginaDeHistorial>();
    const cargar = vi.fn().mockReturnValueOnce(deA.promesa).mockReturnValueOnce(deB.promesa);

    const props = (comp: string) => ({
      nombrePlural: "inscripciones",
      dependencias: [comp, "club-1"],
      encabezados: ["Nadador", "Club"],
      cargar: cargar as never,
    });

    const { rerender } = render(<PanelDeHistorial {...props("comp-A")} />);
    abrir();
    await waitFor(() => expect(cargar).toHaveBeenCalledTimes(1));

    /**
     * LA VENTANA DE MICROTAREA: la resolución de A se encola ANTES del cambio de
     * competencia, así que se procesa en cuanto React ceda el control, cuando la
     * limpieza del efecto de A todavía no ha corrido.
     *
     * Con el diseño vigente da igual que corra o no: el cambio de competencia
     * cambia la `key`, así que esa resolución escribe —si acaso— sobre una
     * instancia que ya no está montada, y la instancia nueva no comparte nada con
     * ella. No hay ningún estado de A que pueda aparecer bajo B.
     */
    const encolada = Promise.resolve().then(() => deA.resolver(filaUnica("de-A")));

    await act(async () => {
      rerender(<PanelDeHistorial {...props("comp-B")} />);
      await encolada;
    });

    expect(screen.queryByText("Nadador de-A"), "la respuesta de A no puede pintarse en B").not.toBeInTheDocument();

    await act(async () => {
      deB.resolver(filaUnica("de-B"));
    });
    expect(await screen.findByText("Nadador de-B")).toBeInTheDocument();
  });

  it("(b) la respuesta de Canceladas no sobrescribe Confirmadas", async () => {
    const deCanceladas = diferida<PaginaDeHistorial>();
    const deConfirmadas = diferida<PaginaDeHistorial>();
    const cargar = vi.fn().mockReturnValueOnce(deCanceladas.promesa).mockReturnValueOnce(deConfirmadas.promesa);

    montar(cargar as never);
    abrir();
    await waitFor(() => expect(cargar).toHaveBeenCalledTimes(1));

    const encolada = Promise.resolve().then(() => deCanceladas.resolver(filaUnica("cancelada")));

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "confirmed" } });
      await encolada;
    });

    expect(screen.queryByText("Nadador cancelada"), "no puede aparecer bajo Confirmadas").not.toBeInTheDocument();

    await act(async () => {
      deConfirmadas.resolver({ filas: [filaDe("confirmada", false)], total: 1, page: 1, pageSize: TAMANO_DE_PAGINA });
    });
    expect(await screen.findByText("Nadador confirmada")).toBeInTheDocument();
  });

  it("(c) la respuesta de la PÁGINA 2 no se aplica si ya se está mirando otra cosa", async () => {
    /**
     * La página forma parte de la identidad de la vista. Esta es la ruta por la
     * que una respuesta de la página 2 puede llegar tarde: el selector de estado
     * sigue disponible mientras la 2 viaja, y cambiarlo devuelve a la página 1 de
     * otro conjunto. Sin la página en la clave, esa respuesta se aplicaría.
     *
     * Nota sobre lo que NO es reproducible: una respuesta de la página 1 pisando
     * a la 2 exige haber navegado, y el pie de navegación solo existe cuando la
     * carga terminó, así que no hay forma de tener dos páginas en vuelo a la vez.
     */
    const dePagina1 = diferida<PaginaDeHistorial>();
    const dePagina2 = diferida<PaginaDeHistorial>();
    const deConfirmadas = diferida<PaginaDeHistorial>();
    const cargar = vi
      .fn()
      .mockReturnValueOnce(dePagina1.promesa)
      .mockReturnValueOnce(dePagina2.promesa)
      .mockReturnValueOnce(deConfirmadas.promesa);

    montar(cargar as never);
    abrir();
    await act(async () => {
      dePagina1.resolver(paginaDe(1, 45));
    });
    await screen.findByText("Nadador r1");

    fireEvent.click(siguiente());
    await waitFor(() => expect(cargar).toHaveBeenCalledTimes(2));

    // Sin esperar a la 2, se cambia de estado: vista nueva, página 1.
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "confirmed" } });
    await waitFor(() => expect(cargar).toHaveBeenCalledTimes(3));
    expect(cargar.mock.calls[2]![1], "el cambio de estado reinicia la página").toBe(1);

    // Y AHORA llega la página 2 de las canceladas.
    await act(async () => {
      dePagina2.resolver(paginaDe(2, 45));
    });
    expect(screen.queryByText("Nadador r21"), "la 2 de canceladas no es esta vista").not.toBeInTheDocument();

    await act(async () => {
      deConfirmadas.resolver(paginaDe(1, 3, false));
    });
    expect(await screen.findByText("Nadador r1")).toBeInTheDocument();
    expect(screen.getByText("Mostrando 1–3 de 3")).toBeInTheDocument();
  });

  it("(d) un ERROR atrasado tampoco tumba la vista actual", async () => {
    const deA = diferida<PaginaDeHistorial>();
    const deB = diferida<PaginaDeHistorial>();
    const cargar = vi.fn().mockReturnValueOnce(deA.promesa).mockReturnValueOnce(deB.promesa);

    const props = (comp: string) => ({
      nombrePlural: "inscripciones",
      dependencias: [comp, "club-1"],
      encabezados: ["Nadador", "Club"],
      cargar: cargar as never,
    });

    const { rerender } = render(<PanelDeHistorial {...props("comp-A")} />);
    abrir();
    await waitFor(() => expect(cargar).toHaveBeenCalledTimes(1));

    const encolada = Promise.resolve()
      .then(() => deA.rechazar(new Error("fallo de la competencia A")))
      .catch(() => undefined);

    await act(async () => {
      rerender(<PanelDeHistorial {...props("comp-B")} />);
      await encolada.catch(() => undefined);
    });

    await act(async () => {
      deB.resolver(filaUnica("de-B"));
    });

    expect(screen.queryByText(/fallo de la competencia A/), "el error de A no es el de B").not.toBeInTheDocument();
    expect(await screen.findByText("Nadador de-B")).toBeInTheDocument();
  });
});

/**
 * LA VENTANA ANTERIOR A LOS EFECTOS PASIVOS, SIN EL ENVOLTORIO `act`.
 *
 * Las pruebas de arriba cambian de vista con `rerender` o `fireEvent`, y
 * Testing Library los envuelve en `act`, que vacía los efectos pasivos de forma
 * SÍNCRONA antes de devolver el control. Por eso ninguna de ellas puede abrir la
 * ventana real entre el commit y esos efectos: cuando la microtarea corre, la
 * limpieza ya se ejecutó.
 *
 * Esta prueba renderiza con `createRoot` y desactiva `IS_REACT_ACT_ENVIRONMENT`
 * para que el planificador de React actúe como en el navegador: la actualización
 * se programa, los efectos pasivos quedan pendientes, y la resolución de la
 * petición anterior se encola a continuación.
 *
 * IMPORTANTE, porque es fácil equivocarse: esto funciona aquí porque **no se usa
 * `fireEvent`**. El `eventWrapper` de Testing Library
 * (`@testing-library/react/dist/pure.js`, ~105-113) envuelve SIEMPRE `fireEvent`
 * en `act` y `act-compat` repone la bandera mientras dura, así que bajarla no
 * basta si se dispara el evento con `fireEvent`. Aquí se monta con `createRoot`,
 * se pulsa con un `.click()` nativo y el cambio de estado se hace llamando
 * directamente al `setState` del padre.
 */
describe("la ventana entre el commit y los efectos pasivos, sin `act`", () => {
  let root: Root | null = null;
  let contenedor: HTMLDivElement | null = null;

  /**
   * Actualizar fuera de `act` es DELIBERADO aquí, y React lo avisa por consola.
   * En vez de dejar ese aviso suelto —lo que obliga a mirar la salida de la suite
   * y decidir cada vez si es el de siempre o uno nuevo—, se captura y se afirma:
   * el esperado tiene que estar, y ningún otro puede colarse. La captura envuelve
   * también al desmontaje, que es donde React lo emite.
   */
  let avisos: string[] = [];
  let errorOriginal: typeof console.error;

  beforeEach(() => {
    avisos = [];
    errorOriginal = console.error;
    console.error = (...args: unknown[]) => void avisos.push(String(args[0]));
  });

  afterEach(() => {
    root?.unmount();
    contenedor?.remove();
    root = null;
    contenedor = null;
  });

  afterEach(() => {
    console.error = errorOriginal;
    expect(
      avisos.filter((a) => a.includes("not wrapped in act")).length,
      "el aviso de act es el precio de correr fuera de act"
    ).toBeGreaterThan(0);
    expect(avisos.filter((a) => !a.includes("not wrapped in act")), "ningún otro aviso de React").toEqual([]);
  });

  function diferida<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  const unaFila = (id: string): PaginaDeHistorial => ({
    filas: [filaDe(id, true)],
    total: 1,
    page: 1,
    pageSize: TAMANO_DE_PAGINA,
  });

  /** Cede el control hasta que el planificador de React vació su cola. */
  const respirar = () => new Promise((r) => setTimeout(r, 0));

  it("una microtarea encolada antes del cambio no pinta filas de la vista vieja", async () => {
    const anterior = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

    try {
      const deA = diferida<PaginaDeHistorial>();
      const deB = diferida<PaginaDeHistorial>();
      const cargar = vi.fn().mockReturnValueOnce(deA.promesa).mockReturnValueOnce(deB.promesa);

      let cambiarCompetencia!: (c: string) => void;
      function Padre() {
        const [comp, setComp] = useState("comp-A");
        cambiarCompetencia = setComp;
        return (
          <PanelDeHistorial
            nombrePlural="inscripciones"
            dependencias={[comp, "club-1"]}
            encabezados={["Nadador", "Club"]}
            cargar={cargar as never}
          />
        );
      }

      contenedor = document.createElement("div");
      document.body.appendChild(contenedor);
      root = createRoot(contenedor);
      root.render(<Padre />);
      await respirar();

      contenedor.querySelector("button")!.click();
      await respirar();
      expect(cargar).toHaveBeenCalledTimes(1);

      // El cambio NO pasa por `act`: los efectos pasivos quedan pendientes y la
      // resolución de A se procesa antes de que corra la limpieza.
      cambiarCompetencia("comp-B");
      deA.resolver(unaFila("de-A"));
      await respirar();

      const textoTrasElCambio = contenedor.textContent ?? "";

      deB.resolver(unaFila("de-B"));
      await respirar();

      expect(textoTrasElCambio, "la vista B no puede mostrar filas de A").not.toContain("Nadador de-A");
      expect(contenedor.textContent).toContain("Nadador de-B");
    } finally {
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = anterior;
    }
  });
});

/**
 * NINGUNA PÁGINA HISTÓRICA POR CLAVE.
 *
 * Un modelo anterior guardaba `{clave, page}` y derivaba la página comparando la
 * clave. Al volver a un conjunto ya visitado, ese `{A, 2}` seguía ahí y la página
 * 2 **resucitaba**: el usuario pedía el club A y recibía su segunda página sin
 * haber navegado. Ahora cada conjunto es una instancia nueva —`key`—, así que no
 * hay nada que recordar.
 */
describe("volver a un conjunto ya visitado empieza en la página 1", () => {
  it("A pág. 2 → B pág. 1 → volver a A: A pide la página 1", async () => {
    const cargar = vi.fn(async (_e: unknown, page: number) => paginaDe(page, 45));
    const props = (comp: string) => ({
      nombrePlural: "inscripciones",
      dependencias: [comp, "club-1"],
      encabezados: ["Nadador", "Club"],
      cargar: cargar as never,
    });

    const { rerender } = render(<PanelDeHistorial {...props("comp-A")} />);
    abrir();
    await screen.findByText("Nadador r1");
    fireEvent.click(siguiente());
    await screen.findByText("Nadador r21");

    rerender(<PanelDeHistorial {...props("comp-B")} />);
    await screen.findByText("Página 1 de 3");

    cargar.mockClear();
    rerender(<PanelDeHistorial {...props("comp-A")} />);

    await waitFor(() => expect(cargar).toHaveBeenCalled());
    expect(cargar.mock.calls[0]![1], "volver a A no resucita su página 2").toBe(1);
    expect(await screen.findByText("Mostrando 1–20 de 45")).toBeInTheDocument();
  });

  it("Canceladas pág. 2 → Confirmadas → Canceladas: también empieza en la 1", async () => {
    const cargar = vi.fn(async (_e: unknown, page: number) => paginaDe(page, 45));
    montar(cargar as never);
    abrir();
    await screen.findByText("Nadador r1");
    fireEvent.click(siguiente());
    await screen.findByText("Nadador r21");

    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "confirmed" } });
    await screen.findByText("Nadador r1");

    cargar.mockClear();
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "cancelled" } });

    await waitFor(() => expect(cargar).toHaveBeenCalled());
    expect(cargar.mock.calls[0]![1], "volver a Canceladas no resucita su página 2").toBe(1);
  });
});

/**
 * NINGUNA FILA DE OTRA CLAVE, NI SIQUIERA UN RENDER.
 *
 * Una solución RETIRADA registraba la identidad de la vista en una `ref` y la
 * comprobaba antes de escribir. Impedía que una promesa atrasada ESCRIBIERA, pero
 * el resultado ya almacenado no estaba asociado a ninguna clave: tras el cambio,
 * el render podía reutilizar las filas viejas hasta que un efecto pasivo
 * encendiera el indicador de carga. La corrección dependía de ese
 * `setCargando(true)`, que corre DESPUÉS del commit.
 *
 * Ahora el conjunto es una `key` —el estado viejo se desmonta— y el resultado va
 * etiquetado con la página que lo produjo, así que no hay nada que reutilizar.
 */
describe("nunca se renderiza una fila de otra vista", () => {
  function pendiente<T>() {
    let resolver!: (v: T) => void;
    const promesa = new Promise<T>((res) => (resolver = res));
    return { promesa, resolver };
  }

  it("A cargada → B con su petición pendiente: ninguna fila de A sigue visible", async () => {
    const deB = pendiente<PaginaDeHistorial>();
    const cargar = vi
      .fn()
      .mockImplementationOnce(async () => paginaDe(1, 45))
      .mockReturnValueOnce(deB.promesa);

    const props = (comp: string) => ({
      nombrePlural: "inscripciones",
      dependencias: [comp, "club-1"],
      encabezados: ["Nadador", "Club"],
      cargar: cargar as never,
    });

    const { rerender } = render(<PanelDeHistorial {...props("comp-A")} />);
    abrir();
    await screen.findByText("Nadador r1");

    rerender(<PanelDeHistorial {...props("comp-B")} />);

    expect(screen.queryByText("Nadador r1"), "las filas de A no pueden verse bajo B").not.toBeInTheDocument();
    expect(screen.queryByText("Mostrando 1–20 de 45"), "ni su pie de navegación").not.toBeInTheDocument();
    expect(screen.queryByRole("table"), "ni la tabla").not.toBeInTheDocument();
    expect(screen.getByText("Cargando…")).toBeInTheDocument();

    await act(async () => {
      deB.resolver(paginaDe(1, 3));
    });
    expect(await screen.findByText("Mostrando 1–3 de 3")).toBeInTheDocument();
  });

  it("página 1 cargada → página 2 pendiente: la 1 no se presenta como si fuera la 2", async () => {
    const de2 = pendiente<PaginaDeHistorial>();
    const cargar = vi
      .fn()
      .mockImplementationOnce(async () => paginaDe(1, 45))
      .mockReturnValueOnce(de2.promesa);

    montar(cargar as never);
    abrir();
    await screen.findByText("Nadador r1");

    fireEvent.click(siguiente());

    expect(screen.queryByText("Nadador r1"), "la 1 no puede seguir pintada").not.toBeInTheDocument();
    expect(screen.queryByText("Mostrando 1–20 de 45")).not.toBeInTheDocument();
    expect(screen.getByText("Cargando…")).toBeInTheDocument();

    await act(async () => {
      de2.resolver(paginaDe(2, 45));
    });
    expect(await screen.findByText("Mostrando 21–40 de 45")).toBeInTheDocument();
  });

  it("cerrar, cambiar dependencias y reabrir: no aparece el historial anterior", async () => {
    const deNueva = pendiente<PaginaDeHistorial>();
    const cargar = vi
      .fn()
      .mockImplementationOnce(async () => paginaDe(1, 45))
      .mockReturnValueOnce(deNueva.promesa);

    const props = (comp: string) => ({
      nombrePlural: "inscripciones",
      dependencias: [comp, "club-1"],
      encabezados: ["Nadador", "Club"],
      cargar: cargar as never,
    });

    const { rerender } = render(<PanelDeHistorial {...props("comp-A")} />);
    abrir();
    await screen.findByText("Nadador r1");

    fireEvent.click(screen.getByRole("button", { name: /Ocultar historial/ }));
    rerender(<PanelDeHistorial {...props("comp-B")} />);
    abrir();

    expect(screen.queryByText("Nadador r1"), "el historial de A no puede reaparecer").not.toBeInTheDocument();
    expect(screen.getByText("Cargando…")).toBeInTheDocument();

    await act(async () => {
      deNueva.resolver(paginaDe(1, 3));
    });
  });

  it("mientras una página viaja no hay controles para pedir otra", async () => {
    /**
     * Es la razón por la que dentro de un conjunto nunca hay dos peticiones en
     * vuelo, y por la que no hace falta un contador de peticiones además del
     * etiquetado por página: el pie de navegación solo existe cuando hay
     * resultado para la página actual.
     */
    const de2 = pendiente<PaginaDeHistorial>();
    const cargar = vi
      .fn()
      .mockImplementationOnce(async () => paginaDe(1, 45))
      .mockReturnValueOnce(de2.promesa);

    montar(cargar as never);
    abrir();
    await screen.findByText("Nadador r1");

    fireEvent.click(siguiente());

    expect(screen.queryByRole("button", { name: "Siguiente" }), "sin pie mientras carga").not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anterior" })).not.toBeInTheDocument();
    expect(cargar).toHaveBeenCalledTimes(2);

    await act(async () => {
      de2.resolver(paginaDe(2, 45));
    });
    expect(await screen.findByText("Mostrando 21–40 de 45")).toBeInTheDocument();
  });
});

/**
 * COHERENCIA DE LA RESPUESTA, VISTA DESDE LA PANTALLA. Las comprobaciones
 * directas del validador viven en `paginacion.test.ts`; aquí se comprueba que el
 * rechazo llega al usuario en vez de pintar filas que no cuadran.
 */
describe("una página incoherente se muestra como error, no como filas", () => {
  it("20 filas con un total de 5", async () => {
    const cargar = vi.fn(async () => {
      throw new Error("La página 1 trae 20 elementos, pero según el total (5) desde su desplazamiento (0) solo quedaban 5.");
    });
    montar(cargar as never);
    abrir();

    expect(await screen.findByText(/solo quedaban 5/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
