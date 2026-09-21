import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { audit, withAudit } from "../audit/audit.service";
import { ValidationError, NotFoundError } from "../../shared/errors";
import { computeAge, getDefaultAgeCutoffDate } from "../../shared/age.util";
import { computeEffectiveStatus, isRegistrationOpen, evaluateRegistrationWindow } from "../competitions/competitions.rules";
import { requiredRelayMembers } from "../../shared/testType.util";
import { withTranslatedPrismaErrors } from "../../shared/prismaErrors";
import { activeCategories, assertCompetitionEventCatalogUsable } from "../../shared/catalogAvailability";
import { resolveCategoryForComputedAge } from "../registrations/registrations.rules";
import { validateRelayRegistration, type RelayMemberInput } from "./relay-registrations.rules";
import type { CreateRelayRegistrationInput, UpdateRelayRegistrationInput, RelayRegistrationListQuery } from "./relay-registrations.schemas";
import { assertClubAccess, resolveClubFilter, scopedPersonId, type ActorContext as SharedActorContext } from "../../shared/actorContext";

/** Contexto único y compartido — ver `shared/actorContext.ts`. */
type ActorContext = SharedActorContext;

interface PersonLite {
  id: string;
  fullName: string;
  run: string;
  status: string;
  birthDate: Date;
  gender: string;
}

const include = {
  club: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
  competitionEvent: {
    include: {
      competition: { select: { id: true, name: true } },
      event: { include: { distance: true, stroke: true, testType: true } },
      competitionSession: { include: { sessionType: true, competitionDate: true } },
    },
  },
  members: { include: { person: { select: { id: true, fullName: true, run: true } } }, orderBy: { orderPosition: "asc" as const } },
};

/**
 * Núcleo compartido de validación de un equipo de relevo, usado tanto al
 * crear como al editar (cambiar integrantes/orden). `excludeRelayRegistrationId`
 * se entrega solo al editar, para no contar la propia inscripción como
 * "otro relevo" al verificar el máximo de 1 relevo por jornada, ni como
 * "equipo duplicado" del mismo club+prueba+categoría.
 */
/**
 * Límite efectivo de relevos por nadador y jornada (hallazgo 11).
 *
 * - Competencia: `maxRelayEventsPerSwimmerPerSession` (por defecto 1).
 * - Jornada: `SessionLimit.maxRelayEvents`, opcional; solo puede RESTRINGIR.
 *
 * Se toma el menor de los dos para que configurar una jornada nunca amplíe
 * en silencio lo que la competencia definió como tope.
 */
export function resolveEffectiveRelayLimit(competitionLimit: number, sessionLimit: number | null): number {
  if (sessionLimit === null) return competitionLimit;
  return Math.min(competitionLimit, sessionLimit);
}

