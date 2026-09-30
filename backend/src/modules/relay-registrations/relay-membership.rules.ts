/**
 * INVARIANTE: todo integrante de un relevo confirmado tiene al menos una
 * inscripción individual confirmada en la MISMA competencia.
 *
 * Por qué es una invariante y no una validación de alta. Tiene dos lados, y
 * comprobar solo uno la deja rota:
 *
 *   - al formar o modificar el equipo, todos sus integrantes deben cumplirla;
 *   - al cancelar una inscripción individual, si era la última confirmada de
 *     alguien que integra un relevo confirmado, la cancelación se RECHAZA.
 *
 * Sin el segundo lado, la regla se cumple en el instante del alta y deja de
 * cumplirse cinco minutos después, sin que nada lo advierta.
 *
 * QUÉ SIGNIFICA «LA MISMA COMPETENCIA». Ni `registrations` ni
 * `relay_registrations` guardan la competencia: las dos apuntan a
 * `competition_events`, y es esa tabla la que tiene `competitionId`. Comparar
 * la prueba en vez de la competencia sería una regla distinta y mucho más
 * dura —exigiría estar inscrito en esa misma prueba—, que no es lo pedido.
 *
 * TAMBIÉN PARA EL ADMINISTRADOR. La excepción administrativa levanta los
 * cupos y los estados de cierre; esto no. Un relevo cuyos integrantes no
 * nadan individualmente no es un permiso especial: es un equipo que no puede
 * competir.
 *
 * NUNCA SE ARREGLA SOLO. Ni se elimina el relevo, ni se le quita el
 * integrante, ni se cancela en cascada. El sistema se niega y dice qué pasa;
 * decidir entre retirar al nadador del equipo o conservar su inscripción es
 * del usuario, y hacerlo por él destruiría datos que nadie pidió borrar.
 */

/** Integrante propuesto para un equipo, con lo necesario para el mensaje. */
export interface IntegrantePropuesto {
  personId: string;
  /** Nombre para el mensaje de error. No participa en la decisión. */
  displayName: string;
}

export interface ResultadoDeElegibilidad {
  ok: boolean;
  /** Identificadores de los que NO cumplen, en el orden recibido. */
  sinInscripcionIndividual: string[];
  reason?: string;
}

/**
 * ¿Pueden estos nadadores integrar un relevo de esta competencia?
 *
 * `conIndividualConfirmada` es el conjunto de quienes SÍ tienen una
 * inscripción individual confirmada en la competencia, leído por quien llama
 * dentro de la misma transacción. Se recibe ya resuelto para que esta función
 * siga siendo pura y comprobable sin base de datos.
 */
export function evaluarElegibilidadDeIntegrantes(
  integrantes: readonly IntegrantePropuesto[],
  conIndividualConfirmada: ReadonlySet<string>
): ResultadoDeElegibilidad {
  const faltan = integrantes.filter((i) => !conIndividualConfirmada.has(i.personId));
  if (faltan.length === 0) {
    return { ok: true, sinInscripcionIndividual: [] };
  }

  const nombres = faltan.map((i) => i.displayName).join(", ");
  return {
    ok: false,
    sinInscripcionIndividual: faltan.map((i) => i.personId),
    reason:
      `Un relevo solo puede formarse con nadadores que ya tengan una inscripción individual confirmada en esta competencia. ` +
      `Sin ella: ${nombres}. ` +
      "Inscríbalos primero en al menos una prueba individual, o cámbielos por otros que ya lo estén.",
  };
}

/** Un relevo confirmado que depende de la inscripción que se quiere cancelar. */
export interface RelevoDependiente {
  relayRegistrationId: string;
  /** Texto legible de la prueba, para que el usuario sepa cuál es. */
  descripcion: string;
}

export interface ResultadoDeCancelacion {
  allowed: boolean;
  reason?: string;
}

/**
 * ¿Se puede cancelar esta inscripción individual?
 *
 * Solo se frena cuando es la ÚLTIMA confirmada del nadador en la competencia
 * y además integra algún relevo confirmado. Con otra inscripción individual
 * viva, cancelar una no rompe nada y se permite sin más.
 *
 * `otrasIndividualesConfirmadas` cuenta las del mismo nadador en la misma
 * competencia SIN incluir la que se está cancelando.
 */
export function evaluarCancelacionDeIndividual(
  otrasIndividualesConfirmadas: number,
  relevosDependientes: readonly RelevoDependiente[]
): ResultadoDeCancelacion {
  if (otrasIndividualesConfirmadas > 0) return { allowed: true };
  if (relevosDependientes.length === 0) return { allowed: true };

  const lista = relevosDependientes.map((r) => r.descripcion).join("; ");
  return {
    allowed: false,
    reason:
      "No se puede cancelar esta inscripción: es la última inscripción individual confirmada del nadador en la competencia, " +
      `y sigue integrando ${relevosDependientes.length} relevo(s) confirmado(s) (${lista}). ` +
      "Retire al nadador de esos equipos —o cancele los relevos— antes de cancelar su última prueba individual. " +
      "El sistema no los modifica por su cuenta.",
  };
}
