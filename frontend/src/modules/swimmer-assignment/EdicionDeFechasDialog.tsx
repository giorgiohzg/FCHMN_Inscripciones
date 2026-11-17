import { useId, useState, type ReactNode } from "react";
import { Dialogo } from "../../shared/Dialogo";
import { esFechaCalendarioExistente, formatearFechaCalendario } from "../../shared/fechaCalendario";
import { useOperacionUnica } from "../../shared/useOperacionUnica";
import {
  CODIGOS,
  codigoDelError,
  conflictosDelError,
  useSwimmerAssignmentApi,
  type ClubSwimmerAssignment,
  type DatosDeFechas,
} from "./assignmentApi";

/**
 * CORRECCIÓN DE DESDE Y HASTA (solo administración). El MISMO diálogo en Asignación de
 * Nadadores a Clubes, en el plantel de Editar Club y en el historial de Editar Persona: la
 * validación definitiva es la del servidor (`PUT /swimmer-assignments/:id/fechas`).
 *
 *  - Fechas de calendario (`AAAA-MM-DD`), con máximo HOY en America/Santiago.
 *  - Activa: solo DESDE; su HASTA lo pone la baja, no esta corrección.
 *  - Finalizada: DESDE y HASTA, con HASTA igual o posterior a DESDE (el mismo día vale).
 *  - Una fecha conocida no se puede vaciar, y una desconocida se deja como está si no se indica:
 *    no se completa nada por cuenta propia. Solo se envía lo que cambió.
 *  - Corregir fechas no cambia el estado de la membresía.
 *  - Superposición o historial con fechas desconocidas: lo decide el servidor con el historial
 *    bloqueado. Para un historial incompleto se pide la aceptación EXPLÍCITA de administración.
 */
