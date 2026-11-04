import { formatHy3Date, type ExportMeet, type TeamManagerExportModel, type ExportEntry, type ExportSwimmer } from "./export-model";

/**
 * Constructor del formato Hy-Tek CL2: registros SDIF v3 de 160 columnas.
 *
 * Decodificado contra una exportación real de Team Manager que HY-TEK Meet
 * Manager importa correctamente (115 líneas), y reconstruida byte a byte con
 * este código fuera del repositorio. Lo que el archivo real NO contenía y por lo
 * tanto sale del estándar SDIF, sin contraste contra Hy-Tek, va marcado como
 * INFERENCIA:
 *   - prueba o relevo SIN marca: "NT";
 *   - relevo Combinado: estilo 7; relevo mixto: sexo X.
 *
 * ESTRUCTURA DE CADA LÍNEA (cierto en las 115):
 *   columnas 0-155  contenido
 *   columna  156    espacio
 *   columna  157    "N"
 *   columnas 158-159 checksum (ver `computeCl2Checksum`)
 *   terminador CRLF, también tras la última línea.
 *
 * Mismas personas e inscripciones que el HY3: los dos archivos salen del mismo
 * `TeamManagerExportModel`. El orden también viene dado por el formato real:
 *   A0, B1, C1,
 *   por nadador con pruebas individuales: D0 de su primera prueba, D3, D0 del resto;
 *   por equipo de relevo: E0 y un F0 por integrante, en orden de posta;
 *   Z0 con los conteos.
 *
 * Un nadador que SOLO nada relevos no tiene D0 (es un registro de prueba
 * individual): aparece únicamente en sus F0, que ya llevan nombre, RUN,
 * nacimiento, edad y sexo. INFERENCIA de la especificación SDIF: el archivo real
 * no tenía ningún caso.
 */

export const CL2_CONTENT_LENGTH = 156;
export const CL2_LINE_LENGTH = 160;

/**
 * Checksum de línea CL2. DISTINTO del HY3, aunque se le parece:
 *
 *   1. Sumar los bytes de las columnas 0 a 155, con el mismo peso (el HY3 duplica
 *      las impares y mira 128 columnas).
 *   2. resultado = floor(suma / 19) + 11 (el HY3 divide por 21 y suma 205).
 *   3. checksum = dígito de unidades seguido del de decenas: invertido, igual que HY3.
 *
 * Las columnas 156-157 (espacio y "N") no entran. Se obtuvo por búsqueda
 * exhaustiva sobre ventana, pesos, divisor, constante y orden de dígitos: esta
 * es la ÚNICA combinación que acierta en las 115 líneas reales, incluidas las
 * que llevan "ñ" (por eso se suman bytes Latin-1 sin signo). Solo se observan
 * dos dígitos, así que la constante queda determinada módulo 100.
 */
export function computeCl2Checksum(content: string): string {
  if (content.length !== CL2_CONTENT_LENGTH) {
    throw new Error(`El contenido debe tener exactamente ${CL2_CONTENT_LENGTH} caracteres (recibidos: ${content.length})`);
  }
  let suma = 0;
  for (let i = 0; i < content.length; i++) suma += content.charCodeAt(i);

  const resultado = Math.floor(suma / 19) + 11;
  return `${resultado % 10}${Math.floor(resultado / 10) % 10}`;
}

/** Línea CL2 completa (160 caracteres) a partir de su contenido. */
export function buildCl2Line(content: string): string {
  const padded = content.padEnd(CL2_CONTENT_LENGTH, " ").slice(0, CL2_CONTENT_LENGTH);
  return `${padded} N${computeCl2Checksum(padded)}`;
}

/** ¿La línea tiene la forma y el checksum correctos? */
export function isValidCl2Line(line: string): boolean {
  if (line.length !== CL2_LINE_LENGTH || line.slice(156, 158) !== " N") return false;
  return line.slice(158) === computeCl2Checksum(line.slice(0, CL2_CONTENT_LENGTH));
}

function padRight(value: string, width: number): string {
  return value.slice(0, width).padEnd(width, " ");
}
function padLeft(value: string, width: number): string {
  return value.slice(0, width).padStart(width, " ");
}

