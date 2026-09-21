import { useEffect, useState } from "react";

/**
 * Fase 6, hallazgo 31 — CONSULTA DEL HISTORIAL, incluidas las CANCELADAS.
 *
 * Antes esa capacidad vivía en dos páginas sin ruta (`RegistrationsListPage` y
 * `RelayRegistrationsListPage`): existían en el código, tenían el selector
 * Confirmadas / Canceladas / Todas… y no había forma de llegar a ellas. Los
 * Workspace, que sí son accesibles, piden `status: "confirmed"` **fijo**, así que
 * no existía ninguna pantalla desde la que ver una inscripción cancelada.
 *
 * POR QUÉ UN PANEL APARTE Y NO UN FILTRO EN LA LISTA PRINCIPAL. La lista del
 * Workspace no es una tabla de consulta: alimenta la lógica de inscripción —qué
 * nadador figura ya inscrito en cada prueba, qué plaza está ocupada—. Meter ahí
 * las canceladas las haría contar como ocupadas y bloquearía inscripciones
 * legítimas. La consulta y la operación son dos cosas distintas y se mantienen
 * separadas.
 *
 * La cancelación es LÓGICA: la fila sigue en la base con `status = "cancelled"` y
 * la auditoría guarda quién y cuándo. Ese historial es el que se mira cuando hay
 * una reclamación —una plaza que se liberó, un cupo discutido—, así que guardarlo
 * y no ofrecer forma de verlo era lo peor de las dos opciones.
 *
 * ESTO ES UNA TABLA, Y PAGINA COMO UNA TABLA
 * ------------------------------------------
 * La primera versión traía el historial ENTERO con `traerTodasLasPaginas`, lo que
 * contradice de plano lo que ese archivo declara en su cabecera: es un mecanismo
 * **para selectores y conjuntos de decisión, no para tablas**. El precio era
 * concreto: hasta 100 peticiones para abrir el panel, hasta 10 000 filas montadas
 * a la vez en el DOM, y un historial que **falla por completo** en cuanto exista
 * un registro más allá de esas 10 000. Ahora se pide UNA página por vez y se
 * navega; `traerTodasLasPaginas` queda donde de verdad hace falta el conjunto
 * completo: la lista operativa del Workspace, que **miente si le falta una fila**.
 *
 * CÓMO SE GARANTIZA QUE NUNCA SE VE LO DE OTRA VISTA
 * --------------------------------------------------
 * Hay dos identidades, y cada una se resuelve donde corresponde:
 *
 *   1. EL CONJUNTO (`{dependencias, estado}`) — competencia, club y estado. Es la
 *      `key` de `<ContenidoDelHistorial>`. Cambiarla **desmonta** el componente y
 *      monta otro: su página, su petición y su resultado se van con él. No queda
 *      nada que resucitar ni que reutilizar, ni siquiera durante un render.
 *   2. LA PÁGINA, dentro de ese conjunto. El resultado se guarda **etiquetado con
 *      la página que lo produjo** y solo se pinta si esa etiqueta coincide con la
 *      página actual.
 *
 * Un intento anterior guardaba `{clave, page}` en estado y derivaba la página de
 * ahí. Fallaba de dos maneras: al volver a un conjunto ya visitado **resucitaba**
 * su página anterior, y las filas del conjunto anterior seguían en memoria,
 * visibles hasta que un efecto pasivo encendiera el indicador de carga. Es decir,
 * la corrección dependía de un `setCargando(true)` que corre DESPUÉS del commit.
 * Con la `key`, la garantía es estructural: no hay estado viejo que ocultar.
 */

/** Filas por página. El pie de navegación usa este mismo número. */
export const TAMANO_DE_PAGINA = 20;

export type EstadoConsultado = "confirmed" | "cancelled" | "todas";

export interface FilaDeHistorial {
  id: string;
  /** Celdas ya formateadas por quien conoce el dominio. */
  celdas: string[];
  cancelada: boolean;
}

/** Una página del historial, ya mapeada a filas por el cargador del dominio. */
export interface PaginaDeHistorial {
  filas: FilaDeHistorial[];
  total: number;
  page: number;
  pageSize: number;
}

