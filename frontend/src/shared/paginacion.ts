/**
 * Fase 6, hallazgo 28 — TRAER UNA LISTA COMPLETA CUANDO DE VERDAD HACE FALTA.
 *
 * Varias llamadas del frontend pedían una página y se quedaban con `items`,
 * tratando la primera página como si fuera el conjunto entero. **No lo es**: los
 * esquemas del backend declaran `pageSize` con máximo y con valor por omisión
 * —100/50 en `clubs`, `competitions`, `persons`, `swimmer-assignments` y
 * `catalogs`; 200/50 en `registrations` y `relay-registrations`—, así que ese
 * número no es una cota holgada sino el techo. Con 101 clubes, el club 101 no
 * aparecía en ningún selector: sin error, sin aviso y sin forma de notarlo salvo
 * buscándolo.
 *
 * Subir el máximo del backend no arregla nada: solo mueve el corte a otro número
 * y hace más pesada cada respuesta. Lo que corresponde es recorrer las páginas.
 *
 * ESTO ES PARA SELECTORES Y CONJUNTOS DE DECISIÓN, NO PARA TABLAS. Un desplegable
 * necesita todas las opciones porque el usuario no puede "pasar de página" dentro
 * de un `<select>`; una lista con la que se calcula qué está ya inscrito necesita
 * estar completa o miente. Una tabla, en cambio, debe conservar su paginación
 * visible: traerlo todo para mostrar 20 filas desperdicia ancho de banda.
 *
 * FAIL-CLOSED, Y ESTO ES LO IMPORTANTE
 * ------------------------------------
 * La primera versión de este archivo cortaba el bucle y **devolvía lo
 * acumulado** ante cualquier rareza: `total` inválido, `items` que no era un
 * array, una página repetida, elementos sin `id`, el tope de páginas. Es decir,
 * devolvía una lista parcial exactamente igual de silenciosa que el defecto que
 * venía a corregir — y encima con la apariencia de estar completa.
 *
 * Ahora, si no se puede garantizar que la lista está entera, **se lanza**. Una
 * excepción la ve el usuario y se puede reintentar; una lista a medias se toma
 * por buena y produce decisiones equivocadas (un nadador que parece libre y ya
 * estaba inscrito, un club que no aparece en el informe).
 *
 * LO QUE NO SE PUEDE GARANTIZAR
 * -----------------------------
 * La paginación por desplazamiento (`skip`/`take`) **no da una fotografía
 * estable** si los datos cambian mientras se recorre: una inserción o un borrado
 * entre dos peticiones desplaza las filas, y un elemento puede repetirse —eso se
 * detecta y se deduplica— o **perderse sin que nada lo delate**. Por eso al final
 * se comprueba el recuento contra el `total` informado; y aun así, si el total
 * también cambió, la comprobación solo puede ser de coherencia, no de identidad.
 * La garantía fuerte exigiría paginación por cursor en el backend.
 */

/**
 * El tamaño que se pide. Es el máximo común a todos los recursos: los que
 * admiten 200 aceptan 100 sin problema, y así no hay que saber el tope de cada
 * endpoint. El backend puede recortarlo y se usa el que aplique.
 */
export const MAXIMO_POR_PAGINA = 100;

/**
 * Tope duro de páginas. 100 × 100 son 10 000 registros: muy por encima de
 * cualquier catálogo real de esta aplicación. Si se alcanza y **todavía faltan
 * elementos**, se lanza: significa que la lista es mayor de lo que este
 * mecanismo puede traer, y devolver 10 000 de 15 000 sería mentir.
 */
const MAXIMO_DE_PAGINAS = 100;

/** La forma que devuelven todas las listas paginadas del backend. */
export interface PaginaDe<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Lo mínimo que se le exige a un elemento para poder deduplicarlo. */
interface ConId {
  id: string;
}

/** Error de paginación, distinguible de un fallo de red o de un 4xx del API. */
export class ErrorDePaginacion extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrorDePaginacion";
  }
}

const esEnteroNoNegativo = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Comprueba que la respuesta tiene la forma y los rangos esperados.
 *
 * No es paranoia: entre el cliente y el servidor hay un proxy, un Service Worker
 * potencial y el propio `fetch`. Una respuesta que no encaja es un fallo, y como
 * tal se trata.
 */