async function validateAndResolveRelayTeam(params: {
  competitionEventId: string;
  clubId: string;
  personIds: string[];
  actor: ActorContext;
  excludeRelayRegistrationId?: string;
  /** Operación en curso — determina qué estados de competencia la admiten. */
  operation?: "create" | "update";
  /**
   * Cliente transaccional. Cuando se entrega, TODAS las lecturas de esta
   * función ocurren dentro de la transacción del llamador — imprescindible
   * para que el conteo de relevos por nadador y la inserción del equipo sean
   * atómicos bajo aislamiento serializable.
   */
  tx?: Prisma.TransactionClient;
}) {
  const { competitionEventId, clubId, personIds, actor, excludeRelayRegistrationId } = params;
  const db = params.tx ?? prisma;

  const competitionEvent = await db.competitionEvent.findUnique({
    where: { id: competitionEventId },
    include: {
      competition: true,
      event: { include: { testType: true, distance: true, stroke: true } },
      competitionSession: { include: { limit: true } },
      enabledCategories: { include: { category: true } },
    },
  });
  if (!competitionEvent) throw new NotFoundError("Prueba de competencia");

  const club = await db.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError("Club");

  assertClubAccess(actor, clubId);

  // Hallazgo 8: la prueba debe ser de relevo. Una llamada directa a la API
  // podía registrar un "equipo" de 4 en una prueba INDIVIDUAL.
  const requiredMemberCount = requiredRelayMembers(competitionEvent.event.testType);
  if (requiredMemberCount <= 1) {
    throw new ValidationError(
      `La prueba seleccionada es de tipo "${competitionEvent.event.testType.name}" (${requiredMemberCount} nadador por inscripción) y no admite equipos de relevo.`
    );
  }

  const ageCutoffDate = competitionEvent.competition.ageCutoffDate ?? getDefaultAgeCutoffDate();

  const persons = await db.person.findMany({ where: { id: { in: personIds }, deletedAt: null } });
  const personsById = new Map<string, PersonLite>(persons.map((p: PersonLite) => [p.id, p]));

  // Hallazgo 13 (reapertura): catálogos retirados no admiten inscripciones
  // nuevas, aunque la prueba siga asignada a la competencia.
  assertCompetitionEventCatalogUsable({
    eventDeletedAt: competitionEvent.event.deletedAt,
    eventLabel: `${competitionEvent.event.distance.meters} ${competitionEvent.event.stroke.name}`,
    enabledCategories: competitionEvent.enabledCategories.map((ec) => ec.category),
  });

  const combinedAge = persons.reduce((sum, p) => sum + computeAge(p.birthDate, ageCutoffDate), 0);
  const resolution = resolveCategoryForComputedAge(
    combinedAge,
    activeCategories(competitionEvent.enabledCategories.map((ec) => ec.category))
  );
  if (resolution.outcome === "none") {
    throw new ValidationError(
      `No hay ninguna categoría configurada para la edad combinada del equipo (${resolution.age} años entre los 4 nadadores) en esta prueba. Revise las categorías habilitadas para esta prueba en la competencia.`
    );
  }
  if (resolution.outcome === "ambiguous") {
    throw new ValidationError(
      `Hay más de una categoría configurada que coincide con la edad combinada del equipo (${resolution.age} años): ` +
        `${resolution.candidates.map((c) => c.name).join(", ")}. Corrija los rangos de edad superpuestos en Catálogo antes de continuar.`
    );
  }
  const category = resolution.category;

  const memberships = await db.clubSwimmer.findMany({
    where: { clubId, personId: { in: personIds }, status: "active" },
  });
  const activeMembershipIds = new Set(memberships.map((m) => m.personId));

  // Estos conteos son el corazón del límite por nadador: si se hacen fuera
  // de la transacción que inserta el equipo, dos equipos simultáneos que
  // comparten un nadador cuentan ambos "0 relevos" y ambos entran.
  const relayCounts = await Promise.all(
    personIds.map((personId) =>
      db.relayRegistrationMember.count({
        where: {
          personId,
          relayRegistration: {
            status: "confirmed",
            competitionEvent: { competitionSessionId: competitionEvent.competitionSessionId },
            ...(excludeRelayRegistrationId ? { id: { not: excludeRelayRegistrationId } } : {}),
          },
        },
      })
    )
  );

  const duplicateTeam = await db.relayRegistration.findFirst({
    where: {
      competitionEventId,
      clubId,
      categoryId: category.id,
      status: "confirmed",
      ...(excludeRelayRegistrationId ? { id: { not: excludeRelayRegistrationId } } : {}),
    },
  });

  const effectiveCompetitionStatus = computeEffectiveStatus(
    competitionEvent.competition.status,
    competitionEvent.competition.registrationStartAt,
    competitionEvent.competition.registrationEndAt,
    new Date()
  );
  // Hallazgo 10: mismos estados admitidos que en inscripciones individuales
  // (la excepción post-cierre solo aplica a competencias CERRADAS).
  const window = evaluateRegistrationWindow(effectiveCompetitionStatus, params.operation ?? "create", actor.canRegisterPostClose);
  if (!window.allowed) throw new ValidationError(window.reason!);
  const competitionIsOpen = isRegistrationOpen(effectiveCompetitionStatus);
  const isPostCloseException = window.isPostCloseException;

  const members: RelayMemberInput[] = personIds.map((personId, idx) => {
    const person = personsById.get(personId);
    return {
      personId,
      displayName: person ? `${person.fullName} (${person.run})` : `Nadador #${idx + 1} (no encontrado)`,
      swimmerIsActive: person?.status === "active",
      swimmerBelongsToClub: activeMembershipIds.has(personId),
      swimmerGender: (person?.gender as "male" | "female") ?? "female",
      // `relayCounts` se construye con el mismo `personIds.map`, así que el
      // índice siempre existe; el `?? 0` es solo para `noUncheckedIndexedAccess`.
      currentRelayCountInSession: relayCounts[idx] ?? 0,
    };
  });

  const result = validateRelayRegistration({
    competitionIsOpen,
    isPostCloseException,
    clubIsActive: club.status === "active",
    competitionEventIsEnabled: competitionEvent.status === "enabled",
    duplicateTeamForClub: Boolean(duplicateTeam),
    eventGender: competitionEvent.event.gender,
    // Hallazgo 11: el límite efectivo sale de la configuración, no de una
    // constante. Manda el parámetro de la competencia, y la jornada puede
    // restringir más (nunca ampliar): se toma el menor de los dos.
    maxRelayEventsInSession: resolveEffectiveRelayLimit(
      competitionEvent.competition.maxRelayEventsPerSwimmerPerSession,
      competitionEvent.competitionSession.limit?.maxRelayEvents ?? null
    ),
    requiredMemberCount,
    members,
  });

  if (!result.valid) {
    throw new ValidationError(result.errors.join(" "), { errors: result.errors });
  }

  return { category, isPostCloseException, competitionEvent };
}

