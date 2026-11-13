import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AppShell } from "../../shared/AppShell";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../../shared/apiClient";
import { formatearFechaCalendario } from "../../shared/fechaCalendario";
import { validarPaginaRecibida } from "../../shared/paginacion";
import { useOperacionUnica } from "../../shared/useOperacionUnica";
import { formatRun, isValidRun, normalizeRun } from "../persons/runValidator";
import type { AssignmentStatus, ClubSwimmerAssignment } from "./assignmentApi";
import type { EstadoSolicitudAlta, SolicitudAlta } from "./incorporacionesApi";
import type { PropuestaDelClub } from "./postulacionApi";
import {
  CODIGOS_POSTULACION as C,
  nuevaClaveDeIdempotencia,
  usePostulacionApi,
  type CuotaDelClub,
  type PeriodoVigente,
  type ResultadoDePostulacion,
} from "./postulacionApi";

const instante = (iso: string) => new Date(iso).toLocaleString("es-CL", { timeZone: "America/Santiago", dateStyle: "short", timeStyle: "short" });
const hora = (iso: string) => new Date(iso).toLocaleTimeString("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit" });

/**
 * C-05, fase 4: «Incorporaciones» del club y su personal autorizado.
 *
 * El estado vive SOLO en memoria y se monta de nuevo si cambia el usuario o el club de la sesión
 * (`key`): un segundo paso, una clave de idempotencia o una respuesta en vuelo no sobreviven a
 * ese cambio. No se guarda RUN, nombres ni identificadores en almacenamiento ni en la consola.
 */
export function IncorporacionesClubPage() {
  const { user } = useAuth();
  return (
    <AppShell>
      <PostulacionDelClub key={`${user?.id ?? ""}|${user?.clubId ?? ""}`} />
    </AppShell>
  );
}

/**
 * Error que NO permite saber si la operación llegó a hacerse: se reintenta con la MISMA clave (o el
 * mismo segundo paso). Es incierto CUALQUIER 5xx, con o sin código (`INTERNAL_ERROR`,
 * `SERVICE_UNAVAILABLE`…): el servidor pudo confirmar la transacción y fallar después, al armar la
 * respuesta. También la red caída y `OPERACION_EN_CURSO`. Los rechazos funcionales (4xx con código,
 * como `INTENTO_INTERRUMPIDO`) son definitivos.
 */
function esIncierto(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true; // red caída, respuesta ilegible
  if (err.code === C.operacionEnCurso) return true;
  return err.status >= 500;
}

type Aviso = { tipo: "exito" | "error" | "incierto"; texto: string };

/**
 * Mensaje de una propuesta según su estado ACTUAL (el que devuelve el servidor). En una repetición
 * la propuesta pudo resolverse entre tanto: no se afirma que siga pendiente si ya no lo está.
 */
function mensajeDePropuesta(p: PropuestaDelClub | null, repeticion: boolean | undefined, prefijo = "Postulación registrada"): string {
  const ya = repeticion ? "Esta postulación ya estaba registrada. " : "";
  if (!p) return `${ya}${prefijo}. Revise su estado en «Propuestas del club».`;
  const quien = `${p.person.fullName} (${p.person.run})`;
  switch (p.status) {
    case "active":
      return `${ya}La propuesta de ${quien} ya fue aprobada por la administración: pertenece al club.`;
    case "rejected":
      return `${ya}La propuesta de ${quien} fue rechazada por la administración. Revise el motivo en «Propuestas del club».`;
    case "ended":
      return `${ya}La propuesta de ${quien} fue aprobada y esa membresía ya finalizó.`;
    default:
      return `${ya}${prefijo}: ${quien}. Queda pendiente de revisión de la administración; mientras no se apruebe, no forma parte del club.`;
  }
}

/** Mensaje de una solicitud de alta según su estado ACTUAL. */
function mensajeDeSolicitud(sol: SolicitudAlta | null, repeticion: boolean | undefined): string {
  if (!sol) {
    return repeticion
      ? "Esta solicitud de alta ya estaba registrada. Revise su estado en «Solicitudes de alta del club»."
      : "Solicitud de alta enviada. La administración verificará los datos declarados y resolverá la incorporación.";
  }
  switch (sol.estado) {
    case "aprobada":
      return "La solicitud de alta ya fue aprobada: la administración registró a la persona y resolvió su incorporación al club.";
    case "rechazada":
      return `La solicitud de alta fue rechazada por la administración${sol.motivoRechazo ? `: ${sol.motivoRechazo}` : ""}.`;
    case "resuelta_por_propuesta":
      return "La solicitud de alta se resolvió con una propuesta existente del club. Revise su estado en «Propuestas del club».";
    default:
      return `${repeticion ? "Esta solicitud de alta ya estaba registrada. " : ""}Solicitud de alta enviada. La administración verificará los datos declarados y resolverá la incorporación.`;
  }
}

