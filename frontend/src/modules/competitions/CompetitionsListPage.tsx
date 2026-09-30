import { useEffect, useState, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useCompetitionsApi, type Competition, type CompetitionStatus } from "./competitionsApi";
import { useSort, sortItems, SortableTh } from "../../shared/sortableTable";
import { usePoolsApi, type Pool } from "../pools/poolsApi";

const STATUS_LABELS: Record<CompetitionStatus, string> = {
  draft: "Borrador",
  scheduled: "Inscripciones programadas",
  open: "Inscripciones abiertas",
  individual_closed: "Inscripciones individuales cerradas",
  closed: "Inscripciones cerradas",
  in_progress: "En ejecución",
  finished: "Finalizada",
  cancelled: "Cancelada",
};
const STATUS_BADGE: Record<CompetitionStatus, string> = {
  draft: "badge-locked",
  scheduled: "badge-locked",
  open: "badge-active",
  // Cierre PARCIAL: ni activa ni inactiva del todo. Se usa la insignia de
  // AVISO —la misma que 'scheduled'—, no la de deshabilitado: los relevos
  // siguen abiertos, y pintarla como una competencia cerrada haría que nadie
  // entrara a armar equipos.
  individual_closed: "badge-locked",
  closed: "badge-disabled",
  in_progress: "badge-active",
  finished: "badge-disabled",
  cancelled: "badge-disabled",
};