export async function createRelayRegistration(input: CreateRelayRegistrationInput, actor: ActorContext) {
  /**
   * Hallazgo 9 (relevos) — validación e inserción en la MISMA transacción
   * serializable.
   *
   * El equipo duplicado (mismo club, prueba y categoría) lo ataja un índice
   * único parcial, pero el límite de relevos POR NADADOR es una regla
   * agregada sobre `relay_registration_members` y ningún índice puede
   * expresarla: dos equipos de pruebas distintas que comparten un nadador
   * contaban ambos "0 relevos usados" y ambos se insertaban, dejando a esa
   * persona con dos relevos en una jornada configurada para uno.
   */
  const relayRegistration = await withTranslatedPrismaErrors(() =>
    prisma.$transaction(
      async (tx) => {
        const validation = await validateAndResolveRelayTeam({
          competitionEventId: input.competitionEventId,
          clubId: input.clubId,
          personIds: input.personIds,
          actor,
          tx,
        });

        const creado = await tx.relayRegistration.create({
          data: {
            competitionEventId: input.competitionEventId,
            clubId: input.clubId,
            categoryId: validation.category.id,
            status: "confirmed",
            registeredByUserId: actor.userId,
            isPostCloseException: validation.isPostCloseException,
            seedTimeCentiseconds: input.seedTimeCentiseconds ?? null,
            // El ORDEN del equipo es el orden del arreglo `personIds` — en
            // pruebas de estilo Combinado, la convención es Espalda, Pecho,
            // Mariposa, Libre (posiciones 1 a 4); el frontend es responsable
            // de pedir los nadadores en ese orden para esas pruebas.
            members: { create: input.personIds.map((personId, idx) => ({ personId, orderPosition: idx + 1 })) },
          },
          include,
        });

        await audit(
          {
            userId: actor.userId,
            action: validation.isPostCloseException ? "RELAY_REGISTRATION_CREATED_POST_CLOSE_EXCEPTION" : "RELAY_REGISTRATION_CREATED",
            entityType: "RelayRegistration",
            entityId: creado.id,
            ipAddress: actor.ipAddress,
            after: creado,
          },
          { tx }
        );

        return creado;
      },
      { isolationLevel: "Serializable" }
    )
  );

  return relayRegistration;
}

/**
 * `restrictToPersonId`: si se entrega, solo devuelve relevos donde ese
 * nadador es integrante — usado para que un nadador "puro" (sin rol
 * delegado/entrenador) solo vea los relevos en los que él participa.
 */
