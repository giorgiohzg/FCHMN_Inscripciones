import { useEffect, useRef, useState } from "react";
import { AppShell } from "../../shared/AppShell";
import { ApiError } from "../../shared/apiClient";
import { traerTodasLasPaginas } from "../../shared/paginacion";
import { competenciaPreseleccionada } from "../../shared/competenciaPredeterminada";
import { useAuth } from "../auth/AuthContext";
import { useCompetitionsApi, type Competition } from "../competitions/competitionsApi";
import { useReportsApi, type ResumenPorClub } from "./reportsApi";
import { ReportesNav } from "./ReportesNav";

const numero = (n: number) => n.toLocaleString("es-CL");

const SOLO_ADMINISTRACION = "Este reporte es exclusivo de administración.";

/** Valor inicial del campo «Edad mínima». */
const EDAD_MINIMA_INICIAL = 70;
/** Mismos límites que el servidor (`resumenPorClubQuerySchema`). */
const EDAD_MINIMA_MAXIMA = 150;
const MENSAJE_EDAD_MINIMA = `Ingrese un número entero entre 0 y ${EDAD_MINIMA_MAXIMA}.`;

/**
 * La edad mínima del campo, o `null` si no es válida: con el mismo criterio que el servidor
 * (solo dígitos, sin ceros a la izquierda, de 0 a 150), para no pedir nunca una consulta que
 * rechazaría. Un campo numérico con texto no numérico entrega "": también es `null`.
 */
function leerEdadMinima(texto: string): number | null {
  if (!/^(0|[1-9][0-9]{0,2})$/.test(texto)) return null;
  const edad = Number(texto);
  return edad <= EDAD_MINIMA_MAXIMA ? edad : null;
}

/** Mensaje para el usuario: un 403 dice lo que significa, no el detalle técnico del servidor. */
function mensajeDeError(err: unknown, porOmision: string): string {
  if (err instanceof ApiError && err.status === 403) return SOLO_ADMINISTRACION;
  return err instanceof Error ? err.message : porOmision;
}

type EstadoExportacion = { generando: true } | { generando: false; error: string };

/** Error de la consulta del resumen. Un 403 no se ofrece reintentar: no cambiaría nada. */
type ErrorResumen = { mensaje: string; reintentable: boolean };

