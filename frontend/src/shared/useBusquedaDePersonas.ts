import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fase 6, hallazgo 28 — BUSCAR PERSONAS SIN DEJAR NINGUNA FUERA DE ALCANCE.
 *
 * Los tres buscadores de personas —`PersonPicker`, `PersonMultiPicker` y el
 * plantel de `ClubSwimmersSection`— pedían la primera página y se quedaban ahí.
 * Avisar de que había más coincidencias fue el primer paso, pero un aviso no
 * resuelve el problema de fondo: **la persona número 21 seguía siendo
 * inalcanzable**, por mucho que el usuario supiera que existía.
 *
 * Tampoco vale traerlas todas: un `search` de dos letras puede coincidir con
 * miles de personas, y descargarlas para que el usuario mire cinco es un
 * despilfarro que además tarda. Lo que corresponde es acumular páginas **a
 * petición**: "Cargar más resultados".
 *
 * CARRERAS ASINCRÓNICAS. Al teclear se disparan búsquedas sucesivas y las
 * respuestas no vuelven en orden: la de "gonz" puede llegar DESPUÉS de la de
 * "gonzalez" y dejar en pantalla los resultados de una consulta que el usuario ya
 * no está escribiendo. Cada solicitud lleva un número monotónico y solo se aplica
 * la respuesta si sigue siendo la última. Un `AbortController` cancelaría además
 * la petición en vuelo, pero el cliente HTTP de este proyecto no acepta `signal`;
 * el contador cubre el efecto observable, que es el que importa.
 */

export interface OpcionDePersona {
  id: string;
  fullName: string;
  run: string;
}

interface RespuestaDeBusqueda {
  items: Array<{ id: string; fullName: string; run: string }>;
  total: number;
  page: number;
  pageSize: number;
}

/**
 * VALIDACIÓN DE LA PÁGINA, FAIL-CLOSED.
 *
 * El hook solo miraba `items` y `total`. Con una respuesta rara —página vacía
 * antes de tiempo, repetida, mal numerada, `total` disparatado— seguía ofreciendo
 * "Cargar más" indefinidamente: el usuario pulsaba y no pasaba nada, sin ninguna
 * explicación. Ahora una respuesta que no encaja detiene la navegación con un
 * mensaje, igual que en `paginacion.ts`.
 *
 * @throws {Error} con el motivo, para que el llamador lo muestre.
 */
function validarPagina(respuesta: unknown, pagePedida: number): RespuestaDeBusqueda {
  if (typeof respuesta !== "object" || respuesta === null) {
    throw new Error(`La búsqueda devolvió una respuesta que no se entiende (página ${pagePedida}).`);
  }
  const r = respuesta as Record<string, unknown>;

  if (!Array.isArray(r.items)) throw new Error(`La página ${pagePedida} no trae una lista de personas.`);
  if (!Number.isInteger(r.total) || (r.total as number) < 0) {
    throw new Error(`La búsqueda informa un total inválido (${String(r.total)}).`);
  }
  if (!Number.isInteger(r.page) || (r.page as number) < 1) {
    throw new Error(`La página ${pagePedida} informa un número de página inválido (${String(r.page)}).`);
  }
  if (!Number.isInteger(r.pageSize) || (r.pageSize as number) < 1) {
    throw new Error(`La página ${pagePedida} informa un tamaño inválido (${String(r.pageSize)}).`);
  }
  // Un proxy que sirva de caché la primera página haría girar en el vacío.
  if (r.page !== pagePedida) {
    throw new Error(`Se pidió la página ${pagePedida} y llegó la ${String(r.page)}.`);
  }
  if ((r.items as unknown[]).length > (r.pageSize as number)) {
    throw new Error(`La página ${pagePedida} trae más personas de las que dice su tamaño.`);
  }
  /**
   * `trim()`, no solo `!== ""`. Una cadena de espacios pasa la comprobación de
   * vacío y en pantalla es indistinguible de un hueco: una opción en blanco que
   * el usuario no puede elegir con criterio, o un identificador que parece válido
   * y no lo es.
   */
  const esCadenaUtil = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

  for (const p of r.items as Array<Record<string, unknown>>) {
    if (typeof p !== "object" || p === null || !esCadenaUtil(p.id)) {
      throw new Error(`La página ${pagePedida} trae una persona sin identificador.`);
    }
    // `fullName` y `run` no son decorativos: son lo ÚNICO que el usuario ve.
    if (!esCadenaUtil(p.fullName)) {
      throw new Error(`La página ${pagePedida} trae una persona sin nombre (id ${String(p.id)}).`);
    }
    if (!esCadenaUtil(p.run)) {
      throw new Error(`La página ${pagePedida} trae una persona sin RUN (id ${String(p.id)}).`);
    }
  }

  return r as unknown as RespuestaDeBusqueda;
}