export async function listRelayRegistrations(query: RelayRegistrationListQuery, actor: ActorContext) {
  const where: any = {};
  if (query.competitionEventId) where.competitionEventId = query.competitionEventId;
  if (query.status) where.status = query.status;
  if (query.competitionId) where.competitionEvent = { competitionId: query.competitionId };

  // Mismo criterio que en inscripciones individuales: el club efectivo lo
  // decide el alcance del actor, no la query.
  const clubFilter = resolveClubFilter(actor, query.clubId ?? null);
  if (clubFilter) where.clubId = clubFilter;

  const restrictToPersonId = scopedPersonId(actor);
  if (restrictToPersonId) where.members = { some: { personId: restrictToPersonId } };

  const [items, total] = await Promise.all([
    prisma.relayRegistration.findMany({
      where,
      include,
      // Varios relevos de un mismo club se crean en el mismo instante.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.relayRegistration.count({ where }),
  ]);

  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * Permite corregir el tiempo estimado del equipo y/o cambiar sus
 * integrantes y el ORDEN en que nadan (relevante sobre todo en pruebas
 * Combinado: Espalda, Pecho, Mariposa, Libre). Si se entregan nuevos
 * `personIds`, se revalida el equipo completo (composición 2+2 si es
 * mixto, elegibilidad de cada integrante, máximo 1 relevo por jornada,
 * etc.) y se recalcula la categoría por la nueva edad combinada.
 */
export async function updateRelayRegistration(id: string, input: UpdateRelayRegistrationInput, actor: ActorContext) {
  const before = await prisma.relayRegistration.findUnique({ where: { id }, include: { members: true } });
  if (!before) throw new NotFoundError("Inscripción de relevo");

  assertClubAccess(actor, before.clubId);
  if (before.status !== "confirmed") {
    throw new ValidationError("Solo se pueden modificar inscripciones confirmadas");
  }

  if (!input.personIds) {
    // Solo se está corrigiendo el tiempo estimado — sin cambios de equipo.
    //
    // Hallazgo 10: esta rama NO comprobaba el cierre de inscripciones. Se
    // podía editar el tiempo de un equipo con la competencia cerrada,
    // cancelada o ya finalizada, sin permiso de excepción y sin quedar
    // marcada como excepción post-cierre. La rama que cambia integrantes sí
    // validaba (dentro de `validateAndResolveRelayTeam`), así que el mismo
    // endpoint aceptaba o rechazaba según qué campo se enviara.
    const competitionEvent = await prisma.competitionEvent.findUniqueOrThrow({
      where: { id: before.competitionEventId },
      include: { competition: true },
    });
    const effectiveStatus = computeEffectiveStatus(
      competitionEvent.competition.status,
      competitionEvent.competition.registrationStartAt,
      competitionEvent.competition.registrationEndAt,
      new Date()
    );
    const window = evaluateRegistrationWindow(effectiveStatus, "update", actor.canRegisterPostClose);
    if (!window.allowed) throw new ValidationError(window.reason!);

    return withAudit(
      (tx) =>
        tx.relayRegistration.update({
          where: { id },
          data: {
            seedTimeCentiseconds: input.seedTimeCentiseconds,
            isPostCloseException: before.isPostCloseException || window.isPostCloseException,
          },
        }),
      (updated) => ({
        userId: actor.userId,
        action: window.isPostCloseException ? "RELAY_REGISTRATION_UPDATED_POST_CLOSE_EXCEPTION" : "RELAY_REGISTRATION_UPDATED",
        entityType: "RelayRegistration",
        entityId: id,
        ipAddress: actor.ipAddress,
        before,
        after: updated,
      })
    );
  }

  // Igual que al crear: la revalidación del equipo y el reemplazo de
  // integrantes van en una sola transacción serializable, o dos ediciones
  // simultáneas podrían dejar a un nadador por encima del límite.
  const updated = await withTranslatedPrismaErrors(() =>
    prisma.$transaction(
      async (tx) => {
        const { category, isPostCloseException } = await validateAndResolveRelayTeam({
          competitionEventId: before.competitionEventId,
          clubId: before.clubId,
          personIds: input.personIds!,
          actor,
          excludeRelayRegistrationId: id,
          operation: "update",
          tx,
        });

        await tx.relayRegistrationMember.deleteMany({ where: { relayRegistrationId: id } });
        const reemplazado = await tx.relayRegistration.update({
          where: { id },
          data: {
            categoryId: category.id,
            seedTimeCentiseconds: input.seedTimeCentiseconds,
            isPostCloseException: before.isPostCloseException || isPostCloseException,
            members: { create: input.personIds!.map((personId, idx) => ({ personId, orderPosition: idx + 1 })) },
          },
          include,
        });

        await audit(
          { userId: actor.userId, action: "RELAY_REGISTRATION_MEMBERS_UPDATED", entityType: "RelayRegistration", entityId: id, ipAddress: actor.ipAddress, before, after: reemplazado },
          { tx }
        );

        return reemplazado;
      },
      { isolationLevel: "Serializable" }
    )
  );

  return updated;
}

export async function cancelRelayRegistration(id: string, actor: ActorContext) {
  const relayRegistration = await prisma.relayRegistration.findUnique({
    where: { id },
    include: { competitionEvent: { include: { competition: true } } },
  });
  if (!relayRegistration) throw new NotFoundError("Inscripción de relevo");

  assertClubAccess(actor, relayRegistration.clubId);

  // Igual que en individuales: cancelar dos veces pisaba `cancelledAt` y
  // dejaba una segunda entrada de auditoría.
  if (relayRegistration.status !== "confirmed") {
    throw new ValidationError("Este equipo de relevo ya está cancelado.");
  }

  const effectiveStatus = computeEffectiveStatus(
    relayRegistration.competitionEvent.competition.status,
    relayRegistration.competitionEvent.competition.registrationStartAt,
    relayRegistration.competitionEvent.competition.registrationEndAt,
    new Date()
  );
  const window = evaluateRegistrationWindow(effectiveStatus, "cancel", actor.canRegisterPostClose);
  if (!window.allowed) throw new ValidationError(window.reason!);
  const isPostCloseException = window.isPostCloseException;

  return withAudit(
    (tx) =>
      tx.relayRegistration.update({
        where: { id },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledByUserId: actor.userId,
          isPostCloseException: relayRegistration.isPostCloseException || isPostCloseException,
        },
      }),
    (updated) => ({
      userId: actor.userId,
      action: isPostCloseException ? "RELAY_REGISTRATION_CANCELLED_POST_CLOSE_EXCEPTION" : "RELAY_REGISTRATION_CANCELLED",
      entityType: "RelayRegistration",
      entityId: id,
      ipAddress: actor.ipAddress,
      before: relayRegistration,
      after: updated,
    })
  );
}
