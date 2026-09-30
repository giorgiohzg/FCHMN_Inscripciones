import { useEffect, useState } from "react";
import { AppShell } from "../../shared/AppShell";
import { useDashboardApi, type DashboardStats } from "./dashboardApi";
import { useSort, sortItems, SortableTh } from "../../shared/sortableTable";

const STATUS_LABELS: Record<string, string> = {
  draft: "Borrador", scheduled: "Programada", open: "Abierta",
  individual_closed: "Individuales cerradas", closed: "Cerrada", in_progress: "En ejecución", finished: "Finalizada", cancelled: "Cancelada",
};

/**
 * Tarjeta del resumen general: el NÚMERO arriba y el texto debajo, ambos
 * centrados.
 *
 * El orden importa para la lectura: en una fila de tarjetas, lo que se
 * compara de un vistazo son las cifras, así que van primero y alineadas
 * entre sí. La etiqueta explica la cifra que ya se leyó.
 *
 * `justifyContent: center` reparte el espacio sobrante cuando una etiqueta
 * ocupa dos líneas y otra una: sin él, las cifras de la misma fila quedarían
 * a distinta altura.
 */
function KpiCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div
      style={{
        background: "var(--brand-bg)",
        borderRadius: 8,
        padding: "1rem 1.25rem",
        flex: 1,
        minWidth: 160,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "2rem", fontWeight: 700, color: accent, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--brand-gray-600)", textTransform: "uppercase", marginTop: "0.3rem" }}>
        {label}
      </div>
    </div>
  );
}

export function AdminDashboardPage() {
  const api = useDashboardApi();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const { sortKey, sortDir, onSort } = useSort<"competitionName" | "status" | "individualCount" | "relayTeamsCount">();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getStats().then(setStats).catch((err) => setError(err instanceof Error ? err.message : "Error al cargar el dashboard"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)" }}>Panel de administración</h1>
      <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>Federación Chilena Máster de Natación — resumen general.</p>

      {error && <p className="error-message">{error}</p>}

      {stats && (
        <>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginTop: "1rem" }}>
            <KpiCard label="Clubes activos" value={stats.clubCount} accent="var(--brand-navy)" />
            <KpiCard label="Nadadores registrados" value={stats.swimmerCount} accent="var(--brand-blue-dark)" />
            <KpiCard label="Competencias activas" value={stats.activeCompetitionsCount} accent="var(--state-success)" />
            <KpiCard label="Con inscripciones abiertas" value={stats.openRegistrationsCount} accent="var(--state-warning)" />
          </div>

          <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)", marginTop: "2rem" }}>Nadadores inscritos por competencia</h2>
          <table className="data-table" style={{ marginTop: "0.5rem" }}>
            <thead>
              <tr>
                <SortableTh label="Competencia" sortKey="competitionName" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Estado" sortKey="status" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Inscripciones individuales" sortKey="individualCount" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Equipos de relevo" sortKey="relayTeamsCount" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {sortItems(stats.registrationsByCompetition, sortKey, sortDir, (c, key) => {
                switch (key) {
                  case "competitionName": return c.competitionName;
                  case "status": return STATUS_LABELS[c.status] ?? c.status;
                  case "individualCount": return c.individualCount;
                  case "relayTeamsCount": return c.relayTeamsCount;
                }
              }).map((c) => (
                <tr key={c.competitionId}>
                  <td>{c.competitionName}</td>
                  <td><span className="badge badge-active">{STATUS_LABELS[c.status] ?? c.status}</span></td>
                  <td>{c.individualCount}</td>
                  <td>{c.relayTeamsCount}</td>
                </tr>
              ))}
              {stats.registrationsByCompetition.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1.5rem" }}>No hay competencias activas en este momento.</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </AppShell>
  );
}
