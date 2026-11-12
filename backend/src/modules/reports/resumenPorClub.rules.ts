/**
 * Resumen de inscripciones por club: las reglas PURAS (orden y totales).
 *
 * Las cifras de cada club las calcula la base (ver `resumenPorClub.service.ts`); aquí solo
 * se ordenan las filas y se suman los totales, para poder probarlo sin base de datos.
 */
import { compararClubes } from "./reports.rules";

/** Una fila del resumen: un CLUB (por su id, no por su nombre) con sus cifras agregadas. */
export interface FilaResumenClub {
  clubId: string;
  clubName: string;
  /** Personas distintas del club con `gender = male`, cuente o no en relevos mixtos. */
  varones: number;
  /** Personas distintas del club con `gender = female`. */
  damas: number;
  /** Personas distintas del club, en individuales o en relevos. */
  totalNadadores: number;
  /**
   * De esas mismas personas distintas, las que tienen la edad mínima pedida o más a la fecha de
   * corte de la competencia (ver `limiteDeNacimientoPorEdad`). La edad mínima viaja aparte, en
   * `ResumenPorClub.edadMinima`.
   */
  nadadoresConEdadMinima: number;
  /** Inscripciones individuales confirmadas: cada una cuenta, aunque repita prueba del programa. */
  pruebasIndividuales: number;
  /** Equipos de relevo confirmados: cada equipo cuenta una vez, no por integrante. */
  relevos: number;
  /** `pruebasIndividuales + relevos`. */
  totalPruebas: number;
}

export type TotalesResumen = Omit<FilaResumenClub, "clubId" | "clubName">;

/**
 * Totales globales: la SUMA de cada columna sobre el conjunto completo de filas.
 *
 * Es una suma de columnas a propósito: si una misma persona compite por dos clubes en la
 * misma competencia, cuenta una vez en cada club y, por lo tanto, dos veces en el total.
 */
export function sumarTotales(filas: readonly FilaResumenClub[]): TotalesResumen {
  const totales: TotalesResumen = { varones: 0, damas: 0, totalNadadores: 0, nadadoresConEdadMinima: 0, pruebasIndividuales: 0, relevos: 0, totalPruebas: 0 };
  for (const f of filas) {
    totales.varones += f.varones;
    totales.damas += f.damas;
    totales.totalNadadores += f.totalNadadores;
    totales.nadadoresConEdadMinima += f.nadadoresConEdadMinima;
    totales.pruebasIndividuales += f.pruebasIndividuales;
    totales.relevos += f.relevos;
    totales.totalPruebas += f.totalPruebas;
  }
  return totales;
}

/** Orden de las filas: nombre del club (mismo criterio que los reportes) y, si se repite, su id. */
export function compararFilasResumen(a: Pick<FilaResumenClub, "clubName" | "clubId">, b: Pick<FilaResumenClub, "clubName" | "clubId">): number {
  return compararClubes(a.clubName, b.clubName) || (a.clubId < b.clubId ? -1 : a.clubId > b.clubId ? 1 : 0);
}

/** Edad mínima de la columna «Nadadores de N años o más» cuando la solicitud no la indica. */
export const EDAD_MINIMA_POR_OMISION = 70;

/**
 * Límites de la edad mínima: un entero de 0 a 150.
 *
 * El cálculo solo resta la edad al año de la fecha de corte y compara enteros, así que no hay
 * riesgo numérico; el tope de 150 cubre cualquier edad real y mantiene el año límite (año del
 * corte − edad) dentro de años de calendario válidos, sin depender del rango de fechas de la
 * base ni de JavaScript.
 */
export const EDAD_MINIMA_MINIMA = 0;
export const EDAD_MINIMA_MAXIMA = 150;

export function esEdadMinimaValida(edad: number): boolean {
  return Number.isSafeInteger(edad) && edad >= EDAD_MINIMA_MINIMA && edad <= EDAD_MINIMA_MAXIMA;
}

/** Fecha como tupla de componentes UTC (mes de 1 a 12), comparable campo por campo. */
export interface FechaUtc {
  anio: number;
  mes: number;
  dia: number;
}

/**
 * Límite de nacimiento para tener al menos `edad` años a `fechaDeCorte`, con el mismo
 * criterio que `computeAge` (componentes UTC; se cumple años el mismo día y mes).
 *
 * `computeAge(nacimiento, corte) >= edad` equivale exactamente a que la tupla
 * (año, mes, día) del nacimiento sea MENOR O IGUAL, campo por campo, a
 * (año del corte − edad, mes del corte, día del corte). No se construye ninguna fecha
 * restando años, así que el 29 de febrero no se «corrige» al 28 ni al 1 de marzo: quien
 * nació un 29 de febrero cumple en un año no bisiesto recién el 1 de marzo, como en
 * `computeAge`.
 */
export function limiteDeNacimientoPorEdad(fechaDeCorte: Date, edad: number): FechaUtc {
  return { anio: fechaDeCorte.getUTCFullYear() - edad, mes: fechaDeCorte.getUTCMonth() + 1, dia: fechaDeCorte.getUTCDate() };
}

/**
 * La misma comparación que hace la consulta del resumen, en TypeScript: solo existe para
 * comprobar sin base de datos que el límite equivale a `computeAge`.
 */
export function nacioHastaElLimite(nacimiento: Date, limite: FechaUtc): boolean {
  const n: FechaUtc = { anio: nacimiento.getUTCFullYear(), mes: nacimiento.getUTCMonth() + 1, dia: nacimiento.getUTCDate() };
  if (n.anio !== limite.anio) return n.anio < limite.anio;
  if (n.mes !== limite.mes) return n.mes < limite.mes;
  return n.dia <= limite.dia;
}