export type CargarHistorial = (
  estado: "confirmed" | "cancelled" | undefined,
  page: number,
  pageSize: number
) => Promise<PaginaDeHistorial>;

interface Props {
  /** Encabezados de la tabla; su largo debe coincidir con el de `celdas`. */
  encabezados: string[];
  /**
   * Trae UNA página del estado pedido. `undefined` como estado significa
   * "todas". El cargador es responsable de validar la respuesta y **lanzar** si
   * no encaja con lo solicitado.
   */
  cargar: CargarHistorial;
  /** Se vuelve a cargar cuando cambia (competencia o club seleccionados). */
  dependencias: unknown[];
  /** Qué se está listando, para los textos: "inscripciones", "relevos"… */
  nombrePlural: string;
}

export function PanelDeHistorial({ encabezados, cargar, dependencias, nombrePlural }: Props) {
  const [abierto, setAbierto] = useState(false);
  const [estado, setEstado] = useState<EstadoConsultado>("cancelled");

  /**
   * La identidad del CONJUNTO consultado. Se usa como `key`, así que cambiarla
   * equivale a empezar de cero: página 1, sin resultado y sin error.
   *
   * El botón y el `<select>` quedan FUERA del componente con `key` a propósito:
   * remontarlos perdería el foco del teclado en cada cambio de filtro.
   */
  const claveDelConjunto = `${JSON.stringify(dependencias)}|${estado}`;

  return (
    <section style={{ marginTop: "1.5rem", borderTop: "1px solid var(--brand-gray-300)", paddingTop: "0.75rem" }}>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        style={{ fontSize: "0.85rem" }}
      >
        {abierto ? "Ocultar" : "Ver"} historial ({nombrePlural} canceladas y confirmadas)
      </button>

      {abierto && (
        <div style={{ marginTop: "0.75rem" }}>
          <label htmlFor="historial-estado" style={{ fontSize: "0.85rem" }}>
            Estado
          </label>
          <select
            id="historial-estado"
            value={estado}
            onChange={(e) => setEstado(e.target.value as EstadoConsultado)}
            style={{ maxWidth: 220 }}
          >
            <option value="cancelled">Canceladas</option>
            <option value="confirmed">Confirmadas</option>
            <option value="todas">Todas</option>
          </select>

          <ContenidoDelHistorial
            key={claveDelConjunto}
            encabezados={encabezados}
            cargar={cargar}
            estado={estado}
            nombrePlural={nombrePlural}
          />
        </div>
      )}
    </section>
  );
}

/** Lo que se sabe de UNA página pedida: o llegó, o falló. */
type Desenlace = { page: number; pagina: PaginaDeHistorial } | { page: number; error: string };

interface ContenidoProps {
  encabezados: string[];
  cargar: CargarHistorial;
  estado: EstadoConsultado;
  nombrePlural: string;
}

/**
 * La navegación, la petición y el resultado de UN conjunto.
 *
 * Vive detrás de una `key`: al cambiar de competencia, club o estado se desmonta
 * entero. Por eso aquí no hay ninguna comprobación de «¿sigue siendo mi
 * conjunto?» — la respuesta es sí por construcción.
 */
