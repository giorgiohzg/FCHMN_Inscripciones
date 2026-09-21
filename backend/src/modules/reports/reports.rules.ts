import { computeAge } from "../../shared/age.util";

/**
 * Sección 16: "Listado de Nadadores Inscritos". Se aíslan como funciones
 * puras (input plano -> fila de reporte) para poder testear el formato
 * exacto sin necesidad de base de datos, y para reutilizarlas igual en
 * JSON, CSV, XLSX y PDF (una sola fuente de verdad del "shape" de la fila).
 */

export interface IndividualReportRowInput {
  competitionName: string;
  clubName: string;
  personRun: string;
  personFullName: string;
  personBirthDate: Date;
  categoryName: string;
  distanceMeters: number;
  strokeName: string;
  gender: "male" | "female" | "mixed";
  sessionDate: Date;
  sessionTypeName: string;
  testTypeName: string;
}

export interface IndividualReportRow {
  competencia: string;
  club: string;
  run: string;
  nombreCompleto: string;
  fechaNacimiento: string;
  categoria: string;
  prueba: string;
  distancia: string;
  estilo: string;
  genero: string;
  fecha: string;
  jornada: string;
  tipoDePrueba: string;
}

const GENDER_LABELS: Record<string, string> = { male: "Varones", female: "Damas", mixed: "Mixto" };

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).split("-").reverse().join("-"); // dd-mm-yyyy, determinístico (UTC)
}

export function mapIndividualRegistrationToRow(input: IndividualReportRowInput): IndividualReportRow {
  return {
    competencia: input.competitionName,
    club: input.clubName,
    run: input.personRun,
    nombreCompleto: input.personFullName,
    fechaNacimiento: formatDate(input.personBirthDate),
    categoria: input.categoryName,
    prueba: `${input.distanceMeters}m ${input.strokeName}`,
    distancia: `${input.distanceMeters}m`,
    estilo: input.strokeName,
    genero: GENDER_LABELS[input.gender] ?? input.gender,
    fecha: formatDate(input.sessionDate),
    jornada: input.sessionTypeName,
    tipoDePrueba: input.testTypeName,
  };
}

export interface RelayReportRowInput {
  competitionName: string;
  clubName: string;
  categoryName: string;
  distanceMeters: number;
  strokeName: string;
  gender: "male" | "female" | "mixed";
  sessionDate: Date;
  sessionTypeName: string;
  memberFullNames: string[]; // exactamente 4, en orden
}

export interface RelayReportRow {
  competencia: string;
  equipoClub: string;
  prueba: string;
  categoria: string;
  genero: string;
  fecha: string;
  jornada: string;
  integrante1: string;
  integrante2: string;
  integrante3: string;
  integrante4: string;
}

export function mapRelayRegistrationToRow(input: RelayReportRowInput): RelayReportRow {
  const [i1, i2, i3, i4] = input.memberFullNames;
  return {
    competencia: input.competitionName,
    equipoClub: input.clubName,
    prueba: `${input.distanceMeters}m ${input.strokeName}`,
    categoria: input.categoryName,
    genero: GENDER_LABELS[input.gender] ?? input.gender,
    fecha: formatDate(input.sessionDate),
    jornada: input.sessionTypeName,
    integrante1: i1 ?? "",
    integrante2: i2 ?? "",
    integrante3: i3 ?? "",
    integrante4: i4 ?? "",
  };
}

/**
 * Caracteres con los que Excel, LibreOffice y Google Sheets interpretan una
 * celda como FÓRMULA en vez de como texto.
 *
 * El riesgo (inyección de fórmulas en CSV): los reportes contienen datos que
 * escriben los propios clubes —nombres de personas, de clubes, razones
 * sociales—. Un club llamado `=HYPERLINK("http://…","Haga clic")` o
 * `=cmd|'/c calc'!A1` viaja intacto hasta el CSV, y al abrirlo el
 * administrador de la Federación su planilla ejecuta la fórmula con SUS
 * permisos. Escapar según RFC 4180 no protege de esto: las comillas resuelven
 * el formato del CSV, no la interpretación de la planilla.
 */
const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

/**
 * Neutraliza una celda que una planilla interpretaría como fórmula,
 * anteponiendo una comilla simple. La planilla la muestra como texto y no
 * incluye la comilla en el valor visible.
 *
 * Se aplica al valor ANTES de escaparlo para CSV, y también en la generación
 * de XLSX, donde el riesgo es idéntico.
 */
export function neutralizeSpreadsheetFormula(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_TRIGGERS.some((trigger) => value.startsWith(trigger)) ? `'${value}` : value;
}

/** Escapa un valor para una celda CSV (RFC 4180: comillas dobles si contiene coma, comilla o salto de línea). */
export function escapeCsvValue(value: string): string {
  const safe = neutralizeSpreadsheetFormula(value);
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function rowsToCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(escapeCsvValue).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsvValue).join(","));
  }
  return lines.join("\r\n");
}

