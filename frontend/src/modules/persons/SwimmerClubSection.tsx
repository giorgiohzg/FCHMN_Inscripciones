import { useCallback, useEffect, useRef, useState } from "react";
import { useClubsApi, type Club } from "../clubs/clubsApi";
import { useSwimmerAssignmentApi, type ClubSwimmerAssignment } from "../swimmer-assignment/assignmentApi";
import { PanelDeActivacion } from "../swimmer-assignment/PanelDeActivacion";
import { traerTodasLasPaginas } from "../../shared/paginacion";
import { formatearFechaCalendario, hoyEnSantiago } from "../../shared/fechaCalendario";
import { useOperacionUnica } from "../../shared/useOperacionUnica";

const ESTADOS: Record<ClubSwimmerAssignment["status"], string> = { pending: "Pendiente", active: "Activa", rejected: "Rechazada", ended: "Finalizada" };

/**
 * Club de la persona y TRASLADO administrativo (`reassign`).
 *
 * C-05: el cambio se revisa antes de enviarlo (origen, destino, fechas y confirmación expresa de
 * la membresía vigente; ver `PanelDeActivacion`). El historial muestra las fechas de PERTENENCIA:
 * el término es `fechaTermino`, nunca `endDate` (el instante en que se registró la baja).
 *
 * El historial se trae COMPLETO (todas las páginas): con una sola no se podría afirmar qué club
 * está vigente ni que el historial está entero. Si la carga falla, no se afirma nada.
 * Mientras una reasignación está en curso, no se puede cambiar el destino ni cancelar.
 */
