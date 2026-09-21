import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { prisma } from "../../shared/prisma.client";
import { getDefaultAgeCutoffDate } from "../../shared/age.util";
import { formatSwimTimeReadable } from "../../shared/swimTime.util";
import {
  mapIndividualRegistrationToRow,
  mapRelayRegistrationToRow,
  rowsToCsv,
  neutralizeSpreadsheetFormula,
  groupReportByClubAndSwimmer,
  type IndividualReportRow,
  type RelayReportRow,
  type SwimmerEventEntry,
  type ClubGroup,
} from "./reports.rules";
import type { RegistrationsReportQuery } from "./reports.schemas";
import { resolveClubFilter, scopedPersonId, type ActorContext } from "../../shared/actorContext";
import { NotFoundError, ValidationError } from "../../shared/errors";

const INDIVIDUAL_HEADERS = [
  "Competencia",
  "Club",
  "RUN",
  "Nombre completo",
  "Fecha de nacimiento",
  "Categoría",
  "Prueba",
  "Distancia",
  "Estilo",
  "Género",
  "Fecha",
  "Jornada",
  "Tipo de prueba",
];

const RELAY_HEADERS = [
  "Competencia",
  "Club",
  "Prueba",
  "Categoría",
  "Género",
  "Fecha",
  "Jornada",
  "Integrante 1",
  "Integrante 2",
  "Integrante 3",
  "Integrante 4",
];

/**
 * Sección 16: "Listado de Nadadores Inscritos", con los filtros exigidos
 * (competencia, club, fecha, jornada, prueba, categoría, género) y las
 * dos secciones requeridas (individuales / relevos con sus 4 integrantes).
 */
/**
 * Tope de filas por descarga. Se expone y se puede sobrescribir por
 * parámetro para poder ejercitarlo en pruebas sin generar 20.000
 * inscripciones reales.
 */
export const DEFAULT_MAX_REPORT_ROWS = 20_000;

