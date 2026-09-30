/**
 * Estado del ciclo de vida de una competencia (sección 10) y las reglas de
 * apertura/cierre automático de inscripciones (RB-07). Se aísla como
 * función pura para poder testear sin base de datos y para poder aplicarse
 * tanto de forma perezosa (al leer una competencia) como desde un futuro
 * job programado, sin duplicar lógica.
 */
export type CompetitionStatus =
  | "draft"
  | "scheduled"
  | "open"
  /**
   * CIERRE PARCIAL: se alcanzó el cupo global de nadadores.
   *
   * Las inscripciones INDIVIDUALES quedan cerradas para quien no sea
   * administrador; los RELEVOS siguen abiertos, porque se forman con nadadores
   * que ya ocupan cupo y por tanto no consumen ninguno.
   *
   * Solo se sale de aquí de tres formas, todas explícitas o por el paso del
   * tiempo: cerrando del todo a mano, por vencimiento de la fecha de fin, o
   * reabriendo con la acción de reapertura. **Nunca se sale solo porque baje
   * la ocupación o porque se amplíe el cupo.**
   */
  | "individual_closed"
  | "closed"
  | "in_progress"
  | "finished"
  | "cancelled";
export type CompetitionAction = "schedule" | "cancel" | "closeRegistrations" | "start" | "finish";

/**
 * Estados en los que las inscripciones están cerradas, del todo o a medias.
 *
 * Se nombra una sola vez porque la distinción aparece en varios sitios y una
 * copia desactualizada sería un agujero: un estado de cierre que alguna
 * comprobación no reconociera dejaría pasar operaciones que debía frenar.
 */
export const ESTADOS_DE_CIERRE: readonly CompetitionStatus[] = ["individual_closed", "closed"];

/** ¿Las inscripciones individuales están cerradas en este estado? */
export function individualRegistrationsClosed(status: CompetitionStatus): boolean {
  return status !== "open";
}

/**
 * Avanza el estado automáticamente según la fecha actual, SOLO entre
 * 'scheduled' -> 'open' -> 'closed' (forward-only). Nunca "retrocede" y
 * nunca toca estados que ya son terminales o manuales para el auto-cómputo
 * (draft, closed, in_progress, finished, cancelled) — esos requieren una
 * acción explícita del administrador para cambiar.
 */
