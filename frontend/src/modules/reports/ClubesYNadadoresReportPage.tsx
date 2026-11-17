import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "../../shared/AppShell";
import { ApiError } from "../../shared/apiClient";
import { useReportsApi, type ReporteClubesYNadadores } from "./reportsApi";
import { ReportesNav } from "./ReportesNav";

const numero = (n: number) => n.toLocaleString("es-CL");
const SOLO_ADMINISTRACION = "Este reporte es exclusivo de administración.";
const ESTADO_DEL_CLUB: Record<"locked" | "disabled", string> = { locked: "bloqueado", disabled: "inhabilitado" };

type Formato = "csv" | "xlsx" | "pdf";

/**
 * Reporte GENERAL «Clubes y nadadores» (solo administración).
 *
 * Es independiente de las competencias: no pide ni consulta ninguna. Muestra la pertenencia
 * VIGENTE: cada club no eliminado (también los que no tienen nadadores), por nombre, con sus
 * nadadores actuales ordenados por apellido paterno, materno y nombre. Luego, si las hay, una
 * sección de REVISIÓN con las personas cuya membresía activa es de un club eliminado (no se
 * reclasifican ni se repara nada desde aquí). Y SIEMPRE como última sección, «Sin club asignado»,
 * con el mismo criterio que la asignación masiva (todas las personas activas sin membresía activa,
 * también personal de club sin membresía). Es el mismo orden de CSV, Excel y PDF (`gruposEnOrden`
 * en el servidor). Grupos, orden y nombres los arma el servidor; esta pantalla solo los presenta. CSV, Excel y PDF se generan en el servidor con el
 * reporte COMPLETO, no con lo que esté a la vista.
 */
