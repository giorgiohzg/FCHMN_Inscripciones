/**
 * Parser del formato Hy-Tek ".ev3" ("Meet Events" — el programa de
 * pruebas de una competencia, exportado desde Hy-Tek Meet Manager).
 * Decodificado línea por línea a partir de una exportación real de Meet
 * Manager — no es documentación de terceros sin contrastar.
 *
 * El fixture que se conserva en el repositorio (`tests/fixtures/sample.ev3`)
 * es SINTÉTICO: reproduce esa estructura con una competencia inventada.
 *
 * Formato: texto separado por punto y coma, una línea de encabezado y
 * luego una línea por prueba, cada línea terminada en "*>". A diferencia
 * del formato HY3 (ancho fijo, con checksum) usado en la exportación a
 * Team Manager, este es de ancho variable y no lleva checksum.
 *
 * Campos del ENCABEZADO verificados contra la muestra:
 *   [0] nombre de la competencia
 *   [2] fecha de inicio (MM/DD/AAAA)
 *   [3] fecha de fin (MM/DD/AAAA)
 *   [4] fecha de corte de edad (MM/DD/AAAA) — coincide EXACTAMENTE con
 *       nuestro concepto de `Competition.ageCutoffDate` (RB-05).
 *
 * Campos de cada línea de PRUEBA verificados contra la muestra:
 *   [0] número de la prueba (orden en el programa)
 *   [4] "I" (individual) o "R" (relevo)
 *   [5] género: "W" (mujeres) o "M" (hombres) — no se observó "X"
 *       (mixto) en la muestra, pero se contempla por si aparece.
 *   [8] distancia total en metros
 *   [9] código de estilo de una letra: A=Libre, B=Espalda, C=Pecho,
 *       D=Mariposa, E=Combinado — mismo mapeo ya verificado de forma
 *       independiente en el Módulo 11 (exportación HY3) y confirmado de
 *       nuevo aquí por el archivo .hyv complementario (códigos numéricos
 *       1-5 con la misma correspondencia).
 *   [23] hora de la sesión (ej. "09:45AM")
 */

export type ParsedGender = "male" | "female" | "mixed";

const STROKE_CODE_TO_NAME: Record<string, string> = {
  A: "Libre",
  B: "Espalda",
  C: "Pecho",
  D: "Mariposa",
  E: "Combinado",
};

const GENDER_CODE_TO_VALUE: Record<string, ParsedGender> = {
  W: "female",
  M: "male",
  X: "mixed",
};

export interface ParsedMeetEvent {
  eventNumber: number;
  isRelay: boolean;
  gender: ParsedGender;
  distanceMeters: number;
  strokeName: string;
  sessionTime: string; // tal como viene en el archivo, ej. "09:45AM"
}

export interface ParsedMeet {
  name: string;
  startDate: Date;
  endDate: Date;
  ageCutoffDate: Date;
  events: ParsedMeetEvent[];
  warnings: string[];
}

function parseUsDate(raw: string): Date | null {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, mm, dd, yyyy] = match;
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (date.getUTCMonth() !== Number(mm) - 1 || date.getUTCDate() !== Number(dd)) return null;
  return date;
}

/**
 * Parsea el contenido completo de un archivo `.ev3` (ya leído como texto,
 * codificación ISO-8859-1/Latin-1 igual que el resto de los formatos
 * Hy-Tek). Lanza un error solo si el encabezado es ilegible; las pruebas
 * individuales con datos raros se omiten con una advertencia en vez de
 * abortar todo el archivo.
 */
export function parseEv3File(content: string): ParsedMeet {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    throw new Error("El archivo .ev3 está vacío.");
  }

  const headerFields = lines[0]!.replace(/\*>$/, "").split(";");
  const name = (headerFields[0] ?? "").trim();
  const startDate = parseUsDate(headerFields[2] ?? "");
  const endDate = parseUsDate(headerFields[3] ?? "");
  const ageCutoffDate = parseUsDate(headerFields[4] ?? "");

  const warnings: string[] = [];
  if (!name) warnings.push("No se pudo leer el nombre de la competencia desde el encabezado.");
  if (!startDate) throw new Error(`No se pudo leer la fecha de inicio de la competencia (valor: "${headerFields[2]}").`);
  if (!endDate) throw new Error(`No se pudo leer la fecha de fin de la competencia (valor: "${headerFields[3]}").`);
  if (!ageCutoffDate) throw new Error(`No se pudo leer la fecha de corte de edad (valor: "${headerFields[4]}").`);

  const events: ParsedMeetEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i]!.replace(/\*>$/, "").split(";");
    const lineNumber = i + 1;

    const eventNumber = Number(fields[0]);
    const typeFlag = fields[4];
    const genderCode = fields[5];
    const distanceMeters = Number(fields[8]);
    const strokeCode = fields[9];
    const sessionTime = fields[24] ?? "";

    if (!Number.isFinite(eventNumber)) {
      warnings.push(`Línea ${lineNumber}: número de prueba ilegible, se omite.`);
      continue;
    }
    if (typeFlag !== "I" && typeFlag !== "R") {
      warnings.push(`Prueba ${eventNumber}: tipo "${typeFlag}" no reconocido (se esperaba I o R), se omite.`);
      continue;
    }
    const gender = genderCode ? GENDER_CODE_TO_VALUE[genderCode] : undefined;
    if (!gender) {
      warnings.push(`Prueba ${eventNumber}: género "${genderCode}" no reconocido, se omite.`);
      continue;
    }
    if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
      warnings.push(`Prueba ${eventNumber}: distancia "${fields[8]}" inválida, se omite.`);
      continue;
    }
    const strokeName = strokeCode ? STROKE_CODE_TO_NAME[strokeCode] : undefined;
    if (!strokeName) {
      warnings.push(`Prueba ${eventNumber}: código de estilo "${strokeCode}" no reconocido, se omite.`);
      continue;
    }

    events.push({ eventNumber, isRelay: typeFlag === "R", gender, distanceMeters, strokeName, sessionTime });
  }

  if (events.length === 0) {
    warnings.push("No se pudo interpretar ninguna prueba del archivo.");
  }

  return { name, startDate, endDate, ageCutoffDate, events, warnings };
}
