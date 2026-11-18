import type { RelayEntryInfo, RelayLegInfo, SwimmerInfo, IndividualEntryInfo } from "./hy3-writer";

/**
 * Modelo neutro de una exportación a Team Manager.
 *
 * Es lo que garantiza que el HY3 y el CL2 representan LAS MISMAS inscripciones,
 * personas y relevos: el servicio lo arma una vez, y cada formato solo decide
 * cómo escribirlo. Sus textos ya vienen listos para exportar (apellido paterno,
 * RUN con guion, solo caracteres Latin-1), de modo que ningún formato los
 * reinterpreta por su cuenta.
 */
export interface ExportMeet {
  name: string;
  facility: string;
  startDate: Date;
  endDate: Date;
  ageUpDate: Date;
  courseCode: "L" | "S";
}

/**
 * Género de la PRUEBA (M, F o X si es mixta), que no es el sexo de quien la nada.
 *
 * Son dos datos distintos en los dos formatos: la persona conserva M o F (D1, E1
 * columna 2, D0 columna 65, F3 y F0), y la prueba lleva el suyo (E1 columnas
 * 13-14 y D0 columna 66). Lo mostró una exportación que Meet Manager importa
 * correctamente, con el programa de pruebas individuales mixtas: escribe "XX" en
 * el E1 y "X" en el D0, y M o F en el sexo de cada nadador.
 */
export type GeneroDePrueba = "M" | "F" | "X";

/** Código del F1 de un relevo: MMM, FFF o XXX (mixto), como en esa misma exportación. */
export type CodigoGeneroRelevo = "MMM" | "FFF" | "XXX";

/** El género del evento (`Event.gender`) con el que se escribe cada prueba individual. */
export function generoDePrueba(gender: "male" | "female" | "mixed"): GeneroDePrueba {
  return gender === "male" ? "M" : gender === "female" ? "F" : "X";
}

/** El género del evento con el que se escribe el F1 de un relevo. */
export function codigoGeneroRelevo(gender: "male" | "female" | "mixed"): CodigoGeneroRelevo {
  return gender === "male" ? "MMM" : gender === "female" ? "FFF" : "XXX";
}

/** Una inscripción individual. `eventGender` es el de la prueba; el sexo del nadador está en `ExportSwimmer.gender`. */
export type ExportEntry = Pick<
  IndividualEntryInfo,
  "distanceMeters" | "strokeCode" | "meetEventNumber" | "seedTimeSeconds" | "eventGender"
>;

export interface ExportSwimmer extends SwimmerInfo {
  /** Edad a la fecha de la competencia; `age` es a la fecha de corte. La usa el F0 del CL2. */
  ageAtMeet: number;
  /** Vacío si solo nada relevos. */
  entries: ExportEntry[];
}

export type ExportRelay = Omit<RelayEntryInfo, "clubCode" | "courseCode"> & { legs: RelayLegInfo[] };

export interface TeamManagerExportModel {
  generatedAt: Date;
  meet: ExportMeet;
  club: { code: string; name: string };
  /** En el orden del archivo: primero los que solo nadan relevos. */
  swimmers: ExportSwimmer[];
  relays: ExportRelay[];
}

/** MMDDYYYY, tal como usa Hy-Tek (formato de fecha estadounidense). */
export function formatHy3Date(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const yyyy = String(date.getUTCFullYear());
  return `${mm}${dd}${yyyy}`;
}

/** Abreviaturas de los meses en los nombres de archivo, en español como el paquete de referencia ("06ene2027"). */
const MESES_EN_NOMBRE = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/**
 * "06ene2027": la fecha de inicio en el nombre del paquete. Lee los componentes
 * UTC, igual que `formatHy3Date`: el día de calendario se guarda como medianoche
 * UTC. Solo afecta al NOMBRE: las fechas dentro de los archivos siguen siendo
 * numéricas (MMDDYYYY).
 */
export function fechaParaNombreDeArchivo(date: Date): string {
  const dia = String(date.getUTCDate()).padStart(2, "0");
  return `${dia}${MESES_EN_NOMBRE[date.getUTCMonth()]}${date.getUTCFullYear()}`;
}

/**
 * Nombres del ZIP y de sus dos archivos, con la misma base: la forma del paquete
 * de Team Manager, en ASCII para que viaje sin problemas en la cabecera HTTP. El
 * "-001" es fijo: el sistema no numera envíos.
 */
export function nombresDelPaquete(clubCode: string, competitionName: string, inicio: Date): { zip: string; hy3: string; cl2: string } {
  const seguro = (texto: string) => texto.replace(/[^\w\- ]/g, "").replace(/\s+/g, "_");
  const base = `${seguro(clubCode)}-Entries-${seguro(competitionName)}-${fechaParaNombreDeArchivo(inicio)}-001`;
  return { zip: `${base}.zip`, hy3: `${base}.HY3`, cl2: `${base}.CL2` };
}

/**
 * Deja un texto listo para un archivo de columnas fijas en Latin-1.
 *
 * Un carácter fuera de Latin-1 perdería su byte al codificar —y descuadraría el
 * checksum, que se calcula antes—, y un salto de línea partiría el registro. Solo
 * afecta a lo exportado: el nombre almacenado no se toca.
 */
export function textoExportable(valor: string): string {
  return Array.from(valor.normalize("NFC"), (caracter) => {
    const codigo = caracter.codePointAt(0)!;
    if (codigo < 0x20 || (codigo >= 0x7f && codigo < 0xa0)) return " ";
    return codigo > 0xff ? "?" : caracter;
  }).join("");
}