/** Mínimo de caracteres antes de molestar al servidor. */
const MINIMO_PARA_BUSCAR = 2;
const RETARDO_MS = 250;

export interface BusquedaDePersonas {
  search: string;
  setSearch: (valor: string) => void;
  /** Opciones acumuladas de todas las páginas pedidas, sin repetidos. */
  opciones: OpcionDePersona[];
  /** Total de coincidencias que informa el servidor. */
  total: number;
  /** ¿Quedan páginas por pedir? */
  hayMas: boolean;
  cargarMas: () => void;
  cargando: boolean;
  error: string | null;
  /** Vacía la consulta y todo lo asociado (tras elegir a alguien, por ejemplo). */
  limpiar: () => void;
  /**
   * Reintenta la última página que falló, conservando la consulta y lo ya
   * acumulado. Sin esto, un fallo dejaba la búsqueda bloqueada: el botón de
   * "Cargar más" desaparecía con el error y no había forma de seguir salvo
   * volver a teclear.
   */
  reintentar: () => void;
  /**
   * Descarta lo acumulado y vuelve a empezar por la primera página, con el mismo
   * texto. Es lo que corresponde cuando el reparto cambió a mitad del recorrido:
   * reintentar la misma página seguiría mezclando dos estados distintos.
   */
  reiniciarBusqueda: () => void;
  /** ¿La incoherencia obliga a reiniciar, en vez de poder reintentar? */
  requiereReinicio: boolean;
}

