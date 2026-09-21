import type { FastifyInstance } from "fastify";
import * as registrationsService from "./registrations.service";
import {
  createRegistrationSchema,
  updateRegistrationSchema,
  registrationListQuerySchema,
  eligibleSwimmersQuerySchema,
  availableEventsQuerySchema,
  clubSwimmersQuerySchema,
  clubEligibilityQuerySchema,
} from "./registrations.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";
import { buildActorContext } from "../../shared/actorContext";

export async function registrationsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Paso 3: pruebas habilitadas de la competencia.
  app.get("/competitions/:id/enabled-events", { preHandler: [requirePermission("registrations:read")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await registrationsService.listEnabledCompetitionEvents(id));
  });

  // Nuevo orden de inscripción — paso "club": nadadores activos del club.
  app.get("/registrations/club-swimmers", { preHandler: [requirePermission("registrations:read")] }, async (req, reply) => {
    const parsed = clubSwimmersQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros inválidos", parsed.error.flatten());
    reply.send(await registrationsService.listActiveSwimmersOfClub(parsed.data.clubId, buildActorContext(req)));
  });

  // Nuevo orden de inscripción — paso "pruebas disponibles" (categoría ya resuelta).
  app.get("/registrations/available-events", { preHandler: [requirePermission("registrations:read")] }, async (req, reply) => {
    const parsed = availableEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros inválidos", parsed.error.flatten());
    reply.send(await registrationsService.listAvailableIndividualEvents(parsed.data.competitionId, parsed.data.personId, buildActorContext(req)));
  });

  // Panel de Inscripción (arrastrar y soltar): elegibilidad de TODO el plantel del club de una vez.
  app.get("/registrations/club-eligibility-matrix", { preHandler: [requirePermission("registrations:read")] }, async (req, reply) => {
    const parsed = clubEligibilityQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros inválidos", parsed.error.flatten());
    reply.send(await registrationsService.listClubEligibilityMatrix(parsed.data.competitionId, parsed.data.clubId, buildActorContext(req)));
  });

  // Paso 6 (flujo anterior, se mantiene disponible): nadadores elegibles para una prueba+categoría ya conocida.
  app.get("/registrations/eligible-swimmers", { preHandler: [requirePermission("registrations:read")] }, async (req, reply) => {
    const parsed = eligibleSwimmersQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros inválidos", parsed.error.flatten());
    reply.send(await registrationsService.listEligibleSwimmers(parsed.data, buildActorContext(req)));
  });

  app.get("/registrations", { preHandler: [requirePermission("registrations:read")] }, async (req, reply) => {
    const parsed = registrationListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros inválidos", parsed.error.flatten());
    reply.send(await registrationsService.listRegistrations(parsed.data, buildActorContext(req)));
  });

  app.post("/registrations", { preHandler: [requirePermission("registrations:write")] }, async (req, reply) => {
    const parsed = createRegistrationSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de inscripción inválidos", parsed.error.flatten());
    const registration = await registrationsService.createRegistration(parsed.data, buildActorContext(req));
    reply.code(201).send(registration);
  });

  app.post("/registrations/:id/cancel", { preHandler: [requirePermission("registrations:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await registrationsService.cancelRegistration(id, buildActorContext(req)));
  });

  app.put("/registrations/:id", { preHandler: [requirePermission("registrations:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = updateRegistrationSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());
    reply.send(await registrationsService.updateRegistration(id, parsed.data, buildActorContext(req)));
  });
}