function ContenidoDelHistorial({ encabezados, cargar, estado, nombrePlural }: ContenidoProps) {
  const [page, setPage] = useState(1);
  const [desenlace, setDesenlace] = useState<Desenlace | null>(null);

  /**
   * ¿Hay algo que mostrar PARA ESTA PÁGINA? Se compara la etiqueta del resultado
   * con la página actual, y de ahí se **deriva** si está cargando, en vez de
   * guardarlo aparte.
   *
   * Esto es lo que hace innecesario un `setCargando(true)` dentro del efecto: al
   * pulsar «Siguiente», `page` pasa a 2 y el desenlace etiquetado con 1 deja de
   * coincidir **en el mismo render**, antes de que corra ningún efecto. La página
   * anterior no se presenta ni un instante como si fuera la nueva.
   */
  const deEstaPagina = desenlace?.page === page ? desenlace : null;

  useEffect(() => {
    /**
     * `vigente` cubre el cambio de página y el desmontaje. No hace falta además
     * un contador de peticiones: el pie de navegación solo existe cuando hay
     * resultado para la página actual, así que dentro de un conjunto nunca hay
     * dos peticiones en vuelo. Y si alguna se colara por la ventana anterior a
     * los efectos pasivos, escribiría un desenlace etiquetado con SU página, que
     * el render descarta por no coincidir con la actual.
     */
    let vigente = true;

    cargar(estado === "todas" ? undefined : estado, page, TAMANO_DE_PAGINA)
      .then((pagina) => {
        if (!vigente) return;
        setDesenlace({ page, pagina });
        /**
         * Si el conjunto encogió mientras se navegaba, esta página ya no existe:
         * quedaría una tabla vacía y **sin pie de navegación** —el pie solo se
         * pinta con `total > 0`—, o sea, sin forma de volver.
         */
        const ultimaValida = Math.max(1, Math.ceil(pagina.total / (pagina.pageSize || TAMANO_DE_PAGINA)));
        if (page > ultimaValida) setPage(ultimaValida);
      })
      .catch((err: unknown) => {
        if (!vigente) return;
        // El cargador LANZA si la página recibida no es la pedida o no encaja:
        // aquí eso se muestra, no se disimula con filas de otra consulta.
        setDesenlace({
          page,
          error: err instanceof Error ? err.message : `No se pudo cargar el historial de ${nombrePlural}`,
        });
      });

    return () => {
      vigente = false;
    };
    // `cargar`, `estado` y `nombrePlural` se excluyen a propósito: `cargar` es una
    // función nueva en cada render del Workspace y depender de su identidad
    // recargaría en bucle; los otros dos son constantes dentro de esta instancia,
    // porque cambiarlos cambia la `key` y monta otra.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  if (deEstaPagina === null) {
    return <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)", marginTop: "0.75rem" }}>Cargando…</p>;
  }
  if ("error" in deEstaPagina) {
    return <p className="error-message">{deEstaPagina.error}</p>;
  }

  const { pagina } = deEstaPagina;
  const total = pagina.total;
  const tamano = pagina.pageSize || TAMANO_DE_PAGINA;
  const ultimaPagina = Math.max(1, Math.ceil(total / tamano));
  const desde = total === 0 ? 0 : (page - 1) * tamano + 1;
  const hasta = Math.min(page * tamano, total);

  return (
    <>
      <table className="data-table" style={{ marginTop: "0.75rem" }}>
        <thead>
          <tr>
            {encabezados.map((h) => (
              <th key={h}>{h}</th>
            ))}
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {pagina.filas.map((f) => (
            /**
             * Solo lectura, a propósito: una inscripción cancelada no se edita ni
             * se vuelve a cancelar. Las acciones viven en la lista operativa, que
             * solo tiene confirmadas.
             */
            <tr key={f.id} style={f.cancelada ? { opacity: 0.65 } : undefined}>
              {f.celdas.map((c, i) => (
                <td key={i}>{c}</td>
              ))}
              <td>
                <span className={f.cancelada ? "badge-disabled" : "badge-active"}>
                  {f.cancelada ? "Cancelada" : "Confirmada"}
                </span>
              </td>
            </tr>
          ))}
          {pagina.filas.length === 0 && (
            <tr>
              <td
                colSpan={encabezados.length + 1}
                style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1.25rem" }}
              >
                Sin {nombrePlural} para este filtro.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/*
        PIE DE NAVEGACIÓN. Se pinta siempre que haya algo: es lo que sustituye al
        recorrido completo de páginas, así que si no está, las filas siguientes
        son inalcanzables.
      */}
      {total > 0 && (
        <div
          style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.5rem", fontSize: "0.85rem" }}
        >
          <span>
            Mostrando {desde}–{hasta} de {total}
          </span>
          <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Anterior
          </button>
          <span>
            Página {page} de {ultimaPagina}
          </span>
          <button
            type="button"
            className="btn-secondary"
            disabled={page >= ultimaPagina}
            onClick={() => setPage(page + 1)}
          >
            Siguiente
          </button>
        </div>
      )}
    </>
  );
}
