import { useEffect, useRef, useState } from "react";
import { AppShell } from "../../shared/AppShell";
import { ApiError } from "../../shared/apiClient";
import { traerTodasLasPaginas } from "../../shared/paginacion";
import { useAuth } from "../auth/AuthContext";
import { useCompetitionsApi, type Competition } from "../competitions/competitionsApi";
import { useReportsApi, type ResumenPorClub } from "./reportsApi";
import { ReportesNav } from "./ReportesNav";

const numero = (n: number) => n.toLocaleString("es-CL");

const SOLO_ADMINISTRACION = "Este reporte es exclusivo de administración.";

/** Mensaje para el usuario: un 403 dice lo que significa, no el detalle técnico del servidor. */
function mensajeDeError(err: unknown, porOmision: string): string {
  if (err instanceof ApiError && err.status === 403) return SOLO_ADMINISTRACION;
  return err instanceof Error ? err.message : porOmision;
}

type EstadoExportacion = { generando: true } | { generando: false; error: string };

/**
 * Resumen de inscripciones por club (solo administración).
 *
 * El único filtro es la competencia. Las cifras llegan AGREGADAS del servidor
 * (`GET /reports/clubs-summary`): esta pantalla no recibe ni calcula nada a partir de datos
 * personales. Cada fila exporta el ZIP de Team Manager de su club con la exportación
 * existente, que conserva sus validaciones y su control de acceso en el servidor.
 */
