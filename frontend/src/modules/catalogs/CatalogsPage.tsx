import { useEffect, useState, useCallback } from "react";
import { AppShell } from "../../shared/AppShell";
import { InlineEditableCell } from "../../shared/InlineEditableCell";
import { useSort, sortItems, SortableTh } from "../../shared/sortableTable";
import {
  useCatalogsApi,
  type TestType,
  type Distance,
  type Stroke,
  type Category,
  type CategoryGroup,
  type EventItem,
  type EventGender,
} from "./catalogsApi";
import { usePoolsApi, type Pool, type PoolCourseLength } from "../pools/poolsApi";

const GENDER_LABELS: Record<EventGender, string> = { male: "Varones", female: "Damas", mixed: "Mixto" };

type Tab = "distances" | "strokes" | "categoryGroups" | "categories" | "events" | "pools";

export function CatalogsPage() {
  const api = useCatalogsApi();
  const poolsApi = usePoolsApi();
  const [tab, setTab] = useState<Tab>("categories");
  const { sortKey: categorySortKey, sortDir: categorySortDir, onSort: onCategorySort } = useSort<"name" | "group" | "testType" | "ageRange">();
  const { sortKey: eventSortKey, sortDir: eventSortDir, onSort: onEventSort } = useSort<"event" | "testType" | "gender">();
  const [testTypes, setTestTypes] = useState<TestType[]>([]);
  const [distances, setDistances] = useState<Distance[]>([]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const [tt, d, s, g, c, e, p] = await Promise.all([
      api.listTestTypes(),
      api.listDistances(),
      api.listStrokes(),
      api.listCategoryGroups(),
      api.listCategories(),
      api.listEvents(),
      poolsApi.list(),
    ]);
    setTestTypes(tt);
    setDistances(d);
    setStrokes(s);
    setCategoryGroups(g);
    setCategories(c.items);
    setEvents(e.items);
    setPools(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // ---------- Distancias ----------
  const [distanceForm, setDistanceForm] = useState("");

  async function handleSaveDistance() {
    setError(null);
    try {
      await api.createDistance(Number(distanceForm));
      setDistanceForm("");
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la distancia");
    }
  }
  async function handleDeleteDistance(id: string) {
    if (!window.confirm("¿Eliminar esta distancia?")) return;
    setError(null);
    try {
      await api.deleteDistance(id);
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar la distancia");
    }
  }

  // ---------- Estilos ----------
  const [strokeForm, setStrokeForm] = useState("");

  async function handleSaveStroke() {
    setError(null);
    try {
      await api.createStroke(strokeForm);
      setStrokeForm("");
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el estilo");
    }
  }
  async function handleDeleteStroke(id: string) {
    if (!window.confirm("¿Eliminar este estilo?")) return;
    setError(null);
    try {
      await api.deleteStroke(id);
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar el estilo");
    }
  }

  // ---------- Grupos de categorías ----------
  const [groupForm, setGroupForm] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);

  function startEditGroup(g: CategoryGroup) {
    setEditingGroupId(g.id);
    setGroupForm(g.name);
  }
  function cancelEditGroup() {
    setEditingGroupId(null);
    setGroupForm("");
  }
  async function handleSaveGroup() {
    setError(null);
    try {
      if (editingGroupId) {
        await api.updateCategoryGroup(editingGroupId, groupForm);
      } else {
        await api.createCategoryGroup(groupForm);
      }
      cancelEditGroup();
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el grupo de categorías");
    }
  }
  async function handleDeleteGroup(id: string) {
    if (!window.confirm("¿Eliminar este grupo de categorías? Las categorías que pertenecían a él quedarán sin grupo asignado, no se eliminan.")) return;
    setError(null);
    try {
      await api.deleteCategoryGroup(id);
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar el grupo de categorías");
    }
  }

  // ---------- Categorías ----------
  const emptyCategoryForm = { testTypeId: "", categoryGroupId: "", name: "", minAge: "", maxAge: "" };
  const [newCategory, setNewCategory] = useState(emptyCategoryForm);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);

  function startEditCategory(c: Category) {
    setEditingCategoryId(c.id);
    setNewCategory({ testTypeId: c.testTypeId, categoryGroupId: c.categoryGroupId ?? "", name: c.name, minAge: String(c.minAge), maxAge: String(c.maxAge) });
  }
  function cancelEditCategory() {
    setEditingCategoryId(null);
    setNewCategory(emptyCategoryForm);
  }
  async function handleSaveCategory() {
    setError(null);
    try {
      if (editingCategoryId) {
        await api.updateCategory(editingCategoryId, {
          categoryGroupId: newCategory.categoryGroupId || null,
          name: newCategory.name,
          minAge: Number(newCategory.minAge),
          maxAge: Number(newCategory.maxAge),
        });
      } else {
        await api.createCategory({
          testTypeId: newCategory.testTypeId,
          categoryGroupId: newCategory.categoryGroupId || null,
          name: newCategory.name,
          minAge: Number(newCategory.minAge),
          maxAge: Number(newCategory.maxAge),
        });
      }
      cancelEditCategory();
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la categoría");
    }
  }
  async function handleDeleteCategory(id: string) {
    if (!window.confirm("¿Eliminar esta categoría?")) return;
    setError(null);
    try {
      await api.deleteCategory(id);
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar la categoría");
    }
  }

  // ---------- Pruebas ----------
  const emptyEventForm = { testTypeId: "", distanceId: "", strokeId: "", gender: "mixed" as EventGender };
  const [newEvent, setNewEvent] = useState(emptyEventForm);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);

  function startEditEvent(ev: EventItem) {
    setEditingEventId(ev.id);
    setNewEvent({ testTypeId: ev.testTypeId, distanceId: ev.distanceId, strokeId: ev.strokeId, gender: ev.gender });
  }
  function cancelEditEvent() {
    setEditingEventId(null);
    setNewEvent(emptyEventForm);
  }
  async function handleSaveEvent() {
    setError(null);
    try {
      if (editingEventId) {
        await api.updateEvent(editingEventId, { gender: newEvent.gender });
      } else {
        await api.createEvent(newEvent);
      }
      cancelEditEvent();
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la prueba");
    }
  }
  async function handleDeleteEvent(id: string) {
    if (!window.confirm("¿Eliminar esta prueba?")) return;
    setError(null);
    try {
      await api.deleteEvent(id);
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar la prueba");
    }
  }

  // ---------- Piscinas ----------
  const [poolName, setPoolName] = useState("");
  const [poolAddress, setPoolAddress] = useState("");
  const [poolHeated, setPoolHeated] = useState(false);
  const [poolCovered, setPoolCovered] = useState(false);
  const [poolCourseLength, setPoolCourseLength] = useState<PoolCourseLength>("long_50m");

  async function handleSavePool() {
    setError(null);
    try {
      if (!poolName.trim()) throw new Error("El nombre de la piscina es obligatorio");
      await poolsApi.create({ name: poolName.trim(), address: poolAddress.trim() || undefined, isHeated: poolHeated, isCovered: poolCovered, courseLength: poolCourseLength });
      setPoolName("");
      setPoolAddress("");
      setPoolHeated(false);
      setPoolCovered(false);
      setPoolCourseLength("long_50m");
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la piscina");
    }
  }
  async function handleDeletePool(id: string) {
    if (!window.confirm("¿Eliminar esta piscina?")) return;
    setError(null);
    try {
      await poolsApi.remove(id);
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar la piscina");
    }
  }

  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)" }}>Catálogos</h1>
      <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
        Tipos de prueba, distancias, estilos, grupos de categorías, categorías y pruebas maestras — reutilizables en todas las competencias.
      </p>

      <div style={{ display: "flex", gap: "0.5rem", margin: "1rem 0", flexWrap: "wrap" }}>
        {(["categories", "categoryGroups", "events", "distances", "strokes", "pools"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "btn-primary" : "btn-secondary"} onClick={() => setTab(t)}>
            {{ categories: "Categorías", categoryGroups: "Grupos de categorías", events: "Pruebas", distances: "Distancias", strokes: "Estilos", pools: "Piscinas" }[t]}
          </button>
        ))}
      </div>

      {error && <p className="error-message">{error}</p>}

      {tab === "distances" && (
        <div style={{ maxWidth: 420 }}>
          <label>Nueva distancia (metros)</label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input type="number" min={1} value={distanceForm} onChange={(e) => setDistanceForm(e.target.value)} />
            <button className="btn-primary" onClick={handleSaveDistance}>Agregar</button>
          </div>
          <table className="data-table" style={{ marginTop: "1rem" }}>
            <thead><tr><th>Metros</th><th></th></tr></thead>
            <tbody>
              {distances.map((d) => (
                <tr key={d.id}>
                  <td>
                    <InlineEditableCell
                      value={String(d.meters)}
                      type="number"
                      onSave={async (v) => {
                        const n = Number(v);
                        if (!n || n <= 0) throw new Error("Debe ser un número mayor a 0");
                        await api.updateDistance(d.id, n);
                        loadAll();
                      }}
                    />{" "}m
                  </td>
                  <td>
                    <button className="btn-danger" onClick={() => handleDeleteDistance(d.id)}>Eliminar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "strokes" && (
        <div style={{ maxWidth: 420 }}>
          <label>Nuevo estilo</label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input value={strokeForm} onChange={(e) => setStrokeForm(e.target.value)} placeholder="Ej: Combinado" />
            <button className="btn-primary" onClick={handleSaveStroke}>Agregar</button>
          </div>
          <table className="data-table" style={{ marginTop: "1rem" }}>
            <thead><tr><th>Estilo</th><th></th></tr></thead>
            <tbody>
              {strokes.map((s) => (
                <tr key={s.id}>
                  <td>
                    <InlineEditableCell
                      value={s.name}
                      onSave={async (v) => {
                        if (!v.trim()) throw new Error("El nombre no puede quedar vacío");
                        await api.updateStroke(s.id, v.trim());
                        loadAll();
                      }}
                    />
                  </td>
                  <td>
                    <button className="btn-danger" onClick={() => handleDeleteStroke(s.id)}>Eliminar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "pools" && (
        <div style={{ maxWidth: 640 }}>
          <label>Nueva piscina</label>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}>
            <input value={poolName} onChange={(e) => setPoolName(e.target.value)} placeholder="Nombre del recinto" />
            <input value={poolAddress} onChange={(e) => setPoolAddress(e.target.value)} placeholder="Dirección (opcional)" />
            <label style={{ fontWeight: 400 }}>
              Largo
              <select value={poolCourseLength} onChange={(e) => setPoolCourseLength(e.target.value as PoolCourseLength)} style={{ marginLeft: "0.5rem" }}>
                <option value="long_50m">50 metros</option>
                <option value="short_25m">25 metros</option>
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
              <input type="checkbox" checked={poolHeated} onChange={(e) => setPoolHeated(e.target.checked)} style={{ width: "auto" }} />
              Temperada
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
              <input type="checkbox" checked={poolCovered} onChange={(e) => setPoolCovered(e.target.checked)} style={{ width: "auto" }} />
              Techada
            </label>
            <button className="btn-primary" onClick={handleSavePool} style={{ alignSelf: "flex-start" }}>Agregar</button>
          </div>
          <table className="data-table" style={{ marginTop: "1rem" }}>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Dirección</th>
                <th>Largo</th>
                <th>Temperada</th>
                <th>Techada</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pools.map((p) => (
                <tr key={p.id}>
                  <td>
                    <InlineEditableCell
                      value={p.name}
                      onSave={async (v) => {
                        if (!v.trim()) throw new Error("El nombre no puede quedar vacío");
                        await poolsApi.update(p.id, { name: v.trim() });
                        loadAll();
                      }}
                    />
                  </td>
                  <td>
                    <InlineEditableCell
                      value={p.address ?? ""}
                      onSave={async (v) => {
                        await poolsApi.update(p.id, { address: v.trim() });
                        loadAll();
                      }}
                    />
                  </td>
                  <td>
                    <select
                      value={p.courseLength}
                      onChange={async (e) => {
                        await poolsApi.update(p.id, { courseLength: e.target.value as PoolCourseLength });
                        loadAll();
                      }}
                    >
                      <option value="long_50m">50 metros</option>
                      <option value="short_25m">25 metros</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={p.isHeated}
                      onChange={async (e) => {
                        await poolsApi.update(p.id, { isHeated: e.target.checked });
                        loadAll();
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={p.isCovered}
                      onChange={async (e) => {
                        await poolsApi.update(p.id, { isCovered: e.target.checked });
                        loadAll();
                      }}
                    />
                  </td>
                  <td>
                    <button className="btn-danger" onClick={() => handleDeletePool(p.id)}>Eliminar</button>
                  </td>
                </tr>
              ))}
              {pools.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1rem" }}>Sin piscinas registradas.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "categoryGroups" && (
        <div style={{ maxWidth: 420 }}>
          <label>{editingGroupId ? "Editar grupo de categorías" : "Nuevo grupo de categorías"}</label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input value={groupForm} onChange={(e) => setGroupForm(e.target.value)} placeholder="Ej: Máster Damas" />
            <button className="btn-primary" onClick={handleSaveGroup}>{editingGroupId ? "Guardar" : "Agregar"}</button>
            {editingGroupId && <button className="btn-secondary" onClick={cancelEditGroup}>Cancelar</button>}
          </div>
          <table className="data-table" style={{ marginTop: "1rem" }}>
            <thead><tr><th>Grupo</th><th></th></tr></thead>
            <tbody>
              {categoryGroups.map((g) => (
                <tr key={g.id}>
                  <td>{g.name}</td>
                  <td style={{ display: "flex", gap: "0.4rem" }}>
                    <button className="btn-secondary" onClick={() => startEditGroup(g)}>Editar</button>
                    <button className="btn-danger" onClick={() => handleDeleteGroup(g.id)}>Eliminar</button>
                  </td>
                </tr>
              ))}
              {categoryGroups.length === 0 && (
                <tr><td colSpan={2} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1rem" }}>Sin grupos creados.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "categories" && (
        <div>
          <div style={{ maxWidth: 640, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label>Tipo de prueba</label>
              <select
                value={newCategory.testTypeId}
                onChange={(e) => setNewCategory({ ...newCategory, testTypeId: e.target.value })}
                disabled={Boolean(editingCategoryId)}
              >
                <option value="">Seleccionar...</option>
                {testTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label>Grupo de categorías (opcional)</label>
              <select value={newCategory.categoryGroupId} onChange={(e) => setNewCategory({ ...newCategory, categoryGroupId: e.target.value })}>
                <option value="">Sin grupo</option>
                {categoryGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div>
              <label>Nombre de la categoría</label>
              <input value={newCategory.name} onChange={(e) => setNewCategory({ ...newCategory, name: e.target.value })} placeholder="Ej: 25-29" />
            </div>
            <div>
              <label>Edad mínima</label>
              <input type="number" value={newCategory.minAge} onChange={(e) => setNewCategory({ ...newCategory, minAge: e.target.value })} />
            </div>
            <div>
              <label>Edad máxima</label>
              <input type="number" value={newCategory.maxAge} onChange={(e) => setNewCategory({ ...newCategory, maxAge: e.target.value })} />
            </div>
          </div>
          <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "0.5rem" }}>
            La edad de cada nadador se calcula con la fecha de corte definida en cada competencia (Módulo Competencias) — no aquí.
          </p>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button className="btn-primary" onClick={handleSaveCategory}>{editingCategoryId ? "Guardar cambios" : "Crear categoría"}</button>
            {editingCategoryId && <button className="btn-secondary" onClick={cancelEditCategory}>Cancelar edición</button>}
          </div>

          <table className="data-table" style={{ marginTop: "1.5rem" }}>
            <thead><tr>
              <SortableTh label="Categoría" sortKey="name" activeKey={categorySortKey} activeDir={categorySortDir} onSort={onCategorySort} />
              <SortableTh label="Grupo" sortKey="group" activeKey={categorySortKey} activeDir={categorySortDir} onSort={onCategorySort} />
              <SortableTh label="Tipo de prueba" sortKey="testType" activeKey={categorySortKey} activeDir={categorySortDir} onSort={onCategorySort} />
              <SortableTh label="Rango de edad" sortKey="ageRange" activeKey={categorySortKey} activeDir={categorySortDir} onSort={onCategorySort} />
              <th></th>
            </tr></thead>
            <tbody>
              {sortItems(categories, categorySortKey, categorySortDir, (c, key) => {
                switch (key) {
                  case "name": return c.name;
                  case "group": return c.categoryGroup?.name ?? null;
                  case "testType": return c.testType.name;
                  case "ageRange": return c.minAge;
                }
              }).map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.categoryGroup?.name ?? <span style={{ color: "var(--brand-gray-600)" }}>Sin grupo</span>}</td>
                  <td>{c.testType.name}</td>
                  <td>{c.minAge} - {c.maxAge} años</td>
                  <td style={{ display: "flex", gap: "0.4rem" }}>
                    <button className="btn-secondary" onClick={() => startEditCategory(c)}>Editar</button>
                    <button className="btn-danger" onClick={() => handleDeleteCategory(c.id)}>Eliminar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "events" && (
        <div>
          <div style={{ maxWidth: 640, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label>Tipo de prueba</label>
              <select
                value={newEvent.testTypeId}
                onChange={(e) => setNewEvent({ ...newEvent, testTypeId: e.target.value })}
                disabled={Boolean(editingEventId)}
              >
                <option value="">Seleccionar...</option>
                {testTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label>Género</label>
              <select value={newEvent.gender} onChange={(e) => setNewEvent({ ...newEvent, gender: e.target.value as EventGender })}>
                <option value="male">Varones</option>
                <option value="female">Damas</option>
                <option value="mixed">Mixto</option>
              </select>
            </div>
            <div>
              <label>Distancia</label>
              <select
                value={newEvent.distanceId}
                onChange={(e) => setNewEvent({ ...newEvent, distanceId: e.target.value })}
                disabled={Boolean(editingEventId)}
              >
                <option value="">Seleccionar...</option>
                {distances.map((d) => <option key={d.id} value={d.id}>{d.meters} m</option>)}
              </select>
            </div>
            <div>
              <label>Estilo</label>
              <select
                value={newEvent.strokeId}
                onChange={(e) => setNewEvent({ ...newEvent, strokeId: e.target.value })}
                disabled={Boolean(editingEventId)}
              >
                <option value="">Seleccionar...</option>
                {strokes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          {editingEventId && (
            <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "0.4rem" }}>
              Al editar una prueba solo se puede cambiar el género — el tipo, la distancia y el estilo definen su identidad (para cambiarlos, elimine y cree una nueva).
            </p>
          )}

          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button className="btn-primary" onClick={handleSaveEvent}>{editingEventId ? "Guardar cambios" : "Crear prueba"}</button>
            {editingEventId && <button className="btn-secondary" onClick={cancelEditEvent}>Cancelar edición</button>}
          </div>

          <table className="data-table" style={{ marginTop: "1.5rem" }}>
            <thead><tr>
              <SortableTh label="Prueba" sortKey="event" activeKey={eventSortKey} activeDir={eventSortDir} onSort={onEventSort} />
              <SortableTh label="Tipo" sortKey="testType" activeKey={eventSortKey} activeDir={eventSortDir} onSort={onEventSort} />
              <SortableTh label="Género" sortKey="gender" activeKey={eventSortKey} activeDir={eventSortDir} onSort={onEventSort} />
              <th></th>
            </tr></thead>
            <tbody>
              {sortItems(events, eventSortKey, eventSortDir, (ev, key) => {
                switch (key) {
                  case "event": return ev.distance.meters;
                  case "testType": return ev.testType.name;
                  case "gender": return GENDER_LABELS[ev.gender];
                }
              }).map((ev) => (
                <tr key={ev.id}>
                  <td>{ev.distance.meters}m {ev.stroke.name}</td>
                  <td>{ev.testType.name}</td>
                  <td>{GENDER_LABELS[ev.gender]}</td>
                  <td style={{ display: "flex", gap: "0.4rem" }}>
                    <button className="btn-secondary" onClick={() => startEditEvent(ev)}>Editar</button>
                    <button className="btn-danger" onClick={() => handleDeleteEvent(ev.id)}>Eliminar</button>
                  </td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1rem" }}>Sin pruebas registradas.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
