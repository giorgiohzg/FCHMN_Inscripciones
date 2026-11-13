import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { diaCalendarioAnterior, esFechaCalendarioExistente, formatearFechaCalendario } from "../../shared/fechaCalendario";
import { traerTodasLasPaginas } from "../../shared/paginacion";
import { useOperacionUnica, type OperacionUnica } from "../../shared/useOperacionUnica";
import {
  CODIGOS,
  codigoDelError,
  conflictosDelError,
  membresiasIncompletasDelError,
  useSwimmerAssignmentApi,
  type ClubSwimmerAssignment,
  type OpcionesDeActivacion,
} from "./assignmentApi";

/**
 * C-05: REVISIÓN Y CONFIRMACIÓN de una activación (aprobar, reasignar, asignar directo, resolver
 * un alta). Decide solo con CÓDIGOS y `details` estructurados, nunca con el texto del mensaje.
 *
 * - Fecha efectiva visible, hoy o anterior (máximo hoy en Santiago).
 * - Traslado (`permiteTraslado`): muestra origen, destino y fechas, y exige marcar EXPRESAMENTE la
 *   membresía vigente que se finaliza. Su id es el que se revisó, no uno sacado de un mensaje.
 * - `REVISAR_DE_NUEVO` / `CONFIRMACION_REQUERIDA`: recarga, desmarca y exige revisar otra vez.
 *   No reintenta solo.
 * - `HISTORIAL_INCOMPLETO`: muestra las membresías afectadas y pide una aceptación SIN marcar.
 * - `CONFLICTO_DE_FECHAS`: se muestra y NO se ofrece aceptación: no se puede eludir.
 * - Sin traslado (`/direct`): una membresía activa en otro club bloquea la confirmación.
 *
 * HISTORIAL COMPLETO: se recorren TODAS las páginas del listado (orden estable del backend). Con
 * una página sola no se puede afirmar que no hay membresía activa; si el recorrido no se puede
 * garantizar completo, falla y no se permite confirmar.
 *
 * UNA OPERACIÓN: el envío usa la `operacion` del contenedor si la recibe, para que el contenedor
 * bloquee su cierre y sus otras acciones mientras dure. Cerrar no cancela una petición enviada.
 */