export function EdicionDeFechasDialog({
  membresia,
  hoy,
  onCancelar,
  onGuardado,
  nadador,
}: {
  membresia: Pick<ClubSwimmerAssignment, "id" | "status" | "startDate" | "fechaTermino"> & {
    person: { fullName: string };
    club: { name: string };
  };
  /** Hoy en America/Santiago (`AAAA-MM-DD`). */
  hoy: string;
  onCancelar: () => void;
  onGuardado: (actualizada: ClubSwimmerAssignment) => void;
  /** Cómo mostrar al nadador. Sin indicarlo, su nombre completo tal como está guardado. */
  nadador?: ReactNode;
}) {
  const api = useSwimmerAssignmentApi();
  const operacion = useOperacionUnica();
  const idDesde = useId();
  const idHasta = useId();
  const finalizada = membresia.status === "ended";
  const desdeActual = membresia.startDate ? membresia.startDate.slice(0, 10) : "";
  const hastaActual = finalizada && membresia.fechaTermino ? membresia.fechaTermino.slice(0, 10) : "";

  const [desde, setDesde] = useState(desdeActual);
  const [hasta, setHasta] = useState(hastaActual);
  /** El servidor pidió aceptar un historial incompleto; se pide de nuevo si cambian las fechas. */
  const [pideAceptacion, setPideAceptacion] = useState(false);
  const [acepta, setAcepta] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [motivos, setMotivos] = useState<string[]>([]);

  const cambiar = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setPideAceptacion(false);
    setAcepta(false);
    setError(null);
    setMotivos([]);
  };

  const datos: DatosDeFechas = {};
  if (desde !== desdeActual && desde !== "") datos.startDate = desde;
  if (finalizada && hasta !== hastaActual && hasta !== "") datos.fechaTermino = hasta;
  const inicioEfectivo = desde || null;
  const terminoEfectivo = finalizada ? hasta || null : null;

  let problema: string | null = null;
  if (desdeActual && desde === "") problema = "DESDE ya tiene una fecha registrada: corregir no la borra.";
  else if (hastaActual && hasta === "") problema = "HASTA ya tiene una fecha registrada: corregir no la borra.";
  else if (desde && !esFechaCalendarioExistente(desde)) problema = "DESDE: esa fecha no existe.";
  else if (hasta && !esFechaCalendarioExistente(hasta)) problema = "HASTA: esa fecha no existe.";
  else if (desde > hoy) problema = `DESDE no puede ser posterior a hoy (${formatearFechaCalendario(hoy)}, hora de Chile).`;
  else if (hasta > hoy) problema = `HASTA no puede ser posterior a hoy (${formatearFechaCalendario(hoy)}, hora de Chile).`;
  else if (inicioEfectivo && terminoEfectivo && terminoEfectivo < inicioEfectivo)
    problema = "HASTA no puede ser anterior a DESDE (el mismo día sí es válido).";
  else if (datos.startDate === undefined && datos.fechaTermino === undefined) problema = "No hay cambios que guardar.";
  else if (pideAceptacion && !acepta) problema = "Debe aceptar expresamente el historial con fechas desconocidas.";

  async function guardar() {
    if (problema) return;
    const testigo = operacion.iniciar();
    if (testigo === null) return;
    setError(null);
    setMotivos([]);
    try {
      const actualizada = await api.editarFechas(
        membresia.id,
        pideAceptacion && acepta ? { ...datos, aceptarHistorialIncompleto: true } : datos
      );
      onGuardado(actualizada);
    } catch (err) {
      const codigo = codigoDelError(err);
      if (codigo === CODIGOS.historialIncompleto) {
        setPideAceptacion(true);
        setAcepta(false);
      } else if (codigo === CODIGOS.conflictoDeFechas) {
        setMotivos(conflictosDelError(err).map((c) => c.motivo));
      }
      setError(err instanceof Error ? err.message : "No se pudieron guardar las fechas.");
    } finally {
      operacion.terminar(testigo);
    }
  }

  const enviando = operacion.enCurso;
  return (
    <Dialogo titulo="Corregir fechas de pertenencia" onCerrar={onCancelar} bloqueado={enviando}>
      <dl className="ficha-datos">
        <dt>Nadador</dt>
        <dd>{nadador ?? membresia.person.fullName}</dd>
        <dt>Club</dt>
        <dd>{membresia.club.name}</dd>
        <dt>Estado</dt>
        <dd>{finalizada ? "Finalizada" : "Activa"}</dd>
      </dl>

      <label htmlFor={idDesde}>DESDE (primer día de pertenencia)</label>
      <input id={idDesde} type="date" value={desde} max={hoy} onChange={(e) => cambiar(setDesde)(e.target.value)} disabled={enviando} />
      {!desdeActual && (
        <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", margin: "0.3rem 0 0" }}>
          Hoy es desconocida. Si no la indica, sigue siendo desconocida.
        </p>
      )}

      {finalizada ? (
        <>
          <label htmlFor={idHasta} style={{ marginTop: "0.75rem" }}>
            HASTA (último día de pertenencia, inclusive)
          </label>
          <input
            id={idHasta}
            type="date"
            value={hasta}
            max={hoy}
            min={desde || undefined}
            onChange={(e) => cambiar(setHasta)(e.target.value)}
            disabled={enviando}
          />
          {!hastaActual && (
            <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", margin: "0.3rem 0 0" }}>
              Hoy es desconocida. Si no la indica, sigue siendo desconocida.
            </p>
          )}
        </>
      ) : (
        <p style={{ fontSize: "0.85rem", margin: "0.75rem 0 0" }}>
          HASTA: sin término, porque la membresía está activa. El término se registra con «Finalizar membresía», no con esta corrección.
        </p>
      )}

      <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", margin: "0.6rem 0 0" }}>
        Las fechas no pueden ser posteriores a hoy ni superponerse con otra membresía del nadador: una nueva pertenencia empieza después del
        último día de la anterior. Corregir fechas no cambia el estado de la membresía ni modifica inscripciones.
      </p>

      {pideAceptacion && (
        <div className="aviso aviso-advertencia" role="alert">
          <p style={{ margin: "0 0 0.4rem" }}>
            El historial del nadador tiene fechas desconocidas y no se puede descartar una superposición. No se completará ninguna fecha. La
            aceptación queda en la auditoría.
          </p>
          <label className="casilla">
            <input type="checkbox" checked={acepta} onChange={(e) => setAcepta(e.target.checked)} disabled={enviando} />
            Acepto, como administración, guardar estas fechas con el historial incompleto.
          </label>
        </div>
      )}

      {problema && (desde !== desdeActual || hasta !== hastaActual) && <p className="error-message">{problema}</p>}
      {error && !pideAceptacion && (
        <div className="error-message" role="alert">
          <p style={{ margin: 0 }}>{error}</p>
          {motivos.length > 0 && (
            <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.2rem" }}>
              {motivos.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="dialogo-acciones">
        <button type="button" className="btn-secondary" onClick={onCancelar} disabled={enviando}>
          Cancelar
        </button>
        <button type="button" className="btn-primary" onClick={() => void guardar()} disabled={problema !== null || enviando}>
          {enviando ? "Guardando…" : "Guardar fechas"}
        </button>
      </div>
    </Dialogo>
  );
}
