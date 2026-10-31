import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import { useSwimmerAssignmentApi, type ClubSwimmerAssignment } from "./assignmentApi";
import { usePersonsApi } from "../persons/personsApi";
import { useSort, sortItems, SortableTh } from "../../shared/sortableTable";
import { formatearFechaCalendario, claveOrdenFechaCalendario, esFechaCalendario } from "../../shared/fechaCalendario";
import { useBusquedaDePersonas } from "../../shared/useBusquedaDePersonas";

/** Filas por página de la tabla. El pie de página usa este mismo número. */
const TAMANO_DE_PAGINA = 20;

/**
 * VALIDACIÓN FAIL-CLOSED DE LA PÁGINA RECIBIDA.
 *
 * La tabla se fiaba de la forma de la respuesta, y eso deja pasar truncaciones
 * silenciosas. El caso que lo resume: se piden 20 de la página 1 y el servidor
 * responde `pageSize: 100`, `total: 45`, con 20 filas. El pie de página calcula
 * `1 * 100 >= 45` y **deshabilita "Siguiente"**: 25 membresías desaparecen sin
 * que nada avise. Por eso `pageSize` no puede ser mayor que el solicitado.
 *
 * @throws {Error} con el motivo, para que la pantalla lo muestre y ofrezca
 *   reintentar. Media tabla con apariencia de completa es peor que un error.
 */
function validarPaginaDeLaTabla(respuesta: unknown, pagePedida: number, pageSizePedido: number) {
  if (typeof respuesta !== "object" || respuesta === null) {
    throw new Error(`El plantel llegó en un formato que no se entiende (página ${pagePedida}).`);
  }
  const r = respuesta as Record<string, unknown>;

  if (!Array.isArray(r.items)) throw new Error(`La página ${pagePedida} del plantel no trae una lista de membresías.`);
  if (!Number.isInteger(r.total) || (r.total as number) < 0) {
    throw new Error(`El plantel informa un total inválido (${String(r.total)}).`);
  }
  if (!Number.isInteger(r.pageSize) || (r.pageSize as number) < 1) {
    throw new Error(`El plantel informa un tamaño de página inválido (${String(r.pageSize)}).`);
  }
  /**
   * Nunca MAYOR que el pedido. Un servidor puede recortar el tamaño —y se
   * respeta—, pero si dice haber servido más de lo que se le pidió, el pie de
   * página calcularía la navegación sobre un número falso.
   */
  if ((r.pageSize as number) > pageSizePedido) {
    throw new Error(`Se pidieron ${pageSizePedido} membresías por página y el servidor informa ${String(r.pageSize)}.`);
  }
  if (!Number.isInteger(r.page) || (r.page as number) < 1 || r.page !== pagePedida) {
    throw new Error(`Se pidió la página ${pagePedida} del plantel y llegó la ${String(r.page)}.`);
  }

  const items = r.items as unknown[];
  const total = r.total as number;
  const pageSize = r.pageSize as number;

  if (items.length > pageSize) {
    throw new Error(`La página ${pagePedida} trae más membresías de las que dice su tamaño.`);
  }
  if (total === 0 && items.length > 0) {
    throw new Error(`El plantel informa 0 membresías y sin embargo devolvió ${items.length}.`);
  }

  /**
   * Coherencia entre la página y el total. `offset` es cuántas filas quedan
   * detrás; lo que puede venir en esta página es, como mucho, lo que falta.
   */
  const offset = (pagePedida - 1) * pageSize;
  const disponibles = Math.max(0, total - offset);
  if (items.length > disponibles) {
    throw new Error(
      `La página ${pagePedida} trae ${items.length} membresías, pero según el total (${total}) solo quedaban ${disponibles}.`
    );
  }
  /**
   * Y una página INTERMEDIA no puede venir corta: si el total dice que hay más
   * detrás, la página tenía que venir llena. Una página corta es, por
   * definición, la última.
   */
  if (items.length < pageSize && items.length < disponibles) {
    throw new Error(
      `La página ${pagePedida} llegó incompleta (${items.length} de ${pageSize}) aunque el total (${total}) indica que hay más.`
    );
  }

  /**
   * FORMA MÍNIMA DE CADA FILA: exactamente lo que el render usa. Una membresía
   * sin `person` reventaría al pintar, y el error saldría lejos de su origen.
   */
  const ESTADOS = ["pending", "active", "rejected", "ended"];
  for (const fila of items) {
    if (typeof fila !== "object" || fila === null) {
      throw new Error(`La página ${pagePedida} trae una membresía que no es un objeto.`);
    }
    const f = fila as Record<string, unknown>;
    if (typeof f.id !== "string" || f.id.trim() === "") {
      throw new Error(`La página ${pagePedida} trae una membresía sin identificador.`);
    }
    if (typeof f.status !== "string" || !ESTADOS.includes(f.status)) {
      throw new Error(`La membresía ${String(f.id)} tiene un estado desconocido (${String(f.status)}).`);
    }
    if (typeof f.person !== "object" || f.person === null) {
      throw new Error(`La membresía ${String(f.id)} no trae los datos del nadador.`);
    }
    const persona = f.person as Record<string, unknown>;
    if (typeof persona.fullName !== "string" || persona.fullName.trim() === "") {
      throw new Error(`La membresía ${String(f.id)} trae un nadador sin nombre.`);
    }
    if (typeof persona.run !== "string" || persona.run.trim() === "") {
      throw new Error(`La membresía ${String(f.id)} trae un nadador sin RUN.`);
    }
    // `startDate` puede faltar —se pinta como "—"—, pero si viene tiene que ser
    // una fecha de CALENDARIO: `AAAA-MM-DD`, con o sin la hora que añade la
    // serialización. Antes bastaba con que `new Date()` la supiera interpretar,
    // que acepta formas que esta pantalla no sabe mostrar sin desplazar el día.
    if (f.startDate !== null && f.startDate !== undefined) {
      if (!esFechaCalendario(f.startDate)) {
        throw new Error(`La membresía ${String(f.id)} trae una fecha de inicio ilegible.`);
      }
    }
  }

  return r as unknown as { items: ClubSwimmerAssignment[]; total: number; page: number; pageSize: number };
}

