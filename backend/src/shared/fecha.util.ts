/**
 * Fechas de CALENDARIO, separadas de los instantes.
 *
 * El sistema mezclaba las dos cosas: `club_swimmers.start_date` era un
 * `TIMESTAMP` al que se le escribía `new Date()`, el mismo instante que la marca
 * de auditoría `reviewed_at`. Eso tenía dos consecuencias medidas:
 *
 *   - La fecha guardada dependía de la ZONA DEL SERVIDOR. Render corre en UTC,
 *     así que una asignación hecha en Chile a las 23:58 del 30 quedaba guardada
 *     como el 31.
 *   - La base y la pantalla decían cosas distintas: la base `2026-10-31`, y
 *     `toLocaleDateString("es-CL")` sobre el mismo instante, `30-10-2026`.
 *
 * Una fecha efectiva es un dato del negocio —«desde cuándo pertenece al club»—
 * y no tiene hora ni zona. Aquí vive como el texto `AAAA-MM-DD`, que es lo que
 * la API recibe y lo que la columna `DATE` guarda.
 */

/** Zona horaria oficial del negocio. Las fechas del negocio son días chilenos. */
export const ZONA_HORARIA_NEGOCIO = "America/Santiago";

/** `AAAA-MM-DD`. El formato de `DATE` en SQL y de `<input type="date">`. */
export const FORMATO_FECHA_CALENDARIO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * La fecha de calendario de HOY en Chile, como `AAAA-MM-DD`.
 *
 * `en-CA` produce exactamente `AAAA-MM-DD`, y `timeZone` hace que el resultado
 * NO dependa de la zona del proceso: con el servidor en UTC a las 02:58 del 31,
 * devuelve `2026-10-30`, que es el día que es en Chile.
 */
export function hoyEnZonaDelNegocio(ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_HORARIA_NEGOCIO }).format(ahora);
}

/**
 * Convierte `AAAA-MM-DD` en el `Date` que Prisma guarda en una columna `DATE`:
 * **medianoche UTC** de ese día.
 *
 * Prisma escribe y lee `@db.Date` como medianoche UTC. Construirlo así es lo
 * único que hace que el día que entra sea el día que queda guardado; usar
 * `new Date("2026-10-30")` también da medianoche UTC, pero
 * `new Date(2026, 9, 30)` daría medianoche LOCAL y, al pasarla a UTC, el día
 * anterior en cualquier zona al oeste de Greenwich.
 */
export function fechaCalendarioAUtc(fecha: string): Date {
  if (!FORMATO_FECHA_CALENDARIO.test(fecha)) {
    throw new Error(`Fecha de calendario inválida: "${fecha}". Se espera AAAA-MM-DD.`);
  }
  const d = new Date(`${fecha}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inexistente: "${fecha}".`);
  return d;
}

/**
 * El inverso: de lo que Prisma devuelve para una columna `DATE` al texto
 * `AAAA-MM-DD`.
 *
 * **Se leen los componentes UTC a propósito.** `getFullYear()` y compañía
 * aplicarían la zona del proceso y restarían un día al oeste de Greenwich: es
 * exactamente la trampa que este módulo existe para cerrar.
 */
export function utcAFechaCalendario(valor: Date | string | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "string") {
    return FORMATO_FECHA_CALENDARIO.test(valor.slice(0, 10)) ? valor.slice(0, 10) : null;
  }
  if (Number.isNaN(valor.getTime())) return null;
  const a = valor.getUTCFullYear();
  const m = String(valor.getUTCMonth() + 1).padStart(2, "0");
  const d = String(valor.getUTCDate()).padStart(2, "0");
  return `${a}-${m}-${d}`;
}

/**
 * ¿Es una fecha de calendario que existe de verdad?
 *
 * El formato no basta: `2026-02-30` lo cumple. `Date` normalizaría al 2 de
 * marzo en silencio, así que se compara el texto de vuelta.
 */
export function esFechaCalendarioValida(fecha: string): boolean {
  if (!FORMATO_FECHA_CALENDARIO.test(fecha)) return false;
  const d = new Date(`${fecha}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && utcAFechaCalendario(d) === fecha;
}
