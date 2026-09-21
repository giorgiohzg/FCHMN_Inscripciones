import { Fragment, useEffect, useState, useCallback } from "react";
import { AppShell } from "../../shared/AppShell";
import { useAuditApi, type AuditLogEntry } from "./auditApi";
import { useSort, sortItems, SortableTh } from "../../shared/sortableTable";

const ACTION_BADGE: Record<string, string> = {
  LOGIN_FAILED: "badge-locked",
  USER_LOCKED: "badge-disabled",
  REFRESH_TOKEN_REUSE_DETECTED: "badge-disabled",
};

function badgeForAction(action: string): string {
  if (ACTION_BADGE[action]) return ACTION_BADGE[action];
  if (action.includes("DELETED") || action.includes("REJECTED") || action.includes("CANCELLED") || action.includes("DISABLED")) return "badge-disabled";
  if (action.includes("BLOCKED")) return "badge-locked";
  return "badge-active";
}

function ExpandableJson({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  if (value === null || value === undefined) return null;
  return (
    <div style={{ marginTop: "0.3rem" }}>
      <button className="btn-secondary" style={{ padding: "0.2rem 0.6rem", fontSize: "0.75rem" }} onClick={() => setOpen((v) => !v)}>
        {open ? "Ocultar" : "Ver"} {label}
      </button>
      {open && (
        <pre style={{ fontSize: "0.75rem", background: "var(--brand-bg)", padding: "0.5rem", borderRadius: 6, marginTop: "0.3rem", overflowX: "auto" }}>
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function AuditLogPage() {
  const api = useAuditApi();
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [actions, setActions] = useState<string[]>([]);

  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [data, setData] = useState<{ items: AuditLogEntry[]; total: number; page: number; pageSize: number } | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { sortKey, sortDir, onSort } = useSort<"createdAt" | "user" | "action" | "entityType" | "entityId" | "ipAddress">("createdAt", "desc");

  useEffect(() => {
    api.getFilters().then((r) => {
      setEntityTypes(r.entityTypes);
      setActions(r.actions);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(
        await api.list({
          entityType: entityType || undefined,
          action: action || undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          page,
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar el registro de auditoría");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, action, dateFrom, dateTo, page]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)" }}>Auditoría</h1>
      <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
        Registro de operaciones críticas del sistema: usuario, fecha/hora, IP, acción y valores anterior/nuevo.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "0.75rem", maxWidth: 1000, marginBottom: "1rem" }}>
        <div>
          <label>Entidad</label>
          <select value={entityType} onChange={(e) => { setPage(1); setEntityType(e.target.value); }}>
            <option value="">Todas</option>
            {entityTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label>Acción</label>
          <select value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }}>
            <option value="">Todas</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label>Desde</label>
          <input type="date" value={dateFrom} onChange={(e) => { setPage(1); setDateFrom(e.target.value); }} />
        </div>
        <div>
          <label>Hasta</label>
          <input type="date" value={dateTo} onChange={(e) => { setPage(1); setDateTo(e.target.value); }} />
        </div>
      </div>

      {error && <p className="error-message">{error}</p>}

      {data && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh label="Fecha/Hora" sortKey="createdAt" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Usuario" sortKey="user" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Acción" sortKey="action" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Entidad" sortKey="entityType" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="ID entidad" sortKey="entityId" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="IP" sortKey="ipAddress" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortItems(data.items, sortKey, sortDir, (log, key) => {
                switch (key) {
                  case "createdAt": return new Date(log.createdAt);
                  case "user": return log.user?.username ?? null;
                  case "action": return log.action;
                  case "entityType": return log.entityType;
                  case "entityId": return log.entityId;
                  case "ipAddress": return log.ipAddress;
                }
              }).map((log) => (
                <Fragment key={log.id}>
                  <tr>
                    <td>{new Date(log.createdAt).toLocaleString("es-CL")}</td>
                    <td>{log.user?.username ?? "—"}</td>
                    <td><span className={`badge ${badgeForAction(log.action)}`}>{log.action}</span></td>
                    <td>{log.entityType}</td>
                    <td style={{ fontSize: "0.75rem" }}>{log.entityId ?? "—"}</td>
                    <td>{log.ipAddress ?? "—"}</td>
                    <td>
                      <button className="btn-secondary" style={{ padding: "0.2rem 0.6rem" }} onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}>
                        {expandedId === log.id ? "Cerrar" : "Detalle"}
                      </button>
                    </td>
                  </tr>
                  {expandedId === log.id && (
                    <tr>
                      <td colSpan={7} style={{ background: "var(--brand-bg)" }}>
                        <ExpandableJson label="valor anterior" value={log.before} />
                        <ExpandableJson label="valor nuevo" value={log.after} />
                        {!log.before && !log.after && <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)" }}>Sin datos adicionales.</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {data.items.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1.5rem" }}>Sin registros para este filtro.</td></tr>
              )}
            </tbody>
          </table>

          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>{data.total} registro(s) — página {data.page}</span>
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
