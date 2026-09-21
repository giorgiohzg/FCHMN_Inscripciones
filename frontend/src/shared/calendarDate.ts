/**
 * Formatea una fecha de CALENDARIO pura (sin hora significativa — ej. la
 * fecha de una competencia, la fecha de corte de edad) evitando el bug
 * clásico de zona horaria: el backend guarda estas fechas como medianoche
 * UTC (ej. "2026-03-28T00:00:00.000Z"), y `toLocaleDateString` sin más
 * las convierte a la hora LOCAL del navegador — en Chile (UTC-3/-4) eso
 * cae en el día anterior. Fijar `timeZone: "UTC"` evita ese corrimiento.
 *
 * No usar esta función para fechas/horas donde la HORA sí importa (ej.
 * inicio/fin de inscripción) — esas deben mostrarse en la hora local.
 */
export function formatCalendarDate(iso: string | Date, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(iso).toLocaleDateString("es-CL", { ...options, timeZone: "UTC" });
}
