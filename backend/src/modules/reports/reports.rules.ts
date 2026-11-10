import { computeAge } from "../../shared/age.util";

/**
 * Sección 16: "Listado de Nadadores Inscritos". Se aíslan como funciones
 * puras (input plano -> fila de reporte) para poder testear el formato
 * exacto sin necesidad de base de datos, y para reutilizarlas igual en
 * JSON, CSV, XLSX y PDF (una sola fuente de verdad del "shape" de la fila).
 *
 * NINGUNA SALIDA DE REPORTE LLEVA EL RUN, para ningún rol, administrador incluido
 * (decisión funcional de SEC-02). El RUN sigue almacenado y el backend lo usa
 * internamente solo como desempate del orden (`PersonaOrdenable.run`), pero no
 * forma parte de las filas, de la vista agrupada ni de los nombres de integrantes.
 * La excepción es el archivo de Team Manager, que es otro módulo con su propio formato.
 *
 * FECHA DE NACIMIENTO (AUD-10). Solo la administración la recibe completa en las filas
 * individuales (JSON, CSV y XLSX). Los demás roles reciben en su lugar la EDAD, calculada
 * con la misma fecha de corte que la vista agrupada (`ageCutoffDate` de la competencia o,
 * si falta, `getDefaultAgeCutoffDate()`), nunca con la fecha actual. La fecha completa no
 * viaja en ninguna otra propiedad de esas respuestas; internamente se sigue usando para
 * calcular la edad y la categoría.
 */

export interface IndividualReportRowInput {
  competitionName: string;
  clubName: string;
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

/**
 * Qué dato de nacimiento lleva cada fila individual, según el actor:
 *   - `administracion`: la fecha completa (`fechaNacimiento`, dd-mm-yyyy);
 *   - `general` (todos los demás roles): la edad a la fecha de corte (`edad`).
 */
export type VistaDeReporte = "administracion" | "general";

/** Fila individual de la administración: la estructura de siempre, con la fecha completa. */
export interface IndividualReportRowAdmin {
  competencia: string;
  club: string;
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

/** Fila individual de los demás roles: `edad` en el lugar de `fechaNacimiento`; nada más cambia. */
export interface IndividualReportRowConEdad {
  competencia: string;
  club: string;
  nombreCompleto: string;
  edad: number;
  categoria: string;
  prueba: string;
  distancia: string;
  estilo: string;
  genero: string;
  fecha: string;
  jornada: string;
  tipoDePrueba: string;
}

export type IndividualReportRow = IndividualReportRowAdmin | IndividualReportRowConEdad;

/** Cómo presentar el dato de nacimiento: la fecha completa, o la edad a una fecha de corte dada. */
export type PresentacionNacimiento = { vista: "administracion" } | { vista: "general"; fechaDeCorte: Date };

const GENDER_LABELS: Record<string, string> = { male: "Varones", female: "Damas", mixed: "Mixto" };

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).split("-").reverse().join("-"); // dd-mm-yyyy, determinístico (UTC)
}

