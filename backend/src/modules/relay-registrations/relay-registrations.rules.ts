import type { Gender, EventGender } from "../registrations/registrations.rules";

export interface RelayMemberInput {
  personId: string;
  displayName: string; // usado para mensajes de error legibles
  swimmerIsActive: boolean;
  swimmerBelongsToClub: boolean;
  swimmerGender: Gender;
  /** Cantidad de relevos YA confirmados de este nadador en esa fecha+jornada. */
  currentRelayCountInSession: number;
}

export interface RelayRegistrationCheckInput {
  competitionIsOpen: boolean;
  isPostCloseException: boolean;

  clubIsActive: boolean;
  competitionEventIsEnabled: boolean;
  duplicateTeamForClub: boolean; // el club ya tiene un equipo confirmado para esta prueba+categoría

  eventGender: EventGender;

  /**
   * Máximo de relevos que un mismo nadador puede tener en esta fecha+jornada.
   *
   * Es el límite EFECTIVO ya resuelto por el servicio: el menor entre el
   * parámetro de la competencia (`maxRelayEventsPerSwimmerPerSession`, por
   * defecto 1) y el de la jornada (`SessionLimit.maxRelayEvents`) cuando este
   * último está definido. `null` significa sin límite.
   *
   * Antes esta regla ignoraba la configuración: había un tope fijo de 1
   * escrito en el código, de modo que una jornada configurada para admitir 2
   * relevos por nadador seguía rechazando el segundo.
   */
  maxRelayEventsInSession: number | null;

  /** Integrantes que exige el tipo de prueba (4 en un relevo estándar). */
  requiredMemberCount: number;

  members: RelayMemberInput[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Sección 14-15: valida un equipo de relevo completo. RB-11: exactamente
 * 4 integrantes, sin duplicados, todos elegibles. Acumula TODOS los
 * errores aplicables (globales + por integrante) en una sola pasada.
 *
 * La EDAD ya no se valida aquí por integrante: la categoría del equipo se
 * calcula automáticamente a partir de la edad COMBINADA de los 4
 * nadadores (suma de sus edades individuales según la fecha de corte de
 * la competencia) — ver `resolveCategoryForComputedAge` en
 * `registrations.rules.ts`, reutilizada por el servicio de relevos. Si
 * esa resolución no encuentra ninguna categoría (o encuentra más de una,
 * por rangos superpuestos), el servicio rechaza la inscripción antes de
 * llegar a este validador — por eso esta función ya no necesita
 * `categoryCutoffDate`/`categoryMinAge`/`categoryMaxAge` como antes.
 */
export function validateRelayRegistration(input: RelayRegistrationCheckInput): ValidationResult {
  const errors: string[] = [];

  if (!input.competitionIsOpen && !input.isPostCloseException) {
    errors.push("La competencia no tiene las inscripciones abiertas.");
  }
  if (!input.clubIsActive) {
    errors.push("El club no está activo.");
  }
  if (!input.competitionEventIsEnabled) {
    errors.push("Esta prueba de relevo no está habilitada para la competencia.");
  }
  if (input.duplicateTeamForClub) {
    errors.push("El club ya tiene un equipo inscrito para esta prueba y categoría.");
  }

  if (input.members.length !== input.requiredMemberCount) {
    errors.push(`Un relevo debe tener exactamente ${input.requiredMemberCount} nadadores (se seleccionaron ${input.members.length}).`);
  }

  // Un relevo MIXTO debe estar conformado exactamente por 2 hombres y 2
  // mujeres (no "cualquier combinación de géneros") — solo se evalúa
  // cuando ya hay 4 integrantes, para no apilar un segundo error confuso
  // sobre el de cantidad incorrecta.
  if (input.eventGender === "mixed" && input.members.length === input.requiredMemberCount) {
    const maleCount = input.members.filter((m) => m.swimmerGender === "male").length;
    const femaleCount = input.members.filter((m) => m.swimmerGender === "female").length;
    if (maleCount !== 2 || femaleCount !== 2) {
      errors.push(`Un relevo mixto debe estar conformado por 2 nadadores y 2 nadadoras (se seleccionaron ${maleCount} hombre(s) y ${femaleCount} mujer(es)).`);
    }
  }

  const seen = new Set<string>();
  for (const member of input.members) {
    if (seen.has(member.personId)) {
      errors.push(`El nadador "${member.displayName}" está duplicado en el equipo.`);
    }
    seen.add(member.personId);
  }

  for (const member of input.members) {
    if (!member.swimmerIsActive) {
      errors.push(`${member.displayName}: el nadador no está activo.`);
    }
    if (!member.swimmerBelongsToClub) {
      errors.push(`${member.displayName}: no pertenece actualmente a este club.`);
    }

    if (input.eventGender !== "mixed" && input.eventGender !== member.swimmerGender) {
      errors.push(`${member.displayName}: el género no es compatible con esta prueba.`);
    }

    // Límite CONFIGURABLE de relevos por nadador y jornada. `null` = sin
    // límite; 0 = no se admiten relevos.
    if (input.maxRelayEventsInSession !== null && member.currentRelayCountInSession >= input.maxRelayEventsInSession) {
      errors.push(
        input.maxRelayEventsInSession === 0
          ? `${member.displayName}: esta competencia no admite relevos en esta fecha y jornada.`
          : `${member.displayName}: ya alcanzó el máximo de ${input.maxRelayEventsInSession} relevo(s) por nadador para esta fecha y jornada.`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
