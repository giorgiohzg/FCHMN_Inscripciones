/**
 * Fase 6, hallazgo 28 — la primera página NO es el conjunto completo, y una
 * lista a medias NO es un resultado aceptable.
 *
 * Dos defectos, uno detrás del otro:
 *
 *  1. Varias llamadas pedían una página y se quedaban con `items`. Como los
 *     esquemas del backend declaran un `pageSize` con techo y con valor por
 *     omisión, ese número no era una cota holgada: con 101 clubes, el club 101
 *     no aparecía en ningún selector.
 *  2. La primera versión del ayudante **devolvía lo acumulado** ante cualquier
 *     rareza —`total` inválido, `items` no-array, página repetida, tope de
 *     páginas—. Es decir, seguía devolviendo listas parciales silenciosas, solo
 *     que con otra excusa. Ahora eso **lanza**: las pruebas que antes esperaban
 *     éxito parcial exigen rechazo.
 *
 * Los tamaños están elegidos alrededor del techo —101, 200, 201—, porque los
 * fallos de paginación viven en los bordes: uno más que el máximo, un múltiplo
 * exacto, y un múltiplo exacto más uno. En todos se comprueba **el último
 * elemento**, que es justo el que se perdía.
 */
import { describe, it, expect, vi } from "vitest";
import {
  traerTodasLasPaginas,
  validarPaginaRecibida,
  ErrorDePaginacion,
  MAXIMO_POR_PAGINA,
  type PaginaDe,
} from "./paginacion";

interface Fila {
  id: string;
  nombre: string;
}

/** Servidor de mentira con el mismo contrato que el real, incluido su techo. */
function servidorCon(cantidad: number, techo = MAXIMO_POR_PAGINA) {
  const todo: Fila[] = Array.from({ length: cantidad }, (_, i) => ({ id: `id-${i + 1}`, nombre: `Club ${i + 1}` }));
  const peticiones: Array<{ page: number; pageSize: number }> = [];

  const pedir = vi.fn(async (page: number, pageSize: number): Promise<PaginaDe<Fila>> => {
    peticiones.push({ page, pageSize });
    const tamano = Math.min(pageSize, techo);
    const desde = (page - 1) * tamano;
    return { items: todo.slice(desde, desde + tamano), total: todo.length, page, pageSize: tamano };
  });

  return { todo, pedir, peticiones };
}

