import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useSwimmerAssignmentApi, type ClubSwimmerAssignment, type AssignmentStatus } from "./assignmentApi";
import { useSort, sortItems, SortableTh } from "../../shared/sortableTable";

const STATUS_LABELS: Record<AssignmentStatus, string> = { pending: "Pendiente", active: "Activo", rejected: "Rechazado", ended: "Finalizado" };
const STATUS_BADGE: Record<AssignmentStatus, string> = { pending: "badge-locked", active: "badge-active", rejected: "badge-disabled", ended: "badge-disabled" };

export function SwimmerAssignmentsPage() {
  const api = useSwimmerAssignmentApi();
  const [status, setStatus] = useState<AssignmentStatus | "">("pending");
  const [data, setData] = useState<{ items: ClubSwimmerAssignment[]; total: number; page: number; pageSize: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const { sortKey, sortDir, onSort } = useSort<"person" | "club" | "status">();

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.list({ status: (status || undefined) as AssignmentStatus | undefined, page });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar solicitudes");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, page]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleApprove(assignment: ClubSwimmerAssignment) {
    if (!window.confirm(`¿Aprobar a ${assignment.person.fullName} para el club ${assignment.club.name}?`)) return;
    try {
      await api.approve(assignment.id);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "No se pudo aprobar la solicitud");
    }
  }

  async function handleReject(assignment: ClubSwimmerAssignment) {
    const reason = window.prompt(`Motivo del rechazo para ${assignment.person.fullName} (opcional):`) ?? undefined;
    try {
      await api.reject(assignment.id, reason);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "No se pudo rechazar la solicitud");
    }
  }

  async function handleEnd(assignment: ClubSwimmerAssignment) {
    if (!window.confirm(`¿Finalizar la membresía de ${assignment.person.fullName} en ${assignment.club.name}?`)) return;
    try {
      await api.end(assignment.id);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "No se pudo finalizar la membresía");
    }
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ color: "var(--brand-navy)" }}>Asignación de Nadadores a Clubes</h1>
        <Link to="/asignaciones/masiva" className="btn-secondary" style={{ textDecoration: "none" }}>
          Asignación masiva
        </Link>
      </div>
      <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
        Las solicitudes propuestas por los clubes requieren aprobación del administrador antes de activarse.
      </p>

      <div style={{ marginBottom: "1rem" }}>
        <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value as AssignmentStatus | ""); }} style={{ maxWidth: 220 }}>
          <option value="pending">Pendientes</option>
          <option value="active">Activas</option>
          <option value="rejected">Rechazadas</option>
          <option value="ended">Finalizadas</option>
          <option value="">Todas</option>
        </select>
      </div>

      {error && <p className="error-message">{error}</p>}

      {data && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh label="Nadador" sortKey="person" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Club" sortKey="club" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Estado" sortKey="status" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {sortItems(data.items, sortKey, sortDir, (a, key) => {
                switch (key) {
                  case "person": return a.person.fullName;
                  case "club": return a.club.name;
                  case "status": return STATUS_LABELS[a.status];
                }
              }).map((a) => (
                <tr key={a.id}>
                  <td>{a.person.fullName} ({a.person.run})</td>
                  <td>{a.club.name}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[a.status]}`}>{STATUS_LABELS[a.status]}</span>
                  </td>
                  <td style={{ display: "flex", gap: "0.4rem" }}>
                    {a.status === "pending" && (
                      <>
                        <button className="btn-primary" onClick={() => handleApprove(a)} style={{ padding: "0.4rem 0.8rem" }}>
                          Aprobar
                        </button>
                        <button className="btn-secondary" onClick={() => handleReject(a)}>
                          Rechazar
                        </button>
                      </>
                    )}
                    {a.status === "active" && (
                      <button className="btn-danger" onClick={() => handleEnd(a)}>
                        Finalizar membresía
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1.5rem" }}>
                    No hay solicitudes en este estado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
              {data.total} solicitud(es) — página {data.page}
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
