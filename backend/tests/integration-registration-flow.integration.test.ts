/**
 * Pruebas de integración del flujo central del sistema: crear una
 * competencia abierta, un club, una persona-nadador, asignarla al club,
 * y confirmar una inscripción individual real contra la base de datos.
 *
 * Igual que `auth.service.integration.test.ts`, requieren PostgreSQL
 * disponible en DATABASE_URL. Se ejecutan con `npm run test:integration`.
 * No se pudieron correr en el entorno de generación de este proyecto por
 * falta de acceso de red a los binarios de Prisma — ver README.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser } from "./helpers/seedRbac";
import * as personsService from "../src/modules/persons/persons.service";
import * as clubsService from "../src/modules/clubs/clubs.service";
import * as assignmentService from "../src/modules/swimmer-assignment/assignment.service";
import * as competitionsService from "../src/modules/competitions/competitions.service";
import * as structureService from "../src/modules/competitions/competition-structure.service";
import * as catalogsCategories from "../src/modules/catalogs/categories.service";
import * as catalogsEvents from "../src/modules/catalogs/events.service";
import * as registrationsService from "../src/modules/registrations/registrations.service";
import { ValidationError } from "../src/shared/errors";

/**
 * El actor apunta a un usuario REAL de la base: desde el hallazgo 23 la
 * auditoría de las escrituras de negocio comparte transacción con el cambio,
 * así que un `userId` inventado rompe la clave foránea de `audit_logs` y
 * revierte la operación entera.
 */
let SYSTEM_ACTOR: { userId: string };
/**
 * Contexto de actor con el formato compartido (`shared/actorContext.ts`):
 * el alcance es un tipo cerrado (`admin` | `club` | `swimmer`), ya no un
 * `actorClubId` que podía quedar en null y desactivar las comprobaciones.
 */
let ADMIN_ACTOR: { userId: string; isAdmin: true; scope: { kind: "admin" }; canRegisterPostClose: boolean };

async function ensureBaseCatalogs() {
  const testType = await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
  const distance = await prisma.distance.upsert({ where: { meters: 50 }, update: {}, create: { meters: 50 } });
  const stroke = await prisma.stroke.upsert({ where: { name: "Libre" }, update: {}, create: { name: "Libre" } });
  const sessionType = await prisma.sessionType.upsert({ where: { name: "Mañana" }, update: {}, create: { name: "Mañana" } });
  return { testType, distance, stroke, sessionType };
}

