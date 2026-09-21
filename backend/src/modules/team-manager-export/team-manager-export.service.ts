import { prisma } from "../../shared/prisma.client";
import { NotFoundError, ValidationError } from "../../shared/errors";
import { audit } from "../audit/audit.service";
import { relayTotalMetersForExport } from "../../shared/relayDistance.util";
import {
  buildA1,
  buildB1,
  buildB2,
  buildC1,
  buildC2,
  buildC3,
  buildD1,
  buildE1,
  buildF1,
  buildF3,
  joinHy3Lines,
  strokeNameToHy3Code,
  type SwimmerInfo,
  type IndividualEntryInfo,
  type RelayEntryInfo,
  type RelayLegInfo,
} from "./hy3-writer";
import { computeAge } from "../../shared/age.util";

/**
 * Adaptador desacoplado (según lo planteado en la propuesta de arquitectura,
 * §1.3 y §7/A-06): esta función es la única que conoce el formato Hy-Tek
 * HY3. El resto del sistema no depende de este módulo para nada — si en el
 * futuro se necesita otro formato de exportación, se agrega un adaptador
 * nuevo sin tocar el dominio de inscripciones.
 *
 * Incluye tanto pruebas individuales (D1/E1) como relevos (F1/F3),
 * decodificados byte a byte contra una exportación real con ambos tipos de
 * prueba (ver tests/fixtures/sample-with-relays.hy3).
 */
/**
 * Tope de inscripciones por archivo .HY3. Ver la nota en el cuerpo de
 * `buildTeamManagerHy3Export`; es el equivalente de `MAX_REPORT_ROWS` de los
 * reportes, más holgado porque el archivo es por club.
 */
export const DEFAULT_MAX_EXPORT_ROWS = 20_000;