/** "45,67", "1:23,45" o "12:03,40": minutos solo si los hay, con coma decimal. */
export function formatCl2Time(totalSeconds: number): string {
  const centesimas = Math.round(Math.max(0, totalSeconds) * 100);
  if (centesimas === 0) return "NT"; // INFERENCIA (SDIF): ver la cabecera.

  const minutos = Math.floor(centesimas / 6000);
  const segundos = Math.floor((centesimas % 6000) / 100);
  const resto = String(centesimas % 100).padStart(2, "0");
  return minutos > 0 ? `${minutos}:${String(segundos).padStart(2, "0")},${resto}` : `${segundos},${resto}`;
}

/** Fecha del pie del archivo: MM-DD-YYYY. */
function fechaConGuiones(date: Date): string {
  const d = formatHy3Date(date);
  return `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}`;
}

/** "Apellido, Nombre" recortado a las 28 columnas del campo. */
function nombreSdif(swimmer: { lastName: string; firstName: string }): string {
  return padRight(`${swimmer.lastName}, ${swimmer.firstName}`, 28);
}

/** Código de equipo: ajustado a la derecha en sus 6 columnas, como en el archivo real. */
const equipo = (code: string) => padLeft(code, 6);

export function buildA0(generatedAt: Date): string {
  let c = "A01";
  c += padRight("V3", 8);
  c += "20"; // constante observada (código de archivo)
  c += padRight("Meet Entries", 30);
  c += padRight("Hy-Tek, Ltd", 20);
  c += padLeft("8.0D", 10); // versión del programa, igual que el "Win-TM 8.0De" del HY3
  c += padRight("Hy-Tek, Ltd", 20);
  c += padRight("252-633-5177", 12); // constante observada (teléfono del fabricante)
  c += formatHy3Date(generatedAt);
  c += padRight("", 36);
  c += "TM41"; // constante observada
  return buildCl2Line(c);
}

export function buildCl2B1(meet: ExportMeet): string {
  let c = "B11";
  c += padRight("", 8);
  c += padRight(meet.name, 30);
  c += padRight("", 44); // direcciones: no gestionadas
  c += padRight(meet.facility, 20);
  c += padRight("", 16);
  c += formatHy3Date(meet.startDate);
  c += formatHy3Date(meet.endDate);
  c += padRight("", 12);
  c += meet.courseCode;
  return buildCl2Line(c);
}

export function buildCl2C1(club: { code: string; name: string }): string {
  let c = "C11";
  c += padRight("", 8);
  c += equipo(club.code);
  c += padRight(club.name, 30);
  c += padRight("", 92);
  c += "CHI"; // país: Chile, igual que el C2 del HY3
  return buildCl2Line(c);
}

/** Código de estilo SDIF. Los relevos usan 6 (libre) y 7 (combinado, INFERENCIA). */
const ESTILO_SDIF: Record<ExportEntry["strokeCode"], string> = { A: "1", B: "2", C: "3", D: "4", E: "5" };

export function buildD0(swimmer: ExportSwimmer, entry: ExportEntry, courseCode: "L" | "S"): string {
  let c = "D01";
  c += padRight("", 8);
  c += nombreSdif(swimmer);
  c += padRight(swimmer.run, 12);
  c += padRight("", 4); // adjunto y ciudadanía
  c += formatHy3Date(swimmer.birthDate);
  c += padLeft(String(swimmer.age), 2);
  c += swimmer.gender;
  c += swimmer.gender; // sexo de la prueba
  c += padLeft(String(entry.distanceMeters), 4);
  c += ESTILO_SDIF[entry.strokeCode];
  c += padLeft(String(entry.meetEventNumber), 3);
  c += " ";
  c += "UNOV"; // categoría de edad de la prueba: constante observada
  c += padRight("", 8);
  c += padLeft(formatCl2Time(entry.seedTimeSeconds), 8);
  c += courseCode;
  return buildCl2Line(c);
}

/** Una por nadador, tras su primer D0. Sus "F" son las constantes del archivo real. */
export function buildD3(swimmer: ExportSwimmer): string {
  let c = "D3";
  c += padRight(swimmer.run, 14);
  c += padRight("", 15);
  c += "X ";
  c += "F".repeat(13);
  return buildCl2Line(c);
}