describe("recorre hasta el final", () => {
  it.each([101, 200, 201])("con %i resultados los trae todos, incluido el último", async (cantidad) => {
    const s = servidorCon(cantidad);

    const resultado = await traerTodasLasPaginas(s.pedir);

    expect(resultado).toHaveLength(cantidad);
    expect(resultado[0]!.id).toBe("id-1");
    // EL ÚLTIMO: es el que se perdía al tratar la primera página como el total.
    expect(resultado[resultado.length - 1]!.id, "el último elemento no puede quedarse fuera").toBe(`id-${cantidad}`);
    expect(new Set(resultado.map((r) => r.id)).size, "sin repetidos").toBe(cantidad);
  });

  it("pide páginas del tamaño máximo, y solo las necesarias", async () => {
    const s = servidorCon(201);

    await traerTodasLasPaginas(s.pedir);

    expect(s.peticiones).toEqual([
      { page: 1, pageSize: MAXIMO_POR_PAGINA },
      { page: 2, pageSize: MAXIMO_POR_PAGINA },
      { page: 3, pageSize: MAXIMO_POR_PAGINA },
    ]);
  });

  it("con 200 (múltiplo exacto) no pide una cuarta página vacía", async () => {
    const s = servidorCon(200);
    await traerTodasLasPaginas(s.pedir);
    expect(s.peticiones).toHaveLength(2);
  });

  it("con menos de una página hace UNA sola petición", async () => {
    const s = servidorCon(7);
    expect(await traerTodasLasPaginas(s.pedir)).toHaveLength(7);
    expect(s.peticiones).toHaveLength(1);
  });

  it("con cero resultados devuelve una lista vacía", async () => {
    const s = servidorCon(0);
    expect(await traerTodasLasPaginas(s.pedir)).toEqual([]);
  });

  it("respeta el tamaño que el backend APLICÓ, no el que se pidió", async () => {
    // Si el servidor recorta a 50, contar con 100 haría saltarse elementos.
    const s = servidorCon(120, 50);

    const resultado = await traerTodasLasPaginas(s.pedir);

    expect(resultado).toHaveLength(120);
    expect(resultado[resultado.length - 1]!.id).toBe("id-120");
    expect(s.peticiones).toHaveLength(3);
  });

  it("DEDUPLICA lo que se repite por desplazamiento, y aun así cuadra el total", async () => {
    /**
     * Pasa de verdad: si alguien borra un registro entre la página 1 y la 2, la
     * paginación se desplaza y un elemento vuelve a aparecer. Se deduplica, y el
     * `total` de la última respuesta —ya actualizado— es con el que se cuadra.
     */
    const pedir = vi.fn(async (page: number): Promise<PaginaDe<Fila>> => {
      if (page === 1) {
        return { items: [{ id: "a", nombre: "A" }, { id: "b", nombre: "B" }], total: 4, page, pageSize: 2 };
      }
      return { items: [{ id: "b", nombre: "B" }, { id: "c", nombre: "C" }], total: 3, page, pageSize: 2 };
    });

    expect((await traerTodasLasPaginas(pedir)).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

/**
 * FAIL-CLOSED. Cada uno de estos casos devolvía antes una lista parcial con cara
 * de estar completa. Ahora todos lanzan: un error se ve y se reintenta, una lista
 * a medias se toma por buena.
 */
describe("no devuelve listas parciales: LANZA", () => {
  it("RECHAZA un `total` que no es un entero válido", async () => {
    const pedir = vi.fn(
      async (page: number) =>
        ({ items: [{ id: "x", nombre: "X" }], total: Number.NaN, page, pageSize: 1 }) as PaginaDe<Fila>
    );

    await expect(traerTodasLasPaginas(pedir)).rejects.toThrow(ErrorDePaginacion);
    await expect(traerTodasLasPaginas(pedir)).rejects.toThrow(/total inválido/);
  });

  it("RECHAZA `items` que no es un array", async () => {
    const pedir = vi.fn(async () => ({ items: null, total: 50, page: 1, pageSize: 10 }) as unknown as PaginaDe<Fila>);
    await expect(traerTodasLasPaginas(pedir)).rejects.toThrow(/no trae una lista/);
  });

  it("RECHAZA una respuesta que no es un objeto", async () => {
    const pedir = vi.fn(async () => "hola" as unknown as PaginaDe<Fila>);
    await expect(traerTodasLasPaginas(pedir)).rejects.toThrow(/no devolvió un objeto/);
  });

  it("RECHAZA un elemento sin identificador utilizable", async () => {
    // Ignorarlo dejaba una lista incompleta e imposible de verificar.
    const pedir = vi.fn(
      async () =>
        ({
          items: [{ id: "bueno", nombre: "A" }, { nombre: "sin id" }],
          total: 2,
          page: 1,
          pageSize: 10,
        }) as unknown as PaginaDe<Fila>
    );

    await expect(traerTodasLasPaginas(pedir)).rejects.toThrow(/sin identificador utilizable/);
  });

  it("RECHAZA una página distinta de la pedida", async () => {
    // Un proxy que cachea la primera página, o un backend que ignora `page`.
    const pedir = vi.fn(
      async (): Promise<PaginaDe<Fila>> => ({
        items: [{ id: "a", nombre: "A" }],
        total: 500,
        page: 1,
        pageSize: 1,
      })
    );

    await expect(traerTodasLasPaginas(pedir)).rejects.toThrow(/devolvió la 1/);
  });

  it("RECHAZA cuando una página no aporta progreso y aún faltan elementos", async () => {
    // El servidor numera bien pero devuelve siempre lo mismo.
    const pedir = vi.fn(
      async (page: number): Promise<PaginaDe<Fila>> => ({
        items: [{ id: "siempre-el-mismo", nombre: "X" }],
        total: 9999,
        page,
        pageSize: 1,
      })
    );

    await expect(traerTodasLasPaginas(pedir)).rejects.toThrow(/no aportó elementos nuevos/);
    expect(pedir, "y se para en cuanto lo detecta").toHaveBeenCalledTimes(2);
  });

  it("RECHAZA un `pageSize` no positivo", async () => {
    const pedir = vi.fn(
      async (page: number): Promise<PaginaDe<Fila>> => ({ items: [{ id: "a", nombre: "A" }], total: 5, page, pageSize: 0 })
    );
    await expect(traerTodasLasPaginas(pedir)).rejects.toThrow(/tamaño de página inválido/);
  });

  it("RECHAZA una página con más elementos de los que dice su tamaño", async () => {
    const pedir = vi.fn(
      async (page: number): Promise<PaginaDe<Fila>> => ({
        items: [{ id: "a", nombre: "A" }, { id: "b", nombre: "B" }],
        total: 2,
        page,
        pageSize: 1,
      })
    );
    await expect(traerTodasLasPaginas(pedir)).rejects.toThrow(/para un tamaño de/);
  });

  it("RECHAZA al alcanzar el límite de páginas con elementos pendientes", async () => {
    /**
     * 100 páginas × 100 elementos = 10 000, y el servidor dice tener 20 000.
     * Devolver la mitad con apariencia de lista completa es justo lo que este
     * ayudante existe para no hacer.
     */
    const TOTAL = 20_000;
    const pedir = vi.fn(async (page: number, pageSize: number): Promise<PaginaDe<Fila>> => {
      const desde = (page - 1) * pageSize;
      return {
        items: Array.from({ length: pageSize }, (_, i) => ({ id: `id-${desde + i + 1}`, nombre: "X" })),
        total: TOTAL,
        page,
        pageSize,
      };
    });

    await expect(traerTodasLasPaginas(pedir)).rejects.toThrow(/límite de 100 páginas con 10000 de 20000/);
  });

  it("RECHAZA si al final falta algún elemento respecto del total", async () => {
    /**
     * El servidor dice tener 5, entrega 3 y luego se queda sin datos. Puede pasar
     * si alguien borra filas a mitad del recorrido: el `total` de la última
     * respuesta ya no cuadra con lo reunido, y la lista no es fiable.
     */
    const pedir = vi.fn(async (page: number): Promise<PaginaDe<Fila>> => {
      if (page === 1) {
        return { items: [{ id: "a", nombre: "A" }, { id: "b", nombre: "B" }], total: 5, page, pageSize: 2 };
      }
      if (page === 2) return { items: [{ id: "c", nombre: "C" }], total: 5, page, pageSize: 2 };
      return { items: [], total: 5, page, pageSize: 2 };
    });

    await expect(traerTodasLasPaginas(pedir)).rejects.toThrow(/Se reunieron 3 elementos y el servidor informa 5/);
  });

  it("PROPAGA el error del servidor sin envolverlo", async () => {
    const pedir = vi.fn(async (page: number): Promise<PaginaDe<Fila>> => {
      if (page === 1) {
        return {
          items: Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, nombre: "X" })),
          total: 300,
          page,
          pageSize: 100,
        };
      }
      throw new Error("500 en la segunda página");
    });

    await expect(traerTodasLasPaginas(pedir)).rejects.toThrow("500 en la segunda página");
  });
});

/**
 * EL VALIDADOR, DIRECTAMENTE. `traerTodasLasPaginas` lo usa en modo permisivo
 * —sin declarar el tamaño pedido— porque tolera por diseño la deriva del
 * desplazamiento. Quien NAVEGA sí lo declara, y entonces se exige coherencia
 * completa: es lo que impide que un pie de «Anterior / Siguiente» se calcule
 * sobre números imposibles.
 */
describe("validarPaginaRecibida en modo NAVEGACIÓN", () => {
  const pagina = (page: number, pageSize: number, total: number, cuantos: number) => ({
    items: Array.from({ length: cuantos }, (_, i) => ({ id: `x${i}` })),
    total,
    page,
    pageSize,
  });

  /**
   * La regla es una igualdad, no una desigualdad: para una respuesta estática y
   * coherente consigo misma,
   *
   *   esperados = min(pageSize, max(0, total - (page - 1) * pageSize))
   *
   * y `items.length` tiene que ser exactamente eso.
   */
  it.each([
    ["página llena", 1, 20, 45, 20],
    ["última página corta", 3, 20, 45, 5],
    ["total menor que una página", 1, 20, 5, 5],
    ["conjunto vacío", 1, 20, 0, 0],
    ["página que dejó de existir: el conjunto encogió (AUTOCORRECCIÓN)", 3, 20, 15, 0],
    ["tamaño recortado por el servidor", 1, 10, 45, 10],
  ])("ACEPTA %s", (_caso, page, pageSize, total, cuantos) => {
    expect(() => validarPaginaRecibida(pagina(page, pageSize, total, cuantos), page, 20)).not.toThrow();
  });

  it.each([
    ["20 elementos con un total de 5", 1, 20, 5, 20, /y solo caben 5/],
    ["una página POSTERIOR al total que llega con elementos", 3, 20, 15, 5, /y solo caben 0/],
    ["más elementos de los que quedaban desde el desplazamiento", 2, 20, 25, 20, /y solo caben 5/],
    // Y la mitad que la comprobación anterior dejaba pasar: los que FALTAN.
    ["una página vacía cuando el total dice que hay 5", 1, 20, 5, 0, /debían venir 5/],
    ["4 elementos cuando el total dice que hay 5", 1, 20, 5, 4, /debían venir 5/],
    ["19 elementos en una página que debía venir llena", 1, 20, 45, 19, /debían venir 20/],
    ["una última página corta de menos", 3, 20, 45, 4, /debían venir 5/],
  ])("RECHAZA %s", (_caso, page, pageSize, total, cuantos, mensaje) => {
    expect(() => validarPaginaRecibida(pagina(page, pageSize, total, cuantos), page, 20)).toThrow(ErrorDePaginacion);
    expect(() => validarPaginaRecibida(pagina(page, pageSize, total, cuantos), page, 20)).toThrow(mensaje as RegExp);
  });

  it("RECHAZA un tamaño mayor que el pedido", () => {
    expect(() => validarPaginaRecibida(pagina(1, 100, 45, 20), 1, 20)).toThrow(/Se pidieron 20 elementos/);
  });

  it("RECHAZA una página distinta de la pedida", () => {
    expect(() => validarPaginaRecibida(pagina(1, 20, 45, 20), 2, 20)).toThrow(/devolvió la 1/);
  });

  it("la página vacía de la autocorrección se acepta también con total 0", () => {
    /**
     * Es lo que permite que el panel vuelva a la última página válida cuando el
     * conjunto se vació entero mientras alguien lo miraba. Rechazarla lo dejaría
     * atrapado en una página inexistente.
     */
    expect(() => validarPaginaRecibida(pagina(2, 20, 0, 0), 2, 20)).not.toThrow();
  });
});

describe("el recorrido completo tolera la deriva que la navegación rechaza", () => {
  it("acepta la página desplazada que el modo navegación rechazaría", async () => {
    const desplazada = { items: [{ id: "b" }, { id: "c" }], total: 3, page: 2, pageSize: 2 };

    // En modo navegación no pasa: desde el desplazamiento 2 solo cabía 1.
    expect(() => validarPaginaRecibida(desplazada, 2, 2)).toThrow(/y solo caben 1/);

    // En el recorrido completo sí, y el resultado se deduplica y cuadra.
    const pedir = vi.fn(async (page: number) =>
      page === 1
        ? ({ items: [{ id: "a" }, { id: "b" }], total: 4, page, pageSize: 2 } as never)
        : (desplazada as never)
    );
    expect((await traerTodasLasPaginas(pedir)).map((r) => (r as { id: string }).id)).toEqual(["a", "b", "c"]);
  });
});
