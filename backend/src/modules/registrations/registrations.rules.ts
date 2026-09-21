import { computeAge } from "../../shared/age.util";

export type Gender = "male" | "female";
export type EventGender = "male" | "female" | "mixed";

export interface IndividualRegistrationCheckInput {
  competitionIsOpen: boolean;
  isPostCloseException: boolean; // A-05-style excepción: admin autorizado operando tras el cierre (RB-08)

  clubIsActive: boolean;

  swimmerIsActive: boolean;
  swimmerBelongsToClub: boolean;
  swimmerBirthDate: Date;
  swimmerGender: Gender;

  categoryCutoffDate: Date;
  categoryMinAge: number;
  categoryMaxAge: number;
  categoryEnabledForCompetitionEvent: boolean;

  eventGender: EventGender;
  competitionEventIsEnabled: boolean;

  alreadyRegisteredForThisEvent: boolean;

  /** Cantidad de inscripciones individuales YA confirmadas del nadador en esa fecha+jornada. */
  currentIndividualCountInSession: number;
  /** null = sin límite (sección 12 / A-09). */
  maxIndividualEventsInSession: number | null;

  /** Cantidad de inscripciones individuales YA confirmadas del nadador en TODA la competencia (todas las fechas/jornadas). */
  currentIndividualCountInCompetition: number;
  /** null = sin límite a nivel de competencia (solo aplican los límites de sesión). Excluye relevos. */
  maxIndividualEventsInCompetition: number | null;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Sección 15: ejecuta TODAS las validaciones y acumula los mensajes de
 * error correspondientes (no se detiene en la primera), para que el
 * usuario reciba retroalimentación completa y comprensible de una vez.
 */
export function validateIndividualRegistration(input: IndividualRegistrationCheckInput): ValidationResult {
  const errors: string[] = [];

  if (!input.competitionIsOpen && !input.isPostCloseException) {
    errors.push("La competencia no tiene las inscripciones abiertas.");
  }

  if (!input.clubIsActive) {
    errors.push("El club no está activo.");
  }

  if (!input.swimmerIsActive) {
    errors.push("El nadador no está activo.");
  }

  if (!input.swimmerBelongsToClub) {
    errors.push("El nadador no pertenece actualmente a este club.");
  }

  const age = computeAge(input.swimmerBirthDate, input.categoryCutoffDate);
  if (age < input.categoryMinAge || age > input.categoryMaxAge) {
    errors.push(`El nadador tiene ${age} años a la fecha de corte y no cumple el rango de la categoría (${input.categoryMinAge}-${input.categoryMaxAge}).`);
  }

  if (input.eventGender !== "mixed" && input.eventGender !== input.swimmerGender) {
    errors.push("El género del nadador no es compatible con esta prueba.");
  }

  if (!input.competitionEventIsEnabled) {
    errors.push("Esta prueba no está habilitada para la competencia.");
  }

  if (!input.categoryEnabledForCompetitionEvent) {
    errors.push("La categoría seleccionada no está habilitada para esta prueba en esta competencia.");
  }

  if (input.alreadyRegisteredForThisEvent) {
    errors.push("El nadador ya tiene una inscripción confirmada en esta prueba.");
  }

  if (input.maxIndividualEventsInSession !== null && input.currentIndividualCountInSession >= input.maxIndividualEventsInSession) {
    errors.push(
      `El nadador ya alcanzó el máximo de ${input.maxIndividualEventsInSession} pruebas individuales para esta fecha y jornada.`
    );
  }

  if (input.maxIndividualEventsInCompetition !== null && input.currentIndividualCountInCompetition >= input.maxIndividualEventsInCompetition) {
    errors.push(
      `El nadador ya alcanzó el máximo de ${input.maxIndividualEventsInCompetition} pruebas individuales permitidas para toda la competencia.`
    );
  }

  return { valid: errors.length === 0, errors };
}

// --------------------------------------------------------------------------
// Resolución automática de categoría (a partir de la edad del nadador)
// --------------------------------------------------------------------------

export interface CategoryCandidate {
  id: string;
  name: string;
  minAge: number;
  maxAge: number;
}

export type CategoryResolution =
  | { outcome: "resolved"; category: CategoryCandidate }
  | { outcome: "none"; age: number }
  | { outcome: "ambiguous"; age: number; candidates: CategoryCandidate[] };

/**
 * La categoría de un nadador para una prueba YA NO se elige manualmente:
 * se calcula a partir de su edad (fecha de nacimiento vs. la fecha de
 * corte de la competencia) contra el conjunto de categorías habilitadas
 * para esa prueba. Debe existir EXACTAMENTE una categoría cuyo rango
 * [minAge, maxAge] contenga la edad calculada — si no hay ninguna, o si
 * hay más de una (rangos de edad superpuestos, un problema de datos en el
 * catálogo), se reporta explícitamente en vez de adivinar.
 */
/**
 * Núcleo de la resolución: dada una edad YA CALCULADA (edad individual de
 * un nadador, o edad combinada de un equipo de relevo — sección 4 del
 * Módulo 8), encuentra la única categoría candidata cuyo rango la cubre.
 */
export function resolveCategoryForComputedAge(age: number, candidates: CategoryCandidate[]): CategoryResolution {
  const matches = candidates.filter((c) => age >= c.minAge && age <= c.maxAge);

  if (matches.length === 0) return { outcome: "none", age };
  if (matches.length > 1) return { outcome: "ambiguous", age, candidates: matches };
  return { outcome: "resolved", category: matches[0]! };
}

export function resolveCategoryForAge(
  birthDate: Date,
  ageCutoffDate: Date,
  candidates: CategoryCandidate[]
): CategoryResolution {
  const age = computeAge(birthDate, ageCutoffDate);
  return resolveCategoryForComputedAge(age, candidates);
}
