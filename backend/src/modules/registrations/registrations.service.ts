import { prisma } from "../../shared/prisma.client";
import { audit, withAudit } from "../audit/audit.service";
import { ValidationError, NotFoundError, ForbiddenError } from "../../shared/errors";
import { assertClubAccess, resolveClubFilter, scopedPersonId, type ActorContext as SharedActorContext } from "../../shared/actorContext";
import { computeAge, getDefaultAgeCutoffDate } from "../../shared/age.util";
import { computeEffectiveStatus, isRegistrationOpen, evaluateRegistrationWindow } from "../competitions/competitions.rules";
import { evaluateCapacity } from "../competitions/competition-capacity.rules";
import {
  readCapacityUsage,
  contarNuevos,
  resumirUso,
  cerrarSiSeAlcanzoElCupo,
  registrarExcesoDeCupo,
} from "../competitions/competition-capacity.service";
import { evaluarCancelacionDeIndividual } from "../relay-registrations/relay-membership.rules";
import { assertTestTypeMatches } from "../../shared/testType.util";
import { withTranslatedPrismaErrors } from "../../shared/prismaErrors";
import { activeCategories, assertCompetitionEventCatalogUsable } from "../../shared/catalogAvailability";
import { validateIndividualRegistration, resolveCategoryForAge } from "./registrations.rules";
import type { CreateRegistrationInput, RegistrationListQuery, EligibleSwimmersQuery } from "./registrations.schemas";

/**
 * El contexto del actor ya no se define aquí: viene de `shared/actorContext`,
 * que es la única fuente de verdad del alcance (admin / club / nadador). Antes
 * cada módulo lo declaraba a su manera y comparaba con
 * `actor.actorClubId && actor.actorClubId !== input.clubId`, condición que NO
 * comprobaba nada cuando el club no se podía resolver.
 */
type ActorContext = SharedActorContext;

/**
 * Verifica que el actor pueda ver/operar sobre los datos de esta persona.
 * Es lo que impide que un club consulte el RUN, la fecha de nacimiento o la
 * elegibilidad de nadadores de otro club.
 */
async function assertPersonWithinScope(actor: ActorContext, personId: string): Promise<void> {
  switch (actor.scope.kind) {
    case "admin":
      return;
    case "swimmer":
      if (actor.scope.personId !== personId) {
        throw new ForbiddenError("Solo puede consultar y operar sobre su propia información.");
      }
      return;
    case "club": {
      const membership = await prisma.clubSwimmer.findFirst({
        where: { clubId: actor.scope.clubId, personId, status: "active" },
        select: { id: true },
      });
      if (!membership) {
        throw new ForbiddenError("Ese nadador no pertenece al plantel activo de su club.");
      }
      return;
    }
  }
}

// --------------------------------------------------------------------------
// Paso 3: mostrar solamente las pruebas habilitadas para la competencia.
// --------------------------------------------------------------------------

export async function listEnabledCompetitionEvents(competitionId: string) {
  return prisma.competitionEvent.findMany({
    where: { competitionId, status: "enabled", event: { deletedAt: null } },
    include: {
      event: { include: { testType: true, distance: true, stroke: true } },
      competitionSession: { include: { sessionType: true, competitionDate: true } },
      enabledCategories: { include: { category: true } },
    },
    orderBy: [{ displayOrder: "asc" }],
  });
}

/**
 * Nadadores activos de un club (sin filtrar todavía por ninguna prueba
 * específica) — es el paso 3 del nuevo orden de inscripción (competencia
 * -> club -> nadador -> pruebas disponibles).
 */
/**
 * Plantel activo de un club. El alcance sale del actor, no del `clubId`
 * recibido: un usuario de club solo puede pedir el suyo (se rechaza si pide
 * otro) y un nadador solo se ve a sí mismo.
 */
export async function listActiveSwimmersOfClub(clubId: string, actor: ActorContext) {
  // Un usuario de club solo puede pedir el plantel del suyo. Un nadador sí
  // puede consultar "su" club, pero el filtro por `personId` de abajo hace
  // que solo se vea a sí mismo, así que no necesita (ni debe) pasar por la
  // comprobación de alcance de club.
  if (actor.scope.kind === "club") assertClubAccess(actor, clubId);
  const restrictToPersonId = scopedPersonId(actor);

  const activeMembers = await prisma.clubSwimmer.findMany({
    where: { clubId, status: "active", ...(restrictToPersonId ? { personId: restrictToPersonId } : {}) },
    include: { person: { include: { roles: true } } },
  });

  return activeMembers
    .map((m) => m.person)
    .filter((p) => p.status === "active" && p.deletedAt === null)
    .filter((p) => p.roles.some((r) => r.roleType === "swimmer" && r.active))
    .map((p) => ({ id: p.id, fullName: p.fullName, run: p.run, gender: p.gender, birthDate: p.birthDate }));
}

