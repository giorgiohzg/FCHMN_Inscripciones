/**
 * Cupos de NADADORES de una competencia — reglas puras.
 *
 * Dos topes opcionales e independientes:
 *   - `maxSwimmers`        — nadadores distintos en toda la competencia.
 *   - `maxSwimmersPerClub` — nadadores distintos aportados por un club.
 *
 * La unidad de conteo es el NADADOR, no la prueba: alguien con seis
 * inscripciones individuales y dos relevos ocupa **un** cupo. Por eso lo que
 * decide no es cuántas filas entran, sino cuántos nadadores entran que aún no
 * estaban.
 *
 * De ahí la propiedad que el enunciado exige y que aquí se hace explícita:
 * **un nadador ya inscrito nunca es bloqueado por el cupo**. Puede seguir
 * añadiendo, cambiando o cancelando pruebas con las reglas de siempre aunque
 * la competencia esté llena, porque no consume un cupo nuevo.
 *
 * Se aísla como función pura para poder probar los bordes —justo en el tope,
 * uno por encima, alta por lotes que cruza el tope— sin base de datos.
 */

export interface CapacityLimits {
  /** null = sin límite global. */
  maxSwimmers: number | null;
  /** null = sin límite por club. */
  maxSwimmersPerClub: number | null;
}

export interface CapacityUsage {
  /** Nadadores distintos YA inscritos en la competencia. */
  totalSwimmers: number;
  /** Nadadores distintos YA inscritos que aporta el club en cuestión. */
  clubSwimmers: number;
}

export interface CapacityRequest {
  /**
   * Cuántos nadadores de esta alta NO estaban ya inscritos en la competencia.
   * Para una inscripción individual vale 0 o 1; para un equipo de relevo, de
   * 0 a 4. Es el número que realmente consume cupo global.
   */
  newToCompetition: number;
  /**
   * Cuántos nadadores de esta alta NO estaban ya inscritos POR ESE CLUB. Puede
   * diferir del anterior si un nadador ya figura en la competencia con otro
   * club: ocupa cupo del club nuevo, pero no cupo global.
   */
  newToClub: number;
  /** Solo para redactar el mensaje de error. */
  clubName?: string;
}

/**
 * Excepción administrativa sobre los cupos.
 *
 * Un administrador autorizado puede inscribir por encima del cupo global y del
 * cupo por club. Es un permiso deliberado y acotado: no elimina ninguna otra
 * regla —la inscripción individual previa de los integrantes de un relevo, los
 * límites de pruebas por nadador, la elegibilidad por categoría y los estados
 * en los que no se puede operar siguen valiendo igual—, y para los demás roles
 * los cupos son obligatorios.
 *
 * Se recibe como parámetro en vez de consultarse dentro porque esta función es
 * pura: quien llama ya resolvió el rol, y así se puede probar el permiso en sí
 * sin montar un actor.
 */
export interface CapacityOverride {
  /** true solo para un administrador con permiso de excepción. */
  puedeExcederCupos: boolean;
}

export interface CapacityEvaluation {
  allowed: boolean;
  reason?: string;
  /**
   * true si el alta se aceptó SOLO porque quien la hizo puede exceder cupos.
   * Es lo que dispara el registro de auditoría específico del exceso.
   */
  exceededByOverride: boolean;
  /**
   * true si, aceptada esta alta, el total de nadadores distintos alcanza o
   * supera `maxSwimmers`. Es la señal de cierre automático: la decide esta
   * función pura, no el servicio, para que el umbral viva en un solo sitio.
   */
  reachesGlobalLimit: boolean;
  /** Total de nadadores distintos que quedaría tras aceptar el alta. */
  projectedTotal: number;
  /** Nadadores distintos del club que quedarían tras aceptar el alta. */
  projectedForClub: number;
}

/**
 * ¿Cabe esta alta dentro de los cupos?
 *
 * Nota sobre el orden de las comprobaciones: se evalúa primero el cupo global
 * y después el del club. Cuando los dos están al tope, el mensaje que recibe
 * quien inscribe habla del cupo de la competencia, que es el que explica mejor
 * por qué no hay nada que hacer.
 */
