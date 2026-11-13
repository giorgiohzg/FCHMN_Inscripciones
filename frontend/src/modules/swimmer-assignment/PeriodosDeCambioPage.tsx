import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { Dialogo } from "../../shared/Dialogo";
import { esFechaCalendarioExistente, formatearFechaCalendario, hoyEnSantiago } from "../../shared/fechaCalendario";
import { useIncorporacionesApi, type PeriodoDeCambio } from "./incorporacionesApi";

type Estado = "vigente" | "programado" | "terminado" | "cerrado";
const ETIQUETAS: Record<Estado, string> = { vigente: "Vigente", programado: "Programado", terminado: "Terminado", cerrado: "Cerrado anticipadamente" };
const INSIGNIAS: Record<Estado, string> = { vigente: "badge-active", programado: "badge-locked", terminado: "badge-disabled", cerrado: "badge-disabled" };

/** Estado de un periodo HOY (Santiago), con fechas inclusivas. */
function estadoDelPeriodo(p: PeriodoDeCambio, hoy: string): Estado {
  if (p.cerradoEn) return "cerrado";
  if (hoy < p.inicio) return "programado";
  if (hoy > p.fin) return "terminado";
  return "vigente";
}

const instante = (iso: string) => new Date(iso).toLocaleString("es-CL", { timeZone: "America/Santiago", dateStyle: "short", timeStyle: "short" });

/**
 * C-05: periodos GLOBALES de cambio de club (solo administración).
 *
 * Crear (inicio y fin inclusivos, motivo), listar con su historial y cerrar anticipadamente con
 * confirmación. No hay edición ni reapertura, y nada se abre solo: tampoco en marzo o agosto.
 */
