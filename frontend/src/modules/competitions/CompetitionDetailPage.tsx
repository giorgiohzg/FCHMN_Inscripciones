import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useCompetitionsApi, type Competition, type CompetitionDate, type CompetitionEventItem, type SessionType } from "./competitionsApi";
import { useCatalogsApi, type EventItem, type Category, type CategoryGroup } from "../catalogs/catalogsApi";
import { formatEventLabel } from "../../shared/eventLabel";
import { formatCalendarDate } from "../../shared/calendarDate";
import { sortBySessionTypeName } from "../../shared/sessionOrder";
import { CircledNumber } from "../../shared/CircledNumber";
import { usePoolsApi, type Pool } from "../pools/poolsApi";

const COURSE_LENGTH_LABELS: Record<"short_25m" | "long_50m", string> = { short_25m: "25 metros", long_50m: "50 metros" };

const STATUS_LABELS: Record<string, string> = {
  draft: "Borrador", scheduled: "Inscripciones programadas", open: "Inscripciones abiertas",
  closed: "Inscripciones cerradas", in_progress: "En ejecución", finished: "Finalizada", cancelled: "Cancelada",
};

const ACTIONS: { action: "schedule" | "cancel" | "closeRegistrations" | "start" | "finish"; label: string; danger?: boolean }[] = [
  { action: "schedule", label: "Programar" },
  { action: "closeRegistrations", label: "Cerrar inscripciones" },
  { action: "start", label: "Iniciar ejecución" },
  { action: "finish", label: "Finalizar" },
  { action: "cancel", label: "Cancelar", danger: true },
];