export function ClubesYNadadoresReportPage() {
  const api = useReportsApi();
  const [reporte, setReporte] = useState<ReporteClubesYNadadores | null>(null);
  const [error, setError] = useState<{ mensaje: string; reintentable: boolean } | null>(null);
  const [cargando, setCargando] = useState(true);
  const [exportando, setExportando] = useState<Formato | null>(null);
  const [errorExportacion, setErrorExportacion] = useState<string | null>(null);
  const cargaVigente = useRef(0);

  const cargar = useCallback(() => {
    const n = ++cargaVigente.current;
    setCargando(true);
    setError(null);
    api
      .getClubesYNadadores()
      .then((r) => {
        if (n === cargaVigente.current) setReporte(r);
      })
      .catch((err: unknown) => {
        if (n !== cargaVigente.current) return;
        setReporte(null);
        const prohibido = err instanceof ApiError && err.status === 403;
        setError({
          mensaje: prohibido ? SOLO_ADMINISTRACION : err instanceof Error ? err.message : "No se pudo cargar el reporte",
          reintentable: !prohibido,
        });
      })
      .finally(() => {
        if (n === cargaVigente.current) setCargando(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function exportar(formato: Formato) {
    if (exportando) return;
    setExportando(formato);
    setErrorExportacion(null);
    try {
      await api.downloadClubesYNadadores(formato);
    } catch (err) {
      setErrorExportacion(
        err instanceof ApiError && err.status === 403
          ? SOLO_ADMINISTRACION
          : err instanceof Error
            ? err.message
            : "No se pudo exportar el reporte"
      );
    } finally {
      setExportando(null);
    }
  }

  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)" }}>Reportes</h1>
      <ReportesNav />
      <h2 style={{ fontSize: "1.15rem", color: "var(--brand-navy)", margin: "0 0 0.25rem" }}>Clubes y nadadores</h2>
      <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem", marginTop: 0 }}>
        Pertenencia vigente, sin relación con ninguna competencia: cada club con sus nadadores actuales (membresía activa) y, al final, las
        personas sin club asignado. No incluye solicitudes pendientes ni historial. El personal de un club no figura en ese club por ser
        personal; si no tiene membresía activa, figura en «Sin club asignado».
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", margin: "0.75rem 0" }}>
        {(["csv", "xlsx", "pdf"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className="btn-secondary"
            onClick={() => void exportar(f)}
            disabled={exportando !== null || !reporte}
          >
            {exportando === f ? "Exportando…" : `Exportar ${f === "xlsx" ? "Excel" : f.toUpperCase()}`}
          </button>
        ))}
      </div>
      {errorExportacion && (
        <p className="error-message" role="alert">
          {errorExportacion}
        </p>
      )}

      {cargando && <p role="status">Cargando reporte…</p>}
      {error && (
        <p className="error-message" role="alert">
          {error.mensaje}{" "}
          {error.reintentable && (
            <button type="button" className="btn-secondary" onClick={cargar} style={{ padding: "0.15rem 0.5rem", fontSize: "0.8rem" }}>
              Reintentar
            </button>
          )}
        </p>
      )}

      {reporte && (
        <>
          <p style={{ fontSize: "0.9rem" }}>
            {numero(reporte.totales.clubes)} club(es) · {numero(reporte.totales.nadadoresConClub)} nadador(es) con club ·{" "}
            {numero(reporte.totales.sinClub)} sin club asignado · {numero(reporte.totales.enClubesEliminados)} con membresía activa en un
            club eliminado (revisión)
          </p>

          {reporte.clubes.map((c) => (
            <section key={c.clubId} className="grupo-reporte" aria-labelledby={`club-${c.clubId}`}>
              <h3 id={`club-${c.clubId}`} className="grupo-reporte-titulo">
                <span>
                  {c.clubName} <span className="grupo-reporte-sigla">({c.sigla})</span>
                  {c.estado !== "active" && <span className="grupo-reporte-sigla"> · club {ESTADO_DEL_CLUB[c.estado]}</span>}
                </span>
                <span className="grupo-reporte-cuenta">{numero(c.nadadores.length)} nadador(es)</span>
              </h3>
              {c.nadadores.length === 0 ? (
                <p className="grupo-reporte-vacio">Sin nadadores.</p>
              ) : (
                <ol className="grupo-reporte-lista">
                  {c.nadadores.map((n) => (
                    <li key={n.personId}>{n.nombre}</li>
                  ))}
                </ol>
              )}
            </section>
          ))}

          {reporte.revision.length > 0 && (
            <section className="grupo-reporte grupo-reporte-revision" aria-labelledby="revision-clubes-eliminados">
              <h3 id="revision-clubes-eliminados" className="grupo-reporte-titulo">
                <span>Revisión: membresía activa en un club eliminado</span>
                <span className="grupo-reporte-cuenta">{numero(reporte.totales.enClubesEliminados)} persona(s)</span>
              </h3>
              <p className="grupo-reporte-vacio" style={{ fontStyle: "normal" }}>
                Tienen una membresía activa en un club que fue eliminado: no se cuentan como «sin club». Este reporte no recupera el club ni
                finaliza membresías; revíselas en Asignación de Nadadores.
              </p>
              {reporte.revision.map((c) => (
                <div key={c.clubId} className="grupo-reporte-subgrupo">
                  <h4 className="grupo-reporte-subtitulo">
                    {c.clubName}{" "}
                    <span className="grupo-reporte-sigla">
                      ({c.sigla}) · club eliminado · {numero(c.personas.length)} persona(s)
                    </span>
                  </h4>
                  <ol className="grupo-reporte-lista">
                    {c.personas.map((n) => (
                      <li key={n.personId}>{n.nombre}</li>
                    ))}
                  </ol>
                </div>
              ))}
            </section>
          )}

          <section className="grupo-reporte" aria-labelledby="sin-club">
            <h3 id="sin-club" className="grupo-reporte-titulo">
              <span>Sin club asignado</span>
              <span className="grupo-reporte-cuenta">{numero(reporte.sinClub.length)} persona(s)</span>
            </h3>
            <p className="grupo-reporte-vacio" style={{ fontStyle: "normal" }}>
              Todas las personas no eliminadas, con cuenta activa y sin membresía activa (el mismo criterio que la asignación masiva).
              Incluye a delegados, entrenadores y representantes legales que no tienen membresía activa.
            </p>
            {reporte.sinClub.length === 0 ? (
              <p className="grupo-reporte-vacio">Nadie sin club.</p>
            ) : (
              <ol className="grupo-reporte-lista">
                {reporte.sinClub.map((n) => (
                  <li key={n.personId}>{n.nombre}</li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}