export function ClubSummaryReportPage() {
  const { hasRole, hasPermission } = useAuth();
  const esAdmin = hasRole("admin");
  const competitionsApi = useCompetitionsApi();
  const api = useReportsApi();

  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [errorCompetencias, setErrorCompetencias] = useState<string | null>(null);
  const [competitionId, setCompetitionId] = useState("");

  const [resumen, setResumen] = useState<ResumenPorClub | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Estado de la exportación de CADA fila, por id de club: una fila no bloquea a las demás. */
  const [exportaciones, setExportaciones] = useState<Record<string, EstadoExportacion>>({});
  /**
   * Generación de la selección: sube en cada cambio de competencia, también al volver a una
   * ya vista (A → B → A). Comparar solo el id de la competencia no distingue ese regreso.
   */
  const generacionSeleccion = useRef(0);
  /** Última operación de exportación iniciada en cada fila, por id de club. */
  const operacionPorFila = useRef<Record<string, number>>({});
  const ultimaOperacion = useRef(0);

  useEffect(() => {
    if (!esAdmin) return;
    // Administración ve también las competencias ocultas: se omite el filtro de visibilidad.
    let vigente = true;
    traerTodasLasPaginas((page, pageSize) => competitionsApi.list({ page, pageSize }))
      .then((todas) => {
        if (vigente) setCompetitions(todas);
      })
      .catch((err) => {
        if (vigente) setErrorCompetencias(mensajeDeError(err, "No se pudieron cargar las competencias"));
      });
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [esAdmin]);

  function cambiarCompetencia(id: string) {
    generacionSeleccion.current += 1;
    operacionPorFila.current = {};
    setCompetitionId(id);
    // Al cambiar de competencia nada de lo anterior se muestra como si fuera de la nueva.
    setResumen(null);
    setError(null);
    setExportaciones({});
    setCargando(Boolean(id));
  }

  useEffect(() => {
    if (!esAdmin || !competitionId) return;
    let vigente = true;
    api
      .getResumenPorClub(competitionId)
      .then((r) => {
        if (vigente) setResumen(r);
      })
      .catch((err) => {
        if (vigente) setError(mensajeDeError(err, "No se pudo generar el resumen"));
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });
    // Una respuesta tardía de la competencia anterior se descarta.
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitionId, esAdmin]);

  async function exportar(clubId: string) {
    const competencia = competitionId;
    const generacion = generacionSeleccion.current;
    const operacion = ++ultimaOperacion.current;
    operacionPorFila.current[clubId] = operacion;
    setExportaciones((e) => ({ ...e, [clubId]: { generando: true } }));
    let resultado: EstadoExportacion | null = null;
    try {
      await api.downloadTeamManagerExport(competencia, clubId);
    } catch (err) {
      resultado = { generando: false, error: err instanceof Error ? err.message : "No se pudo generar el archivo para Team Manager" };
    }
    // Solo la operación vigente de ESTA fila, en la MISMA selección, actualiza su estado. Una
    // operación anterior (otra selección, aunque sea la misma competencia) no borra el
    // «Generando...» de la nueva ni le pone su error. Las demás filas no se ven afectadas.
    if (generacionSeleccion.current !== generacion || operacionPorFila.current[clubId] !== operacion) return;
    delete operacionPorFila.current[clubId];
    setExportaciones((e) => {
      const siguiente = { ...e };
      if (resultado) siguiente[clubId] = resultado;
      else delete siguiente[clubId];
      return siguiente;
    });
  }

  const puedeExportar = hasPermission("export:team-manager");

  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)" }}>Reportes</h1>
      <ReportesNav />

      {!esAdmin ? (
        // La ruta ya exige el rol; esto cubre el instante en que la sesión lo pierde.
        <p className="error-message" role="alert">{SOLO_ADMINISTRACION}</p>
      ) : (
        <>
          <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
            Resumen de inscripciones confirmadas por club: nadadores distintos por sexo, pruebas individuales y relevos.
          </p>

          <div style={{ maxWidth: 420 }}>
            <label htmlFor="resumen-competencia">Competencia</label>
            <select id="resumen-competencia" value={competitionId} onChange={(e) => cambiarCompetencia(e.target.value)}>
              <option value="">Seleccionar...</option>
              {competitions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {errorCompetencias && <p className="error-message">{errorCompetencias}</p>}

          {!competitionId && (
            <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem", marginTop: "1rem" }}>Seleccione una competencia para ver el resumen.</p>
          )}

          {cargando && (
            <p role="status" style={{ marginTop: "1rem" }}>
              Cargando resumen…
            </p>
          )}

          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}

          {resumen && resumen.competitionId === competitionId && (
            <section style={{ marginTop: "1.5rem" }} aria-label={`Resumen de ${resumen.competitionName}`}>
              <h2 style={{ fontSize: "1.2rem", color: "var(--brand-navy)" }}>{resumen.competitionName}</h2>

              {resumen.clubs.length === 0 ? (
                <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>La competencia no tiene inscripciones confirmadas.</p>
              ) : (
                // En pantallas angostas la tabla se desplaza dentro de su contenedor, sin ensanchar la página.
                <div style={{ overflowX: "auto", maxWidth: "100%" }}>
                  <table className="data-table" style={{ minWidth: 760 }}>
                    <thead>
                      <tr>
                        <th scope="col">Club</th>
                        <th scope="col" style={{ textAlign: "right" }}>Varones</th>
                        <th scope="col" style={{ textAlign: "right" }}>Damas</th>
                        <th scope="col" style={{ textAlign: "right" }}>Total nadadores</th>
                        <th scope="col" style={{ textAlign: "right" }}>Pruebas individuales</th>
                        <th scope="col" style={{ textAlign: "right" }}>Relevos</th>
                        <th scope="col" style={{ textAlign: "right" }}>Total pruebas</th>
                        {puedeExportar && <th scope="col">Team Manager</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {resumen.clubs.map((f) => {
                        const estado = exportaciones[f.clubId];
                        return (
                          // Clave: el id del club. Dos clubes pueden llamarse igual.
                          <tr key={f.clubId}>
                            <th scope="row" style={{ textAlign: "left", fontWeight: 600, background: "transparent", color: "inherit", textTransform: "none", letterSpacing: 0, fontSize: "0.9rem" }}>
                              {f.clubName}
                            </th>
                            <td style={{ textAlign: "right" }}>{numero(f.varones)}</td>
                            <td style={{ textAlign: "right" }}>{numero(f.damas)}</td>
                            <td style={{ textAlign: "right" }}>{numero(f.totalNadadores)}</td>
                            <td style={{ textAlign: "right" }}>{numero(f.pruebasIndividuales)}</td>
                            <td style={{ textAlign: "right" }}>{numero(f.relevos)}</td>
                            <td style={{ textAlign: "right" }}>{numero(f.totalPruebas)}</td>
                            {puedeExportar && (
                              <td>
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  onClick={() => void exportar(f.clubId)}
                                  disabled={estado?.generando === true}
                                  aria-label={`Exportar a Team Manager (.zip): ${f.clubName}`}
                                  style={{ whiteSpace: "nowrap" }}
                                >
                                  {estado?.generando ? "Generando..." : "Exportar a Team Manager (.zip)"}
                                </button>
                                {estado && !estado.generando && (
                                  <p className="error-message" role="alert" style={{ margin: "0.3rem 0 0", fontSize: "0.8rem" }}>
                                    {estado.error}
                                  </p>
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        {/* Sigue siendo encabezado de fila, pero sin el estilo de encabezado de columna (fondo azul, texto blanco). */}
                        <th scope="row" style={{ textAlign: "left", fontWeight: 600, background: "transparent", color: "inherit", textTransform: "none", letterSpacing: 0, fontSize: "0.9rem" }}>
                          Total
                        </th>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumen.totales.varones)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumen.totales.damas)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumen.totales.totalNadadores)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumen.totales.pruebasIndividuales)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumen.totales.relevos)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumen.totales.totalPruebas)}</td>
                        {puedeExportar && <td />}
                      </tr>
                    </tfoot>
                  </table>
                  <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", marginTop: "0.5rem" }}>
                    Cada nadador se cuenta una vez por club. Los totales suman las filas: quien compite por dos clubes cuenta en ambos.
                  </p>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}
