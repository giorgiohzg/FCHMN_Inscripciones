import AdmZip from "adm-zip";
import { prisma } from "../../shared/prisma.client";
import { NotFoundError, ValidationError } from "../../shared/errors";
import { audit } from "../audit/audit.service";
import { relayTotalMetersForExport } from "../../shared/relayDistance.util";
import { buildHy3File, strokeNameToHy3Code, type RelayLegInfo } from "./hy3-writer";
import { buildCl2File } from "./cl2-writer";
import { textoExportable, type ExportRelay, type ExportSwimmer, type TeamManagerExportModel } from "./export-model";
import { computeAge } from "../../shared/age.util";
import { fechasDeLaCompetencia } from "./competition-dates";
import { assertClubAccess, type ActorContext } from "../../shared/actorContext";
import { exigirCompetenciaVisible } from "../competitions/competitions.visibilidad";
import { formatRunConGuion } from "../../shared/run.util";

/**
 * Adaptador desacoplado (según lo planteado en la propuesta de arquitectura,
 * §1.3 y §7/A-06): este módulo es el único que conoce los formatos de Hy-Tek.
 * El resto del sistema no depende de él para nada — si en el futuro se necesita
 * otro formato de exportación, se agrega un adaptador nuevo sin tocar el dominio
 * de inscripciones.
 *
 * Produce un ZIP con un .CL2 y un .HY3 de las mismas inscripciones, igual que el
 * paquete de Team Manager que Meet Manager importa. Incluye pruebas individuales
 * y relevos, decodificados byte a byte contra exportaciones reales.
 */
/**
 * Tope de inscripciones por archivo .HY3. Ver la nota en el cuerpo de
 * `buildTeamManagerHy3Export`; es el equivalente de `MAX_REPORT_ROWS` de los
 * reportes, más holgado porque el archivo es por club.
 */
export const DEFAULT_MAX_EXPORT_ROWS = 20_000;

/**
 * Sede que va en el B1 de ambos formatos. Sigue siendo la constante observada en
 * la exportación real: el sistema no modela este dato.
 */
const SEDE_EN_ARCHIVO = "cduc";

/**
 * Sin esto `adm-zip` marca cada nombre como UTF-8, cosa que el paquete original no
 * hace. Los nombres de estos archivos son ASCII: la marca no aporta nada, y así el
 * ZIP se parece más al que Meet Manager ya acepta.
 */
const NOMBRES_ZIP_SIN_MARCA_UTF8 = {
  efs: false,
  encode: (texto: string) => Buffer.from(texto, "latin1"),
  decode: (bytes: Buffer) => bytes.toString("latin1"),
};

const MESES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Lo que entrega la exportación: el ZIP, y cada archivo por separado. */
export interface TeamManagerExport {
  filename: string;
  zip: Buffer;
  /** Contenido como texto; se codifica en Latin-1 al escribirlo. */
  hy3: { filename: string; content: string };
  cl2: { filename: string; content: string };
}

/**
 * Nombre y apellido PATERNO para exportar, o `null` si la persona no los tiene
 * por separado.
 *
 * Una persona histórica solo guarda `fullName`, y de ahí no se puede saber cuál
 * es el apellido paterno: "Pérez Soto" pueden ser dos apellidos o uno compuesto.
 * No se adivina: la exportación se detiene con un mensaje claro, igual que con
 * una piscina sin asignar o un relevo incompleto.
 */
function nombreParaExportar(person: { firstName: string | null; paternalLastName: string | null }) {
  const firstName = person.firstName?.trim();
  const lastName = person.paternalLastName?.trim();
  return firstName && lastName ? { firstName: textoExportable(firstName), lastName: textoExportable(lastName) } : null;
}