export function computeEffectiveStatus(current: CompetitionStatus, registrationStartAt: Date, registrationEndAt: Date, now: Date): CompetitionStatus {
  /**
   * EL CIERRE PARCIAL SOLO AVANZA, NUNCA RETROCEDE.
   *
   * Desde `individual_closed`, el vencimiento de la fecha lo lleva a `closed`
   * —cerrar más es legítimo y es lo que pide la regla— pero ninguna otra
   * situación lo devuelve a `open`. Si se recalculara como los demás, una
   * competencia llena volvería a estar abierta en cuanto alguien cancelara una
   * inscripción, que es exactamente la reapertura automática que no debe
   * existir.
   */
  if (current === "individual_closed") {
    return now > registrationEndAt ? "closed" : "individual_closed";
  }

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

/**
 * ¿Se aceptan nuevas inscripciones INDIVIDUALES sin excepción manual?
 *
 * Deliberadamente NO incluye `individual_closed`: ahí las individuales están
 * cerradas, que es el sentido del estado.
 */
export function isRegistrationOpen(status: CompetitionStatus): boolean {
  return status === "open";
}

/**
 * ¿Se aceptan RELEVOS sin excepción manual?
 *
 * En `individual_closed` sí, y esa es la diferencia con el cierre total. Un
 * relevo creado ahí por un club es una operación NORMAL, no una excepción
 * post-cierre: marcarlo como excepción ensuciaría el rastro de auditoría
 * —donde «excepción» debe significar «un administrador forzó algo»— y dejaría
 * la columna `is_post_close_exception` en true para filas corrientes.
 */
export function isRelayRegistrationOpen(status: CompetitionStatus): boolean {
  return status === "open" || status === "individual_closed";
}

/**
 * Estados que una edición recalcula desde las fechas.
 *
 * 'closed' NO está: una competencia cerrada no se reabre editándola. Ver
 * `recomputeStatusAfterEdit`.
 */
const AUTO_RECOMPUTABLE_ON_EDIT: CompetitionStatus[] = ["scheduled", "open"];

/** Por qué se cerraron las inscripciones. `null` = causa desconocida (fila antigua). */
export type RegistrationsCloseReason = "manual" | "capacity" | "schedule";

/**
 * Estado tras una edición explícita de la competencia.
 *
 * 'scheduled' y 'open' se recalculan desde las fechas en cualquier dirección
 * —incluido cerrarse si el periodo ya terminó—. Los estados terminales o
 * manuales (draft, cancelled, in_progress, finished) nunca se tocan.
 *
 * **UNA COMPETENCIA CERRADA NO SE REABRE AL EDITARLA.** Reabrir es una acción
 * propia: `evaluateReopenRegistrations`.
 *
 * Por qué no se infiere la intención de la edición. Se intentó, y no es
 * recuperable:
 *
 *   - «la solicitud trae fechas» no significa que hayan cambiado: el
 *     formulario de edición envía SIEMPRE las dos, se hayan tocado o no. Con
 *     esa señal, renombrar una competencia cerrada a mano la reabría.
 *   - «hay cupo libre» no significa que esta edición lo haya ampliado: basta
 *     que alguien cancele una inscripción para que sobre sitio. Con esa
 *     señal, renombrar una competencia cerrada por cupo la reabría.
 *
 * Comparar valores contra los guardados tampoco sirve: una fecha que el
 * usuario no tocó vuelve del formulario con otra precisión, y corregir una
 * errata en la fecha de fin no es una orden de reapertura.
 *
 * Cuando la intención no se puede distinguir con fiabilidad, se pide de forma
 * explícita en vez de adivinarla.
 */
export function recomputeStatusAfterEdit(current: CompetitionStatus, registrationStartAt: Date, registrationEndAt: Date, now: Date): CompetitionStatus {
  /**
   * El cierre parcial no está en `AUTO_RECOMPUTABLE_ON_EDIT` porque no se
   * recalcula: solo avanza a `closed` si la fecha venció.
   *
   * Es la trampa de este estado. Añadirlo a la lista habría bastado para que
   * compilara y para que el cierre por fecha funcionara, y a cambio habría
   * reabierto la competencia en cuanto alguien editara cualquier campo dentro
   * de la ventana — ampliar el cupo, corregir el nombre—. La reapertura tiene
   * que ser siempre una acción con nombre.
   */
  if (current === "individual_closed") {
    return now > registrationEndAt ? "closed" : "individual_closed";
  }
  if (!AUTO_RECOMPUTABLE_ON_EDIT.includes(current)) return current;
  if (now < registrationStartAt) return "scheduled";
  if (now >= registrationStartAt && now <= registrationEndAt) return "open";
  return "closed";
}

export interface ReopenEvaluation {
  allowed: boolean;
  nextStatus?: CompetitionStatus;
  reason?: string;
}

/**
 * ¿Se pueden reabrir las inscripciones de esta competencia?
 *
 * Es una acción deliberada y con nombre, no un efecto colateral. Exige que
 * los dos motivos que pueden mantenerla cerrada estén resueltos, y lo dice
 * con el motivo concreto para que el administrador sepa qué corregir antes:
 *
 *   - la ventana de inscripción tiene que estar vigente o por empezar;
 *   - el cupo global no puede estar alcanzado.
 *
 * `closeReason` no decide, solo redacta: sirve para explicar por qué está
 * cerrada cuando el impedimento coincide con la causa.
 */
export function evaluateReopenRegistrations(
  current: CompetitionStatus,
  closeReason: RegistrationsCloseReason | null,
  registrationStartAt: Date,
  registrationEndAt: Date,
  now: Date,
  capacity: { maxSwimmers: number | null; totalSwimmers: number }
): ReopenEvaluation {
  if (!ESTADOS_DE_CIERRE.includes(current)) {
    return { allowed: false, reason: `Solo se pueden reabrir las inscripciones de una competencia cerrada (actual: '${current}').` };
  }

  if (now > registrationEndAt) {
    return {
      allowed: false,
      reason:
        `El periodo de inscripción terminó el ${registrationEndAt.toISOString().slice(0, 10)}. ` +
        "Extienda la fecha de fin de inscripción antes de reabrir." +
        (closeReason === "schedule" ? " Fue justamente el vencimiento de esa fecha lo que la cerró." : ""),
    };
  }

  /**
   * CON EL CUPO LLENO, REABRIR LLEVA AL CIERRE PARCIAL, no al rechazo.
   *
   * Antes esto devolvía un "no se puede" y obligaba a ampliar el cupo primero.
   * Con el estado parcial hay una respuesta mejor y más fiel a lo que el
   * administrador pidió: las individuales siguen cerradas —el cupo está
   * lleno, y eso no ha cambiado— pero los relevos se habilitan, que es
   * justamente lo que un cupo lleno no tiene por qué impedir.
   *
   * No es una reapertura a medias por comodidad: es el estado que describe con
   * exactitud "llena para nuevos nadadores, disponible para armar equipos". Y
   * sigue exigiendo la acción explícita: nunca se llega aquí por cancelar una
   * inscripción ni por editar el cupo.
   *
   * Desde `scheduled` no se habilita nada todavía, así que si la ventana aún
   * no empieza el destino es `scheduled` aunque el cupo esté lleno: cuando
   * abra, el cierre por cupo volverá a actuar.
   */
  const cupoLleno = capacity.maxSwimmers !== null && capacity.totalSwimmers >= capacity.maxSwimmers;
  if (now < registrationStartAt) {
    return { allowed: true, nextStatus: "scheduled" };
  }
  if (cupoLleno) {
    return {
      allowed: true,
      nextStatus: "individual_closed",
      reason:
        `La competencia tiene ${capacity.totalSwimmers} nadador(es) inscrito(s) y su cupo es de ${capacity.maxSwimmers}. ` +
        "Se reabrieron los relevos; las inscripciones individuales siguen cerradas mientras el cupo esté alcanzado. " +
        "Amplíe el cupo —o quítelo— y vuelva a reabrir para habilitarlas; reducirlo nunca elimina inscripciones.",
    };
  }

  return { allowed: true, nextStatus: "open" };
}

/** Operaciones que un club o un administrador puede hacer sobre inscripciones. */
export type RegistrationOperation = "create" | "update" | "cancel";

/**
 * Sobre qué se opera. El estado `individual_closed` trata a los dos de forma
 * distinta, y antes esta función servía a ambos sin distinguirlos: sin este
 * parámetro, habilitar los relevos en el cierre parcial habría habilitado
 * también las individuales.
 */
export type RegistrationKind = "individual" | "relay";

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
  canRegisterPostClose: boolean,
  /**
   * Por omisión, "individual": es el comportamiento que tenía esta función
   * cuando servía a los dos por igual, y así ninguna llamada existente cambia
   * de sentido por olvidar el argumento.
   */
  kind: RegistrationKind = "individual"
): RegistrationWindowResult {
  if (status === "open") {
    return { allowed: true, isPostCloseException: false };
  }

  const OPERATION_LABELS: Record<RegistrationOperation, string> = {
    create: "inscribir",
    update: "modificar inscripciones",
    cancel: "cancelar inscripciones",
  };

  /**
   * CIERRE PARCIAL: los relevos son operación normal, las individuales no.
   *
   * Para un relevo se devuelve `isPostCloseException: false` aunque la
   * competencia no esté `open`. Es lo correcto: un club que arma su equipo con
   * el cupo lleno no está forzando nada, está haciendo lo que este estado
   * permite. Marcarlo como excepción llenaría la auditoría de excepciones
   * falsas y haría inútil el propio concepto.
   */
  if (status === "individual_closed") {
    if (kind === "relay") {
      return { allowed: true, isPostCloseException: false };
    }
    if (!canRegisterPostClose) {
      return {
        allowed: false,
        isPostCloseException: false,
        reason:
          `Esta competencia alcanzó su cupo de nadadores, así que las inscripciones individuales están cerradas y no se puede ${OPERATION_LABELS[operation]}. ` +
          "Los relevos siguen disponibles con nadadores que ya tengan una inscripción individual confirmada.",
      };
    }
    return { allowed: true, isPostCloseException: true };
  }

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
    individual_closed: "con las inscripciones individuales cerradas",
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

const CANCELLABLE_FROM: CompetitionStatus[] = ["draft", "scheduled", "open", "individual_closed", "closed", "in_progress"];
/**
 * Cerrar del todo se puede también desde el cierre parcial: es la vía
 * explícita para pasar de `individual_closed` a `closed`, junto al vencimiento
 * de la fecha.
 */
const CLOSE_REGISTRATIONS_FROM: CompetitionStatus[] = ["scheduled", "open", "individual_closed"];

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
      /**
       * NO se puede iniciar desde el cierre parcial.
       *
       * En `individual_closed` los relevos siguen abiertos: arrancar la
       * ejecución dejaría equipos formándose mientras la competencia ya está
       * en curso. Hay que cerrar del todo primero, a mano o por vencimiento.
       * El mensaje lo dice, porque desde fuera «individuales cerradas» se
       * parece bastante a «cerrada».
       */
      if (current === "individual_closed") {
        return {
          allowed: false,
          reason:
            "Las inscripciones individuales están cerradas, pero los relevos siguen abiertos. " +
            "Cierre las inscripciones por completo antes de iniciar la ejecución.",
        };
      }
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
