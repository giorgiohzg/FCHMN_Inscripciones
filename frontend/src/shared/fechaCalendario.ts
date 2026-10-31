/**
 * Fechas de CALENDARIO en la interfaz.
 *
 * El servidor envía la fecha efectiva de una membresía como medianoche UTC,
 * porque vive en una columna `DATE` y Prisma la serializa así:
 * `"2026-10-30T00:00:00.000Z"`.
 *
 * Pasar eso por `new Date(...).toLocaleDateString("es-CL")` muestra
 * **29-10-2026**: medianoche UTC son las 21:00 del día anterior en Chile. Es la
 * trampa que hace que un arreglo de zonas horarias rompa la pantalla en la
 * dirección contraria, así que una fecha de calendario se formatea desde su
 * TEXTO y no se construye ningún `Date`.
 */

/** `"2026-10-30T00:00:00.000Z"` o `"2026-10-30"` → `"30-10-2026"`. */
export function formatearFechaCalendario(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split("-");
  return a && m && d ? `${d}-${m}-${a}` : iso;
}

/**
 * Clave de ordenación: los primeros diez caracteres en ISO.
 *
 * En `AAAA-MM-DD` el orden alfabético coincide con el cronológico, así que no
 * hace falta convertir a `Date` para ordenar.
 */
export const claveOrdenFechaCalendario = (iso: string): string => iso.slice(0, 10);

/** ¿Es una fecha de calendario con la forma que el servidor promete? */
export const esFechaCalendario = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
