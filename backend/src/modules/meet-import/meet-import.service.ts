import { prisma } from "../../shared/prisma.client";
import { readSingleEntryFromZip } from "../../shared/safeZip";
import { audit } from "../audit/audit.service";
import { AppError, ValidationError } from "../../shared/errors";
import { LONG_TRANSACTION_OPTIONS, withSavepoint } from "../../shared/transaction";
import { parseEv3File, type ParsedMeet } from "./ev3-parser";
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
 * Determina la jornada (mañana/tarde/noche) a partir de la hora de la
 * sesión del archivo importado — el archivo Hy-Tek no tiene un concepto
 * de "SessionType" con nombre, solo una hora de reloj.
 */
function inferSessionTypeName(sessionTime: string): string {
  const match = sessionTime.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return "Sesión";
  let hour = Number(match[1]);
  const ampm = match[3]!.toUpperCase();
  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  if (hour < 12) return "Mañana";
  if (hour < 18) return "Tarde";
  return "Noche";
}

/** Días que abarca el rango, ambos extremos incluidos. */
function countDays(startDate: Date, endDate: Date): number {
  const dias = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  return Math.max(1, dias);
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
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
 * Importa una competencia completa desde el .zip de "Meet Events"
 * exportado por Hy-Tek Meet Manager: crea la competencia (en Borrador),
 * su(s) fecha(s), las jornadas necesarias (inferidas por hora), las
 * pruebas maestras del catálogo (reutilizando las existentes cuando ya
 * coinciden), y las asigna a la competencia — SIN categorías habilitadas,
 * ya que el archivo de Meet Manager no trae esa información (es un dato
 * exclusivo de este sistema, sección 12/13). El resumen indica cuántas
 * pruebas quedaron pendientes de configurar categorías.
 */
export async function importCompetitionFromMeetEventsZip(
  zipBuffer: Buffer,
  input: { maxIndividualEventsPerSwimmer: number; maxRelayEventsPerSwimmerPerSession?: number },
  actor: ActorContext
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
  let etapa: "lectura-del-zip" | "interpretacion-del-archivo" | "validacion" | "escritura" = "lectura-del-zip";

  try {
    return await ejecutarImportacion();
  } catch (err) {
    await registrarIntentoFallido(actor, etapa, parsed, err);
    throw traducirFalloDeImportacion(etapa, err);
  }

  async function ejecutarImportacion(): Promise<MeetImportSummary> {
  const ev3Content = findEv3EntryInZip(zipBuffer);
  etapa = "interpretacion-del-archivo";
  parsed = parseEv3File(ev3Content);
  etapa = "validacion";

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
  if (dayCount > 1) {
    throw new ValidationError(
      `La competencia del archivo abarca ${dayCount} días (${formatDay(meet.startDate)} a ${formatDay(meet.endDate)}), pero el formato .ev3 ` +
        `no indica en qué día se nada cada prueba. Importarla asignaría las ${meet.events.length} pruebas al primer día, ` +
        `dejando mal calculados los límites por jornada y los reportes por fecha.\n\n` +
        `Qué hacer: cree la competencia manualmente (fechas, jornadas y pruebas) usando este archivo como referencia. ` +
        `NO importe un archivo .ev3 por cada día: cada importación crea una competencia SEPARADA, y terminaría con ` +
        `${dayCount} competencias distintas en vez de una sola con ${dayCount} fechas.`,
      { days: dayCount, startDate: meet.startDate, endDate: meet.endDate, eventCount: meet.events.length }
    );
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
      const singleDateId = Object.values(dateIds)[0]!;

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
       * Las cachés anteriores memorizan filas creadas DENTRO de la
       * transacción. Cuando el intento de una prueba se revierte a su
       * savepoint, esas filas dejan de existir, así que la caché tiene que
       * volver al mismo punto: de lo contrario una prueba posterior
       * reutilizaría el id de una distancia o un estilo que ya no está y
       * fallaría por clave foránea.
       */
      const cachesReversibles = [sessionTypeCache, sessionCache, distanceCache, strokeCache, eventCache];
      function tomarInstantanea() {
        return { copias: cachesReversibles.map((c) => new Map(c)), sessionsCreated };
      }
      function restaurarInstantanea(inst: ReturnType<typeof tomarInstantanea>) {
        cachesReversibles.forEach((cache, idx) => {
          cache.clear();
          for (const [k, v] of inst.copias[idx]!) cache.set(k, v);
        });
        sessionsCreated = inst.sessionsCreated;
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
      const relayTestType = testTypes.find((t) => t.swimmersCount > 1);
      if (!individualTestType || !relayTestType) {
        throw new ValidationError("El catálogo no tiene configurados los tipos de prueba Individual y Relevo (revise el seed inicial).");
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
            const testTypeId = parsedEvent.isRelay ? relayTestType.id : individualTestType.id;
            const distanceId = await getOrCreateDistance(parsedEvent.distanceMeters);
            const strokeId = await getOrCreateStroke(parsedEvent.strokeName);
            const eventId = await getOrCreateEvent(testTypeId, distanceId, strokeId, parsedEvent.gender);

            const sessionTypeName = inferSessionTypeName(parsedEvent.sessionTime);
            const sessionTypeId = await getOrCreateSessionType(sessionTypeName);
            const competitionSessionId = await getOrCreateSession(singleDateId, sessionTypeId);

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
          eventsImported,
          eventsSkipped,
          sessionsCreated,
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
  err: unknown
): Promise<void> {
  await audit({
    userId: actor.userId,
    action: "COMPETITION_IMPORT_FAILED",
    entityType: "Competition",
    entityId: null,
    ipAddress: actor.ipAddress,
    after: {
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
   * `parseEv3File` lanza `Error` corriente con mensajes redactados para quien
   * importa ("No se pudo leer la fecha de inicio..."), así que se conservan;
   * cualquier otra cosa se responde genérica.
   */
  if (etapa === "interpretacion-del-archivo" && err instanceof Error && !(err instanceof AppError)) {
    return new ValidationError(err.message);
  }

  return new ValidationError(
    "La importación falló y no se creó la competencia. Revise que el archivo sea el ZIP de \"Meet Events\" " +
      "exportado desde Hy-Tek Meet Manager. Si el problema persiste, informe al administrador con la fecha y hora del intento."
  );
}
