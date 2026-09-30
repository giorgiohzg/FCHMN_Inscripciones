import { prisma } from "../../shared/prisma.client";
import { readSingleEntryFromZip } from "../../shared/safeZip";
import { audit } from "../audit/audit.service";
import { AppError, ValidationError } from "../../shared/errors";
import { LONG_TRANSACTION_OPTIONS, withSavepoint } from "../../shared/transaction";
import { parseEv3File, type ParsedMeet, type ParsedMeetEvent } from "./ev3-parser";
import { parseHyvFile } from "./hyv-parser";
import { detectarFormato, type FormatoImportable } from "./meet-file-detector";
import {
  AVISO_ARCHIVO_CAMBIADO,
  AVISO_RELEVOS_SIN_CONFIRMAR_EV3,
  AVISO_RELEVOS_SIN_CONFIRMAR_HYV,
  OMITIR,
  huellaDelArchivo,
  relevosParaConfirmar,
  validarDecisiones,
  type DecisionDeRelevo,
  type DecisionResuelta,
  type RelevoPorConfirmar,
  type TipoDeRelevoDisponible,
} from "./relay-decisions";
import * as competitionsService from "../competitions/competitions.service";
import * as structureService from "../competitions/competition-structure.service";
import { addCompetitionEvent } from "../competitions/competition-events.service";

interface ActorContext {
  userId: string;
  ipAddress?: string;
}

function findEv3EntryInZip(buffer: Buffer): string {
  // Lectura con límites (tamaño, cantidad de entradas, tasa de compresión,
  // rutas y tiempo) — ver `shared/safeZip.ts`. Antes se abría el ZIP y se
  // descomprimía sin ningún tope.
  const { content } = readSingleEntryFromZip(buffer, {
    allowedExtensions: [".ev3"],
    // Los archivos Hy-Tek están en ISO-8859-1 (Latin-1), igual que en la exportación a Team Manager.
    encoding: "latin1",
    notFoundMessage:
      'El archivo .zip no contiene ningún archivo .ev3 ("Meet Events") — verifique que sea el ZIP exportado desde Hy-Tek Meet Manager con esa opción.',
  });
  return content;
}

/**
 * Jornada que se usa cuando el archivo NO permite saber cuál es.
 *
 * El nombre es deliberadamente largo y explícito: aparece en el detalle de la
 * competencia, y quien lo vea tiene que entender sin más contexto que ahí hay
 * trabajo pendiente. Un nombre neutro como "Sesión" —que es lo que se creaba
 * antes— se confunde con una jornada legítima y el pendiente se pierde.
 *
 * No se reparten las pruebas entre "Mañana" y "Tarde": el dato no está en el
 * archivo y repartirlas sería inventarlo. Una jornada visiblemente incompleta
 * se arregla; una repartida al azar parece correcta y no se revisa.
 *
 * SOBRE LAS JORNADAS YA CREADAS: esto no toca ninguna. El `SessionType`
 * llamado "Sesión" que puedan haber creado importaciones anteriores sigue en
 * el catálogo, con las competencias que lo usan intactas. Este nombre nuevo lo
 * usan solo las importaciones de aquí en adelante.
 */
export const JORNADA_SIN_ESPECIFICAR = "Jornada sin especificar (importada)";

/**
 * Determina la jornada (mañana/tarde/noche) a partir de la hora de la
 * sesión del archivo importado — el archivo Hy-Tek no tiene un concepto
 * de "SessionType" con nombre, solo una hora de reloj.
 *
 * Devuelve además si la jornada quedó realmente identificada, porque de eso
 * depende que la importación avise. Dos caminos llegan a `especificada:
 * false` y los dos merecen el mismo aviso:
 *   - un `.hyv`, que no trae hora en absoluto (comprobado campo por campo);
 *   - un `.ev3` cuya hora no se puede interpretar.
 */
export function inferSessionTypeName(sessionTime: string): { nombre: string; especificada: boolean } {
  const match = sessionTime.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return { nombre: JORNADA_SIN_ESPECIFICAR, especificada: false };

  let hour = Number(match[1]);
  const minute = Number(match[2]);

  /**
   * La forma no basta: hay que comprobar que la hora EXISTA.
   *
   * El patrón admite dos dígitos, así que "25:00AM" lo satisfacía y salía
   * adelante: 25 no es 12, así que no se ajustaba, y como 25 ≥ 18 la prueba
   * terminaba en "Noche". Una hora imposible se convertía en una jornada de
   * aspecto normal, sin un solo aviso. En un reloj de 12 horas el valor válido
   * va de 1 a 12; cualquier otra cosa es un archivo que no dice la hora, y eso
   * es exactamente la jornada sin especificar.
   */
  if (hour < 1 || hour > 12 || minute > 59) {
    return { nombre: JORNADA_SIN_ESPECIFICAR, especificada: false };
  }

  const ampm = match[3]!.toUpperCase();
  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  if (hour < 12) return { nombre: "Mañana", especificada: true };
  if (hour < 18) return { nombre: "Tarde", especificada: true };
  return { nombre: "Noche", especificada: true };
}

/**
 * Días que abarca el rango, ambos extremos incluidos.
 *
 * Se exporta para que la guarda del fixture sintético y el anonimizador que lo
 * genera usen ESTA aritmética y no una copia suya: un fixture que abarcase más
 * de un día sería rechazado por la importación, y el desajuste solo aparecería
 * al correr la suite de integración.
 */
