/**
 * Límites de las listas JSON que recibe la API (SEC-01) y de los cuerpos que las llevan.
 *
 * Existen por una razón concreta: en Zod 3 el `.max()` de un arreglo NO corta el recorrido (valida
 * todos los elementos y solo después marca el exceso), así que una lista enorme de elementos
 * inválidos producía cientos de miles de errores antes de rechazarse. Aquí viven los números, y
 * `listaAcotada` (ver `listaAcotada.ts`) comprueba la longitud ANTES de mirar un solo elemento.
 *
 * Son límites TÉCNICOS de la API, no reglas del dominio: la regla de cuántos integrantes tiene un
 * relevo sigue siendo `TestType.swimmersCount`, que valida el servicio con la cantidad exacta.
 */

/** Máximo de elementos por lista. */
export const LIMITES_LISTAS = {
  /**
   * Integrantes de un relevo. El estándar lleva 4; el catálogo admite otros tipos y el esquema de
   * datos no impide un `swimmersCount` mayor, de modo que un tipo con más de 8 nadadores no podría
   * inscribirse hasta subir este tope.
   */
  integrantesDeRelevo: 8,
  /** Nadadores en una asignación masiva. No garantiza una duración determinada de la operación. */
  asignacionMasiva: 10_000,
  delegadosPorClub: 50,
  entrenadoresPorClub: 50,
  categoriasPorPrueba: 100,
  reordenamientos: 1_000,
  /** Decisiones de relevo de la importación de Meet Events (el tope que ya existía). */
  decisionesDeRelevo: 500,
} as const;

const KIB = 1024;

/** `bodyLimit` por ruta JSON, en bytes. Se aplica antes de autenticar y no rige para multipart. */
export const LIMITES_CUERPO_JSON = {
  relevos: 4 * KIB,
  asignacionMasiva: 512 * KIB,
  clubes: 32 * KIB,
  categoriasPorPrueba: 16 * KIB,
  reordenamientos: 256 * KIB,
} as const;

/** Límites del multipart de analizar e importar Meet Events (el archivo conserva el máximo global). */
export const LIMITES_MULTIPART_IMPORTACION = {
  fieldSize: 64 * KIB,
  fields: 4,
  files: 1,
  parts: 6,
} as const;

/** Longitud máxima, en caracteres, del nombre de cualquier parte del multipart de importación. */
export const LONGITUD_MAXIMA_NOMBRE_DE_CAMPO = 64;