export function PanelDeActivacion({
  personaId,
  clubDestino,
  permiteTraslado,
  hoy,
  etiquetaConfirmar,
  enviar,
  onExito,
  onCancelar,
  onErrorNoManejado,
  bloqueoExterno,
  excluirMembresiaId,
  operacion,
  children,
}: {
  /** null = persona nueva (aún no existe): no hay historial que revisar. */
  personaId: string | null;
  clubDestino: { id: string; name: string };
  permiteTraslado: boolean;
  hoy: string;
  etiquetaConfirmar: string;
  enviar: (opciones: OpcionesDeActivacion) => Promise<unknown>;
  onExito: (resultado: unknown) => void;
  onCancelar: () => void;
  /** Errores que el panel no interpreta (p. ej. los de una solicitud de alta). */
  onErrorNoManejado?: (err: unknown) => void;
  /** Motivo por el que aún no se puede confirmar (formulario externo incompleto). */
  bloqueoExterno?: string | null;
  /** La propuesta que se aprueba no es «otra membresía». */
  excluirMembresiaId?: string;
  /** Barrera del contenedor (diálogo, ficha). Sin ella el panel usa una propia. */
  operacion?: OperacionUnica;
  children?: ReactNode;
}) {
  const api = useSwimmerAssignmentApi();
  const idFecha = useId();
  const [membresias, setMembresias] = useState<ClubSwimmerAssignment[] | null>(personaId ? null : []);
  const [errorDeCarga, setErrorDeCarga] = useState<string | null>(null);
  const [fecha, setFecha] = useState(hoy);
  const [confirmaTraslado, setConfirmaTraslado] = useState(false);
  const [incompletas, setIncompletas] = useState<string[] | null>(null);
  const [aceptaIncompleto, setAceptaIncompleto] = useState(false);
  const [conflictos, setConflictos] = useState<{ membresiaId: string; motivo: string }[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const propia = useOperacionUnica();
  const op = operacion ?? propia;
  const enviando = op.enCurso;

  /**
   * OTRA PERSONA U OTRO DESTINO = OTRA REVISIÓN. Se reinicia durante el render (el patrón de React
   * para derivar estado de props): nada de lo confirmado o aceptado para el contexto anterior
   * sobrevive, y la carga anterior queda descartada por `cargaVigente`.
   */
  const contexto = `${personaId ?? ""}|${clubDestino.id}`;
  const [contextoAnterior, setContextoAnterior] = useState(contexto);
  if (contexto !== contextoAnterior) {
    setContextoAnterior(contexto);
    setMembresias(personaId ? null : []);
    setErrorDeCarga(null);
    setFecha(hoy);
    setConfirmaTraslado(false);
    setIncompletas(null);
    setAceptaIncompleto(false);
    setConflictos([]);
    setAviso(null);
    setError(null);
  }
  /** Solo la última carga puede aplicar su respuesta; al desmontar, ninguna. */
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
    if (!personaId) return;
    const n = ++cargaVigente.current;
    setMembresias(null);
    setErrorDeCarga(null);
    try {
      // TODAS las páginas: la activa puede estar en cualquiera. Lanza si no se puede garantizar.
      const todas = await traerTodasLasPaginas((page, pageSize) => api.list({ personId: personaId, page, pageSize }));
      if (!montado.current || n !== cargaVigente.current) return;
      setMembresias(todas);
    } catch (err) {
      if (!montado.current || n !== cargaVigente.current) return;
      setErrorDeCarga(err instanceof Error ? err.message : "No se pudo cargar el historial del nadador.");
    }
    // Depende del MISMO contexto que el reinicio de arriba (persona Y destino). Con solo la persona,
    // cambiar el destino vaciaba `membresias` sin volver a cargarlas: el panel quedaba sin historial
    // y sin poder confirmar. Una carga anterior en vuelo queda descartada por `cargaVigente`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contexto]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const otras = (membresias ?? []).filter((m) => m.id !== excluirMembresiaId);
  const vigente = otras.find((m) => m.status === "active" && m.club.id !== clubDestino.id) ?? null;
  const yaPertenece = otras.some((m) => m.status === "active" && m.club.id === clubDestino.id);
  const porId = new Map(otras.map((m) => [m.id, m]));

  function cambiarFecha(v: string) {
    setFecha(v);
    // Lo confirmado y aceptado se refería a la fecha anterior: se revisa de nuevo.
    setConfirmaTraslado(false);
    setIncompletas(null);
    setAceptaIncompleto(false);
    setConflictos([]);
    setError(null);
  }

  let problema: string | null = null;
  if (membresias === null) problema = errorDeCarga ? "No se pudo cargar el historial." : "Cargando el historial…";
  else if (!esFechaCalendarioExistente(fecha)) problema = "Indique una fecha efectiva válida.";
  else if (fecha > hoy) problema = `La fecha efectiva no puede ser posterior a hoy (${formatearFechaCalendario(hoy)}).`;
  else if (yaPertenece) problema = `El nadador ya pertenece activamente a ${clubDestino.name}.`;
  else if (vigente && !permiteTraslado) problema = `Tiene una membresía activa en ${vigente.club.name}: esta vía no traslada. Use «Cambiar de club» en la ficha de la persona.`;
  else if (vigente && !confirmaTraslado) problema = "Confirme expresamente la membresía vigente que se finalizará.";
  else if (incompletas && !aceptaIncompleto) problema = "Acepte expresamente el historial incompleto, o cancele.";
  else if (bloqueoExterno) problema = bloqueoExterno;

  async function confirmar() {
    if (problema) return;
    // Reserva SÍNCRONA y compartida: un segundo clic o una acción exterior no pasan.
    const testigo = op.iniciar();
    if (testigo === null) return;
    setError(null);
    setAviso(null);
    const opciones: OpcionesDeActivacion = { fechaEfectiva: fecha };
    if (vigente && confirmaTraslado) opciones.confirmarFinDeMembresiaId = vigente.id;
    if (incompletas && aceptaIncompleto) opciones.aceptarHistorialIncompleto = true;
    try {
      const r = await enviar(opciones);
      if (montado.current) onExito(r);
    } catch (err) {
      if (!montado.current) return;
      const codigo = codigoDelError(err);
      if (codigo === CODIGOS.revisarDeNuevo || codigo === CODIGOS.confirmacionRequerida) {
        setConfirmaTraslado(false);
        setIncompletas(null);
        setAceptaIncompleto(false);
        setAviso("La membresía vigente del nadador cambió desde que se cargó esta revisión. Se recargó la información: revísela y confirme otra vez.");
        void cargar();
      } else if (codigo === CODIGOS.historialIncompleto) {
        setIncompletas(membresiasIncompletasDelError(err));
        setAceptaIncompleto(false);
        void cargar();
      } else if (codigo === CODIGOS.conflictoDeFechas) {
        setConflictos(conflictosDelError(err));
        setError(err instanceof Error ? err.message : "La fecha contradice el historial.");
      } else {
        setError(err instanceof Error ? err.message : "No se pudo completar la operación.");
        onErrorNoManejado?.(err);
      }
    } finally {
      op.terminar(testigo);
    }
  }

  const fechaSegura = esFechaCalendarioExistente(fecha) ? fecha : null;

  return (
    <div>
      {children}

      <label htmlFor={idFecha}>Fecha efectiva (inicio en {clubDestino.name})</label>
      <input id={idFecha} type="date" required value={fecha} max={hoy} onChange={(e) => cambiarFecha(e.target.value)} disabled={enviando} />
      <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", margin: "0.3rem 0 0" }}>Hoy o anterior (hora de Chile). No se programan activaciones futuras.</p>

      {errorDeCarga && (
        <p className="error-message">
          {errorDeCarga}{" "}
          <button type="button" className="btn-secondary" onClick={() => void cargar()} style={{ padding: "0.15rem 0.5rem", fontSize: "0.8rem" }}>
            Reintentar
          </button>
        </p>
      )}
      {aviso && (
        <p className="aviso aviso-advertencia" role="alert">
          {aviso}
        </p>
      )}

      {vigente && permiteTraslado && (
        <div className="aviso aviso-advertencia">
          <strong>Traslado.</strong>
          <dl className="ficha-datos">
            <dt>Club de origen</dt>
            <dd>{vigente.club.name}</dd>
            <dt>Inicio en el origen</dt>
            <dd>{vigente.startDate ? formatearFechaCalendario(vigente.startDate) : "Desconocido"}</dd>
            <dt>Último día en el origen</dt>
            <dd>{fechaSegura ? formatearFechaCalendario(diaCalendarioAnterior(fechaSegura)) : "—"}</dd>
            <dt>Club de destino</dt>
            <dd>{clubDestino.name}</dd>
            <dt>Inicio en el destino</dt>
            <dd>{fechaSegura ? formatearFechaCalendario(fechaSegura) : "—"}</dd>
          </dl>
          <label className="casilla">
            <input type="checkbox" checked={confirmaTraslado} onChange={(e) => setConfirmaTraslado(e.target.checked)} disabled={enviando} />
            Confirmo finalizar la membresía vigente en {vigente.club.name}.
          </label>
        </div>
      )}
      {vigente && !permiteTraslado && (
        <p className="aviso aviso-peligro">
          Tiene una membresía activa en <strong>{vigente.club.name}</strong>. La asignación directa y la masiva no trasladan: use «Cambiar de club» en la ficha de la persona.
        </p>
      )}
      {!vigente && membresias !== null && personaId && <p className="aviso">Club de destino: {clubDestino.name}. El nadador no tiene otra membresía activa.</p>}

      {incompletas && (
        <div className="aviso aviso-advertencia" role="alert">
          <p style={{ margin: "0 0 0.4rem" }}>
            <strong>Historial incompleto.</strong> Estas membresías anteriores tienen fechas desconocidas y no se puede descartar un solapamiento. No se completará
            ninguna fecha; la aceptación queda en la auditoría.
          </p>
          <ul style={{ margin: "0 0 0.4rem", paddingLeft: "1.2rem" }}>
            {incompletas.map((id) => {
              const m = porId.get(id);
              return (
                <li key={id}>
                  {m
                    ? `${m.club.name}: inicio ${m.startDate ? formatearFechaCalendario(m.startDate) : "desconocido"}, término ${m.fechaTermino ? formatearFechaCalendario(m.fechaTermino) : "desconocido"}`
                    : "Membresía que ya no figura en el historial cargado"}
                </li>
              );
            })}
          </ul>
          <label className="casilla">
            <input type="checkbox" checked={aceptaIncompleto} onChange={(e) => setAceptaIncompleto(e.target.checked)} disabled={enviando} />
            Acepto, como administración, el historial incompleto.
          </label>
        </div>
      )}

      {conflictos.length > 0 && (
        <div className="aviso aviso-peligro" role="alert">
          <strong>Conflicto de fechas.</strong> La fecha contradice fechas registradas y no se puede aceptar: elija otra fecha.
          <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.2rem" }}>
            {conflictos.map((c) => (
              <li key={c.membresiaId}>{porId.get(c.membresiaId)?.club.name ? `${porId.get(c.membresiaId)!.club.name}: ${c.motivo}` : c.motivo}</li>
            ))}
          </ul>
        </div>
      )}

      {problema && membresias !== null && <p className="error-message">{problema}</p>}
      {error && conflictos.length === 0 && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}

      <div className="dialogo-acciones">
        <button type="button" className="btn-secondary" onClick={onCancelar} disabled={enviando}>
          Cancelar
        </button>
        <button type="button" className="btn-primary" onClick={() => void confirmar()} disabled={problema !== null || enviando}>
          {enviando ? "Enviando…" : etiquetaConfirmar}
        </button>
      </div>
    </div>
  );
}