export function countDays(startDate: Date, endDate: Date): number {
  const dias = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  return Math.max(1, dias);
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * ¿Trae el archivo una asignación de pruebas a días que se pueda respetar?
 *
 * Exige que la asignación sea COMPLETA y COHERENTE, no parcial: o el archivo
 * sabe a qué día va cada prueba, o no lo sabe. Aceptar una asignación a medias
 * repartiría unas pruebas por su día real y otras por un valor por omisión,
 * y nadie podría distinguir a simple vista cuáles quedaron mal.
 *
 * Tres motivos de rechazo, todos con aviso propio para que el administrador
 * sepa qué mirar:
 *   - ninguna prueba trae día — hoy es el caso de los dos formatos, aunque por
 *     motivos distintos: el `.hyv` no lo exporta y el `.ev3` lo trae de una
 *     forma que todavía no se puede atribuir con certeza (ver `AVISO_DIA_EV3`);
 *   - solo algunas lo traen;
 *   - alguna cae fuera del rango de fechas de la competencia.
 */
export function evaluarAsignacionPorDia(
  events: readonly ParsedMeetEvent[],
  primerDia: Date,
  ultimoDia: Date
): { valida: boolean; motivo?: string } {
  const conDia = events.filter((e) => e.eventDate instanceof Date && !Number.isNaN(e.eventDate.getTime()));
  if (conDia.length === 0) return { valida: false };

  if (conDia.length !== events.length) {
    return {
      valida: false,
      motivo:
        `El archivo asigna día solo a ${conDia.length} de ${events.length} pruebas. ` +
        "Una asignación parcial no se aplica: se usó el primer día para todas.",
    };
  }

  const desde = formatDay(primerDia);
  const hasta = formatDay(ultimoDia);
  const fuera = conDia.filter((e) => {
    const dia = formatDay(e.eventDate!);
    return dia < desde || dia > hasta;
  });
  if (fuera.length > 0) {
    return {
      valida: false,
      motivo:
        `El archivo asigna ${fuera.length} prueba(s) a días fuera del rango de la competencia (${desde} a ${hasta}). ` +
        "Se descartó la asignación completa y se usó el primer día para todas.",
    };
  }

  return { valida: true };
}

/**
 * Aviso de asignación por día para un `.ev3`.
 *
 * REDACCIÓN CORREGIDA, y el matiz es el punto entero del aviso. Antes decía
 * "el archivo no especifica qué pruebas corresponden a cada día", y eso es
 * FALSO: en una exportación real de dos días, los campos [21] y [23] de cada
 * línea valen 1 en las pruebas del primer día y 2 en las del segundo. El
 * archivo sí trae con qué separarlos.
 *
 * Lo que no se puede es atribuirlo con certeza: esa competencia tenía una sola
 * sesión por día, así que los dos campos valen lo mismo y no hay forma de
 * saber cuál es el día y cuál el número de sesión. Usar uno de los dos sería
 * apostar, y una apuesta que falle reparte el programa entre días equivocados
 * sin que nadie lo note. Hasta tener una muestra con dos sesiones en un mismo
 * día —que es lo que distinguiría los campos—, no se usan.
 */
export const AVISO_DIA_EV3 =
  "El importador no puede asignar con certeza cada prueba a su día: el archivo .ev3 sí trae información de sesión, " +
  "pero no permite distinguir cuál de sus campos indica el día y cuál el número de sesión. " +
  "Todas las pruebas se cargaron en el primer día; muévalas manualmente a los días correspondientes.";

/**
 * Aviso de asignación por día para un `.hyv`.
 *
 * Aquí la afirmación es más fuerte porque está comprobada: se alinearon las
 * pruebas de un `.hyv` real con las del `.ev3` del mismo evento y se buscó
 * campo por campo cualquiera que separase el primer día del segundo. En el
 * `.ev3` hay tres; en el `.hyv`, ninguno. El evento además tenía sesiones
 * configuradas, así que no es una competencia mal armada: el formato no lo
 * exporta. Se acota a la versión verificada a propósito.
 */
export const AVISO_DIA_HYV =
  "El archivo .hyv no indica a qué día corresponde cada prueba (comprobado campo por campo contra la versión 7.0Gb de Meet Manager). " +
  "Todas las pruebas se cargaron en el primer día; muévalas manualmente a los días correspondientes.";

/**
 * Aviso de jornada, común a los dos formatos.
 *
 * Se emite cuando alguna prueba terminó en `JORNADA_SIN_ESPECIFICAR`, sea
 * porque el archivo no trae hora (`.hyv`) o porque la que trae no se pudo
 * interpretar (`.ev3`). El mismo hueco merece el mismo aviso, venga por donde
 * venga.
 */
export const AVISO_JORNADA_SIN_ESPECIFICAR =
  `El archivo no permite identificar la jornada de cada prueba, así que quedaron en «${JORNADA_SIN_ESPECIFICAR}». ` +
  "No se asignaron a Mañana ni a Tarde para no inventar un dato que el archivo no trae: " +
  "distribúyalas manualmente en las jornadas que correspondan antes de abrir las inscripciones.";

/**
 * Interpreta el archivo subido, sea cual sea su formato.
 *
 * Se extrae aquí porque las DOS fases —análisis y confirmación— tienen que
 * leer el archivo exactamente igual. Si cada una lo hiciera por su cuenta,
 * podrían divergir y el usuario confirmaría decisiones sobre una lectura y se
 * importaría otra.
 */
type FormatoConocido = Exclude<FormatoImportable, { tipo: "desconocido" }>;

/** Hasta dónde llegó un intento de importación; se registra si falla. */
type EtapaDeImportacion = "lectura-del-zip" | "interpretacion-del-archivo" | "validacion" | "escritura";

/**
 * Saca el texto del archivo. Para un `.zip` esto abre el contenedor, que es
 * trabajo de la etapa `lectura-del-zip`: se mantiene separado de la
 * interpretación para que un `.zip` sin `.ev3` dentro se registre como lo que
 * es, y no como un archivo ilegible.
 */
function contenidoDelArchivo(buffer: Buffer, formato: FormatoConocido): string {
  return formato.tipo === "zip" ? findEv3EntryInZip(buffer) : formato.contenido;
}

/** Un formato, un parser. El `.hyv` NO se reinterpreta como `.ev3`. */
function interpretarArchivo(contenido: string, formato: FormatoConocido): ParsedMeet {
  return formato.tipo === "hyv" ? parseHyvFile(contenido) : parseEv3File(contenido);
}

/**
 * Tipos de relevo del catálogo, en un orden estable para mostrarlos.
 *
 * El orden importa poco para la corrección —ya no se elige el primero— pero sí
 * para la pantalla: una lista que cambia de orden entre dos análisis del mismo
 * archivo invita a equivocarse al elegir.
 */
export function ordenarTiposDeRelevo(
  tipos: ReadonlyArray<{ id: string; name: string; swimmersCount: number }>
): TipoDeRelevoDisponible[] {
  return tipos
    .filter((t) => t.swimmersCount > 1)
    .map((t) => ({ id: t.id, name: t.name, swimmersCount: t.swimmersCount }))
    .sort((a, b) => a.swimmersCount - b.swimmersCount || a.name.localeCompare(b.name));
}

/** Lo que la ruta entrega como confirmación ya validada en su forma. */
export type ConfirmacionDeRelevosEntrada = { fileHash: string; decisiones: DecisionDeRelevo[] };

export interface MeetAnalysisSummary {
  /** Huella de los bytes subidos; la confirmación debe devolverla igual. */
  fileHash: string;
  formato: "zip" | "ev3" | "hyv";
  competitionName: string;
  startDate: Date;
  endDate: Date;
  ageCutoffDate: Date;
  dayCount: number;
  eventsTotal: number;
  relevos: RelevoPorConfirmar[];
  /** Verdadero si no se puede importar sin decidir el tipo de cada relevo. */
  requiereConfirmacionDeRelevos: boolean;
  warnings: string[];
}

/**
 * FASE 1 — analizar el archivo sin crear la competencia.
 *
 * Devuelve lo que hace falta para que quien importa decida: qué competencia
 * trae el archivo, cuántas pruebas, y —una por una— las pruebas de relevo con
 * las opciones del catálogo y la etiqueta que resultaría de cada opción.
 *
 * QUÉ ESCRIBE Y QUÉ NO, con precisión, porque "no escribe nada" es cómodo de
 * decir y falso:
 *
 *   - NO crea la competencia, ni sus fechas, ni sus jornadas, ni pruebas, ni
 *     entradas de catálogo (distancias, estilos, tipos de jornada). Nada de lo
 *     que el usuario vería como resultado de importar.
 *   - SÍ escribe una fila en `audit_logs` **cuando el análisis falla**. Es
 *     deliberado: antes, un archivo ilegible fallaba dentro de la importación
 *     y quedaba registrado; al mover esa comprobación a una fase previa, el
 *     rastro se habría perdido justo para los archivos que más conviene poder
 *     revisar después. Un análisis que prospera no escribe nada.
 *
 * Así que es una fase sin efectos sobre los datos del sistema, no una lectura
 * pura.
 */
export async function analizarArchivoDeImportacion(
  buffer: Buffer,
  actor: ActorContext,
  nombreArchivo?: string
): Promise<MeetAnalysisSummary> {
  let etapa: EtapaDeImportacion = "lectura-del-zip";
  let parsed: ParsedMeet | undefined;

  try {
    const formato = detectarFormato(buffer, nombreArchivo);
    if (formato.tipo === "desconocido") throw new ValidationError(formato.motivo);

    const contenido = contenidoDelArchivo(buffer, formato);
    etapa = "interpretacion-del-archivo";
    parsed = interpretarArchivo(contenido, formato);
    etapa = "validacion";

    const meet = parsed;
    if (meet.events.length === 0) {
      throw new ValidationError("No se pudo interpretar ninguna prueba válida en el archivo importado.");
    }

    const tipos = ordenarTiposDeRelevo(await prisma.testType.findMany());
    const relevos = relevosParaConfirmar(meet, tipos);

    return {
      fileHash: huellaDelArchivo(buffer),
      formato: formato.tipo,
      competitionName: meet.name,
      startDate: meet.startDate,
      endDate: meet.endDate,
      ageCutoffDate: meet.ageCutoffDate,
      dayCount: countDays(meet.startDate, meet.endDate),
      eventsTotal: meet.events.length,
      relevos,
      requiereConfirmacionDeRelevos: relevos.length > 0,
      warnings: [...meet.warnings],
    };
  } catch (err) {
    await registrarIntentoFallido(actor, etapa, parsed, err, "analisis");
    throw traducirFalloDeImportacion(etapa, err);
  }
}

export interface MeetImportSummary {
  competitionId: string;
  competitionName: string;
  eventsImported: number;
  eventsSkipped: number;
  sessionsCreated: number;
  warnings: string[];
}

/**
 * Importa una competencia completa desde la exportación "Meet Events" de
 * Hy-Tek Meet Manager, en cualquiera de sus tres formas: el `.zip`, el `.ev3`
 * suelto o el `.hyv`. Crea la competencia (en Borrador), su(s) fecha(s), las
 * jornadas necesarias, las pruebas maestras del catálogo (reutilizando las
 * existentes cuando ya coinciden) y las asigna a la competencia.
 *
 * El nombre de la función conserva "Zip" por compatibilidad con quienes la
 * llaman; lo que recibe es el archivo subido, sea cual sea su formato, y
 * `detectarFormato` decide por su contenido.
 *
 * LO QUE LA IMPORTACIÓN NO PUEDE RESOLVER SOLA, y por eso avisa en vez de
 * rellenarlo:
 *   - las CATEGORÍAS de edad, que son un dato exclusivo de este sistema
 *     (sección 12/13) y no existen en ningún archivo de Meet Manager;
 *   - el DÍA de cada prueba en una competencia de varios días;
 *   - la JORNADA, cuando el archivo no trae una hora interpretable.
 *
 * Los tres quedan como trabajo manual declarado en `warnings`, nunca como un
 * valor inventado que parezca configurado.
 */
export async function importCompetitionFromMeetEventsZip(
  zipBuffer: Buffer,
  input: {
    maxIndividualEventsPerSwimmer: number;
    maxRelayEventsPerSwimmerPerSession?: number;
    /**
     * FASE 2 — decisiones de relevo tomadas sobre el análisis previo.
     *
     * Ausente significa "no se confirmó nada", no "usa lo que te parezca": un
     * `.hyv` con relevos se rechaza en ese caso. Ver `relay-decisions.ts`.
     */
    confirmacionDeRelevos?: { fileHash: string; decisiones: DecisionDeRelevo[] };
  },
  actor: ActorContext,
  /** Solo para los mensajes de error y el registro del intento fallido. */
  nombreArchivo?: string
): Promise<MeetImportSummary> {
  /**
   * `parsed` es opcional a propósito.
   *
   * El registro del fallo (hallazgo 23) empezaba DESPUÉS del parseo, así que
   * los rechazos más tempranos —un .zip corrupto, un .zip sin .ev3, un
   * encabezado ilegible— no dejaban ninguna huella: para el sistema, esos
   * intentos nunca habían ocurrido. Ahora la captura envuelve el intento
   * completo y los metadatos del archivo se anotan solo si se alcanzaron a
   * leer; `etapa` dice hasta dónde se llegó.
   */
  let parsed: ParsedMeet | undefined;
  let etapa: EtapaDeImportacion = "lectura-del-zip";

  try {
    return await ejecutarImportacion();
  } catch (err) {
    await registrarIntentoFallido(actor, etapa, parsed, err, "importacion");
    throw traducirFalloDeImportacion(etapa, err);
  }

  async function ejecutarImportacion(): Promise<MeetImportSummary> {
  /**
   * El contenido decide, no la extensión. Un `.zip` se abre para sacar su
   * `.ev3`; un `.ev3` suelto (venga con ese nombre o con cualquier otro de
   * los admitidos) se usa tal cual. Cualquier otra cosa se rechaza aquí,
   * antes de escribir nada.
   */
  const formato = detectarFormato(zipBuffer, nombreArchivo);
  if (formato.tipo === "desconocido") throw new ValidationError(formato.motivo);
  /**
   * Abrir el ZIP sigue siendo `lectura-del-zip`, y la etapa NO se adelanta.
   *
   * Un `.zip` que no contenga ningún `.ev3` falla aquí, y en el registro del
   * intento fallido ese caso tiene que distinguirse del archivo que se leyó
   * bien pero no se pudo interpretar: son dos problemas distintos y se
   * corrigen de forma distinta.
   */
  const esHyv = formato.tipo === "hyv";
  const contenido = contenidoDelArchivo(zipBuffer, formato);

  etapa = "interpretacion-del-archivo";
  parsed = interpretarArchivo(contenido, formato);
  etapa = "validacion";

  /**
   * LA HUELLA SE COMPRUEBA ANTES QUE NADA MÁS.
   *
   * Si el archivo no es el que se analizó, las decisiones vienen numeradas por
   * pruebas de OTRO archivo. Números que coinciden y significados que no es el
   * peor desenlace posible, así que se corta aquí, antes incluso de mirar si
   * las decisiones están completas.
   */
  if (input.confirmacionDeRelevos && input.confirmacionDeRelevos.fileHash !== huellaDelArchivo(zipBuffer)) {
    throw new ValidationError(AVISO_ARCHIVO_CAMBIADO);
  }

  const meet = parsed;
  if (meet.events.length === 0) {
    throw new ValidationError("No se pudo interpretar ninguna prueba válida en el archivo importado.");
  }

  const warnings = [...meet.warnings];

  // El archivo .ev3 solo trae las fechas de la competencia (cuándo se nada),
  // no un período de inscripción real (ese dato no existe en el formato).
  // Se usa el rango de fechas de la competencia como aproximación, pero el
  // fin de inscripción se fija al FINAL de ese día (23:59:59) — nunca a la
  // misma medianoche que el inicio — para que sea siempre estrictamente
  // posterior al inicio. Con una competencia de un solo día, dejarlo igual
  // a la medianoche del inicio hacía que, aunque el alta pasara (esta
  // creación no pasa por la validación de la ruta), cualquier edición
  // posterior de la competencia quedara bloqueada por esa misma regla.
  const registrationEndAt = new Date(meet.endDate);
  registrationEndAt.setUTCHours(23, 59, 59, 999);

  /**
   * Rango de fechas INVERTIDO en el archivo (fin anterior al inicio).
   *
   * `countDays` acota su resultado a un mínimo de 1, así que un rango
   * invertido se colaba como "competencia de un día" y la importación seguía
   * adelante: se creaba la competencia con `registrationStartAt` posterior a
   * `registrationEndAt`, un rango imposible que `computeEffectiveStatus`
   * nunca abre y que bloquea cualquier edición posterior por la propia
   * validación de rangos. Se rechaza antes de escribir nada.
   */
  if (meet.endDate.getTime() < meet.startDate.getTime()) {
    throw new ValidationError(
      `El archivo declara una fecha de término (${formatDay(meet.endDate)}) anterior a la de inicio (${formatDay(meet.startDate)}). ` +
        `Corrija las fechas de la competencia en Meet Manager y vuelva a exportar el archivo.`,
      { startDate: meet.startDate, endDate: meet.endDate }
    );
  }

  /**
   * Hallazgo 15 — el .ev3 NO trae la fecha de cada prueba, solo la hora.
   *
   * Antes, en una competencia de varios días se creaba una fecha por día y
   * después se asignaban TODAS las pruebas a la primera (`onlyDateId`). El
   * resultado era una competencia que parecía correcta —con sus 3 fechas
   * creadas— pero con el programa completo apilado en el día 1: los límites
   * por jornada se calculaban mal y el reporte por fecha mostraba todo el
   * torneo en una sola jornada. Nadie recibía un aviso.
   *
   * Como el dato no existe en el archivo, no se inventa una distribución.
   * Con una sola fecha se importa normalmente; con varias, la importación se
   * rechaza con una instrucción concreta.
   *
   * La comprobación va ANTES de escribir nada: si se hiciera después de
   * crear la competencia, un rechazo dejaría una competencia a medio armar.
   */
  const dayCount = countDays(meet.startDate, meet.endDate);

  /**
   * COMPETENCIAS DE VARIOS DÍAS.
   *
   * Antes esto era un rechazo: el `.ev3` no dice en qué día se nada cada
   * prueba, y meterlas todas en el primero descuadra los límites por jornada
   * y los reportes por fecha. Pero rechazar dejaba al administrador sin
   * ninguna ayuda: tenía que cargar a mano decenas de pruebas.
   *
   * Ahora se importa igual, con una regla explícita y un aviso imposible de
   * pasar por alto:
   *
   *   - si el archivo SÍ asigna cada prueba a un día, y esa asignación es
   *     válida (todas las pruebas tienen día y ese día cae dentro del rango
   *     de la competencia), se respeta tal cual;
   *   - si no la trae —o la trae incompleta o fuera de rango—, todas las
   *     pruebas van al PRIMER día cronológico y se avisa que hay que moverlas.
   *
   * Las fechas de los demás días se crean igualmente, vacías, para que mover
   * una prueba sea arrastrarla a un día que ya existe.
   */
  const primerDia = new Date(meet.startDate.getTime());
  const ultimoDia = new Date(meet.endDate.getTime());
  const asignacionDelArchivo = evaluarAsignacionPorDia(meet.events, primerDia, ultimoDia);

  if (dayCount > 1 && !asignacionDelArchivo.valida) {
    warnings.push(esHyv ? AVISO_DIA_HYV : AVISO_DIA_EV3);
    if (asignacionDelArchivo.motivo) warnings.push(asignacionDelArchivo.motivo);
  }

  /**
   * Hallazgo 18 — toda la escritura ocurre dentro de UNA transacción.
   *
   * Antes cada servicio auxiliar escribía con el cliente global, así que la
   * importación no podía ser atómica: se creaba la competencia, luego sus
   * fechas, luego las jornadas y las pruebas, y un fallo a mitad de camino
   * dejaba datos escritos. La única defensa era una limpieza compensatoria
   * que borraba la competencia a posteriori — un remedio que no cubre la
   * caída del proceso ni el fallo de la propia limpieza, y que dependía de
   * que la cascada barriera todo lo demás.
   *
   * Ahora los servicios aceptan `{ tx }` y comparten esta transacción: si algo
   * falla, la base revierte el conjunto completo. Ya no hay limpieza
   * compensatoria porque no queda nada que limpiar.
   *
   * Las entradas de catálogo creadas al vuelo (distancias, estilos, tipos de
   * jornada, pruebas maestras) también se revierten si la importación falla;
   * son aditivas y volverán a crearse en el siguiente intento.
   */
  etapa = "escritura";
  return await prisma.$transaction(async (tx) => {
      // 1. Competencia (en Borrador — el admin debe revisarla y programarla).
      const competition = await competitionsService.createCompetition(
        {
          name: meet.name || "Competencia importada",
          registrationStartAt: meet.startDate,
          registrationEndAt,
          ageCutoffDate: meet.ageCutoffDate,
          maxIndividualEventsPerSwimmer: input.maxIndividualEventsPerSwimmer,
          // El archivo .ev3 no trae este dato; se usa el valor por defecto (1
          // relevo por nadador y jornada), que el administrador puede ajustar
          // al revisar la competencia importada, que queda en Borrador.
          maxRelayEventsPerSwimmerPerSession: input.maxRelayEventsPerSwimmerPerSession ?? 1,
        },
        actor,
        { tx }
      );

      // 2. Fecha(s) de la competencia (aquí `dayCount` es siempre 1).
      const dateIds: Record<string, string> = {};
      for (let i = 0; i < dayCount; i++) {
        const date = new Date(meet.startDate.getTime() + i * 86_400_000);
        const created = await structureService.addCompetitionDate(competition.id, date, actor, { tx });
        dateIds[date.toISOString().slice(0, 10)] = created.id;
      }
      const primerDiaId = dateIds[formatDay(primerDia)]!;

      /**
       * A qué fecha de la competencia va esta prueba.
       *
       * Con asignación válida del archivo, la suya. Sin ella, el primer día
       * cronológico — que es exactamente lo que anuncia el aviso.
       */
      function dateIdParaPrueba(parsedEvent: ParsedMeetEvent): string {
        if (!asignacionDelArchivo.valida || !parsedEvent.eventDate) return primerDiaId;
        return dateIds[formatDay(parsedEvent.eventDate)] ?? primerDiaId;
      }

      // 3. Jornadas — se crea una por cada combinación (fecha, tipo de
      // jornada inferido de la hora) realmente usada por las pruebas del
      // archivo. Todas las pruebas de la muestra caen en la única fecha
      // disponible; si en el futuro el archivo trajera fechas por prueba,
      // este mismo mecanismo ya soporta extenderlo.
      const sessionTypeCache = new Map<string, string>(); // nombre -> id
      const sessionCache = new Map<string, string>(); // `${dateId}:${sessionTypeId}` -> competitionSessionId
      const distanceCache = new Map<string, string>(); // metros (como texto) -> id
      const strokeCache = new Map<string, string>(); // nombre -> id
      const eventCache = new Map<string, string>(); // `${testTypeId}:${distanceId}:${strokeId}:${gender}` -> eventId
      let sessionsCreated = 0;
      /**
       * Pruebas que terminaron en `JORNADA_SIN_ESPECIFICAR`.
       *
       * Va junto a `sessionsCreated` y entra en la misma instantánea porque
       * se incrementa DENTRO del savepoint de cada prueba: si esa prueba se
       * revierte, su jornada no llegó a existir y el contador tiene que
       * volver atrás con ella. Si no, la importación avisaría de una jornada
       * sin especificar que no está en ninguna parte, y quien la buscara no
       * la encontraría.
       */
      let pruebasSinJornada = 0;

      /**
       * Las cachés anteriores memorizan filas creadas DENTRO de la
       * transacción. Cuando el intento de una prueba se revierte a su
       * savepoint, esas filas dejan de existir, así que la caché tiene que
       * volver al mismo punto: de lo contrario una prueba posterior
       * reutilizaría el id de una distancia o un estilo que ya no está y
       * fallaría por clave foránea.
       */
      const cachesReversibles = [sessionTypeCache, sessionCache, distanceCache, strokeCache, eventCache];
      function tomarInstantanea() {
        return { copias: cachesReversibles.map((c) => new Map(c)), sessionsCreated, pruebasSinJornada };
      }
      function restaurarInstantanea(inst: ReturnType<typeof tomarInstantanea>) {
        cachesReversibles.forEach((cache, idx) => {
          cache.clear();
          for (const [k, v] of inst.copias[idx]!) cache.set(k, v);
        });
        sessionsCreated = inst.sessionsCreated;
        pruebasSinJornada = inst.pruebasSinJornada;
      }

      async function getOrCreateSessionType(name: string): Promise<string> {
        if (sessionTypeCache.has(name)) return sessionTypeCache.get(name)!;
        let sessionType = await tx.sessionType.findFirst({ where: { name } });
        if (!sessionType) {
          sessionType = await tx.sessionType.create({ data: { name } });
        }
        sessionTypeCache.set(name, sessionType.id);
        return sessionType.id;
      }

      async function getOrCreateSession(dateId: string, sessionTypeId: string): Promise<string> {
        const key = `${dateId}:${sessionTypeId}`;
        if (sessionCache.has(key)) return sessionCache.get(key)!;
        const session = await structureService.addSession(dateId, sessionTypeId, actor, { tx });
        sessionCache.set(key, session.id);
        sessionsCreated++;
        return session.id;
      }

      // 4. Catálogo (Distancia/Estilo/Tipo de prueba/Prueba maestra) — se
      // reutiliza lo que ya exista y solo se crea lo que falte.
      const testTypes = await tx.testType.findMany();
      const individualTestType = testTypes.find((t) => t.swimmersCount === 1);

      /**
       * DE DÓNDE SALE EL TIPO DE RELEVO DE CADA PRUEBA.
       *
       * Ningún formato que sepamos leer aporta el número de postas: el `.hyv`
       * no lo trae, y el `.ev3` lo trae en [29] pero este importador todavía
       * no lo lee (tarea aparte). La posta sale del tipo de prueba —
       * `Distance.meters` guarda el TOTAL, 200 para un 4×50, y
       * `TestType.swimmersCount` dice en cuántas se divide—, y ese tipo lo
       * elige AHORA el usuario, prueba por prueba, en la fase de confirmación.
       *
       * El catálogo se relee aquí, dentro de la transacción, y las decisiones
       * se validan contra esta lectura: entre el análisis y la confirmación
       * alguien pudo borrar un tipo de prueba, y entonces la elección ya no
       * significa nada.
       */
      const tiposDeRelevo = ordenarTiposDeRelevo(testTypes);

      if (!individualTestType) {
        throw new ValidationError("El catálogo no tiene configurado el tipo de prueba Individual (revise el seed inicial).");
      }

      const relevosDelArchivo = relevosParaConfirmar(meet, tiposDeRelevo);

      /** Tipo de relevo resuelto por número de prueba, o la marca de omitir. */
      const decisionPorPrueba = new Map<number, DecisionResuelta>();

      if (relevosDelArchivo.length > 0) {
        if (tiposDeRelevo.length === 0) {
          throw new ValidationError(
            "El archivo trae relevos y el catálogo no tiene ningún tipo de prueba de relevo configurado (revise el seed inicial)."
          );
        }

        if (input.confirmacionDeRelevos) {
          const validacion = validarDecisiones(relevosDelArchivo, input.confirmacionDeRelevos.decisiones, tiposDeRelevo);
          if (!validacion.ok) {
            // Se lanzan TODOS los problemas juntos: corregirlos de a uno, con
            // una importación fallida por cada uno, sería exasperante.
            throw new ValidationError(validacion.errores.join("\n\n"), { errores: validacion.errores });
          }
          for (const [numero, decision] of validacion.porPrueba) decisionPorPrueba.set(numero, decision);
        } else {
          /**
           * SIN CONFIRMACIÓN NO SE IMPORTA NINGÚN RELEVO, venga el archivo en
           * el formato que venga.
           *
           * Aquí ya no queda ninguna rama que elija por su cuenta. La que
           * había —tomar el primer tipo de relevo del catálogo y avisar— se
           * eliminó: elegir el único candidato disponible no es una deducción
           * sobre el archivo, es una propiedad del catálogo, y el valor no es
           * cosmético (decide cuántos nadadores exige cada inscripción de
           * relevo).
           *
           * El motivo difiere según el formato y el mensaje también: el `.hyv`
           * no trae el dato, mientras que el `.ev3` sí lo trae en [29] y lo
           * que falta es leerlo. Es una medida temporal de seguridad de datos
           * mientras esa lectura no exista y esté probada.
           */
          throw new ValidationError(esHyv ? AVISO_RELEVOS_SIN_CONFIRMAR_HYV : AVISO_RELEVOS_SIN_CONFIRMAR_EV3);
        }

        /**
         * Un total que no se divide entre las postas del tipo elegido no es
         * representable de forma legible: `formatDistanceLabel` renuncia a
         * mostrar "n×m" y deja el total crudo. No se rechaza —la prueba es
         * válida y la competencia nace en Borrador—, pero se nombra, porque
         * en pantalla se vería como un número suelto sin explicación.
         */
        const noDivisibles = relevosDelArchivo.filter((relevo) => {
          const decision = decisionPorPrueba.get(relevo.eventNumber);
          if (typeof decision !== "string") return false;
          const tipo = tiposDeRelevo.find((t) => t.id === decision)!;
          return relevo.distanceMeters % tipo.swimmersCount !== 0;
        });
        if (noDivisibles.length > 0) {
          warnings.push(
            `${noDivisibles.length} relevo(s) tienen una distancia total que no se divide entre las postas del tipo elegido ` +
              `(${noDivisibles.map((e) => `#${e.eventNumber}: ${e.distanceMeters}m`).join(", ")}). ` +
              "Se importaron igual, pero su distancia se mostrará como el total y no como «n×m»: revise que el tipo de prueba sea el correcto."
          );
        }
      }

      async function getOrCreateDistance(meters: number): Promise<string> {
        const key = String(meters);
        if (distanceCache.has(key)) return distanceCache.get(key)!;
        let distance = await tx.distance.findUnique({ where: { meters } });
        if (!distance) distance = await tx.distance.create({ data: { meters } });
        distanceCache.set(key, distance.id);
        return distance.id;
      }

      async function getOrCreateStroke(name: string): Promise<string> {
        if (strokeCache.has(name)) return strokeCache.get(name)!;
        let stroke = await tx.stroke.findUnique({ where: { name } });
        if (!stroke) stroke = await tx.stroke.create({ data: { name } });
        strokeCache.set(name, stroke.id);
        return stroke.id;
      }

      async function getOrCreateEvent(
        testTypeId: string,
        distanceId: string,
        strokeId: string,
        gender: "male" | "female" | "mixed"
      ): Promise<string> {
        const key = `${testTypeId}:${distanceId}:${strokeId}:${gender}`;
        if (eventCache.has(key)) return eventCache.get(key)!;
        let event = await tx.event.findFirst({ where: { testTypeId, distanceId, strokeId, gender, deletedAt: null } });
        if (!event) {
          event = await tx.event.create({
            data: { testTypeId, distanceId, strokeId, gender, createdBy: actor.userId, updatedBy: actor.userId },
          });
        }
        eventCache.set(key, event.id);
        return event.id;
      }

      let eventsImported = 0;
      let eventsSkipped = 0;

      for (const [indice, parsedEvent] of meet.events.entries()) {
        /**
         * OMISIÓN DELIBERADA de un relevo cuyo tipo no se pudo confirmar.
         *
         * Va ANTES del savepoint porque no es un fallo: no hay nada que
         * intentar ni que revertir. Se cuenta en `eventsSkipped` —lo que
         * dispara el aviso de IMPORTACIÓN PARCIAL— y su mensaje empieza por
         * "Prueba #", que es lo que recoge `skippedDetail` en la auditoría.
         * Así la omisión queda contada y visible en los tres lugares, en vez
         * de desaparecer.
         */
        if (parsedEvent.isRelay && decisionPorPrueba.get(parsedEvent.eventNumber) === OMITIR) {
          eventsSkipped++;
          warnings.push(
            `Prueba #${parsedEvent.eventNumber} (${parsedEvent.distanceMeters}m ${parsedEvent.strokeName}, relevo): ` +
              "no se importó porque no se confirmó en cuántas postas se divide. Cárguela manualmente en el detalle de la competencia."
          );
          continue;
        }

        const instantanea = tomarInstantanea();
        try {
          /**
           * Cada prueba se intenta dentro de su propio savepoint. Sin él, la
           * primera prueba que fallara abortaría la transacción entera y este
           * `catch` no podría "saltarla y seguir": todas las consultas
           * posteriores fallarían. Con el savepoint, el fallo revierte solo lo
           * que esa prueba alcanzó a escribir y la importación continúa, con
           * el mismo comportamiento tolerante que tenía antes.
           */
          await withSavepoint(tx, `sp_prueba_${indice}`, async () => {
            /**
             * Para un relevo, el tipo es el que se decidió para ESTA prueba
             * —no el del catálogo, no el de otra prueba con la misma
             * distancia y estilo—. Las omisiones ya se descartaron arriba, así
             * que aquí la decisión es siempre un id.
             */
            const testTypeId = parsedEvent.isRelay
              ? (decisionPorPrueba.get(parsedEvent.eventNumber) as string)
              : individualTestType.id;
            const distanceId = await getOrCreateDistance(parsedEvent.distanceMeters);
            const strokeId = await getOrCreateStroke(parsedEvent.strokeName);
            const eventId = await getOrCreateEvent(testTypeId, distanceId, strokeId, parsedEvent.gender);

            const jornada = inferSessionTypeName(parsedEvent.sessionTime);
            const sessionTypeId = await getOrCreateSessionType(jornada.nombre);
            const competitionSessionId = await getOrCreateSession(dateIdParaPrueba(parsedEvent), sessionTypeId);
            if (!jornada.especificada) pruebasSinJornada++;

            await addCompetitionEvent(
              competition.id,
              { eventId, competitionSessionId, categoryIds: [], displayOrder: parsedEvent.eventNumber },
              actor,
              { tx }
            );
          });
          eventsImported++;
        } catch (err) {
          restaurarInstantanea(instantanea);
          eventsSkipped++;
          warnings.push(
            `Prueba #${parsedEvent.eventNumber} (${parsedEvent.distanceMeters}m ${parsedEvent.strokeName}): no se pudo importar — ${motivoDePruebaSaltada(
              err
            )}`
          );
        }
      }

      /**
       * Si NINGUNA prueba se pudo importar, la competencia no sirve de nada:
       * quedaría un cascarón con fechas vacías. Se lanza el motivo real (el
       * primer error de la lista) en vez de devolver un "importación exitosa:
       * 0 pruebas", y al lanzarlo la transacción revierte todo.
       */
      if (eventsImported === 0) {
        throw new ValidationError(
          `No se pudo importar ninguna de las ${meet.events.length} pruebas del archivo, así que la competencia no se creó.\n\n` +
            `Primer motivo: ${warnings.find((w) => w.startsWith("Prueba #")) ?? "desconocido"}`,
          { eventCount: meet.events.length, warnings }
        );
      }

      // Importación parcial: se conserva lo importado (la competencia queda en
      // Borrador y el administrador la revisa), pero el aviso va PRIMERO en la
      // lista para que no pase inadvertido entre los avisos de rutina.
      if (eventsSkipped > 0) {
        warnings.unshift(
          `IMPORTACIÓN PARCIAL: ${eventsImported} de ${meet.events.length} pruebas se importaron y ${eventsSkipped} quedaron fuera. ` +
            `Revise el detalle más abajo y complete manualmente lo que falte antes de abrir las inscripciones.`
        );
      }

      /**
       * Va antes que el aviso de categorías porque exige una acción distinta:
       * las categorías siempre hay que configurarlas, en cambio una jornada
       * sin especificar solo aparece cuando el archivo no alcanzó a decirla, y
       * es lo que hay que mirar primero al revisar la competencia.
       */
      if (pruebasSinJornada > 0) {
        warnings.push(
          `${AVISO_JORNADA_SIN_ESPECIFICAR} (${pruebasSinJornada} de ${eventsImported} pruebas importadas).`
        );
      }

      warnings.push(
        "Ninguna prueba importada tiene categorías habilitadas todavía (el archivo de Meet Manager no incluye esa información) — " +
          "debe asignarlas manualmente en el detalle de la competencia antes de abrir las inscripciones."
      );

      await audit(
        {
          userId: actor.userId,
          action: "COMPETITION_IMPORTED_FROM_MEET_EVENTS",
          entityType: "Competition",
          entityId: competition.id,
          ipAddress: actor.ipAddress,
          // `eventsSkipped > 0` es una importación PARCIAL: queda anotado en el
        // mismo registro, con el detalle de qué no entró, para que después se
        // pueda saber que esa competencia nació incompleta.
        after: {
          formato: formato.tipo,
          eventsImported,
          eventsSkipped,
          sessionsCreated,
          // Qué se decidió para los relevos, y si esas decisiones vinieron
          // confirmadas por el usuario: es lo que permite saber después si una
          // competencia nació con un tipo de relevo elegido o adivinado.
          relevosConfirmados: Boolean(input.confirmacionDeRelevos),
          relevosOmitidos: [...decisionPorPrueba.entries()].filter(([, d]) => d === OMITIR).map(([n]) => n),
          // Cuántas pruebas quedaron pendientes de repartir en jornadas: es el
          // trabajo manual que la importación deja abierto, y conviene poder
          // saber después si una competencia nació así.
          pruebasSinJornada,
          partial: eventsSkipped > 0,
          ...(eventsSkipped > 0 ? { skippedDetail: warnings.filter((w) => w.startsWith("Prueba #")) } : {}),
        },
        },
        { tx }
      );

      return {
        competitionId: competition.id,
        competitionName: competition.name,
        eventsImported,
        eventsSkipped,
        sessionsCreated,
        warnings,
      };
  }, LONG_TRANSACTION_OPTIONS);
  }
}

/**
 * Deja constancia de un intento de importación que no prosperó.
 *
 * Va FUERA de la transacción y es best-effort: cuando se llega aquí la
 * transacción —si llegó a abrirse— ya se deshizo, así que no hay ninguna a la
 * que sumarse, y fallar al anotar solo cambiaría el mensaje que recibe quien
 * importa. Se registra QUÉ se intentó y hasta dónde se llegó, nunca el
 * contenido del archivo.
 *
 * Se llama exactamente una vez por intento fallido: es el único `catch` del
 * flujo.
 */
async function registrarIntentoFallido(
  actor: ActorContext,
  etapa: string,
  parsed: ParsedMeet | undefined,
  err: unknown,
  /**
   * Cuál de las dos fases falló. El análisis no crea la competencia, pero sus
   * fallos SÍ se registran —y ese registro es la única escritura que hace—:
   * al separarlo de la importación, un archivo ilegible pasó a fallar antes de
   * llegar a `importCompetitionFromMeetEventsZip`, y sin esto el rastro que
   * existía se habría perdido justo para los archivos que más conviene poder
   * revisar después.
   */
  fase: "analisis" | "importacion"
): Promise<void> {
  await audit({
    userId: actor.userId,
    action: "COMPETITION_IMPORT_FAILED",
    entityType: "Competition",
    entityId: null,
    ipAddress: actor.ipAddress,
    after: {
      fase,
      etapa,
      // Solo si el archivo alcanzó a interpretarse.
      competitionName: parsed?.name || null,
      eventCount: parsed?.events.length ?? null,
      startDate: parsed?.startDate ?? null,
      endDate: parsed?.endDate ?? null,
      ...describirFallo(err),
    },
  });
}

/**
 * Describe un fallo de forma SEGURA para guardar y para responder.
 *
 * El mensaje de un `ValidationError` es texto que este servicio escribió para
 * que lo lea quien importa, y se conserva. El de cualquier otro error no: un
 * error de Prisma trae la consulta y los valores, uno del sistema de archivos
 * trae rutas absolutas del servidor. Guardarlo en `audit_logs` —una tabla que
 * la API expone y que no se borra nunca— o devolverlo al cliente convertía un
 * fallo interno en una filtración. De esos solo se anota la clase y, si lo
 * tiene, un código conocido.
 */
function describirFallo(err: unknown): { reason: string | null; errorName?: string; errorCode?: string } {
  if (err instanceof ValidationError) {
    return { reason: err.message };
  }
  const nombre = err instanceof Error ? err.constructor.name : typeof err;
  const codigo = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
  return { reason: null, errorName: nombre, ...(codigo ? { errorCode: codigo } : {}) };
}

/**
 * Por qué no entró una prueba, en términos publicables.
 *
 * Este texto tiene tres destinos, y los tres son visibles: los avisos que
 * recibe quien importa, `skippedDetail` en `audit_logs`, y —cuando NINGUNA
 * prueba entró— el mensaje del error que se devuelve. Copiar aquí `err.message`
 * dejaba abierta exactamente la misma filtración que `describirFallo` cierra
 * en el nivel de arriba: un fallo inesperado de Prisma habría publicado su
 * consulta y sus valores por esta vía aunque el `catch` externo la tapara.
 */
function motivoDePruebaSaltada(err: unknown): string {
  const { reason, errorName, errorCode } = describirFallo(err);
  if (reason) return reason;
  // Sin mensaje publicable: se identifica el fallo sin describirlo.
  return `error interno (${errorName ?? "desconocido"}${errorCode ? `, código ${errorCode}` : ""})`;
}

/** Error que se devuelve al cliente, sin filtrar detalles internos. */
function traducirFalloDeImportacion(etapa: string, err: unknown): Error {
  // Los errores de dominio ya traen un mensaje escrito para el usuario.
  if (err instanceof ValidationError) return err;

  /**
   * `parseEv3File` y `parseHyvFile` lanzan `Error` corriente con mensajes
   * redactados para quien importa ("No se pudo leer la fecha de inicio..."),
   * así que se conservan; cualquier otra cosa se responde genérica.
   */
  if (etapa === "interpretacion-del-archivo" && err instanceof Error && !(err instanceof AppError)) {
    return new ValidationError(err.message);
  }

  return new ValidationError(
    'La importación falló y no se creó la competencia. Revise que el archivo sea el de "Meet Events" ' +
      "exportado desde Hy-Tek Meet Manager (.zip, .ev3 o .hyv). " +
      "Si el problema persiste, informe al administrador con la fecha y hora del intento."
  );
}
