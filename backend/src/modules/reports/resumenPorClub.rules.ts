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
  const totales: TotalesResumen = { varones: 0, damas: 0, totalNadadores: 0, pruebasIndividuales: 0, relevos: 0, totalPruebas: 0 };
  for (const f of filas) {
    totales.varones += f.varones;
    totales.damas += f.damas;
    totales.totalNadadores += f.totalNadadores;
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