export function evaluateCapacity(
  limits: CapacityLimits,
  usage: CapacityUsage,
  request: CapacityRequest,
  /** Por omisión, sin excepción: el comportamiento de cualquier rol que no sea administrador. */
  override: CapacityOverride = { puedeExcederCupos: false }
): CapacityEvaluation {
  const projectedTotal = usage.totalSwimmers + request.newToCompetition;
  const projectedForClub = usage.clubSwimmers + request.newToClub;

  const reachesGlobalLimit = limits.maxSwimmers !== null && projectedTotal >= limits.maxSwimmers;

  /**
   * Un alta que no incorpora ningún nadador nuevo nunca puede chocar con un
   * cupo: por definición no lo consume. Esto es lo que deja a un nadador ya
   * inscrito gestionar sus pruebas con la competencia llena.
   */
  if (request.newToCompetition === 0 && request.newToClub === 0) {
    return { allowed: true, exceededByOverride: false, reachesGlobalLimit, projectedTotal, projectedForClub };
  }

  const excedeGlobal = limits.maxSwimmers !== null && projectedTotal > limits.maxSwimmers;
  const excedePorClub = limits.maxSwimmersPerClub !== null && projectedForClub > limits.maxSwimmersPerClub;

  /**
   * LA EXCEPCIÓN ADMINISTRATIVA SE APLICA AQUÍ, y solo a los cupos.
   *
   * Los máximos configurados NO se tocan: se conservan tal cual, y el conteo
   * real se devuelve aunque los supere. Quien llama usa `exceededByOverride`
   * para dejar el rastro de auditoría del exceso.
   */
  if (override.puedeExcederCupos && (excedeGlobal || excedePorClub)) {
    return { allowed: true, exceededByOverride: true, reachesGlobalLimit, projectedTotal, projectedForClub };
  }

  if (excedeGlobal && limits.maxSwimmers !== null) {
    const libres = Math.max(0, limits.maxSwimmers - usage.totalSwimmers);
    return {
      allowed: false,
      exceededByOverride: false,
      reachesGlobalLimit,
      projectedTotal,
      projectedForClub,
      reason:
        `La competencia alcanzó su cupo de ${limits.maxSwimmers} nadador(es). ` +
        (libres === 0
          ? "No quedan cupos disponibles."
          : `Quedan ${libres} cupo(s) y esta operación necesita ${request.newToCompetition}.`) +
        " Las inscripciones de quienes ya están inscritos no se ven afectadas.",
    };
  }

  if (excedePorClub && limits.maxSwimmersPerClub !== null) {
    const libres = Math.max(0, limits.maxSwimmersPerClub - usage.clubSwimmers);
    const club = request.clubName ? `El club ${request.clubName}` : "El club";
    return {
      allowed: false,
      exceededByOverride: false,
      reachesGlobalLimit,
      projectedTotal,
      projectedForClub,
      reason:
        `${club} alcanzó su cupo de ${limits.maxSwimmersPerClub} nadador(es) para esta competencia. ` +
        (libres === 0
          ? "No puede inscribir nadadores nuevos."
          : `Quedan ${libres} cupo(s) y esta operación necesita ${request.newToClub}.`) +
        " Los nadadores ya inscritos de este club pueden seguir gestionando sus pruebas.",
    };
  }

  return { allowed: true, exceededByOverride: false, reachesGlobalLimit, projectedTotal, projectedForClub };
}

/**
 * ¿Hay que cerrar las inscripciones tras este alta?
 *
 * Se separa de `evaluateCapacity` porque el cierre también se evalúa al EDITAR
 * los cupos de la competencia (reducir `maxSwimmers` por debajo de lo ya
 * inscrito cierra igual, sin borrar nada), y ahí no hay ningún alta que
 * evaluar.
 */
export function shouldCloseRegistrations(maxSwimmers: number | null, totalSwimmers: number): boolean {
  return maxSwimmers !== null && totalSwimmers >= maxSwimmers;
}
