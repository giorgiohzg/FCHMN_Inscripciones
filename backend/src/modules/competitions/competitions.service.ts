import { prisma } from "../../shared/prisma.client";
import { audit, withAudit } from "../audit/audit.service";
import { ValidationError, NotFoundError } from "../../shared/errors";
import { computeEffectiveStatus, recomputeStatusAfterEdit, evaluateCompetitionAction, evaluateReopenRegistrations, type CompetitionAction } from "./competitions.rules";
import { shouldCloseRegistrations } from "./competition-capacity.rules";
import { readCapacityUsage } from "./competition-capacity.service";
import { scopedClubId, type ActorContext as SharedActorContext } from "../../shared/actorContext";
import { type TxOption } from "../../shared/transaction";
import { withTranslatedPrismaErrors } from "../../shared/prismaErrors";
import type { CompetitionCreateInput, CompetitionUpdateInput, CompetitionListQuery, DuplicateCompetitionInput } from "./competitions.schemas";

interface ActorContext {
  userId: string;
  ipAddress?: string;
  isAdmin?: boolean;
}

/**
 * RB-07: aplica el auto-cómputo de apertura/cierre (lazy, en cada lectura)
 * y persiste el cambio si el estado efectivo difiere del almacenado. Así
 * no se necesita un job programado para que el estado quede siempre
 * correcto al consultarlo — la misma función pura serviría para un cron.
 */
async function applyAutoStatus<T extends { id: string; status: any; registrationStartAt: Date; registrationEndAt: Date }>(
  competition: T
): Promise<T> {
  const effective = computeEffectiveStatus(competition.status, competition.registrationStartAt, competition.registrationEndAt, new Date());
  if (effective === competition.status) return competition;

  /**
   * Hallazgo 23 — este cambio de estado NO dejaba rastro.
   *
   * Es el único que ocurre sin que nadie lo pida: una competencia pasa sola de
   * "programada" a "abierta" y de "abierta" a "cerrada" al leerla. Sin
   * auditoría, la pregunta "¿cuándo se cerró esta competencia?" no tenía
   * respuesta en el sistema, y justo esa fecha es la que decide si una
   * inscripción fue una excepción post-cierre.
   *
   * Va en transacción con el cambio: es un cambio de estado de negocio, del
   * grupo trazable. `userId` es nulo a propósito — no hay actor, lo hizo el
   * paso del tiempo.
   */
  const updated = await prisma.$transaction(async (tx) => {
    /*
      La causa viaja con el estado.

      `applyAutoStatus` PERSISTE el cierre por vencimiento de la fecha, así que
      tiene que registrar su causa: si no, seguiría generando filas 'closed'
      sin causa y NULL dejaría de significar "anterior a este campo".

      Al reabrir (hacia 'open' o 'scheduled') ambos campos se limpian: una
      competencia abierta no tiene causa de cierre, y la restricción
      `competitions_close_reason_coherente` lo exige en la base.
    */
    const fila = await tx.competition.update({
      where: { id: competition.id },
      data:
        effective === "closed"
          ? { status: effective, registrationsClosedReason: "schedule", registrationsClosedAt: new Date() }
          : { status: effective, registrationsClosedReason: null, registrationsClosedAt: null },
    });
    await audit(
      {
        userId: null,
        action: "COMPETITION_STATUS_AUTO_CHANGED",
        entityType: "Competition",
        entityId: competition.id,
        before: { status: competition.status },
        after: { status: effective, registrationStartAt: competition.registrationStartAt, registrationEndAt: competition.registrationEndAt },
      },
      { tx }
    );
    return fila;
  });
  return { ...competition, status: updated.status };
}

// Estos 3 estados son los únicos que el auto-cómputo de RB-07 puede
// modificar (scheduled -> open -> closed). Si se filtra por cualquiera de
// ellos, hay que traer TODOS los candidatos en ese conjunto — filtrar
// directo por `query.status` en la base de datos excluiría de entrada
// competencias cuyo estado guardado todavía no se "auto-sanó" (por
// ejemplo, una competencia guardada como 'scheduled' cuya fecha de inicio
// de inscripción ya llegó, y que nadie volvió a abrir individualmente
// para que se actualizara sola).
const AUTO_MUTABLE_STATUSES = ["scheduled", "open", "closed"];

