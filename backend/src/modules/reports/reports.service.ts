import { prisma } from "../../shared/prisma.client";
import { getDefaultAgeCutoffDate } from "../../shared/age.util";
import {
  mapIndividualRegistrationToRow,
  mapRelayRegistrationToRow,
  compararFilasIndividuales,
  compararFilasDeRelevo,
  lineaDePrueba,
  tiempoDeInscripcion,
  type PersonaOrdenable,
  type IndividualReportRow,
  type VistaDeReporte,
  type RelayReportRow,
  type SwimmerEventEntry,
  type JornadaDeEntrada,
} from "./reports.rules";
import { armarReporteDetallado } from "./reporteDetallado.rules";
import type { RegistrationsReportQuery } from "./reports.schemas";
import { resolveClubFilter, scopedPersonId, type ActorContext } from "../../shared/actorContext";
import { NotFoundError, ValidationError } from "../../shared/errors";
import { exigirCompetenciaVisible } from "../competitions/competitions.visibilidad";

/**
 * Vista del reporte según el ALCANCE EFECTIVO del actor (`buildActorContext`), nunca según
 * parámetros del cliente: solo el alcance de administración recibe la fecha de nacimiento
 * completa. Quien es administrador y además tiene otro rol resuelve a `admin`.
 */
export function vistaDeReporteParaActor(actor: ActorContext): VistaDeReporte {
  return actor.scope.kind === "admin" ? "administracion" : "general";
}

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
  // reporte completo de cualquier competencia —con la fecha de nacimiento
  // de los nadadores de todos los clubes— o el de un club ajeno pasando su
  // `clubId`.
  const clubFilter = resolveClubFilter(actor, query.clubId ?? null);
  const restrictToPersonId = scopedPersonId(actor);

  const competition = await prisma.competition.findUnique({ where: { id: query.competitionId } });
  if (!competition) throw new NotFoundError("Competencia");
  exigirCompetenciaVisible(competition, actor); // AUD-07

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

  /**
   * ORDEN de las filas planas, que hoy consume solo el JSON (CSV, XLSX y PDF presentan la vista
   * agrupada; ver `reporteDetallado.rules.ts`).
   *
   * Los criterios son los de la vista agrupada (`reports.rules.ts`), aplicados a
   * lo que cada formato tiene por fila:
   *   - individuales (una fila por inscripción): club, nadador por apellido
   *     paterno y, dentro del nadador, `compararLineasDePrueba` —el MISMO criterio
   *     de la vista agrupada: número de programa numérico, ausentes al final y,
   *     si se repite o falta, descripción y tiempo tal como se ven—. Las filas de
   *     un mismo nadador quedan juntas, en el orden en que las vería agrupadas;
   *   - relevos (una fila por EQUIPO, no por nadador): club y la misma
   *     `compararLineasDePrueba`. Se mantiene por equipo a propósito: ordenarlos
   *     "por nadador" exigiría repetir cada equipo cuatro veces o elegir un
   *     integrante arbitrario.
   * El identificador de la inscripción es solo el ÚLTIMO desempate, para que el
   * resultado no dependa del orden en que la base devuelva las filas.
   *
   * Se ordenan COPIAS: `individualRegs` y `relayRegs` conservan el orden de la
   * base, que es el que decide la categoría mostrada de cada nadador en cada club
   * de la vista agrupada (la de la primera inscripción que llega, individuales antes
   * que relevos). Ordenar esos arreglos cambiaría esa selección. El club no depende
   * del orden: es el de cada inscripción.
   */
  const ordenable = (p: { id: string; run: string; fullName: string; paternalLastName: string | null; maternalLastName: string | null; firstName: string | null }): PersonaOrdenable => ({
    paternalLastName: p.paternalLastName,
    maternalLastName: p.maternalLastName,
    firstName: p.firstName,
    fullName: p.fullName,
    run: p.run,
    personId: p.id,
  });
  const lineaIndividual = (r: (typeof individualRegs)[number]) =>
    lineaDePrueba(r.competitionEvent.displayOrder, `${r.competitionEvent.event.distance.meters}m ${r.competitionEvent.event.stroke.name}`, tiempoDeInscripcion(r.seedTimeCentiseconds));
  const lineaRelevo = (r: (typeof relayRegs)[number]) =>
    lineaDePrueba(
      r.competitionEvent.displayOrder,
      `Relevo ${r.competitionEvent.event.distance.meters}m ${r.competitionEvent.event.stroke.name} (${GENDER_LABELS_ES[r.competitionEvent.event.gender]})`,
      tiempoDeInscripcion(r.seedTimeCentiseconds)
    );
  const individualesOrdenadas = individualRegs
    .map((r) => ({ r, orden: { clubName: r.club.name, persona: ordenable(r.person), linea: lineaIndividual(r), id: r.id } }))
    .sort((x, y) => compararFilasIndividuales(x.orden, y.orden))
    .map((x) => x.r);
  const relevosOrdenados = relayRegs
    .map((r) => ({ r, orden: { clubName: r.club.name, linea: lineaRelevo(r), categoryName: r.category.name, id: r.id } }))
    .sort((x, y) => compararFilasDeRelevo(x.orden, y.orden))
    .map((x) => x.r);

  // Fecha de corte de la edad: la MISMA de la vista agrupada (más abajo), con el mismo fallback.
  const ageCutoffDate = competition.ageCutoffDate ?? getDefaultAgeCutoffDate();
  const presentacion =
    vistaDeReporteParaActor(actor) === "administracion"
      ? ({ vista: "administracion" } as const)
      : ({ vista: "general", fechaDeCorte: ageCutoffDate } as const);

  const individualRows: IndividualReportRow[] = individualesOrdenadas.map((r) =>
    mapIndividualRegistrationToRow({
      competitionName: competition.name,
      clubName: r.club.name,
      personFullName: r.person.fullName,
      personBirthDate: r.person.birthDate,
      categoryName: r.category.name,
      distanceMeters: r.competitionEvent.event.distance.meters,
      strokeName: r.competitionEvent.event.stroke.name,
      gender: r.competitionEvent.event.gender,
      sessionDate: r.competitionEvent.competitionSession.competitionDate.date,
      sessionTypeName: r.competitionEvent.competitionSession.sessionType.name,
      testTypeName: r.competitionEvent.event.testType.name,
    }, presentacion)
  );

  const relayRows: RelayReportRow[] = relevosOrdenados.map((r) =>
    mapRelayRegistrationToRow({
      competitionName: competition.name,
      clubName: r.club.name,
      categoryName: r.category.name,
      distanceMeters: r.competitionEvent.event.distance.meters,
      strokeName: r.competitionEvent.event.stroke.name,
      gender: r.competitionEvent.event.gender,
      sessionDate: r.competitionEvent.competitionSession.competitionDate.date,
      sessionTypeName: r.competitionEvent.competitionSession.sessionType.name,
      memberFullNames: r.members.map((m) => m.person.fullName),
    })
  );

  // -------- Vista agrupada por club -> nadador (individuales y relevos combinados) --------
  // Las individuales se agregan PRIMERO para que, si un nadador tiene
  // ambas, la categoría mostrada sea la de su prueba individual (más
  // específica que la del relevo, que es por edad combinada del equipo).
  // Se arman desde `individualRegs`/`relayRegs` SIN ordenar (ver arriba): el
  // orden de presentación no interviene en esa selección.
  //
  // El menor número de programa de cada jornada se toma de TODA la competencia, no de lo filtrado:
  // así el orden de las jornadas no cambia según el club, la persona o la prueba que se pida.
  const programaPorJornada = new Map(
    (
      await prisma.competitionEvent.groupBy({
        by: ["competitionSessionId"],
        where: { competitionId: query.competitionId },
        _min: { displayOrder: true },
      })
    ).map((g) => [g.competitionSessionId, g._min.displayOrder])
  );
  const jornadaDe = (ce: {
    competitionSessionId: string;
    competitionSession: { competitionDate: { date: Date }; sessionType: { name: string } };
  }): JornadaDeEntrada => ({
    id: ce.competitionSessionId,
    fecha: ce.competitionSession.competitionDate.date,
    nombre: ce.competitionSession.sessionType.name,
    primerNumero: programaPorJornada.get(ce.competitionSessionId) ?? null,
  });
  const swimmerEntries: SwimmerEventEntry[] = [
    ...individualRegs.map((r): SwimmerEventEntry => ({
      personId: r.personId,
      run: r.person.run,
      fullName: r.person.fullName,
      paternalLastName: r.person.paternalLastName,
      maternalLastName: r.person.maternalLastName,
      firstName: r.person.firstName,
      clubId: r.clubId,
      clubName: r.club.name,
      birthDate: r.person.birthDate,
      gender: r.person.gender,
      categoryName: r.category.name,
      eventNumber: r.competitionEvent.displayOrder,
      eventLabel: `${r.competitionEvent.event.distance.meters}m ${r.competitionEvent.event.stroke.name}`,
      timeLabel: tiempoDeInscripcion(r.seedTimeCentiseconds),
      kind: "individual",
      jornada: jornadaDe(r.competitionEvent),
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
          paternalLastName: m.person.paternalLastName,
          maternalLastName: m.person.maternalLastName,
          firstName: m.person.firstName,
          clubId: r.clubId,
          clubName: r.club.name,
          birthDate: m.person.birthDate,
          gender: m.person.gender,
          categoryName: r.category.name,
          eventNumber: r.competitionEvent.displayOrder,
          eventLabel: `Relevo ${r.competitionEvent.event.distance.meters}m ${r.competitionEvent.event.stroke.name} (${GENDER_LABELS_ES[r.competitionEvent.event.gender]})`,
          timeLabel: tiempoDeInscripcion(r.seedTimeCentiseconds),
          kind: "relay",
          jornada: jornadaDe(r.competitionEvent),
        }))
    ),
  ];
  // Cantidad de EQUIPOS de relevo distintos por club — no se puede derivar
  // sumando `relevos` por nadador (cada equipo aporta 4 integrantes). Por
  // identificador: el nombre del club no es único.
  const equiposPorClubId = new Map<string, number>();
  for (const r of relayRegs) {
    equiposPorClubId.set(r.clubId, (equiposPorClubId.get(r.clubId) ?? 0) + 1);
  }
  const detallado = armarReporteDetallado(competition.name, swimmerEntries, ageCutoffDate, equiposPorClubId);

  return { ...detallado, individualRows, relayRows };
}

const GENDER_LABELS_ES: Record<"male" | "female" | "mixed", string> = { male: "Varones", female: "Damas", mixed: "Mixto" };
