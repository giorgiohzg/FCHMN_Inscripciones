import { z } from "zod";

/**
 * Lista con tope de longitud que se comprueba ANTES de validar sus elementos.
 *
 * En Zod 3 `z.array(...).max(n)` recorre y valida todos los elementos y solo al final añade el error
 * del máximo: con un millón de elementos inválidos generaba cientos de miles de errores (medido).
 * Aquí la longitud se comprueba primero con un `custom` y el esquema de la lista solo se ejecuta
 * (`pipe`) si ese paso no la rechazó. Con exceso hay UN error y ningún elemento se valida.
 *
 * Lo que no es una lista (ausente, `null`, texto, objeto) pasa de largo la comprobación de longitud y
 * lo rechaza el esquema de la lista con sus mismos mensajes (`Required`, `Expected array`). Los
 * mínimos, los mensajes y la opcionalidad que ya tuviera el esquema interno no cambian: para una
 * lista opcional, se aplica `.optional()` al resultado y «no enviado» sigue significando «no tocar».
 */
export function listaAcotada<S extends z.ZodTypeAny>(max: number, esquemaDeLista: S, mensaje: string): z.ZodType<z.output<S>, z.ZodTypeDef, z.input<S>> {
  const porLongitud = z.custom<unknown>((valor) => !Array.isArray(valor) || valor.length <= max, { message: mensaje });
  return porLongitud.pipe(esquemaDeLista) as unknown as z.ZodType<z.output<S>, z.ZodTypeDef, z.input<S>>;
}
