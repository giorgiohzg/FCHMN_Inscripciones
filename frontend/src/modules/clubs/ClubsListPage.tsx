import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useClubsApi, type Club, type AccountStatus } from "./clubsApi";
import { InlineEditableCell } from "../../shared/InlineEditableCell";
import { useSort, sortItems, SortableTh } from "../../shared/sortableTable";

const STATUS_LABELS: Record<AccountStatus, string> = { active: "Activo", locked: "Bloqueado", disabled: "Inhabilitado" };
const STATUS_BADGE: Record<AccountStatus, string> = { active: "badge-active", locked: "badge-locked", disabled: "badge-disabled" };

export function ClubsListPage() {
  const api = useClubsApi();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<AccountStatus | "">("");
  const [data, setData] = useState<{ items: Club[]; total: number; page: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const { sortKey, sortDir, onSort } = useSort<"name" | "code" | "rut" | "delegate" | "coach" | "status">();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.list({ search: search || undefined, status: (status || undefined) as AccountStatus | undefined, page }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar clubes");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status, page]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAction(action: "block" | "disable" | "reactivate" | "remove", club: Club) {
    const confirmMsg: Record<string, string> = {
      block: `¿Bloquear el club ${club.name}?`,
      disable: `¿Inhabilitar el club ${club.name}?`,
      reactivate: `¿Reactivar el club ${club.name}?`,
      remove: `¿Eliminar el club ${club.name}?`,
    };
    if (!window.confirm(confirmMsg[action])) return;
    try {
      if (action === "block") await api.block(club.id);
      if (action === "disable") await api.disable(club.id);
      if (action === "reactivate") await api.reactivate(club.id);
      if (action === "remove") await api.remove(club.id);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "No se pudo completar la acción");
    }
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h1 style={{ color: "var(--brand-navy)" }}>Clubes</h1>
        <Link to="/clubes/nuevo" className="btn-primary" style={{ textDecoration: "none" }}>
          + Nuevo club
        </Link>
      </div>

      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <input
          placeholder="Buscar por nombre, razón social o RUT..."
          value={search}
          onChange={(e) => { setPage(1); setSearch(e.target.value); }}
          style={{ maxWidth: 320 }}
        />
        <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value as AccountStatus | ""); }} style={{ maxWidth: 180 }}>
          <option value="">Todos los estados</option>
          <option value="active">Activo</option>
          <option value="locked">Bloqueado</option>
          <option value="disabled">Inhabilitado</option>
        </select>
      </div>

      {error && <p className="error-message">{error}</p>}
      {loading && <p>Cargando...</p>}

      {data && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh label="Club" sortKey="name" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Sigla" sortKey="code" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="RUT" sortKey="rut" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Delegado(a)" sortKey="delegate" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Entrenador(a)" sortKey="coach" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Estado" sortKey="status" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {sortItems(data.items, sortKey, sortDir, (c, key) => {
                switch (key) {
                  case "name": return c.name;
                  case "code": return c.code;
                  case "rut": return c.rut;
                  case "delegate": return c.staff.filter((s) => s.roleType === "delegate").map((s) => s.person.fullName).join(", ") || null;
                  case "coach": return c.staff.filter((s) => s.roleType === "coach").map((s) => s.person.fullName).join(", ") || null;
                  case "status": return STATUS_LABELS[c.status];
                }
              }).map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/clubes/${c.id}`}>{c.name}</Link>
                  </td>
                  <td>
                    <InlineEditableCell
                      value={c.code}
                      onSave={async (v) => {
                        if (!v.trim()) throw new Error("La sigla no puede quedar vacía");
                        await api.update(c.id, { code: v.trim().toUpperCase() });
                        load();
                      }}
                    />
                  </td>
                  <td>{c.rut ? c.rut : <span style={{ color: "var(--brand-gray-600)" }}>Sin personalidad jurídica</span>}</td>
                  <td>{c.staff.filter((s) => s.roleType === "delegate").map((s) => s.person.fullName).join(", ") || "—"}</td>
                  <td>{c.staff.filter((s) => s.roleType === "coach").map((s) => s.person.fullName).join(", ") || "—"}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[c.status]}`}>{STATUS_LABELS[c.status]}</span>
                  </td>
                  <td style={{ display: "flex", gap: "0.4rem" }}>
                    {c.status === "active" && (
                      <button className="btn-secondary" onClick={() => handleAction("block", c)}>Bloquear</button>
                    )}
                    {c.status !== "disabled" && (
                      <button className="btn-secondary" onClick={() => handleAction("disable", c)}>Inhabilitar</button>
                    )}
                    {c.status !== "active" && (
                      <button className="btn-secondary" onClick={() => handleAction("reactivate", c)}>Reactivar</button>
                    )}
                    <button className="btn-danger" onClick={() => handleAction("remove", c)}>Eliminar</button>
                  </td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1.5rem" }}>
                    No se encontraron clubes con los filtros aplicados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
              {data.total} club(es) — página {data.page}
            </span>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</button>
              <button className="btn-secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage((p) => p + 1)}>Siguiente</button>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}
