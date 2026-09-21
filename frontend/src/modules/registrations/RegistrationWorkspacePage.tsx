import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "../../shared/AppShell";
import { useToast } from "../../shared/ToastProvider";
import { useCompetitionsApi, type Competition } from "../competitions/competitionsApi";
import { useClubsApi, type Club } from "../clubs/clubsApi";
import {
  useRegistrationsApi,
  type EnabledCompetitionEvent,
  type ClubEligibilityEntry,
  type RegistrationItem,
} from "./registrationsApi";
import { formatEventLabel } from "../../shared/eventLabel";
import { sortBySessionTypeName } from "../../shared/sessionOrder";
import { CircledNumber } from "../../shared/CircledNumber";
import { formatCalendarDate } from "../../shared/calendarDate";
import { parseSwimTimeInput, formatSwimTimeReadable } from "../../shared/swimTime";
import { useAuth } from "../auth/AuthContext";
import { useSwimmerAssignmentApi } from "../swimmer-assignment/assignmentApi";
import { traerTodasLasPaginas } from "../../shared/paginacion";
import { PanelDeHistorial } from "../../shared/PanelDeHistorial";
import { COLUMNAS_INSCRIPCIONES, cargadorDeInscripciones } from "../../shared/filasDeHistorial";

const DRAG_ROSTER = "application/x-roster-swimmer";

/**
 * Una acción de deshacer concreta. Es un objeto **por inscripción**, y la
 * identidad se comprueba por referencia: cada aviso captura el suyo y lo vuelve a
 * presentar al pulsarlo, de modo que un aviso viejo no puede accionar lo nuevo.
 */
interface AccionDeshacer {
  clave: string;
  registrationId: string;
  enCurso: boolean;
}

