import { nombreEnPanel } from "../../shared/nombreDeNadador";
import type { ClubGroupSwimmerRow } from "./reportsApi";

/**
 * PRESENTACIÓN EN PANTALLA de la línea de cada nadador en «Generar reporte» (vista agrupada).
 *
 * Formato: `PATERNO MATERNO, NOMBRE (EDAD) - Categoría - Género`, p. ej.
 * `SINTÉTICO EJEMPLO, ANA MARÍA (54) - Master G - Damas`.
 *
 *  - El nombre sale de los campos separados que entrega el servidor (`apellidoPaterno`,
 *    `apellidoMaterno`, `nombres`) con el MISMO criterio de los paneles (`nombreEnPanel`):
 *    mayúsculas solo de presentación y, si el registro está incompleto (sin apellido paterno o sin
 *    nombre, o con una API anterior que aún no envía esos campos), el nombre almacenado
 *    (`nombreCompleto`) en mayúsculas, sin coma ni apellidos inventados.
 *  - La edad es la que calcula el servidor a la fecha de corte; categoría y género, los recibidos.
 *  - NO ordena: el orden de los nadadores es el del servidor (`compararNadadores` del backend).
 *  - Es solo pantalla: CSV, XLSX, PDF y Team Manager no pasan por aquí.
 */
export function partesDeLineaDelReporte(s: ClubGroupSwimmerRow): { nombre: string; detalle: string } {
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
