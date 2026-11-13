import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { Dialogo } from "../../shared/Dialogo";
import { esFechaCalendarioExistente, formatearFechaCalendario, hoyEnSantiago } from "../../shared/fechaCalendario";
import { codigoDelError, CODIGOS } from "./assignmentApi";
import { PanelDeActivacion } from "./PanelDeActivacion";
import { useOperacionUnica } from "../../shared/useOperacionUnica";
import {
  CODIGOS_ALTA,
  useIncorporacionesApi,
  type DatosDePersonaNueva,
  type DetalleSolicitudAlta,
  type EstadoSolicitudAlta,
  type ListaDeSolicitudes,
  type SolicitudAlta,
} from "./incorporacionesApi";

const ETIQUETAS: Record<EstadoSolicitudAlta, string> = {
  pendiente: "Pendiente",
  aprobada: "Aprobada",
  rechazada: "Rechazada",
  resuelta_por_propuesta: "Resuelta por propuesta existente",
};
const INSIGNIAS: Record<EstadoSolicitudAlta, string> = {
  pendiente: "badge-locked",
  aprobada: "badge-active",
  rechazada: "badge-disabled",
  resuelta_por_propuesta: "badge-active",
};

const instante = (iso: string) => new Date(iso).toLocaleString("es-CL", { timeZone: "America/Santiago", dateStyle: "short", timeStyle: "short" });

/** Códigos que significan «la solicitud o la persona cambió»: se recarga el detalle y se revisa otra vez. */
const CAMBIOS_EXTERNOS = new Set<string>([
  CODIGOS_ALTA.personaYaRegistrada,
  CODIGOS_ALTA.personaNoRegistrada,
  CODIGOS_ALTA.personaDistinta,
  CODIGOS_ALTA.coincidenciaEliminada,
  CODIGOS.solicitudYaResuelta,
]);

/**
 * C-05: solicitudes de alta (RUN no registrado al postular). Solo administración las resuelve.
 * La resolución es UNA petición atómica del servidor: crea o vincula a la persona y la asigna.
 */
