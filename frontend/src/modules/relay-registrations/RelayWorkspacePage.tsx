import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "../../shared/AppShell";
import { useToast } from "../../shared/ToastProvider";
import { useCompetitionsApi, type Competition } from "../competitions/competitionsApi";
import { useClubsApi, type Club } from "../clubs/clubsApi";
import { useRegistrationsApi, type EnabledCompetitionEvent, type EligibleSwimmer } from "../registrations/registrationsApi";
import { useRelayRegistrationsApi, type RelayRegistrationItem } from "./relayRegistrationsApi";
import { formatEventLabel } from "../../shared/eventLabel";
import { formatCalendarDate } from "../../shared/calendarDate";
import { sortBySessionTypeName } from "../../shared/sessionOrder";
import { CircledNumber } from "../../shared/CircledNumber";
import { relayPositionLabels } from "../../shared/relayOrder";
import { computeAgeClientPreview } from "../../shared/ageClientPreview";
import { parseSwimTimeInput, formatSwimTimeReadable } from "../../shared/swimTime";
import { useAuth } from "../auth/AuthContext";
import { useSwimmerAssignmentApi } from "../swimmer-assignment/assignmentApi";
import { traerTodasLasPaginas } from "../../shared/paginacion";
import { PanelDeHistorial } from "../../shared/PanelDeHistorial";
import { COLUMNAS_RELEVOS, cargadorDeRelevos } from "../../shared/filasDeHistorial";

const DRAG_ROSTER = "application/x-roster-swimmer";
const DRAG_SLOT = "application/x-slot-index";