/**
 * Resumen de inscripciones por club (solo administración).
 *
 * Se elige la competencia y la «Edad mínima» (70 al inicio). La edad mínima solo cambia la
 * columna de edad: las demás cifras, los clubes listados y la exportación no dependen de ella.
 * Escribir en el campo no consulta nada: la edad se confirma con «Aplicar» o Enter, y mientras
 * tanto se conservan los últimos resultados, identificados por la edad que informó el servidor.
 * La edad se mide a la fecha de corte de la competencia, que la calcula el servidor. Las cifras
 * llegan AGREGADAS del servidor
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
  /** Espejo de `competitionId`, para decidir la preselección al llegar la lista. */
  const competenciaActual = useRef("");
  /**
   * La persona ya eligió a mano (también «Seleccionar...»): desde entonces la competencia por
   * defecto no se vuelve a aplicar, aunque la lista llegue o se recargue después.
   */
  const eleccionManual = useRef(false);
  /** Lo que se está escribiendo. No consulta nada hasta «Aplicar» o Enter. */
  const [edadTexto, setEdadTexto] = useState(String(EDAD_MINIMA_INICIAL));
  const edadEscrita = leerEdadMinima(edadTexto);
  /** Edad CONFIRMADA: la única que se pide al servidor. Siempre válida. */
  const [edadAplicada, setEdadAplicada] = useState(EDAD_MINIMA_INICIAL);
  /** Sube con cada «Aplicar» o «Reintentar»: vuelve a pedir aunque la combinación no cambie. */
  const [solicitud, setSolicitud] = useState(0);

  const [resumen, setResumen] = useState<ResumenPorClub | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<ErrorResumen | null>(null);

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

  /** TODA selección de competencia pasa por aquí: la manual y la preselección. */
  function cambiarCompetencia(id: string) {
    competenciaActual.current = id;
    generacionSeleccion.current += 1;
    operacionPorFila.current = {};
    setCompetitionId(id);
    // Al cambiar de competencia nada de lo anterior se muestra como si fuera de la nueva.
    setResumen(null);
    setError(null);
    setExportaciones({});
    // La competencia nueva se consulta con la edad YA APLICADA, aunque haya un cambio sin aplicar.
    setCargando(Boolean(id));
  }

  function elegirCompetencia(id: string) {
    eleccionManual.current = true;
    cambiarCompetencia(id);
  }

  useEffect(() => {
    if (!esAdmin) return;
    // Administración ve también las competencias ocultas: se omite el filtro de visibilidad.
    let vigente = true;
    traerTodasLasPaginas((page, pageSize) => competitionsApi.list({ page, pageSize }))
      .then((todas) => {
        if (!vigente) return;
        setCompetitions(todas);
        // Competencia por defecto, con el criterio de Inscripción y Relevos (ver
        // `competenciaPreseleccionada`). Pasa por `cambiarCompetencia`, como una elección normal:
        // nueva generación de la selección, exportaciones por fila reiniciadas y la misma carga.
        const { competitionId: siguiente, invalidada } = competenciaPreseleccionada(todas, competenciaActual.current, eleccionManual.current);
        if (invalidada) eleccionManual.current = true;
        if (siguiente !== competenciaActual.current) cambiarCompetencia(siguiente);
      })
      .catch((err) => {
        if (vigente) setErrorCompetencias(mensajeDeError(err, "No se pudieron cargar las competencias"));
      });
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [esAdmin]);

  /** Vuelve a pedir el resumen con la competencia y la edad aplicadas (también para reintentar). */
  function pedirDeNuevo() {
    setSolicitud((n) => n + 1);
    if (competitionId) {
      setCargando(true);
      setError(null);
    }
  }

  /**
   * Confirma la edad escrita. Un valor inválido no se aplica (su validación ya está a la vista),
   * y aplicar la misma edad que ya está a la vista no consulta de nuevo. NO retira la tabla ni
   * toca las exportaciones: son de la misma competencia y no dependen de la edad.
   */
  function aplicarEdad() {
    if (edadEscrita === null) return;
    const yaVigente = edadEscrita === edadAplicada && !error && !cargando && (!competitionId || resumen?.edadMinima === edadEscrita);
    if (yaVigente) return;
    setEdadAplicada(edadEscrita);
    pedirDeNuevo();
  }

  useEffect(() => {
    if (!esAdmin || !competitionId) return;
    let vigente = true;
    api
      .getResumenPorClub(competitionId, edadAplicada)
      .then((r) => {
        if (vigente) setResumen(r);
      })
      .catch((err) => {
        // Se conservan los resultados anteriores de la MISMA competencia, identificados como tales.
        if (vigente)
          setError({
            mensaje: mensajeDeError(err, "No se pudo generar el resumen"),
            reintentable: !(err instanceof ApiError && err.status === 403),
          });
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });
    // Una respuesta tardía de otra combinación de competencia y edad mínima se descarta.
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitionId, edadAplicada, solicitud, esAdmin]);

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

  /** Último resultado de ESTA competencia (el de otra nunca se muestra). */
  const resumenVisible = resumen && resumen.competitionId === competitionId ? resumen : null;
  /** El resultado a la vista es de otra edad que la aplicada: se está recalculando o falló. */
  const resultadoDeOtraEdad = resumenVisible !== null && resumenVisible.edadMinima !== edadAplicada;
  const cambioSinAplicar = edadTexto !== String(edadAplicada);

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
            Resumen de inscripciones confirmadas por club: nadadores distintos por sexo, nadadores con la edad mínima elegida o más, pruebas individuales y relevos.
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 260px", maxWidth: 420 }}>
              <label htmlFor="resumen-competencia">Competencia</label>
              <select id="resumen-competencia" value={competitionId} onChange={(e) => elegirCompetencia(e.target.value)}>
                <option value="">Seleccionar...</option>
                {competitions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            {/* Un formulario propio: Enter en el campo equivale a «Aplicar». noValidate: la validación es la de abajo. */}
            <form
              noValidate
              style={{ flex: "0 1 260px" }}
              onSubmit={(e) => {
                e.preventDefault();
                aplicarEdad();
              }}
            >
              <label htmlFor="resumen-edad-minima">Edad mínima</label>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "stretch" }}>
                <input
                  id="resumen-edad-minima"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={EDAD_MINIMA_MAXIMA}
                  step={1}
                  value={edadTexto}
                  onChange={(e) => setEdadTexto(e.target.value)}
                  aria-invalid={edadEscrita === null}
                  aria-describedby="resumen-edad-minima-ayuda"
                  style={{ flex: "1 1 auto", minWidth: 0 }}
                />
                <button type="submit" className="btn-secondary" style={{ whiteSpace: "nowrap" }}>
                  Aplicar
                </button>
              </div>
              {edadEscrita === null ? (
                <p id="resumen-edad-minima-ayuda" className="error-message" role="alert" style={{ margin: "0.3rem 0 0", fontSize: "0.8rem" }}>
                  {MENSAJE_EDAD_MINIMA} No se aplica: se mantiene {edadAplicada}.
                </p>
              ) : cambioSinAplicar ? (
                <p id="resumen-edad-minima-ayuda" aria-live="polite" style={{ color: "var(--brand-navy)", fontWeight: 600, fontSize: "0.8rem", margin: "0.3rem 0 0" }}>
                  Cambio sin aplicar: se mantiene {edadAplicada}. Pulse «Aplicar» o Enter.
                </p>
              ) : (
                <p id="resumen-edad-minima-ayuda" style={{ color: "var(--brand-gray-600)", fontSize: "0.8rem", margin: "0.3rem 0 0" }}>
                  Años cumplidos a la fecha de corte de la competencia. Solo cambia esa columna.
                </p>
              )}
            </form>
          </div>

          {errorCompetencias && <p className="error-message">{errorCompetencias}</p>}

          {!competitionId && (
            <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem", marginTop: "1rem" }}>Seleccione una competencia para ver el resumen.</p>
          )}

          {cargando && (
            <p role="status" style={{ marginTop: "1rem" }}>
              {resumenVisible
                ? `Recalculando con ${edadAplicada} años o más… La tabla muestra todavía los resultados de ${resumenVisible.edadMinima} años o más.`
                : "Cargando resumen…"}
            </p>
          )}

          {error && (
            <p className="error-message" role="alert">
              {resultadoDeOtraEdad
                ? `No se pudo actualizar a ${edadAplicada} años o más (${error.mensaje}). La tabla muestra los resultados de ${resumenVisible.edadMinima} años o más.`
                : error.mensaje}
              {error.reintentable && (
                <>
                  {" "}
                  <button type="button" className="btn-secondary" onClick={pedirDeNuevo} style={{ marginLeft: "0.5rem" }}>
                    Reintentar
                  </button>
                </>
              )}
            </p>
          )}

          {resultadoDeOtraEdad && !cargando && !error && (
            <p className="error-message" role="alert">
              Estos resultados son de {resumenVisible.edadMinima} años o más, no de la edad aplicada ({edadAplicada}).
            </p>
          )}

          {/*
            Solo resultados de ESTA competencia. El encabezado sale de la respuesta, no del campo. Al
            aplicar otra edad la sección NO se desmonta (se atenúa y queda marcada como ocupada): así
            se conserva el desplazamiento horizontal de la tabla.
          */}
          {resumenVisible && (
            <section
              style={{ marginTop: "1.5rem", opacity: resultadoDeOtraEdad ? 0.55 : 1, transition: "opacity 120ms" }}
              aria-label={`Resumen de ${resumenVisible.competitionName}`}
              aria-busy={cargando}
            >
              <h2 style={{ fontSize: "1.2rem", color: "var(--brand-navy)" }}>{resumenVisible.competitionName}</h2>

              {resumenVisible.clubs.length === 0 ? (
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
                        <th scope="col" style={{ textAlign: "right" }}>Nadadores de {resumenVisible.edadMinima} años o más</th>
                        <th scope="col" style={{ textAlign: "right" }}>Pruebas individuales</th>
                        <th scope="col" style={{ textAlign: "right" }}>Relevos</th>
                        <th scope="col" style={{ textAlign: "right" }}>Total pruebas</th>
                        {puedeExportar && <th scope="col">Team Manager</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {resumenVisible.clubs.map((f) => {
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
                            <td style={{ textAlign: "right" }}>{numero(f.nadadoresConEdadMinima)}</td>
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
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumenVisible.totales.varones)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumenVisible.totales.damas)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumenVisible.totales.totalNadadores)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumenVisible.totales.nadadoresConEdadMinima)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumenVisible.totales.pruebasIndividuales)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumenVisible.totales.relevos)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{numero(resumenVisible.totales.totalPruebas)}</td>
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