export function validarPaginaRecibida<T>(respuesta: unknown, pagePedida: number, pageSizePedido?: number): PaginaDe<T> {
  if (typeof respuesta !== "object" || respuesta === null) {
    throw new ErrorDePaginacion(`La página ${pagePedida} no devolvió un objeto.`);
  }
  const p = respuesta as Record<string, unknown>;

  if (!Array.isArray(p.items)) {
    throw new ErrorDePaginacion(`La página ${pagePedida} no trae una lista de elementos.`);
  }
  if (!esEnteroNoNegativo(p.total)) {
    throw new ErrorDePaginacion(`La página ${pagePedida} informa un total inválido (${String(p.total)}).`);
  }
  if (!esEnteroNoNegativo(p.pageSize) || p.pageSize === 0) {
    throw new ErrorDePaginacion(`La página ${pagePedida} informa un tamaño de página inválido (${String(p.pageSize)}).`);
  }
  if (!esEnteroNoNegativo(p.page) || p.page === 0) {
    throw new ErrorDePaginacion(`La página ${pagePedida} informa un número de página inválido (${String(p.page)}).`);
  }
  /**
   * LA PÁGINA RECIBIDA DEBE SER LA PEDIDA. Un servidor que ignore el parámetro
   * —o un proxy que sirva de caché la primera— devolvería siempre la misma, y el
   * recorrido daría vueltas creyendo avanzar.
   */
  if (p.page !== pagePedida) {
    throw new ErrorDePaginacion(`Se pidió la página ${pagePedida} y el servidor devolvió la ${p.page}.`);
  }
  if (p.items.length > p.pageSize) {
    throw new ErrorDePaginacion(`La página ${pagePedida} trae ${p.items.length} elementos para un tamaño de ${p.pageSize}.`);
  }
  /**
   * NUNCA MAYOR QUE EL PEDIDO, cuando el llamador declara qué pidió. El servidor
   * puede recortar el tamaño —y se respeta—, pero si dice haber servido más de lo
   * que se le pidió, un pie de navegación calcularía «hay más páginas» sobre un
   * número falso y escondería filas. Es opcional porque el recorrido completo no
   * navega y no lo necesita.
   */
  /**
   * COMPROBACIONES DE NAVEGACIÓN. Solo se aplican cuando el llamador declara el
   * tamaño que pidió, y ese es justo el que navega: una tabla con pie de
   * «Anterior / Siguiente». Ahí la respuesta tiene que ser internamente coherente
   * porque el pie se calcula con ella.
   *
   * El recorrido completo (`traerTodasLasPaginas`) NO las pide, y no es un
   * descuido: ese camino tolera por diseño la deriva del desplazamiento —si
   * alguien borra un registro entre dos páginas, la siguiente puede repetir un
   * elemento y traer más de los que el nuevo `total` sugiere—, lo deduplica y
   * cuadra al final contra el último total informado. Imponerle esta coherencia
   * página a página rompería ese mecanismo.
   */
  if (pageSizePedido !== undefined) {
    /**
     * El tamaño NUNCA mayor que el pedido. El servidor puede recortarlo —y se
     * respeta—, pero si dice haber servido más de lo que se le pidió, el pie
     * calcularía «hay más páginas» sobre un número falso y escondería filas.
     */
    if ((p.pageSize as number) > pageSizePedido) {
      throw new ErrorDePaginacion(
        `Se pidieron ${pageSizePedido} elementos por página y el servidor informa ${String(p.pageSize)}.`
      );
    }

    /**
     * Y COHERENCIA EXACTA ENTRE `items`, `total`, `page` Y `pageSize`. Que
     * `total` sea un entero no dice nada: tiene que cuadrar con lo que llegó.
     *
     * Una respuesta estática y coherente consigo misma no deja margen: desde el
     * desplazamiento de esta página quedan `total - offset` elementos, y la
     * página trae los que quepan. Ni uno más ni uno menos.
     *
     *   - **De más** es lo que producía un pie de navegación que miente y filas
     *     que el usuario no puede situar: 20 elementos con un total de 5, o una
     *     página posterior al total llegando con filas.
     *   - **De menos** es truncación silenciosa, que es el defecto que este
     *     hallazgo persigue: 19 elementos donde debían venir 20 esconde uno, y el
     *     pie sigue diciendo que el conjunto está completo. Comprobar solo el
     *     exceso dejaba pasar justo la mitad peligrosa.
     *
     * Lo que SÍ se acepta, porque la fórmula lo contempla y es el caso de la
     * autocorrección: una página que dejó de existir porque el conjunto encogió.
     * Su desplazamiento supera al total, `esperados` da 0, y llega **vacía**;
     * quien la pidió la usa para volver a la última página válida.
     */
    const offset = (pagePedida - 1) * (p.pageSize as number);
    const esperados = Math.min(p.pageSize as number, Math.max(0, (p.total as number) - offset));
    if (p.items.length !== esperados) {
      const detalle =
        p.items.length > esperados
          ? `trae ${p.items.length} elementos y solo caben ${esperados}`
          : `trae ${p.items.length} elementos cuando debían venir ${esperados}`;
      throw new ErrorDePaginacion(
        `La página ${pagePedida} ${detalle}, según el total (${p.total}) desde su desplazamiento (${offset}).`
      );
    }
  }

  return p as unknown as PaginaDe<T>;
}

