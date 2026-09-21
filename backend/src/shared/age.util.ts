/**
 * RB-05: la edad de un nadador para efectos de categoría se calcula con
 * `birthDate` vs. una fecha de corte — NUNCA con la fecha de inscripción
 * ni con la fecha de la prueba.
 *
 * La categoría ya NO almacena una fecha de corte propia (se eliminó ese
 * campo por pedido explícito). En su lugar se usa la convención estándar
 * de natación máster: la edad que el nadador cumple durante el año en
 * curso, es decir, calculada al 31 de diciembre de ese año — ver
 * `getDefaultAgeCutoffDate()`.
 */

/** Años cumplidos por una persona a una fecha de referencia dada. */
export function computeAge(birthDate: Date, asOfDate: Date): number {
  let age = asOfDate.getUTCFullYear() - birthDate.getUTCFullYear();

  const hasHadBirthdayThisYear =
    asOfDate.getUTCMonth() > birthDate.getUTCMonth() ||
    (asOfDate.getUTCMonth() === birthDate.getUTCMonth() && asOfDate.getUTCDate() >= birthDate.getUTCDate());

  if (!hasHadBirthdayThisYear) age -= 1;

  return age;
}

/**
 * Fecha de corte implícita para el cálculo de edad por categoría: el 31 de
 * diciembre del año de `referenceDate` (por defecto, hoy). Reemplaza el
 * campo `Category.cutoffDate` que existía antes — ahora es un único
 * criterio uniforme para todas las categorías, sin tener que definirlo
 * manualmente al crear cada una.
 */
export function getDefaultAgeCutoffDate(referenceDate: Date = new Date()): Date {
  return new Date(Date.UTC(referenceDate.getUTCFullYear(), 11, 31));
}

/** true si la edad calculada a `cutoffDate` cae dentro de [minAge, maxAge]. */
export function isAgeInCategoryRange(birthDate: Date, cutoffDate: Date, minAge: number, maxAge: number): boolean {
  const age = computeAge(birthDate, cutoffDate);
  return age >= minAge && age <= maxAge;
}
