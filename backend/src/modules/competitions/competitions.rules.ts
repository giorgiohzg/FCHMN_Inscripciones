/**
 * Estado del ciclo de vida de una competencia (sección 10) y las reglas de
 * apertura/cierre automático de inscripciones (RB-07). Se aísla como
 * función pura para poder testear sin base de datos y para poder aplicarse
 * tanto de forma perezosa (al leer una competencia) como desde un futuro
 * job programado, sin duplicar lógica.
 */
export type CompetitionStatus = "draft" | "scheduled" | "open" | "closed" | "in_progress" | "finished" | "cancelled";
export type CompetitionAction = "schedule" | "cancel" | "closeRegistrations" | "start" | "finish";

/**
 * Avanza el estado automáticamente según la fecha actual, SOLO entre
 * 'scheduled' -> 'open' -> 'closed' (forward-only). Nunca "retrocede" y
 * nunca toca estados que ya son terminales o manuales para el auto-cómputo
 * (draft, closed, in_progress, finished, cancelled) — esos requieren una
 * acción explícita del administrador para cambiar.
 */
export function computeEffectiveStatus(current: CompetitionStatus, registrationStartAt: Date, registrationEndAt: Date, now: Date): CompetitionStatus {
  // Solo 'scheduled' y 'open' se recalculan automáticamente. 'closed' es
  // terminal para el auto-cómputo (pudo haberse cerrado manualmente antes
  // de horario, y no debe "reabrirse" solo porque la fecha sigue vigente).
  if (current !== "scheduled" && current !== "open") {
    return current;
  }

  if (now < registrationStartAt) return "scheduled";
  if (now >= registrationStartAt && now <= registrationEndAt) return "open";
  return "closed"; // now > registrationEndAt
}

/** true si, dado el estado, hoy se aceptan nuevas inscripciones sin excepción manual. */
export function isRegistrationOpen(status: CompetitionStatus): boolean {
  return status === "open";
}

const AUTO_RECOMPUTABLE_ON_EDIT: CompetitionStatus[] = ["scheduled", "open", "closed"];

/**
 * A diferencia de `computeEffectiveStatus` (de solo avance, nunca reabre
 * 'closed'), esta función se usa cuando el administrador EDITA
 * explícitamente las fechas de inscripción de la competencia: en ese caso
 * sí corresponde recalcular el estado en cualquier dirección dentro de
 * {scheduled, open, closed} — por ejemplo, si estaba 'closed' y el admin
 * extiende la fecha de cierre a futuro, debe volver a 'open'. Los estados
 * draft/cancelled/in_progress/finished nunca se tocan aquí: requieren
 * siempre una acción explícita del ciclo de vida (Programar, Cancelar,
 * Iniciar, Finalizar), nunca un efecto colateral de editar fechas.
 */
export function recomputeStatusAfterEdit(current: CompetitionStatus, registrationStartAt: Date, registrationEndAt: Date, now: Date): CompetitionStatus {
  if (!AUTO_RECOMPUTABLE_ON_EDIT.includes(current)) return current;
  if (now < registrationStartAt) return "scheduled";
  if (now >= registrationStartAt && now <= registrationEndAt) return "open";
  return "closed";
}

/** Operaciones que un club o un administrador puede hacer sobre inscripciones. */
export type RegistrationOperation = "create" | "update" | "cancel";

export interface RegistrationWindowResult {
  allowed: boolean;
  /** true si la operación solo es posible por la excepción post-cierre (RB-08). */
  isPostCloseException: boolean;
  reason?: string;
}