export interface AvailableIndividualEvent {
  competitionEventId: string;
  distanceMeters: number;
  strokeName: string;
  sessionTypeName: string;
  competitionDate: Date;
  categoryId: string;
  categoryName: string;
}

/**
 * Paso 4 del nuevo orden de inscripción: una vez elegido el nadador, se
 * listan TODAS las pruebas individuales disponibles para él en esa
 * competencia — la categoría YA NO se elige a mano, se calcula sola
 * (edad del nadador según la fecha de corte de la competencia, contra
 * las categorías habilitadas para cada prueba). Una prueba solo aparece
 * si: es de tipo Individual, el género calza, existe EXACTAMENTE una
 * categoría habilitada que cubre la edad calculada, y el nadador no está
 * ya inscrito en ella.
 */
export async function listAvailableIndividualEvents(competitionId: string, personId: string, actor: ActorContext): Promise<AvailableIndividualEvent[]> {
  // Sin esta comprobación, cualquier usuario con `registrations:read` podía
  // pedir la elegibilidad de CUALQUIER nadador del sistema pasando su id.
  await assertPersonWithinScope(actor, personId);

  const competition = await prisma.competition.findUnique({ where: { id: competitionId } });
  if (!competition) throw new NotFoundError("Competencia");

  const person = await prisma.person.findFirst({ where: { id: personId, deletedAt: null } });
  if (!person) throw new NotFoundError("Nadador");

  const ageCutoffDate = competition.ageCutoffDate ?? getDefaultAgeCutoffDate();

  const competitionEvents = await prisma.competitionEvent.findMany({
    where: { competitionId, status: "enabled", event: { testType: { swimmersCount: 1 }, deletedAt: null } },
    include: {
      event: { include: { distance: true, stroke: true } },
      competitionSession: { include: { sessionType: true, competitionDate: true } },
      enabledCategories: { include: { category: true } },
    },
    orderBy: [{ displayOrder: "asc" }],
  });

  const alreadyRegistered = await prisma.registration.findMany({
    where: { personId, status: "confirmed", competitionEvent: { competitionId } },
    select: { competitionEventId: true },
  });
  const alreadyRegisteredEventIds = new Set(alreadyRegistered.map((r) => r.competitionEventId));

  const available: AvailableIndividualEvent[] = [];

  for (const ce of competitionEvents) {
    if (alreadyRegisteredEventIds.has(ce.id)) continue;
    if (ce.event.gender !== "mixed" && ce.event.gender !== person.gender) continue;

    // Solo categorías VIGENTES: una categoría eliminada del catálogo no debe
    // seguir ofreciendo pruebas como disponibles (hallazgo 13, reapertura).
    const candidates = activeCategories(ce.enabledCategories.map((ec) => ec.category));
    const resolution = resolveCategoryForAge(person.birthDate, ageCutoffDate, candidates);
    if (resolution.outcome !== "resolved") continue; // "none" o "ambiguous": no se ofrece como disponible

    available.push({
      competitionEventId: ce.id,
      distanceMeters: ce.event.distance.meters,
      strokeName: ce.event.stroke.name,
      sessionTypeName: ce.competitionSession.sessionType.name,
      competitionDate: ce.competitionSession.competitionDate.date,
      categoryId: resolution.category.id,
      categoryName: resolution.category.name,
    });
  }

  return available;
}

export interface ClubEligibilityEntry {
  personId: string;
  fullName: string;
  run: string;
  gender: "male" | "female";
  eligibleEvents: { competitionEventId: string; categoryId: string; categoryName: string }[];
  registeredEventIds: string[];
}

/**
 * Igual que `listAvailableIndividualEvents`, pero para TODO el plantel
 * activo de un club a la vez — evita tener que pedir la elegibilidad
 * nadador por nadador (sección "Panel de Inscripción" / arrastrar y
 * soltar). Devuelve, por cada nadador, las pruebas donde es elegible
 * (con su categoría ya resuelta) y en cuáles ya está inscrito.
 * `restrictToPersonId`: si se entrega, la elegibilidad calculada solo
 * incluye a ESE nadador — usado para que un nadador "puro" solo vea su
 * propia información en el Panel de Inscripción.
 */
