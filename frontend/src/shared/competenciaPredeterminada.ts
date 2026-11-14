/**
 * SELECCIÓN DE COMPETENCIA del Panel de Inscripción y del Panel de Relevos cada vez que llega la
 * lista del desplegable.
 *
 * `disponibles` es la lista que ESA cuenta ya puede ver y elegir: el servidor oculta Borrador y
 * Programada a quien no administra, y el panel pide solo las visibles en los paneles, salvo para
 * administración, que conserva su excepción para las ocultas.
 *
 *  - Si hay una competencia elegida (a mano o preseleccionada) y SIGUE en la lista, se conserva.
 *  - Si ya NO está (por ejemplo, la cuenta perdió administración y la competencia es oculta), la
 *    selección se INVALIDA y queda vacía. No se reemplaza por otra, tampoco por la predeterminada:
 *    el panel vuelve a «Elija una competencia…» y deja de mostrar lo de la anterior.
 *  - Sin elección: la predeterminada, si está en la lista y la persona no eligió a mano (volver a
 *    «Seleccionar...» también es elegir). Si no está, el selector queda sin elección.
 *
 * Las respuestas tardías de una lista anterior las descarta el propio panel (`vigente`), antes de
 * llamar a esta función.
 */
export interface SeleccionDeCompetencia {
  competitionId: string;
  /** La elección anterior ya no está disponible y se vació. */
  invalidada: boolean;
}

export function competenciaPreseleccionada(
  disponibles: readonly { id: string; esPredeterminada?: boolean }[],
  actual: string,
  eleccionManual: boolean
): SeleccionDeCompetencia {
  if (actual !== "") {
    return disponibles.some((c) => c.id === actual) ? { competitionId: actual, invalidada: false } : { competitionId: "", invalidada: true };
  }
  if (eleccionManual) return { competitionId: "", invalidada: false };
  return { competitionId: disponibles.find((c) => c.esPredeterminada === true)?.id ?? "", invalidada: false };
}