export async function listCompetitions(query: CompetitionListQuery, hideDraftAndScheduled: boolean = false) {
  const where: any = {};
  if (query.search) where.name = { contains: query.search.trim(), mode: "insensitive" };

  // "draft" nunca se recalcula automáticamente (no es un AUTO_MUTABLE_STATUS),
  // así que si hay que ocultarlas se puede filtrar directo en la base de
  // datos, sin afectar el resto de la lógica de paginación.
  if (hideDraftAndScheduled) where.NOT = { status: "draft" };

  const filteringByMutableStatus = query.status && AUTO_MUTABLE_STATUSES.includes(query.status);
  if (query.status) {
    where.status = filteringByMutableStatus ? { in: AUTO_MUTABLE_STATUSES } : query.status;
  }

  // "scheduled" SÍ es auto-mutable (una competencia guardada como
  // 'scheduled' puede ya estar efectivamente 'open' por fecha) — no se
  // puede filtrar de forma confiable en la base de datos, así que cuando
  // hay que ocultarla (roles sin acceso a Borrador/Programada) se usa el
  // mismo camino de "traer todo y paginar en memoria" que ya existía para
  // filtrar por un estado auto-mutable.
  const needsFullFetch = filteringByMutableStatus || hideDraftAndScheduled;

  // Cuando se filtra por un estado auto-mutable, no se puede paginar de
  // forma confiable a nivel de base de datos (el estado real solo se sabe
  // después de recalcularlo) — se trae el conjunto completo de candidatos
  // y se pagina en memoria después de filtrar.
  const [rawItems, totalWithoutStatusFilter] = await Promise.all([
    prisma.competition.findMany({
      where,
      /**
       * El desempate por `id` vale para los DOS caminos: el que pagina en la
       * base y el que trae todo y recorta en memoria más abajo. En el segundo
       * el orden viene de esta misma consulta, así que si no fuera total, el
       * `slice` cortaría por un sitio distinto en cada petición.
       */
      orderBy: [{ registrationStartAt: "desc" }, { id: "desc" }],
      ...(needsFullFetch ? {} : { skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    }),
    prisma.competition.count({ where }),
  ]);

  const withEffectiveStatus = await Promise.all(rawItems.map((c) => applyAutoStatus(c)));

  if (!needsFullFetch) {
    return { items: withEffectiveStatus, total: totalWithoutStatusFilter, page: query.page, pageSize: query.pageSize };
  }

  const filtered = withEffectiveStatus.filter((c) => {
    if (hideDraftAndScheduled && (c.status === "draft" || c.status === "scheduled")) return false;
    if (query.status && c.status !== query.status) return false;
    return true;
  });
  const start = (query.page - 1) * query.pageSize;
  const paged = filtered.slice(start, start + query.pageSize);

  return { items: paged, total: filtered.length, page: query.page, pageSize: query.pageSize };
}

/**
 * `hideIfDraftOrScheduled`: para roles sin acceso a competencias en
 * Borrador o Programada — se lanza NotFoundError (no Forbidden) para no
 * revelar siquiera que la competencia existe.
 */
export async function getCompetitionById(id: string, hideIfDraftOrScheduled: boolean = false) {
  const competition = await prisma.competition.findUnique({
    where: { id },
    include: {
      dates: { include: { sessions: { include: { sessionType: true, limit: true } } }, orderBy: { date: "asc" } },
      pool: true,
    },
  });
  if (!competition) throw new NotFoundError("Competencia");
  const withEffectiveStatus = await applyAutoStatus(competition);
  if (hideIfDraftOrScheduled && (withEffectiveStatus.status === "draft" || withEffectiveStatus.status === "scheduled")) {
    throw new NotFoundError("Competencia");
  }
  return withEffectiveStatus;
}

export async function createCompetition(input: CompetitionCreateInput, actor: ActorContext, options?: TxOption) {
  /**
   * La invariante del rango se comprueba AQUÍ, no solo en el esquema Zod.
   *
   * El esquema protege el endpoint HTTP, pero este servicio también se llama
   * desde dentro del sistema —la importación de competencias desde un .ev3—,
   * donde los datos vienen de un archivo y nunca pasan por Zod. Una
   * competencia con `registrationEndAt` anterior al inicio es un rango que
   * `computeEffectiveStatus` nunca abre y que además bloquea toda edición
   * posterior por la propia validación de rangos: queda inservible y solo se
   * puede arreglar por base de datos.
   *
   * La regla vive donde se persiste, que es el único punto por el que pasan
   * todos los caminos. La misma comprobación existe en `updateCompetition`
   * sobre los valores combinados (hallazgo 12).
   */
  if (input.registrationEndAt <= input.registrationStartAt) {
    throw new ValidationError(
      `La fecha de fin de inscripción debe ser posterior a la de inicio. Se recibió inicio ` +
        `${input.registrationStartAt.toISOString().slice(0, 10)} y fin ${input.registrationEndAt.toISOString().slice(0, 10)}.`,
      { registrationStartAt: input.registrationStartAt, registrationEndAt: input.registrationEndAt }
    );
  }

  return withAudit(
    (tx) =>
      tx.competition.create({
        data: {
          name: input.name,
          description: input.description || null,
          status: "draft",
          registrationStartAt: input.registrationStartAt,
          registrationEndAt: input.registrationEndAt,
          ageCutoffDate: input.ageCutoffDate,
          maxIndividualEventsPerSwimmer: input.maxIndividualEventsPerSwimmer,
          maxRelayEventsPerSwimmerPerSession: input.maxRelayEventsPerSwimmerPerSession,
          // Cupos de nadadores: `?? null` conserva el "sin límite" cuando el
          // formulario no los envía, que es el comportamiento de siempre.
          maxSwimmers: input.maxSwimmers ?? null,
          maxSwimmersPerClub: input.maxSwimmersPerClub ?? null,
          poolId: input.poolId || null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      }),
    (competition) => ({
      userId: actor.userId,
      action: "COMPETITION_CREATED",
      entityType: "Competition",
      entityId: competition.id,
      ipAddress: actor.ipAddress,
      after: competition,
    }),
    options
  );
}

export async function updateCompetition(id: string, input: CompetitionUpdateInput, actor: ActorContext) {
  const before = await getCompetitionById(id);

  // El administrador puede editar fechas sin importar el estado actual de
  // la competencia (antes se bloqueaba fuera de 'draft'/'scheduled'). Como
  // contraparte, si la edición cambia el resultado de comparar las fechas
  // contra "ahora", el estado se recalcula en consecuencia — ej.: si
  // estaba 'closed' y se extiende la fecha de cierre a futuro, vuelve a
  // 'open' automáticamente. Ver `recomputeStatusAfterEdit` para el detalle
  // de qué estados nunca se tocan (draft/cancelled/in_progress/finished).
  const effectiveRegistrationStartAt = input.registrationStartAt ?? before.registrationStartAt;
  const effectiveRegistrationEndAt = input.registrationEndAt ?? before.registrationEndAt;

  // Hallazgo 12: el rango se valida sobre los valores COMBINADOS (lo enviado
  // + lo ya guardado), no solo cuando ambas fechas vienen juntas. Enviar solo
  // `registrationStartAt` con una fecha posterior al fin ya almacenado
  // superaba el esquema Zod y dejaba la competencia con un rango imposible,
  // que además hacía que `computeEffectiveStatus` no la abriera nunca.
  if (effectiveRegistrationEndAt <= effectiveRegistrationStartAt) {
    throw new ValidationError(
      "La fecha de fin de inscripción debe ser posterior a la de inicio. " +
        `Con este cambio quedarían: inicio ${effectiveRegistrationStartAt.toISOString().slice(0, 10)} y fin ${effectiveRegistrationEndAt
          .toISOString()
          .slice(0, 10)}.`
    );
  }


  /**
   * CUPOS — coherencia sobre los valores COMBINADOS, por el mismo motivo que
   * las fechas (hallazgo 12): enviar solo `maxSwimmersPerClub` no permite a
   * Zod compararlo con el cupo global ya guardado.
   *
   * `=== undefined` y no `??`: enviar null explícito QUITA el cupo, que es
   * una operación distinta de no tocarlo.
   */
  const effectiveMaxSwimmers = input.maxSwimmers === undefined ? before.maxSwimmers : input.maxSwimmers;
  const effectiveMaxSwimmersPerClub = input.maxSwimmersPerClub === undefined ? before.maxSwimmersPerClub : input.maxSwimmersPerClub;
  if (effectiveMaxSwimmers != null && effectiveMaxSwimmersPerClub != null && effectiveMaxSwimmersPerClub > effectiveMaxSwimmers) {
    throw new ValidationError(
      `El cupo por club (${effectiveMaxSwimmersPerClub}) no puede superar el cupo total de la competencia (${effectiveMaxSwimmers}).`
    );
  }

  /**
   * Reducir un cupo por debajo de lo ya inscrito NO borra inscripciones.
   *
   * Lo que hace es lo mismo que haría alcanzarlo por la vía normal: bloquear
   * altas nuevas y, si el afectado es el cupo global, cerrar las
   * inscripciones. Borrar filas sería destruir trabajo de los clubes por un
   * cambio de configuración, y el sistema no lo hace en ningún caso.
   */
  /**
   * El estado se recalcula SOLO desde las fechas, y nunca reabre una
   * competencia cerrada: `recomputeStatusAfterEdit` ya no incluye 'closed'
   * entre los estados recalculables.
   *
   * Aquí vivía una inferencia de intención —"trae fechas", "hay cupo libre"—
   * que no resistía el payload real del formulario: éste envía siempre las
   * dos fechas y el cupo, se hayan tocado o no. Reabrir es ahora una acción
   * explícita (`reopenRegistrations`).
   */
  let recomputedStatus = recomputeStatusAfterEdit(before.status, effectiveRegistrationStartAt, effectiveRegistrationEndAt, new Date());

  /**
   * Reducir un cupo por debajo de lo ya inscrito NO borra inscripciones.
   *
   * Lo que hace es lo mismo que haría alcanzarlo por la vía normal: bloquear
   * altas nuevas y, si el afectado es el cupo global, cerrar las
   * inscripciones. Borrar filas sería destruir trabajo de los clubes por un
   * cambio de configuración, y el sistema no lo hace en ningún caso.
   */
  const nadadoresInscritos = (await readCapacityUsage(prisma, id)).swimmerIds.size;
  let cerradaPorCupo = false;
  /**
   * Reducir el cupo por debajo de lo inscrito cierra las INDIVIDUALES, igual
   * que alcanzarlo por la vía normal. No la competencia entera: los relevos se
   * forman con nadadores que ya ocupan cupo y no hay razón para bloquearlos,
   * y si la vía normal y esta discreparan, el mismo hecho —el cupo lleno—
   * dejaría estados distintos según cómo se llegara a él.
   */
  if (shouldCloseRegistrations(effectiveMaxSwimmers, nadadoresInscritos) && (recomputedStatus === "open" || recomputedStatus === "scheduled")) {
    recomputedStatus = "individual_closed";
    cerradaPorCupo = true;
  }

  /**
   * Los campos de causa se mueven CON el estado, nunca por separado: la
   * restricción `competitions_close_reason_coherente` exige que una fila
   * abierta no conserve causa de cierre, y que una cerrada la tenga completa.
   *
   * Una edición solo puede CERRAR (por cupo o por fecha vencida), nunca
   * reabrir, así que la rama de limpieza cubre únicamente el paso de
   * 'scheduled' a 'open' y similares, donde no había causa que limpiar.
   */
  const camposDeCierre =
    recomputedStatus === before.status
      ? {}
      : // El cierre PARCIAL también necesita su causa, y solo puede ser una: el
        // cupo. La restricción de la base lo exige, y sin esta rama la edición
        // que reduce el cupo escribía `individual_closed` con la causa a nulo y
        // la base rechazaba la escritura entera.
        recomputedStatus === "individual_closed"
        ? { registrationsClosedReason: "capacity" as const, registrationsClosedAt: new Date() }
        : recomputedStatus === "closed"
          ? {
              registrationsClosedReason: (cerradaPorCupo ? "capacity" : "schedule") as "capacity" | "schedule",
              registrationsClosedAt: new Date(),
            }
          : { registrationsClosedReason: null, registrationsClosedAt: null };

  const actualizada = await withAudit(
    (tx) =>
      tx.competition.update({
        where: { id },
        data: {
          name: input.name ?? undefined,
          description: input.description ?? undefined,
          registrationStartAt: input.registrationStartAt ?? undefined,
          registrationEndAt: input.registrationEndAt ?? undefined,
          ageCutoffDate: input.ageCutoffDate ?? undefined,
          maxIndividualEventsPerSwimmer: input.maxIndividualEventsPerSwimmer ?? undefined,
          maxRelayEventsPerSwimmerPerSession: input.maxRelayEventsPerSwimmerPerSession ?? undefined,
          // Igual que `poolId`: `=== undefined` para distinguir "no lo toques"
          // de "quítalo".
          maxSwimmers: input.maxSwimmers === undefined ? undefined : input.maxSwimmers,
          maxSwimmersPerClub: input.maxSwimmersPerClub === undefined ? undefined : input.maxSwimmersPerClub,
          // OJO: no usar `?? undefined` aquí — así sí se puede "limpiar" la
          // piscina de una competencia (enviando poolId: null explícito).
          poolId: input.poolId === undefined ? undefined : input.poolId,
          status: recomputedStatus !== before.status ? recomputedStatus : undefined,
          ...camposDeCierre,
          updatedBy: actor.userId,
        },
      }),
    (competition) => ({ userId: actor.userId, action: "COMPETITION_UPDATED", entityType: "Competition", entityId: id, ipAddress: actor.ipAddress, before, after: competition })
  );

  if (cerradaPorCupo) {
    await audit({
      userId: actor.userId,
      action: "COMPETITION_REGISTRATIONS_AUTO_CLOSED_BY_CAPACITY",
      entityType: "Competition",
      entityId: id,
      ipAddress: actor.ipAddress,
      before: { status: before.status, maxSwimmers: before.maxSwimmers },
      after: { status: "closed", maxSwimmers: effectiveMaxSwimmers },
    });
  }

  return actualizada;
}

export interface CompetitionCapacityView {
  maxSwimmers: number | null;
  maxSwimmersPerClub: number | null;
  /** Nadadores distintos con inscripción activa en toda la competencia. */
  totalSwimmers: number;
  /** Cupos globales libres, o null si no hay cupo global. */
  remainingSwimmers: number | null;
  /** true si el cupo global está alcanzado (o superado por una reducción). */
  isFull: boolean;
  /**
   * Uso por club. Un administrador recibe todos los clubes con al menos un
   * nadador inscrito; un usuario de club recibe únicamente el suyo.
   */
  byClub: { clubId: string; clubName: string; swimmers: number; remaining: number | null; isFull: boolean }[];
}

/**
 * Cupos y uso actual, para mostrarlos en la interfaz.
 *
 * Lectura pura: no cierra ni abre nada. El cierre automático ocurre en el
 * momento del alta (o de la edición de cupos), no al consultar — una consulta
 * no debe tener efectos.
 */
export async function getCompetitionCapacity(id: string, actor: SharedActorContext): Promise<CompetitionCapacityView> {
  const competition = await prisma.competition.findUnique({
    where: { id },
    select: { id: true, maxSwimmers: true, maxSwimmersPerClub: true },
  });
  if (!competition) throw new NotFoundError("Competencia");

  const uso = await readCapacityUsage(prisma, id);
  const totalSwimmers = uso.swimmerIds.size;

  // Recorte por alcance: un club solo puede ver su propia ocupación.
  const soloEsteClub = scopedClubId(actor);
  const clubIds = [...uso.swimmerIdsByClub.keys()].filter((c) => soloEsteClub === null || c === soloEsteClub);
  const clubes = clubIds.length
    ? await prisma.club.findMany({ where: { id: { in: clubIds } }, select: { id: true, name: true } })
    : [];
  const nombres = new Map(clubes.map((c) => [c.id, c.name]));

  return {
    maxSwimmers: competition.maxSwimmers,
    maxSwimmersPerClub: competition.maxSwimmersPerClub,
    totalSwimmers,
    remainingSwimmers: competition.maxSwimmers === null ? null : Math.max(0, competition.maxSwimmers - totalSwimmers),
    isFull: shouldCloseRegistrations(competition.maxSwimmers, totalSwimmers),
    byClub: clubIds
      .map((clubId) => {
        const swimmers = uso.swimmerIdsByClub.get(clubId)?.size ?? 0;
        return {
          clubId,
          clubName: nombres.get(clubId) ?? "(club desconocido)",
          swimmers,
          remaining: competition.maxSwimmersPerClub === null ? null : Math.max(0, competition.maxSwimmersPerClub - swimmers),
          isFull: competition.maxSwimmersPerClub !== null && swimmers >= competition.maxSwimmersPerClub,
        };
      })
      .sort((a, b) => a.clubName.localeCompare(b.clubName, "es")),
  };
}

/**
 * Transiciones manuales del ciclo de vida (schedule/cancel/closeRegistrations/start/finish).
 * `closeRegistrations` antes de tiempo es la "excepción manual" de la
 * sección 10, reservada a administradores autorizados (`isAdmin` ya viene
 * resuelto desde el RBAC de la ruta).
 */
export async function transitionCompetition(id: string, action: CompetitionAction, actor: ActorContext) {
  const before = await getCompetitionById(id);

  const result = evaluateCompetitionAction(before.status, action);
  if (!result.allowed) throw new ValidationError(result.reason!);

  /**
   * La causa acompaña al cierre manual, que es el que más importa distinguir:
   * es una decisión explícita y ninguna edición incidental debe anularla.
   *
   * Las demás transiciones que sacan a la competencia de 'closed'
   * —`start`, `cancel`— limpian los dos campos: fuera de 'closed' no hay
   * causa de cierre que guardar, y la restricción de la base lo exige.
   */
  const camposDeCierre =
    result.nextStatus === "closed"
      ? { registrationsClosedReason: "manual" as const, registrationsClosedAt: new Date() }
      : { registrationsClosedReason: null, registrationsClosedAt: null };

  return withAudit(
    (tx) => tx.competition.update({ where: { id }, data: { status: result.nextStatus!, ...camposDeCierre, updatedBy: actor.userId } }),
    (competition) => ({
      userId: actor.userId,
      action: `COMPETITION_${action.toUpperCase()}`,
      entityType: "Competition",
      entityId: id,
      ipAddress: actor.ipAddress,
      before,
      after: competition,
    })
  );
}

/**
 * Reabre las inscripciones de una competencia cerrada.
 *
 * Es una acción DELIBERADA y con nombre. Existe porque la alternativa
 * —deducir de una edición si el administrador quería reabrir— resultó
 * imposible de hacer con fiabilidad: el formulario envía siempre las fechas y
 * el cupo, se hayan tocado o no, y "hay cupo libre" no distingue entre
 * ampliar el cupo y que alguien haya cancelado una inscripción.
 *
 * Exige que los dos impedimentos posibles estén resueltos antes, y nombra el
 * que falte. No los corrige por su cuenta: ampliar un cupo o extender una
 * fecha son decisiones del administrador, no efectos colaterales de pulsar
 * "Reabrir".
 */
export async function reopenRegistrations(id: string, actor: ActorContext) {
  /**
   * COMPROBAR Y ESCRIBIR EN LA MISMA OPERACIÓN PROTEGIDA.
   *
   * La ocupación es una regla AGREGADA, igual que los límites por nadador
   * (hallazgo 9): depende de cuántas filas hay, no de una concreta, y ningún
   * índice único puede expresarla. Leer fuera y escribir después dejaba una
   * ventana real: entre el conteo y el `update`, un administrador con permiso
   * post-cierre podía inscribir al nadador que completaba el cupo, y la
   * reapertura se confirmaba igual. Resultado prohibido: competencia ABIERTA
   * con el cupo ya alcanzado.
   *
   * ORDEN DE ACCESO — el mismo que la vía de inscripción, a propósito:
   *
   *   1. `registrations` y `relay_registrations` (vía `readCapacityUsage`)
   *   2. `competitions`
   *
   * `createRegistration` hace exactamente eso: cuenta, inserta la
   * inscripción y solo al final toca `competitions` para cerrarla. Invertir
   * el orden aquí —bloquear primero la competencia y luego leer las
   * inscripciones— crearía el ciclo clásico entre dos transacciones que se
   * esperan mutuamente.
   *
   * Con `Serializable`, PostgreSQL detecta que ambas leyeron y escribieron el
   * mismo conjunto y aborta una con un conflicto de serialización, que
   * `withTranslatedPrismaErrors` convierte en un 409 reintentable.
   */
  return withTranslatedPrismaErrors(() =>
    prisma.$transaction(
      async (tx) => {
        // 1. Inscripciones primero.
        const inscritos = (await readCapacityUsage(tx, id)).swimmerIds.size;

        // 2. Y después la competencia.
        const before = await tx.competition.findUnique({ where: { id } });
        if (!before) throw new NotFoundError("Competencia");

        /**
         * El estado efectivo se calcula aquí, sin persistirlo: si se usara
         * `getCompetitionById` —que aplica y GUARDA el auto-estado— esa
         * escritura quedaría fuera de esta transacción y volvería a abrir la
         * ventana que este bloque cierra.
         */
        const estadoEfectivo = computeEffectiveStatus(before.status, before.registrationStartAt, before.registrationEndAt, new Date());

        const evaluacion = evaluateReopenRegistrations(
          estadoEfectivo,
          before.registrationsClosedReason,
          before.registrationStartAt,
          before.registrationEndAt,
          new Date(),
          { maxSwimmers: before.maxSwimmers, totalSwimmers: inscritos }
        );
        if (!evaluacion.allowed) throw new ValidationError(evaluacion.reason!);

        /**
         * REABRIR NO SIEMPRE LIMPIA LA CAUSA.
         *
         * Si la reapertura aterriza en `individual_closed` —porque el cupo
         * sigue lleno—, la competencia NO queda abierta: queda parcialmente
         * cerrada, y esa situación tiene causa, `capacity`. Limpiarla haría
         * dos daños: perdería la explicación de por qué las individuales
         * siguen cerradas, y la restricción `competitions_close_reason_
         * coherente` rechazaría la escritura, que exige causa para ese estado.
         *
         * Solo al abrir de verdad se limpian los dos campos.
         */
        const reabreDelTodo = evaluacion.nextStatus !== "individual_closed";

        const actualizada = await tx.competition.update({
          where: { id },
          data: {
            status: evaluacion.nextStatus!,
            ...(reabreDelTodo
              ? { registrationsClosedReason: null, registrationsClosedAt: null }
              : { registrationsClosedReason: "capacity", registrationsClosedAt: before.registrationsClosedAt ?? new Date() }),
            updatedBy: actor.userId,
          },
        });

        // La auditoría entra en la MISMA transacción: una reapertura sin
        // rastro de quién la pidió no puede quedar en la base.
        await audit(
          {
            userId: actor.userId,
            action: "COMPETITION_REGISTRATIONS_REOPENED",
            entityType: "Competition",
            entityId: id,
            ipAddress: actor.ipAddress,
            before: { status: before.status, registrationsClosedReason: before.registrationsClosedReason, totalSwimmers: inscritos },
            after: actualizada,
          },
          { tx }
        );

        return actualizada;
      },
      { isolationLevel: "Serializable" }
    )
  );
}

/**
 * Sección 10: "Duplicar una competencia como base para una nueva". Copia
 * la estructura completa (fechas, jornadas, límites, pruebas asignadas y
 * sus categorías habilitadas) hacia una nueva competencia en estado
 * `draft`, con nombre y período de inscripción provistos por el usuario.
 */
export async function duplicateCompetition(sourceId: string, input: DuplicateCompetitionInput, actor: ActorContext) {
  const source = await prisma.competition.findUnique({
    where: { id: sourceId },
    include: {
      dates: { include: { sessions: { include: { limit: true } } } },
      competitionEvents: { include: { enabledCategories: true } },
    },
  });
  if (!source) throw new NotFoundError("Competencia");

  const newCompetition = await prisma.$transaction(async (tx) => {
    const created = await tx.competition.create({
      data: {
        name: input.name,
        description: source.description,
        status: "draft",
        registrationStartAt: input.registrationStartAt,
        registrationEndAt: input.registrationEndAt,
        ageCutoffDate: input.ageCutoffDate ?? source.ageCutoffDate,
        maxIndividualEventsPerSwimmer: input.maxIndividualEventsPerSwimmer ?? source.maxIndividualEventsPerSwimmer,
        maxRelayEventsPerSwimmerPerSession: input.maxRelayEventsPerSwimmerPerSession ?? source.maxRelayEventsPerSwimmerPerSession,
        // Los cupos se heredan de la competencia original: duplicar es
        // "otra edición de lo mismo", y el cupo forma parte de esa
        // configuración. La copia nace en Borrador y sin inscripciones, así
        // que arranca con el cupo íntegro disponible.
        maxSwimmers: source.maxSwimmers,
        maxSwimmersPerClub: source.maxSwimmersPerClub,
        poolId: input.poolId !== undefined ? input.poolId : source.poolId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
    });

    // date.id (viejo) -> sessionType.id -> newSession.id, para remapear competitionEvents luego.
    const sessionIdMap = new Map<string, string>(); // oldSessionId -> newSessionId

    for (const oldDate of source.dates) {
      const newDate = await tx.competitionDate.create({ data: { competitionId: created.id, date: oldDate.date } });

      for (const oldSession of oldDate.sessions) {
        const newSession = await tx.competitionSession.create({
          // `competitionId` es la columna derivada que permite garantizar en
          // base de datos que las pruebas se asocien a jornadas de su propia
          // competencia — aquí es la competencia NUEVA, no la de origen.
          data: { competitionDateId: newDate.id, sessionTypeId: oldSession.sessionTypeId, competitionId: created.id },
        });
        sessionIdMap.set(oldSession.id, newSession.id);

        if (oldSession.limit) {
          await tx.sessionLimit.create({
            data: {
              competitionSessionId: newSession.id,
              maxIndividualEvents: oldSession.limit.maxIndividualEvents,
              maxRelayEvents: oldSession.limit.maxRelayEvents,
            },
          });
        }
      }
    }

    for (const oldCe of source.competitionEvents) {
      const newSessionId = sessionIdMap.get(oldCe.competitionSessionId);
      if (!newSessionId) continue; // seguridad; no debería ocurrir si el mapeo es consistente

      const newCe = await tx.competitionEvent.create({
        data: {
          competitionId: created.id,
          eventId: oldCe.eventId,
          competitionSessionId: newSessionId,
          status: oldCe.status,
          displayOrder: oldCe.displayOrder,
        },
      });

      if (oldCe.enabledCategories.length > 0) {
        await tx.competitionEventCategory.createMany({
          data: oldCe.enabledCategories.map((ec) => ({ competitionEventId: newCe.id, categoryId: ec.categoryId })),
        });
      }
    }

    // La auditoría va DENTRO de la transacción que duplica: si no se puede
    // registrar quién duplicó qué, la copia tampoco debe quedar.
    await audit(
      {
        userId: actor.userId,
        action: "COMPETITION_DUPLICATED",
        entityType: "Competition",
        entityId: created.id,
        ipAddress: actor.ipAddress,
        after: { sourceId, newCompetitionId: created.id },
      },
      { tx }
    );

    return created;
  });

  return getCompetitionById(newCompetition.id);
}

/**
 * Elimina una competencia por completo, junto con su estructura interna
 * (fechas, jornadas, límites, pruebas asignadas — todas con `onDelete:
 * Cascade` en el schema). Se BLOQUEA si ya existen inscripciones
 * (individuales o de relevo) confirmadas o canceladas — borrar esos
 * registros destruiría el historial/auditoría de inscripciones reales;
 * en ese caso corresponde `Cancelar` la competencia, no eliminarla.
 */
export async function deleteCompetition(id: string, actor: ActorContext) {
  const before = await getCompetitionById(id);

  // A pedido explícito: eliminar una competencia ahora borra también, en
  // cascada, TODAS sus inscripciones (individuales y de relevo) — antes
  // esto estaba bloqueado si ya había inscripciones (había que cancelarlas
  // primero). Se deja registro en la auditoría de cuántas se destruyeron,
  // ya que esta acción es irreversible.
  const [individualCount, relayCount] = await Promise.all([
    prisma.registration.count({ where: { competitionEvent: { competitionId: id } } }),
    prisma.relayRegistration.count({ where: { competitionEvent: { competitionId: id } } }),
  ]);

  await withAudit(
    (tx) => tx.competition.delete({ where: { id } }),
    () => ({
      userId: actor.userId,
      action: "COMPETITION_DELETED",
      entityType: "Competition",
      entityId: id,
      ipAddress: actor.ipAddress,
      before: { ...before, deletedIndividualRegistrations: individualCount, deletedRelayRegistrations: relayCount },
    })
  );
}