export function buildE0(relay: TeamManagerExportModel["relays"][number], clubCode: string, meet: ExportMeet): string {
  const sexo = relay.genderCode === "MMM" ? "M" : relay.genderCode === "FFF" ? "F" : "X";
  let c = "E01";
  c += padRight("", 8);
  c += relay.relayLetter;
  c += equipo(clubCode);
  c += padRight("", 2);
  c += sexo;
  c += padLeft(String(relay.distanceMeters), 4);
  c += relay.strokeCode === "E" ? "7" : "6";
  c += padLeft(String(relay.meetEventNumber), 3);
  c += " ";
  c += "UNOV";
  c += padRight("", 3);
  c += formatHy3Date(meet.startDate);
  c += padLeft(formatCl2Time(relay.seedTimeSeconds), 8);
  c += meet.courseCode;
  c = padRight(c, 154);
  c += relay.seedTimeSeconds > 0 ? "X" : " "; // misma marca que la columna 83 del F1 del HY3
  return buildCl2Line(c);
}

/**
 * Un integrante. Su edad es a la FECHA DE LA COMPETENCIA, no a la de corte que
 * usan D0 y D1: en el archivo real solo así coinciden los 12 integrantes (a la
 * fecha de corte, 10). El orden de posta lo da la secuencia de líneas: las tres
 * columnas de orden del registro valen "000" en todos.
 */
export function buildF0(
  swimmer: ExportSwimmer,
  relay: TeamManagerExportModel["relays"][number],
  clubCode: string
): string {
  let c = "F01";
  c += padRight("", 8);
  c += padLeft(String(relay.meetEventNumber), 3);
  c += " ";
  c += equipo(clubCode);
  c += relay.relayLetter;
  c += nombreSdif(swimmer);
  c += padRight(swimmer.run, 12);
  c += padRight("", 3);
  c += formatHy3Date(swimmer.birthDate);
  c += padLeft(String(swimmer.ageAtMeet), 2);
  c += swimmer.gender;
  c += "000";
  c += padRight("", 13);
  c += padRight(swimmer.run, 14);
  return buildCl2Line(c);
}

export interface Cl2Counts {
  d0: number;
  swimmers: number;
  e0: number;
  f0: number;
}

export function buildZ0(generatedAt: Date, counts: Cl2Counts): string {
  let c = "Z01";
  c += padRight("", 8);
  c += "02"; // constante observada
  c += padRight(`Successful Build on ${fechaConGuiones(generatedAt)}`, 30);
  c += padLeft("1", 3); // registros B
  c += padLeft("1", 3); // competencias
  c += padLeft("1", 4); // registros C
  c += padLeft("1", 4); // equipos
  c += padLeft(String(counts.d0), 6);
  c += padLeft(String(counts.swimmers), 6);
  c += padLeft(String(counts.e0), 5);
  c += padLeft(String(counts.f0), 6);
  c += padLeft("0", 6); // registros G
  return buildCl2Line(c);
}

/** El archivo completo, con CRLF también tras la última línea. */
export function buildCl2File(model: TeamManagerExportModel): string {
  const { meet, club } = model;
  const lines = [buildA0(model.generatedAt), buildCl2B1(meet), buildCl2C1(club)];

  const counts: Cl2Counts = { d0: 0, swimmers: 0, e0: 0, f0: 0 };
  for (const swimmer of model.swimmers) {
    if (swimmer.entries.length === 0) continue; // solo relevos: va en sus F0
    counts.swimmers++;
    swimmer.entries.forEach((entry, i) => {
      lines.push(buildD0(swimmer, entry, meet.courseCode));
      counts.d0++;
      if (i === 0) lines.push(buildD3(swimmer));
    });
  }

  const porId = new Map(model.swimmers.map((s) => [s.swimmerId, s]));
  for (const relay of model.relays) {
    lines.push(buildE0(relay, club.code, meet));
    counts.e0++;
    for (const leg of relay.legs) {
      lines.push(buildF0(porId.get(leg.swimmerId)!, relay, club.code));
      counts.f0++;
    }
  }

  lines.push(buildZ0(model.generatedAt, counts));
  return lines.join("\r\n") + "\r\n";
}