export async function getRegistrationsReport(query: RegistrationsReportQuery, actor: ActorContext, options: { maxRows?: number } = {}) {
  // El alcance se resuelve ANTES de buscar la competencia: si se comprobara
  // después, pedir el reporte de otro club con un id de competencia
  // inexistente respondería 404 en vez de 403, revelando por diferencia de
  // respuesta qué competencias existen.
  //
  // Antes este módulo no tenía ningún alcance: cualquier usuario con
  // `reports:read` (lo tienen todos los roles de club) podía pedir el
  // reporte completo de cualquier competencia —con RUN y fecha de nacimiento
  // de los nadadores de todos los clubes— o el de un club ajeno pasando su
  // `clubId`.
  const clubFilter = resolveClubFilter(actor, query.clubId ?? null);
  const restrictToPersonId = scopedPersonId(actor);

  const competition = await prisma.competition.findUnique({ where: { id: query.competitionId } });
  if (!competition) throw new NotFoundError("Competencia");

  /**
   * Hallazgo 17 — tope de tamaño del reporte.
   *
   * El reporte carga en memoria todas las inscripciones con sus relaciones y
   * después arma CSV, XLSX o PDF completos, también en memoria. Sin tope, un
   * torneo grande podía agotar la memoria del proceso y tumbar el servidor
   * para todos, no solo para quien pidió el reporte.
   *
   * El tope se comprueba con un `count` barato ANTES de traer las filas, y
   * el mensaje indica cómo acotar. Para el tamaño real de la federación
   * (cientos de inscripciones por competencia) nunca se alcanza; existe como
   * red de contención, no como restricción funcional.
   */
  const MAX_REPORT_ROWS = options.maxRows ?? DEFAULT_MAX_REPORT_ROWS;

  const competitionEventWhere: any = { competitionId: query.competitionId };
  if (query.competitionEventId) competitionEventWhere.id = query.competitionEventId;
  if (query.sessionTypeId) competitionEventWhere.competitionSession = { sessionTypeId: query.sessionTypeId };
  if (query.competitionDateId) {
    competitionEventWhere.competitionSession = {
      ...(competitionEventWhere.competitionSession ?? {}),
      competitionDateId: query.competitionDateId,
    };
  }
  if (query.gender) competitionEventWhere.event = { gender: query.gender };

  // -------- Individuales --------
  const individualWhere: any = {
    status: "confirmed",
    competitionEvent: competitionEventWhere,
  };
  if (clubFilter) individualWhere.clubId = clubFilter;
  if (query.categoryId) individualWhere.categoryId = query.categoryId;
  // Un nadador "puro" (sin rol delegado/entrenador) solo ve SU PROPIO
  // reporte — nunca el de otros nadadores del club.
  if (restrictToPersonId) individualWhere.personId = restrictToPersonId;

  const relayWhere: any = {
    status: "confirmed",
    competitionEvent: competitionEventWhere,
  };
  if (clubFilter) relayWhere.clubId = clubFilter;
  if (query.categoryId) relayWhere.categoryId = query.categoryId;
  if (restrictToPersonId) relayWhere.members = { some: { personId: restrictToPersonId } };

  /**
   * El tope cubre AMBAS secciones del reporte y actúa en DOS momentos.
   *
   * 1. `count` previo: rechaza barato, sin cargar nada, y permite dar un
   *    mensaje con las cifras exactas.
   * 2. `take` en la lectura, con PRESUPUESTO COMBINADO: el `count` por sí
   *    solo no acota nada — entre contar y leer pueden entrar filas nuevas
   *    (otro club inscribiendo en paralelo), y sin `take` el `findMany`
   *    traería igual todo lo que haya.
   *
   *    El presupuesto es combinado y no `MAX + 1` por consulta: con un tope
   *    por cada una se podían cargar hasta 2 × (MAX + 1) filas, o sea el
   *    doble de lo permitido. Se leen primero las individuales; lo que
   *    consuman se descuenta del presupuesto, y los relevos se limitan al
   *    remanente + 1. Así el total leído nunca supera MAX + 1.
   *
   * Contar solo las individuales dejaba el hueco abierto: un reporte puede
   * ser mayoritariamente de relevos, y cada equipo arrastra además sus
   * integrantes con sus personas.
   */
  const [filasIndividuales, filasRelevo] = await Promise.all([
    prisma.registration.count({ where: individualWhere }),
    prisma.relayRegistration.count({ where: relayWhere }),
  ]);

  /**
   * `truncado` indica que las cifras vienen de una lectura acotada, así que
   * son un piso y no el total. En ese caso el mensaje dice "al menos": decir
   * "tiene 3 inscripciones" cuando en realidad hay 900 y solo se leyeron 3
   * sería informar mal y llevaría a acotar el filtro por el motivo
   * equivocado.
   */
  const excedeTope = (individuales: number, relevos: number, truncado = false) => {
    const total = individuales + relevos;
    if (total <= MAX_REPORT_ROWS) return null;
    const cantidad = truncado ? `al menos ${total.toLocaleString("es-CL")}` : total.toLocaleString("es-CL");
    const desglose = truncado
      ? `(al menos ${individuales.toLocaleString("es-CL")} individuales y ${relevos.toLocaleString("es-CL")} de relevo)`
      : `(${individuales.toLocaleString("es-CL")} individuales y ${relevos.toLocaleString("es-CL")} de relevo)`;
    return new ValidationError(
      `El reporte solicitado tiene ${cantidad} inscripciones ${desglose} ` +
        `y el máximo por descarga es ${MAX_REPORT_ROWS.toLocaleString("es-CL")}. ` +
        `Acote el reporte por club, fecha, jornada o prueba y descárguelo por partes.`,
      { individualRows: individuales, relayRows: relevos, totalRows: total, maxRows: MAX_REPORT_ROWS, truncated: truncado }
    );
  };

  const excesoPrevio = excedeTope(filasIndividuales, filasRelevo);
  if (excesoPrevio) throw excesoPrevio;

  const individualRegs = await prisma.registration.findMany({
    where: individualWhere,
    include: {
      person: true,
      club: true,
      category: true,
      competitionEvent: {
        include: {
          event: { include: { distance: true, stroke: true, testType: true } },
          competitionSession: { include: { sessionType: true, competitionDate: true } },
        },
      },
    },
    orderBy: [{ club: { name: "asc" } }, { person: { fullName: "asc" } }],
    take: MAX_REPORT_ROWS + 1,
  });

  /**
   * Si las individuales por sí solas ya llenaron el presupuesto, se corta
   * aquí: no tiene sentido leer relevos y el total es un piso, no un dato
   * exacto (la lectura vino truncada).
   */
  if (individualRegs.length > MAX_REPORT_ROWS) {
    throw excedeTope(individualRegs.length, 0, true)!;
  }

  /** Lo que queda del presupuesto tras leer las individuales. */
  const presupuestoRestante = MAX_REPORT_ROWS - individualRegs.length;

  // -------- Relevos --------

  const relayRegs = await prisma.relayRegistration.findMany({
    where: relayWhere,
    include: {
      club: true,
      category: true,
      members: { include: { person: true }, orderBy: { orderPosition: "asc" } },
      competitionEvent: {
        include: {
          event: { include: { distance: true, stroke: true, testType: true } },
          competitionSession: { include: { sessionType: true, competitionDate: true } },
        },
      },
    },
    orderBy: [{ club: { name: "asc" } }],
    take: presupuestoRestante + 1,
  });

  /**
   * Verificación del total REAL ya leído, antes de transformar nada.
   *
   * El `count` previo puede haber quedado obsoleto (otro club inscribiendo
   * mientras se arma el reporte). Esta comprobación mira lo que efectivamente
   * se trajo, y como la lectura está acotada con `take`, en el peor caso se
   * cargó una fila de más y no el torneo completo.
   */
  const lecturaTruncada = relayRegs.length > presupuestoRestante;
  const excesoReal = excedeTope(individualRegs.length, relayRegs.length, lecturaTruncada);
  if (excesoReal) throw excesoReal;

  const individualRows: IndividualReportRow[] = individualRegs.map((r) =>
    mapIndividualRegistrationToRow({
      competitionName: competition.name,
      clubName: r.club.name,
      personRun: r.person.run,
      personFullName: r.person.fullName,
      personBirthDate: r.person.birthDate,
      categoryName: r.category.name,
      distanceMeters: r.competitionEvent.event.distance.meters,
      strokeName: r.competitionEvent.event.stroke.name,
      gender: r.competitionEvent.event.gender,
      sessionDate: r.competitionEvent.competitionSession.competitionDate.date,
      sessionTypeName: r.competitionEvent.competitionSession.sessionType.name,
      testTypeName: r.competitionEvent.event.testType.name,
    })
  );

  const relayRows: RelayReportRow[] = relayRegs.map((r) =>
    mapRelayRegistrationToRow({
      competitionName: competition.name,
      clubName: r.club.name,
      categoryName: r.category.name,
      distanceMeters: r.competitionEvent.event.distance.meters,
      strokeName: r.competitionEvent.event.stroke.name,
      gender: r.competitionEvent.event.gender,
      sessionDate: r.competitionEvent.competitionSession.competitionDate.date,
      sessionTypeName: r.competitionEvent.competitionSession.sessionType.name,
      memberFullNames: r.members.map((m) => `${m.person.fullName} (${m.person.run})`),
    })
  );

  // -------- Vista agrupada por club -> nadador (individuales y relevos combinados) --------
  // Las individuales se agregan PRIMERO para que, si un nadador tiene
  // ambas, la categoría mostrada sea la de su prueba individual (más
  // específica que la del relevo, que es por edad combinada del equipo).
  const swimmerEntries: SwimmerEventEntry[] = [
    ...individualRegs.map((r): SwimmerEventEntry => ({
      personId: r.personId,
      run: r.person.run,
      fullName: r.person.fullName,
      clubName: r.club.name,
      birthDate: r.person.birthDate,
      gender: r.person.gender,
      categoryName: r.category.name,
      eventNumber: r.competitionEvent.displayOrder,
      eventLabel: `${r.competitionEvent.event.distance.meters}m ${r.competitionEvent.event.stroke.name}`,
      timeLabel: r.seedTimeCentiseconds !== null ? formatSwimTimeReadable(r.seedTimeCentiseconds) : null,
      kind: "individual",
    })),
    ...relayRegs.flatMap((r): SwimmerEventEntry[] =>
      r.members
        // Con restricción por nadador (ej. reporte de un nadador puro),
        // solo se agrega SU propia entrada del equipo — nunca la de sus
        // compañeros de relevo, aunque el equipo completo haya calzado
        // el filtro `relayWhere.members.some`.
        .filter((m) => !restrictToPersonId || m.personId === restrictToPersonId)
        .map((m): SwimmerEventEntry => ({
          personId: m.personId,
          run: m.person.run,
          fullName: m.person.fullName,
          clubName: r.club.name,
          birthDate: m.person.birthDate,
          gender: m.person.gender,
          categoryName: r.category.name,
          eventNumber: r.competitionEvent.displayOrder,
          eventLabel: `Relevo ${r.competitionEvent.event.distance.meters}m ${r.competitionEvent.event.stroke.name} (${GENDER_LABELS_ES[r.competitionEvent.event.gender]})`,
          timeLabel: r.seedTimeCentiseconds !== null ? formatSwimTimeReadable(r.seedTimeCentiseconds) : null,
          kind: "relay",
        }))
    ),
  ];
  const ageCutoffDate = competition.ageCutoffDate ?? getDefaultAgeCutoffDate();
  // Cantidad de EQUIPOS de relevo distintos por club — no se puede derivar
  // sumando `relevos` por nadador (cada equipo aporta 4 integrantes).
  const relayTeamCountByClub = new Map<string, number>();
  for (const r of relayRegs) {
    relayTeamCountByClub.set(r.club.name, (relayTeamCountByClub.get(r.club.name) ?? 0) + 1);
  }
  const groupedByClub: ClubGroup[] = groupReportByClubAndSwimmer(swimmerEntries, ageCutoffDate, relayTeamCountByClub);

  return { competitionName: competition.name, individualRows, relayRows, groupedByClub };
}