export async function listClubEligibilityMatrix(competitionId: string, clubId: string, actor: ActorContext): Promise<ClubEligibilityEntry[]> {
  if (actor.scope.kind === "club") assertClubAccess(actor, clubId);
  const restrictToPersonId = scopedPersonId(actor);

  const competition = await prisma.competition.findUnique({ where: { id: competitionId } });
  if (!competition) throw new NotFoundError("Competencia");

  const ageCutoffDate = competition.ageCutoffDate ?? getDefaultAgeCutoffDate();

  const competitionEvents = await prisma.competitionEvent.findMany({
    where: { competitionId, status: "enabled", event: { testType: { swimmersCount: 1 }, deletedAt: null } },
    include: { event: true, enabledCategories: { include: { category: true } } },
    orderBy: [{ displayOrder: "asc" }],
  });

  const activeMembers = await prisma.clubSwimmer.findMany({
    where: { clubId, status: "active", ...(restrictToPersonId ? { personId: restrictToPersonId } : {}) },
    include: { person: { include: { roles: true } } },
  });
  const swimmers = activeMembers
    .map((m) => m.person)
    .filter((p) => p.status === "active" && p.deletedAt === null)
    .filter((p) => p.roles.some((r) => r.roleType === "swimmer" && r.active));

  const registrations = await prisma.registration.findMany({
    where: { status: "confirmed", clubId, competitionEvent: { competitionId } },
    select: { personId: true, competitionEventId: true },
  });
  const registeredByPerson = new Map<string, Set<string>>();
  for (const r of registrations) {
    if (!registeredByPerson.has(r.personId)) registeredByPerson.set(r.personId, new Set());
    registeredByPerson.get(r.personId)!.add(r.competitionEventId);
  }

  return swimmers.map((person) => {
    const registeredEventIds = Array.from(registeredByPerson.get(person.id) ?? []);
    const eligibleEvents: ClubEligibilityEntry["eligibleEvents"] = [];

    for (const ce of competitionEvents) {
      if (registeredByPerson.get(person.id)?.has(ce.id)) continue;
      if (ce.event.gender !== "mixed" && ce.event.gender !== person.gender) continue;
      const resolution = resolveCategoryForAge(person.birthDate, ageCutoffDate, activeCategories(ce.enabledCategories.map((ec) => ec.category)));
      if (resolution.outcome !== "resolved") continue;
      eligibleEvents.push({ competitionEventId: ce.id, categoryId: resolution.category.id, categoryName: resolution.category.name });
    }

    return {
      personId: person.id,
      fullName: person.fullName,
      run: person.run,
      gender: person.gender as "male" | "female",
      eligibleEvents,
      registeredEventIds,
    };
  });
}

// --------------------------------------------------------------------------
// Paso 6 (uso previo, se mantiene disponible para otros flujos): mostrar
// nadadores elegibles para UNA prueba+categoría específica ya conocida.
// --------------------------------------------------------------------------