export async function buildTeamManagerHy3Export(
  competitionId: string,
  clubId: string,
  actor: { userId: string; ipAddress?: string },
  options: { maxRows?: number } = {}
): Promise<{ filename: string; content: string }> {
  const MAX_EXPORT_ROWS = options.maxRows ?? DEFAULT_MAX_EXPORT_ROWS;

  const competition = await prisma.competition.findUnique({ where: { id: competitionId }, include: { pool: true } });
  if (!competition) throw new NotFoundError("Competencia");

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

  const lines: string[] = [];
  lines.push(buildA1(new Date()));
  lines.push(
    buildB1({
      name: competition.name,
      startDate: competition.registrationStartAt,
      endDate: competition.registrationEndAt,
      ageUpDate,
    })
  );
  lines.push(buildB2(courseCode));
  lines.push(buildC1({ code: club.code, name: club.name }));
  lines.push(buildC2());
  lines.push(buildC3());

  function nameParts(person: { firstName: string | null; paternalLastName: string | null; maternalLastName: string | null; fullName: string }) {
    // Usa los campos separados (Nombre/Apellido paterno/Apellido materno)
    // cuando existen; si es una persona creada ANTES de ese cambio (campos
    // en null), recurre al método anterior (fullName = "Apellido, Nombre")
    // como respaldo, para no romper la exportación de datos históricos.
    if (person.firstName && person.paternalLastName) {
      const firstName = person.firstName;
      const lastName = person.maternalLastName ? `${person.paternalLastName} ${person.maternalLastName}` : person.paternalLastName;
      return { firstName, lastName };
    }
    const [legacyLastName, ...firstParts] = person.fullName.split(",").map((s: string) => s.trim());
    return { lastName: legacyLastName || person.fullName, firstName: firstParts.join(" ") || "" };
  }

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

  // Igual que en el exportación real de Hy-Tek: primero se listan los
  // nadadores que SOLO están en relevos (D1 sin ningún E1 después), y
  // después los que tienen pruebas individuales (D1 + sus E1). El id
  // interno (swimmerId) solo necesita ser único y consistente dentro del
  // archivo — no hace falta que coincida con ningún valor externo.
  const relayOnlyPeople = Array.from(allPeople.values()).filter((p) => !individualRegsByPerson.has(p.id));
  const individualPeople = Array.from(allPeople.values())
    .filter((p) => individualRegsByPerson.has(p.id))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "es"));

  const swimmerIdByPersonId = new Map<string, number>();
  const lastNameById = new Map<string, string>();
  let nextSwimmerId = 1;

  for (const person of relayOnlyPeople) {
    const { firstName, lastName } = nameParts(person);
    const swimmerId = nextSwimmerId++;
    swimmerIdByPersonId.set(person.id, swimmerId);
    lastNameById.set(person.id, lastName);

    const swimmer: SwimmerInfo = {
      swimmerId,
      gender: person.gender === "male" ? "M" : "F",
      lastName,
      firstName,
      run: person.run,
      birthDate: person.birthDate,
      age: computeAge(person.birthDate, ageUpDate),
    };
    lines.push(buildD1(swimmer));
  }

  for (const person of individualPeople) {
    const { firstName, lastName } = nameParts(person);
    const swimmerId = nextSwimmerId++;
    swimmerIdByPersonId.set(person.id, swimmerId);
    lastNameById.set(person.id, lastName);

    const gender: "M" | "F" = person.gender === "male" ? "M" : "F";
    const swimmer: SwimmerInfo = {
      swimmerId,
      gender,
      lastName,
      firstName,
      run: person.run,
      birthDate: person.birthDate,
      age: computeAge(person.birthDate, ageUpDate),
    };
    lines.push(buildD1(swimmer));

    for (const reg of individualRegsByPerson.get(person.id)!) {
      const entry: IndividualEntryInfo = {
        gender,
        swimmerId,
        lastNameAbbrev: lastName.slice(0, 5),
        distanceMeters: reg.competitionEvent.event.distance.meters,
        strokeCode: strokeNameToHy3Code(reg.competitionEvent.event.stroke.name),
        meetEventNumber: reg.competitionEvent.displayOrder ?? 1,
        seedTimeSeconds: (reg.seedTimeCentiseconds ?? 0) / 100, // 0 = "sin marca de referencia" si no se ingresó
        courseCode,
      };
      lines.push(buildE1(entry));
    }
  }

  // -------- Relevos (F1 + F3) --------
  const GENDER_CODE: Record<"male" | "female" | "mixed", "MMM" | "FFF" | "MIX"> = { male: "MMM", female: "FFF", mixed: "MIX" };
  let relayId = 100; // igual convención de ancho (3 dígitos) que la exportación real; el valor exacto no importa, solo que sea único

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

    const entry: RelayEntryInfo = {
      clubCode: club.code,
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
      courseCode,
    };
    lines.push(buildF1(entry));

    const legs = relay.members.map((m): RelayLegInfo => ({
      gender: m.person.gender === "male" ? "M" : "F",
      swimmerId: swimmerIdByPersonId.get(m.personId)!,
      lastNameAbbrev: (lastNameById.get(m.personId) ?? nameParts(m.person).lastName).slice(0, 5),
      legNumber: (m.orderPosition as 1 | 2 | 3 | 4),
    }));
    lines.push(buildF3(legs as [RelayLegInfo, RelayLegInfo, RelayLegInfo, RelayLegInfo]));
  }

  const content = joinHy3Lines(lines);
  const safeName = competition.name.replace(/[^\w\- ]/g, "").replace(/\s+/g, "_");
  const safeClub = club.name.replace(/[^\w\- ]/g, "").replace(/\s+/g, "_");
  const filename = `${safeClub}-Entries-${safeName}.HY3`;

  await audit({
    userId: actor.userId,
    action: "TEAM_MANAGER_EXPORT_HY3",
    entityType: "Competition",
    entityId: competitionId,
    ipAddress: actor.ipAddress,
    after: { clubId, filename, individualCount: registrations.length, relayCount: relayRegistrations.length },
  });

  return { filename, content };
}