export function PeriodosDeCambioPage() {
  const api = useIncorporacionesApi();
  const hoy = hoyEnSantiago();
  const [periodos, setPeriodos] = useState<PeriodoDeCambio[] | null>(null);
  const [errorDeCarga, setErrorDeCarga] = useState<string | null>(null);
  const [inicio, setInicio] = useState("");
  const [fin, setFin] = useState("");
  const [motivo, setMotivo] = useState("");
  const [creando, setCreando] = useState(false);
  const [errorAlCrear, setErrorAlCrear] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [aCerrar, setACerrar] = useState<PeriodoDeCambio | null>(null);
  const [cerrando, setCerrando] = useState(false);
  const [errorAlCerrar, setErrorAlCerrar] = useState<string | null>(null);
  const enviando = useRef(false);
  const cargaVigente = useRef(0);

  const cargar = useCallback(async () => {
    const n = ++cargaVigente.current;
    setErrorDeCarga(null);
    try {
      const r = await api.listarPeriodos();
      if (n === cargaVigente.current) setPeriodos(r);
    } catch (err) {
      if (n === cargaVigente.current) setErrorDeCarga(err instanceof Error ? err.message : "No se pudieron cargar los periodos");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  let problema: string | null = null;
  if (!esFechaCalendarioExistente(inicio)) problema = "Indique la fecha de inicio.";
  else if (!esFechaCalendarioExistente(fin)) problema = "Indique la fecha de fin.";
  else if (fin < inicio) problema = "El fin no puede ser anterior al inicio.";
  else if (fin < hoy) problema = `El periodo terminaría antes de hoy (${formatearFechaCalendario(hoy)}): no habilitaría ningún cambio.`;
  else if (motivo.trim() === "") problema = "Indique el motivo.";

  async function crear() {
    if (problema || enviando.current) return;
    enviando.current = true;
    setCreando(true);
    setErrorAlCrear(null);
    setMensaje(null);
    try {
      await api.crearPeriodo({ inicio, fin, motivo: motivo.trim() });
      setInicio("");
      setFin("");
      setMotivo("");
      setMensaje("Periodo creado.");
    } catch (err) {
      setErrorAlCrear(err instanceof Error ? err.message : "No se pudo crear el periodo");
    } finally {
      enviando.current = false;
      setCreando(false);
      void cargar();
    }
  }

  async function cerrar(p: PeriodoDeCambio) {
    if (enviando.current) return;
    enviando.current = true;
    setCerrando(true);
    setErrorAlCerrar(null);
    try {
      await api.cerrarPeriodo(p.id);
      setACerrar(null);
      setMensaje("Periodo cerrado. Las propuestas y solicitudes pendientes se conservan.");
    } catch (err) {
      setErrorAlCerrar(err instanceof Error ? err.message : "No se pudo cerrar el periodo");
    } finally {
      enviando.current = false;
      setCerrando(false);
      void cargar();
    }
  }

  return (
    <AppShell>
      <div className="c05-pantalla">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <h1 style={{ color: "var(--brand-navy)" }}>Periodos de cambio de club</h1>
          <Link to="/asignaciones" className="btn-secondary" style={{ textDecoration: "none" }}>
            Volver a asignaciones
          </Link>
        </div>
        <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem", maxWidth: 760 }}>
          Durante un periodo vigente, un club puede postular a un nadador que hoy pertenece a otro club. Los periodos son globales, con fechas inclusivas (hora de
          Chile), y solo los abre administración: no hay apertura automática, tampoco en marzo o agosto. Un periodo no se edita ni se reabre; se puede cerrar
          anticipadamente.
        </p>

        <section style={{ maxWidth: 560, marginTop: "1rem" }} aria-labelledby="titulo-nuevo-periodo">
          <h2 id="titulo-nuevo-periodo" style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>
            Nuevo periodo
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0 1rem" }}>
            <div>
              <label htmlFor="periodo-inicio">Inicio (inclusive)</label>
              <input id="periodo-inicio" type="date" required value={inicio} onChange={(e) => setInicio(e.target.value)} disabled={creando} />
            </div>
            <div>
              <label htmlFor="periodo-fin">Fin (inclusive)</label>
              <input
                id="periodo-fin"
                type="date"
                required
                value={fin}
                min={inicio && inicio > hoy ? inicio : hoy}
                onChange={(e) => setFin(e.target.value)}
                disabled={creando}
              />
            </div>
          </div>
          <label htmlFor="periodo-motivo">Motivo</label>
          <input id="periodo-motivo" value={motivo} maxLength={300} onChange={(e) => setMotivo(e.target.value)} disabled={creando} />
          {(inicio || fin || motivo) && problema && <p className="error-message">{problema}</p>}
          {errorAlCrear && (
            <p className="error-message" role="alert">
              {errorAlCrear}
            </p>
          )}
          <button className="btn-primary" style={{ marginTop: "0.75rem" }} onClick={() => void crear()} disabled={problema !== null || creando}>
            {creando ? "Creando…" : "Crear periodo"}
          </button>
        </section>

        {mensaje && (
          <p className="aviso" role="status">
            {mensaje}
          </p>
        )}

        <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)", marginTop: "1.5rem" }}>Periodos e historial</h2>
        {errorDeCarga && (
          <p className="error-message">
            {errorDeCarga}{" "}
            <button type="button" className="btn-secondary" onClick={() => void cargar()} style={{ padding: "0.15rem 0.5rem", fontSize: "0.8rem" }}>
              Reintentar
            </button>
          </p>
        )}
        {periodos === null && !errorDeCarga && <p role="status">Cargando periodos…</p>}
        {periodos && (
          <div className="tabla-desplazable">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Inicio</th>
                  <th>Fin</th>
                  <th>Motivo</th>
                  <th>Estado</th>
                  <th>Creado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {periodos.map((p) => {
                  const estado = estadoDelPeriodo(p, hoy);
                  return (
                    <tr key={p.id}>
                      <td>{formatearFechaCalendario(p.inicio)}</td>
                      <td>{formatearFechaCalendario(p.fin)}</td>
                      <td>{p.motivo ?? "—"}</td>
                      <td>
                        <span className={`badge ${INSIGNIAS[estado]}`}>{ETIQUETAS[estado]}</span>
                        {p.cerradoEn && <div style={{ fontSize: "0.75rem", color: "var(--brand-gray-600)" }}>el {instante(p.cerradoEn)}</div>}
                      </td>
                      <td>{instante(p.creadoEn)}</td>
                      <td>
                        {!p.cerradoEn && estado !== "terminado" && (
                          <button
                            className="btn-danger"
                            onClick={() => {
                              setErrorAlCerrar(null);
                              setACerrar(p);
                            }}
                            disabled={cerrando}
                          >
                            Cerrar anticipadamente
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {periodos.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1.5rem" }}>
                      No hay periodos registrados.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {aCerrar && (
        <Dialogo titulo="Cerrar periodo anticipadamente" onCerrar={() => !cerrando && setACerrar(null)} bloqueado={cerrando}>
          <p style={{ fontSize: "0.9rem" }}>
            Periodo del {formatearFechaCalendario(aCerrar.inicio)} al {formatearFechaCalendario(aCerrar.fin)}
            {aCerrar.motivo ? ` (${aCerrar.motivo})` : ""}.
          </p>
          <p className="aviso aviso-advertencia">
            Desde el cierre, los clubes no podrán postular cambios por este periodo. Cerrar <strong>no elimina ni resuelve</strong> las propuestas ni las solicitudes
            pendientes: se conservan para que administración las revise. Un periodo cerrado no se reabre ni se edita.
          </p>
          {errorAlCerrar && (
            <p className="error-message" role="alert">
              {errorAlCerrar}
            </p>
          )}
          <div className="dialogo-acciones">
            <button type="button" className="btn-secondary" onClick={() => setACerrar(null)} disabled={cerrando}>
              Cancelar
            </button>
            <button type="button" className="btn-danger" onClick={() => void cerrar(aCerrar)} disabled={cerrando}>
              {cerrando ? "Cerrando…" : "Confirmar cierre"}
            </button>
          </div>
        </Dialogo>
      )}
    </AppShell>
  );
}