export function useBusquedaDePersonas(
  buscar: (params: { search: string; page: number }) => Promise<RespuestaDeBusqueda>
): BusquedaDePersonas {
  const [search, setSearchInterno] = useState("");
  const [opciones, setOpciones] = useState<OpcionDePersona[]>([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(1);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Se incrementa para forzar otro intento de la MISMA página. Es lo que
   * distingue "reintentar" de "cargar la siguiente".
   */
  const [intento, setIntento] = useState(0);
  /**
   * Cuando la incoherencia es del REPARTO —el total o el tamaño cambiaron, o
   * llegaron más personas de las declaradas— reintentar la misma página no
   * arregla nada: hay que rehacer el recorrido desde el principio.
   */
  const [requiereReinicio, setRequiereReinicio] = useState(false);

  /**
   * Número de la última solicitud emitida. Una respuesta con un número menor
   * pertenece a una consulta anterior y se descarta sin tocar nada.
   */
  const ultimaSolicitud = useRef(0);

  /**
   * Espejo de las opciones acumuladas. Permite decidir si una página aportó algo
   * SIN meter esa lógica dentro del actualizador de `setOpciones`: un actualizador
   * debe ser puro, y React puede ejecutarlo dos veces en modo estricto.
   */
  /**
   * El `total` y el `pageSize` de la PRIMERA página de esta búsqueda.
   *
   * Tienen que mantenerse mientras se recorre. Si cambian, la paginación por
   * desplazamiento ya se movió bajo los pies —alguien insertó o borró— y lo
   * acumulado deja de ser un recorrido coherente: no se puede seguir sumando
   * páginas de dos repartos distintos como si fueran uno.
   */
  const totalDeLaBusqueda = useRef<number | null>(null);
  const pageSizeDeLaBusqueda = useRef<number | null>(null);

  const opcionesRef = useRef<OpcionDePersona[]>([]);
  useEffect(() => {
    opcionesRef.current = opciones;
  }, [opciones]);

  const buscarRef = useRef(buscar);
  useEffect(() => {
    buscarRef.current = buscar;
  }, [buscar]);

  const limpiarTodo = useCallback(() => {
    // Se invalida cualquier respuesta en vuelo: lo que llegue después ya no vale.
    ultimaSolicitud.current++;
    totalDeLaBusqueda.current = null;
    pageSizeDeLaBusqueda.current = null;
    setOpciones([]);
    setTotal(0);
    setPagina(1);
    setError(null);
    setCargando(false);
    setIntento(0);
    setRequiereReinicio(false);
  }, []);

  /** Cambiar la consulta REINICIA página, resultados, total y error. */
  const setSearch = useCallback(
    (valor: string) => {
      setSearchInterno(valor);
      limpiarTodo();
    },
    [limpiarTodo]
  );

  const limpiar = useCallback(() => {
    setSearchInterno("");
    limpiarTodo();
  }, [limpiarTodo]);

  useEffect(() => {
    const consulta = search.trim();
    if (consulta.length < MINIMO_PARA_BUSCAR) {
      // Consulta borrada o demasiado corta: NADA de lo anterior sigue siendo
      // válido. Conservar opciones de otra consulta es peor que no mostrar nada.
      ultimaSolicitud.current++;
      setOpciones([]);
      setTotal(0);
      setError(null);
      setCargando(false);
      return;
    }

    const idDeEstaSolicitud = ++ultimaSolicitud.current;
    const esPrimeraPagina = pagina === 1;
    setCargando(true);

    const temporizador = setTimeout(() => {
      buscarRef
        .current({ search: consulta, page: pagina })
        .then((crudo) => {
          // ¿Sigue siendo la última? Si no, esta respuesta es de otra consulta.
          if (idDeEstaSolicitud !== ultimaSolicitud.current) return;

          const res = validarPagina(crudo, pagina);

          /**
           * ESTABILIDAD DEL REPARTO. `total` y `pageSize` se fijan con la primera
           * página y no pueden cambiar: si lo hacen, las páginas siguientes
           * pertenecen a un reparto distinto y unirlas produciría una lista que
           * no corresponde a ningún estado real de la base.
           */
          if (esPrimeraPagina) {
            totalDeLaBusqueda.current = res.total;
            pageSizeDeLaBusqueda.current = res.pageSize;
          } else {
            if (totalDeLaBusqueda.current !== null && res.total !== totalDeLaBusqueda.current) {
              setError(
                `Los resultados cambiaron mientras se cargaban (antes ${totalDeLaBusqueda.current}, ahora ${res.total}). ` +
                  `Reinicie la búsqueda para ver una lista coherente.`
              );
              setRequiereReinicio(true);
              return;
            }
            if (pageSizeDeLaBusqueda.current !== null && res.pageSize !== pageSizeDeLaBusqueda.current) {
              setError(
                `El tamaño de página cambió durante la búsqueda (antes ${pageSizeDeLaBusqueda.current}, ahora ${res.pageSize}). ` +
                  `Reinicie la búsqueda.`
              );
              setRequiereReinicio(true);
              return;
            }
          }

          const base = esPrimeraPagina ? [] : opcionesRef.current;
          const vistos = new Set(base.map((o) => o.id));
          const nuevas = [...base];
          for (const p of res.items) {
            // Deduplicación por id: el desplazamiento de la paginación puede
            // devolver el mismo registro en dos páginas.
            if (vistos.has(p.id)) continue;
            vistos.add(p.id);
            nuevas.push({ id: p.id, fullName: p.fullName, run: p.run });
          }

          /**
           * SIN PROGRESO Y CON PERSONAS PENDIENTES: página vacía antes de
           * tiempo, repetida, o un `total` que no cuadra con lo que el servidor
           * entrega. Antes esto dejaba el botón "Cargar más" activo para
           * siempre, sin añadir a nadie y sin decir por qué.
           */
          const faltan = res.total - nuevas.length;
          const noAvanza = !esPrimeraPagina && nuevas.length === base.length && faltan > 0;
          const vaciaPrematura = esPrimeraPagina && res.items.length === 0 && res.total > 0;

          /**
           * MÁS DE LOS QUE DICE HABER. Con 20 acumulados, 20 nuevos y `total` 30,
           * el contador mostraba «40 de 30» y se daba por bueno. O el `total`
           * miente o las páginas se solapan mal: en cualquier caso la lista no es
           * la que el servidor dice tener.
           */
          if (nuevas.length > res.total) {
            setError(
              `La búsqueda devolvió ${nuevas.length} personas para un total declarado de ${res.total}. Reinicie la búsqueda.`
            );
            setRequiereReinicio(true);
            return;
          }

          /**
           * PÁGINA CORTA CON POSTERIORES. Una página que no se llena es la
           * última por definición: si además dice que faltan, el reparto no
           * cuadra. (Si algún endpoint filtrara después de paginar y esto
           * dejara de ser cierto, habría que justificarlo aquí, no relajarlo en
           * silencio.)
           */
          if (res.items.length < res.pageSize && faltan > 0) {
            setError(
              `La página ${pagina} llegó incompleta (${res.items.length} de ${res.pageSize}) pero aún faltarían ${faltan} ` +
                `de ${res.total}. Reinicie la búsqueda.`
            );
            setRequiereReinicio(true);
            return;
          }

          if (noAvanza) {
            setError(
              `La búsqueda no avanza: faltan ${faltan} de ${res.total} coincidencias y la página ${pagina} no aportó ninguna nueva.`
            );
            return;
          }
          if (vaciaPrematura) {
            setError(`La búsqueda informa ${res.total} coincidencias pero no devolvió ninguna.`);
            return;
          }

          setOpciones(nuevas);
          setTotal(res.total);
          setError(null);
        })
        .catch((err: unknown) => {
          if (idDeEstaSolicitud !== ultimaSolicitud.current) return;
          setError(err instanceof Error ? err.message : "No se pudo buscar personas");

          /**
           * QUÉ SE CONSERVA DEPENDE DE QUÉ PÁGINA FALLÓ.
           *
           * - La PRIMERA: no hay nada válido que mostrar. Dejar en pantalla las
           *   opciones de la consulta anterior, junto al aviso de "hay más",
           *   haría creer que la lista está truncada cuando lo que pasó es que la
           *   búsqueda falló.
           * - Una POSTERIOR: lo ya acumulado sigue siendo válido —vino de páginas
           *   que sí respondieron—, así que se conserva. Borrarlo obligaba a
           *   empezar de cero y hacía inútil el botón de reintentar.
           */
          if (esPrimeraPagina) {
            setOpciones([]);
            setTotal(0);
          }
        })
        .finally(() => {
          if (idDeEstaSolicitud === ultimaSolicitud.current) setCargando(false);
        });
    }, RETARDO_MS);

    return () => clearTimeout(temporizador);
  }, [search, pagina, intento]);

  const cargarMas = useCallback(() => {
    // Con un error en pantalla no se avanza: primero hay que reintentar.
    setError(null);
    setPagina((p) => p + 1);
  }, []);

  const reintentar = useCallback(() => {
    setError(null);
    setIntento((i) => i + 1);
  }, []);

  const reiniciarBusqueda = useCallback(() => {
    ultimaSolicitud.current++;
    totalDeLaBusqueda.current = null;
    pageSizeDeLaBusqueda.current = null;
    opcionesRef.current = [];
    setOpciones([]);
    setTotal(0);
    setError(null);
    setRequiereReinicio(false);
    setPagina(1);
    setIntento((i) => i + 1);
  }, []);

  return {
    search,
    setSearch,
    opciones,
    total,
    /**
     * El botón desaparece cuando ya se tiene todo… y también cuando hay un error:
     * insistir en avanzar sobre una búsqueda que falló solo repite el fallo. En
     * ese caso lo que se ofrece es `reintentar`.
     */
    hayMas: error === null && opciones.length < total,
    cargarMas,
    cargando,
    error,
    limpiar,
    reintentar,
    reiniciarBusqueda,
    requiereReinicio,
  };
}