export async function listEligibleSwimmers(query: EligibleSwimmersQuery, actor: ActorContext) {
  if (actor.scope.kind === "club") assertClubAccess(actor, query.clubId);

  const competitionEvent = await prisma.competitionEvent.findUnique({
    where: { id: query.competitionEventId },
    include: { event: { include: { distance: true, stroke: true } }, enabledCategories: { include: { category: true } }, competition: true },
  });
  if (!competitionEvent) throw new NotFoundError("Prueba de competencia");

  /**
   * Este endpoint alimenta el paso "nadadores elegibles" del asistente y no
   * comprobaba nada del estado de la prueba: devolvía candidatos —con RUN y
   * fecha de nacimiento— para pruebas DESHABILITADAS, para pruebas maestras
   * eliminadas del catálogo y para categorías retiradas. Quien los siguiera
   * hasta el final chocaba recién al confirmar, y mientras tanto el listado
   * exponía datos personales para una prueba en la que nadie puede inscribir.
   */
  if (competitionEvent.status !== "enabled") {
    throw new ValidationError("Esta prueba está deshabilitada en la competencia y no admite inscripciones.");
  }
  assertCompetitionEventCatalogUsable({
    eventDeletedAt: competitionEvent.event.deletedAt,
    eventLabel: `${competitionEvent.event.distance.meters} ${competitionEvent.event.stroke.name}`,
    enabledCategories: competitionEvent.enabledCategories.map((ec) => ec.category),
  });

  const ageCutoffDate = competitionEvent.competition.ageCutoffDate ?? getDefaultAgeCutoffDate();

  const categoryEnabled = competitionEvent.enabledCategories.some((ec) => ec.categoryId === query.categoryId);
  if (!categoryEnabled) throw new ValidationError("La categoría seleccionada no está habilitada para esta prueba");

  // `findFirst` con `deletedAt: null`: una categoría retirada del catálogo no
  // puede seguir usándose para armar inscripciones nuevas (hallazgo 13).
  const category = await prisma.category.findFirst({ where: { id: query.categoryId, deletedAt: null } });
  if (!category) {
    throw new ValidationError("La categoría seleccionada fue eliminada del catálogo y ya no admite inscripciones nuevas.");
  }

  const restrictToPersonId = scopedPersonId(actor);
  const activeMembers = await prisma.clubSwimmer.findMany({
    where: { clubId: query.clubId, status: "active", ...(restrictToPersonId ? { personId: restrictToPersonId } : {}) },
    // `deletedAt: null`: una persona eliminada lógicamente conserva su
    // membresía histórica y seguía apareciendo como candidata.
    include: { person: { include: { roles: true } } },
  });

  const alreadyRegistered = await prisma.registration.findMany({
    where: { competitionEventId: query.competitionEventId, status: "confirmed" },
    select: { personId: true },
  });
  const alreadyRegisteredIds = new Set(alreadyRegistered.map((r) => r.personId));

  const eligible = activeMembers
    .map((m) => m.person)
    .filter((p) => p.status === "active" && p.deletedAt === null)
    .filter((p) => p.roles.some((r) => r.roleType === "swimmer" && r.active))
    .filter((p) => competitionEvent.event.gender === "mixed" || competitionEvent.event.gender === p.gender)
    .filter((p) => {
      const age = computeAge(p.birthDate, ageCutoffDate);
      return age >= category.minAge && age <= category.maxAge;
    })
    .filter((p) => !alreadyRegisteredIds.has(p.id));

  return eligible.map((p) => ({ id: p.id, fullName: p.fullName, run: p.run, gender: p.gender, birthDate: p.birthDate }));
}

// --------------------------------------------------------------------------
// Confirmar inscripción — la categoría se RESUELVE automáticamente aquí
// (ya no llega como parámetro del usuario) y luego se delega en la
// función pura de validación (registrations.rules.ts) como respaldo.
// --------------------------------------------------------------------------

