import { ValidationError } from "./errors";

/**
 * Hallazgo 13 (reapertura) — catálogos retirados: se conserva el historial,
 * pero no se admiten operaciones nuevas.
 *
 * La eliminación de categorías y pruebas maestras es LÓGICA (`deletedAt`),
 * precisamente para que los reportes y las exportaciones de competencias
 * pasadas sigan mostrando "Master A" o "50 Libre" aunque el catálogo haya
 * cambiado. El problema era que ese mismo dato retirado seguía sirviendo
 * para inscribir: una categoría eliminada continuaba resolviendo la edad de
 * nuevos nadadores, y una prueba maestra eliminada seguía inscribiendo gente
 * si ya estaba asignada a una competencia. Desaparecían de los listados de
 * catálogo, pero no del flujo de inscripción.
 *
 * La distinción que aplican estas funciones:
 *   - LEER historial (reportes, listados de inscripciones ya hechas) → todo.
 *   - CREAR o MODIFICAR inscripciones → solo catálogos vigentes.
 */

interface SoftDeletable {
  deletedAt: Date | null;
}

/** Categorías habilitadas de una prueba de competencia que siguen vigentes. */
export function activeCategories<T extends SoftDeletable>(categories: T[]): T[] {
  return categories.filter((c) => c.deletedAt === null);
}

/**
 * Rechaza operar sobre una prueba de competencia cuya prueba maestra fue
 * retirada del catálogo, o cuyas categorías habilitadas están todas
 * retiradas.
 */
export function assertCompetitionEventCatalogUsable(params: {
  eventDeletedAt: Date | null;
  eventLabel: string;
  enabledCategories: SoftDeletable[];
}): void {
  if (params.eventDeletedAt !== null) {
    throw new ValidationError(
      `La prueba "${params.eventLabel}" fue eliminada del catálogo general y ya no admite inscripciones nuevas. ` +
        `Las inscripciones existentes se conservan; para volver a usarla, restaure la prueba en Catálogos o retírela de la competencia.`
    );
  }

  if (params.enabledCategories.length > 0 && activeCategories(params.enabledCategories).length === 0) {
    throw new ValidationError(
      `Todas las categorías habilitadas para la prueba "${params.eventLabel}" fueron eliminadas del catálogo. ` +
        `Habilite al menos una categoría vigente antes de inscribir.`
    );
  }
}
