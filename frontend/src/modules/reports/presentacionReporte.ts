import { nombreEnPanel } from "../../shared/nombreDeNadador";
import type { ClubGroupSwimmerRow, PruebaDeJornada } from "./reportsApi";

/**
 * PRESENTACIÓN EN PANTALLA de la línea de cada nadador en «Generar reporte» (vista agrupada).
 *
 * Formato: `PATERNO MATERNO, NOMBRE (EDAD) - Categoría - Género`, p. ej.
 * `SINTÉTICO EJEMPLO, ANA MARÍA (54) - Master G - Damas`.
 *
 *  - El servidor ya entrega el nombre y el detalle presentados (`nombrePresentado`, `detalle`), los
 *    mismos que usan CSV, Excel y PDF. Lo que sigue es solo para una API anterior, que no los envía.
 *  - El nombre sale de los campos separados que entrega el servidor (`apellidoPaterno`,
 *    `apellidoMaterno`, `nombres`) con el MISMO criterio de los paneles (`nombreEnPanel`):
 *    mayúsculas solo de presentación y, si el registro está incompleto (sin apellido paterno o sin
 *    nombre, o con una API anterior que aún no envía esos campos), el nombre almacenado
 *    (`nombreCompleto`) en mayúsculas, sin coma ni apellidos inventados.
 *  - La edad es la que calcula el servidor a la fecha de corte; categoría y género, los recibidos.
 *  - NO ordena: el orden de los nadadores es el del servidor (`compararNadadores` del backend).
 *  - Es solo pantalla: los archivos se arman en el servidor, y Team Manager no pasa por aquí.
 */
export function partesDeLineaDelReporte(s: ClubGroupSwimmerRow): { nombre: string; detalle: string } {
  if (s.nombrePresentado !== undefined && s.detalle !== undefined) return { nombre: s.nombrePresentado, detalle: ` ${s.detalle}` };
  const nombre = nombreEnPanel({
    fullName: s.nombreCompleto,
    paternalLastName: s.apellidoPaterno,
    maternalLastName: s.apellidoMaterno,
    firstName: s.nombres,
  });
  return { nombre, detalle: ` (${s.edad}) - ${s.categoria} - ${s.genero}` };
}

/** La línea completa como texto, sin la numeración. */
export function lineaDelReporte(s: ClubGroupSwimmerRow): string {
  const { nombre, detalle } = partesDeLineaDelReporte(s);
  return `${nombre}${detalle}`;
}

/** Encabezados de los dos bloques, los mismos de Excel y PDF (`ENCABEZADOS_DE_BLOQUES` del servidor). */
export const ENCABEZADOS_DE_BLOQUES = ["Fecha y jornada", "Prueba", "Tiempo", "Prueba", "Tiempo"] as const;

/**
 * Las pruebas de UNA jornada en filas de dos bloques, de izquierda a derecha y siguiendo en la fila
 * siguiente, en el orden que entrega el servidor. Con una cantidad impar, el último bloque derecho
 * queda vacío. Es solo disposición: no reordena, y recibe una sola jornada, así que nunca empareja
 * pruebas de jornadas, días, nadadores o clubes distintos. Excel y PDF usan la misma regla en el servidor.
 */
export function enDosBloques(pruebas: readonly PruebaDeJornada[]): { izquierda: PruebaDeJornada; derecha: PruebaDeJornada | null }[] {
  const filas: { izquierda: PruebaDeJornada; derecha: PruebaDeJornada | null }[] = [];
  for (let i = 0; i < pruebas.length; i += 2) filas.push({ izquierda: pruebas[i]!, derecha: pruebas[i + 1] ?? null });
  return filas;
}
