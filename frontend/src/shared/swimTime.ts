/**
 * ENTRADA DEL TIEMPO ESTIMADO: de 1 a 6 dígitos, sin separadores, que se leen DE DERECHA A
 * IZQUIERDA. Los dos últimos son centésimas, los dos anteriores segundos y los restantes (hasta
 * dos) minutos; lo que falta a la izquierda vale cero. Así no hace falta escribir seis dígitos ni
 * ceros iniciales: "13236" = 1:32,36; "2356" = 0:23,56; "1" = 0:00,01; "012567" = 1:25,67.
 *
 * Reglas que se conservan: segundos entre 00 y 59 (un "6000" NO se convierte en un minuto: se
 * rechaza); el tiempo cero se rechaza; solo dígitos ASCII, sin signos, decimales, exponentes ni
 * separadores; se ignoran los espacios exteriores. El campo vacío no llega aquí: cada operación
 * decide qué significa (opcional al crear, «sin tiempo» al editar).
 *
 * Se guarda como centésimas de segundo TOTALES (entero), que es lo que recibe el backend. Ojo con
 * las unidades: la ENTRADA "20000" es 2:00,00, mientras que el número GUARDADO 20000 es 3:20,00.
 * Para precargar un campo con un tiempo guardado se usa `formatSwimTimeCentiseconds`, nunca el
 * número convertido a texto.
 *
 * El backend tiene su propio `shared/swimTime.util.ts` con el formato fijo de 6 dígitos; ninguna
 * ruta lo usa para leer entradas (recibe centésimas numéricas), y no se modificó.
 */

const TIME_INPUT_PATTERN = /^[0-9]{1,6}$/;

/** Ayuda breve para los campos de tiempo (etiquetas y `title`). */
export const AYUDA_ENTRADA_DE_TIEMPO =
  "Hasta 6 dígitos, sin separadores, leídos de derecha a izquierda: centésimas, segundos y minutos (ej.: 13236 = 1:32,36; 2356 = 0:23,56).";

export interface SwimTimeParseResult {
  ok: boolean;
  centiseconds?: number;
  error?: string;
}

export function parseSwimTimeInput(raw: string): SwimTimeParseResult {
  const trimmed = raw.trim();
  if (!TIME_INPUT_PATTERN.test(trimmed)) {
    return { ok: false, error: "Formato inválido — escriba hasta 6 dígitos, de derecha a izquierda: centésimas, segundos y minutos (ej.: 13236 = 1:32,36)." };
  }
  // Las posiciones ausentes a la izquierda valen cero.
  const digitos = trimmed.padStart(6, "0");
  const minutes = Number(digitos.slice(0, 2));
  const seconds = Number(digitos.slice(2, 4));
  const centis = Number(digitos.slice(4, 6));

  if (seconds > 59) {
    return { ok: false, error: "Los segundos no pueden ser mayores a 59." };
  }

  const totalCentiseconds = (minutes * 60 + seconds) * 100 + centis;
  if (totalCentiseconds <= 0) {
    return { ok: false, error: "El tiempo debe ser mayor a cero." };
  }

  return { ok: true, centiseconds: totalCentiseconds };
}

/**
 * Centésimas TOTALES guardadas → texto del campo editable ("mmsscc"), para precargar una edición.
 * Es la inversa del parseo: guardar sin cambios envía exactamente lo guardado.
 */
export function formatSwimTimeCentiseconds(totalCentiseconds: number | null | undefined): string {
  if (totalCentiseconds === null || totalCentiseconds === undefined || totalCentiseconds < 0) return "";
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const centis = totalCentiseconds % 100;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}${String(seconds).padStart(2, "0")}${String(centis).padStart(2, "0")}`;
}

/** Versión legible, ej. "1:25,67" — solo para mostrar en tablas, no para el input editable. */
export function formatSwimTimeReadable(totalCentiseconds: number | null | undefined): string {
  if (totalCentiseconds === null || totalCentiseconds === undefined || totalCentiseconds < 0) return "—";
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const centis = totalCentiseconds % 100;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")},${String(centis).padStart(2, "0")}`;
}