const STATUS_LABELS: Record<string, string> = { pending: "Pendiente", active: "Activo", rejected: "Rechazado", ended: "Finalizado" };
const STATUS_BADGE: Record<string, string> = { pending: "badge-locked", active: "badge-active", rejected: "badge-disabled", ended: "badge-disabled" };

interface ClubSwimmersSectionProps {
  clubId: string;
}

export function ClubSwimmersSection({ clubId }: ClubSwimmersSectionProps) {
  const api = useSwimmerAssignmentApi();
  const personsApi = usePersonsApi();
  const [assignments, setAssignments] = useState<ClubSwimmerAssignment[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(TAMANO_DE_PAGINA);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** Hay una carga de la tabla en vuelo: la navegación y las acciones esperan. */
  const [cargando, setCargando] = useState(true);
  /**
   * LAS ESCRITURAS EN VUELO, UNA POR CLUB.
   *
   * Ni un booleano ni un solo `{id, clubId}` bastan:
   *
   *   - El booleano bloqueaba TODOS los clubes mientras una operación de
   *     cualquiera siguiera en vuelo, y `fetch` no tiene tiempo de espera: una
   *     petición que nunca conteste dejaría la aplicación inservible.
   *   - Un único `{id, clubId}` se PIERDE al empezar otra operación: con A1 en
   *     vuelo, iniciar B1 sobrescribía el registro de A; al volver a A, la
   *     interfaz creía que no había nada en curso y permitía A2, con dos
   *     escrituras simultáneas sobre el mismo club.
   *
   * Un registro por club conserva las dos. El `Record` que se pinta y la `ref`
   * que lo espeja van a la par: la ref permite la comprobación **síncrona** del
   * manejador —antes de que React haya vuelto a pintar—, que es la que de verdad
   * impide la doble escritura; el estado solo sirve para deshabilitar los
   * controles.
   */
  const [accionesPorClub, setAccionesPorClub] = useState<Record<string, number>>({});
  const accionesRef = useRef<Record<string, number>>({});
  const proximaAccion = useRef(0);
  /** ¿Hay una escritura en curso EN ESTE club? */
  const accionEnCurso = accionesPorClub[clubId] !== undefined;

  /**
   * Registra la operación si el club está libre. Devuelve su id, o `null` si ya
   * había una en curso —comprobación síncrona, sin esperar a un render—.
   */
  function reservarAccion(club: string): number | null {
    if (accionesRef.current[club] !== undefined) return null;
    const id = ++proximaAccion.current;
    accionesRef.current = { ...accionesRef.current, [club]: id };
    setAccionesPorClub(accionesRef.current);
    return id;
  }

  /** Libera la operación SOLO si sigue siendo la registrada para ese club. */
  function liberarAccion(club: string, id: number): void {
    if (accionesRef.current[club] !== id) return;
    const resto = { ...accionesRef.current };
    delete resto[club];
    accionesRef.current = resto;
    setAccionesPorClub(resto);
  }
  /**
   * Se incrementa para pedir OTRA carga de la vista vigente. Es lo que usan las
   * mutaciones en vez de invocar un `load` capturado: aquel pertenecía al render
   * donde empezó la operación y recargaba el club de entonces, no el de ahora.
   */
  const [recargas, setRecargas] = useState(0);
  const recargar = useCallback(() => setRecargas((n) => n + 1), []);

  /**
   * AL CAMBIAR DE CLUB SE VUELVE A LA PRIMERA PÁGINA.
   *
   * Sin esto, quien estuviera en la página 3 del plantel de un club y cambiara a
   * otro con menos de 41 nadadores se encontraba una tabla vacía, sin ninguna
   * pista de que bastaba con pulsar "Anterior".
   *
   * El ajuste se hace DURANTE EL RENDER comparando con el club anterior —el
   * patrón que documenta React para derivar estado de una prop—, no en un
   * efecto: en un efecto habría un render intermedio pidiendo la página 3 del
   * club nuevo.
   */
  const [clubAnterior, setClubAnterior] = useState(clubId);
  if (clubId !== clubAnterior) {
    setClubAnterior(clubId);
    setPage(1);
    /**
     * Las filas del club anterior se retiran EN EL ACTO, sin esperar a la
     * respuesta del nuevo. Mientras llega, la tabla no muestra membresías de
     * otro club con botones operables encima: "finalizar membresía" sobre una
     * fila del club A estando ya en el B sería un borrado en el club
     * equivocado.
     */
    setAssignments([]);
    setTotal(0);
    setError(null);
    setMessage(null);
    setCargando(true);
  }
  /**
   * Búsqueda de nadadores para asignar: compartida con los demás buscadores de
   * personas. Trae la primera página y acumula más A PETICIÓN —un `search` de
   * dos letras puede coincidir con miles—, sin dejar a nadie inalcanzable.
   */
  const busqueda = useBusquedaDePersonas(({ search, page }) => personsApi.list({ search, page }));
  const { sortKey, sortDir, onSort } = useSort<"person" | "status" | "startDate">();

  /**
   * CARRERAS ENTRE PETICIONES DE LA TABLA.
   *
   * Reiniciar la página al cambiar de club no bastaba: la petición del club
   * ANTERIOR sigue en vuelo y puede terminar DESPUÉS que la del nuevo,
   * sobrescribiendo filas, total y tamaño. El resultado es una tabla que muestra
   * el plantel del club A bajo el rótulo del club B —y sus botones de "finalizar
   * membresía" operarían sobre membresías que no son las que se ven—.
   *
   * Lo mismo entre páginas del MISMO club si se pulsa "Siguiente" deprisa: la
   * respuesta de la 2 puede llegar después de la de la 3.
   *
   * El mecanismo NO es un contador monotónico de peticiones —eso es lo que usa el
   * buscador de personas—, sino una **clave de generación de vista**: cada
   * petición se marca con la clave `{clubId, page, recargas}` desde la que salió,
   * y solo puede aplicar su respuesta, su error o apagar el indicador de carga si
   * esa clave sigue siendo la vigente.
   *
   * La diferencia es deliberada. Un contador ordena las peticiones entre sí, pero
   * no dice a qué vista pertenecen: la respuesta más reciente ganaría aunque
   * viniera del club anterior. La clave identifica la vista, así que una respuesta
   * de A queda descartada por no corresponder a la vista actual, sea o no la
   * última en llegar. Y `recargas` la hace cambiar también cuando el `{clubId,
   * page}` se repite, que es el caso del reintento.
   *
   * `AbortController` no se usa porque el cliente HTTP del proyecto no acepta
   * `signal`; la clave cubre el efecto observable, que es el que importa.
   */
  /**
   * IDENTIDAD DE LA VISTA, REGISTRADA DE FORMA SÍNCRONA.
   *
   * Toda respuesta —de una carga o de una mutación— se contrasta contra esta
   * clave antes de tocar nada. Incluye `recargas` porque un reintento sobre el
   * mismo `{clubId, page}` también invalida lo anterior.
   *
   * VA EN `useLayoutEffect`, NO EN `useEffect`, y la diferencia importa:
   *
   *   - `useEffect` es **pasivo**: React lo programa para después del commit. Entre
   *     que el commit del club B termina y su efecto pasivo corre, el bucle de
   *     eventos puede procesar microtareas —por ejemplo la resolución de la
   *     petición del club A—. En esa ventana la clave todavía diría "A", y la
   *     respuesta atrasada se aplicaría.
   *   - `useLayoutEffect` corre **dentro del commit**, síncronamente, antes de
   *     ceder el control. Cuando cualquier microtarea posterior se ejecuta, la
   *     clave ya es la de B.
   *
   * La limpieza del efecto pasivo de carga sigue estando (marca `vigente = false`),
   * pero ya no es la única protección: es la segunda.
   */
  const claveDeLaVista = `${clubId}|${page}|${recargas}`;
  const claveVigenteRef = useRef(claveDeLaVista);
  const clubVigenteRef = useRef(clubId);
  useLayoutEffect(() => {
    claveVigenteRef.current = claveDeLaVista;
    clubVigenteRef.current = clubId;
  }, [claveDeLaVista, clubId]);

  /**
   * ¿Puede esta respuesta tocar el estado?
   *
   * Dos condiciones independientes:
   *   - `vigente`: su efecto no ha sido limpiado (cambio de vista o desmontaje);
   *   - la clave de la vista de la que salió sigue siendo la vigente.
   *
   * La segunda es la que cierra la ventana descrita arriba; la primera cubre el
   * desmontaje, donde ya no hay clave nueva que registrar.
   */
  const aplicable = useCallback(
    (vigente: boolean, claveDeLaPeticion: string) => vigente && claveVigenteRef.current === claveDeLaPeticion,
    []
  );

  useEffect(() => {
    /**
     * El plantel se muestra por defecto solo "activo" —lo que espera ver un
     * delegado o entrenador al revisar "todos los nadadores del club"—. El
     * historial completo (pendientes/rechazados/finalizados) se revisa en la
     * pantalla general de Asignación de nadadores.
     *
     * ESTA ES UNA TABLA CON PAGINACIÓN VISIBLE, así que pide el tamaño que
     * realmente muestra. Antes pedía 100 fijo mientras el pie de página
     * calculaba "Siguiente" con `pageSize`, que arrancaba en 20: los dos
     * números no eran el mismo y la navegación quedaba descuadrada.
     */
    let vigente = true;
    const claveDeEstaPeticion = claveDeLaVista;
    setCargando(true);

    api
      .list({ clubId, status: "active", page, pageSize: TAMANO_DE_PAGINA })
      .then((crudo) => {
        if (!aplicable(vigente, claveDeEstaPeticion)) return;

        // Lanza si la respuesta no encaja; lo recoge el `catch` de abajo, que
        // retira las filas y deja el error con su botón de reintento.
        const res = validarPaginaDeLaTabla(crudo, page, TAMANO_DE_PAGINA);

        setAssignments(res.items);
        setTotal(res.total);
        // El backend puede recortar el tamaño pedido: manda el que aplicó.
        setPageSize(res.pageSize);
        // Una carga correcta borra el error anterior.
        setError(null);

        /**
         * PÁGINA FUERA DE RANGO. Al finalizar la última membresía de la última
         * página, esa página deja de existir y la tabla quedaba vacía con los
         * botones de navegación en un estado imposible. Se vuelve a la última
         * página que sí tiene filas.
         */
        const ultimaValida = Math.max(1, Math.ceil(res.total / (res.pageSize || TAMANO_DE_PAGINA)));
        /**
         * También cuando el total pasa a CERO. Exigir `total > 0` dejaba a quien
         * estuviera en la página 3 atrapado en una tabla vacía y sin pie de
         * navegación —el pie solo se pinta con `total > 0`—, sin ninguna forma de
         * volver.
         */
        if (page > ultimaValida) setPage(ultimaValida);
      })
      .catch((err: unknown) => {
        if (!aplicable(vigente, claveDeEstaPeticion)) return;
        setError(err instanceof Error ? err.message : "No se pudo cargar el plantel del club");
        /**
         * Las filas de la carga fallida se retiran: dejarlas visibles junto a un
         * error haría creer que siguen siendo el estado real, y sus acciones
         * operarían sobre datos que quizá ya no existen.
         */
        setAssignments([]);
        setTotal(0);
      })
      .finally(() => {
        if (aplicable(vigente, claveDeEstaPeticion)) setCargando(false);
      });

    /**
     * Segunda barrera: al desmontar —o antes de relanzar el efecto— esta
     * petición deja de poder aplicar nada. La primera es la clave de vista, que
     * ya se actualizó síncronamente en el `useLayoutEffect`.
     */
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveDeLaVista]);

  /**
   * MUTACIONES ATADAS AL CLUB DONDE EMPEZARON.
   *
   * `handleAssign` y `handleEndMembership` capturaban el `clubId` y el `load` del
   * render en el que arrancaron. Si el usuario cambiaba de club mientras la
   * petición estaba en vuelo, al resolverse escribían el mensaje de éxito, el
   * error, limpiaban el buscador y RECARGABAN LA LISTA DEL CLUB ANTERIOR sobre
   * la vista del nuevo.
   *
   * Ahora cada operación recuerda en qué club empezó y, después de cada `await`,
   * comprueba si sigue siendo el vigente. Si no lo es, no toca nada: la operación
   * se completó igualmente en el servidor —eso no se puede deshacer—, pero su
   * resultado no se proyecta sobre una vista a la que no pertenece.
   */
  async function handleAssign(personId: string) {
    const clubDeLaOperacion = clubId;
    // Comprobación SÍNCRONA: el estado deshabilita los controles, pero entre el
    // clic y el repintado cabe otro clic.
    const idDeEstaAccion = reservarAccion(clubDeLaOperacion);
    if (idDeEstaAccion === null) return;

    setError(null);
    setMessage(null);
    try {
      await api.assignDirectly(clubDeLaOperacion, personId);
      if (clubVigenteRef.current !== clubDeLaOperacion) return;

      setMessage("Nadador asignado directamente al club.");
      busqueda.limpiar();
      setPage(1);
      // Recarga la vista VIGENTE, no un `load` de un render anterior.
      recargar();
    } catch (err) {
      if (clubVigenteRef.current !== clubDeLaOperacion) return;
      setError(err instanceof Error ? err.message : "No se pudo asignar el nadador");
    } finally {
      // Solo su propia entrada: si mientras tanto empezó otra, esta no puede
      // desbloquearla, y las de otros clubes ni se tocan.
      liberarAccion(clubDeLaOperacion, idDeEstaAccion);
    }
  }

  async function handleEndMembership(a: ClubSwimmerAssignment) {
    if (!window.confirm(`¿Finalizar la membresía de ${a.person.fullName} en este club?`)) return;
    const clubDeLaOperacion = clubId;
    const idDeEstaAccion = reservarAccion(clubDeLaOperacion);
    if (idDeEstaAccion === null) return;

    setError(null);
    setMessage(null);
    try {
      await api.end(a.id);
      if (clubVigenteRef.current !== clubDeLaOperacion) return;

      setMessage("Membresía finalizada.");
      recargar();
    } catch (err) {
      if (clubVigenteRef.current !== clubDeLaOperacion) return;
      setError(err instanceof Error ? err.message : "No se pudo finalizar la membresía");
    } finally {
      liberarAccion(clubDeLaOperacion, idDeEstaAccion);
    }
  }

  return (
    <div style={{ marginTop: "2rem", paddingTop: "1.5rem", borderTop: "1px solid var(--brand-gray-100)", maxWidth: 560 }}>
      <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Plantel de nadadores</h2>

      <label>Asignar nadador al club (directo, sin necesidad de que haya estado en otro club)</label>
      <input
        placeholder="Buscar nadador por nombre o RUN..."
        value={busqueda.search}
        onChange={(e) => busqueda.setSearch(e.target.value)}
      />
      {busqueda.opciones.length > 0 && (
        <ul style={{ listStyle: "none", margin: "0.3rem 0 0", padding: 0, border: "1px solid var(--brand-gray-300)", borderRadius: 6 }}>
          {busqueda.opciones.map((o) => (
            <li
              key={o.id}
              /*
                Con una asignación en curso, un segundo clic mandaba otra
                petición para la misma persona: la segunda fallaba con un error
                sobre una membresía que ya existía.
              */
              onClick={() => {
                if (!accionEnCurso) void handleAssign(o.id);
              }}
              aria-disabled={accionEnCurso}
              style={{
                padding: "0.5rem 0.75rem",
                cursor: accionEnCurso ? "default" : "pointer",
                fontSize: "0.9rem",
                opacity: accionEnCurso ? 0.6 : 1,
              }}
            >
              {o.fullName} ({o.run})
            </li>
          ))}
        </ul>
      )}
      {busqueda.error && (
        <p className="error-message">
          {busqueda.error}{" "}
          <button
            type="button"
            className="btn-secondary"
            onClick={busqueda.requiereReinicio ? busqueda.reiniciarBusqueda : busqueda.reintentar}
            disabled={busqueda.cargando}
            style={{ padding: "0.15rem 0.5rem", fontSize: "0.8rem" }}
          >
            {/*
              Si el reparto cambió a mitad del recorrido, reintentar la misma
              página seguiría mezclando dos estados distintos: lo que toca es
              rehacer la búsqueda desde la primera página.
            */}
            {busqueda.cargando ? "Cargando…" : busqueda.requiereReinicio ? "Reiniciar búsqueda" : "Reintentar"}
          </button>
        </p>
      )}
      {busqueda.total > 0 && !busqueda.error && (
        <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", marginTop: "0.3rem" }}>
          Se muestran {busqueda.opciones.length} de {busqueda.total} coincidencias.{" "}
          {busqueda.hayMas && (
            <button
              type="button"
              className="btn-secondary"
              onClick={busqueda.cargarMas}
              disabled={busqueda.cargando}
              style={{ padding: "0.15rem 0.5rem", fontSize: "0.8rem" }}
            >
              {busqueda.cargando ? "Cargando…" : "Cargar más resultados"}
            </button>
          )}
        </p>
      )}

      {error && (
        <p className="error-message">
          {error}{" "}
          {/*
            Reintento REAL. Antes la única forma de recuperarse de un error de
            carga era cambiar de club y volver, que no es una instrucción que
            nadie pueda adivinar.
          */}
          <button
            type="button"
            className="btn-secondary"
            onClick={recargar}
            disabled={cargando}
            style={{ padding: "0.15rem 0.5rem", fontSize: "0.8rem" }}
          >
            {cargando ? "Reintentando…" : "Reintentar"}
          </button>
        </p>
      )}
      {cargando && (
        <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }} role="status">
          Cargando plantel…
        </p>
      )}
      {message && (
        <p style={{ fontSize: "0.85rem", background: "var(--brand-bg)", padding: "0.6rem", borderRadius: 6, marginTop: "0.5rem" }}>{message}</p>
      )}

      <table className="data-table" style={{ marginTop: "1rem" }}>
        <thead>
          <tr>
            <SortableTh label="Nadador" sortKey="person" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
            <SortableTh label="Estado" sortKey="status" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
            <SortableTh label="Desde" sortKey="startDate" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {sortItems(assignments, sortKey, sortDir, (a, key) => {
            switch (key) {
              case "person": return a.person.fullName;
              case "status": return STATUS_LABELS[a.status];
              case "startDate": return a.startDate ? claveOrdenFechaCalendario(a.startDate) : null;
            }
          }).map((a) => (
            <tr key={a.id}>
              <td>{a.person.fullName} ({a.person.run})</td>
              <td>
                <span className={`badge ${STATUS_BADGE[a.status]}`}>{STATUS_LABELS[a.status]}</span>
              </td>
              <td>{a.startDate ? formatearFechaCalendario(a.startDate) : "—"}</td>
              <td>
                <button
                  className="btn-danger"
                  style={{ padding: "0.2rem 0.6rem", fontSize: "0.8rem" }}
                  onClick={() => handleEndMembership(a)}
                  /*
                    Durante una transición las filas visibles pueden ser las del
                    club anterior: finalizar una membresía ahí sería operar sobre
                    el club equivocado.
                  */
                  disabled={cargando || accionEnCurso}
                >
                  Finalizar membresía
                </button>
              </td>
            </tr>
          ))}
          {/*
            "No tiene nadadores" es una AFIRMACIÓN sobre los datos, y solo se
            puede hacer cuando la carga terminó bien. Mientras carga o si falló,
            la tabla también está vacía y decir esto sería mentir: el club puede
            tener cien.
          */}
          {assignments.length === 0 && !cargando && !error && (
            <tr>
              <td colSpan={4} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1rem" }}>
                Este club aún no tiene nadadores asignados.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {total > 0 && (
        <div style={{ marginTop: "0.75rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
            {total} registro(s) — página {page}
          </span>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            {/* Sin esto, pulsar deprisa encadena peticiones cuyas respuestas
                pueden volver desordenadas. */}
            <button className="btn-secondary" disabled={cargando || page <= 1} onClick={() => setPage((p) => p - 1)}>
              Anterior
            </button>
            <button
              className="btn-secondary"
              disabled={cargando || page * pageSize >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              Siguiente
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
