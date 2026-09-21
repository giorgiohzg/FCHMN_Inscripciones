import { useEffect, useState } from "react";
import { AppShell } from "../../shared/AppShell";
import { useAuth } from "../auth/AuthContext";
import { useCompetitionsApi, type Competition } from "../competitions/competitionsApi";
import { useClubsApi, type Club } from "../clubs/clubsApi";
import { useReportsApi, type RegistrationsReportResult, type ReportFilters } from "./reportsApi";
import { useSwimmerAssignmentApi } from "../swimmer-assignment/assignmentApi";
import { CircledNumber } from "../../shared/CircledNumber";
import { traerTodasLasPaginas } from "../../shared/paginacion";

export function ReportsPage() {
  const { user, hasRole } = useAuth();
  const competitionsApi = useCompetitionsApi();
  const clubsApi = useClubsApi();
  const assignmentApi = useSwimmerAssignmentApi();
  const api = useReportsApi();

  // Un nadador "puro" (sin club real de delegado/entrenador) ve su propio
  // club de la misma forma que en Inscripciones/Inscripciones de Relevo:
  // texto fijo, tomado de su propia membresía de nadador (no de `user.clubId`,
  // que para ellos siempre es null).
  const isPureSwimmer = user?.ownerType === "person" && !hasRole("admin") && !user?.clubId;
  // Una cuenta de club, o un delegado/entrenador: el reporte se carga
  // filtrado directo a su propio club — el filtro se muestra como texto
  // fijo, no como desplegable (el servidor tampoco permite otro club).
  const isClubScoped = !hasRole("admin") && Boolean(user?.clubId);

  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [ownClubName, setOwnClubName] = useState<string | null>(null);

  const [competitionId, setCompetitionId] = useState("");
  const [clubId, setClubId] = useState("");

  const [result, setResult] = useState<RegistrationsReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  useEffect(() => {
    /**
     * Selector de competencias: sin recorrer las páginas llegaban solo las 20
     * primeras (el `pageSize` por omisión del backend), así que una competencia
     * antigua simplemente no se podía elegir para el informe.
     */
    traerTodasLasPaginas((page, pageSize) => competitionsApi.list({ page, pageSize }))
      .then(setCompetitions)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar las competencias"));

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
            }
          })
          .catch((err) => setError(err instanceof Error ? err.message : "No se pudo determinar su club"));
      }
      return;
    }

    if (isClubScoped) {
      setClubId(user!.clubId!);
      clubsApi
        .get(user!.clubId!)
        .then((c) => setOwnClubName(c.name))
        .catch((err) => setError(err instanceof Error ? err.message : "No se pudo cargar el club"));
      return;
    }
    // Selector: sin todas las páginas, el club 101 no existía para el informe.
    traerTodasLasPaginas((page, pageSize) => clubsApi.list({ page, pageSize }))
      .then(setClubs)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los clubes"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filters: ReportFilters | null = competitionId
    ? {
        competitionId,
        clubId: clubId || undefined,
      }
    : null;

  async function handleGenerate() {
    if (!filters) return;
    setError(null);
    setLoading(true);
    try {
      setResult(await api.getRegistrationsReport(filters));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el reporte");
    } finally {
      setLoading(false);
    }
  }

  async function handleExport(format: "csv" | "xlsx" | "pdf") {
    if (!filters) return;
    setExporting(format);
    setError(null);
    try {
      await api.downloadExport(filters, format);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo exportar el reporte");
    } finally {
      setExporting(null);
    }
  }

  async function handleTeamManagerExport() {
    if (!competitionId || !clubId) {
      setError("Para exportar a Team Manager debe seleccionar competencia Y club (un archivo es por club).");
      return;
    }
    setExporting("hy3");
    setError(null);
    try {
      await api.downloadTeamManagerExport(competitionId, clubId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el archivo para Team Manager");
    } finally {
      setExporting(null);
    }
  }

  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)" }}>Reportes</h1>
      <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>Listado de nadadores inscritos, con filtros y exportación.</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "0.75rem", maxWidth: 900 }}>
        <div>
          <label>Competencia</label>
          <select value={competitionId} onChange={(e) => setCompetitionId(e.target.value)}>
            <option value="">Seleccionar...</option>
            {competitions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label>Club{isPureSwimmer || isClubScoped ? "" : " (opcional)"}</label>
          {isPureSwimmer || isClubScoped ? (
            <p style={{ fontSize: "0.9rem", padding: "0.45rem 0" }}>{ownClubName ?? "Cargando..."}</p>
          ) : (
            <select value={clubId} onChange={(e) => setClubId(e.target.value)}>
              <option value="">Todos</option>
              {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
        <button className="btn-primary" onClick={handleGenerate} disabled={!competitionId || loading}>
          {loading ? "Generando..." : "Generar reporte"}
        </button>
        <button className="btn-secondary" onClick={() => handleExport("csv")} disabled={!competitionId || exporting !== null}>
          {exporting === "csv" ? "Exportando..." : "Exportar CSV"}
        </button>
        <button className="btn-secondary" onClick={() => handleExport("xlsx")} disabled={!competitionId || exporting !== null}>
          {exporting === "xlsx" ? "Exportando..." : "Exportar Excel"}
        </button>
        <button className="btn-secondary" onClick={() => handleExport("pdf")} disabled={!competitionId || exporting !== null}>
          {exporting === "pdf" ? "Exportando..." : "Exportar PDF"}
        </button>
        {hasRole("admin") && (
          <button className="btn-secondary" onClick={handleTeamManagerExport} disabled={!competitionId || exporting !== null}>
            {exporting === "hy3" ? "Generando..." : "Exportar a Team Manager (.HY3)"}
          </button>
        )}
      </div>

      {hasRole("admin") && !clubId && (
        <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", marginTop: "0.4rem" }}>
          Para exportar a Team Manager, seleccione también un club arriba — el archivo .HY3 es por club.
        </p>
      )}

      {error && <p className="error-message">{error}</p>}

      {result && (
        <div style={{ marginTop: "2rem" }}>
          {/* Título: competencia seleccionada */}
          <h1 style={{ fontSize: "1.3rem", color: "var(--brand-navy)" }}>{result.competitionName}</h1>

          {result.groupedByClub.length === 0 && (
            <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>Sin inscripciones para estos filtros.</p>
          )}

          {result.groupedByClub.map((club) => (
            <div key={club.clubName} style={{ marginTop: "1.25rem" }}>
              {/* Subtítulo: club, con los totales entre paréntesis sin negrita */}
              <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)", borderBottom: "1px solid var(--brand-gray-100)", paddingBottom: "0.3rem" }}>
                <strong>{club.clubName}</strong>{" "}
                <span style={{ fontWeight: 400, fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
                  ({club.totalNadadores} nadadores, {club.totalPruebasIndividuales} pruebas individuales, {club.totalRelevos} relevos)
                </span>
              </h2>
              {club.swimmers.map((s, index) => (
                <div key={s.run} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--brand-gray-100)" }}>
                  {/* Una línea: número, nadador (RUN), edad, categoría, género */}
                  <div style={{ fontSize: "0.9rem" }}>
                    {index + 1}. <strong>{s.nombreCompleto}</strong> ({s.run}) — {s.edad} años — {s.categoria} — {s.genero}
                  </div>
                  {/* Pruebas individuales y relevos en los que está inscrito — con sangría hacia la derecha */}
                  <div style={{ fontSize: "0.82rem", color: "var(--brand-gray-600)", marginTop: "0.15rem", paddingLeft: "1.5rem" }}>
                    {s.pruebas.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.4rem", marginBottom: "0.25rem" }}>
                        {s.pruebas.map((p, i) => (
                          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                            <CircledNumber n={p.number} size={16} />
                            {p.text}
                          </span>
                        ))}
                      </div>
                    )}
                    {s.relevos.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.4rem" }}>
                        {s.relevos.map((r, i) => (
                          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                            <CircledNumber n={r.number} size={16} />
                            {r.text}
                          </span>
                        ))}
                      </div>
                    )}
                    {s.pruebas.length === 0 && s.relevos.length === 0 && <div>Sin pruebas ni relevos.</div>}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
