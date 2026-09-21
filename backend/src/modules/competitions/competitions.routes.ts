import type { FastifyInstance } from "fastify";
import * as competitionsService from "./competitions.service";
import * as structureService from "./competition-structure.service";
import * as competitionEventsService from "./competition-events.service";
import {
  competitionCreateSchema,
  competitionUpdateSchema,
  competitionListQuerySchema,
  duplicateCompetitionSchema,
  addDateSchema,
  addSessionSchema,
  sessionLimitSchema,
  sessionTypeCreateSchema,
  addCompetitionEventSchema,
  updateCompetitionEventSchema,
  reorderCompetitionEventsSchema,
} from "./competitions.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";
import type { CompetitionAction } from "./competitions.rules";

export async function competitionsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ---------- Tipos de jornada ----------
  app.get("/catalogs/session-types", { preHandler: [requirePermission("catalogs:read")] }, async (_req, reply) => {
    reply.send(await structureService.listSessionTypes());
  });
  app.post("/catalogs/session-types", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const parsed = sessionTypeCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Nombre de jornada inválido", parsed.error.flatten());
    reply.code(201).send(await structureService.createSessionType(parsed.data.name, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  // ---------- Competencias ----------
  app.get("/competitions", { preHandler: [requirePermission("competitions:read")] }, async (req, reply) => {
    const parsed = competitionListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros inválidos", parsed.error.flatten());
    const isAdmin = (req.authUser!.roles as string[]).includes("admin");
    reply.send(await competitionsService.listCompetitions(parsed.data, !isAdmin));
  });

  app.get("/competitions/:id", { preHandler: [requirePermission("competitions:read")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const isAdmin = (req.authUser!.roles as string[]).includes("admin");
    reply.send(await competitionsService.getCompetitionById(id, !isAdmin));
  });

  app.post("/competitions", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const parsed = competitionCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de competencia inválidos", parsed.error.flatten());
    const competition = await competitionsService.createCompetition(parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(competition);
  });

  app.put("/competitions/:id", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = competitionUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de competencia inválidos", parsed.error.flatten());
    reply.send(await competitionsService.updateCompetition(id, parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.delete("/competitions/:id", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await competitionsService.deleteCompetition(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(204).send();
  });

  app.post("/competitions/:id/duplicate", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = duplicateCompetitionSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());
    const competition = await competitionsService.duplicateCompetition(id, parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(competition);
  });

  const actions: CompetitionAction[] = ["schedule", "cancel", "closeRegistrations", "start", "finish"];
  for (const action of actions) {
    app.post(`/competitions/:id/${action}`, { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      reply.send(await competitionsService.transitionCompetition(id, action, { userId: req.authUser!.sub, ipAddress: req.ip }));
    });
  }

  // ---------- Fechas ----------
  app.post("/competitions/:id/dates", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = addDateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Fecha inválida", parsed.error.flatten());
    const date = await structureService.addCompetitionDate(id, parsed.data.date, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(date);
  });

  app.delete("/competition-dates/:dateId", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { dateId } = req.params as { dateId: string };
    await structureService.removeCompetitionDate(dateId, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(204).send();
  });

  // ---------- Jornadas ----------
  app.post("/competition-dates/:dateId/sessions", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { dateId } = req.params as { dateId: string };
    const parsed = addSessionSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());
    const session = await structureService.addSession(dateId, parsed.data.sessionTypeId, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(session);
  });

  app.delete("/competition-sessions/:sessionId", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    await structureService.removeSession(sessionId, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(204).send();
  });

  app.put("/competition-sessions/:sessionId/limit", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const parsed = sessionLimitSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de límite inválidos", parsed.error.flatten());
    reply.send(await structureService.setSessionLimit(sessionId, parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  // ---------- Pruebas asignadas a la competencia ----------
  app.get("/competitions/:id/events", { preHandler: [requirePermission("competitions:read")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await competitionEventsService.listCompetitionEvents(id));
  });

  app.post("/competitions/:id/events", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = addCompetitionEventSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());
    const ce = await competitionEventsService.addCompetitionEvent(id, parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(ce);
  });

  app.put("/competition-events/:ceId", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { ceId } = req.params as { ceId: string };
    const parsed = updateCompetitionEventSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());
    reply.send(await competitionEventsService.updateCompetitionEvent(ceId, parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  // Renumera VARIAS pruebas en una sola solicitud — usado al reordenar o
  // mover una prueba entre jornadas/fechas, donde un solo movimiento
  // puede afectar el número de muchas otras pruebas de la competencia.
  app.put("/competition-events/reorder", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const parsed = reorderCompetitionEventsSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());
    reply.send(await competitionEventsService.reorderCompetitionEvents(parsed.data.updates, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.delete("/competition-events/:ceId", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { ceId } = req.params as { ceId: string };
    await competitionEventsService.removeCompetitionEvent(ceId, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(204).send();
  });
}