/** Contenido de un segundo paso ENVIADO cuyo resultado no se pudo confirmar. Solo en memoria. */
interface EnvioSinConfirmar {
  intentoId: string;
  nombres: string;
  apellidos: string;
}

interface SegundoPaso {
  intentoId: string;
  expiraEn: string;
  /** Solo para mostrarlo mientras dura el paso; no se envía ni se guarda. */
  run: string;
}

function PostulacionDelClub() {
  const api = usePostulacionApi();
  const operacion = useOperacionUnica();
  const idRun = useId();
  const [run, setRun] = useState("");
  const [errorDeRun, setErrorDeRun] = useState<string | null>(null);
  /** Clave de la postulación EN CURSO y el RUN al que pertenece. Se conserva para reintentarla. */
  const [clave, setClave] = useState<{ valor: string; run: string } | null>(null);
  const [paso, setPaso] = useState<SegundoPaso | null>(null);
  const [nombres, setNombres] = useState("");
  const [apellidos, setApellidos] = useState("");
  /** Lo que se envió en el segundo paso y no se confirmó: el reintento reenvía EXACTAMENTE esto. */
  const [sinConfirmar, setSinConfirmar] = useState<EnvioSinConfirmar | null>(null);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [cuota, setCuota] = useState<CuotaDelClub | null>(null);
  const [periodo, setPeriodo] = useState<PeriodoVigente | null>(null);
  const [errorDeContexto, setErrorDeContexto] = useState<string | null>(null);
  const [recargas, setRecargas] = useState(0);
  const montado = useRef(true);
  const cargaDeContexto = useRef(0);
  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  /** Cuota y periodo SIEMPRE del servidor: nada se descuenta localmente. */
  const cargarContexto = useCallback(async () => {
    const n = ++cargaDeContexto.current;
    try {
      const [c, p] = await Promise.all([api.cuota(), api.periodoVigente()]);
      if (!montado.current || n !== cargaDeContexto.current) return;
      setCuota(c);
      setPeriodo(p);
      setErrorDeContexto(null);
    } catch (err) {
      if (!montado.current || n !== cargaDeContexto.current) return;
      setErrorDeContexto(err instanceof Error ? err.message : "No se pudo consultar la cuota ni el periodo.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void cargarContexto();
  }, [cargarContexto]);

  function cambiarRun(v: string) {
    if (operacion.ocupada()) return;
    setRun(v);
    setErrorDeRun(null);
    // Otro RUN es OTRA postulación: la clave anterior no se reutiliza para él.
    if (clave && normalizeRun(v) !== clave.run) setClave(null);
  }

  function terminarPostulacion(r: ResultadoDePostulacion) {
    setClave(null);
    if (r.resultado === "requiere_datos_de_alta") {
      setPaso({ intentoId: r.intentoId, expiraEn: r.expiraEn, run: formatRun(run) });
      setNombres("");
      setApellidos("");
      setAviso({
        tipo: "exito",
        texto: "El RUN no está registrado. Indique el nombre y el apellido tal como los conoce el club: la administración los verificará antes de registrar a la persona.",
      });
      return;
    }
    setRun("");
    setRecargas((n) => n + 1);
    if (r.resultado === "propuesta_creada") setAviso({ tipo: "exito", texto: mensajeDePropuesta(r.propuesta, r.repeticion) });
    else setAviso({ tipo: "exito", texto: mensajeDeSolicitud(r.solicitud, r.repeticion) });
  }

  function mensajeDeRechazo(err: unknown): Aviso {
    const codigo = err instanceof ApiError ? err.code : undefined;
    const texto = err instanceof Error ? err.message : "No se pudo completar la postulación.";
    switch (codigo) {
      case C.cuotaAgotada:
        return { tipo: "error", texto: "El club alcanzó los intentos de hoy (hora de Chile). Podrá volver a postular mañana." };
      case C.fueraDePeriodo:
        return {
          tipo: "error",
          texto: "La persona tiene una membresía activa en otro club. Un cambio de club solo puede postularse durante un periodo habilitado por la administración.",
        };
      case C.duplicado:
        return { tipo: "error", texto: "Ya hay una propuesta o solicitud pendiente para este RUN en el club, o la persona ya pertenece a él." };
      case C.intentoInterrumpido:
        return { tipo: "error", texto: "El intento anterior se interrumpió y ya contó en la cuota. Si corresponde, vuelva a postular: se tratará como una postulación nueva." };
      case C.idempotenciaConflicto:
        return { tipo: "error", texto: "La postulación anterior no coincide con la actual. Vuelva a postular: se tratará como una postulación nueva." };
      default:
        return { tipo: "error", texto };
    }
  }

  async function postular() {
    const actual = run.trim();
    if (!isValidRun(actual)) {
      // Validación local: no se envía y, por lo tanto, no gasta cuota.
      setErrorDeRun("El RUN no es válido. Revise los números y el dígito verificador (por ejemplo, 12.345.678-5).");
      return;
    }
    const testigo = operacion.iniciar();
    if (testigo === null) return;
    const normalizado = normalizeRun(actual);
    // Misma postulación (mismo RUN) tras un resultado incierto: MISMA clave. Si no, una nueva.
    const valor = clave && clave.run === normalizado ? clave.valor : nuevaClaveDeIdempotencia();
    setClave({ valor, run: normalizado });
    setAviso(null);
    try {
      const r = await api.postular(actual, valor);
      if (!montado.current) return;
      terminarPostulacion(r);
    } catch (err) {
      if (!montado.current) return;
      if (esIncierto(err)) {
        // Se conserva la clave: reintentar devuelve el estado real de ESTA postulación.
        setAviso({
          tipo: "incierto",
          texto:
            err instanceof ApiError && err.code === C.operacionEnCurso
              ? "La postulación todavía se está procesando. Consulte de nuevo en unos segundos."
              : "No se pudo confirmar si la postulación se registró. Puede reintentarla: se consultará la misma postulación, sin duplicarla.",
        });
      } else {
        setClave(null);
        setAviso(mensajeDeRechazo(err));
      }
    } finally {
      operacion.terminar(testigo);
      if (montado.current) void cargarContexto();
    }
  }

  async function completar() {
    if (!paso) return;
    // Tras un resultado incierto se reenvía EXACTAMENTE lo enviado, no lo que haya en los campos.
    const datos: EnvioSinConfirmar = sinConfirmar ?? { intentoId: paso.intentoId, nombres: nombres.trim(), apellidos: apellidos.trim() };
    if (datos.nombres.length < 2 || datos.apellidos.length < 2) return;
    const testigo = operacion.iniciar();
    if (testigo === null) return;
    setAviso(null);
    try {
      const r = await api.completarAlta(datos.intentoId, datos.nombres, datos.apellidos);
      if (!montado.current) return;
      setSinConfirmar(null);
      setPaso(null);
      setRun("");
      setRecargas((x) => x + 1);
      if (r.resultado === "propuesta_creada") {
        setAviso({
          tipo: "exito",
          texto:
            r.propuesta && r.propuesta.status !== "pending"
              ? mensajeDePropuesta(r.propuesta, r.repeticion)
              : mensajeDePropuesta(r.propuesta, r.repeticion, "La persona quedó registrada entre tanto: se envió una propuesta"),
        });
      } else if (r.resultado === "solicitud_alta_creada") {
        setAviso({ tipo: "exito", texto: mensajeDeSolicitud(r.solicitud, r.repeticion) });
      } else {
        // El segundo paso no pide otro paso; si llegara, se informa sin suponer su resultado.
        setAviso({ tipo: "incierto", texto: "El servidor respondió de una forma inesperada. Revise «Solicitudes de alta del club»." });
      }
    } catch (err) {
      if (!montado.current) return;
      if (esIncierto(err)) {
        // Repetir con los MISMOS datos devuelve el mismo resultado: no se duplica.
        setSinConfirmar(datos);
        setAviso({ tipo: "incierto", texto: "No se pudo confirmar el envío. Puede reintentarlo: se reenviarán exactamente los mismos datos y no se duplicará." });
        return;
      }
      setSinConfirmar(null);
      const codigo = err instanceof ApiError ? err.code : undefined;
      // Paso vencido, usado, inexistente o ya resuelto: no se puede continuar con este intento.
      setPaso(null);
      setRecargas((x) => x + 1);
      if (codigo === C.pasoVencido) setAviso({ tipo: "error", texto: "Venció el plazo para completar nombre y apellido. Inicie una postulación nueva." });
      else if (codigo === C.pasoYaUtilizado) setAviso({ tipo: "error", texto: "Este paso ya se completó con otros datos. Revise las solicitudes del club." });
      else if (codigo === C.pasoNoEncontrado || codigo === C.pasoNoDisponible)
        setAviso({ tipo: "error", texto: "Este paso ya no está disponible para su cuenta. Inicie una postulación nueva si corresponde." });
      else setAviso(mensajeDeRechazo(err));
    } finally {
      operacion.terminar(testigo);
    }
  }

  function descartarPaso() {
    if (operacion.ocupada()) return;
    const habiaEnvio = sinConfirmar !== null;
    setPaso(null);
    setSinConfirmar(null);
    setNombres("");
    setApellidos("");
    if (habiaEnvio) {
      // No es una cancelación: lo enviado pudo guardarse en el servidor.
      setRecargas((x) => x + 1);
      setAviso({
        tipo: "incierto",
        texto:
          "Se cerró el formulario sin confirmar el envío. La solicitud podría haberse guardado: revise «Solicitudes de alta del club» antes de volver a postular este RUN.",
      });
    } else {
      setAviso({ tipo: "exito", texto: "Se descartó el paso sin enviar datos. El intento ya contó en la cuota de hoy." });
    }
  }

  const ocupado = operacion.enCurso;
  const reintentable = aviso?.tipo === "incierto";

  return (
    <div className="c05-pantalla">
      <h1 style={{ color: "var(--brand-navy)" }}>Incorporaciones</h1>
      <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem", maxWidth: 760 }}>
        Postule a un nadador para su club ingresando solo su RUN. Toda postulación queda pendiente de revisión de la administración. Una persona sin membresía
        activa se puede postular durante todo el año; un cambio desde otro club, solo durante un periodo habilitado por la administración.
      </p>

      <section aria-label="Cuota y periodo" className="aviso">
        {errorDeContexto ? (
          <span className="error-message">
            {errorDeContexto}{" "}
            <button type="button" className="btn-secondary" onClick={() => void cargarContexto()} style={{ padding: "0.15rem 0.5rem", fontSize: "0.8rem" }}>
              Reintentar
            </button>
          </span>
        ) : (
          <>
            <div>
              {cuota
                ? `Intentos del club hoy (${formatearFechaCalendario(cuota.dia)}, hora de Chile): ${cuota.usados} de ${cuota.limite}. Quedan ${cuota.restantes}. La cuota es compartida por todas las cuentas del club.`
                : "Consultando la cuota…"}
            </div>
            <div style={{ marginTop: "0.3rem" }}>
              {periodo === null
                ? "Consultando el periodo de cambio…"
                : periodo.vigente
                  ? `Periodo de cambio de club habilitado del ${formatearFechaCalendario(periodo.inicio)} al ${formatearFechaCalendario(periodo.fin)} (inclusive).`
                  : "No hay un periodo de cambio habilitado: por ahora solo puede postular a personas sin membresía activa. Los periodos los abre la administración; no se abren solos en marzo ni en agosto."}
            </div>
          </>
        )}
      </section>

      {!paso && (
        <section style={{ maxWidth: 480 }} aria-labelledby={`${idRun}-titulo`}>
          <h2 id={`${idRun}-titulo`} style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>
            Postular por RUN
          </h2>
          <label htmlFor={idRun}>RUN del nadador</label>
          <input
            id={idRun}
            value={run}
            inputMode="text"
            autoComplete="off"
            placeholder="12.345.678-5"
            maxLength={20}
            disabled={ocupado}
            onChange={(e) => cambiarRun(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void postular();
            }}
            aria-invalid={errorDeRun ? true : undefined}
          />
          {errorDeRun && <p className="error-message">{errorDeRun}</p>}
          <button className="btn-primary" style={{ marginTop: "0.75rem" }} onClick={() => void postular()} disabled={ocupado || run.trim() === ""}>
            {ocupado ? "Enviando…" : reintentable && clave ? "Reintentar la misma postulación" : "Postular"}
          </button>
        </section>
      )}

      {paso && (
        <section style={{ maxWidth: 520 }} aria-labelledby={`${idRun}-paso`}>
          <h2 id={`${idRun}-paso`} style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>
            Datos declarados por el club
          </h2>
          <p style={{ fontSize: "0.9rem" }}>
            RUN {paso.run}. Complete antes de las {hora(paso.expiraEn)} (hora de Chile). Estos datos los declara el club y no se registran como verificados.
          </p>
          <label htmlFor={`${idRun}-nombres`}>Nombre</label>
          <input
            id={`${idRun}-nombres`}
            value={nombres}
            maxLength={120}
            // Con un envío sin confirmar, lo enviado queda fijo hasta conocer su resultado.
            disabled={ocupado || sinConfirmar !== null}
            onChange={(e) => {
              if (!sinConfirmar) setNombres(e.target.value);
            }}
          />
          <label htmlFor={`${idRun}-apellidos`}>Apellido</label>
          <input
            id={`${idRun}-apellidos`}
            value={apellidos}
            maxLength={120}
            disabled={ocupado || sinConfirmar !== null}
            onChange={(e) => {
              if (!sinConfirmar) setApellidos(e.target.value);
            }}
          />
          {sinConfirmar && (
            <p className="aviso aviso-advertencia" style={{ marginTop: "0.6rem" }}>
              Pendiente de confirmar: {sinConfirmar.nombres} {sinConfirmar.apellidos}. Es lo que se envió y lo que se reenviará al reintentar.
            </p>
          )}
          <div className="dialogo-acciones" style={{ justifyContent: "flex-start" }}>
            <button
              className="btn-primary"
              onClick={() => void completar()}
              disabled={ocupado || (!sinConfirmar && (nombres.trim().length < 2 || apellidos.trim().length < 2))}
            >
              {ocupado ? "Enviando…" : sinConfirmar ? "Reintentar el envío" : "Enviar solicitud de alta"}
            </button>
            <button className="btn-secondary" onClick={descartarPaso} disabled={ocupado}>
              {sinConfirmar ? "Cerrar sin confirmar" : "Descartar"}
            </button>
          </div>
        </section>
      )}

      {aviso && (
        <p
          className={`aviso ${aviso.tipo === "error" ? "aviso-peligro" : aviso.tipo === "incierto" ? "aviso-advertencia" : ""}`}
          role={aviso.tipo === "exito" ? "status" : "alert"}
          style={{ maxWidth: 760 }}
        >
          {aviso.texto}
        </p>
      )}

      <PropuestasDelClub recargas={recargas} />
      <SolicitudesDelClub recargas={recargas} />
    </div>
  );
}

const POR_PAGINA = 20;
const ESTADO_PROPUESTA: Record<AssignmentStatus, string> = {
  pending: "Pendiente de revisión",
  rejected: "Rechazada",
  active: "Aprobada (activa)",
  ended: "Finalizada",
};
const ESTADO_ALTA: Record<EstadoSolicitudAlta, string> = {
  pendiente: "Pendiente de revisión",
  aprobada: "Aprobada",
  rechazada: "Rechazada",
  resuelta_por_propuesta: "Resuelta por una propuesta existente",
};

/** Página paginada del club, con descarte de respuestas de un filtro o página anteriores. */
function usePaginaDelClub<T>(pedir: (page: number) => Promise<unknown>, clave: string) {
  const [page, setPage] = useState(1);
  const [datos, setDatos] = useState<{ items: T[]; total: number; pageSize: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const vigente = useRef(0);
  const [claveAnterior, setClaveAnterior] = useState(clave);
  if (clave !== claveAnterior) {
    setClaveAnterior(clave);
    setPage(1);
  }
  useEffect(() => {
    const n = ++vigente.current;
    setError(null);
    pedir(page)
      .then((r) => {
        if (n !== vigente.current) return;
        const p = validarPaginaRecibida<T>(r, page, POR_PAGINA);
        setDatos({ items: p.items, total: p.total, pageSize: p.pageSize });
      })
      .catch((err) => {
        if (n !== vigente.current) return;
        setDatos(null);
        setError(err instanceof Error ? err.message : "No se pudo cargar la lista.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave, page]);
  return { page, setPage, datos, error };
}

function Paginador({ page, total, pageSize, setPage }: { page: number; total: number; pageSize: number; setPage: (f: (p: number) => number) => void }) {
  return (
    <div style={{ marginTop: "0.5rem", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
      <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
        {total} registro(s) — página {page}
      </span>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          Anterior
        </button>
        <button className="btn-secondary" disabled={page * pageSize >= total} onClick={() => setPage((p) => p + 1)}>
          Siguiente
        </button>
      </div>
    </div>
  );
}

function PropuestasDelClub({ recargas }: { recargas: number }) {
  const api = usePostulacionApi();
  const [filtro, setFiltro] = useState<"pending" | "rejected" | "">("pending");
  const { page, setPage, datos, error } = usePaginaDelClub<ClubSwimmerAssignment>(
    (p) => api.propuestas({ status: filtro || undefined, page: p, pageSize: POR_PAGINA }),
    `${filtro}|${recargas}`
  );
  return (
    <section style={{ marginTop: "1.5rem" }} aria-label="Propuestas del club">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Propuestas del club</h2>
        <select aria-label="Estado de las propuestas" value={filtro} onChange={(e) => setFiltro(e.target.value as typeof filtro)} style={{ maxWidth: 240 }}>
          <option value="pending">Pendientes</option>
          <option value="rejected">Rechazadas</option>
          <option value="">Todas</option>
        </select>
      </div>
      <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", margin: "0.2rem 0 0.5rem" }}>Nombre y RUN son los de la persona registrada.</p>
      {error && <p className="error-message">{error}</p>}
      {datos && (
        <>
          <div className="tabla-desplazable">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nadador</th>
                  <th>RUN</th>
                  <th>Estado</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {datos.items.map((p) => (
                  <tr key={p.id}>
                    <td>{p.person.fullName}</td>
                    <td>{p.person.run}</td>
                    <td>{ESTADO_PROPUESTA[p.status]}</td>
                    <td>{p.status === "rejected" && p.rejectionReason ? `Motivo: ${p.rejectionReason}` : "—"}</td>
                  </tr>
                ))}
                {datos.items.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1rem" }}>
                      No hay propuestas en este estado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {datos.total > 0 && <Paginador page={page} total={datos.total} pageSize={datos.pageSize} setPage={setPage} />}
        </>
      )}
    </section>
  );
}

function SolicitudesDelClub({ recargas }: { recargas: number }) {
  const api = usePostulacionApi();
  const [filtro, setFiltro] = useState<EstadoSolicitudAlta | "">("pendiente");
  const { page, setPage, datos, error } = usePaginaDelClub<SolicitudAlta>(
    (p) => api.solicitudes({ estado: filtro || undefined, page: p, pageSize: POR_PAGINA }),
    `${filtro}|${recargas}`
  );
  return (
    <section style={{ marginTop: "1.5rem" }} aria-label="Solicitudes de alta del club">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Solicitudes de alta del club</h2>
        <select aria-label="Estado de las solicitudes" value={filtro} onChange={(e) => setFiltro(e.target.value as typeof filtro)} style={{ maxWidth: 260 }}>
          <option value="pendiente">Pendientes</option>
          <option value="aprobada">Aprobadas</option>
          <option value="resuelta_por_propuesta">Resueltas por propuesta</option>
          <option value="rechazada">Rechazadas</option>
          <option value="">Todas</option>
        </select>
      </div>
      <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", margin: "0.2rem 0 0.5rem" }}>
        «Declarado por el club» son los nombres que envió el club; «Verificado» es la persona registrada por la administración al resolver.
      </p>
      {error && <p className="error-message">{error}</p>}
      {datos && (
        <>
          <div className="tabla-desplazable">
            <table className="data-table">
              <thead>
                <tr>
                  <th>RUN</th>
                  <th>Declarado por el club</th>
                  <th>Verificado</th>
                  <th>Estado</th>
                  <th>Recibida</th>
                </tr>
              </thead>
              <tbody>
                {datos.items.map((s) => (
                  <tr key={s.id}>
                    <td>{s.run}</td>
                    <td>
                      {s.nombres} {s.apellidos}
                    </td>
                    <td>{s.persona ? s.persona.fullName : "Sin verificar"}</td>
                    <td>
                      {ESTADO_ALTA[s.estado]}
                      {s.estado === "rechazada" && s.motivoRechazo ? ` — ${s.motivoRechazo}` : ""}
                    </td>
                    <td>{instante(s.creadoEn)}</td>
                  </tr>
                ))}
                {datos.items.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1rem" }}>
                      No hay solicitudes en este estado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {datos.total > 0 && <Paginador page={page} total={datos.total} pageSize={datos.pageSize} setPage={setPage} />}
        </>
      )}
    </section>
  );
}
