import { useEffect, useState, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { Dialogo } from "../../shared/Dialogo";
import { useSwimmerAssignmentApi, CODIGOS, codigoDelError, type ClubSwimmerAssignment, type AssignmentStatus } from "./assignmentApi";
import { useSort, sortItems, SortableTh } from "../../shared/sortableTable";
import { formatearFechaCalendario, hoyEnSantiago } from "../../shared/fechaCalendario";
import { BajaDeMembresiaDialog } from "./BajaDeMembresiaDialog";
import { PanelDeActivacion } from "./PanelDeActivacion";
import { useOperacionUnica } from "../../shared/useOperacionUnica";

const STATUS_LABELS: Record<AssignmentStatus, string> = { pending: "Pendiente", active: "Activo", rejected: "Rechazado", ended: "Finalizado" };
const STATUS_BADGE: Record<AssignmentStatus, string> = { pending: "badge-locked", active: "badge-active", rejected: "badge-disabled", ended: "badge-disabled" };

/**
 * Fecha de TÉRMINO de pertenencia. Es `fechaTermino`, nunca `endDate` (el instante de la
 * operación). En una finalizada sin `fechaTermino`, el término es desconocido y se dice.
 */
function terminoDePertenencia(a: Pick<ClubSwimmerAssignment, "status" | "fechaTermino">): string {
  if (a.status !== "ended") return "—";
  return a.fechaTermino ? formatearFechaCalendario(a.fechaTermino) : "Desconocido";
}

type Accion =
  | { tipo: "aprobar"; a: ClubSwimmerAssignment }
  | { tipo: "rechazar"; a: ClubSwimmerAssignment }
  | { tipo: "baja"; a: ClubSwimmerAssignment };

export function SwimmerAssignmentsPage() {
  const api = useSwimmerAssignmentApi();
  const [status, setStatus] = useState<AssignmentStatus | "">("pending");
  const [data, setData] = useState<{ items: ClubSwimmerAssignment[]; total: number; page: number; pageSize: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  /** Aviso de que otra operación cambió el estado. Lo pinta la acción; la recarga no lo borra. */
  const [avisoDeCambio, setAvisoDeCambio] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const { sortKey, sortDir, onSort } = useSort<"person" | "club" | "status">();
  const [accion, setAccion] = useState<Accion | null>(null);
  const [motivo, setMotivo] = useState("");
  const [errorDeAccion, setErrorDeAccion] = useState<string | null>(null);
  /**
   * UNA escritura a la vez en toda la pantalla (aprobar, rechazar, dar de baja), compartida con el
   * panel de aprobación: mientras dura, el diálogo no se cierra y no se abre otra acción.
   */
  const operacion = useOperacionUnica();
  const enviando = operacion.enCurso;
  /** Solo la última carga aplica su respuesta (filtro o página cambiados entre medias). */
  const cargaVigente = useRef(0);
  const hoy = hoyEnSantiago();

  const load = useCallback(async () => {
    const n = ++cargaVigente.current;
    setError(null);
    try {
      const res = await api.list({ status: (status || undefined) as AssignmentStatus | undefined, page });
      if (n === cargaVigente.current) setData(res);
    } catch (err) {
      if (n === cargaVigente.current) setError(err instanceof Error ? err.message : "Error al cargar solicitudes");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function abrir(a: Accion) {
    if (operacion.ocupada()) return;
    setAccion(a);
    setMotivo("");
    setErrorDeAccion(null);
    setMensaje(null);
    setAvisoDeCambio(null);
  }
  const cerrar = useCallback(() => {
    if (operacion.ocupada()) return;
    setAccion(null);
    setErrorDeAccion(null);
  }, [operacion]);

  /** Ejecuta una escritura una sola vez y recarga la lista al terminar, bien o mal. */
  async function ejecutar(escritura: () => Promise<unknown>, exito: string) {
    const testigo = operacion.iniciar();
    if (testigo === null) return;
    setErrorDeAccion(null);
    try {
      await escritura();
      setAccion(null);
      setMensaje(exito);
    } catch (err) {
      if (codigoDelError(err) === CODIGOS.membresiaNoActiva || codigoDelError(err) === CODIGOS.solicitudYaResuelta) {
        // Otra operación la cambió: el diálogo ya no describe el estado real.
        setAccion(null);
        setAvisoDeCambio(err instanceof Error ? err.message : "La membresía cambió. Revise el estado actual.");
      } else {
        setErrorDeAccion(err instanceof Error ? err.message : "No se pudo completar la operación");
      }
    } finally {
      operacion.terminar(testigo);
      void load();
    }
  }

  return (
    <AppShell>
      <div className="c05-pantalla">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <h1 style={{ color: "var(--brand-navy)" }}>Asignación de Nadadores a Clubes</h1>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <Link to="/asignaciones/altas" className="btn-secondary" style={{ textDecoration: "none" }}>
              Solicitudes de alta
            </Link>
            <Link to="/asignaciones/periodos" className="btn-secondary" style={{ textDecoration: "none" }}>
              Periodos de cambio
            </Link>
            <Link to="/asignaciones/masiva" className="btn-secondary" style={{ textDecoration: "none" }}>
              Asignación masiva
            </Link>
          </div>
        </div>
        <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
          Las solicitudes propuestas por los clubes requieren aprobación del administrador antes de activarse.
        </p>

        <div style={{ marginBottom: "1rem" }}>
          <select
            aria-label="Estado"
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value as AssignmentStatus | "");
            }}
            style={{ maxWidth: 220 }}
          >
            <option value="pending">Pendientes</option>
            <option value="active">Activas</option>
            <option value="rejected">Rechazadas</option>
            <option value="ended">Finalizadas</option>
            <option value="">Todas</option>
          </select>
        </div>

        {error && <p className="error-message">{error}</p>}
        {avisoDeCambio && (
          <p className="aviso aviso-advertencia" role="alert">
            {avisoDeCambio}
          </p>
        )}
        {mensaje && (
          <p className="aviso" role="status">
            {mensaje}
          </p>
        )}

        {data && (
          <>
            <div className="tabla-desplazable">
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableTh label="Nadador" sortKey="person" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                    <SortableTh label="Club" sortKey="club" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                    <SortableTh label="Estado" sortKey="status" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                    <th>Desde</th>
                    <th>Hasta</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {sortItems(data.items, sortKey, sortDir, (a, key) => {
                    switch (key) {
                      case "person":
                        return a.person.fullName;
                      case "club":
                        return a.club.name;
                      case "status":
                        return STATUS_LABELS[a.status];
                    }
                  }).map((a) => (
                    <tr key={a.id}>
                      <td>
                        {a.person.fullName} ({a.person.run})
                      </td>
                      <td>{a.club.name}</td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[a.status]}`}>{STATUS_LABELS[a.status]}</span>
                      </td>
                      <td>{a.startDate ? formatearFechaCalendario(a.startDate) : a.status === "pending" ? "—" : "Desconocido"}</td>
                      <td>{terminoDePertenencia(a)}</td>
                      <td style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                        {a.status === "pending" && (
                          <>
                            <button className="btn-primary" onClick={() => abrir({ tipo: "aprobar", a })} style={{ padding: "0.4rem 0.8rem" }} disabled={enviando}>
                              Aprobar
                            </button>
                            <button className="btn-secondary" onClick={() => abrir({ tipo: "rechazar", a })} disabled={enviando}>
                              Rechazar
                            </button>
                          </>
                        )}
                        {a.status === "active" && (
                          <button className="btn-danger" onClick={() => abrir({ tipo: "baja", a })} disabled={enviando}>
                            Finalizar membresía
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.items.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1.5rem" }}>
                        No hay solicitudes en este estado.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
                {data.total} solicitud(es) — página {data.page}
              </span>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Anterior
                </button>
                <button className="btn-secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage((p) => p + 1)}>
                  Siguiente
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {accion?.tipo === "aprobar" && (
        <Dialogo titulo="Aprobar propuesta" onCerrar={cerrar} bloqueado={enviando}>
          <dl className="ficha-datos">
            <dt>Nadador</dt>
            <dd>
              {accion.a.person.fullName} ({accion.a.person.run})
            </dd>
            <dt>Club de destino</dt>
            <dd>{accion.a.club.name}</dd>
          </dl>
          <PanelDeActivacion
            personaId={accion.a.personId}
            clubDestino={accion.a.club}
            permiteTraslado
            excluirMembresiaId={accion.a.id}
            operacion={operacion}
            hoy={hoy}
            etiquetaConfirmar="Aprobar"
            enviar={(opciones) => api.approve(accion.a.id, opciones)}
            onExito={() => {
              setAccion(null);
              setMensaje(`Propuesta aprobada: ${accion.a.person.fullName} queda activo en ${accion.a.club.name}.`);
              void load();
            }}
            onErrorNoManejado={(err) => {
              if (codigoDelError(err) === CODIGOS.solicitudYaResuelta) {
                setAccion(null);
                setAvisoDeCambio(err instanceof Error ? err.message : "La propuesta ya no está pendiente.");
              }
              void load();
            }}
            onCancelar={cerrar}
          />
        </Dialogo>
      )}

      {accion?.tipo === "rechazar" && (
        <Dialogo titulo="Rechazar propuesta" onCerrar={cerrar} bloqueado={enviando}>
          <p style={{ fontSize: "0.9rem" }}>
            {accion.a.person.fullName} ({accion.a.person.run}) en {accion.a.club.name}.
          </p>
          <label htmlFor="motivo-rechazo">Motivo (opcional)</label>
          <textarea id="motivo-rechazo" value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} disabled={enviando} />
          {errorDeAccion && (
            <p className="error-message" role="alert">
              {errorDeAccion}
            </p>
          )}
          <div className="dialogo-acciones">
            <button type="button" className="btn-secondary" onClick={cerrar} disabled={enviando}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={enviando}
              onClick={() => void ejecutar(() => api.reject(accion.a.id, motivo.trim() || undefined), "Propuesta rechazada.")}
            >
              {enviando ? "Enviando…" : "Confirmar rechazo"}
            </button>
          </div>
        </Dialogo>
      )}

      {accion?.tipo === "baja" && (
        <BajaDeMembresiaDialog
          membresia={accion.a}
          hoy={hoy}
          enviando={enviando}
          error={errorDeAccion}
          onCancelar={cerrar}
          onConfirmar={(datos) => void ejecutar(() => api.end(accion.a.id, datos), `Baja registrada: ${accion.a.person.fullName} deja ${accion.a.club.name}.`)}
        />
      )}
    </AppShell>
  );
}
