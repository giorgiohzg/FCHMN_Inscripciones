import { ValidationError } from "../../shared/errors";
import { fechaCalendarioAUtc, utcAFechaCalendario } from "../../shared/fecha.util";

/**
 * Fechas REALES de una competencia para el registro B1 del archivo HY3.
 *
 * B1 lleva el inicio y el término de la COMPETENCIA. Hasta aquí se escribían la
 * apertura y el cierre de las INSCRIPCIONES, que son otra cosa: con inscripción
 * del 26/10 al 05/11 y competencia el 08/11, Team Manager recibía como fechas
 * del evento el 26/10 y el 05/11. Las fechas de la competencia son sus
 * `CompetitionDate`.
 *
 * CRITERIO EXACTO
 *   - Inicio = la fecha MÁS TEMPRANA programada; término = la MÁS TARDÍA.
 *     Con un solo día, las dos son esa fecha.
 *   - No depende del orden en que la base devuelva las filas: se comparan como
 *     texto `AAAA-MM-DD`, cuyo orden alfabético es el cronológico.
 *   - Sin ninguna fecha, es un error claro. Nunca se sustituyen por las fechas
 *     de inscripción: eso reproduciría justo el defecto que se corrige.
 *
 * ZONA HORARIA
 *   `CompetitionDate.date` es un día de calendario que el sistema guarda como
 *   medianoche UTC (lo que llega de `<input type="date">` y de la importación
 *   del ZIP de Meet Events). Se lee su día con los componentes UTC y se devuelve
 *   una medianoche UTC de ESE día, de modo que `formatHy3Date` —que también lee
 *   componentes UTC— escribe el mismo día sin importar la zona del proceso ni la
 *   hora con que se hubiera guardado. Usar `getDate()` (zona local) restaría un
 *   día en cualquier servidor al oeste de Greenwich.
 */
export function fechasDeLaCompetencia(
  fechas: ReadonlyArray<{ date: Date }>,
  nombreCompetencia: string
): { inicio: Date; termino: Date } {
  const dias = fechas
    .map((f) => utcAFechaCalendario(f.date))
    .filter((d): d is string => d !== null)
    .sort();

  if (dias.length === 0) {
    throw new ValidationError(
      `La competencia "${nombreCompetencia}" no tiene fechas programadas, y el archivo de Team Manager necesita saber cuándo se ` +
        `realiza. Agregue al menos una fecha en el detalle de la competencia y vuelva a exportar. ` +
        `No se usan las fechas de inscripción en su lugar, porque no son las de la competencia.`,
      { missing: "competitionDates" }
    );
  }

  return { inicio: fechaCalendarioAUtc(dias[0]!), termino: fechaCalendarioAUtc(dias[dias.length - 1]!) };
}
