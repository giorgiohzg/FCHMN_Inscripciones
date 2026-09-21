/**
 * Formato único de tiempo estimado: "mmsscc" (6 dígitos, sin separador) —
 * mm = minutos (2 dígitos), ss = segundos (2 dígitos), cc = centésimas de
 * segundo (2 dígitos). Ejemplo: "012567" = 1 min 25,67 seg. "003510" =
 * 35,10 seg. Se usa tanto para inscripciones individuales como de relevo.
 *
 * Se almacena internamente como CENTÉSIMAS DE SEGUNDO totales (un entero),
 * para no perder precisión ni depender de coma flotante.
 */

const TIME_INPUT_PATTERN = /^(\d{2})(\d{2})(\d{2})$/;

export interface SwimTimeParseResult {
  ok: boolean;
  centiseconds?: number;
  error?: string;
}

/** Convierte "mmsscc" a centésimas de segundo totales. */
export function parseSwimTimeInput(raw: string): SwimTimeParseResult {
  const trimmed = raw.trim();
  const match = trimmed.match(TIME_INPUT_PATTERN);
  if (!match) {
    return { ok: false, error: "Formato inválido — use mmsscc (ej: 012567 para 1 minuto 25,67 segundos)." };
  }
  const [, mm, ss, cc] = match;
  const minutes = Number(mm);
  const seconds = Number(ss);
  const centis = Number(cc);

  if (seconds > 59) {
    return { ok: false, error: "Los segundos no pueden ser mayores a 59." };
  }

  const totalCentiseconds = (minutes * 60 + seconds) * 100 + centis;
  if (totalCentiseconds <= 0) {
    return { ok: false, error: "El tiempo debe ser mayor a cero." };
  }

  return { ok: true, centiseconds: totalCentiseconds };
}

/** Convierte centésimas de segundo totales a "mmsscc" para mostrar/editar. */
export function formatSwimTimeCentiseconds(totalCentiseconds: number | null): string {
  if (totalCentiseconds === null || totalCentiseconds < 0) return "";
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const centis = totalCentiseconds % 100;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}${String(seconds).padStart(2, "0")}${String(centis).padStart(2, "0")}`;
}

/** Versión legible para humanos, ej. "1:25,67" — solo para mostrar, no para el input editable. */
export function formatSwimTimeReadable(totalCentiseconds: number | null): string {
  if (totalCentiseconds === null || totalCentiseconds < 0) return "—";
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const centis = totalCentiseconds % 100;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")},${String(centis).padStart(2, "0")}`;
}
