import ExcelJS from "exceljs";
import { inspeccionarArchivo } from "./inspeccion-zip";
import {
  CELDAS_LEIDAS,
  MENSAJE_XLSX_INVALIDO,
  PERSONS_IMPORT_SHEET,
  RechazoXlsx,
  type FilaAnalizada,
  type LibroAnalizado,
  type LimitesXlsx,
} from "./limites";

const largo = (valor: unknown) => JSON.stringify(valor)?.length ?? 0;

/**
 * Lo que ExcelJS construyó de verdad, antes de recorrerlo. El escaneo ya lo midió; esta es
 * la defensa por si su lectura y la de ExcelJS divergieran: el bucle de filas usa este
 * número, y NaN tampoco pasa la comparación.
 */
function comprobarDimensionesEfectivas(workbook: ExcelJS.Workbook, limites: LimitesXlsx): void {
  if (workbook.worksheets.length > limites.hojasMax) {
    throw new RechazoXlsx(`El archivo tiene más de ${limites.hojasMax} hojas. No se importó ninguna fila.`);
  }
  for (const hoja of workbook.worksheets) {
    if (!(hoja.rowCount <= limites.indiceFilaMax) || !(hoja.columnCount <= limites.columnaMax)) {
      throw new RechazoXlsx(`La hoja «${hoja.name}» supera las dimensiones admitidas. No se importó ninguna fila.`);
    }
  }
}

/**
 * El análisis completo del archivo, sin base de datos y sin credenciales: inspecciona
 * el ZIP, carga el libro y devuelve las filas crudas. Corre en su propio proceso.
 *
 * `workbook.xlsx.load` se conserva, en vez del lector por flujo, porque es lo que da las
 * celdas combinadas, los hipervínculos, las fórmulas y las fechas con que ya funciona la
 * carga. Por eso `inspeccionarArchivo` va antes: mide lo que `load` recorrería a ciegas.
 */
export async function analizarLibro(archivo: Buffer, limites: LimitesXlsx): Promise<LibroAnalizado> {
  inspeccionarArchivo(archivo, limites);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(archivo as unknown as ArrayBuffer);
  } catch {
    throw new RechazoXlsx(MENSAJE_XLSX_INVALIDO);
  }

  comprobarDimensionesEfectivas(workbook, limites);

  /**
   * SE ELIGE LA HOJA POR NOMBRE, no por posición.
   *
   * La plantilla trae `Personas` (datos) e `Instrucciones` (ejemplo y notas),
   * y el orden en que un editor las guarde no debe decidir cuál se importa.
   * La primera hoja se usa SOLO como respaldo, para los archivos anteriores a
   * ese cambio, que traían una única hoja y podían tener cualquier nombre.
   */
  const sheet = workbook.getWorksheet(PERSONS_IMPORT_SHEET) ?? workbook.worksheets[0];
  if (!sheet) throw new RechazoXlsx("El archivo no tiene ninguna hoja de cálculo.");

  let caracteres = 0;
  const leerFila = (rowNumber: number): unknown[] => {
    const row = sheet.getRow(rowNumber);
    const valores: unknown[] = [];
    for (let col = 1; col <= CELDAS_LEIDAS; col++) {
      const valor = row.getCell(col).value;
      const caracteresCelda = largo(valor);
      if (caracteresCelda > limites.caracteresPorCeldaMax) {
        throw new RechazoXlsx(`La fila ${rowNumber} tiene una celda con más de ${limites.caracteresPorCeldaMax} caracteres. No se importó ninguna fila.`);
      }
      caracteres += caracteresCelda;
      if (caracteres > limites.caracteresTotalesMax) {
        throw new RechazoXlsx("Las celdas del archivo suman demasiado texto. No se importó ninguna fila.");
      }
      valores.push(valor);
    }
    return valores;
  };

  const encabezado = leerFila(1);

  // Filas con algún dato (las completamente vacías se ignoran en silencio).
  const filas: FilaAnalizada[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const valores = leerFila(rowNumber);
    if (valores.every((v) => v === null || v === undefined || String(v).trim() === "")) continue;
    filas.push({ row: rowNumber, valores });
    if (filas.length > limites.filasConDatosMax) {
      throw new RechazoXlsx(`El archivo tiene más de ${limites.filasConDatosMax.toLocaleString("es-CL")} personas. Divídalo en varios archivos. No se importó ninguna fila.`);
    }
  }

  return { encabezado, filas };
}