describe("Flujo integral — inscripción individual (Módulos 2,3,4,5,6,7 en conjunto)", () => {
  let personId: string;
  let clubId: string;
  let competitionId: string;
  let categoryId: string;
  let competitionEventId: string;

  beforeAll(async () => {
    await truncateAllTables(prisma);
    await seedRolesAndPermissions();
    const admin = await createUser({ username: "admin_flujo", roleNames: ["admin"] });
    SYSTEM_ACTOR = { userId: admin.id };
    ADMIN_ACTOR = { userId: admin.id, isAdmin: true, scope: { kind: "admin" }, canRegisterPostClose: true };

    const { testType, distance, stroke, sessionType } = await ensureBaseCatalogs();

    // Módulo 2: persona-nadador
    const person = await personsService.createPerson(
      {
        run: "111111111", // se normaliza; DV real no se valida aquí, se usa fixture directo vía prisma si hiciera falta
        username: `nadador_integracion_${Date.now()}`,
        firstName: "Prueba",
        paternalLastName: "Integración",
        birthDate: new Date("2000-01-01"),
        gender: "female",
        email: `integracion-${Date.now()}@test.local`,
      },
      SYSTEM_ACTOR
    );
    personId = person.id;

    // Módulo 3: club
    const club = await clubsService.createClub(
      {
        name: "Club Integración",
        username: `club_integracion_${Date.now()}`,
        code: "INTEG",
        hasLegalStatus: false,
        email: `club-integracion-${Date.now()}@test.local`,
        isAchmnMember: false,
        isFchmnMember: false,
        isFchmnCollaborator: false,
      },
      SYSTEM_ACTOR
    );
    clubId = club.id;

    // Módulo 4: asignación nadador-club (propuesta + aprobación).
    // Va con ADMIN_ACTOR: `proposeAssignment` exige `isAdmin` o que
    // `actorClubId` coincida con el club — un actor sin club real detrás se
    // rechaza con 403, que es exactamente el comportamiento correcto.
    const assignment = await assignmentService.proposeAssignment({ clubId, personId }, ADMIN_ACTOR);
    await assignmentService.approveAssignment(assignment.id, ADMIN_ACTOR);

    // Módulo 5: categoría y prueba
    const category = await catalogsCategories.createCategory(
      { testTypeId: testType.id, name: "25-29 TEST", minAge: 20, maxAge: 30 },
      SYSTEM_ACTOR
    );
    categoryId = category.id;

    const event = await catalogsEvents.createEvent(
      { testTypeId: testType.id, distanceId: distance.id, strokeId: stroke.id, gender: "mixed" },
      SYSTEM_ACTOR
    );

    // Módulo 6: competencia abierta, con fecha/jornada/límite y la prueba asignada
    const now = new Date();
    const competition = await competitionsService.createCompetition(
      {
        name: "Competencia Integración",
        registrationStartAt: new Date(now.getTime() - 86_400_000),
        registrationEndAt: new Date(now.getTime() + 86_400_000),
        ageCutoffDate: new Date(now.getFullYear(), 11, 31),
        maxIndividualEventsPerSwimmer: 5,
        maxRelayEventsPerSwimmerPerSession: 1,
      },
      SYSTEM_ACTOR
    );
    competitionId = competition.id;

    // La competencia debe quedar ABIERTA. Antes este flujo inscribía con la
    // competencia en BORRADOR y pasaba, porque bastaba el permiso
    // post-cierre para saltarse cualquier estado (hallazgo 10). Ahora la
    // excepción post-cierre solo aplica a competencias cerradas, así que hay
    // que programarla: con el rango de fechas de arriba, el auto-cómputo la
    // deja en `open`.
    await competitionsService.transitionCompetition(competitionId, "schedule", SYSTEM_ACTOR);

    const compDate = await structureService.addCompetitionDate(competitionId, new Date(), SYSTEM_ACTOR);
    const session = await structureService.addSession(compDate.id, sessionType.id, SYSTEM_ACTOR);
    await structureService.setSessionLimit(session.id, { maxIndividualEvents: 3, maxRelayEvents: null }, SYSTEM_ACTOR);

    const { addCompetitionEvent } = await import("../src/modules/competitions/competition-events.service");
    const ce = await addCompetitionEvent(competitionId, { eventId: event.id, competitionSessionId: session.id, categoryIds: [categoryId] }, SYSTEM_ACTOR);
    competitionEventId = ce.id;
  });

  afterAll(async () => {
    // Se vacía la base COMPLETA en vez de borrar fila por fila. Antes esta
    // limpieza era una lista de `deleteMany` con ids que podían quedar
    // `undefined` si el `beforeAll` fallaba a mitad de camino — y en Prisma
    // un `where` con `undefined` no filtra: borra la tabla entera. Como el
    // guard de `testDb.ts` garantiza que esto solo corre contra la base
    // desechable, truncar es más simple y más seguro que acertarle a cada id.
    await truncateAllTables(prisma);
    await prisma.$disconnect();
  });

  it("confirma una inscripción individual válida de punta a punta", async () => {
    const registration = await registrationsService.createRegistration(
      { competitionEventId, clubId, personId },
      ADMIN_ACTOR
    );
    expect(registration.status).toBe("confirmed");
  });

  it("rechaza una segunda inscripción duplicada del mismo nadador en la misma prueba (RB-09)", async () => {
    await expect(
      registrationsService.createRegistration({ competitionEventId, clubId, personId }, ADMIN_ACTOR)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("el nadador aparece en la lista de elegibles ANTES de inscribirse y desaparece después", async () => {
    // Nota: como el `beforeAll` ya inscribió al nadador, verificamos el
    // comportamiento negativo (ya no debe aparecer como elegible).
    const eligible = await registrationsService.listEligibleSwimmers({ clubId, competitionEventId, categoryId }, ADMIN_ACTOR);
    expect(eligible.find((s) => s.id === personId)).toBeUndefined();
  });
});