export function RegistrationWorkspacePage() {
  const { showToast } = useToast();
  const { user, hasRole } = useAuth();
  const competitionsApi = useCompetitionsApi();
  const clubsApi = useClubsApi();
  const assignmentApi = useSwimmerAssignmentApi();
  const api = useRegistrationsApi();

  // Un nadador "puro" (sin rol delegado/entrenador) ve este mismo panel,
  // pero acotado a sí mismo: el club se muestra solo informativo (no se
  // puede elegir otro), y el plantel/las pruebas ya vienen filtrados a su
  // propia información desde el servidor.
  const isPureSwimmer = user?.ownerType === "person" && !hasRole("admin") && !user?.clubId;

  // Una cuenta de club, o un delegado/entrenador: solo pueden operar sobre
  // su propio club (el servidor lo carga en la sesión — ver `user.clubId`).
  // El club se muestra igual que para el nadador: solo informativo.
  const isClubScoped = !isPureSwimmer && Boolean(user?.clubId);

  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [ownClubName, setOwnClubName] = useState<string | null>(null);
  const [competitionId, setCompetitionId] = useState("");
  const [clubId, setClubId] = useState("");

  /**
   * QUÉ SE ESTÁ MIRANDO: competencia y club.
   */
  const claveDeLaVista = `${competitionId}|${clubId}`;

  /**
   * UNA FOTOGRAFÍA COHERENTE, NO TRES LISTAS SUELTAS.
   *
   * Las tres fuentes —pruebas habilitadas, elegibilidad del plantel e
   * inscripciones confirmadas— se publicaban por separado, cada una en cuanto
   * llegaba. Eso dejaba la pantalla operable con una fotografía **parcial**: con
   * las pruebas y el plantel ya pintados y las inscripciones todavía en vuelo, el
   * botón «Inscribir» estaba disponible y la lista de «ya inscrito» estaba
   * incompleta. Inscribir ahí duplica una inscripción que existe pero que la
   * pantalla aún no conoce.
   *
   * Ahora las tres se piden juntas y se publican **a la vez**, y solo si las tres
   * salieron bien y la generación sigue vigente. Si falla cualquiera, no se
   * publica nada de esa generación.
   */
  interface DatosDeLaVista {
    events: EnabledCompetitionEvent[];
    eligibility: ClubEligibilityEntry[];
    registrations: RegistrationItem[];
  }
  interface CargaDeLaVista {
    clave: string;
    generacion: number;
    fase: "cargando" | "listo" | "error";
    /** Durante una RECARGA se conservan los datos anteriores, en solo lectura. */
    datos: DatosDeLaVista | null;
    mensaje: string | null;
  }
  const [carga, setCarga] = useState<CargaDeLaVista | null>(null);

  /** La carga que corresponde a lo que se está mirando; si no, nada. */
  const cargaDeEstaVista = carga?.clave === claveDeLaVista ? carga : null;
  const datos = cargaDeEstaVista?.datos ?? null;

  const events = useMemo(() => datos?.events ?? [], [datos]);
  const eligibility = useMemo(() => datos?.eligibility ?? [], [datos]);
  const registrations = useMemo(() => datos?.registrations ?? [], [datos]);

  /** Hay una carga en vuelo para esta vista (primera o recarga). */
  const cargandoLaVista = cargaDeEstaVista === null || cargaDeEstaVista.fase === "cargando";

  /**
   * SOLO LECTURA mientras la fotografía no esté completa. Es lo que impide operar
   * sobre datos a medias: durante una recarga se siguen viendo los datos
   * anteriores —para no vaciar la pantalla en cada guardado— pero sin poder
   * tocarlos, y ante un error no se opera en absoluto.
   */
  const soloLectura = cargandoLaVista || cargaDeEstaVista?.fase === "error";

  const [search, setSearch] = useState("");

  // Nadador "seleccionado" (uno solo, por clic o arrastre): al elegirlo, se
  // habilita el campo de tiempo en cada prueba donde es elegible — el
  // tiempo es obligatorio antes de inscribir, así que ya no se inscribe
  // solo con soltar.
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [pendingTimes, setPendingTimes] = useState<Record<string, string>>({}); // competitionEventId -> texto del tiempo
  const [draggingPersonId, setDraggingPersonId] = useState<string | null>(null);
  const [dragOverEventId, setDragOverEventId] = useState<string | null>(null);
  /**
   * REGISTRO DE ESCRITURAS EN CURSO, POR IDENTIDAD DE LA OPERACIÓN.
   *
   * Antes había un solo `busyEventId`, y una sola identidad no puede representar
   * dos operaciones. La secuencia que lo rompía:
   *
   *   1. empieza una inscripción en la prueba A;
   *   2. empieza otra en la prueba B, y `busyEventId` pasa a ser B;
   *   3. termina la de A, y su `finally` hace `setBusyEventId(null)`;
   *   4. **B queda habilitada con su petición todavía en vuelo**.
   *
   * Y `handleRemove`/`handleSaveEditedTime` no tenían ninguna autoridad mientras
   * esperaban: `soloLectura` solo se enciende cuando la escritura termina y
   * dispara la recarga, así que una segunda pulsación mandaba otra petición.
   *
   * El registro va por identidad y con TOKEN propio:
   *
   *   - crear:   `crear:<personId>:<competitionEventId>`
   *   - la fila: `registro:<registrationId>`
   *
   * **Una sola identidad por fila, no una por verbo.** Con `editar:` y `cancelar:`
   * separados, dos operaciones incompatibles podían solaparse sobre la misma
   * inscripción: guardar una edición de `r1`, salir del editor con la «✕» local
   * —que solo cierra el formulario—, y pulsar la «×» de la fila, que consultaba
   * otra clave y mandaba `cancel(r1)` con el `update(r1)` todavía en vuelo. Y al
   * revés: una cancelación pendiente no impedía abrir el editor y guardar. El
   * recurso en disputa es la inscripción, así que la identidad es la inscripción.
   *
   * Operaciones distintas pueden correr en paralelo —inscribir en dos pruebas a
   * la vez es legítimo—, pero **ninguna puede desbloquear a otra**: el `finally`
   * solo retira su token si sigue siendo el vigente para esa identidad.
   *
   * La `ref` es la autoridad: permite la comprobación **síncrona** del manejador,
   * antes de que React haya vuelto a pintar, que es lo que de verdad impide la
   * doble escritura. El estado espejo existe para que los botones se enteren.
   */
  const [operaciones, setOperaciones] = useState<Record<string, number>>({});
  const operacionesRef = useRef<Record<string, number>>({});
  const proximoToken = useRef(0);

  /** ¿Hay una escritura en curso con esta identidad? Para pintar los controles. */
  const operacionEnCurso = (id: string) => operaciones[id] !== undefined;

  /**
   * Reserva la operación si esa identidad está libre. Devuelve su token, o `null`
   * si ya había una en curso — comprobación síncrona, sin esperar a un render.
   */
  function reservarOperacion(id: string): number | null {
    if (operacionesRef.current[id] !== undefined) return null;
    const token = ++proximoToken.current;
    operacionesRef.current = { ...operacionesRef.current, [id]: token };
    setOperaciones(operacionesRef.current);
    return token;
  }

  /** Libera la operación SOLO si el token sigue siendo el vigente. */
  function liberarOperacion(id: string, token: number): void {
    if (operacionesRef.current[id] !== token) return;
    const resto = { ...operacionesRef.current };
    delete resto[id];
    operacionesRef.current = resto;
    setOperaciones(resto);
  }

  // Edición del tiempo de una inscripción ya confirmada, directo en la prueba.
  const [editingRegistrationId, setEditingRegistrationId] = useState<string | null>(null);
  const [editTime, setEditTime] = useState("");

  /**
   * QUÉ VISTA ES LA VIGENTE, para que una operación que empezó en otra pueda
   * darse cuenta. Se registra en un efecto y se consulta en el momento de actuar,
   * no se deduce de lo que un cierre capturó.
   */
  const claveVigenteRef = useRef(claveDeLaVista);
  /**
   * `useLayoutEffect`, NO `useEffect`: un efecto pasivo se programa para DESPUÉS
   * del commit, y entre el commit de la vista nueva y su ejecución el bucle de
   * eventos puede procesar microtareas —la resolución de una mutación que empezó
   * en la vista anterior, por ejemplo—. En esa ventana la referencia todavía
   * diría "lo de antes" y esa mutación dispararía una recarga que ya no
   * corresponde. `useLayoutEffect` corre dentro del commit, antes de ceder el
   * control.
   */
  useLayoutEffect(() => {
    claveVigenteRef.current = claveDeLaVista;
  }, [claveDeLaVista]);

  /**
   * UN CONTADOR DE CARGAS **POR VISTA**, no uno global.
   *
   * Con un contador único pasaba esto: se inscribe en A, se cambia a B, y cuando
   * la inscripción termina su manejador —que conserva el `loadWorkspace` de A—
   * dispara una recarga de A. Esa recarga vieja se convertía en la generación más
   * reciente y **descartaba las peticiones de B que aún viajaban**: B se quedaba
   * vacía, sin pruebas, sin plantel y sin nada que explicara por qué.
   *
   * Con un contador por vista, una carga solo puede invalidar a otra **de su
   * misma vista**. Y con la comprobación de arriba, una carga de una vista que ya
   * no se está mirando ni siquiera empieza.
   */
  const cargasPorVista = useRef<Record<string, number>>({});

  /**
   * EL ERROR TAMBIÉN ES DE UNA VISTA. Los de INICIALIZACIÓN —competencias, club
   * propio— no dependen de la vista y son globales. Los de CARGA viven **dentro**
   * de la fotografía, así que una carga posterior correcta de la misma vista los
   * borra sin más: publicar una fotografía nueva sustituye a la anterior, error
   * incluido. Antes quedaban en un estado aparte que nadie limpiaba, y volver a
   * una vista que había fallado la mostraba en rojo aunque cargara bien.
   */
  const [errorGlobal, setErrorGlobal] = useState<string | null>(null);
  const error = errorGlobal ?? (cargaDeEstaVista?.fase === "error" ? cargaDeEstaVista.mensaje : null);


  // Atajos de teclado.
  const searchInputRef = useRef<HTMLInputElement>(null);
  /**
   * DESHACER LA ÚLTIMA INSCRIPCIÓN, CON IDENTIDAD DE VISTA.
   *
   * Antes esto era una función suelta en una `ref`. Al crear en la competencia A,
   * cambiar a la B y pulsar Ctrl+Z —o el «Deshacer» del aviso, que sigue en
   * pantalla—, se cancelaba la inscripción de A mientras se estaba mirando la B:
   * una escritura invisible sobre datos que el usuario ya no tiene delante. Y
   * como no había ningún cerrojo, dos activaciones seguidas mandaban dos
   * cancelaciones del mismo registro.
   *
   * SEMÁNTICA ELEGIDA: **deshacer solo puede ejecutarse cuando su vista es la
   * vigente**. Abandonar la vista **no elimina la acción**: un intento desde otra
   * competencia informa del problema sin consumirla, y volver a la vista permite
   * ejecutarla. Se eligió esto y no «invalidar al salir» porque regresar a la
   * competencia A y deshacer sigue siendo una operación legítima y comprensible.
   * Una acción solo desaparece al consumirse o al ser sustituida por otra
   * creación de esa misma vista.
   *
   * EXCEPCIÓN EXPLÍCITA AL MODO SOLO LECTURA: deshacer **sí** puede ejecutarse
   * durante una recarga. Actúa sobre el identificador exacto que acaba de
   * crearse, no sobre el snapshot, así que no depende de que la fotografía esté
   * completa; y `enCurso` lo serializa para que no salgan dos cancelaciones.
   */
  /**
   * UNA ACCIÓN VIGENTE **POR VISTA**, no una sola global.
   *
   * Con una referencia única, cada creación terminada la sobrescribía sin mirar de
   * dónde venía. Con `create(A)` todavía en vuelo se cambia a B, se inscribe allí,
   * y al terminar A **pisaba la acción de B**: el aviso de B quedaba obsoleto,
   * Ctrl+Z recogía la de A —que no corresponde a la vista, así que no cancelaba
   * nada— y la inscripción recién hecha en B se quedaba sin poder deshacerse. Los
   * controles de carga impedían que A repintara B, pero no protegían esto.
   *
   * Con el mapa, cada creación toca únicamente la entrada de **su** vista, y
   * volver a una competencia recupera su deshacer pendiente.
   */
  const deshacerPorVista = useRef<Map<string, AccionDeshacer>>(new Map());

  useEffect(() => {
    // Se muestran TODAS las competencias (no solo las abiertas) — permite
    // revisar o corregir inscripciones de competencias ya cerradas.
    traerTodasLasPaginas((page, pageSize) => competitionsApi.list({ page, pageSize }))
      .then(setCompetitions)
      .catch((err) => setErrorGlobal(err instanceof Error ? err.message : "No se pudieron cargar las competencias"));

    if (isPureSwimmer) {
      if (user?.personId) {
        assignmentApi
          .getCurrentClub(user.personId)
          .then((c) => {
            if (c) {
              setClubId(c.club.id);
              setOwnClubName(c.club.name);
            } else {
              setOwnClubName("Sin club asignado");
              setErrorGlobal("No tiene un club asignado — no puede inscribirse hasta que un administrador lo asigne a un club.");
            }
          })
          .catch((err) => setErrorGlobal(err instanceof Error ? err.message : "No se pudo determinar su club"));
      }
      return;
    }

    if (isClubScoped) {
      // Cuenta de club, o delegado/entrenador: solo pueden operar sobre
      // su propio club — se carga directo, sin desplegable ni lista de
      // otros clubes (el servidor tampoco permitiría actuar sobre otro).
      setClubId(user!.clubId!);
      clubsApi
        .get(user!.clubId!)
        .then((c) => setOwnClubName(c.name))
        .catch((err) => setErrorGlobal(err instanceof Error ? err.message : "No se pudo cargar el club"));
      return;
    }

    traerTodasLasPaginas((page, pageSize) => clubsApi.list({ status: "active", page, pageSize }))
      .then(setClubs)
      .catch((err) => setErrorGlobal(err instanceof Error ? err.message : "No se pudieron cargar los clubes"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * @param claveDeLaOperacion la vista desde la que se pide la recarga. Los
   *   manejadores de escritura la conservan explícitamente desde que empiezan; si
   *   para cuando terminan ya no es la vigente, esta llamada **no hace nada**: ni
   *   pide, ni incrementa contadores, ni invalida la carga de nadie.
   */
  function loadWorkspace(claveDeLaOperacion: string = `${competitionId}|${clubId}`) {
    if (!competitionId || !clubId) return;
    if (claveDeLaOperacion !== claveVigenteRef.current) return;

    const clave = claveDeLaOperacion;
    const miCarga = (cargasPorVista.current[clave] ?? 0) + 1;
    cargasPorVista.current[clave] = miCarga;
    /**
     * Publica solo si (a) sigue siendo la carga más reciente DE SU VISTA y (b) esa
     * vista sigue siendo la que se está mirando.
     */
    const aplicable = () => cargasPorVista.current[clave] === miCarga && claveVigenteRef.current === clave;

    // Entra en «cargando» conservando lo que hubiera de esta misma vista: durante
    // una recarga la pantalla no se vacía, pero queda en solo lectura.
    setCarga((previa) =>
      previa && previa.clave === clave
        ? { ...previa, generacion: miCarga, fase: "cargando", mensaje: null }
        : { clave, generacion: miCarga, fase: "cargando", datos: null, mensaje: null }
    );

    Promise.all([
      api.listEnabledEvents(competitionId),
      api.listClubEligibilityMatrix(competitionId, clubId),
      // TODAS las confirmadas: el backend pagina de 50 en 50, y esta lista decide
      // qué aparece como ya inscrito. Con 51 inscripciones, la 51 se "perdía" y la
      // pantalla la ofrecía como disponible.
      traerTodasLasPaginas((page, pageSize) => api.list({ competitionId, clubId, status: "confirmed", page, pageSize })),
    ])
      .then(([todasLasPruebas, elegibilidad, inscripciones]) => {
        if (!aplicable()) return;
        setCarga({
          clave,
          generacion: miCarga,
          fase: "listo",
          datos: {
            events: todasLasPruebas.filter((e) => e.event.testType.swimmersCount === 1),
            eligibility: elegibilidad,
            registrations: inscripciones,
          },
          mensaje: null,
        });
        // Para un nadador puro, la lista ya viene acotada a sí mismo — se
        // autoselecciona para no obligarlo a hacer clic sobre su propio nombre.
        if (isPureSwimmer && elegibilidad.length === 1) setSelectedPersonId(elegibilidad[0]!.personId);
      })
      .catch((err) => {
        if (!aplicable()) return;
        // Falló alguna de las tres: no se publica nada de esta generación. Los
        // datos anteriores se descartan, porque operar sobre ellos con una parte
        // del conjunto sin confirmar es justo lo que hay que evitar.
        setCarga({
          clave,
          generacion: miCarga,
          fase: "error",
          datos: null,
          mensaje: err instanceof Error ? err.message : "No se pudo cargar el panel de inscripción",
        });
      });
  }

  useEffect(() => {
    setSelectedPersonId(null);
    setPendingTimes({});
    loadWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitionId, clubId]);

  // -------- Columnas por día: cada día de la competencia, con sus pruebas en el orden ya definido en la ficha de la competencia --------
  const days = useMemo(() => {
    const set = new Set<string>();
    events.forEach((e) => set.add(e.competitionSession.competitionDate.date));
    return Array.from(set).sort();
  }, [events]);

  function eventsForDay(date: string): EnabledCompetitionEvent[] {
    return events
      .filter((e) => e.competitionSession.competitionDate.date === date)
      .slice()
      .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  }

  const filteredSwimmers = eligibility.filter((s) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return s.fullName.toLowerCase().includes(q) || s.run.toLowerCase().includes(q);
  });

  const selectedSwimmer = selectedPersonId ? eligibility.find((s) => s.personId === selectedPersonId) : undefined;

  function matchesEvent(r: RegistrationItem, ce: EnabledCompetitionEvent) {
    return (
      r.competitionEvent.event.distance.meters === ce.event.distance.meters &&
      r.competitionEvent.event.stroke.name === ce.event.stroke.name &&
      r.competitionEvent.event.gender === ce.event.gender &&
      r.competitionEvent.competitionSession.sessionType.name === ce.competitionSession.sessionType.name &&
      r.competitionEvent.competitionSession.competitionDate.date === ce.competitionSession.competitionDate.date
    );
  }

  function eventRegistrations(ce: EnabledCompetitionEvent) {
    return registrations.filter((r) => matchesEvent(r, ce));
  }

  function selectSwimmer(personId: string) {
    setSelectedPersonId((cur) => (cur === personId ? null : personId));
    setPendingTimes({});
  }

  // Arrastrar un nadador sobre una prueba: lo selecciona y prepara el
  // campo de tiempo de ESA prueba para que el usuario lo complete — ya no
  // inscribe de inmediato, porque el tiempo ahora es obligatorio.
  function handleDropSwimmer(personId: string, competitionEventId: string) {
    setDragOverEventId(null);
    const swimmer = eligibility.find((s) => s.personId === personId);
    if (!swimmer) return;

    if (swimmer.registeredEventIds.includes(competitionEventId)) {
      showToast(`${swimmer.fullName} ya está inscrito en esta prueba.`, "info");
      return;
    }
    if (!swimmer.eligibleEvents.some((e) => e.competitionEventId === competitionEventId)) {
      showToast(`${swimmer.fullName} no es elegible para esta prueba (revise género, edad/categoría, o si ya está inscrito).`, "error");
      return;
    }
    setSelectedPersonId(personId);
    setTimeout(() => document.getElementById(`time-input-${competitionEventId}`)?.focus(), 50);
  }

  async function handleConfirmTime(competitionEventId: string) {
    if (soloLectura) return;
    if (!selectedPersonId || !selectedSwimmer) return;
    // La vista donde empieza esta escritura. Se conserva para que la recarga
    // posterior sepa si todavía corresponde.
    const claveDeLaOperacion = claveDeLaVista;
    const raw = (pendingTimes[competitionEventId] ?? "").trim();
    if (!raw) {
      showToast("Debe ingresar el tiempo estimado antes de inscribir.", "error");
      return;
    }
    const parsed = parseSwimTimeInput(raw);
    if (!parsed.ok) {
      showToast(parsed.error ?? "Tiempo inválido", "error");
      return;
    }

    // Identidad de ESTA creación. Dos inscripciones de personas distintas, o de
    // la misma persona en pruebas distintas, son operaciones distintas.
    const idOperacion = `crear:${selectedPersonId}:${competitionEventId}`;
    const token = reservarOperacion(idOperacion);
    if (token === null) return;

    try {
      const created = await api.create({ competitionEventId, clubId, personId: selectedPersonId, seedTimeCentiseconds: parsed.centiseconds });
      // Un objeto NUEVO por inscripción: es lo que permite distinguir el aviso de
      // esta de los que puedan seguir en pantalla de otras anteriores.
      const accion: AccionDeshacer = { clave: claveDeLaOperacion, registrationId: created.id, enCurso: false };
      // Solo la entrada de SU vista: una creación atrasada de otra competencia no
      // puede desplazar la acción de la que se está mirando.
      deshacerPorVista.current.set(claveDeLaOperacion, accion);
      showToast(`✓ ${selectedSwimmer.fullName} inscrito(a). (Ctrl+Z para deshacer)`, "success", {
        label: "Deshacer",
        // El aviso captura SU acción y la vuelve a presentar al pulsarse.
        onClick: () => void deshacerUltimaInscripcion(accion),
      });
      setPendingTimes((prev) => {
        const next = { ...prev };
        delete next[competitionEventId];
        return next;
      });
      loadWorkspace(claveDeLaOperacion);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo inscribir", "error");
    } finally {
      liberarOperacion(idOperacion, token);
    }
  }

  /**
   * Ejecuta UNA acción de deshacer concreta, la que pide quien pulsa.
   *
   * Recibe la acción en vez de leerla de la ref, y esa es la diferencia. Antes se
   * leía `deshacerRef.current` en el momento de la pulsación, y los avisos con
   * acción duran seis segundos: con dos inscripciones seguidas coexisten dos
   * avisos en pantalla, y pulsar el de la primera **cancelaba la segunda**.
   *
   * Tres comprobaciones, en este orden:
   *
   *   1. Que la acción pedida siga siendo la vigente **de su propia vista**
   *      —identidad por referencia contra la entrada del mapa—. Un aviso obsoleto
   *      no acciona nada.
   *   2. Que su vista siga siendo la que se mira. Se consulta
   *      `claveVigenteRef.current`, **no** el `soloLectura` ni la clave del
   *      cierre: ambos serían del render en que se mostró el aviso.
   *   3. Que no esté ya en curso: el cerrojo es **por acción**, así que dos
   *      pulsaciones del mismo aviso mandan una sola cancelación.
   *
   * Y al terminar —bien o mal— la entrada del mapa solo se toca **si todavía
   * contiene esta misma acción**. Sin eso pasaba lo siguiente: deshacer `r1` queda
   * en vuelo, se crea `r2` —que instala su acción—, y al resolverse `r1` el
   * borrado se llevaba la acción de `r2`, que se quedaba sin poder deshacerse.
   */
  async function deshacerUltimaInscripcion(accionEsperada: AccionDeshacer) {
    if (deshacerPorVista.current.get(accionEsperada.clave) !== accionEsperada) {
      showToast("Ese deshacer ya no está disponible.", "info");
      return;
    }

    if (accionEsperada.clave !== claveVigenteRef.current) {
      /**
       * Se está mirando otra competencia. Se avisa y **no se borra nada**: la
       * acción sigue siendo válida para su propia vista, y volver allí debe
       * permitir deshacerla. Una acción solo desaparece al consumirse o al ser
       * sustituida por otra creación de esa misma vista.
       */
      showToast("El deshacer ya no corresponde a lo que está viendo.", "info");
      return;
    }
    if (accionEsperada.enCurso) return; // segunda pulsación mientras la primera viaja

    // Y comparte autoridad con el resto de la fila: editarla o cancelarla es
    // operar sobre la misma inscripción, se pida desde donde se pida.
    const idOperacion = `registro:${accionEsperada.registrationId}`;
    const token = reservarOperacion(idOperacion);
    if (token === null) return;
    accionEsperada.enCurso = true;

    try {
      await api.cancel(accionEsperada.registrationId);
      if (deshacerPorVista.current.get(accionEsperada.clave) === accionEsperada) {
        deshacerPorVista.current.delete(accionEsperada.clave);
      }
      showToast("Inscripción deshecha.", "info");
      loadWorkspace(accionEsperada.clave);
    } catch (err) {
      accionEsperada.enCurso = false;
      showToast(err instanceof Error ? err.message : "No se pudo deshacer", "error");
    } finally {
      liberarOperacion(idOperacion, token);
    }
  }

  /**
   * ATAJOS DE TECLADO: "/" enfoca la búsqueda, Escape cancela la selección actual,
   * Ctrl+Z (o Cmd+Z) deshace la última inscripción creada.
   *
   * VA AQUÍ, después de `deshacerUltimaInscripcion`, y **sin array de
   * dependencias**: se vuelve a registrar en cada render. Antes se registraba una
   * sola vez y su cierre era el del PRIMER render —cuando todavía no hay
   * competencia elegida y la recarga posterior no haría nada—. Se probó a
   * resolverlo con una ref a "la versión actual", pero eso obliga a referenciar la
   * función antes de declararla, que es justo lo que la regla de hooks prohíbe.
   * Reinstalar un escuchador por render es barato y deja el cierre siempre al día.
   */
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isTyping = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      if (e.key === "/" && !isTyping) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "Escape") {
        setSelectedPersonId(null);
        setPendingTimes({});
        setEditingRegistrationId(null);
        (document.activeElement as HTMLElement | null)?.blur();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        // El teclado actúa sobre la acción de la vista que se está mirando, y la
        // pasa explícita: nunca sobre la de otra competencia.
        const vigente = deshacerPorVista.current.get(claveVigenteRef.current);
        if (vigente) {
          e.preventDefault();
          void deshacerUltimaInscripcion(vigente);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  async function handleRemove(registration: RegistrationItem) {
    if (soloLectura) return;
    const idOperacion = `registro:${registration.id}`;
    const token = reservarOperacion(idOperacion);
    if (token === null) return; // ya hay otra operación sobre esta fila en vuelo

    const claveDeLaOperacion = claveDeLaVista;
    try {
      await api.cancel(registration.id);
      /**
       * La inscripción ya está cancelada, así que el «Deshacer» que la ofrecía
       * queda CONSUMIDO: sin esto, Ctrl+Z mandaba una segunda cancelación de algo
       * ya cancelado. Se compara el identificador para no llevarse por delante una
       * acción posterior de OTRA inscripción, y solo se hace si la cancelación
       * salió bien: si falla, el deshacer sigue disponible.
       */
      const pendienteDeEstaVista = deshacerPorVista.current.get(claveDeLaOperacion);
      if (pendienteDeEstaVista?.registrationId === registration.id) {
        deshacerPorVista.current.delete(claveDeLaOperacion);
      }
      showToast(`Inscripción de ${registration.person.fullName} eliminada.`, "info");
      loadWorkspace(claveDeLaOperacion);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo eliminar la inscripción", "error");
    } finally {
      liberarOperacion(idOperacion, token);
    }
  }

  function startEditRegistration(r: RegistrationItem) {
    setEditingRegistrationId(r.id);
    setEditTime(r.seedTimeCentiseconds !== null ? String(r.seedTimeCentiseconds).padStart(6, "0") : "");
  }

  async function handleSaveEditedTime(id: string) {
    if (soloLectura) return;

    // El tiempo se valida ANTES de reservar: un formato inválido no es una
    // operación en curso, y bloquear la identidad por ello dejaría el control
    // muerto hasta recargar.
    const raw = editTime.trim();
    let centesimas: number | null = null;
    if (raw) {
      const parsed = parseSwimTimeInput(raw);
      if (!parsed.ok) {
        showToast(parsed.error ?? "Tiempo inválido", "error");
        return;
      }
      centesimas = parsed.centiseconds!;
    }

    const idOperacion = `registro:${id}`;
    const token = reservarOperacion(idOperacion);
    if (token === null) return; // ya hay otra operación sobre esta fila en vuelo

    const claveDeLaOperacion = claveDeLaVista;
    try {
      await api.update(id, { seedTimeCentiseconds: centesimas });
      setEditingRegistrationId(null);
      if (centesimas !== null) showToast("Inscripción actualizada.", "success");
      loadWorkspace(claveDeLaOperacion);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo guardar", "error");
    } finally {
      liberarOperacion(idOperacion, token);
    }
  }

  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)", marginBottom: "0.75rem" }}>Panel de Inscripción</h1>

      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
        <div>
          <label style={{ fontSize: "0.8rem" }}>Competencia</label>
          <select value={competitionId} onChange={(e) => setCompetitionId(e.target.value)} style={{ minWidth: 260 }}>
            <option value="">Seleccionar...</option>
            {competitions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: "0.8rem" }}>Club</label>
          {isPureSwimmer || isClubScoped ? (
            <p style={{ fontSize: "0.9rem", padding: "0.45rem 0" }}>{ownClubName ?? "Cargando..."}</p>
          ) : (
            <select value={clubId} onChange={(e) => setClubId(e.target.value)} style={{ minWidth: 200 }}>
              <option value="">Seleccionar...</option>
              {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
      </div>

      {error && <p className="error-message">{error}</p>}

      {!competitionId || !clubId ? (
        <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>Elija una competencia y un club para comenzar a inscribir.</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", fontSize: "0.82rem", background: "var(--brand-bg)", borderRadius: 6, padding: "0.4rem 0.75rem", marginBottom: "0.5rem" }}>
            <span>Nadadores: <strong>{eligibility.length}</strong></span>
            <span>Inscripciones: <strong>{registrations.length}</strong></span>
            <span>Pruebas: <strong>{events.length}</strong></span>
          </div>
          <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginBottom: "0.5rem" }}>
            Cada columna es un día de la competencia, con sus pruebas numeradas (el orden se define en la ficha de la competencia). Haga clic en un
            nadador (o arrástrelo sobre una prueba) para seleccionarlo y habilitar el campo de tiempo. Las inscripciones ya confirmadas se pueden
            editar directamente en la prueba.
            {" "}
            <span title="/ enfoca la búsqueda · Escape cancela la selección · Ctrl+Z deshace la última inscripción">
              Atajos: <kbd>/</kbd> buscar, <kbd>Esc</kbd> cancelar, <kbd>Ctrl+Z</kbd> deshacer.
            </span>
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: "1rem", alignItems: "start" }}>
            {/* -------- Panel izquierdo: nadadores -------- */}
            <div style={{ border: "1px solid var(--brand-gray-100)", borderRadius: 8, padding: "0.75rem", maxHeight: "78vh", overflowY: "auto" }}>
              <input ref={searchInputRef} placeholder="🔎 Buscar nadador o RUN... (/)" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: "0.5rem" }} />
              {filteredSwimmers.length === 0 && (
                <p style={{ fontSize: "0.82rem", color: "var(--brand-gray-600)" }}>Sin nadadores para este filtro.</p>
              )}
              {filteredSwimmers.map((s) => (
                <div
                  key={s.personId}
                  draggable
                  onClick={() => selectSwimmer(s.personId)}
                  onDragStart={(e) => { e.dataTransfer.setData(DRAG_ROSTER, s.personId); setDraggingPersonId(s.personId); }}
                  onDragEnd={() => setDraggingPersonId(null)}
                  style={{
                    padding: "0.45rem 0.6rem",
                    marginBottom: "0.35rem",
                    borderRadius: 6,
                    border: selectedPersonId === s.personId ? "2px solid var(--brand-blue-dark)" : "1px solid var(--brand-gray-100)",
                    background: selectedPersonId === s.personId || draggingPersonId === s.personId ? "var(--brand-bg)" : "white",
                    cursor: "grab",
                    fontSize: "0.85rem",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                  title={`${s.eligibleEvents.length} prueba(s) disponibles — clic para seleccionar`}
                >
                  <span>☰ {s.fullName}</span>
                  <span style={{ color: "var(--brand-gray-600)", fontSize: "0.78rem" }}>{s.eligibleEvents.length}</span>
                </div>
              ))}
            </div>

            {/* -------- Centro: una columna por día -------- */}
            <div style={{ display: "flex", gap: "0.75rem", overflowX: "auto", maxHeight: "78vh", paddingBottom: "0.5rem" }}>
              {days.length === 0 && (
                <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>Sin pruebas individuales configuradas en esta competencia.</p>
              )}
              {days.map((date) => {
                const dayEvents = eventsForDay(date);
                return (
                  <div key={date} style={{ minWidth: 250, flex: "0 0 250px" }}>
                    <h3 style={{ fontSize: "0.9rem", color: "var(--brand-navy)", position: "sticky", top: 0, background: "white", padding: "0.2rem 0" }}>
                      {formatCalendarDate(date, { weekday: "long", day: "2-digit", month: "2-digit" })}
                    </h3>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                      {sortBySessionTypeName(Array.from(new Set(dayEvents.map((ce) => ce.competitionSession.sessionType.name))), (n) => n).map((sessionName) => (
                      <div key={sessionName}>
                        <h4 style={{ fontSize: "0.72rem", color: "var(--brand-gray-600)", textTransform: "uppercase", letterSpacing: "0.03em", margin: "0.3rem 0 0.25rem" }}>
                          {sessionName}
                        </h4>
                        {dayEvents.filter((ce) => ce.competitionSession.sessionType.name === sessionName).map((ce) => {
                        const isEligibleTarget = selectedSwimmer?.eligibleEvents.some((e) => e.competitionEventId === ce.id);
                        const isRegisteredTarget = selectedSwimmer?.registeredEventIds.includes(ce.id);
                        const showTimeInput = Boolean(selectedSwimmer) && isEligibleTarget && !isRegisteredTarget;
                        const confirmed = eventRegistrations(ce);

                        let borderColor = "var(--brand-gray-100)";
                        if (selectedSwimmer) borderColor = isRegisteredTarget ? "var(--state-warning)" : isEligibleTarget ? "var(--state-success)" : "var(--brand-gray-100)";
                        if (dragOverEventId === ce.id) borderColor = "var(--brand-blue-dark)";

                        return (
                          <div
                            key={ce.id}
                            onDragOver={(e) => { e.preventDefault(); setDragOverEventId(ce.id); }}
                            onDragLeave={() => setDragOverEventId((cur) => (cur === ce.id ? null : cur))}
                            onDrop={(e) => {
                              e.preventDefault();
                              const rosterPersonId = e.dataTransfer.getData(DRAG_ROSTER);
                              if (rosterPersonId) handleDropSwimmer(rosterPersonId, ce.id);
                              setDraggingPersonId(null);
                            }}
                            style={{
                              border: `2px solid ${borderColor}`,
                              borderRadius: 8,
                              padding: "0.55rem",
                              background: operacionEnCurso(`crear:${selectedPersonId}:${ce.id}`) ? "var(--brand-bg)" : "white",
                              transition: "border-color 0.1s",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                              <strong style={{ fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.35rem" }}>
                                <CircledNumber n={ce.displayOrder} />
                                {formatEventLabel({ distanceMeters: ce.event.distance.meters, strokeName: ce.event.stroke.name, gender: ce.event.gender, isRelay: false })}
                              </strong>
                            </div>

                            {showTimeInput && (
                              <div style={{ display: "flex", gap: "0.3rem", marginTop: "0.3rem" }} onClick={(e) => e.stopPropagation()}>
                                <input
                                  id={`time-input-${ce.id}`}
                                  value={pendingTimes[ce.id] ?? ""}
                                  onChange={(e) => setPendingTimes((prev) => ({ ...prev, [ce.id]: e.target.value }))}
                                  onKeyDown={(e) => { if (e.key === "Enter") handleConfirmTime(ce.id); }}
                                  placeholder="mmsscc"
                                  maxLength={6}
                                  style={{ maxWidth: 80, fontSize: "0.78rem" }}
                                />
                                <button className="btn-primary" style={{ padding: "0.2rem 0.4rem", fontSize: "0.75rem" }} onClick={() => handleConfirmTime(ce.id)} disabled={soloLectura || operacionEnCurso(`crear:${selectedPersonId}:${ce.id}`)}>
                                  Inscribir
                                </button>
                              </div>
                            )}
                            {selectedSwimmer && isRegisteredTarget && (
                              <p style={{ fontSize: "0.7rem", color: "var(--state-warning)", margin: "0.25rem 0 0" }}>Ya inscrito(a)</p>
                            )}

                            {/* Inscripciones ya confirmadas de esta prueba, editables aquí mismo. */}
                            {confirmed.length > 0 && (
                              <div style={{ marginTop: "0.4rem", borderTop: "1px solid var(--brand-gray-100)", paddingTop: "0.3rem" }} onClick={(e) => e.stopPropagation()}>
                                {confirmed.map((r) => (
                                  <div key={r.id} style={{ fontSize: "0.72rem", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.15rem" }}>
                                    <span>{r.person.fullName}</span>
                                    {editingRegistrationId === r.id ? (
                                      <span style={{ display: "flex", gap: "0.2rem" }}>
                                        <input value={editTime} onChange={(e) => setEditTime(e.target.value)} placeholder="mmsscc" maxLength={6} style={{ maxWidth: 65, fontSize: "0.72rem" }} />
                                        <button className="btn-primary" style={{ padding: "0.05rem 0.3rem", fontSize: "0.68rem" }} onClick={() => handleSaveEditedTime(r.id)} disabled={soloLectura || operacionEnCurso(`registro:${r.id}`)}>✓</button>
                                        <button className="btn-secondary" style={{ padding: "0.05rem 0.3rem", fontSize: "0.68rem" }} onClick={() => setEditingRegistrationId(null)}>✕</button>
                                      </span>
                                    ) : (
                                      <span style={{ display: "flex", gap: "0.3rem", alignItems: "center", color: "var(--brand-gray-600)" }}>
                                        {formatSwimTimeReadable(r.seedTimeCentiseconds)}
                                        <button className="btn-secondary" style={{ padding: "0.05rem 0.3rem", fontSize: "0.65rem" }} onClick={() => startEditRegistration(r)} disabled={soloLectura || operacionEnCurso(`registro:${r.id}`)}>Editar</button>
                                        <button className="btn-danger" style={{ padding: "0.05rem 0.3rem", fontSize: "0.65rem" }} onClick={() => handleRemove(r)} disabled={soloLectura || operacionEnCurso(`registro:${r.id}`)}>×</button>
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
      {/*
        HISTORIAL, incluidas las CANCELADAS (hallazgo 31). Esta capacidad solo
        existía en `RegistrationsListPage`, que no tenía ruta: estaba en el
        código y era inalcanzable. Va en un panel aparte porque la lista de
        arriba no es una tabla de consulta —decide qué plazas están ocupadas— y
        mezclar canceladas ahí bloquearía inscripciones legítimas.
      */}
      {competitionId && (
        <PanelDeHistorial
          nombrePlural="inscripciones"
          dependencias={[competitionId, clubId]}
          encabezados={COLUMNAS_INSCRIPCIONES}
          cargar={cargadorDeInscripciones(api.list, competitionId, clubId)}
        />
      )}
    </AppShell>
  );
}
