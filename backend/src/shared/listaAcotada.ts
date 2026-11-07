import { z } from "zod";

/**
 * Lista con tope de longitud que se comprueba ANTES de validar sus elementos.
 *
 * Con Zod 3 `z.array(...).max(n)` recorría y validaba todos los elementos y solo al final añadía el error
 * del máximo: con un millón de elementos inválidos generaba cientos de miles de errores (medido). Zod 4.6.6+
 * (GHSA-mrhx-c7xc-m3w5) también comprueba los límites de tamaño antes de los elementos, pero este control se
 * CONSERVA a propósito: es una defensa propia, con su mensaje y sus pruebas, que no depende de que una versión
 * futura de la biblioteca conserve esa corrección.
 *
 * Aquí la longitud se comprueba primero con un `custom` y el esquema de la lista solo se ejecuta
 * (`pipe`) si ese paso no la rechazó. Con exceso hay UN error y ningún elemento se valida.
 *
 * Lo que no es una lista (ausente, `null`, texto, objeto) pasa de largo la comprobación de longitud y
 * lo rechaza el esquema de la lista con su propio error de tipo. Los mínimos, los mensajes y la
 * opcionalidad que ya tuviera el esquema interno no cambian: para una lista opcional, se aplica
 * `.optional()` al resultado y «no enviado» sigue significando «no tocar».
 */
export function listaAcotada<S extends z.ZodType>(max: number, esquemaDeLista: S, mensaje: string): z.ZodType<z.output<S>, z.input<S>> {
  const porLongitud = z.custom<unknown>((valor) => !Array.isArray(valor) || valor.length <= max, { error: mensaje });
  return porLongitud.pipe(esquemaDeLista) as unknown as z.ZodType<z.output<S>, z.input<S>>;
}