export async function createRegistration(input: CreateRegistrationInput, actor: ActorContext) {
  const competitionEvent = await prisma.competitionEvent.findUnique({
    where: { id: input.competitionEventId },
    include: {
      competition: true,
      event: { include: { testType: true, distance: true, stroke: true } },
      competitionSession: { include: { limit: true } },
      enabledCategories: { include: { category: true } },
    },
  });
  if (!competitionEvent) throw new NotFoundError("Prueba de competencia");

  const club = await prisma.club.findUnique({ where: { id: input.clubId } });
  if (!club) throw new NotFoundError("Club");

  // Alcance: un usuario de club solo inscribe en representación del suyo, y
  // un nadador solo se inscribe a sí mismo. `assertClubAccess` rechaza además
  // el caso que antes pasaba de largo: actor no administrador cuyo club no se
  // pudo resolver.
  if (actor.scope.kind === "swimmer") {
    if (actor.scope.personId !== input.personId) {
      throw new ForbiddenError("Solo puede inscribirse a usted mismo en pruebas individuales");
    }
  } else {
    assertClubAccess(actor, input.clubId);
  }

  const person = await prisma.person.findFirst({ where: { id: input.personId, deletedAt: null }, include: { roles: true } });
  if (!person) throw new NotFoundError("Nadador");

  // Hallazgo 8: el tipo de prueba debe ser individual. Sin esto, una llamada
  // directa a la API podía inscribir a UN nadador en una prueba de RELEVO
  // (que exige un equipo de 4), dejando un relevo con un solo integrante
  // registrado como inscripción individual.
  //
  // Va ANTES de resolver la categoría: en una prueba de relevo, la categoría
  // se calcula por la edad COMBINADA del equipo, así que la resolución
  // fallaría primero con un "no hay categoría para la edad del nadador" que
  // no explica el problema real.
  assertTestTypeMatches(competitionEvent.event.testType, 1, "individual");

  // Hallazgo 13 (reapertura): ni la prueba maestra ni la categoría pueden
  // estar eliminadas del catálogo para admitir una inscripción NUEVA.
  assertCompetitionEventCatalogUsable({
    eventDeletedAt: competitionEvent.event.deletedAt,
    eventLabel: `${competitionEvent.event.distance.meters} ${competitionEvent.event.stroke.name}`,
    enabledCategories: competitionEvent.enabledCategories.map((ec) => ec.category),
  });

  const ageCutoffDate = competitionEvent.competition.ageCutoffDate ?? getDefaultAgeCutoffDate();
  const resolution = resolveCategoryForAge(
    person.birthDate,
    ageCutoffDate,
    activeCategories(competitionEvent.enabledCategories.map((ec) => ec.category))
  );
  if (resolution.outcome === "none") {
    throw new ValidationError(
      `No hay ninguna categoría configurada para la edad del nadador (${resolution.age} años) en esta prueba. Revise las categorías habilitadas para esta prueba en la competencia.`
    );
  }
  if (resolution.outcome === "ambiguous") {
    throw new ValidationError(
      `Hay más de una categoría configurada que coincide con la edad del nadador (${resolution.age} años) en esta prueba: ` +
        `${resolution.candidates.map((c) => c.name).join(", ")}. Corrija los rangos de edad superpuestos en Catálogo antes de continuar.`
    );
  }
  const category = resolution.category;

  const membership = await prisma.clubSwimmer.findFirst({ where: { clubId: input.clubId, personId: input.personId, status: "active" } });

  const effectiveCompetitionStatus = computeEffectiveStatus(
    competitionEvent.competition.status,
    competitionEvent.competition.registrationStartAt,
    competitionEvent.competition.registrationEndAt,
    new Date()
  );

  // Hallazgo 10: qué estados admiten la operación, en vez de "abierta o
  // tengo permiso post-cierre".
  const window = evaluateRegistrationWindow(effectiveCompetitionStatus, "create", actor.canRegisterPostClose);
  if (!window.allowed) throw new ValidationError(window.reason!);
  const competitionIsOpen = isRegistrationOpen(effectiveCompetitionStatus);
  const isPostCloseException = window.isPostCloseException;

  /**
   * Hallazgo 9 — contar y luego crear no es atómico.
   *
   * Los límites por jornada y por competencia son reglas AGREGADAS: dependen
   * de cuántas filas hay, no de una fila concreta, así que ningún índice
   * único puede expresarlas. Con dos solicitudes simultáneas del mismo
   * nadador, ambas contaban 2 de 3 pruebas usadas y ambas insertaban: 4
   * inscripciones con el límite en 3.
   *
   * Se resuelve ejecutando el conteo y la inserción dentro de una misma
   * transacción SERIALIZABLE: PostgreSQL detecta que las dos transacciones
   * leyeron y escribieron el mismo conjunto y aborta una con un conflicto de
   * serialización, que se traduce a un 409 reintentable.
   *
   * El duplicado exacto (mismo nadador, misma prueba) sí tiene índice único
   * parcial y lo ataja la base con un P2002, también traducido a 409.
   */
  const registration = await withTranslatedPrismaErrors(() =>
    prisma.$transaction(
      async (tx) => {
        const alreadyRegistered = await tx.registration.findFirst({
          where: { competitionEventId: input.competitionEventId, personId: input.personId, status: "confirmed" },
        });

        const currentIndividualCountInSession = await tx.registration.count({
          where: {
            personId: input.personId,
            status: "confirmed",
            competitionEvent: { competitionSessionId: competitionEvent.competitionSessionId },
          },
        });

        // RB-10 a nivel de competencia completa (no solo la fecha+jornada actual).
        const currentIndividualCountInCompetition = await tx.registration.count({
          where: {
            personId: input.personId,
            status: "confirmed",
            competitionEvent: { competitionId: competitionEvent.competitionId },
          },
        });

        const result = validateIndividualRegistration({
          competitionIsOpen,
          isPostCloseException,
          clubIsActive: club.status === "active",
          swimmerIsActive: person.status === "active",
          swimmerBelongsToClub: Boolean(membership),
          swimmerBirthDate: person.birthDate,
          swimmerGender: person.gender as "male" | "female",
          categoryCutoffDate: ageCutoffDate,
          categoryMinAge: category.minAge,
          categoryMaxAge: category.maxAge,
          categoryEnabledForCompetitionEvent: true, // ya se resolvió DESDE las habilitadas, siempre cumple
          eventGender: competitionEvent.event.gender,
          competitionEventIsEnabled: competitionEvent.status === "enabled",
          alreadyRegisteredForThisEvent: Boolean(alreadyRegistered),
          currentIndividualCountInSession,
          maxIndividualEventsInSession: competitionEvent.competitionSession.limit?.maxIndividualEvents ?? null,
          currentIndividualCountInCompetition,
          maxIndividualEventsInCompetition: competitionEvent.competition.maxIndividualEventsPerSwimmer ?? null,
        });

        if (!result.valid) {
          throw new ValidationError(result.errors.join(" "), { errors: result.errors });
        }

        /**
         * CUPOS DE NADADORES (global y por club).
         *
         * Va después de las reglas por nadador y dentro de la misma
         * transacción serializable, por el mismo motivo que aquéllas: es una
         * regla agregada y contar fuera de la transacción dejaría pasar dos
         * altas simultáneas sobre el último cupo.
         *
         * Un nadador que YA está inscrito no consume cupo, así que esta
         * comprobación no le impide añadir otra prueba aunque la competencia
         * esté llena.
         */
        const uso = await readCapacityUsage(tx, competitionEvent.competitionId);
        const nuevos = contarNuevos(uso, input.clubId, [input.personId]);
        const capacidad = evaluateCapacity(
          {
            maxSwimmers: competitionEvent.competition.maxSwimmers,
            maxSwimmersPerClub: competitionEvent.competition.maxSwimmersPerClub,
          },
          resumirUso(uso, input.clubId),
          { ...nuevos, clubName: club.name },
          // Solo un administrador con permiso de excepción puede exceder.
          { puedeExcederCupos: actor.canRegisterPostClose }
        );
        /**
         * LA EXCEPCIÓN ADMINISTRATIVA SOBRE EL CUPO, y su rastro.
         *
         * `evaluateCapacity` decide si el alta cabe. Un administrador con
         * permiso post-cierre puede pasar por encima, y cuando eso ocurre
         * queda constancia con una acción de auditoría PROPIA —distinta de la
         * excepción por cierre— porque son dos permisos excepcionales
         * diferentes: «operé con las inscripciones cerradas» y «metí un
         * nadador más de los que caben». Pueden darse a la vez, y quien
         * revise después tiene que poder contarlos por separado.
         */
        const maxSwimmers = competitionEvent.competition.maxSwimmers;
        const excedeElCupo = capacidad.exceededByOverride && maxSwimmers !== null;

        if (!capacidad.allowed) throw new ValidationError(capacidad.reason!);

        const creada = await tx.registration.create({
          data: {
            competitionEventId: input.competitionEventId,
            personId: input.personId,
            clubId: input.clubId,
            categoryId: category.id,
            status: "confirmed",
            registeredByUserId: actor.userId,
            isPostCloseException,
            seedTimeCentiseconds: input.seedTimeCentiseconds ?? null,
          },
        });

        // La auditoría entra en la MISMA transacción serializable: una
        // inscripción sin rastro de quién la hizo —y de si fue excepción
        // post-cierre— no puede quedar en la base.
        await audit(
          {
            userId: actor.userId,
            action: isPostCloseException ? "REGISTRATION_CREATED_POST_CLOSE_EXCEPTION" : "REGISTRATION_CREATED",
            entityType: "Registration",
            entityId: creada.id,
            ipAddress: actor.ipAddress,
            after: creada,
          },
          { tx }
        );

        if (excedeElCupo) {
          await registrarExcesoDeCupo(
            tx,
            {
              competitionId: competitionEvent.competitionId,
              entityType: "Registration",
              entityId: creada.id,
              maxSwimmers: maxSwimmers!,
              totalSwimmersAntes: capacidad.projectedTotal - nuevos.newToCompetition,
              totalSwimmersDespues: capacidad.projectedTotal,
              nuevosNadadores: nuevos.newToCompetition,
            },
            actor
          );
        }

        // Cierre automático al alcanzar el cupo global: atómico con el alta
        // que lo provoca, para que nunca exista una competencia llena que
        // todavía figure abierta. Si ya está en cierre parcial o total, no
        // hace nada: un alta administrativa por encima del cupo no vuelve a
        // "cerrar" lo cerrado ni reescribe la marca de tiempo.
        await cerrarSiSeAlcanzoElCupo(tx, competitionEvent.competitionId, capacidad.projectedTotal, actor);

        return creada;
      },
      { isolationLevel: "Serializable" }
    )
  );

  return registration;
}