export function mapIndividualRegistrationToRow(input: IndividualReportRowInput, presentacion: { vista: "administracion" }): IndividualReportRowAdmin;
export function mapIndividualRegistrationToRow(input: IndividualReportRowInput, presentacion: { vista: "general"; fechaDeCorte: Date }): IndividualReportRowConEdad;
export function mapIndividualRegistrationToRow(input: IndividualReportRowInput, presentacion: PresentacionNacimiento): IndividualReportRow;
export function mapIndividualRegistrationToRow(input: IndividualReportRowInput, presentacion: PresentacionNacimiento): IndividualReportRow {
  // La clave va en la MISMA posición en ambas variantes: el orden de las propiedades es el de las columnas.
  const nacimiento =
    presentacion.vista === "administracion"
      ? { fechaNacimiento: formatDate(input.personBirthDate) }
      : { edad: computeAge(input.personBirthDate, presentacion.fechaDeCorte) };
  return {
    competencia: input.competitionName,
    club: input.clubName,
    nombreCompleto: input.personFullName,
    ...nacimiento,
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

/**
 * Límites de celda y disparadores DENTRO de un valor de CSV (AUD-V).
 *
 * `neutralizeSpreadsheetFormula` solo mira el PRINCIPIO del valor, y eso solo
 * protege cuando la planilla separa por coma. Con otro separador de lista (en
 * es-CL, Excel usa `;`) el valor `Club;=1+1;Z` se parte en tres celdas y la
 * del medio se evalúa como fórmula, porque el entrecomillado RFC 4180 solo
 * rige para la coma. Se observó con Excel 16.0 por doble clic.
 *
 * Por eso se neutraliza también cada trozo que una planilla podría tomar como
 * INICIO de celda: el comienzo del valor y lo que sigue a un posible separador
 * (`;`, `|`, tabulador) o a un salto de línea, saltando espacios, tabuladores y
 * comillas que la planilla podría quitar al leer la celda. Se antepone una comilla
 * simple al disparador (`= + - @`), igual que al principio del valor; el texto
 * almacenado no cambia y la estructura del CSV tampoco.
 *
 * Es propio del CSV: XLSX escribe cada valor como una celda de texto y no tiene
 * separadores, así que no usa esta función.
 */
const INICIO_DE_CELDA_CON_DISPARADOR = /(^|[;|\t\r\n])([ \t"]*)(?=[=+\-@])/g;

export function neutralizeCsvCellBoundaries(value: string): string {
  return value.replace(INICIO_DE_CELDA_CON_DISPARADOR, "$1$2'");
}

/** Escapa un valor para una celda CSV (RFC 4180: comillas dobles si contiene coma, comilla o salto de línea). */
export function escapeCsvValue(value: string): string {
  const safe = neutralizeCsvCellBoundaries(neutralizeSpreadsheetFormula(value));
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
  /** SOLO para desempatar el orden (ver `compararNadadores`). Nunca llega a una salida del reporte. */
  run: string;
  fullName: string;
  clubName: string;
  birthDate: Date;
  gender: "male" | "female";
  /**
   * Componentes del nombre, SOLO para ordenar (no se muestran ni se modifican).
   * Las personas históricas pueden no tenerlos: ver `compararNadadores`.
   */
  paternalLastName?: string | null;
  maternalLastName?: string | null;
  firstName?: string | null;
  categoryName: string;
  eventNumber: number | null; // número de la prueba en el programa de la competencia (`displayOrder`)
  eventLabel: string; // ej. "50m Libre"
  timeLabel: string | null; // ej. "1:25,67" o null si no se ingresó tiempo
  kind: "individual" | "relay";
}

export interface ReportEventLine {
  number: number | null; // número de la prueba en el programa — se muestra como número encerrado en un círculo, sin paréntesis
  text: string; // ej. "50m Libre 1:25,67" — ya sin el número ni paréntesis
}

export interface ClubGroupSwimmerRow {
  /**
   * Identificador INTERNO de la persona, estable y único: la clave de la fila en la interfaz.
   * No es un dato anónimo: sigue asociado a una persona concreta, así que se entrega solo a
   * quien ya puede ver el reporte. El nombre no sirve de clave, porque puede repetirse.
   */
  personId: string;
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

// --------------------------------------------------------------------------
// ORDEN del reporte. Todos los criterios viven aquí, como funciones puras, y los
// usan tanto la vista agrupada como las filas planas de CSV / XLSX / PDF: así los
// formatos no pueden divergir.
// --------------------------------------------------------------------------

/**
 * Colación para comparar texto: español, sin distinguir mayúsculas ni tildes
 * («Perez» y «Pérez» empatan en este nivel y se desempatan con las claves
 * siguientes). La eñe sí es una letra distinta, como en el alfabeto español.
 */
const COLACION = new Intl.Collator("es", { sensitivity: "base" });

const limpio = (v: string | null | undefined): string => (v ?? "").trim();

/** Compara dos textos que pueden faltar: los que faltan van DESPUÉS de los presentes. */
function compararOpcionales(a: string | null | undefined, b: string | null | undefined): number {
  const x = limpio(a);
  const y = limpio(b);
  if (x === "" && y === "") return 0;
  if (x === "") return 1;
  if (y === "") return -1;
  return COLACION.compare(x, y);
}

/** Orden alfabético de clubes (el de siempre, con `localeCompare` en español). */
export function compararClubes(a: string, b: string): number {
  return a.localeCompare(b, "es");
}

/** Lo mínimo de una persona para ordenarla. */
export interface PersonaOrdenable {
  paternalLastName?: string | null;
  maternalLastName?: string | null;
  firstName?: string | null;
  /** Nombre completo ALMACENADO, tal cual: nunca se reescribe ni se parte para inventar apellidos. */
  fullName: string;
  run: string;
  personId: string;
}

/**
 * Orden de los nadadores dentro de un club: por APELLIDO PATERNO.
 *
 * Claves, en este orden (cada una desempata la anterior):
 *   1. apellido paterno;
 *   2. apellido materno;
 *   3. nombre de pila;
 *   4. nombre completo almacenado;
 *   5. RUN;
 *   6. identificador de la persona (único y estable).
 * Con eso el resultado es el mismo sea cual sea el orden de entrada, y no hay
 * dos personas distintas que empaten.
 *
 * PERSONAS HISTÓRICAS sin apellido paterno (creadas antes de que el nombre se
 * separara en tres campos: sus `paternalLastName` son `null`): NO se les
 * inventa un apellido —partir «María del Carmen Pérez Soto» por palabras
 * acertaría solo a veces—. Van DESPUÉS de todas las que sí lo tienen, ordenadas
 * por su nombre completo almacenado y luego por las claves 5 y 6. Un apellido
 * materno o un nombre de pila sueltos, sin paterno, tampoco se usan como clave:
 * el paterno es la primera y, si falta, la persona entra en ese grupo.
 */
export function compararNadadores(a: PersonaOrdenable, b: PersonaOrdenable): number {
  const aTienePaterno = limpio(a.paternalLastName) !== "";
  const bTienePaterno = limpio(b.paternalLastName) !== "";
  if (aTienePaterno !== bTienePaterno) return aTienePaterno ? -1 : 1;

  if (aTienePaterno) {
    const porClaves =
      compararOpcionales(a.paternalLastName, b.paternalLastName) ||
      compararOpcionales(a.maternalLastName, b.maternalLastName) ||
      compararOpcionales(a.firstName, b.firstName);
    if (porClaves !== 0) return porClaves;
  }

  return (
    compararOpcionales(a.fullName, b.fullName) ||
    (a.run < b.run ? -1 : a.run > b.run ? 1 : 0) ||
    (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0)
  );
}

/**
 * Orden de los números de programa: NUMÉRICO (2, 3, 10 y no «10, 2, 3») y con los
 * números AUSENTES (`null`) al FINAL. Es el orden en que se nada una jornada, así
 * que una prueba sin número asignado todavía no tiene lugar en el programa y no
 * debe abrir la lista.
 *
 * El «número de programa» es `CompetitionEvent.displayOrder`: la única columna que
 * lo guarda. `eventNumber` es el nombre que le da el importador de Meet Events a
 * ese mismo dato al leer el ZIP (se guarda como `displayOrder`), y la pantalla lo
 * edita como tal (`reorderCompetitionEvents`). No hay un segundo número.
 */
export function compararNumerosDePrograma(a: number | null | undefined, b: number | null | undefined): number {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x - y;
}

/**
 * Orden de las líneas de pruebas (o de relevos) de UN nadador: número de programa
 * numérico, ausentes al final; si dos pruebas REPITEN número, por su texto
 * (descripción y tiempo) y no por el orden en que llegaron.
 *
 * Es el ÚNICO criterio de presentación de pruebas: lo usan la vista agrupada
 * (`groupReportByClubAndSwimmer`) y las filas planas que consumen CSV, XLSX y PDF
 * (`reports.service.ts`), de modo que dos filas equivalentes de un mismo nadador
 * salen en el mismo orden relativo en ambas. El identificador de la inscripción
 * entra solo como ÚLTIMO desempate en las filas planas (ver el servicio), nunca
 * antes del texto visible.
 */
export function compararLineasDePrueba(a: ReportEventLine, b: ReportEventLine): number {
  return compararNumerosDePrograma(a.number, b.number) || COLACION.compare(a.text, b.text) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
}

/**
 * { number: 3, text: "50m Libre 1:25,67" } — el número se muestra aparte (círculo), nunca entre paréntesis.
 * Construye la línea a partir de los mismos datos para la vista agrupada y para
 * ordenar las filas planas: así el texto que desempata es el que se ve.
 */
export function lineaDePrueba(eventNumber: number | null, eventLabel: string, timeLabel: string | null): ReportEventLine {
  const text = timeLabel ? `${eventLabel} ${timeLabel}` : eventLabel;
  return { number: eventNumber, text };
}

const porTexto = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** Lo que se necesita para ordenar una fila PLANA de individuales (CSV / XLSX / PDF / JSON). */
export interface FilaIndividualOrdenable {
  clubName: string;
  persona: PersonaOrdenable;
  /** La misma línea (número y texto) que muestra la vista agrupada para esa inscripción. */
  linea: ReportEventLine;
  /** Identificador de la inscripción: SOLO el último desempate. */
  id: string;
}

/**
 * Orden de las filas planas de individuales: club, nadador (apellido paterno…),
 * `compararLineasDePrueba` —el mismo criterio visible de la vista agrupada— y,
 * como último desempate, el identificador de la inscripción. Así dos filas
 * equivalentes de un mismo nadador quedan en el mismo orden relativo que sus
 * líneas en la vista agrupada, y el id nunca decide antes que el texto.
 */
export function compararFilasIndividuales(a: FilaIndividualOrdenable, b: FilaIndividualOrdenable): number {
  return compararClubes(a.clubName, b.clubName) || compararNadadores(a.persona, b.persona) || compararLineasDePrueba(a.linea, b.linea) || porTexto(a.id, b.id);
}

/** Lo que se necesita para ordenar una fila plana de relevos (una por EQUIPO). */
export interface FilaRelevoOrdenable {
  clubName: string;
  linea: ReportEventLine;
  categoryName: string;
  id: string;
}

/**
 * Orden de las filas planas de relevos (una por equipo, nunca por integrante):
 * club, `compararLineasDePrueba` (el mismo criterio visible que la lista de
 * relevos de cada nadador en la vista agrupada), categoría e identificador.
 */
export function compararFilasDeRelevo(a: FilaRelevoOrdenable, b: FilaRelevoOrdenable): number {
  return compararClubes(a.clubName, b.clubName) || compararLineasDePrueba(a.linea, b.linea) || a.categoryName.localeCompare(b.categoryName, "es") || porTexto(a.id, b.id);
}

function formatEventLine(entry: SwimmerEventEntry): ReportEventLine {
  return lineaDePrueba(entry.eventNumber, entry.eventLabel, entry.timeLabel);
}

/**
 * Agrupa las inscripciones (individuales + relevos, ya aplanadas a una
 * entrada por nadador por prueba) en: club (subtítulo, con sus totales) ->
 * nadador (una línea, con edad/categoría/género) -> sus pruebas y
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
    persona: PersonaOrdenable;
    birthDate: Date;
    gender: "male" | "female";
    /** Club y categoría de la PRIMERA inscripción vista del nadador (ver más abajo): no los decide el orden de presentación. */
    clubName: string;
    categoria: string;
    pruebas: ReportEventLine[];
    relevos: ReportEventLine[];
  }
  const swimmers = new Map<string, Accum>();

  /**
   * SELECCIÓN de club y categoría, separada del orden de las listas: es la de
   * siempre, la de la primera entrada que llega de cada nadador. El servicio
   * entrega primero las individuales y luego los relevos, así que la individual
   * manda sobre el relevo. NO es «la de la primera prueba del programa»: eso
   * sería una regla nueva. Las listas `pruebas` y `relevos` se ordenan después,
   * solo para mostrarlas.
   */
  for (const e of entries) {
    if (!swimmers.has(e.personId)) {
      swimmers.set(e.personId, {
        persona: {
          paternalLastName: e.paternalLastName,
          maternalLastName: e.maternalLastName,
          firstName: e.firstName,
          fullName: e.fullName,
          run: e.run,
          personId: e.personId,
        },
        birthDate: e.birthDate,
        gender: e.gender,
        clubName: e.clubName,
        categoria: e.categoryName,
        pruebas: [],
        relevos: [],
      });
    }
    const s = swimmers.get(e.personId)!;
    const line = formatEventLine(e);
    if (e.kind === "individual") s.pruebas.push(line);
    else s.relevos.push(line);
  }

  const byClub = new Map<string, { persona: PersonaOrdenable; fila: ClubGroupSwimmerRow }[]>();
  for (const s of swimmers.values()) {
    if (!byClub.has(s.clubName)) byClub.set(s.clubName, []);
    byClub.get(s.clubName)!.push({
      persona: s.persona,
      fila: {
        personId: s.persona.personId,
        nombreCompleto: s.persona.fullName,
        edad: computeAge(s.birthDate, ageCutoffDate),
        categoria: s.categoria,
        genero: REPORT_GENDER_LABELS[s.gender],
        pruebas: s.pruebas.slice().sort(compararLineasDePrueba),
        relevos: s.relevos.slice().sort(compararLineasDePrueba),
      },
    });
  }

  return Array.from(byClub.entries())
    .sort(([a], [b]) => compararClubes(a, b))
    .map(([clubName, swimmerRows]) => {
      // Por apellido paterno, NO por edad: la edad se muestra pero no ordena.
      const sortedSwimmers = swimmerRows.slice().sort((x, y) => compararNadadores(x.persona, y.persona)).map((x) => x.fila);
      return {
        clubName,
        totalNadadores: sortedSwimmers.length,
        totalPruebasIndividuales: sortedSwimmers.reduce((sum, s) => sum + s.pruebas.length, 0),
        totalRelevos: relayTeamCountByClub.get(clubName) ?? 0,
        swimmers: sortedSwimmers,
      };
    });
}
