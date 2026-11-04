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

export type ExportEntry = Pick<IndividualEntryInfo, "distanceMeters" | "strokeCode" | "meetEventNumber" | "seedTimeSeconds">;

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