const GENDER_LABELS_ES: Record<"male" | "female" | "mixed", string> = { male: "Varones", female: "Damas", mixed: "Mixto" };

function individualRowToArray(r: IndividualReportRow): string[] {
  return [
    r.competencia,
    r.club,
    r.run,
    r.nombreCompleto,
    r.fechaNacimiento,
    r.categoria,
    r.prueba,
    r.distancia,
    r.estilo,
    r.genero,
    r.fecha,
    r.jornada,
    r.tipoDePrueba,
  ];
}
function relayRowToArray(r: RelayReportRow): string[] {
  return [
    r.competencia,
    r.equipoClub,
    r.prueba,
    r.categoria,
    r.genero,
    r.fecha,
    r.jornada,
    r.integrante1,
    r.integrante2,
    r.integrante3,
    r.integrante4,
  ];
}

export function buildCsv(individualRows: IndividualReportRow[], relayRows: RelayReportRow[]): string {
  const parts: string[] = [];
  parts.push("INDIVIDUALES");
  parts.push(rowsToCsv(INDIVIDUAL_HEADERS, individualRows.map(individualRowToArray)));
  parts.push("");
  parts.push("RELEVOS");
  parts.push(rowsToCsv(RELAY_HEADERS, relayRows.map(relayRowToArray)));
  return parts.join("\r\n");
}