export async function buildTeamManagerExport(
  competitionId: string,
  clubId: string,
  actor: ActorContext,
  options: { maxRows?: number } = {}
): Promise<TeamManagerExport> {
  /**
   * ALCANCE, antes de leer NADA.
   *
   * El archivo lleva RUN y fecha de nacimiento de los nadadores del club. Desde
   * que el permiso `export:team-manager` también lo tienen el rol `club` y el personal de club,
   * el `clubId` ya no puede darse por bueno: llega de la query y quien llama
   * puede cambiarlo. El alcance sale de la identidad (`ActorContext`), no del
   * parámetro: el administrador exporta cualquier club, el personal solo el
   * suyo, y un nadador puro ninguno. Se comprueba aquí y no solo en la ruta
   * para que cualquier llamador futuro quede cubierto, y antes de la primera
   * consulta para que ni la existencia de la competencia ni la del club se
   * revelen a quien no corresponde.
   */
  assertClubAccess(actor, clubId);

  const MAX_EXPORT_ROWS = options.maxRows ?? DEFAULT_MAX_EXPORT_ROWS;

  const competition = await prisma.competition.findUnique({ where: { id: competitionId }, include: { pool: true, dates: { select: { date: true } } } });
  if (!competition) throw new NotFoundError("Competencia");
  exigirCompetenciaVisible(competition, actor); // AUD-07

  /**
   * Hallazgo 17 — el curso de piscina ya no se adivina.
   *
   * Antes, sin piscina asignada se exportaba "L" (piscina larga, 50 m) por
   * defecto. Ese carácter no es decorativo: Team Manager lo usa para
   * interpretar los tiempos de referencia, y una competencia de piscina
   * corta exportada como larga produce marcas mal clasificadas en el
   * programa oficial, sin que nada lo advierta. Adivinar el dato más común
   * es peor que pedirlo, porque el error es silencioso y aparece recién en
   * el software de destino.
   */
  if (!competition.pool) {
    throw new ValidationError(
      `La competencia "${competition.name}" no tiene piscina asignada, y el archivo de Team Manager necesita saber si es de ` +
        `25 o 50 metros para interpretar los tiempos de referencia. Asigne la piscina en el detalle de la competencia y vuelva a exportar.`,
      { competitionId, missing: "pool" }
    );
  }
  const courseCode: "L" | "S" = competition.pool.courseLength === "short_25m" ? "S" : "L";

  /**
   * Fechas REALES de la competencia (sus `CompetitionDate`), no las de
   * inscripción. Sin ninguna, error claro: ver `competition-dates.ts`.
   */
  const { inicio: inicioCompetencia, termino: terminoCompetencia } = fechasDeLaCompetencia(competition.dates, competition.name);

  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError("Club");

  /**
   * Mismo tope de memoria que en los reportes, y por el mismo motivo: este
   * generador carga todas las inscripciones del club con sus personas y
   * arma el archivo completo como una cadena en memoria. Aunque el archivo
   * es por club (bastante más chico que un reporte de competencia), no había
   * ninguna cota: nada impide que un club tenga miles de inscripciones.
   *
   * Se cuentan individuales Y relevos antes de traer nada.
   */
  const [conteoIndividuales, conteoRelevos] = await Promise.all([
    prisma.registration.count({ where: { clubId, status: "confirmed", competitionEvent: { competitionId } } }),
    prisma.relayRegistration.count({ where: { clubId, status: "confirmed", competitionEvent: { competitionId } } }),
  ]);
  /**
   * `truncado`: las cifras vienen de una lectura acotada, así que son un piso
   * y no el total. El mensaje lo dice ("al menos N") en vez de presentar el
   * número leído como si fuera el total exacto.
   */
  const excedeTope = (individuales: number, relevos: number, truncado = false) => {
    const total = individuales + relevos;
    if (total <= MAX_EXPORT_ROWS) return null;
    const cantidad = truncado ? `al menos ${total.toLocaleString("es-CL")}` : total.toLocaleString("es-CL");
    const prefijo = truncado ? "al menos " : "";
    return new ValidationError(
      `El club tiene ${cantidad} inscripciones confirmadas en esta competencia ` +
        `(${prefijo}${individuales.toLocaleString("es-CL")} individuales y ${relevos.toLocaleString("es-CL")} de relevo) ` +
        `y el máximo por archivo es ${MAX_EXPORT_ROWS.toLocaleString("es-CL")}. Contacte al administrador del sistema.`,
      { individualRows: individuales, relayRows: relevos, totalRows: total, maxRows: MAX_EXPORT_ROWS, truncated: truncado }
    );
  };

  const excesoPrevio = excedeTope(conteoIndividuales, conteoRelevos);
  if (excesoPrevio) throw excesoPrevio;

  /**
   * Presupuesto de lectura COMBINADO, no `MAX + 1` por consulta: con un tope
   * por cada una se podían cargar hasta 2 × (MAX + 1) filas. Se leen primero
   * las individuales y los relevos se limitan al remanente.
   */

  const registrations = await prisma.registration.findMany({
    where: { clubId, status: "confirmed", competitionEvent: { competitionId } },
    include: {
      person: true,
      competitionEvent: {
        include: { event: { include: { distance: true, stroke: true } } },
      },
    },
    orderBy: [{ person: { fullName: "asc" } }],
    take: MAX_EXPORT_ROWS + 1,
  });

  // Si las individuales ya agotaron el presupuesto, se corta sin leer relevos.
  if (registrations.length > MAX_EXPORT_ROWS) {
    throw excedeTope(registrations.length, 0, true)!;
  }
  const presupuestoRestante = MAX_EXPORT_ROWS - registrations.length;

  const relayRegistrations = await prisma.relayRegistration.findMany({
    where: { clubId, status: "confirmed", competitionEvent: { competitionId } },
    include: {
      members: { include: { person: true }, orderBy: { orderPosition: "asc" } },
      competitionEvent: {
        include: { event: { include: { distance: true, stroke: true } } },
      },
    },
    take: presupuestoRestante + 1,
  });

  /**
   * Verificación del total REAL ya leído, antes de armar el archivo. El
   * `count` previo pudo quedar obsoleto; la lectura está acotada con `take`,
   * así que en el peor caso se trajo una fila de más.
   */
  const lecturaTruncada = relayRegistrations.length > presupuestoRestante;
  const excesoReal = excedeTope(registrations.length, relayRegistrations.length, lecturaTruncada);
  if (excesoReal) throw excesoReal;

  if (registrations.length === 0 && relayRegistrations.length === 0) {
    throw new ValidationError("El club no tiene inscripciones confirmadas (individuales ni de relevo) en esta competencia");
  }

  // Fecha de corte de edad: ahora la competencia tiene su propio campo
  // explícito (`ageCutoffDate`, una por competencia — RB-05). Si por algún
  // motivo no está definida (competencia creada antes de este campo), se
  // usa la fecha de cierre de inscripciones como respaldo.
  const ageUpDate = competition.ageCutoffDate ?? competition.registrationEndAt;

  // -------- Junta TODAS las personas involucradas (individuales + integrantes de relevo) --------
  type PersonRow = (typeof registrations)[number]["person"] | (typeof relayRegistrations)[number]["members"][number]["person"];
  const individualRegsByPerson = new Map<string, typeof registrations>();
  for (const reg of registrations) {
    const list = individualRegsByPerson.get(reg.personId) ?? [];
    list.push(reg);
    individualRegsByPerson.set(reg.personId, list);
  }

  const allPeople = new Map<string, PersonRow>();
  for (const reg of registrations) allPeople.set(reg.personId, reg.person);
  for (const relay of relayRegistrations) for (const m of relay.members) allPeople.set(m.personId, m.person);

  const sinApellidoSeparado = Array.from(allPeople.values()).filter((p) => !nombreParaExportar(p));
  if (sinApellidoSeparado.length > 0) {
    throw new ValidationError(
      `No se puede generar el archivo: ${sinApellidoSeparado.length} persona(s) inscrita(s) no tienen nombre y apellido paterno por separado, ` +
        `y el archivo exporta solo el apellido paterno. Pida al administrador completarlos en la ficha de: ` +
        `${sinApellidoSeparado.map((p) => p.fullName).join("; ")}.`,
      { personsWithoutSeparateNames: sinApellidoSeparado.map((p) => p.id) }
    );
  }

  // Igual que en la exportación real de Hy-Tek: primero se listan los
  // nadadores que SOLO están en relevos (D1 sin ningún E1 después), y
  // después los que tienen pruebas individuales (D1 + sus E1). El id
  // interno (swimmerId) solo necesita ser único y consistente dentro del
  // archivo — no hace falta que coincida con ningún valor externo.
  const relayOnlyPeople = Array.from(allPeople.values()).filter((p) => !individualRegsByPerson.has(p.id));
  const individualPeople = Array.from(allPeople.values())
    .filter((p) => individualRegsByPerson.has(p.id))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "es"));

  const swimmers: ExportSwimmer[] = [];
  const swimmerByPersonId = new Map<string, ExportSwimmer>();

  for (const person of [...relayOnlyPeople, ...individualPeople]) {
    const swimmer: ExportSwimmer = {
      ...nombreParaExportar(person)!,
      swimmerId: swimmers.length + 1,
      gender: person.gender === "male" ? "M" : "F",
      run: formatRunConGuion(person.run),
      birthDate: person.birthDate,
      age: computeAge(person.birthDate, ageUpDate),
      ageAtMeet: computeAge(person.birthDate, inicioCompetencia),
      entries: (individualRegsByPerson.get(person.id) ?? []).map((reg) => ({
        distanceMeters: reg.competitionEvent.event.distance.meters,
        strokeCode: strokeNameToHy3Code(reg.competitionEvent.event.stroke.name),
        meetEventNumber: reg.competitionEvent.displayOrder ?? 1,
        seedTimeSeconds: (reg.seedTimeCentiseconds ?? 0) / 100, // 0 = "sin marca de referencia" si no se ingresó
      })),
    };
    swimmers.push(swimmer);
    swimmerByPersonId.set(person.id, swimmer);
  }

  // -------- Relevos (F1 + F3) --------
  const GENDER_CODE: Record<"male" | "female" | "mixed", "MMM" | "FFF" | "MIX"> = { male: "MMM", female: "FFF", mixed: "MIX" };
  let relayId = 100; // igual convención de ancho (3 dígitos) que la exportación real; el valor exacto no importa, solo que sea único
  const relays: ExportRelay[] = [];

  /**
   * Hallazgo 17 — los relevos inconsistentes ya no se omiten en silencio.
   *
   * Antes, un equipo cuyo número de integrantes no fuera 4 se saltaba con un
   * `continue`. El archivo se generaba "correctamente" y el club descubría
   * en la mesa de control que su equipo no estaba inscrito, sin ninguna
   * pista de por qué. Un equipo con datos inconsistentes es un error que hay
   * que corregir antes de competir, no una fila que se pueda descartar.
   */
  const requiredMembers = 4;
  const relevosInconsistentes = relayRegistrations.filter((r) => r.members.length !== requiredMembers);
  if (relevosInconsistentes.length > 0) {
    const detalle = relevosInconsistentes
      .map((r) => {
        const prueba = `${r.competitionEvent.event.distance.meters}m ${r.competitionEvent.event.stroke.name}`;
        return `equipo ${r.id} (${prueba}): ${r.members.length} integrante(s) en vez de ${requiredMembers}`;
      })
      .join("; ");
    throw new ValidationError(
      `No se puede generar el archivo: ${relevosInconsistentes.length} equipo(s) de relevo de este club tienen datos inconsistentes y ` +
        `quedarían fuera del archivo sin aviso. Corríjalos o cancélelos antes de exportar. Detalle: ${detalle}.`,
      { inconsistentRelays: relevosInconsistentes.map((r) => ({ id: r.id, members: r.members.length })) }
    );
  }

  for (const relay of relayRegistrations) {
    relays.push({
      relayLetter: "A", // un club solo puede tener un equipo por prueba+categoría (regla de negocio ya validada al inscribir)
      relayId: relayId++,
      genderCode: GENDER_CODE[relay.competitionEvent.event.gender],
      // `Event.distance` YA es la distancia total del relevo (4×50 se guarda
      // como 200), que es exactamente lo que espera el registro F1. Antes
      // aquí se multiplicaba por 4 asumiendo que el valor era por posta, así
      // que un 4×50 importado desde un .ev3 —donde el total viene de
      // fábrica— se exportaba como 800 metros. Ver `shared/relayDistance.util.ts`.
      distanceMeters: relayTotalMetersForExport(relay.competitionEvent.event.distance.meters),
      strokeCode: strokeNameToHy3Code(relay.competitionEvent.event.stroke.name),
      meetEventNumber: relay.competitionEvent.displayOrder ?? 1,
      seedTimeSeconds: (relay.seedTimeCentiseconds ?? 0) / 100,
      legs: relay.members.map((m): RelayLegInfo => {
        const swimmer = swimmerByPersonId.get(m.personId)!;
        return {
          gender: swimmer.gender,
          swimmerId: swimmer.swimmerId,
          lastNameAbbrev: swimmer.lastName.slice(0, 5),
          legNumber: m.orderPosition as 1 | 2 | 3 | 4,
        };
      }),
    });
  }

  const generatedAt = new Date();
  const model: TeamManagerExportModel = {
    generatedAt,
    meet: {
      name: textoExportable(competition.name),
      facility: SEDE_EN_ARCHIVO,
      startDate: inicioCompetencia,
      endDate: terminoCompetencia,
      ageUpDate,
      courseCode,
    },
    club: { code: textoExportable(club.code), name: textoExportable(club.name) },
    swimmers,
    relays,
  };

  // Misma forma de nombre que el paquete de Team Manager, en ASCII para que viaje
  // sin problemas en la cabecera HTTP. El "-001" es fijo: el sistema no numera envíos.
  const seguro = (texto: string) => texto.replace(/[^\w\- ]/g, "").replace(/\s+/g, "_");
  const dia = String(inicioCompetencia.getUTCDate()).padStart(2, "0");
  const fecha = `${dia}${MESES[inicioCompetencia.getUTCMonth()]}${inicioCompetencia.getUTCFullYear()}`;
  const base = `${seguro(club.code)}-Entries-${seguro(competition.name)}-${fecha}-001`;

  const hy3 = { filename: `${base}.HY3`, content: buildHy3File(model) };
  const cl2 = { filename: `${base}.CL2`, content: buildCl2File(model) };
  const filename = `${base}.zip`;

  const paquete = new AdmZip(undefined, { decoder: NOMBRES_ZIP_SIN_MARCA_UTF8 } as Partial<AdmZip.InitOptions>);
  // Latin-1, no UTF-8: Team Manager es un programa de la era DOS/Windows clásico.
  paquete.addFile(cl2.filename, Buffer.from(cl2.content, "latin1"));
  paquete.addFile(hy3.filename, Buffer.from(hy3.content, "latin1"));
  const zip = paquete.toBuffer();

  await audit({
    userId: actor.userId,
    action: "TEAM_MANAGER_EXPORT_HY3",
    entityType: "Competition",
    entityId: competitionId,
    ipAddress: actor.ipAddress,
    after: {
      clubId,
      filename,
      files: [cl2.filename, hy3.filename],
      individualCount: registrations.length,
      relayCount: relayRegistrations.length,
    },
  });

  return { filename, zip, hy3, cl2 };
}
