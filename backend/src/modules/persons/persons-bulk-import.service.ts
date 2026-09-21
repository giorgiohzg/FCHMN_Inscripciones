import ExcelJS from "exceljs";
import { createPerson } from "./persons.service";
import { mapRowToPersonInput, PERSONS_IMPORT_HEADERS } from "./persons-bulk-import.rules";
import { ValidationError } from "../../shared/errors";

interface ActorContext {
  userId: string;
  ipAddress?: string;
}

/**
 * Nombre de la hoja de DATOS. El importador la busca por nombre; ver
 * `importPersonsFromExcel`.
 */
export const PERSONS_IMPORT_SHEET = "Personas";

/** Nombre de la hoja de AYUDA. Nunca se procesa. */
export const PERSONS_INSTRUCTIONS_SHEET = "Instrucciones";

/** La fila ilustrativa: vive en la hoja de ayuda, jamás en la de datos. */
const EXAMPLE_ROW = [
  "12.345.678-5",
  "jperez",
  "Juan",
  "Pérez",
  "González",
  "15-03-1990",
  "Masculino",
  "jperez@correo.cl",
  "912345678",
];

/**
 * Plantilla descargable: DOS hojas.
 *
 *   - `Personas`: solo el encabezado, sin ninguna fila de datos.
 *   - `Instrucciones`: la fila de ejemplo y las notas de formato.
 *
 * ANTES ERA UNA SOLA HOJA, y ese diseño creaba personas falsas. El ejemplo
 * («Juan Pérez González», RUN 12.345.678-5) es una fila enteramente válida, de
 * modo que quien descargaba la plantilla y la subía sin editar insertaba esa
 * persona en la base. La nota que acompañaba al ejemplo no solo no lo impedía:
 * lo autorizaba —«Elimine la fila de ejemplo […] o déjela y solo agregue filas
 * nuevas debajo»—, una instrucción contradictoria consigo misma.
 *
 * La separación en dos hojas resuelve el problema por construcción, sin
 * marcadores ocultos ni RUN reservados: la hoja que el importador lee no
 * contiene datos, y la que contiene el ejemplo no se lee.
 */
export async function buildPersonsImportTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  // --- Hoja de datos: encabezado y nada más -------------------------------
  const datos = workbook.addWorksheet(PERSONS_IMPORT_SHEET);
  datos.addRow(PERSONS_IMPORT_HEADERS).font = { bold: true };
  PERSONS_IMPORT_HEADERS.forEach((_, i) => {
    datos.getColumn(i + 1).width = 26;
  });

  // --- Hoja de ayuda: ejemplo y notas, fuera del alcance del importador ---
  const guia = workbook.addWorksheet(PERSONS_INSTRUCTIONS_SHEET);
  guia.getColumn(1).width = 120;

  guia.addRow([`Esta hoja es solo informativa: el sistema NO la lee ni importa nada de ella.`]).font = {
    bold: true,
  };
  guia.addRow([`Escriba sus datos en la hoja «${PERSONS_IMPORT_SHEET}», a partir de la fila 2.`]);
  guia.addRow([]);

  guia.addRow(["Ejemplo de una fila bien formada (informativo, NO se importa):"]).font = { bold: true };
  guia.addRow(PERSONS_IMPORT_HEADERS).font = { italic: true };
  guia.addRow(EXAMPLE_ROW).font = { italic: true };
  guia.addRow([]);

  guia.addRow(["Notas:"]).font = { italic: true, bold: true };
  guia.addRow([`- No borre ni reordene la fila de encabezado de la hoja «${PERSONS_IMPORT_SHEET}» (fila 1).`]);
  guia.addRow([`- No escriba datos en esta hoja: no se procesan. Solo se lee «${PERSONS_IMPORT_SHEET}».`]);
  guia.addRow(["- Fecha de nacimiento: formato DD-MM-AAAA (ej: 15-03-1990)."]);
  guia.addRow(["- Género: escriba exactamente \"Femenino\" o \"Masculino\"."]);
  guia.addRow([
    "- Este archivo NO tiene columna de roles. El rol de nadador se obtiene al incorporar a la persona al plantel de un club (Asignaciones), y los de delegado, entrenador y representante legal al nombrarla en la ficha del club. Si reutiliza una plantilla antigua con esa columna, bórrela: el sistema rechazará las filas que la traigan.",
  ]);
  guia.addRow(["- El correo electrónico, el teléfono y el apellido materno son opcionales. Todos los demás campos son obligatorios."]);
  guia.addRow(["- El nombre de usuario y el RUN deben ser únicos — el sistema rechazará filas duplicadas o ya existentes."]);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export interface BulkImportRowResult {
  row: number; // número de fila en el Excel (1-indexado, incluye el encabezado)
  status: "created" | "error";
  fullName?: string;
  errors?: string[];
}

export interface BulkImportSummary {
  totalRows: number;
  createdCount: number;
  errorCount: number;
  results: BulkImportRowResult[];
}

/**
 * Procesa el archivo Excel subido: valida y crea una persona por fila
 * válida (reutilizando `createPerson`, con las mismas reglas — RUN único,
 * nombre de usuario único, etc.). Una fila con errores
 * NO detiene el procesamiento de las demás — se acumulan todos los
 * resultados en un solo reporte.
 *
 * El comportamiento ES PARCIAL ENTRE FILAS, a propósito: las válidas se crean
 * aunque otras fallen. Lo que no ocurre es que una fila rechazada deje una
 * escritura a medias.
 */
export async function importPersonsFromExcel(fileBuffer: Buffer, actor: ActorContext): Promise<BulkImportSummary> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(fileBuffer as any);
  } catch {
    throw new ValidationError("El archivo no es un Excel (.xlsx) válido.");
  }

  /**
   * SE ELIGE LA HOJA POR NOMBRE, no por posición.
   *
   * La plantilla trae `Personas` (datos) e `Instrucciones` (ejemplo y notas),
   * y el orden en que un editor las guarde no debe decidir cuál se importa:
   * si `Instrucciones` quedara primera, leer «la hoja 0» procesaría el ejemplo.
   *
   * La primera hoja se usa SOLO como respaldo, para los archivos anteriores a
   * este cambio, que traían una única hoja y podían tener cualquier nombre.
   */
  const sheet = workbook.getWorksheet(PERSONS_IMPORT_SHEET) ?? workbook.worksheets[0];
  if (!sheet) throw new ValidationError("El archivo no tiene ninguna hoja de cálculo.");

  const results: BulkImportRowResult[] = [];
  let createdCount = 0;

  // Fila 1 = encabezado, se omite. exceljs es 1-indexado.
  const lastRow = sheet.rowCount;
  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const rawValues: unknown[] = [];
    for (let col = 1; col <= 10; col++) {
      rawValues.push(row.getCell(col).value);
    }

    // Filas completamente vacías (ej. al final del archivo) se ignoran en silencio.
    if (rawValues.every((v) => v === null || v === undefined || String(v).trim() === "")) continue;

    const mapped = mapRowToPersonInput(rawValues);
    if (!mapped.ok || !mapped.data) {
      results.push({ row: rowNumber, status: "error", errors: mapped.errors });
      continue;
    }

    try {
      const person = await createPerson(mapped.data, actor);
      results.push({ row: rowNumber, status: "created", fullName: person.fullName });
      createdCount++;
    } catch (err) {
      results.push({ row: rowNumber, status: "error", errors: [err instanceof Error ? err.message : "Error desconocido al crear la persona"] });
    }
  }

  return { totalRows: results.length, createdCount, errorCount: results.length - createdCount, results };
}