export async function buildXlsx(individualRows: IndividualReportRow[], relayRows: RelayReportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  /**
   * El riesgo de inyección de fórmulas es el MISMO que en el CSV: un nombre
   * de club que empiece con `=` se escribe como fórmula en la celda y Excel
   * la evalúa al abrir el archivo. Se neutraliza con la misma función que
   * usa el CSV, para que ambos formatos no puedan divergir.
   */
  const seguro = (celdas: string[]): string[] => celdas.map(neutralizeSpreadsheetFormula);

  const sheet1 = workbook.addWorksheet("Individuales");
  sheet1.addRow(INDIVIDUAL_HEADERS).font = { bold: true };
  individualRows.forEach((r) => sheet1.addRow(seguro(individualRowToArray(r))));
  sheet1.columns.forEach((col) => {
    col.width = 18;
  });

  const sheet2 = workbook.addWorksheet("Relevos");
  sheet2.addRow(RELAY_HEADERS).font = { bold: true };
  relayRows.forEach((r) => sheet2.addRow(seguro(relayRowToArray(r))));
  sheet2.columns.forEach((col) => {
    col.width = 18;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function buildPdf(
  competitionName: string,
  individualRows: IndividualReportRow[],
  relayRows: RelayReportRow[]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).text(`Listado de Nadadores Inscritos — ${competitionName}`, { align: "left" });
    doc.moveDown();

    doc.fontSize(12).text("Individuales", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(8);
    individualRows.forEach((r) => {
      doc.text(`${r.club} — ${r.nombreCompleto} (${r.run}) — ${r.prueba} — ${r.categoria} — ${r.fecha} ${r.jornada}`);
    });

    doc.moveDown();
    doc.fontSize(12).text("Relevos", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(8);
    relayRows.forEach((r) => {
      doc.text(
        `${r.equipoClub} — ${r.prueba} — ${r.categoria} — ${r.fecha} ${r.jornada} — Integrantes: ${[r.integrante1, r.integrante2, r.integrante3, r.integrante4].filter(Boolean).join(", ")}`
      );
    });

    doc.end();
  });
}