export function CompetitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const api = useCompetitionsApi();
  const catalogsApi = useCatalogsApi();
  const poolsApi = usePoolsApi();
  const [pools, setPools] = useState<Pool[]>([]);

  const [competition, setCompetition] = useState<Competition | null>(null);
  const [sessionTypes, setSessionTypes] = useState<SessionType[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>([]);
  const [competitionEvents, setCompetitionEvents] = useState<CompetitionEventItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newDate, setNewDate] = useState("");

  // ---------- Edición de datos generales de la competencia ----------
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    description: "",
    registrationStartAt: "",
    registrationEndAt: "",
    ageCutoffDate: "",
    maxIndividualEventsPerSwimmer: "",
    maxRelayEventsPerSwimmerPerSession: "1",
    poolId: "",
  });

  const load = useCallback(async () => {
    if (!id) return;
    const [c, st, ev, cat, grp, ce, pl] = await Promise.all([
      api.get(id),
      api.listSessionTypes(),
      catalogsApi.listEvents(),
      catalogsApi.listCategories(),
      catalogsApi.listCategoryGroups(),
      api.listCompetitionEvents(id),
      poolsApi.list(),
    ]);
    setCompetition(c);
    setEditForm({
      name: c.name,
      description: c.description ?? "",
      registrationStartAt: c.registrationStartAt.slice(0, 16),
      registrationEndAt: c.registrationEndAt.slice(0, 16),
      ageCutoffDate: c.ageCutoffDate ? c.ageCutoffDate.slice(0, 10) : "",
      maxIndividualEventsPerSwimmer: c.maxIndividualEventsPerSwimmer !== null ? String(c.maxIndividualEventsPerSwimmer) : "",
      maxRelayEventsPerSwimmerPerSession: String(c.maxRelayEventsPerSwimmerPerSession ?? 1),
      poolId: c.poolId ?? "",
    });
    setSessionTypes(st);
    setEvents(ev.items);
    setCategories(cat.items);
    setCategoryGroups(grp);
    setCompetitionEvents(ce);
    setPools(pl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAction(action: typeof ACTIONS[number]["action"]) {
    setError(null);
    try {
      await api.transition(id!, action);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo ejecutar la acción");
    }
  }

  async function handleAddDate() {
    if (!newDate) return;
    setError(null);
    try {
      await api.addDate(id!, newDate);
      setNewDate("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo agregar la fecha");
    }
  }

  async function handleDeleteDate(dateId: string, dateLabel: string) {
    if (!window.confirm(`¿Eliminar la fecha ${dateLabel}? Esto también elimina sus jornadas y cualquier prueba de la competencia asignada a ellas.`)) return;
    setError(null);
    try {
      await api.removeDate(dateId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar la fecha");
    }
  }

  async function handleSaveDetails() {
    setError(null);
    try {
      await api.update(id!, {
        name: editForm.name,
        description: editForm.description,
        registrationStartAt: editForm.registrationStartAt,
        registrationEndAt: editForm.registrationEndAt,
        ageCutoffDate: editForm.ageCutoffDate || undefined,
        maxIndividualEventsPerSwimmer: editForm.maxIndividualEventsPerSwimmer ? Number(editForm.maxIndividualEventsPerSwimmer) : undefined,
        maxRelayEventsPerSwimmerPerSession:
          editForm.maxRelayEventsPerSwimmerPerSession !== "" ? Number(editForm.maxRelayEventsPerSwimmerPerSession) : undefined,
        poolId: editForm.poolId || null,
      });
      setEditing(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la competencia");
    }
  }

  async function handleDeleteCompetition() {
    if (
      !window.confirm(
        "¿Eliminar esta competencia por completo? Esta acción NO se puede deshacer y también elimina TODAS sus inscripciones ya confirmadas (individuales y de relevo)."
      )
    )
      return;
    setError(null);
    try {
      await api.remove(id!);
      navigate("/competencias");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar la competencia");
    }
  }

  async function handleAddSession(dateId: string, sessionTypeId: string) {
    setError(null);
    try {
      await api.addSession(dateId, sessionTypeId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo agregar la jornada");
    }
  }

  async function handleSetLimit(sessionId: string, maxIndividual: string, maxRelay: string) {
    setError(null);
    try {
      await api.setSessionLimit(sessionId, {
        maxIndividualEvents: maxIndividual === "" ? null : Number(maxIndividual),
        maxRelayEvents: maxRelay === "" ? null : Number(maxRelay),
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el límite");
    }
  }

  if (!competition) return <AppShell><p>Cargando...</p></AppShell>;

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ color: "var(--brand-navy)", marginBottom: "0.2rem" }}>{competition.name}</h1>
          <span className="badge badge-active">{STATUS_LABELS[competition.status]}</span>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {ACTIONS.map((a) => (
            <button key={a.action} className={a.danger ? "btn-danger" : "btn-secondary"} onClick={() => handleAction(a.action)}>
              {a.label}
            </button>
          ))}
          <button className="btn-secondary" onClick={() => setEditing((v) => !v)}>{editing ? "Cancelar edición" : "Editar"}</button>
          <button className="btn-danger" onClick={handleDeleteCompetition}>Eliminar</button>
        </div>
      </div>

      {error && <p className="error-message">{error}</p>}

      {!editing ? (
        <>
          <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem", marginTop: "0.5rem" }}>
            Inscripciones: {new Date(competition.registrationStartAt).toLocaleString("es-CL")} — {new Date(competition.registrationEndAt).toLocaleString("es-CL")}
          </p>
          <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
            Fecha de corte de edad:{" "}
            {competition.ageCutoffDate ? (
              formatCalendarDate(competition.ageCutoffDate)
            ) : (
              <span style={{ color: "var(--state-warning)" }}>Sin definir — los nadadores no aparecerán como elegibles hasta configurarla.</span>
            )}
          </p>
          <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
            Máximo de pruebas individuales por nadador:{" "}
            {competition.maxIndividualEventsPerSwimmer !== null ? competition.maxIndividualEventsPerSwimmer : "Sin límite"}
          </p>
          <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
            Máximo de relevos por nadador y jornada:{" "}
            {competition.maxRelayEventsPerSwimmerPerSession === 0 ? "No admite relevos" : competition.maxRelayEventsPerSwimmerPerSession}
          </p>
          <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
            Piscina:{" "}
            {competition.pool ? (
              <>{competition.pool.name} ({COURSE_LENGTH_LABELS[competition.pool.courseLength]})</>
            ) : (
              "Sin especificar"
            )}
          </p>
        </>
      ) : (
        <div style={{ maxWidth: 640, background: "var(--brand-bg)", padding: "1rem", borderRadius: 8, marginTop: "0.75rem" }}>
          <label>Nombre</label>
          <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
          <label>Descripción</label>
          <input value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label>Inicio de inscripción</label>
              <input
                type="datetime-local"
                value={editForm.registrationStartAt}
                onChange={(e) => setEditForm({ ...editForm, registrationStartAt: e.target.value })}
              />
            </div>
            <div>
              <label>Fin de inscripción</label>
              <input
                type="datetime-local"
                value={editForm.registrationEndAt}
                onChange={(e) => setEditForm({ ...editForm, registrationEndAt: e.target.value })}
              />
            </div>
          </div>
          <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "-0.4rem" }}>
            Estas fechas se pueden modificar en cualquier momento. Si el cambio hace que la fecha de cierre quede en el futuro (o en el pasado), el
            estado de la competencia se actualiza automáticamente para reflejarlo.
          </p>
          <label>Fecha de corte para el cálculo de edad de categoría</label>
          <input type="date" value={editForm.ageCutoffDate} onChange={(e) => setEditForm({ ...editForm, ageCutoffDate: e.target.value })} />
          <label>Máximo de pruebas individuales por nadador (excluye relevos)</label>
          <input
            type="number"
            min={1}
            value={editForm.maxIndividualEventsPerSwimmer}
            onChange={(e) => setEditForm({ ...editForm, maxIndividualEventsPerSwimmer: e.target.value })}
          />
          <label>Máximo de relevos por nadador en cada jornada (0 = sin relevos)</label>
          <input
            type="number"
            min={0}
            value={editForm.maxRelayEventsPerSwimmerPerSession}
            onChange={(e) => setEditForm({ ...editForm, maxRelayEventsPerSwimmerPerSession: e.target.value })}
          />
          <label>Piscina (opcional)</label>
          <select value={editForm.poolId} onChange={(e) => setEditForm({ ...editForm, poolId: e.target.value })}>
            <option value="">Sin especificar</option>
            {pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="btn-primary" style={{ marginTop: "0.75rem" }} onClick={handleSaveDetails}>Guardar cambios</button>
        </div>
      )}

      {/* ---------- Fechas y jornadas ---------- */}
      <h2 style={{ fontSize: "1.1rem", color: "var(--brand-navy)", marginTop: "2rem" }}>Fechas y jornadas</h2>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} style={{ maxWidth: 200 }} />
        <button className="btn-primary" onClick={handleAddDate}>Agregar fecha</button>
      </div>

      {competition.dates.length === 0 && (
        <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>Todavía no hay fechas agregadas a esta competencia.</p>
      )}

      {competition.dates.map((d) => (
        <div key={d.id} style={{ border: "1px solid var(--brand-gray-100)", borderRadius: 8, padding: "1rem", marginBottom: "0.75rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>{formatCalendarDate(d.date, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</strong>
            <button
              className="btn-danger"
              onClick={() => handleDeleteDate(d.id, formatCalendarDate(d.date))}
            >
              Eliminar fecha
            </button>
          </div>

          {d.sessions.length === 0 && (
            <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", marginTop: "0.4rem" }}>Esta fecha todavía no tiene jornadas.</p>
          )}

          <div style={{ marginTop: "0.5rem" }}>
            {sortBySessionTypeName(d.sessions, (s) => s.sessionType?.name ?? "").map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.4rem 0", borderTop: "1px solid var(--brand-gray-100)" }}>
                <span style={{ minWidth: 90 }}>{s.sessionType?.name ?? "(jornada)"}</span>
                <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>Máx. individuales:</span>
                <input
                  type="number"
                  min={0}
                  defaultValue={s.limit?.maxIndividualEvents ?? ""}
                  placeholder="Sin límite"
                  style={{ width: 100 }}
                  onBlur={(e) => handleSetLimit(s.id, e.target.value, String(s.limit?.maxRelayEvents ?? ""))}
                />
                <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>Máx. relevos:</span>
                <input
                  type="number"
                  min={0}
                  defaultValue={s.limit?.maxRelayEvents ?? ""}
                  placeholder="Sin límite"
                  style={{ width: 100 }}
                  onBlur={(e) => handleSetLimit(s.id, String(s.limit?.maxIndividualEvents ?? ""), e.target.value)}
                />
              </div>
            ))}
          </div>

          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
            {sessionTypes.filter((st) => !d.sessions.some((s) => s.sessionTypeId === st.id)).length === 0 ? (
              <span style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)" }}>
                Ya se agregaron todos los tipos de jornada disponibles a esta fecha.
              </span>
            ) : (
              <>
                <select id={`session-type-${d.id}`} style={{ maxWidth: 200 }}>
                  {sessionTypes
                    .filter((st) => !d.sessions.some((s) => s.sessionTypeId === st.id))
                    .map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                </select>
                <button
                  className="btn-secondary"
                  onClick={() => {
                    const select = document.getElementById(`session-type-${d.id}`) as HTMLSelectElement;
                    if (select?.value) handleAddSession(d.id, select.value);
                  }}
                >
                  + Agregar jornada
                </button>
              </>
            )}
          </div>
        </div>
      ))}

      {/* ---------- Pruebas asignadas ---------- */}
      <h2 style={{ fontSize: "1.1rem", color: "var(--brand-navy)", marginTop: "2rem" }}>Pruebas de la competencia</h2>
      <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)" }}>
        Arrastre una prueba del catálogo (izquierda) hacia la columna de la fecha donde quiera agregarla. Arrastre una prueba ya asignada sobre otra
        (o sobre el área de una jornada) para reordenarla o moverla — funciona dentro de la misma jornada, entre jornadas, y entre fechas distintas.
      </p>
      <CompetitionEventsBoard
        competitionId={id!}
        events={events}
        categories={categories}
        categoryGroups={categoryGroups}
        dates={competition.dates}
        competitionEvents={competitionEvents}
        onChanged={load}
        onError={(m) => setError(m)}
      />
    </AppShell>
  );
}

/** Categorías de un tipo de prueba dado que pertenecen a alguno de los grupos indicados. */
function resolveCategoryIdsFromGroups(groupIds: string[], categories: Category[], testTypeId: string): string[] {
  return categories.filter((c) => c.testTypeId === testTypeId && c.categoryGroupId && groupIds.includes(c.categoryGroupId)).map((c) => c.id);
}

/**
 * Para modo edición: un grupo se muestra "seleccionado" si TODAS sus
 * categorías (del tipo de prueba correspondiente) ya están habilitadas
 * para esta prueba de competencia. Es una simplificación deliberada — no
 * distingue selección parcial, ya que la interfaz trabaja por grupo
 * completo, no por categoría individual.
 */
function computeSelectedGroupsFromCategoryIds(enabledCategoryIds: string[], categories: Category[], categoryGroups: CategoryGroup[], testTypeId: string): string[] {
  const enabledSet = new Set(enabledCategoryIds);
  return categoryGroups
    .filter((g) => {
      const groupCategoriesOfType = categories.filter((c) => c.testTypeId === testTypeId && c.categoryGroupId === g.id);
      return groupCategoriesOfType.length > 0 && groupCategoriesOfType.every((c) => enabledSet.has(c.id));
    })
    .map((g) => g.id);
}

function GroupCheckboxes({
  testTypeId,
  categories,
  categoryGroups,
  selectedGroupIds,
  onChange,
}: {
  testTypeId: string;
  categories: Category[];
  categoryGroups: CategoryGroup[];
  selectedGroupIds: string[];
  onChange: (groupIds: string[]) => void;
}) {
  const groupsWithCategoriesOfType = categoryGroups.filter((g) => categories.some((c) => c.testTypeId === testTypeId && c.categoryGroupId === g.id));

  if (groupsWithCategoriesOfType.length === 0) {
    return (
      <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
        No hay grupos de categorías con categorías de este tipo de prueba todavía. Cree uno en Catálogo → Grupos de categorías, y asigne categorías a él.
      </span>
    );
  }

  return (
    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
      {groupsWithCategoriesOfType.map((g) => (
        <label key={g.id} style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontWeight: 400 }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={selectedGroupIds.includes(g.id)}
            onChange={(e) => onChange(e.target.checked ? [...selectedGroupIds, g.id] : selectedGroupIds.filter((id) => id !== g.id))}
          />
          {g.name}
        </label>
      ))}
    </div>
  );
}