/**
 * ¿Se puede crear, editar o cancelar una inscripción con la competencia en
 * este estado? (hallazgo 10)
 *
 * Antes la única pregunta era "¿está abierta?" y, si no lo estaba, bastaba
 * el permiso `registrations:write:post-close` para operar — sin mirar el
 * estado real. Eso permitía inscribir en una competencia en BORRADOR (aún
 * sin fechas definitivas ni pruebas cargadas), en una CANCELADA, o en una ya
 * EN CURSO o FINALIZADA, donde una inscripción nueva no significa nada y
 * descuadra los resultados. La excepción post-cierre existe para un caso
 * concreto: la competencia cerró y falta corregir algo antes de que empiece.
 *
 * Reglas:
 *   - `open`      → cualquiera con permiso de escritura, sin excepción.
 *   - `closed`    → SOLO con permiso post-cierre, marcado como excepción.
 *   - resto       → nadie, ni siquiera con permiso post-cierre.
 *
 * Cancelar sigue el mismo criterio: en una competencia ya en curso o
 * finalizada, retirar a alguien del listado altera el registro histórico.
 */
export function evaluateRegistrationWindow(
  status: CompetitionStatus,
  operation: RegistrationOperation,
  canRegisterPostClose: boolean
): RegistrationWindowResult {
  if (status === "open") {
    return { allowed: true, isPostCloseException: false };
  }

  const OPERATION_LABELS: Record<RegistrationOperation, string> = {
    create: "inscribir",
    update: "modificar inscripciones",
    cancel: "cancelar inscripciones",
  };

  if (status === "closed") {
    if (!canRegisterPostClose) {
      return {
        allowed: false,
        isPostCloseException: false,
        reason: `Las inscripciones de esta competencia están cerradas; solo un administrador autorizado puede ${OPERATION_LABELS[operation]} como excepción.`,
      };
    }
    return { allowed: true, isPostCloseException: true };
  }

  const STATUS_LABELS: Record<CompetitionStatus, string> = {
    draft: "en borrador",
    scheduled: "programada (las inscripciones aún no abren)",
    open: "abierta",
    closed: "cerrada",
    in_progress: "en ejecución",
    finished: "finalizada",
    cancelled: "cancelada",
  };

  return {
    allowed: false,
    isPostCloseException: false,
    reason: `No se puede ${OPERATION_LABELS[operation]} en una competencia ${STATUS_LABELS[status]}. La excepción post-cierre solo aplica a competencias cerradas.`,
  };
}

const CANCELLABLE_FROM: CompetitionStatus[] = ["draft", "scheduled", "open", "closed", "in_progress"];
const CLOSE_REGISTRATIONS_FROM: CompetitionStatus[] = ["scheduled", "open"];

export interface TransitionResult {
  allowed: boolean;
  nextStatus?: CompetitionStatus;
  reason?: string;
}

export function evaluateCompetitionAction(current: CompetitionStatus, action: CompetitionAction): TransitionResult {
  switch (action) {
    case "schedule":
      if (current !== "draft") {
        return { allowed: false, reason: `Solo se puede programar una competencia en estado 'draft' (actual: '${current}')` };
      }
      return { allowed: true, nextStatus: "scheduled" };

    case "cancel":
      if (!CANCELLABLE_FROM.includes(current)) {
        return { allowed: false, reason: `No se puede cancelar una competencia en estado '${current}'` };
      }
      return { allowed: true, nextStatus: "cancelled" };

    case "closeRegistrations":
      if (!CLOSE_REGISTRATIONS_FROM.includes(current)) {
        return { allowed: false, reason: `No se pueden cerrar inscripciones desde el estado '${current}'` };
      }
      return { allowed: true, nextStatus: "closed" };

    case "start":
      if (current !== "closed") {
        return { allowed: false, reason: `La competencia debe tener las inscripciones cerradas antes de iniciar su ejecución (actual: '${current}')` };
      }
      return { allowed: true, nextStatus: "in_progress" };

    case "finish":
      if (current !== "in_progress") {
        return { allowed: false, reason: `Solo se puede finalizar una competencia 'en ejecución' (actual: '${current}')` };
      }
      return { allowed: true, nextStatus: "finished" };
  }
}
