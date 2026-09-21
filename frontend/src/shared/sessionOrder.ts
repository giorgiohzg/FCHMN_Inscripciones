/**
 * Orden canónico de jornadas: "Mañana" siempre antes que "Tarde", y
 * cualquier otra jornada (ej. "Noche", o nombres personalizados) va
 * después, en orden alfabético. Se usa para pestañas, columnas y
 * subtítulos agrupados por jornada en toda la aplicación.
 */
function sessionOrderRank(sessionTypeName: string): number {
  const normalized = sessionTypeName.trim().toLowerCase();
  if (normalized === "mañana" || normalized === "manana") return 0;
  if (normalized === "tarde") return 1;
  return 2;
}

export function compareSessionTypeNames(a: string, b: string): number {
  const rankDiff = sessionOrderRank(a) - sessionOrderRank(b);
  if (rankDiff !== 0) return rankDiff;
  return a.localeCompare(b, "es", { sensitivity: "base" });
}

/** Ordena una lista de objetos que tienen un nombre de jornada, según el orden canónico. */
export function sortBySessionTypeName<T>(items: T[], getName: (item: T) => string): T[] {
  return items.slice().sort((a, b) => compareSessionTypeNames(getName(a), getName(b)));
}