/**
 * Recorre todas las páginas y devuelve la lista completa, o **lanza**.
 *
 * @param pedirPagina pide UNA página: recibe el número (1-based) y el tamaño, y
 *   devuelve la respuesta tal cual la da el backend.
 *
 * @throws {ErrorDePaginacion} si la lista no se puede garantizar completa: una
 *   respuesta incoherente, una página que no avanza, el tope de seguridad
 *   alcanzado con elementos pendientes, o un recuento final que no cuadra con el
 *   total informado.
 * @throws lo que lance `pedirPagina` — los errores de red o del servidor se
 *   propagan sin envolver.
 */
export async function traerTodasLasPaginas<T extends ConId>(
  pedirPagina: (page: number, pageSize: number) => Promise<PaginaDe<T>>
): Promise<T[]> {
  const acumulado: T[] = [];
  const vistos = new Set<string>();
  let totalInformado = 0;

  for (let page = 1; page <= MAXIMO_DE_PAGINAS; page++) {
    // Sin `pageSizePedido`: este recorrido no navega, así que un tamaño mayor
    // del pedido no puede esconderle nada. Añadirlo aquí cambiaría el
    // comportamiento de nueve llamadas que hoy funcionan.
    const respuesta = validarPaginaRecibida<T>(await pedirPagina(page, MAXIMO_POR_PAGINA), page);
    totalInformado = respuesta.total;

    if (respuesta.items.length === 0) break;

    const antes = acumulado.length;
    for (const item of respuesta.items) {
      /**
       * Un elemento sin `id` utilizable NO se ignora: sin él no se puede
       * deduplicar ni contar, así que la lista dejaría de ser verificable.
       */
      if (typeof item !== "object" || item === null || typeof (item as ConId).id !== "string" || (item as ConId).id === "") {
        throw new ErrorDePaginacion(`La página ${page} trae un elemento sin identificador utilizable.`);
      }
      const id = (item as ConId).id;
      if (vistos.has(id)) continue; // repetido por desplazamiento: se deduplica
      vistos.add(id);
      acumulado.push(item);
    }

    const yaEstanTodos = acumulado.length >= totalInformado;

    /**
     * SIN PROGRESO Y CON ELEMENTOS PENDIENTES. Es el servidor que repite página o
     * que devuelve un `total` mayor que lo que entrega. Antes se cortaba en
     * silencio con una lista incompleta.
     */
    if (acumulado.length === antes && !yaEstanTodos) {
      throw new ErrorDePaginacion(
        `La página ${page} no aportó elementos nuevos y aún faltan ${totalInformado - acumulado.length} de ${totalInformado}.`
      );
    }

    if (yaEstanTodos) break;

    // El backend puede haber recortado el tamaño pedido: manda el que aplicó.
    if (page * respuesta.pageSize >= totalInformado) break;

    if (page === MAXIMO_DE_PAGINAS) {
      throw new ErrorDePaginacion(
        `Se alcanzó el límite de ${MAXIMO_DE_PAGINAS} páginas con ${acumulado.length} de ${totalInformado} elementos.`
      );
    }
  }

  /**
   * COMPROBACIÓN FINAL. Se devuelve solo si lo reunido es compatible con lo
   * informado. Menos elementos que el total significa que faltan; más, que el
   * total mentía. Cualquiera de las dos cosas invalida la lista.
   *
   * Nota sobre la igualdad estricta: con datos cambiando a la vez, el `total` de
   * la última respuesta puede no ser el de la primera. Por eso se compara contra
   * el ÚLTIMO total informado, que es el más reciente que el servidor conoce.
   */
  if (acumulado.length !== totalInformado) {
    throw new ErrorDePaginacion(
      `Se reunieron ${acumulado.length} elementos y el servidor informa ${totalInformado}. La lista no está completa.`
    );
  }

  return acumulado;
}
