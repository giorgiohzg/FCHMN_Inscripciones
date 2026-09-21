/**
 * SEMÁNTICA DE LA DISTANCIA EN PRUEBAS DE RELEVO — decisión de negocio.
 *
 * `Event.distance` guarda SIEMPRE la distancia TOTAL de la prueba:
 *
 *   - Individual: 50 Libre  → distance = 50
 *   - Relevo:     4×50 Libre → distance = 200   (no 50)
 *
 * Por qué total y no por posta:
 *   - Es lo que traen los archivos .ev3 de Hy-Tek Meet Manager, que es la
 *     fuente de la que se importan los programas de competencia.
 *   - Es lo que espera el registro F1 del formato .HY3 al exportar.
 *   Con la distancia por posta habría que convertir en AMBOS extremos; con
 *   el total, la conversión ocurre solo al mostrarla en pantalla.
 *
 * El defecto que esto corrige: el importador guardaba el total (200 para un
 * 4×50) y el exportador multiplicaba por 4 asumiendo que era por posta, así
 * que un 4×50 importado se exportaba como un relevo de 800 metros. Ida y
 * vuelta EV3 → modelo → HY3 no era idempotente.
 */

/** Metros por posta, para mostrar "4×50" a partir de un total de 200. */
export function metersPerLeg(totalMeters: number, swimmersCount: number): number | null {
  if (swimmersCount <= 1) return null;
  if (totalMeters % swimmersCount !== 0) return null; // total no divisible: no se infiere
  return totalMeters / swimmersCount;
}

/**
 * Etiqueta legible de la distancia de una prueba.
 *   - Individual         → "50"
 *   - Relevo 4 × 50      → "4×50"
 *   - Relevo no divisible → "200" (se muestra el total tal cual)
 */
export function formatDistanceLabel(totalMeters: number, swimmersCount: number): string {
  const perLeg = metersPerLeg(totalMeters, swimmersCount);
  if (perLeg === null) return String(totalMeters);
  return `${swimmersCount}×${perLeg}`;
}

/**
 * Distancia total que debe escribirse en el registro F1 del archivo .HY3.
 * Es directamente el valor almacenado: NO se multiplica por la cantidad de
 * nadadores, porque ya es el total.
 */
export function relayTotalMetersForExport(storedDistanceMeters: number): number {
  return storedDistanceMeters;
}