function CompetitionEventsBoard({
  competitionId,
  events,
  categories,
  categoryGroups,
  dates,
  competitionEvents,
  onChanged,
  onError,
}: {
  competitionId: string;
  events: EventItem[];
  categories: Category[];
  categoryGroups: CategoryGroup[];
  dates: Competition["dates"];
  competitionEvents: CompetitionEventItem[];
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const api = useCompetitionsApi();
  const [search, setSearch] = useState("");

  const [draggingCatalogId, setDraggingCatalogId] = useState<string | null>(null);
  const [draggingAssignedId, setDraggingAssignedId] = useState<string | null>(null);
  const [dragOverDateId, setDragOverDateId] = useState<string | null>(null);
  const [dragOverAssignedId, setDragOverAssignedId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  // Al soltar una prueba del catálogo sobre una fecha, se abre este
  // mini-formulario pendiente (jornada + grupos de categorías) antes de
  // confirmar — son datos que el backend exige y el arrastre por sí solo
  // no alcanza a capturar.
  const [pendingAdd, setPendingAdd] = useState<{ eventId: string; dateId: string } | null>(null);
  const [pendingSessionId, setPendingSessionId] = useState("");
  const [pendingGroupIds, setPendingGroupIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  // Edición de una prueba ya asignada (jornada/estado/grupos), inline en su tarjeta.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSessionId, setEditSessionId] = useState("");
  const [editStatus, setEditStatus] = useState<"enabled" | "disabled">("enabled");
  const [editGroupIds, setEditGroupIds] = useState<string[]>([]);

  const DRAG_CATALOG = "application/x-catalog-event";
  const DRAG_ASSIGNED = "application/x-assigned-event";

  const sortedDates = dates.slice().sort((a, b) => a.date.localeCompare(b.date));

  // Una prueba no se puede repetir en la competencia — una vez asignada
  // (en cualquier fecha), desaparece del catálogo de la izquierda.
  const assignedEventIds = new Set(competitionEvents.map((ce) => ce.event.id));

  const filteredCatalog = events.filter((e) => {
    if (assignedEventIds.has(e.id)) return false;
    if (!search.trim()) return true;
    return formatEventLabel({ distanceMeters: e.distance.meters, strokeName: e.stroke.name, gender: e.gender, isRelay: e.testType.swimmersCount > 1 })
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  });

  function assignedForDate(date: CompetitionDate): CompetitionEventItem[] {
    return competitionEvents
      .filter((ce) => ce.competitionSession.competitionDate.date === date.date)
      .slice()
      .sort((a, b) => (a.displayOrder ?? Infinity) - (b.displayOrder ?? Infinity));
  }

  /**
   * Recalcula el número (displayOrder) de TODAS las pruebas de la
   * competencia como una secuencia única y consecutiva — fecha por fecha
   * (en orden cronológico) y, dentro de cada fecha, jornada por jornada
   * (Mañana antes que Tarde) — nunca reinicia el conteo por jornada.
   * `overrideSessionId`/`overrideIds` permiten pasar el nuevo orden LOCAL
   * de una jornada recién modificada (por reordenar o por mover una
   * prueba desde otra jornada/fecha), antes de persistirlo.
   * `sourceEvents` permite calcular sobre una copia simulada (con el
   * cambio de jornada de una prueba ya aplicado en memoria) en vez del
   * estado real, que todavía no se refrescó del servidor.
   */
  async function renumberAllEvents(overrideSessionId?: string, overrideIds?: string[], sourceEvents: CompetitionEventItem[] = competitionEvents) {
    const updates: { id: string; displayOrder: number }[] = [];
    let counter = 1;
    for (const date of sortedDates) {
      const dateEvents = sourceEvents
        .filter((ce) => ce.competitionSession.competitionDate.date === date.date)
        .slice()
        .sort((a, b) => (a.displayOrder ?? Infinity) - (b.displayOrder ?? Infinity));
      const sessionNames = sortBySessionTypeName(Array.from(new Set(dateEvents.map((ce) => ce.competitionSession.sessionType.name))), (n) => n);
      for (const sessionName of sessionNames) {
        const sessionEvents = dateEvents.filter((ce) => ce.competitionSession.sessionType.name === sessionName);
        const sessionId = sessionEvents[0]?.competitionSessionId;
        const ids = sessionId && sessionId === overrideSessionId && overrideIds ? overrideIds : sessionEvents.map((ce) => ce.id);
        for (const id of ids) {
          updates.push({ id, displayOrder: counter });
          counter++;
        }
      }
    }

    const changed = updates.filter((u) => {
      const ce = competitionEvents.find((c) => c.id === u.id);
      return ce && ce.displayOrder !== u.displayOrder;
    });
    if (changed.length === 0) return;

    setReordering(true);
    try {
      await api.reorderCompetitionEvents(changed);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "No se pudo actualizar la numeración de las pruebas");
    } finally {
      setReordering(false);
    }
  }

  /**
   * Mueve una prueba ya asignada a otra jornada (de la misma fecha o de
   * otra), insertándola justo antes de `insertBeforeId` — o al final de
   * esa jornada si no se entrega ninguna. Si la jornada de destino es la
   * misma en la que ya estaba, esto equivale a un simple reordenar.
   */
  async function moveEventToSession(draggedId: string, targetDate: CompetitionDate, targetSessionId: string, insertBeforeId?: string) {
    const draggedCe = competitionEvents.find((c) => c.id === draggedId);
    const targetSession = targetDate.sessions.find((s) => s.id === targetSessionId);
    if (!draggedCe || !targetSession) return;

    const changingSession = draggedCe.competitionSessionId !== targetSessionId;

    // Copia simulada en memoria con el cambio de jornada ya aplicado, para
    // calcular la nueva numeración ANTES de que el servidor la confirme.
    const simulated: CompetitionEventItem[] = competitionEvents.map((ce) =>
      ce.id === draggedId
        ? { ...ce, competitionSessionId: targetSessionId, competitionSession: { ...ce.competitionSession, sessionType: targetSession.sessionType, competitionDate: { date: targetDate.date } } }
        : ce
    );

    const sessionIds = simulated
      .filter((ce) => ce.competitionSessionId === targetSessionId)
      .sort((a, b) => (a.displayOrder ?? Infinity) - (b.displayOrder ?? Infinity))
      .map((ce) => ce.id)
      .filter((id) => id !== draggedId);
    if (insertBeforeId && sessionIds.includes(insertBeforeId)) {
      sessionIds.splice(sessionIds.indexOf(insertBeforeId), 0, draggedId);
    } else {
      sessionIds.push(draggedId);
    }

    if (changingSession) {
      setReordering(true);
      try {
        await api.updateCompetitionEvent(draggedId, { competitionSessionId: targetSessionId });
      } catch (err) {
        onError(err instanceof Error ? err.message : "No se pudo mover la prueba de jornada");
        setReordering(false);
        return;
      }
      setReordering(false);
    }

    await renumberAllEvents(targetSessionId, sessionIds, simulated);
  }

  function openPendingAdd(eventId: string, date: CompetitionDate) {
    if (date.sessions.length === 0) {
      onError('Esta fecha todavía no tiene ninguna jornada creada — agregue una en "Fechas y jornadas" arriba antes de asignarle pruebas.');
      return;
    }
    setPendingAdd({ eventId, dateId: date.id });
    setPendingSessionId(sortBySessionTypeName(date.sessions, (s) => s.sessionType.name)[0]!.id);
    setPendingGroupIds([]);
  }

  async function confirmPendingAdd() {
    if (!pendingAdd) return;
    const event = events.find((e) => e.id === pendingAdd.eventId);
    if (!event) return;
    const categoryIds = resolveCategoryIdsFromGroups(pendingGroupIds, categories, event.testTypeId);
    if (categoryIds.length === 0) {
      onError("Debe seleccionar al menos un grupo de categorías.");
      return;
    }
    setAdding(true);
    try {
      // Se agrega al final de la numeración consecutiva de TODA la
      // competencia (no reinicia por jornada) — mientras esa numeración
      // ya sea consecutiva, esto la mantiene así sin tener que
      // renumerar todo de nuevo en cada alta.
      const maxOrder = competitionEvents.reduce((max, ce) => Math.max(max, ce.displayOrder ?? 0), 0);
      await api.addCompetitionEvent(competitionId, { eventId: pendingAdd.eventId, competitionSessionId: pendingSessionId, categoryIds, displayOrder: maxOrder + 1 });
      setPendingAdd(null);
      setPendingGroupIds([]);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "No se pudo agregar la prueba");
    } finally {
      setAdding(false);
    }
  }

  function startEdit(ce: CompetitionEventItem) {
    setEditingId(ce.id);
    setEditSessionId(ce.competitionSessionId);
    setEditStatus(ce.status);
    setEditGroupIds(computeSelectedGroupsFromCategoryIds(ce.enabledCategories.map((ec) => ec.category.id), categories, categoryGroups, ce.event.testTypeId));
  }

  async function saveEdit(ce: CompetitionEventItem) {
    const categoryIds = resolveCategoryIdsFromGroups(editGroupIds, categories, ce.event.testTypeId);
    if (categoryIds.length === 0) {
      onError("Debe seleccionar al menos un grupo de categorías.");
      return;
    }
    try {
      await api.updateCompetitionEvent(ce.id, { competitionSessionId: editSessionId, status: editStatus, categoryIds });
      setEditingId(null);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "No se pudo guardar la prueba");
    }
  }

  async function handleDeleteAssigned(ce: CompetitionEventItem) {
    if (!window.confirm("¿Quitar esta prueba de la competencia? La prueba maestra del catálogo no se elimina, solo su asignación aquí.")) return;
    try {
      await api.removeCompetitionEvent(ce.id);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "No se pudo eliminar la prueba");
    }
  }

  async function handleDropOnCard(date: CompetitionDate, draggedId: string, targetId: string) {
    setDragOverAssignedId(null);
    setDraggingAssignedId(null);
    if (draggedId === targetId) return;

    const targetCe = competitionEvents.find((c) => c.id === targetId);
    if (!targetCe) return;

    // Se suelta justo antes de la prueba destino — funciona igual para
    // reordenar dentro de la misma jornada que para moverla desde otra
    // jornada o fecha distinta.
    await moveEventToSession(draggedId, date, targetCe.competitionSessionId, targetId);
  }

  return (
    <div style={{ display: "flex", gap: "1rem", overflowX: "auto", paddingBottom: "0.5rem", marginTop: "0.75rem" }}>
      {/* -------- Columna izquierda: catálogo -------- */}
      <div style={{ minWidth: 240, flex: "0 0 240px", border: "1px solid var(--brand-gray-100)", borderRadius: 8, padding: "0.75rem", maxHeight: "75vh", overflowY: "auto" }}>
        <strong style={{ fontSize: "0.9rem" }}>Catálogo de pruebas</strong>
        <input placeholder="🔎 Buscar..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginTop: "0.4rem", marginBottom: "0.5rem" }} />
        {filteredCatalog.length === 0 && (
          <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)" }}>Sin pruebas en el catálogo — créelas primero en Catálogos.</p>
        )}
        {filteredCatalog.map((e) => (
          <div
            key={e.id}
            draggable
            onDragStart={(ev) => { ev.dataTransfer.setData(DRAG_CATALOG, e.id); setDraggingCatalogId(e.id); }}
            onDragEnd={() => setDraggingCatalogId(null)}
            style={{
              padding: "0.4rem 0.55rem",
              marginBottom: "0.3rem",
              borderRadius: 6,
              border: "1px solid var(--brand-gray-100)",
              background: draggingCatalogId === e.id ? "var(--brand-bg)" : "white",
              cursor: "grab",
              fontSize: "0.82rem",
            }}
          >
            ☰ {formatEventLabel({ distanceMeters: e.distance.meters, strokeName: e.stroke.name, gender: e.gender, isRelay: e.testType.swimmersCount > 1 })}
          </div>
        ))}
      </div>

      {/* -------- Columnas de la derecha: una por fecha -------- */}
      {sortedDates.length === 0 && (
        <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>Agregue al menos una fecha en "Fechas y jornadas" para poder asignarle pruebas.</p>
      )}
      {sortedDates.map((date) => {
        const assigned = assignedForDate(date);
        const isDropTarget = dragOverDateId === date.id;
        return (
          <div
            key={date.id}
            style={{ minWidth: 260, flex: "0 0 260px" }}
            onDragOver={(e) => { e.preventDefault(); setDragOverDateId(date.id); }}
            onDragLeave={() => setDragOverDateId((cur) => (cur === date.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverDateId(null);
              const catalogEventId = e.dataTransfer.getData(DRAG_CATALOG);
              const assignedDragId = e.dataTransfer.getData(DRAG_ASSIGNED);
              if (catalogEventId) openPendingAdd(catalogEventId, date);
              else if (assignedDragId && date.sessions.length > 0) {
                // Se soltó en el área general de la columna (no sobre una
                // prueba puntual): se mueve al final de la primera jornada
                // de esa fecha (Mañana si existe).
                const firstSession = sortBySessionTypeName(date.sessions, (s) => s.sessionType.name)[0]!;
                moveEventToSession(assignedDragId, date, firstSession.id);
              }
              setDraggingCatalogId(null);
            }}
          >
            <h3 style={{ fontSize: "0.9rem", color: "var(--brand-navy)", position: "sticky", top: 0, background: "white", padding: "0.2rem 0" }}>
              {formatCalendarDate(date.date, { weekday: "long", day: "2-digit", month: "2-digit" })}
            </h3>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
                minHeight: 60,
                border: isDropTarget ? "2px dashed var(--brand-blue-dark)" : "2px dashed transparent",
                borderRadius: 8,
                padding: isDropTarget ? "0.3rem" : 0,
              }}
            >
              {assigned.length === 0 && (
                <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)" }}>Sin pruebas asignadas — arrastre una del catálogo.</p>
              )}
              {sortBySessionTypeName(Array.from(new Set(assigned.map((ce) => ce.competitionSession.sessionType.name))), (n) => n).map((sessionName) => {
                const sessionId = assigned.find((ce) => ce.competitionSession.sessionType.name === sessionName)?.competitionSessionId;
                return (
                <div
                  key={sessionName}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const assignedDragId = e.dataTransfer.getData(DRAG_ASSIGNED);
                    if (assignedDragId && sessionId) moveEventToSession(assignedDragId, date, sessionId);
                  }}
                >
                  <h4 style={{ fontSize: "0.75rem", color: "var(--brand-gray-600)", textTransform: "uppercase", letterSpacing: "0.03em", margin: "0.4rem 0 0.3rem" }}>
                    {sessionName}
                  </h4>
                  {assigned.filter((ce) => ce.competitionSession.sessionType.name === sessionName).map((ce) => (
                <div
                  key={ce.id}
                  draggable={editingId !== ce.id}
                  onDragStart={(e) => { e.dataTransfer.setData(DRAG_ASSIGNED, ce.id); setDraggingAssignedId(ce.id); }}
                  onDragEnd={() => setDraggingAssignedId(null)}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverAssignedId(ce.id); }}
                  onDragLeave={() => setDragOverAssignedId((cur) => (cur === ce.id ? null : cur))}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const assignedDragId = e.dataTransfer.getData(DRAG_ASSIGNED);
                    const catalogEventId = e.dataTransfer.getData(DRAG_CATALOG);
                    if (assignedDragId) handleDropOnCard(date, assignedDragId, ce.id);
                    else if (catalogEventId) openPendingAdd(catalogEventId, date);
                    setDraggingCatalogId(null);
                  }}
                  style={{
                    border: `2px solid ${dragOverAssignedId === ce.id ? "var(--brand-blue-dark)" : "var(--brand-gray-100)"}`,
                    borderRadius: 8,
                    padding: "0.5rem",
                    background: draggingAssignedId === ce.id ? "var(--brand-bg)" : "white",
                    cursor: editingId === ce.id ? "default" : "grab",
                  }}
                >
                  {editingId !== ce.id ? (
                    <>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <strong style={{ fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "0.35rem" }}>
                          <CircledNumber n={ce.displayOrder} />
                          {formatEventLabel({ distanceMeters: ce.event.distance.meters, strokeName: ce.event.stroke.name, gender: ce.event.gender, isRelay: ce.event.testType.swimmersCount > 1 })}
                        </strong>
                        <span style={{ fontSize: "0.65rem", color: "var(--brand-gray-600)" }}>☰</span>
                      </div>
                      <p style={{ fontSize: "0.7rem", color: "var(--brand-gray-600)", margin: "0.15rem 0" }}>
                        {Array.from(new Set(ce.enabledCategories.map((ec) => ec.category.categoryGroup?.name ?? "Sin grupo"))).join(", ")}
                      </p>
                      <span className={`badge ${ce.status === "enabled" ? "badge-active" : "badge-disabled"}`} style={{ fontSize: "0.68rem" }}>
                        {ce.status === "enabled" ? "Habilitada" : "Deshabilitada"}
                      </span>
                      <div style={{ display: "flex", gap: "0.3rem", marginTop: "0.35rem" }}>
                        <button className="btn-secondary" style={{ padding: "0.1rem 0.4rem", fontSize: "0.72rem" }} onClick={() => startEdit(ce)}>Editar</button>
                        <button className="btn-danger" style={{ padding: "0.1rem 0.4rem", fontSize: "0.72rem" }} onClick={() => handleDeleteAssigned(ce)}>Eliminar</button>
                      </div>
                    </>
                  ) : (
                    <div>
                      <p style={{ fontSize: "0.78rem", margin: "0 0 0.3rem" }}>
                        {formatEventLabel({ distanceMeters: ce.event.distance.meters, strokeName: ce.event.stroke.name, gender: ce.event.gender, isRelay: ce.event.testType.swimmersCount > 1 })}
                      </p>
                      <label style={{ fontSize: "0.72rem" }}>Jornada</label>
                      <select value={editSessionId} onChange={(e) => setEditSessionId(e.target.value)} style={{ fontSize: "0.78rem" }}>
                        {sortBySessionTypeName(date.sessions, (s) => s.sessionType.name).map((s) => <option key={s.id} value={s.id}>{s.sessionType.name}</option>)}
                      </select>
                      <label style={{ fontSize: "0.72rem" }}>Estado</label>
                      <select value={editStatus} onChange={(e) => setEditStatus(e.target.value as "enabled" | "disabled")} style={{ fontSize: "0.78rem" }}>
                        <option value="enabled">Habilitada</option>
                        <option value="disabled">Deshabilitada</option>
                      </select>
                      <label style={{ fontSize: "0.72rem" }}>Grupos de categorías</label>
                      <GroupCheckboxes testTypeId={ce.event.testTypeId} categories={categories} categoryGroups={categoryGroups} selectedGroupIds={editGroupIds} onChange={setEditGroupIds} />
                      <div style={{ display: "flex", gap: "0.3rem", marginTop: "0.4rem" }}>
                        <button className="btn-primary" style={{ padding: "0.15rem 0.5rem", fontSize: "0.75rem" }} onClick={() => saveEdit(ce)}>Guardar</button>
                        <button className="btn-secondary" style={{ padding: "0.15rem 0.5rem", fontSize: "0.75rem" }} onClick={() => setEditingId(null)}>Cancelar</button>
                      </div>
                    </div>
                  )}
                </div>
                  ))}
                </div>
                );
              })}

              {pendingAdd?.dateId === date.id && (() => {
                const event = events.find((e) => e.id === pendingAdd.eventId);
                if (!event) return null;
                return (
                  <div style={{ border: "2px dashed var(--brand-blue-dark)", borderRadius: 8, padding: "0.5rem", background: "var(--brand-bg)" }}>
                    <p style={{ fontSize: "0.78rem", margin: "0 0 0.3rem" }}>
                      Agregar: <strong>{formatEventLabel({ distanceMeters: event.distance.meters, strokeName: event.stroke.name, gender: event.gender, isRelay: event.testType.swimmersCount > 1 })}</strong>
                    </p>
                    {date.sessions.length > 1 && (
                      <>
                        <label style={{ fontSize: "0.72rem" }}>Jornada</label>
                        <select value={pendingSessionId} onChange={(e) => setPendingSessionId(e.target.value)} style={{ fontSize: "0.78rem" }}>
                          {sortBySessionTypeName(date.sessions, (s) => s.sessionType.name).map((s) => <option key={s.id} value={s.id}>{s.sessionType.name}</option>)}
                        </select>
                      </>
                    )}
                    <label style={{ fontSize: "0.72rem" }}>Grupos de categorías</label>
                    <GroupCheckboxes testTypeId={event.testTypeId} categories={categories} categoryGroups={categoryGroups} selectedGroupIds={pendingGroupIds} onChange={setPendingGroupIds} />
                    <div style={{ display: "flex", gap: "0.3rem", marginTop: "0.4rem" }}>
                      <button className="btn-primary" style={{ padding: "0.15rem 0.5rem", fontSize: "0.75rem" }} onClick={confirmPendingAdd} disabled={pendingGroupIds.length === 0 || adding}>
                        {adding ? "Agregando..." : "Confirmar"}
                      </button>
                      <button className="btn-secondary" style={{ padding: "0.15rem 0.5rem", fontSize: "0.75rem" }} onClick={() => setPendingAdd(null)}>Cancelar</button>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        );
      })}
      {reordering && <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)" }}>Guardando nuevo orden...</p>}
    </div>
  );
}
