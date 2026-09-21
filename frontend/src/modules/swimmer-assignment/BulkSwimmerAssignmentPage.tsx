import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useClubsApi, type Club } from "../clubs/clubsApi";
import { useSwimmerAssignmentApi, type SwimmerForBulkAssign, type BulkAssignSummary } from "./assignmentApi";
import { useSort, sortItems, SortableTh } from "../../shared/sortableTable";
import { traerTodasLasPaginas } from "../../shared/paginacion";

const NONE_FILTER = "none";

export function BulkSwimmerAssignmentPage() {
  const navigate = useNavigate();
  const clubsApi = useClubsApi();
  const api = useSwimmerAssignmentApi();

  const [clubs, setClubs] = useState<Club[]>([]);
  const [sourceClubFilter, setSourceClubFilter] = useState(NONE_FILTER);
  const [search, setSearch] = useState("");
  const [swimmers, setSwimmers] = useState<SwimmerForBulkAssign[]>([]);
  const { sortKey, sortDir, onSort } = useSort<"fullName" | "run">();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [targetClubId, setTargetClubId] = useState("");

  const [loadingSwimmers, setLoadingSwimmers] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [summary, setSummary] = useState<BulkAssignSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    traerTodasLasPaginas((page, pageSize) => clubsApi.list({ status: "active", page, pageSize }))
      .then(setClubs)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los clubes"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setSelectedIds([]);
    setSummary(null);
    setLoadingSwimmers(true);
    setError(null);
    api
      .listSwimmersByClub(sourceClubFilter, search || undefined)
      .then(setSwimmers)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los nadadores"))
      .finally(() => setLoadingSwimmers(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceClubFilter, search]);

  function toggleSwimmer(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.length === swimmers.length ? [] : swimmers.map((s) => s.id)));
  }

  async function handleAssign() {
    if (!targetClubId || selectedIds.length === 0) return;
    setError(null);
    setSummary(null);
    setAssigning(true);
    try {
      const result = await api.bulkAssign(targetClubId, selectedIds);
      setSummary(result);
      setSelectedIds([]);
      // Recarga la lista con el mismo filtro — los recién asignados ya no deberían aparecer si el filtro de origen es distinto al destino.
      const refreshed = await api.listSwimmersByClub(sourceClubFilter, search || undefined);
      setSwimmers(refreshed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo asignar a los nadadores");
    } finally {
      setAssigning(false);
    }
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ color: "var(--brand-navy)" }}>Asignación masiva de nadadores</h1>
        <button className="btn-secondary" onClick={() => navigate("/asignaciones")}>Volver a asignaciones</button>
      </div>
      <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
        Filtre nadadores por su club actual (o "Sin club" para los que todavía no tienen ninguno), selecciónelos, y asígnelos todos de una vez a un
        club destino. Cada nadador queda activo de inmediato, sin pasar por aprobación.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", maxWidth: 800, marginTop: "1rem" }}>
        <div>
          <label>Filtrar por club actual</label>
          <select value={sourceClubFilter} onChange={(e) => setSourceClubFilter(e.target.value)}>
            <option value={NONE_FILTER}>Sin club</option>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label>Buscar por nombre o RUN (opcional)</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar..." />
        </div>
      </div>

      {error && <p className="error-message">{error}</p>}

      <div style={{ marginTop: "1rem" }}>
        {loadingSwimmers ? (
          <p style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)" }}>Cargando nadadores...</p>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
                {swimmers.length} nadador(es) {sourceClubFilter === NONE_FILTER ? "sin club" : `en el club filtrado`} — {selectedIds.length} seleccionado(s)
              </span>
              {swimmers.length > 0 && (
                <button className="btn-secondary" onClick={toggleSelectAll}>
                  {selectedIds.length === swimmers.length ? "Deseleccionar todos" : "Seleccionar todos"}
                </button>
              )}
            </div>
            <table className="data-table">
              <thead><tr>
                <th></th>
                <SortableTh label="Nadador" sortKey="fullName" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="RUN" sortKey="run" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
              </tr></thead>
              <tbody>
                {sortItems(swimmers, sortKey, sortDir, (s, key) => s[key]).map((s) => (
                  <tr key={s.id}>
                    <td><input type="checkbox" style={{ width: "auto" }} checked={selectedIds.includes(s.id)} onChange={() => toggleSwimmer(s.id)} /></td>
                    <td>{s.fullName}</td>
                    <td>{s.run}</td>
                  </tr>
                ))}
                {swimmers.length === 0 && (
                  <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1rem" }}>Sin nadadores para este filtro.</td></tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div style={{ marginTop: "1.5rem", maxWidth: 400 }}>
        <label>Club de destino</label>
        <select value={targetClubId} onChange={(e) => setTargetClubId(e.target.value)}>
          <option value="">Seleccionar...</option>
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn-primary" style={{ marginTop: "0.75rem" }} onClick={handleAssign} disabled={!targetClubId || selectedIds.length === 0 || assigning}>
          {assigning ? "Asignando..." : `Asignar ${selectedIds.length || ""} nadador(es) seleccionado(s)`}
        </button>
      </div>

      {summary && (
        <div style={{ marginTop: "2rem" }}>
          <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Resultado</h2>
          <p style={{ fontSize: "0.9rem" }}>
            {summary.totalCount} nadador(es) procesado(s) — <span style={{ color: "var(--state-success)" }}>{summary.assignedCount} asignado(s)</span>
            {summary.errorCount > 0 && <> — <span style={{ color: "var(--state-danger)" }}>{summary.errorCount} con error</span></>}
          </p>
          <table className="data-table" style={{ marginTop: "0.5rem" }}>
            <thead><tr><th>Nadador</th><th>Estado</th><th>Detalle</th></tr></thead>
            <tbody>
              {summary.results.map((r) => (
                <tr key={r.personId}>
                  <td>{r.fullName}</td>
                  <td>
                    <span className={`badge ${r.status === "assigned" ? "badge-active" : "badge-disabled"}`}>
                      {r.status === "assigned" ? "Asignado" : "Error"}
                    </span>
                  </td>
                  <td>{r.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
