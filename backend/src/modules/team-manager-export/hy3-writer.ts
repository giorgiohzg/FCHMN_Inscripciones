import { buildHy3Line } from "./hy3-checksum";
import { formatHy3Date, type TeamManagerExportModel } from "./export-model";

export { formatHy3Date };

/**
 * Constructor de registros del formato Hy-Tek HY3, con las posiciones de
 * columna EXACTAS decodificadas byte a byte de una exportación real de
 * Hy-Tek (resuelve A-06).
 *
 * Los fixtures que se conservan en el repositorio son SINTÉTICOS: reproducen
 * esa misma estructura con personas, club y competencia inventados.
 *
 * Convención: cada `buildXxx()` arma una cadena de 128 caracteres
 * (posiciones 0-127) que luego pasa por `buildHy3Line()` para agregar el
 * checksum verificado y completar los 130 caracteres de la línea.
 *
 * Los campos marcados "constante (observado en la muestra)" no tienen
 * semántica confirmada más allá de "Team Manager los espera con este
 * valor" — se replican tal cual aparecen en la exportación real en vez de
 * inventar un valor, para maximizar la probabilidad de que el archivo
 * generado sea aceptado sin errores.
 */

function padRight(value: string, width: number): string {
  return value.slice(0, width).padEnd(width, " ");
}
function padLeft(value: string, width: number): string {
  return value.slice(0, width).padStart(width, " ");
}