export function SolicitudesDeAltaPage() {
  const api = useIncorporacionesApi();
  const [estado, setEstado] = useState<EstadoSolicitudAlta | "">("pendiente");
  const [page, setPage] = useState(1);
  const [lista, setLista] = useState<ListaDeSolicitudes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const cargaVigente = useRef(0);

  const cargar = useCallback(async () => {
    const n = ++cargaVigente.current;
    setError(null);
    try {
      const r = await api.listarSolicitudes({ estado: estado || undefined, page });
      if (n === cargaVigente.current) setLista(r);
    } catch (err) {
      if (n === cargaVigente.current) setError(err instanceof Error ? err.message : "No se pudieron cargar las solicitudes");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estado, page]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <AppShell>
      <div className="c05-pantalla">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <h1 style={{ color: "var(--brand-navy)" }}>Solicitudes de alta</h1>
          <Link to="/asignaciones" className="btn-secondary" style={{ textDecoration: "none" }}>
            Volver a asignaciones
          </Link>
        </div>
        <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem", maxWidth: 760 }}>
          Un club envía una solicitud de alta cuando postula un RUN que no está registrado. Los nombres son los que declaró el club y no están verificados:
          administración verifica los datos al crear a la persona, o la vincula si ya existe.
        </p>

        <select
          aria-label="Estado"
          value={estado}
          onChange={(e) => {
            setPage(1);
            setEstado(e.target.value as EstadoSolicitudAlta | "");
          }}
          style={{ maxWidth: 260, marginBottom: "1rem" }}
        >
          <option value="pendiente">Pendientes</option>
          <option value="aprobada">Aprobadas</option>
          <option value="resuelta_por_propuesta">Resueltas por propuesta</option>
          <option value="rechazada">Rechazadas</option>
          <option value="">Todas</option>
        </select>

        {error && <p className="error-message">{error}</p>}
        {mensaje && (
          <p className="aviso" role="status">
            {mensaje}
          </p>
        )}

        {lista && (
          <>
            <div className="tabla-desplazable">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Club solicitante</th>
                    <th>RUN</th>
                    <th>Nombres declarados</th>
                    <th>Estado</th>
                    <th>Recibida</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {lista.items.map((s) => (
                    <tr key={s.id}>
                      <td>{s.club.name}</td>
                      <td>{s.run}</td>
                      <td>
                        {s.nombres} {s.apellidos}
                      </td>
                      <td>
                        <span className={`badge ${INSIGNIAS[s.estado]}`}>{ETIQUETAS[s.estado]}</span>
                      </td>
                      <td>{instante(s.creadoEn)}</td>
                      <td>
                        <button className="btn-secondary" onClick={() => setAbierta((actual) => actual ?? s.id)} disabled={abierta !== null}>
                          {s.estado === "pendiente" ? "Revisar" : "Ver"}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {lista.items.length === 0 && (
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
                {lista.total} solicitud(es) — página {lista.page}
              </span>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Anterior
                </button>
                <button className="btn-secondary" disabled={page * lista.pageSize >= lista.total} onClick={() => setPage((p) => p + 1)}>
                  Siguiente
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {abierta && (
        <DetalleDeSolicitud
          key={abierta}
          id={abierta}
          onCerrar={() => {
            setAbierta(null);
            void cargar();
          }}
          onResuelta={(texto) => {
            setAbierta(null);
            setMensaje(texto);
            void cargar();
          }}
        />
      )}
    </AppShell>
  );
}

const PERSONA_VACIA = { firstName: "", paternalLastName: "", maternalLastName: "", birthDate: "", gender: "" as "" | "male" | "female", email: "", phone: "" };

function DetalleDeSolicitud({ id, onCerrar, onResuelta }: { id: string; onCerrar: () => void; onResuelta: (mensaje: string) => void }) {
  const api = useIncorporacionesApi();
  const hoy = hoyEnSantiago();
  const [detalle, setDetalle] = useState<DetalleSolicitudAlta | null>(null);
  const [errorDeCarga, setErrorDeCarga] = useState<string | null>(null);
  /** Cada recarga reinicia la revisión (el panel se vuelve a montar): nada confirmado sobrevive. */
  const [version, setVersion] = useState(0);
  const [aviso, setAviso] = useState<string | null>(null);
  const [persona, setPersona] = useState(PERSONA_VACIA);
  const [creaPeseAEliminada, setCreaPeseAEliminada] = useState(false);
  const [rechazando, setRechazando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [errorDeRechazo, setErrorDeRechazo] = useState<string | null>(null);
  /**
   * UNA escritura a la vez en esta solicitud: crear, vincular o rechazar. La comparten los paneles
   * y el rechazo; mientras dura, el diálogo no se cierra ni cambian los datos enviados.
   */
  const operacion = useOperacionUnica();
  const ocupado = operacion.enCurso;
  const cargaVigente = useRef(0);
  const montado = useRef(true);
  useEffect(() => {
    // Se vuelve a marcar al montar: StrictMode desmonta y monta otra vez en desarrollo, y una
    // marca que solo se apagara dejaría el componente ignorando sus propias respuestas.
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  const cargar = useCallback(async () => {
    const n = ++cargaVigente.current;
    setErrorDeCarga(null);
    try {
      const d = await api.obtenerSolicitud(id);
      if (!montado.current || n !== cargaVigente.current) return;
      setDetalle(d);
      setCreaPeseAEliminada(false);
      setVersion((v) => v + 1);
    } catch (err) {
      if (montado.current && n === cargaVigente.current) setErrorDeCarga(err instanceof Error ? err.message : "No se pudo cargar la solicitud");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function alResolver(r: unknown) {
    const s = r as SolicitudAlta | null;
    if (s?.estado === "resuelta_por_propuesta") {
      onResuelta(`La solicitud de ${detalle?.run ?? ""} quedó resuelta por la propuesta existente del club: revísela en Asignaciones (pendientes).`);
    } else {
      onResuelta(`Solicitud aprobada: ${s?.persona?.fullName ?? "la persona"} queda asignada a ${detalle?.club.name ?? "el club"}.`);
    }
  }

  function alFallar(err: unknown) {
    const codigo = codigoDelError(err);
    if (codigo && CAMBIOS_EXTERNOS.has(codigo)) {
      setAviso(
        codigo === CODIGOS_ALTA.coincidenciaEliminada
          ? "El RUN coincide con personas eliminadas. Se recargó la solicitud: revise la advertencia y confirme expresamente si corresponde crear una persona nueva."
          : "La solicitud o la persona con ese RUN cambió desde que se cargó. Se recargó la información: revísela y confirme otra vez."
      );
      void cargar();
    }
  }

  async function rechazar() {
    if (motivo.trim() === "") return;
    const testigo = operacion.iniciar();
    if (testigo === null) return;
    setErrorDeRechazo(null);
    try {
      await api.rechazarSolicitud(id, motivo.trim());
      if (montado.current) onResuelta("Solicitud rechazada. Se conserva como historial.");
    } catch (err) {
      if (!montado.current) return;
      setErrorDeRechazo(err instanceof Error ? err.message : "No se pudo rechazar la solicitud");
      if (codigoDelError(err) === CODIGOS.solicitudYaResuelta) void cargar();
    } finally {
      operacion.terminar(testigo);
    }
  }

  const vigente = detalle?.coincidencias?.personaVigente ?? null;
  const eliminadas = detalle?.coincidencias?.eliminadas ?? [];

  let problemaDeDatos: string | null = null;
  if (persona.firstName.trim().length < 2) problemaDeDatos = "Indique el nombre verificado.";
  else if (persona.paternalLastName.trim().length < 2) problemaDeDatos = "Indique el apellido paterno verificado.";
  else if (!esFechaCalendarioExistente(persona.birthDate) || persona.birthDate > hoy) problemaDeDatos = "Indique una fecha de nacimiento válida.";
  else if (persona.gender === "") problemaDeDatos = "Indique el género.";
  else if (eliminadas.length > 0 && !creaPeseAEliminada) problemaDeDatos = "Confirme expresamente que se crea una persona nueva.";

  function datosPersona(): DatosDePersonaNueva {
    return {
      firstName: persona.firstName.trim(),
      paternalLastName: persona.paternalLastName.trim(),
      ...(persona.maternalLastName.trim() ? { maternalLastName: persona.maternalLastName.trim() } : {}),
      birthDate: persona.birthDate,
      gender: persona.gender as "male" | "female",
      ...(persona.email.trim() ? { email: persona.email.trim() } : {}),
      ...(persona.phone.trim() ? { phone: persona.phone.trim() } : {}),
    };
  }

  const campo = (clave: keyof typeof PERSONA_VACIA) => ({
    id: `alta-${clave}`,
    value: persona[clave],
    // Los datos de una creación enviada no cambian hasta conocer su resultado.
    disabled: ocupado,
    onChange: (e: { target: { value: string } }) => {
      if (!operacion.ocupada()) setPersona((p) => ({ ...p, [clave]: e.target.value }));
    },
  });

  return (
    <Dialogo titulo="Solicitud de alta" onCerrar={onCerrar} bloqueado={ocupado} ancho={680}>
      {errorDeCarga && (
        <p className="error-message">
          {errorDeCarga}{" "}
          <button type="button" className="btn-secondary" onClick={() => void cargar()} style={{ padding: "0.15rem 0.5rem", fontSize: "0.8rem" }}>
            Reintentar
          </button>
        </p>
      )}
      {!detalle && !errorDeCarga && <p role="status">Cargando…</p>}

      {detalle && (
        <>
          <h3 style={{ fontSize: "0.95rem", color: "var(--brand-navy)", margin: "0.5rem 0 0" }}>Datos declarados por el club (no verificados)</h3>
          <dl className="ficha-datos">
            <dt>Club solicitante</dt>
            <dd>{detalle.club.name}</dd>
            <dt>RUN</dt>
            <dd>{detalle.run}</dd>
            <dt>Nombres</dt>
            <dd>{detalle.nombres}</dd>
            <dt>Apellidos</dt>
            <dd>{detalle.apellidos}</dd>
            <dt>Recibida</dt>
            <dd>{instante(detalle.creadoEn)}</dd>
            <dt>Estado</dt>
            <dd>
              <span className={`badge ${INSIGNIAS[detalle.estado]}`}>{ETIQUETAS[detalle.estado]}</span>
            </dd>
          </dl>

          {aviso && (
            <p className="aviso aviso-advertencia" role="alert">
              {aviso}
            </p>
          )}

          {detalle.estado !== "pendiente" && (
            <>
              {detalle.persona && (
                <>
                  <h3 style={{ fontSize: "0.95rem", color: "var(--brand-navy)", margin: "0.75rem 0 0" }}>Persona verificada por administración</h3>
                  <dl className="ficha-datos">
                    <dt>Nombre</dt>
                    <dd>{detalle.persona.fullName}</dd>
                    <dt>RUN</dt>
                    <dd>{detalle.persona.run}</dd>
                  </dl>
                </>
              )}
              {detalle.estado === "resuelta_por_propuesta" && (
                <p className="aviso">La persona ya tenía una propuesta pendiente de este club: la solicitud quedó resuelta por esa propuesta, sin crear otra membresía.</p>
              )}
              {detalle.estado === "rechazada" && <p className="aviso">Motivo del rechazo: {detalle.motivoRechazo ?? "sin motivo registrado"}.</p>}
              {detalle.revisadoEn && <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)" }}>Revisada el {instante(detalle.revisadoEn)}.</p>}
              <div className="dialogo-acciones">
                <button type="button" className="btn-secondary" onClick={onCerrar}>
                  Cerrar
                </button>
              </div>
            </>
          )}

          {detalle.estado === "pendiente" && !rechazando && (
            <>
              {vigente ? (
                <>
                  <h3 style={{ fontSize: "0.95rem", color: "var(--brand-navy)", margin: "0.75rem 0 0" }}>Persona ya registrada con este RUN (datos verificados)</h3>
                  <dl className="ficha-datos">
                    <dt>Nombre</dt>
                    <dd>{vigente.fullName}</dd>
                    <dt>RUN</dt>
                    <dd>{vigente.run}</dd>
                    <dt>Membresía activa</dt>
                    <dd>
                      {vigente.membresiaActiva
                        ? `${vigente.membresiaActiva.club.name}, desde ${vigente.membresiaActiva.startDate ? formatearFechaCalendario(vigente.membresiaActiva.startDate) : "fecha desconocida"}`
                        : "Ninguna"}
                    </dd>
                  </dl>
                  <p className="aviso">Se vinculará la solicitud a esta persona (la que está revisando) y se la asignará a {detalle.club.name}.</p>
                  <PanelDeActivacion
                    key={`vincular-${version}`}
                    personaId={vigente.id}
                    clubDestino={detalle.club}
                    permiteTraslado
                    operacion={operacion}
                    hoy={hoy}
                    etiquetaConfirmar="Vincular y asignar"
                    enviar={(opciones) => api.aprobarSolicitud(id, { modo: "vincular", personaEsperadaId: vigente.id, ...opciones })}
                    onExito={alResolver}
                    onErrorNoManejado={alFallar}
                    onCancelar={onCerrar}
                  />
                </>
              ) : (
                <>
                  <h3 style={{ fontSize: "0.95rem", color: "var(--brand-navy)", margin: "0.75rem 0 0" }}>Datos verificados por administración</h3>
                  <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", margin: "0.2rem 0" }}>
                    Complételos con la documentación revisada; el RUN es el de la solicitud y no se puede cambiar.
                  </p>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "0 1rem" }}>
                    <div>
                      <label htmlFor="alta-firstName">Nombres</label>
                      <input {...campo("firstName")} />
                    </div>
                    <div>
                      <label htmlFor="alta-paternalLastName">Apellido paterno</label>
                      <input {...campo("paternalLastName")} />
                    </div>
                    <div>
                      <label htmlFor="alta-maternalLastName">Apellido materno (opcional)</label>
                      <input {...campo("maternalLastName")} />
                    </div>
                    <div>
                      <label htmlFor="alta-birthDate">Fecha de nacimiento</label>
                      <input type="date" max={hoy} {...campo("birthDate")} />
                    </div>
                    <div>
                      <label htmlFor="alta-gender">Género</label>
                      <select {...campo("gender")}>
                        <option value="">Seleccionar...</option>
                        <option value="female">Femenino</option>
                        <option value="male">Masculino</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="alta-email">Correo (opcional)</label>
                      <input type="email" {...campo("email")} />
                    </div>
                    <div>
                      <label htmlFor="alta-phone">Teléfono (opcional)</label>
                      <input {...campo("phone")} />
                    </div>
                  </div>

                  {eliminadas.length > 0 && (
                    <div className="aviso aviso-peligro" role="alert">
                      <p style={{ margin: "0 0 0.4rem" }}>
                        <strong>El RUN coincide con {eliminadas.length} persona(s) eliminada(s).</strong> No se restaurará ninguna: se creará una persona NUEVA, sin
                        heredar cuentas, credenciales, roles ni membresías de la eliminada. La creación queda en la auditoría.
                      </p>
                      <label className="casilla">
                        <input type="checkbox" checked={creaPeseAEliminada} disabled={ocupado} onChange={(e) => setCreaPeseAEliminada(e.target.checked)} />
                        Confirmo crear una persona nueva pese a la coincidencia con personas eliminadas.
                      </label>
                    </div>
                  )}

                  <PanelDeActivacion
                    key={`crear-${version}`}
                    personaId={null}
                    clubDestino={detalle.club}
                    permiteTraslado
                    operacion={operacion}
                    hoy={hoy}
                    etiquetaConfirmar="Crear persona y asignar"
                    bloqueoExterno={problemaDeDatos}
                    enviar={(opciones) =>
                      api.aprobarSolicitud(id, {
                        modo: "crear",
                        datosPersona: datosPersona(),
                        ...(eliminadas.length > 0 && creaPeseAEliminada ? { crearPeseACoincidenciaEliminada: true } : {}),
                        ...opciones,
                      })
                    }
                    onExito={alResolver}
                    onErrorNoManejado={alFallar}
                    onCancelar={onCerrar}
                  />
                </>
              )}
              <div style={{ borderTop: "1px solid var(--brand-gray-100)", marginTop: "1rem", paddingTop: "0.5rem" }}>
                <button
                  type="button"
                  className="btn-secondary"
                  // Con una creación o vinculación enviada no se puede iniciar un rechazo.
                  disabled={ocupado}
                  onClick={() => {
                    if (!operacion.ocupada()) setRechazando(true);
                  }}
                >
                  Rechazar solicitud…
                </button>
              </div>
            </>
          )}

          {detalle.estado === "pendiente" && rechazando && (
            <>
              <label htmlFor="alta-motivo">Motivo del rechazo</label>
              <textarea id="alta-motivo" value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} disabled={ocupado} />
              <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)" }}>La solicitud rechazada se conserva como historial.</p>
              {errorDeRechazo && (
                <p className="error-message" role="alert">
                  {errorDeRechazo}
                </p>
              )}
              <div className="dialogo-acciones">
                <button type="button" className="btn-secondary" onClick={() => setRechazando(false)} disabled={ocupado}>
                  Volver
                </button>
                <button type="button" className="btn-danger" onClick={() => void rechazar()} disabled={ocupado || motivo.trim() === ""}>
                  {ocupado ? "Rechazando…" : "Confirmar rechazo"}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Dialogo>
  );
}
