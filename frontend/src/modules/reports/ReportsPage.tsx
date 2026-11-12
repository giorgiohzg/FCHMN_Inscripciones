import { useEffect, useRef, useState } from "react";
import { AppShell } from "../../shared/AppShell";
import { useAuth } from "../auth/AuthContext";
import { useCompetitionsApi, type Competition } from "../competitions/competitionsApi";
import { useClubsApi, type Club } from "../clubs/clubsApi";
import { useReportsApi, type OpcionClub, type RegistrationsReportResult, type ReportFilters } from "./reportsApi";
import { ReportesNav } from "./ReportesNav";
import { useSwimmerAssignmentApi } from "../swimmer-assignment/assignmentApi";
import { CircledNumber } from "../../shared/CircledNumber";
import { traerTodasLasPaginas } from "../../shared/paginacion";

export function ReportsPage() {
  const { user, hasRole, hasPermission } = useAuth();
  const competitionsApi = useCompetitionsApi();
  const clubsApi = useClubsApi();
  const assignmentApi = useSwimmerAssignmentApi();
  const api = useReportsApi();

  // Un nadador "puro" (sin club real de delegado/entrenador) ve su propio
  // club de la misma forma que en Inscripciones/Inscripciones de Relevo:
  // texto fijo, tomado de su propia membresía de nadador (no de `user.clubId`,
  // que para ellos siempre es null).
  // Administración ve también las competencias ocultas (prevalece si combina otros roles).
  const veCompetenciasOcultas = hasRole("admin");
  const isPureSwimmer = user?.ownerType === "person" && !hasRole("admin") && !user?.clubId;
  // Una cuenta de club, o un delegado/entrenador: el reporte se carga
  // filtrado directo a su propio club — el filtro se muestra como texto
  // fijo, no como desplegable (el servidor tampoco permite otro club).
  const isClubScoped = !hasRole("admin") && Boolean(user?.clubId);
  // Administración elige club entre los que tienen inscripciones confirmadas en la competencia.
  const esAdmin = hasRole("admin");

  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);
  /**
   * Opciones del selector de administración para la competencia elegida: `null` mientras se
   * cargan. Solo clubes con al menos una inscripción confirmada (individual o de relevo).
   */
  const [opcionesDeClub, setOpcionesDeClub] = useState<OpcionClub[] | null>([]);
  const [ownClubName, setOwnClubName] = useState<string | null>(null);

  const [competitionId, setCompetitionId] = useState("");
  const [clubId, setClubId] = useState("");

  const [result, setResult] = useState<RegistrationsReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  /**
   * Número de la consulta vigente del reporte. Cambiar la competencia o el club lo incrementa:
   * una respuesta que llegue después, de una selección anterior, se descarta.
   */
  const consultaVigente = useRef(0);

  function invalidarResultado() {
    consultaVigente.current++;
    setResult(null);
    setLoading(false);
  }

  function cambiarCompetencia(id: string) {
    setCompetitionId(id);
    setError(null);
    invalidarResultado();
    if (esAdmin) {
      // Sin competencia no hay opciones; con una, quedan pendientes hasta que respondan.
      setOpcionesDeClub(id ? null : []);
      if (!id) setClubId("");
    }
  }

  function cambiarClub(id: string) {
    setClubId(id);
    invalidarResultado();
  }

  useEffect(() => {
    // Selector de competencias. Las que la administración ocultó
    // (visibleInRegistrationPanels = false) solo se quitan del desplegable de quienes no son
    // administradores; no cambia ningún acceso ni regla. Para administración se OMITE el
    // parámetro (enviar false traería solo las ocultas). Depende del valor booleano, no de
    // una función, para recargar una sola vez si la sesión cambia de rol.
    let vigente = true;
    traerTodasLasPaginas((page, pageSize) =>
      competitionsApi.list({ ...(veCompetenciasOcultas ? {} : { visibleInRegistrationPanels: true }), page, pageSize })
    )
      .then((todas) => {
        if (vigente) setCompetitions(todas);
      })
      .catch((err) => {
        if (vigente) setError(err instanceof Error ? err.message : "No se pudieron cargar las competencias");
      });
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [veCompetenciasOcultas]);

  useEffect(() => {
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
    // Administración: las opciones dependen de la competencia (efecto siguiente).
    if (esAdmin) return;
    // Selector: sin todas las páginas, el club 101 no existía para el informe.
    traerTodasLasPaginas((page, pageSize) => clubsApi.list({ page, pageSize }))
      .then(setClubs)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los clubes"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!esAdmin || !competitionId) return;
    let vigente = true;
    api
      .getClubesConInscripciones(competitionId)
      .then(({ clubs: opciones }) => {
        if (!vigente) return; // respuesta tardía de una competencia anterior
        setOpcionesDeClub(opciones);
        // La selección se conserva solo si sigue siendo válida para esta competencia.
        setClubId((actual) => (opciones.some((c) => c.id === actual) ? actual : ""));
      })
      .catch((err) => {
        if (!vigente) return;
        setOpcionesDeClub([]);
        setClubId("");
        setError(err instanceof Error ? err.message : "No se pudieron cargar los clubes de la competencia");
      });
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [esAdmin, competitionId]);

  /** Mientras llegan las opciones de la competencia, el club elegido aún no está validado. */
  const cargandoClubes = esAdmin && Boolean(competitionId) && opcionesDeClub === null;
  const clubesDelSelector: { id: string; name: string }[] = esAdmin ? (opcionesDeClub ?? []) : clubs;

  const filters: ReportFilters | null = competitionId
    ? {
        competitionId,
        clubId: clubId || undefined,
      }
    : null;

  async function handleGenerate() {
    if (!filters || cargandoClubes) return;
    const consulta = ++consultaVigente.current;
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const informe = await api.getRegistrationsReport(filters);
      if (consulta === consultaVigente.current) setResult(informe);
    } catch (err) {
      if (consulta === consultaVigente.current) setError(err instanceof Error ? err.message : "No se pudo generar el reporte");
    } finally {
      if (consulta === consultaVigente.current) setLoading(false);
    }
  }

  async function handleExport(format: "csv" | "xlsx" | "pdf") {
    if (!filters || cargandoClubes) return;
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
    if (cargandoClubes) return;
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
      <ReportesNav />
      <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>Listado de nadadores inscritos, con filtros y exportación.</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "0.75rem", maxWidth: 900 }}>
        <div>
          <label>Competencia</label>
          <select value={competitionId} onChange={(e) => cambiarCompetencia(e.target.value)}>
            <option value="">Seleccionar...</option>
            {competitions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label>Club{isPureSwimmer || isClubScoped ? "" : " (opcional)"}</label>
          {isPureSwimmer || isClubScoped ? (
            <p style={{ fontSize: "0.9rem", padding: "0.45rem 0" }}>{ownClubName ?? "Cargando..."}</p>
          ) : (
            <select
              aria-label="Club"
              value={clubId}
              onChange={(e) => cambiarClub(e.target.value)}
              disabled={esAdmin && (!competitionId || cargandoClubes)}
            >
              <option value="">{cargandoClubes ? "Cargando clubes..." : "Todos"}</option>
              {clubesDelSelector.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
        <button className="btn-primary" onClick={handleGenerate} disabled={!competitionId || loading || cargandoClubes}>
          {loading ? "Generando..." : "Generar reporte"}
        </button>
        <button className="btn-secondary" onClick={() => handleExport("csv")} disabled={!competitionId || exporting !== null || cargandoClubes}>
          {exporting === "csv" ? "Exportando..." : "Exportar CSV"}
        </button>
        <button className="btn-secondary" onClick={() => handleExport("xlsx")} disabled={!competitionId || exporting !== null || cargandoClubes}>
          {exporting === "xlsx" ? "Exportando..." : "Exportar Excel"}
        </button>
        <button className="btn-secondary" onClick={() => handleExport("pdf")} disabled={!competitionId || exporting !== null || cargandoClubes}>
          {exporting === "pdf" ? "Exportando..." : "Exportar PDF"}
        </button>
        {/* Solo muestra u oculta: el servidor aplica el permiso y, para el personal de club, que sea SU club. */}
        {hasPermission("export:team-manager") && (
          <button className="btn-secondary" onClick={handleTeamManagerExport} disabled={!competitionId || exporting !== null || cargandoClubes}>
            {exporting === "hy3" ? "Generando..." : "Exportar a Team Manager (.zip)"}
          </button>
        )}
      </div>

      {hasRole("admin") && !clubId && (
        <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", marginTop: "0.4rem" }}>
          Para exportar a Team Manager, seleccione también un club arriba — el archivo .zip es por club.
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
                // Clave: el identificador interno de la persona; nunca el nombre (puede repetirse) ni el RUN.
                // TRANSICIÓN: con una API anterior, que aún no envía `personId`, se usa la posición dentro del club;
                // la lista no se reordena en pantalla, así que esa clave es estable mientras se muestra.
                <div key={s.personId ?? `posicion-${index}`} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--brand-gray-100)" }}>
                  {/* Una línea: número, nadador, edad, categoría, género. Sin RUN. */}
                  <div style={{ fontSize: "0.9rem" }}>
                    {index + 1}. <strong>{s.nombreCompleto}</strong> — {s.edad} años — {s.categoria} — {s.genero}
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
