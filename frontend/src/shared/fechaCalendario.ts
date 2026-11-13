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

/**
 * HOY en America/Santiago como `AAAA-MM-DD`: la zona del negocio, la misma que usa el servidor
 * para rechazar fechas futuras. No depende de la zona del navegador.
 */
export function hoyEnSantiago(ahora: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ahora);
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")}`;
}

/** ¿Es `AAAA-MM-DD` y existe en el calendario (sin 30 de febrero)? */
export function esFechaCalendarioExistente(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [a, m, d] = v.split("-").map(Number) as [number, number, number];
  const f = new Date(Date.UTC(a, m - 1, d));
  return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}

/** Día de calendario anterior, con componentes UTC (sin restar 24 horas a un reloj). */
export function diaCalendarioAnterior(fecha: string): string {
  const [a, m, d] = fecha.slice(0, 10).split("-").map(Number) as [number, number, number];
  const f = new Date(Date.UTC(a, m - 1, d - 1));
  return f.toISOString().slice(0, 10);
}