export function CompetitionsListPage() {
  const api = useCompetitionsApi();
  const poolsApi = usePoolsApi();
  const [pools, setPools] = useState<Pool[]>([]);
  const navigate = useNavigate();
  const [status, setStatus] = useState<CompetitionStatus | "">("");
  const { sortKey, sortDir, onSort } = useSort<"name" | "registrationStartAt" | "status">();
  /**
   * La respuesta trae también `page` y `pageSize`: se guardan porque el pie de
   * página los necesita. Antes se descartaban, la llamada no enviaba `page` y la
   * tabla mostraba solo las 20 primeras competencias —el tamaño por omisión del
   * backend— sin ningún control para ver el resto.
   */
  const [data, setData] = useState<{ items: Competition[]; total: number; page: number; pageSize: number } | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", registrationStartAt: "", registrationEndAt: "", ageCutoffDate: "", maxIndividualEventsPerSwimmer: "", maxRelayEventsPerSwimmerPerSession: "1", maxSwimmers: "", maxSwimmersPerClub: "", poolId: "" });

  useEffect(() => {
    poolsApi.list().then(setPools);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await api.list({ status: (status || undefined) as CompetitionStatus | undefined, page }));
      // Una carga correcta BORRA el error anterior: si no, un fallo puntual
      // dejaba el mensaje pegado sobre datos que ya se habían cargado bien.
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar competencias");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, page]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDelete(competition: Competition) {
    if (
      !window.confirm(
        `¿Eliminar la competencia "${competition.name}"? Esta acción NO se puede deshacer y también elimina TODAS sus inscripciones ya confirmadas (individuales y de relevo).`
      )
    )
      return;
    try {
      await api.remove(competition.id);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "No se pudo eliminar la competencia");
    }
  }

  async function handleCreate() {
    setError(null);
    try {
      const c = await api.create({
        ...form,
        maxIndividualEventsPerSwimmer: Number(form.maxIndividualEventsPerSwimmer),
        maxRelayEventsPerSwimmerPerSession: Number(form.maxRelayEventsPerSwimmerPerSession || 1),
        // Vacío = sin cupo. Se envía null, no undefined, para que el campo
        // quede explícitamente sin límite.
        maxSwimmers: form.maxSwimmers !== "" ? Number(form.maxSwimmers) : null,
        maxSwimmersPerClub: form.maxSwimmersPerClub !== "" ? Number(form.maxSwimmersPerClub) : null,
        poolId: form.poolId || undefined,
      });
      setShowCreate(false);
      setForm({ name: "", description: "", registrationStartAt: "", registrationEndAt: "", ageCutoffDate: "", maxIndividualEventsPerSwimmer: "", maxRelayEventsPerSwimmerPerSession: "1", maxSwimmers: "", maxSwimmersPerClub: "", poolId: "" });
      navigate(`/competencias/${c.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la competencia");
    }
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h1 style={{ color: "var(--brand-navy)" }}>Competencias</h1>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Link to="/competencias/importar" className="btn-secondary" style={{ textDecoration: "none" }}>
            Importar desde Team Manager
          </Link>
          <button className="btn-primary" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Cancelar" : "+ Nueva competencia"}
          </button>
        </div>
      </div>

      {showCreate && (
        <div style={{ maxWidth: 560, marginBottom: "1.5rem", background: "var(--brand-bg)", padding: "1rem", borderRadius: 8 }}>
          <label>Nombre</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label>Descripción (opcional)</label>
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label>Inicio de inscripción</label>
              <input type="datetime-local" value={form.registrationStartAt} onChange={(e) => setForm({ ...form, registrationStartAt: e.target.value })} />
            </div>
            <div>
              <label>Fin de inscripción</label>
              <input type="datetime-local" value={form.registrationEndAt} onChange={(e) => setForm({ ...form, registrationEndAt: e.target.value })} />
            </div>
          </div>
          <label>Fecha de corte para el cálculo de edad de categoría</label>
          <input type="date" value={form.ageCutoffDate} onChange={(e) => setForm({ ...form, ageCutoffDate: e.target.value })} />
          <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "0.2rem" }}>
            La edad de cada nadador se calcula restando su año de nacimiento al año de esta fecha (ej.: nace en 1972, fecha de corte 31-12-2025 → 53 años). Es una sola fecha para toda la competencia.
          </p>
          <label>Máximo de pruebas individuales por nadador (para toda la competencia; no aplica a relevos)</label>
          <input
            type="number"
            min={1}
            value={form.maxIndividualEventsPerSwimmer}
            onChange={(e) => setForm({ ...form, maxIndividualEventsPerSwimmer: e.target.value })}
          />
          <label>Máximo de relevos por nadador en cada jornada</label>
          <input
            type="number"
            min={0}
            value={form.maxRelayEventsPerSwimmerPerSession}
            onChange={(e) => setForm({ ...form, maxRelayEventsPerSwimmerPerSession: e.target.value })}
          />
          <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "0.2rem" }}>
            Cuántos relevos puede nadar una misma persona dentro de una fecha y jornada. Por defecto 1. Use 0 si la competencia no admite relevos. El
            límite por jornada (en la ficha de cada jornada) puede restringirlo más, nunca ampliarlo.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label htmlFor="nuevo-cupo-total">Cupo de nadadores (opcional)</label>
              <input
                id="nuevo-cupo-total"
                type="number"
                min={1}
                placeholder="Sin límite"
                value={form.maxSwimmers}
                onChange={(e) => setForm({ ...form, maxSwimmers: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="nuevo-cupo-club">Cupo por club (opcional)</label>
              <input
                id="nuevo-cupo-club"
                type="number"
                min={1}
                placeholder="Sin límite"
                value={form.maxSwimmersPerClub}
                onChange={(e) => setForm({ ...form, maxSwimmersPerClub: e.target.value })}
              />
            </div>
          </div>
          <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "0.2rem" }}>
            Cuentan <strong>nadadores distintos</strong>, no pruebas. Al llenarse el cupo total, las inscripciones se cierran automáticamente. Deje
            los campos vacíos para no poner límite.
          </p>
          <label>Piscina (opcional)</label>
          <select value={form.poolId} onChange={(e) => setForm({ ...form, poolId: e.target.value })}>
            <option value="">Sin especificar</option>
            {pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="btn-primary" style={{ marginTop: "0.75rem" }} onClick={handleCreate}>Crear (borrador)</button>
        </div>
      )}

      <div style={{ marginBottom: "1rem" }}>
        <select value={status} onChange={(e) => {
            // Cambiar el filtro vuelve a la primera página: la 3 del filtro
            // anterior puede no existir en el nuevo.
            setPage(1);
            setStatus(e.target.value as CompetitionStatus | "");
          }} style={{ maxWidth: 260 }}>
          <option value="">Todos los estados</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {error && <p className="error-message">{error}</p>}

      {data && (
        <table className="data-table">
          <thead><tr>
            <SortableTh label="Competencia" sortKey="name" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
            <SortableTh label="Período de inscripción" sortKey="registrationStartAt" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
            <SortableTh label="Estado" sortKey="status" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
            <th></th>
          </tr></thead>
          <tbody>
            {sortItems(data.items, sortKey, sortDir, (c, key) => {
              switch (key) {
                case "name": return c.name;
                case "registrationStartAt": return new Date(c.registrationStartAt);
                case "status": return STATUS_LABELS[c.status];
              }
            }).map((c) => (
              <tr key={c.id}>
                <td><Link to={`/competencias/${c.id}`}>{c.name}</Link></td>
                <td>
                  {new Date(c.registrationStartAt).toLocaleDateString("es-CL")} — {new Date(c.registrationEndAt).toLocaleDateString("es-CL")}
                </td>
                <td><span className={`badge ${STATUS_BADGE[c.status]}`}>{STATUS_LABELS[c.status]}</span></td>
                <td>
                  <button className="btn-danger" onClick={() => handleDelete(c)}>Eliminar</button>
                </td>
              </tr>
            ))}
            {data.items.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1.5rem" }}>No hay competencias con este filtro.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {data && data.total > 0 && (
        <div style={{ marginTop: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
            {data.total} competencia(s) — página {data.page}
          </span>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Anterior
            </button>
            <button
              className="btn-secondary"
              disabled={page * data.pageSize >= data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Siguiente
            </button>
          </div>
        </div>
      )}
    </AppShell>
  );
}