export function RelayWorkspacePage() {
  const { showToast } = useToast();
  const { user, hasRole } = useAuth();
  const competitionsApi = useCompetitionsApi();
  const clubsApi = useClubsApi();
  const assignmentApi = useSwimmerAssignmentApi();
  const enabledEventsApi = useRegistrationsApi();
  const api = useRelayRegistrationsApi();

  // Un nadador "puro" solo puede VISUALIZAR los relevos en los que ya
  // está inscrito — nunca armar ni editar equipos (el backend ya lo
  // rechaza). El panel se muestra igual que para los demás roles, pero
  // sin las interacciones de armado y con el club como solo informativo.
  const isPureSwimmer = user?.ownerType === "person" && !hasRole("admin") && !user?.clubId;
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
   * UNA FOTOGRAFÍA COHERENTE, NO TRES LISTAS SUELTAS. Aquí importa todavía más
   * que en el panel individual: con las pruebas y los nadadores ya pintados pero
   * los equipos confirmados en vuelo, el armador dejaba montar un relevo sobre
   * una prueba que **ya tenía equipo** —el backend lo rechaza por unicidad, pero
   * el usuario llega hasta el final para descubrirlo—.
   *
   * Las tres fuentes se piden juntas y se publican a la vez, solo si las tres
   * salieron bien y la generación sigue vigente.
   */
  interface DatosDeLaVista {
    events: EnabledCompetitionEvent[];
    swimmers: EligibleSwimmer[];
    teams: RelayRegistrationItem[];
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

  const cargaDeEstaVista = carga?.clave === claveDeLaVista ? carga : null;
  const datos = cargaDeEstaVista?.datos ?? null;

  const events = useMemo(() => datos?.events ?? [], [datos]);
  const swimmers = useMemo(() => datos?.swimmers ?? [], [datos]);
  const teams = useMemo(() => datos?.teams ?? [], [datos]);

  const cargandoLaVista = cargaDeEstaVista === null || cargaDeEstaVista.fase === "cargando";
  /** Mientras la fotografía no esté completa, no se arma ni se cancela nada. */
  const soloLectura = cargandoLaVista || cargaDeEstaVista?.fase === "error";

  const [activeEventId, setActiveEventId] = useState("");
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null); // null = armando equipo nuevo
  const [slots, setSlots] = useState<string[]>(["", "", "", ""]); // 4 personId ordenados
  const [timeInput, setTimeInput] = useState("");
  const [search, setSearch] = useState("");

  const [draggingRosterId, setDraggingRosterId] = useState<string | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
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
   * UN CONTADOR DE CARGAS **POR VISTA**, no uno global. Con un contador único,
   * guardar o cancelar un equipo en A, cambiar a B y que la operación terminara
   * después disparaba una recarga **de A** que se convertía en la generación más
   * reciente y descartaba las peticiones de B en vuelo: B se quedaba sin pruebas,
   * sin nadadores y sin equipos.
   */
  const cargasPorVista = useRef<Record<string, number>>({});

  /**
   * EL ERROR TAMBIÉN ES DE UNA VISTA. Los de INICIALIZACIÓN son globales; los de
   * CARGA viven **dentro** de la fotografía, así que una carga posterior correcta
   * de la misma vista los borra al publicarse.
   */
  const [errorGlobal, setErrorGlobal] = useState<string | null>(null);
  const error = errorGlobal ?? (cargaDeEstaVista?.fase === "error" ? cargaDeEstaVista.mensaje : null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Atajos de teclado: "/" enfoca la búsqueda, Escape cancela la edición actual.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isTyping = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if (e.key === "/" && !isTyping) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "Escape") {
        resetBuilder();
        (document.activeElement as HTMLElement | null)?.blur();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Se muestran TODAS las competencias (no solo las abiertas) — permite
    // revisar o corregir equipos de competencias ya cerradas.
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
              setErrorGlobal("No tiene un club asignado.");
            }
          })
          .catch((err) => setErrorGlobal(err instanceof Error ? err.message : "No se pudo determinar su club"));
      }
      return;
    }

    if (isClubScoped) {
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
   * @param claveDeLaOperacion la vista desde la que se pide la recarga. Si para
   *   cuando se llama ya no es la vigente, esta llamada **no hace nada**.
   */
  function loadWorkspace(claveDeLaOperacion: string = `${competitionId}|${clubId}`) {
    if (!competitionId || !clubId) return;
    if (claveDeLaOperacion !== claveVigenteRef.current) return;

    const clave = claveDeLaOperacion;
    const miCarga = (cargasPorVista.current[clave] ?? 0) + 1;
    cargasPorVista.current[clave] = miCarga;
    const aplicable = () => cargasPorVista.current[clave] === miCarga && claveVigenteRef.current === clave;

    setCarga((previa) =>
      previa && previa.clave === clave
        ? { ...previa, generacion: miCarga, fase: "cargando", mensaje: null }
        : { clave, generacion: miCarga, fase: "cargando", datos: null, mensaje: null }
    );

    Promise.all([
      enabledEventsApi.listEnabledEvents(competitionId),
      enabledEventsApi.listClubSwimmers(clubId),
      // TODOS los relevos confirmados: el backend pagina de 50 en 50 y esta lista
      // decide qué se muestra como ya inscrito.
      traerTodasLasPaginas((page, pageSize) => api.list({ competitionId, clubId, status: "confirmed", page, pageSize })),
    ])
      .then(([todasLasPruebas, nadadores, equipos]) => {
        if (!aplicable()) return;
        setCarga({
          clave,
          generacion: miCarga,
          fase: "listo",
          datos: {
            events: todasLasPruebas.filter((e) => e.event.testType.swimmersCount > 1),
            swimmers: nadadores,
            teams: equipos,
          },
          mensaje: null,
        });
      })
      .catch((err) => {
        if (!aplicable()) return;
        setCarga({
          clave,
          generacion: miCarga,
          fase: "error",
          datos: null,
          mensaje: err instanceof Error ? err.message : "No se pudo cargar el panel de relevos",
        });
      });
  }

  useEffect(() => {
    setActiveEventId("");
    resetBuilder();
    loadWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitionId, clubId]);

  // -------- Columnas por día, con las pruebas de relevo agrupadas por jornada --------
  const days = useMemo(() => {
    const set = new Set<string>();
    events.forEach((e) => set.add(e.competitionSession.competitionDate.date));
    return Array.from(set).sort();
  }, [events]);

  function eventsForDay(date: string): EnabledCompetitionEvent[] {
    return events.filter((e) => e.competitionSession.competitionDate.date === date);
  }

  const activeEvent = events.find((e) => e.id === activeEventId);

  const filteredSwimmers = swimmers.filter((s) => {
    if (activeEvent && activeEvent.event.gender !== "mixed" && activeEvent.event.gender !== s.gender) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return s.fullName.toLowerCase().includes(q) || s.run.toLowerCase().includes(q);
  });

  function resetBuilder() {
    setEditingTeamId(null);
    setSlots(["", "", "", ""]);
    setTimeInput("");
  }

  function selectEvent(ce: EnabledCompetitionEvent) {
    setActiveEventId((cur) => (cur === ce.id ? "" : ce.id));
    resetBuilder();
  }

  function teamsForEvent(ce: EnabledCompetitionEvent): RelayRegistrationItem[] {
    return teams.filter(
      (t) =>
        t.competitionEvent.event.distance.meters === ce.event.distance.meters &&
        t.competitionEvent.event.stroke.name === ce.event.stroke.name &&
        t.competitionEvent.event.gender === ce.event.gender &&
        t.competitionEvent.competitionSession.sessionType.name === ce.competitionSession.sessionType.name &&
        t.competitionEvent.competitionSession.competitionDate.date === ce.competitionSession.competitionDate.date
    );
  }

  function loadTeamForEdit(t: RelayRegistrationItem) {
    const matched = events.find(
      (e) =>
        e.event.distance.meters === t.competitionEvent.event.distance.meters &&
        e.event.stroke.name === t.competitionEvent.event.stroke.name &&
        e.event.gender === t.competitionEvent.event.gender &&
        e.competitionSession.sessionType.name === t.competitionEvent.competitionSession.sessionType.name &&
        e.competitionSession.competitionDate.date === t.competitionEvent.competitionSession.competitionDate.date
    );
    if (matched) setActiveEventId(matched.id);
    setEditingTeamId(t.id);
    const ordered = t.members.slice().sort((a, b) => a.orderPosition - b.orderPosition).map((m) => m.person.id);
    setSlots([ordered[0] ?? "", ordered[1] ?? "", ordered[2] ?? "", ordered[3] ?? ""]);
    setTimeInput(t.seedTimeCentiseconds ? String(t.seedTimeCentiseconds).padStart(6, "0") : "");
  }

  function placeInSlot(index: number, personId: string) {
    setSlots((prev) => {
      const next = [...prev];
      const existingIndex = next.indexOf(personId);
      if (existingIndex !== -1 && existingIndex !== index) next[existingIndex] = "";
      next[index] = personId;
      return next;
    });
  }

  function swapSlots(a: number, b: number) {
    setSlots((prev) => {
      const next = [...prev];
      [next[a], next[b]] = [next[b], next[a]];
      return next;
    });
  }

  function clearSlot(index: number) {
    setSlots((prev) => {
      const next = [...prev];
      next[index] = "";
      return next;
    });
  }

  const positionLabels = activeEvent ? relayPositionLabels(activeEvent.event.stroke.name) : relayPositionLabels("");
  const filledCount = slots.filter(Boolean).length;

  const selectedCompetition = competitions.find((c) => c.id === competitionId);
  const combinedAgePreview = useMemo(() => {
    if (!activeEvent || !selectedCompetition?.ageCutoffDate || filledCount !== 4) return null;
    const chosen = slots.map((id) => swimmers.find((s) => s.id === id)).filter((s): s is EligibleSwimmer => Boolean(s));
    if (chosen.length !== 4) return null;
    const combinedAge = chosen.reduce((sum, s) => sum + computeAgeClientPreview(s.birthDate, selectedCompetition.ageCutoffDate!), 0);
    const match = activeEvent.enabledCategories.filter((ec) => combinedAge >= ec.category.minAge && combinedAge <= ec.category.maxAge);
    if (match.length === 0) return { combinedAge, error: `Ninguna categoría cubre esta edad combinada (${combinedAge} años).` };
    if (match.length > 1) return { combinedAge, error: `Hay más de una categoría posible para ${combinedAge} años — revise el catálogo.` };
    return { combinedAge, categoryName: match[0]!.category.name };
  }, [activeEvent, selectedCompetition, slots, swimmers, filledCount]);

  async function handleSaveTeam() {
    if (soloLectura) return;
    if (!activeEvent || filledCount !== 4) return;
    // La vista donde empieza esta escritura, conservada para la recarga posterior.
    const claveDeLaOperacion = claveDeLaVista;
    setSaving(true);
    try {
      const parsedTime = timeInput.trim() ? parseSwimTimeInput(timeInput) : { ok: true, centiseconds: undefined };
      if (!parsedTime.ok) {
        showToast(parsedTime.error ?? "Tiempo inválido", "error");
        setSaving(false);
        return;
      }
      if (editingTeamId) {
        await api.update(editingTeamId, { personIds: slots, seedTimeCentiseconds: parsedTime.centiseconds ?? null });
        showToast("Equipo actualizado.", "success");
      } else {
        await api.create({ competitionEventId: activeEvent.id, clubId, personIds: slots, seedTimeCentiseconds: parsedTime.centiseconds });
        showToast("Equipo de relevo inscrito.", "success");
      }
      resetBuilder();
      loadWorkspace(claveDeLaOperacion);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo guardar el equipo", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteTeam(t: RelayRegistrationItem) {
    if (soloLectura) return;
    if (!window.confirm(`¿Cancelar el equipo de relevo de ${t.club.name}?`)) return;
    const claveDeLaOperacion = claveDeLaVista;
    try {
      await api.cancel(t.id);
      showToast("Equipo cancelado.", "info");
      if (editingTeamId === t.id) resetBuilder();
      loadWorkspace(claveDeLaOperacion);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo cancelar", "error");
    }
  }

  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)", marginBottom: "0.75rem" }}>Panel de Relevos</h1>

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
        <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>Elija una competencia y un club para comenzar a armar relevos.</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", fontSize: "0.82rem", background: "var(--brand-bg)", borderRadius: 6, padding: "0.4rem 0.75rem", marginBottom: "0.5rem" }}>
            <span>Nadadores: <strong>{swimmers.length}</strong></span>
            <span>Equipos confirmados: <strong>{teams.length}</strong></span>
            <span>Pruebas de relevo: <strong>{events.length}</strong></span>
            <span title="/ enfoca la búsqueda · Escape cancela la edición actual">
              Atajos: <kbd>/</kbd> buscar, <kbd>Esc</kbd> cancelar.
            </span>
          </div>
          <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginBottom: "0.5rem" }}>
            Cada columna es un día de la competencia, con sus pruebas de relevo agrupadas por jornada. Haga clic en una prueba para armar o editar su
            equipo — arrastre nadadores desde la izquierda hacia los 4 puestos.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: "1rem", alignItems: "start" }}>
            {/* -------- Panel izquierdo: nadadores -------- */}
            <div style={{ border: "1px solid var(--brand-gray-100)", borderRadius: 8, padding: "0.75rem", maxHeight: "78vh", overflowY: "auto" }}>
              <input ref={searchInputRef} placeholder="🔎 Buscar nadador o RUN... (/)" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: "0.5rem" }} />
              {isPureSwimmer && <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)" }}>Solo puede visualizar los relevos en los que participa.</p>}
              {!isPureSwimmer && !activeEventId && <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)" }}>Elija una prueba de relevo a la derecha para empezar a armar el equipo.</p>}
              {filteredSwimmers.map((s) => (
                <div
                  key={s.id}
                  draggable={!isPureSwimmer}
                  onDragStart={(e) => { e.dataTransfer.setData(DRAG_ROSTER, s.id); setDraggingRosterId(s.id); }}
                  onDragEnd={() => setDraggingRosterId(null)}
                  style={{
                    padding: "0.4rem 0.55rem",
                    marginBottom: "0.3rem",
                    borderRadius: 6,
                    border: "1px solid var(--brand-gray-100)",
                    background: slots.includes(s.id) ? "var(--brand-bg)" : draggingRosterId === s.id ? "var(--brand-bg)" : "white",
                    cursor: activeEventId ? "grab" : "not-allowed",
                    fontSize: "0.85rem",
                    opacity: activeEventId ? 1 : 0.5,
                  }}
                >
                  ☰ {s.fullName} {slots.includes(s.id) && "✓"}
                </div>
              ))}
            </div>

            {/* -------- Centro: una columna por día -------- */}
            <div style={{ display: "flex", gap: "0.75rem", overflowX: "auto", maxHeight: "78vh", paddingBottom: "0.5rem" }}>
              {days.length === 0 && (
                <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>Sin pruebas de relevo configuradas en esta competencia.</p>
              )}
              {days.map((date) => {
                const dayEvents = eventsForDay(date);
                return (
                  <div key={date} style={{ minWidth: 260, flex: "0 0 260px" }}>
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
                            const isActive = activeEventId === ce.id;
                            const teamsHere = teamsForEvent(ce);
                            return (
                              <div
                                key={ce.id}
                                onClick={() => { if (!isPureSwimmer) selectEvent(ce); }}
                                style={{
                                  border: `2px solid ${isActive ? "var(--brand-blue-dark)" : "var(--brand-gray-100)"}`,
                                  borderRadius: 8,
                                  padding: "0.55rem",
                                  cursor: isPureSwimmer ? "default" : "pointer",
                                  background: isActive ? "var(--brand-bg)" : "white",
                                  marginBottom: "0.5rem",
                                }}
                              >
                                <strong style={{ fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.35rem" }}>
                                  <CircledNumber n={ce.displayOrder} />
                                  {formatEventLabel({ distanceMeters: ce.event.distance.meters, strokeName: ce.event.stroke.name, gender: ce.event.gender, isRelay: true })}
                                </strong>
                                <p style={{ fontSize: "0.7rem", color: "var(--brand-gray-600)", margin: "0.15rem 0" }}>{teamsHere.length} equipo(s)</p>

                                {/* Constructor de equipo — visible al seleccionar esta prueba. Va primero: es la acción en curso. */}
                                {isActive && (
                                  <div style={{ marginTop: "0.4rem", borderTop: "1px solid var(--brand-gray-100)", paddingTop: "0.4rem" }} onClick={(e) => e.stopPropagation()}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                      <strong style={{ fontSize: "0.75rem" }}>{editingTeamId ? "Editando equipo" : "Nuevo equipo"}</strong>
                                      {editingTeamId && <button className="btn-secondary" style={{ padding: "0.05rem 0.3rem", fontSize: "0.65rem" }} onClick={resetBuilder}>Nuevo</button>}
                                    </div>
                                    {editingTeamId && (
                                      <p style={{ fontSize: "0.68rem", color: "var(--brand-gray-600)", margin: "0.15rem 0 0.3rem" }}>
                                        Arrastre un nadador ya puesto (☰) hacia otro puesto para reordenar el equipo.
                                      </p>
                                    )}
                                    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.3rem" }}>
                                      {positionLabels.map((label, i) => {
                                        const swimmer = swimmers.find((s) => s.id === slots[i]);
                                        return (
                                          <div
                                            key={i}
                                            draggable={Boolean(swimmer)}
                                            onDragStart={(e) => { if (swimmer) e.dataTransfer.setData(DRAG_SLOT, String(i)); }}
                                            onDragOver={(e) => { e.preventDefault(); setDragOverSlot(i); }}
                                            onDragLeave={() => setDragOverSlot((cur) => (cur === i ? null : cur))}
                                            onDrop={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              setDragOverSlot(null);
                                              const fromRoster = e.dataTransfer.getData(DRAG_ROSTER);
                                              const fromSlot = e.dataTransfer.getData(DRAG_SLOT);
                                              if (fromRoster) placeInSlot(i, fromRoster);
                                              else if (fromSlot !== "") swapSlots(Number(fromSlot), i);
                                            }}
                                            style={{
                                              border: `2px dashed ${dragOverSlot === i ? "var(--brand-blue-dark)" : "var(--brand-gray-100)"}`,
                                              borderRadius: 6,
                                              padding: "0.3rem 0.4rem",
                                              background: swimmer ? "var(--brand-bg)" : "white",
                                              display: "flex",
                                              justifyContent: "space-between",
                                              alignItems: "center",
                                              cursor: swimmer ? "grab" : "default",
                                            }}
                                          >
                                            <span style={{ fontSize: "0.68rem", color: "var(--brand-gray-600)", minWidth: 70 }}>{label}</span>
                                            {swimmer ? (
                                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flex: 1, fontSize: "0.75rem" }}>
                                                <span>☰ {swimmer.fullName}</span>
                                                <button className="btn-danger" style={{ padding: "0.05rem 0.3rem", fontSize: "0.68rem" }} onClick={(e) => { e.stopPropagation(); clearSlot(i); }}>×</button>
                                              </div>
                                            ) : (
                                              <span style={{ fontSize: "0.7rem", color: "var(--brand-gray-600)" }}>Arrastre aquí</span>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>

                                    <div style={{ marginTop: "0.4rem" }}>
                                      <label style={{ fontSize: "0.7rem" }}>Tiempo estimado (opcional) — mmsscc</label>
                                      <input value={timeInput} onChange={(e) => setTimeInput(e.target.value)} placeholder="012567" maxLength={6} style={{ maxWidth: 100, fontSize: "0.78rem" }} />
                                    </div>

                                    <div style={{ fontSize: "0.72rem", marginTop: "0.3rem" }}>
                                      {combinedAgePreview === null && filledCount === 4 && <span style={{ color: "var(--brand-gray-600)" }}>Calculando categoría...</span>}
                                      {combinedAgePreview && "categoryName" in combinedAgePreview && (
                                        <span style={{ fontWeight: 600, color: "var(--brand-navy)" }}>
                                          {combinedAgePreview.categoryName} <span style={{ fontWeight: 400, color: "var(--brand-gray-600)" }}>(edad: {combinedAgePreview.combinedAge})</span>
                                        </span>
                                      )}
                                      {combinedAgePreview && "error" in combinedAgePreview && <span style={{ color: "var(--state-danger)" }}>{combinedAgePreview.error}</span>}
                                    </div>

                                    <button
                                      className="btn-primary"
                                      style={{ marginTop: "0.4rem", padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
                                      onClick={handleSaveTeam}
                                      disabled={soloLectura || filledCount !== 4 || saving || !combinedAgePreview || "error" in (combinedAgePreview ?? {})}
                                    >
                                      {saving ? "Guardando..." : editingTeamId ? "Guardar cambios" : "Confirmar equipo"}
                                    </button>
                                  </div>
                                )}

                                {/* Equipos ya confirmados de esta prueba (los demás, además del que se está editando). */}
                                {teamsHere.length > 0 && (
                                  <div style={{ marginTop: "0.3rem", borderTop: "1px solid var(--brand-gray-100)", paddingTop: "0.3rem" }} onClick={(e) => e.stopPropagation()}>
                                    {teamsHere.map((t) => (
                                      <div key={t.id} style={{ fontSize: "0.7rem", marginBottom: "0.3rem" }}>
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                          <span style={{ color: "var(--brand-gray-600)" }}>{t.category.name} — {formatSwimTimeReadable(t.seedTimeCentiseconds)}</span>
                                          {!isPureSwimmer && (
                                            <span style={{ display: "flex", gap: "0.2rem" }}>
                                              <button className="btn-secondary" style={{ padding: "0.05rem 0.3rem", fontSize: "0.65rem" }} onClick={() => loadTeamForEdit(t)} disabled={soloLectura}>Editar</button>
                                              <button className="btn-danger" style={{ padding: "0.05rem 0.3rem", fontSize: "0.65rem" }} onClick={() => handleDeleteTeam(t)} disabled={soloLectura}>×</button>
                                            </span>
                                          )}
                                        </div>
                                        <div style={{ color: "var(--brand-gray-600)" }}>
                                          {t.members.slice().sort((a, b) => a.orderPosition - b.orderPosition).map((m) => m.person.fullName).join(" → ")}
                                        </div>
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
      {/* Historial de relevos, incluidos los CANCELADOS: ver la nota del panel. */}
      {competitionId && (
        <PanelDeHistorial
          nombrePlural="equipos de relevo"
          dependencias={[competitionId, clubId]}
          encabezados={COLUMNAS_RELEVOS}
          cargar={cargadorDeRelevos(api.list, competitionId, clubId)}
        />
      )}
    </AppShell>
  );
}