/**
 * `restrictToPersonId`: si se entrega, solo devuelve inscripciones de ESE
 * nadador — usado para que un nadador "puro" (sin rol delegado/entrenador)
 * solo vea sus propias inscripciones individuales, nunca las de otros.
 */
export async function listRegistrations(query: RegistrationListQuery, actor: ActorContext) {
  const where: any = {};
  if (query.competitionEventId) where.competitionEventId = query.competitionEventId;
  if (query.personId) where.personId = query.personId;
  if (query.status) where.status = query.status;
  if (query.competitionId) where.competitionEvent = { competitionId: query.competitionId };

  // El club del filtro lo decide el alcance del actor, no la query: un
  // usuario de club que no envía `clubId` obtiene SU club (antes obtenía
  // todas las inscripciones del sistema), y si envía otro se rechaza.
  const clubFilter = resolveClubFilter(actor, query.clubId ?? null);
  if (clubFilter) where.clubId = clubFilter;

  const restrictToPersonId = scopedPersonId(actor);
  if (restrictToPersonId) where.personId = restrictToPersonId;

  const [items, total] = await Promise.all([
    prisma.registration.findMany({
      where,
      include: {
        person: { select: { id: true, fullName: true, firstName: true, paternalLastName: true, run: true } },
        club: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        competitionEvent: { include: { competition: { select: { id: true, name: true, status: true, registrationStartAt: true, registrationEndAt: true } }, event: { include: { distance: true, stroke: true, testType: true } }, competitionSession: { include: { sessionType: true, competitionDate: true } } } },
      },
      // Una inscripción masiva crea muchas filas con el mismo `createdAt`.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.registration.count({ where }),
  ]);

  const now = new Date();
  const itemsWithStatus = items.map((item) => ({
    ...item,
    competitionEvent: {
      ...item.competitionEvent,
      competition: {
        ...item.competitionEvent.competition,
        isRegistrationOpen: isRegistrationOpen(
          computeEffectiveStatus(
            item.competitionEvent.competition.status,
            item.competitionEvent.competition.registrationStartAt,
            item.competitionEvent.competition.registrationEndAt,
            now
          )
        ),
      },
    },
  }));

  return { items: itemsWithStatus, total, page: query.page, pageSize: query.pageSize };
}

/**
 * Permite modificar el tiempo estimado de una inscripción ya confirmada
 * (ej. corregir un error de tipeo, o agregarlo si no se ingresó al
 * inscribir). Mismo alcance por club que cancelar — no cambia el estado
 * de la inscripción ni revalida las demás reglas de negocio.
 */
export async function updateRegistration(id: string, input: { seedTimeCentiseconds: number | null }, actor: ActorContext) {
  const before = await prisma.registration.findUnique({
    where: { id },
    include: { competitionEvent: { include: { competition: true } } },
  });
  if (!before) throw new NotFoundError("Inscripción");

  if (actor.scope.kind === "swimmer") {
    if (actor.scope.personId !== before.personId) throw new ForbiddenError("Solo puede modificar sus propias inscripciones");
  } else {
    assertClubAccess(actor, before.clubId);
  }
  if (before.status !== "confirmed") {
    throw new ValidationError("Solo se pueden modificar inscripciones confirmadas");
  }

  const effectiveStatus = computeEffectiveStatus(
    before.competitionEvent.competition.status,
    before.competitionEvent.competition.registrationStartAt,
    before.competitionEvent.competition.registrationEndAt,
    new Date()
  );
  const window = evaluateRegistrationWindow(effectiveStatus, "update", actor.canRegisterPostClose);
  if (!window.allowed) throw new ValidationError(window.reason!);

  // Hallazgo 10: la edición posterior al cierre no marcaba la inscripción
  // como excepción, así que en el listado y en la auditoría era
  // indistinguible de una edición hecha con la competencia abierta.
  return withAudit(
    (tx) =>
      tx.registration.update({
        where: { id },
        data: {
          seedTimeCentiseconds: input.seedTimeCentiseconds,
          isPostCloseException: before.isPostCloseException || window.isPostCloseException,
        },
      }),
    (updated) => ({
      userId: actor.userId,
      action: window.isPostCloseException ? "REGISTRATION_UPDATED_POST_CLOSE_EXCEPTION" : "REGISTRATION_UPDATED",
      entityType: "Registration",
      entityId: id,
      ipAddress: actor.ipAddress,
      before,
      after: updated,
    })
  );
}

/**
 * RB-07/RB-08: mientras la competencia esté abierta, el club puede
 * cancelar sus propias inscripciones. Tras el cierre, solo un admin con
 * permiso `registrations:write:post-close` puede hacerlo — y queda
 * marcado como excepción trazable.
 */
export async function cancelRegistration(id: string, actor: ActorContext) {
  const registration = await prisma.registration.findUnique({
    where: { id },
    include: { competitionEvent: { include: { competition: true } } },
  });
  if (!registration) throw new NotFoundError("Inscripción");

  if (actor.scope.kind === "swimmer") {
    if (actor.scope.personId !== registration.personId) throw new ForbiddenError("Solo puede cancelar sus propias inscripciones");
  } else {
    assertClubAccess(actor, registration.clubId);
  }

  // Cancelar dos veces dejaba una segunda entrada de auditoría y pisaba
  // `cancelledAt`/`cancelledByUserId` con datos del segundo intento.
  if (registration.status !== "confirmed") {
    throw new ValidationError("Esta inscripción ya está cancelada.");
  }

  const effectiveStatus = computeEffectiveStatus(
    registration.competitionEvent.competition.status,
    registration.competitionEvent.competition.registrationStartAt,
    registration.competitionEvent.competition.registrationEndAt,
    new Date()
  );
  const window = evaluateRegistrationWindow(effectiveStatus, "cancel", actor.canRegisterPostClose);
  if (!window.allowed) throw new ValidationError(window.reason!);
  const isPostCloseException = window.isPostCloseException;

  const competitionId = registration.competitionEvent.competitionId;

  /**
   * LA INVARIANTE DE RELEVOS SE COMPRUEBA Y SE ESCRIBE EN LA MISMA OPERACIÓN
   * PROTEGIDA.
   *
   * Es una regla agregada —depende de cuántas inscripciones vivas quedan y de
   * qué relevos existen—, así que comprobar fuera y escribir después deja una
   * ventana real: entre la comprobación y el `update`, otro usuario crea un
   * relevo con este nadador y la cancelación se confirma igual, dejando un
   * relevo con un integrante sin inscripción individual.
   *
   * ORDEN DE ACCESO, el mismo que la vía de inscripción:
   *   1. `registrations`          (contar las otras confirmadas)
   *   2. `relay_registrations`    (buscar los relevos dependientes)
   *   3. `registrations` de nuevo (la escritura)
   *
   * Y el ciclo que hace que PostgreSQL aborte una de las dos:
   *   - esta transacción LEE relevos y ESCRIBE inscripciones;
   *   - la creación de relevo LEE inscripciones y ESCRIBE relevos.
   * Con las dos aristas hay ciclo, y `Serializable` detecta el conflicto.
   * `withTranslatedPrismaErrors` lo convierte en un 409 reintentable.
   */
  return withTranslatedPrismaErrors(() =>
    prisma.$transaction(
      async (tx) => {
        // 1. ¿Le queda alguna otra inscripción individual confirmada?
        const otras = await tx.registration.count({
          where: {
            personId: registration.personId,
            status: "confirmed",
            competitionEvent: { competitionId },
            id: { not: id },
          },
        });

        // 2. ¿Integra algún relevo confirmado de esta competencia?
        const relevos = await tx.relayRegistration.findMany({
          where: {
            status: "confirmed",
            competitionEvent: { competitionId },
            members: { some: { personId: registration.personId } },
          },
          include: {
            competitionEvent: { include: { event: { include: { distance: true, stroke: true } } } },
          },
        });

        const veredicto = evaluarCancelacionDeIndividual(
          otras,
          relevos.map((r) => ({
            relayRegistrationId: r.id,
            descripcion: `${r.competitionEvent.event.distance.meters}m ${r.competitionEvent.event.stroke.name}`,
          }))
        );
        if (!veredicto.allowed) throw new ValidationError(veredicto.reason!);

        // 3. Recién ahora se escribe.
        const updated = await tx.registration.update({
          where: { id },
          data: {
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledByUserId: actor.userId,
            isPostCloseException: registration.isPostCloseException || isPostCloseException,
          },
        });

        await audit(
          {
            userId: actor.userId,
            action: isPostCloseException ? "REGISTRATION_CANCELLED_POST_CLOSE_EXCEPTION" : "REGISTRATION_CANCELLED",
            entityType: "Registration",
            entityId: id,
            ipAddress: actor.ipAddress,
            before: registration,
            after: updated,
          },
          { tx }
        );

        return updated;
      },
      { isolationLevel: "Serializable" }
    )
  );
}