// --------------------------------------------------------------------------
// Vista agrupada del reporte: por club, y dentro de cada club una línea por
// nadador con su edad/categoría/género y AMBAS listas (pruebas individuales
// y relevos) en las que está inscrito.

const REPORT_GENDER_LABELS: Record<"male" | "female", string> = { male: "Varones", female: "Damas" };

export interface SwimmerEventEntry {
  personId: string;
  run: string;
  fullName: string;
  clubName: string;
  birthDate: Date;
  gender: "male" | "female";
  categoryName: string;
  eventNumber: number | null; // número de la prueba en el programa de la competencia (displayOrder)
  eventLabel: string; // ej. "50m Libre"
  timeLabel: string | null; // ej. "1:25,67" o null si no se ingresó tiempo
  kind: "individual" | "relay";
}

export interface ReportEventLine {
  number: number | null; // número de la prueba en el programa — se muestra como número encerrado en un círculo, sin paréntesis
  text: string; // ej. "50m Libre 1:25,67" — ya sin el número ni paréntesis
}

export interface ClubGroupSwimmerRow {
  run: string;
  nombreCompleto: string;
  edad: number;
  categoria: string;
  genero: string;
  pruebas: ReportEventLine[];
  relevos: ReportEventLine[];
}

export interface ClubGroup {
  clubName: string;
  totalNadadores: number;
  totalPruebasIndividuales: number;
  totalRelevos: number;
  swimmers: ClubGroupSwimmerRow[];
}

/** { number: 3, text: "50m Libre 1:25,67" } — el número se muestra aparte (círculo), nunca entre paréntesis. */
function formatEventLine(entry: SwimmerEventEntry): ReportEventLine {
  const text = entry.timeLabel ? `${entry.eventLabel} ${entry.timeLabel}` : entry.eventLabel;
  return { number: entry.eventNumber, text };
}

/**
 * Agrupa las inscripciones (individuales + relevos, ya aplanadas a una
 * entrada por nadador por prueba) en: club (subtítulo, con sus totales) ->
 * nadador (una línea, con RUN/edad/categoría/género) -> sus pruebas y
 * relevos. `entries` debe traer primero las individuales y después los
 * relevos de cada nadador, para que la categoría mostrada priorice la de
 * sus pruebas individuales (más específica) sobre la de sus relevos (por
 * edad combinada del equipo) cuando tiene ambas. `relayTeamCountByClub`
 * es la cantidad de EQUIPOS de relevo distintos por club (no se puede
 * derivar contando `relevos` por nadador, porque cada equipo aporta 4
 * integrantes y se contaría 4 veces).
 */
export function groupReportByClubAndSwimmer(
  entries: SwimmerEventEntry[],
  ageCutoffDate: Date,
  relayTeamCountByClub: Map<string, number> = new Map()
): ClubGroup[] {
  interface Accum {
    run: string;
    fullName: string;
    clubName: string;
    edad: number;
    categoria: string;
    genero: string;
    pruebas: ReportEventLine[];
    relevos: ReportEventLine[];
  }
  const swimmers = new Map<string, Accum>();

  for (const e of entries) {
    if (!swimmers.has(e.personId)) {
      swimmers.set(e.personId, {
        run: e.run,
        fullName: e.fullName,
        clubName: e.clubName,
        edad: computeAge(e.birthDate, ageCutoffDate),
        categoria: e.categoryName,
        genero: REPORT_GENDER_LABELS[e.gender],
        pruebas: [],
        relevos: [],
      });
    }
    const s = swimmers.get(e.personId)!;
    const line = formatEventLine(e);
    if (e.kind === "individual") s.pruebas.push(line);
    else s.relevos.push(line);
  }

  const byClub = new Map<string, ClubGroupSwimmerRow[]>();
  for (const s of swimmers.values()) {
    if (!byClub.has(s.clubName)) byClub.set(s.clubName, []);
    byClub.get(s.clubName)!.push({ run: s.run, nombreCompleto: s.fullName, edad: s.edad, categoria: s.categoria, genero: s.genero, pruebas: s.pruebas, relevos: s.relevos });
  }

  return Array.from(byClub.entries())
    .sort(([a], [b]) => a.localeCompare(b, "es"))
    .map(([clubName, swimmerRows]) => {
      const sortedSwimmers = swimmerRows.slice().sort((a, b) => a.edad - b.edad || a.nombreCompleto.localeCompare(b.nombreCompleto, "es"));
      return {
        clubName,
        totalNadadores: sortedSwimmers.length,
        totalPruebasIndividuales: sortedSwimmers.reduce((sum, s) => sum + s.pruebas.length, 0),
        totalRelevos: relayTeamCountByClub.get(clubName) ?? 0,
        swimmers: sortedSwimmers,
      };
    });
}
