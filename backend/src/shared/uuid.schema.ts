import { z } from "zod";

/**
 * Identificador de la API: ocho-cuatro-cuatro-cuatro-doce dígitos hexadecimales, sin exigir versión ni variante.
 *
 * Es el contrato HISTÓRICO (el `.uuid()` de cadena de Zod 3). `z.uuid()` de Zod 4 es más estricto —exige versión 1 a 8 y variante
 * RFC 9562/4122— y rechazaría identificadores que la API siempre aceptó y que existen en la base (por ejemplo los de prueba,
 * o los que inserte una migración o una carga a mano). `z.guid()` conserva la regla anterior. El mensaje, si se da, es el de siempre.
 */
export const uuidField = (mensaje?: string) => z.guid(mensaje);
