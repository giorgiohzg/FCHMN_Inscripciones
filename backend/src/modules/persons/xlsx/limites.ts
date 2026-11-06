/**
 * Límites del procesamiento del archivo de la carga masiva de personas.
 *
 * Este módulo y los demás de esta carpeta (salvo `analisis-aislado.ts`) se cargan
 * DENTRO del proceso de análisis: no deben importar Prisma, `shared/env` ni nada que lea
 * credenciales. `xlsx-analisis.test.ts` lo comprueba.
 *
 * La calibración de estos valores, con los tamaños y tiempos medidos, está en
 * `docs/seguridad/PLAN_SEGURIDAD.md` (Fase 4).
 */
export interface LimitesXlsx {
  /** Tamaño del archivo subido. Se corta al recibirlo, antes de acumularlo. */
  comprimidoMaxBytes: number;
  /** Entradas del ZIP, directorios incluidos. */
  entradasMax: number;
  /** Bytes REALES descomprimidos de una entrada. */
  entradaMaxBytes: number;
  /** Bytes REALES descomprimidos del archivo entero. */
  totalMaxBytes: number;
  /** Hojas del libro. */
  hojasMax: number;
  /** Elementos `<row>` de todas las hojas juntas, con datos o sin ellos. */
  filasMax: number;
  /** Mayor número de fila admitido. Es lo que frena una hoja dispersa. */
  indiceFilaMax: number;
  /** Mayor número de columna admitido en celdas y en referencias (combinaciones, validaciones, nombres). */
  columnaMax: number;
  /**
   * Mayor extremo `min` o `max` de una declaración de formato `<col>`. Es el máximo físico de una
   * hoja: Excel lo escribe al dar formato o ancho a la hoja entera. Es un límite APARTE de
   * `columnaMax`: lo que ExcelJS crea por una declaración son objetos de formato (no celdas) y
   * su número está acotado por este valor en cada hoja.
   */
  columnasDeFormatoMax: number;
  /** Elementos `<c>` de todas las hojas juntas. */
  celdasMax: number;
  /** Elementos `<si>` de las cadenas compartidas. */
  cadenasCompartidasMax: number;
  /** Celdas que abarcan, sumadas, las combinaciones, validaciones y nombres definidos. */
  areaDeclaradaMax: number;
  /** Filas CON DATOS de la hoja que se importa. */
  filasConDatosMax: number;
  /** Caracteres de una celda leída. */
  caracteresPorCeldaMax: number;
  /** Caracteres de todas las celdas leídas: una cadena compartida se repite gratis. */
  caracteresTotalesMax: number;
  /** Plazo del análisis, desde que se lanza su proceso. Al vencer se le mata. */
  plazoAnalisisMs: number;
  /** Plazo para recibir el archivo: un envío detenido no retiene la carga. */
  plazoSubidaMs: number;
  /** Montón de V8 del proceso de análisis. NO cubre los buffers externos: ver `analisis-aislado.ts`. */
  monticuloAnalisisMb: number;
}

const MIB = 1024 * 1024;

export const LIMITES_XLSX: Readonly<LimitesXlsx> = Object.freeze({
  comprimidoMaxBytes: 4 * MIB,
  entradasMax: 128,
  entradaMaxBytes: 16 * MIB,
  totalMaxBytes: 32 * MIB,
  hojasMax: 16,
  filasMax: 25_000,
  indiceFilaMax: 25_000,
  columnaMax: 1_024,
  columnasDeFormatoMax: 16_384,
  celdasMax: 300_000,
  cadenasCompartidasMax: 150_000,
  areaDeclaradaMax: 300_000,
  filasConDatosMax: 10_000,
  caracteresPorCeldaMax: 2_048,
  caracteresTotalesMax: 8 * MIB,
  plazoAnalisisMs: 60_000,
  plazoSubidaMs: 120_000,
  monticuloAnalisisMb: 128,
});

/** Nombre de la hoja de datos. El analizador la busca por nombre. */
export const PERSONS_IMPORT_SHEET = "Personas";

/** Cuántas celdas se leen por fila: A-K más una de control (L) para detectar datos de sobra. */
export const CELDAS_LEIDAS = 12;

/** Un rechazo previsto del archivo. Su mensaje es para quien hace la carga. */
export class RechazoXlsx extends Error {}

export const MENSAJE_XLSX_INVALIDO = "El archivo no es un Excel (.xlsx) válido.";

export interface FilaAnalizada {
  row: number;
  valores: unknown[];
}

export interface LibroAnalizado {
  encabezado: unknown[];
  filas: FilaAnalizada[];
}

/** Lo que el proceso de análisis le responde al principal. */
export type RespuestaDelAnalisis = { tipo: "listo"; libro: LibroAnalizado } | { tipo: "rechazo"; mensaje: string } | { tipo: "fallo" };