/** "h:mm AM" o "hh:mm PM": 7 u 8 caracteres según los dígitos de la hora. */
export function formatHy3Time(date: Date): string {
  let hours = date.getUTCHours();
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${ampm}`;
}

/** "350,00" (segundos,centésimas con coma decimal, sin separador de miles) — tal como en la muestra. */
export function formatHy3Time_SecondsComma(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const whole = Math.floor(clamped);
  const centis = Math.round((clamped - whole) * 100);
  return `${whole},${String(centis).padStart(2, "0")}`;
}

// --------------------------------------------------------------------------
// A1 — encabezado del archivo
// --------------------------------------------------------------------------
/**
 * El fabricante va en la columna 29: Meet Manager rechaza con «NO es un archivo
 * .HY3 creado por Active» lo que ofrecía este encabezado con otro nombre (ver el
 * README: es la diferencia que motivó el cambio, pero no se pudo ejecutar el
 * programa para aislarla).
 *
 * La hora va AJUSTADA A LA DERECHA en las columnas 66-74, de modo que su última
 * letra queda pegada al "TEAM MANAGER Lite" de la columna 75, con uno o dos
 * dígitos de hora. Antes iba a la izquierda desde la 68: con dos dígitos corría
 * todo el resto una columna, y con uno dejaba un espacio después de AM/PM.
 */
export function buildA1(generatedAt: Date, appName = "Hy-Tek, Ltd"): string {
  let content = "";
  content += "A1";
  content += "02";
  content += padRight("Meet Entries", 25);
  content += padRight(appName, 11);
  content += padRight("", 4);
  content += padRight("Win-TM 8.0De", 12);
  content += padRight("", 2);
  content += formatHy3Date(generatedAt);
  content += padLeft(formatHy3Time(generatedAt), 9);
  content += padRight("TEAM MANAGER Lite", 18);
  return buildHy3Line(padRight(content, 128));
}

// --------------------------------------------------------------------------
// B1 / B2 — información de la competencia
// --------------------------------------------------------------------------
export interface MeetInfo {
  name: string;
  facility: string; // sede: columna 47
  startDate: Date;
  endDate: Date;
  ageUpDate: Date; // fecha de corte para el cálculo de edad (RB-05)
}

export function buildB1(meet: MeetInfo): string {
  let content = "";
  content += "B1";
  content += padRight(meet.name, 45);
  content += padRight(meet.facility, 45);
  content += formatHy3Date(meet.startDate);
  content += formatHy3Date(meet.endDate);
  content += formatHy3Date(meet.ageUpDate);
  return buildHy3Line(padRight(content, 128));
}

export function buildB2(courseCode: "L" | "S" = "L"): string {
  let content = "";
  content += "B2";
  content += padRight("", 92);
  content += "06"; // constante observada (código de tipo de competencia)
  content += padRight("", 2);
  content += courseCode; // curso de la competencia: L=Long course (50m), S=Short course (25m)
  content += padRight("", 3);
  content += "0,00"; // costo de inscripción (no gestionado por este sistema)
  content += courseCode;
  content += "O"; // constante observada
  return buildHy3Line(padRight(content, 128));
}

// --------------------------------------------------------------------------
// C1 / C2 / C3 — información del club
// --------------------------------------------------------------------------
export interface ClubInfo {
  code: string; // ej. "SINT" — máx. 5 chars
  name: string;
}

export function buildC1(club: ClubInfo): string {
  let content = "";
  content += "C1";
  content += padRight(club.code, 5);
  content += padRight(club.name, 112);
  content += "MAS"; // asociación: Masters
  return buildHy3Line(padRight(content, 128));
}

export function buildC2(): string {
  let content = "";
  content += "C2";
  content += padRight("", 102);
  content += "CHI"; // país: Chile
  content += " ";
  content += "OTH"; // constante observada
  return buildHy3Line(padRight(content, 128));
}

export function buildC3(): string {
  return buildHy3Line(padRight("C3", 128));
}

// --------------------------------------------------------------------------
// D1 — nadador
// --------------------------------------------------------------------------
export interface SwimmerInfo {
  swimmerId: number; // ID correlativo dentro del archivo (1, 2, 3...)
  gender: "M" | "F";
  lastName: string;
  firstName: string;
  run: string; // ya con el formato de exportación; ocupa el campo de "USS#"/ID nacional
  birthDate: Date;
  age: number;
}

export function buildD1(swimmer: SwimmerInfo): string {
  let content = "";
  content += "D1";
  content += swimmer.gender;
  content += padRight("", 2);
  content += padLeft(String(swimmer.swimmerId), 3);
  content += padRight(swimmer.lastName, 20);
  content += padRight(swimmer.firstName, 20);
  content += padRight("", 21);
  // Ajustado a la IZQUIERDA desde la columna 69, como en la exportación real: un
  // RUN de 7 dígitos no empieza más adentro que uno de 8.
  content += padRight(swimmer.run, 19);
  content += formatHy3Date(swimmer.birthDate);
  content += " ";
  content += padLeft(String(swimmer.age), 2);
  return buildHy3Line(padRight(content, 128));
}

// --------------------------------------------------------------------------
// E1 — prueba individual inscrita
// --------------------------------------------------------------------------
export interface IndividualEntryInfo {
  gender: "M" | "F";
  swimmerId: number;
  lastNameAbbrev: string; // primeros 5 caracteres del apellido
  distanceMeters: number;
  strokeCode: "A" | "B" | "C" | "D" | "E"; // A=Libre B=Espalda C=Pecho D=Mariposa E=Combinado
  meetEventNumber: number; // número de la prueba en el programa de la competencia
  seedTimeSeconds: number;
  courseCode?: "L" | "S"; // L=piscina larga (50m), S=piscina corta (25m) — L por defecto si no se indica
}

const STROKE_CODE_MAP: Record<string, "A" | "B" | "C" | "D" | "E"> = {
  Libre: "A",
  Espalda: "B",
  Pecho: "C",
  Mariposa: "D",
  Combinado: "E",
};

export function strokeNameToHy3Code(strokeName: string): "A" | "B" | "C" | "D" | "E" {
  const code = STROKE_CODE_MAP[strokeName];
  if (!code) throw new Error(`Estilo sin mapeo a código Hy-Tek: "${strokeName}" (use Libre/Espalda/Pecho/Mariposa/Combinado)`);
  return code;
}

export function buildE1(entry: IndividualEntryInfo): string {
  let content = "";
  content += "E1";
  content += entry.gender;
  content += padRight("", 2);
  content += padLeft(String(entry.swimmerId), 3);
  content += padRight(entry.lastNameAbbrev, 5);
  content += entry.gender + entry.gender; // observado: género duplicado
  content += padLeft(String(entry.distanceMeters), 6);
  content += entry.strokeCode;
  content += padRight("", 2);
  content += "0109"; // constante observada (sin semántica confirmada)
  content += padRight("", 6);
  content += "0,00"; // constante observada (tiempo de conversión, no usado)
  content += padRight("", 1);
  content += padLeft(String(entry.meetEventNumber), 2);
  content += padRight("", 8);
  content += "0"; // constante observada
  content += entry.courseCode ?? "L"; // curso de la marca de referencia
  content += padLeft(formatHy3Time_SecondsComma(entry.seedTimeSeconds), 8);
  content += entry.courseCode ?? "L"; // curso de la competencia
  content += padRight("", 31);
  content += "C"; // constante observada (estado del registro)
  return buildHy3Line(padRight(content, 128));
}

/** Une todas las líneas con CRLF, terminando el archivo con CRLF final. */
export function joinHy3Lines(lines: string[]): string {
  return lines.join("\r\n") + "\r\n";
}

// --------------------------------------------------------------------------
// F1 / F3 — equipo de relevo inscrito
//
// Decodificados byte a byte contra una exportación real con relevos
//.
// A diferencia de E1, un relevo SIN tiempo de referencia se escribe como
// "0.00" (con PUNTO decimal, formato inglés) en vez de "0,00" — cuando SÍ
// hay tiempo, usa coma decimal igual que E1. El registro F1 tampoco lleva
// el marcador de estado "C" que sí lleva E1 (esa posición queda en blanco).
// --------------------------------------------------------------------------
export interface RelayEntryInfo {
  clubCode: string; // ej. "SINT"
  relayLetter: string; // "A", "B"... (un club solo puede tener un equipo por prueba+categoría, así que en la práctica siempre es "A")
  relayId: number; // id interno correlativo del archivo, solo necesita ser único
  genderCode: "MMM" | "FFF" | "MIX";
  distanceMeters: number; // distancia TOTAL del relevo (4 × la distancia de cada posta)
  strokeCode: "A" | "B" | "C" | "D" | "E";
  meetEventNumber: number;
  seedTimeSeconds: number; // 0 = sin marca de referencia
  courseCode?: "L" | "S"; // L=piscina larga (50m), S=piscina corta (25m) — L por defecto si no se indica
}

export function buildF1(entry: RelayEntryInfo): string {
  let content = "";
  content += "F1";
  content += padRight(entry.clubCode, 5);
  content += entry.relayLetter;
  content += " ";
  content += padLeft(String(entry.relayId), 3);
  content += entry.genderCode;
  content += padRight("", 3);
  content += padLeft(String(entry.distanceMeters), 3);
  content += entry.strokeCode;
  content += padRight("", 2);
  content += "0109"; // constante observada (igual que en E1)
  content += padRight("", 6);
  content += "0,00"; // constante observada (igual que en E1)
  content += " ";
  content += padLeft(String(entry.meetEventNumber), 2);
  content += padRight("", 8);
  content += "0"; // constante observada
  content += entry.courseCode ?? "L"; // curso de la marca de referencia (misma convención que E1)
  content += entry.seedTimeSeconds > 0 ? padLeft(formatHy3Time_SecondsComma(entry.seedTimeSeconds), 8) : padLeft("0.00", 8);
  content += entry.courseCode ?? "L"; // curso de la competencia
  content += padRight("", 23);
  // Solo con marca: así en las exportaciones reales con y sin ella. Es el mismo dato
  // que la "X" de la columna 154 del E0 del CL2.
  content += entry.seedTimeSeconds > 0 ? "X" : " ";
  content += padRight("", 7);
  content += " "; // los relevos NO llevan el marcador de estado "C" que sí lleva E1
  return buildHy3Line(padRight(content, 128));
}

export interface RelayLegInfo {
  gender: "M" | "F";
  swimmerId: number; // debe coincidir con el swimmerId usado en el D1 de ese nadador
  lastNameAbbrev: string; // primeros 5 caracteres del apellido
  legNumber: 1 | 2 | 3 | 4;
}

/** Siempre exactamente 4 integrantes, en el orden real del equipo (posición 1 a 4). */
export function buildF3(legs: [RelayLegInfo, RelayLegInfo, RelayLegInfo, RelayLegInfo]): string {
  let content = "F3";
  for (const leg of legs) {
    content += leg.gender;
    content += padRight("", 2);
    content += padLeft(String(leg.swimmerId), 3);
    content += padRight(leg.lastNameAbbrev, 5);
    content += "F";
    content += String(leg.legNumber);
  }
  return buildHy3Line(padRight(content, 128));
}

/** El archivo HY3 completo. El orden de los registros es el de la exportación real. */
export function buildHy3File(model: TeamManagerExportModel): string {
  const { meet, club } = model;
  const lines = [
    buildA1(model.generatedAt),
    buildB1(meet),
    buildB2(meet.courseCode),
    buildC1(club),
    buildC2(),
    buildC3(),
  ];

  for (const swimmer of model.swimmers) {
    lines.push(buildD1(swimmer));
    for (const entry of swimmer.entries) {
      lines.push(
        buildE1({
          ...entry,
          gender: swimmer.gender,
          swimmerId: swimmer.swimmerId,
          lastNameAbbrev: swimmer.lastName.slice(0, 5),
          courseCode: meet.courseCode,
        })
      );
    }
  }

  for (const { legs, ...relay } of model.relays) {
    lines.push(buildF1({ ...relay, clubCode: club.code, courseCode: meet.courseCode }));
    lines.push(buildF3(legs as [RelayLegInfo, RelayLegInfo, RelayLegInfo, RelayLegInfo]));
  }

  return joinHy3Lines(lines);
}
