import { useId, useState } from "react";
import { Dialogo } from "../../shared/Dialogo";
import { esFechaCalendarioExistente, formatearFechaCalendario } from "../../shared/fechaCalendario";
import type { ClubSwimmerAssignment, DatosDeBaja } from "./assignmentApi";

/**
 * C-05: BAJA SIMPLE con fecha de término ELEGIDA.
 *
 * - La fecha es obligatoria y empieza VACÍA: no hay un valor por omisión oculto.
 * - Calendario con máximo HOY (America/Santiago) y mínimo el INICIO conocido; puede ser
 *   retroactiva (una renuncia comunicada después). El mismo día del inicio es válido.
 * - Inicio desconocido: advertencia y aceptación administrativa EXPLÍCITA, sin marcar.
 * - Cancelar no envía nada; confirmar envía la fecha expresamente.
 */
export function BajaDeMembresiaDialog({
  membresia,
  hoy,
  enviando,
  error,
  onCancelar,
  onConfirmar,
}: {
  membresia: Pick<ClubSwimmerAssignment, "id" | "startDate" | "person" | "club">;
  /** Hoy en America/Santiago (`AAAA-MM-DD`). */
  hoy: string;
  enviando: boolean;
  error: string | null;
  onCancelar: () => void;
  onConfirmar: (datos: DatosDeBaja) => void;
}) {
  const idFecha = useId();
  const [fecha, setFecha] = useState("");
  const [aceptaInicioDesconocido, setAceptaInicioDesconocido] = useState(false);
  const inicio = membresia.startDate ? membresia.startDate.slice(0, 10) : null;

  let problema: string | null = null;
  if (fecha === "") problema = "Indique la fecha de término.";
  else if (!esFechaCalendarioExistente(fecha)) problema = "Esa fecha no existe.";
  else if (fecha > hoy) problema = `No puede ser posterior a hoy (${formatearFechaCalendario(hoy)}, hora de Chile).`;
  else if (inicio && fecha < inicio) problema = `No puede ser anterior al inicio de la membresía (${formatearFechaCalendario(inicio)}).`;
  else if (!inicio && !aceptaInicioDesconocido) problema = "Debe aceptar expresamente que el inicio es desconocido.";

  function confirmar() {
    // El padre reserva la operación de forma síncrona: un segundo clic no envía otra.
    if (problema || enviando) return;
    onConfirmar(inicio ? { fechaTermino: fecha } : { fechaTermino: fecha, aceptarHistorialIncompleto: true });
  }

  return (
    <Dialogo titulo="Baja de membresía" onCerrar={onCancelar} bloqueado={enviando}>
      <dl className="ficha-datos">
        <dt>Nadador</dt>
        <dd>
          {membresia.person.fullName} ({membresia.person.run})
        </dd>
        <dt>Club</dt>
        <dd>{membresia.club.name}</dd>
        <dt>Inicio</dt>
        <dd>{inicio ? formatearFechaCalendario(inicio) : "Desconocido"}</dd>
      </dl>

      <label htmlFor={idFecha}>Fecha de término (último día de pertenencia)</label>
      <input
        id={idFecha}
        type="date"
        required
        value={fecha}
        max={hoy}
        min={inicio ?? undefined}
        onChange={(e) => setFecha(e.target.value)}
        disabled={enviando}
        aria-describedby={`${idFecha}-ayuda`}
      />
      <p id={`${idFecha}-ayuda`} style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", margin: "0.3rem 0 0" }}>
        Es el último día en que el nadador perteneció al club (inclusive). Puede ser anterior a hoy, por ejemplo una renuncia comunicada después;
        no puede ser posterior a hoy{inicio ? " ni anterior al inicio" : ""}. Registrar la baja no modifica inscripciones ni operaciones anteriores.
        Si el término es hoy, otra membresía solo podrá comenzar después de hoy.
      </p>

      {!inicio && (
        <div className="aviso aviso-advertencia" role="alert">
          <p style={{ margin: "0 0 0.4rem" }}>
            Esta membresía no tiene fecha de inicio registrada: la fecha de término no se puede comprobar contra ella. No se completará ningún
            inicio. Solo administración puede aceptar esta incertidumbre, y la aceptación queda en la auditoría.
          </p>
          <label className="casilla">
            <input type="checkbox" checked={aceptaInicioDesconocido} onChange={(e) => setAceptaInicioDesconocido(e.target.checked)} disabled={enviando} />
            Acepto, como administración, registrar la baja con el inicio desconocido.
          </label>
        </div>
      )}

      {fecha !== "" && problema && <p className="error-message">{problema}</p>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}

      <div className="dialogo-acciones">
        <button type="button" className="btn-secondary" onClick={onCancelar} disabled={enviando}>
          Cancelar
        </button>
        <button type="button" className="btn-danger" onClick={confirmar} disabled={problema !== null || enviando}>
          {enviando ? "Registrando…" : "Confirmar baja"}
        </button>
      </div>
    </Dialogo>
  );
}
