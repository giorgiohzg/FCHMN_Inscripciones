/**
 * Etiquetas de las 4 posiciones de un equipo de relevo, en el orden en
 * que se ingresan/muestran. En una prueba "Combinado" el orden real de
 * natación es fijo: Espalda, Pecho, Mariposa, Libre (posiciones 1 a 4).
 * Para cualquier otro estilo de relevo (todos nadan el mismo estilo), la
 * posición es solo el orden de posta, sin un estilo distinto por puesto.
 */
export function relayPositionLabels(strokeName: string): string[] {
  if (strokeName.trim().toLowerCase() === "combinado") {
    return ["1er relevo — Espalda", "2do relevo — Pecho", "3er relevo — Mariposa", "4to relevo — Libre"];
  }
  return ["1er relevo", "2do relevo", "3er relevo", "4to relevo"];
}