export function SwimmerClubSection({ personId }: { personId: string }) {
  const clubsApi = useClubsApi();
  const api = useSwimmerAssignmentApi();

  /** undefined = cargando o carga fallida (sin datos que afirmar). */
  const [membresias, setMembresias] = useState<ClubSwimmerAssignment[] | undefined>(undefined);
  const [errorDeCarga, setErrorDeCarga] = useState<string | null>(null);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [changing, setChanging] = useState(false);
  const [selectedClubId, setSelectedClubId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const cargaVigente = useRef(0);
  const operacion = useOperacionUnica();

  /** Otra persona = otra ficha: nada de la revisión anterior sobrevive. */
  const [personaAnterior, setPersonaAnterior] = useState(personId);
  if (personId !== personaAnterior) {
    setPersonaAnterior(personId);
    setMembresias(undefined);
    setErrorDeCarga(null);
    setChanging(false);
    setSelectedClubId("");
    setError(null);
    setMessage(null);
  }

  const load = useCallback(() => {
    const n = ++cargaVigente.current;
    setErrorDeCarga(null);
    traerTodasLasPaginas((page, pageSize) => api.list({ personId, page, pageSize }))
      .then((todas) => {
        if (n === cargaVigente.current) setMembresias(todas);
      })
      .catch((err) => {
        if (n !== cargaVigente.current) return;
        // Sin datos: no se afirma «no tiene club» ni un historial vacío.
        setMembresias(undefined);
        setErrorDeCarga(err instanceof Error ? err.message : "No se pudo cargar el historial de membresías");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId]);

  useEffect(() => {
    load();
    traerTodasLasPaginas((page, pageSize) => clubsApi.list({ status: "active", page, pageSize }))
      .then(setClubs)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los clubes"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId]);

  const vigente = membresias?.find((m) => m.status === "active") ?? null;
  const historial = (membresias ?? []).filter((m) => m.status === "active" || m.status === "ended");
  const clubElegido = clubs.find((c) => c.id === selectedClubId) ?? null;

  /** Cierra el formulario de cambio (también tras un éxito, cuando la operación aún se está liberando). */
  function cerrarCambio() {
    setChanging(false);
    setSelectedClubId("");
  }
  /** Cancelación del USUARIO: no se permite con una reasignación en curso. */
  function cancelar() {
    if (operacion.ocupada()) return;
    cerrarCambio();
  }

  return (
    <div className="c05-pantalla" style={{ marginTop: "2rem", paddingTop: "1.5rem", borderTop: "1px solid var(--brand-gray-100)", maxWidth: 620 }}>
      <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Club asignado</h2>

      {membresias === undefined && !errorDeCarga && <p style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)" }}>Cargando...</p>}
      {errorDeCarga && (
        <p className="error-message">
          {errorDeCarga}{" "}
          <button type="button" className="btn-secondary" onClick={load} style={{ padding: "0.15rem 0.5rem", fontSize: "0.8rem" }}>
            Reintentar
          </button>
        </p>
      )}

      {membresias !== undefined && !changing && (
        <>
          {vigente ? (
            <p style={{ fontSize: "0.9rem" }}>
              Actualmente asignado a: <strong>{vigente.club.name}</strong>
              {vigente.startDate ? ` desde el ${formatearFechaCalendario(vigente.startDate)}` : " (inicio desconocido)"}
            </p>
          ) : (
            <p style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)" }}>No tiene club asignado.</p>
          )}
          <button className="btn-secondary" onClick={() => setChanging(true)} disabled={!!errorDeCarga}>
            {vigente ? "Cambiar de club" : "Asignar a un club"}
          </button>
        </>
      )}

      {changing && (
        <div style={{ marginTop: "0.5rem" }}>
          <label htmlFor="nuevo-club">{vigente ? "Nuevo club" : "Club"}</label>
          <select
            id="nuevo-club"
            value={selectedClubId}
            // Con una reasignación enviada, el destino no cambia hasta conocer su resultado.
            disabled={operacion.enCurso}
            onChange={(e) => {
              if (!operacion.ocupada()) setSelectedClubId(e.target.value);
            }}
          >
            <option value="">Seleccionar...</option>
            {clubs
              .filter((c) => c.id !== vigente?.club.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          {clubElegido ? (
            <PanelDeActivacion
              // Otra persona u otro club elegido = otra revisión, desde cero.
              key={`${personId}|${clubElegido.id}`}
              personaId={personId}
              clubDestino={{ id: clubElegido.id, name: clubElegido.name }}
              permiteTraslado
              operacion={operacion}
              hoy={hoyEnSantiago()}
              etiquetaConfirmar={vigente ? "Confirmar cambio de club" : "Confirmar asignación"}
              enviar={(opciones) => api.reassign(personId, clubElegido.id, opciones)}
              onExito={() => {
                setMessage("Club actualizado correctamente.");
                setError(null);
                cerrarCambio();
                load();
              }}
              onErrorNoManejado={() => load()}
              onCancelar={cancelar}
            />
          ) : (
            <div className="dialogo-acciones">
              <button type="button" className="btn-secondary" onClick={cancelar}>
                Cancelar
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="error-message">{error}</p>}
      {message && (
        <p style={{ fontSize: "0.85rem", background: "var(--brand-bg)", padding: "0.6rem", borderRadius: 6, marginTop: "0.5rem" }} role="status">
          {message}
        </p>
      )}

      {historial.length > 0 && (
        <>
          <h3 style={{ fontSize: "0.95rem", color: "var(--brand-navy)", marginTop: "1.25rem" }}>Historial de pertenencia</h3>
          <div className="tabla-desplazable">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Club</th>
                  <th>Estado</th>
                  <th>Desde</th>
                  <th>Hasta (último día)</th>
                </tr>
              </thead>
              <tbody>
                {historial.map((m) => (
                  <tr key={m.id}>
                    <td>{m.club.name}</td>
                    <td>{ESTADOS[m.status]}</td>
                    <td>{m.startDate ? formatearFechaCalendario(m.startDate) : "Desconocido"}</td>
                    <td>{m.status === "active" ? "—" : m.fechaTermino ? formatearFechaCalendario(m.fechaTermino) : "Desconocido"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
