import type { FastifyInstance } from "fastify";
import * as base from "./baseCatalogs.service";
import * as categoriesService from "./categories.service";
import * as categoryGroupsService from "./category-groups.service";
import * as eventsService from "./events.service";
import {
  distanceCreateSchema,
  strokeCreateSchema,
  categoryGroupCreateSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
  categoryListQuerySchema,
  eventCreateSchema,
  eventUpdateSchema,
  eventListQuerySchema,
} from "./catalogs.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";

export async function catalogsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ---------- Tipos de prueba ----------
  app.get("/catalogs/test-types", { preHandler: [requirePermission("catalogs:read")] }, async (_req, reply) => {
    reply.send(await base.listTestTypes());
  });

  // ---------- Distancias ----------
  app.get("/catalogs/distances", { preHandler: [requirePermission("catalogs:read")] }, async (_req, reply) => {
    reply.send(await base.listDistances());
  });

  app.post("/catalogs/distances", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const parsed = distanceCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Distancia inválida", parsed.error.flatten());
    const distance = await base.createDistance(parsed.data.meters, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(distance);
  });

  app.put("/catalogs/distances/:id", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = distanceCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Distancia inválida", parsed.error.flatten());
    reply.send(await base.updateDistance(id, parsed.data.meters, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.delete("/catalogs/distances/:id", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await base.deleteDistance(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(204).send();
  });

  // ---------- Estilos ----------
  app.get("/catalogs/strokes", { preHandler: [requirePermission("catalogs:read")] }, async (_req, reply) => {
    reply.send(await base.listStrokes());
  });

  app.post("/catalogs/strokes", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const parsed = strokeCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Estilo inválido", parsed.error.flatten());
    const stroke = await base.createStroke(parsed.data.name, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(stroke);
  });

  app.put("/catalogs/strokes/:id", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = strokeCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Estilo inválido", parsed.error.flatten());
    reply.send(await base.updateStroke(id, parsed.data.name, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.delete("/catalogs/strokes/:id", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await base.deleteStroke(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(204).send();
  });

  // ---------- Grupos de categorías ----------
  app.get("/catalogs/category-groups", { preHandler: [requirePermission("catalogs:read")] }, async (_req, reply) => {
    reply.send(await categoryGroupsService.listCategoryGroups());
  });

  app.post("/catalogs/category-groups", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const parsed = categoryGroupCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Nombre de grupo inválido", parsed.error.flatten());
    const group = await categoryGroupsService.createCategoryGroup(parsed.data.name, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(group);
  });

  app.put("/catalogs/category-groups/:id", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = categoryGroupCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Nombre de grupo inválido", parsed.error.flatten());
    reply.send(await categoryGroupsService.updateCategoryGroup(id, parsed.data.name, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.delete("/catalogs/category-groups/:id", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await categoryGroupsService.deleteCategoryGroup(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(204).send();
  });

  // ---------- Categorías ----------
  app.get("/catalogs/categories", { preHandler: [requirePermission("catalogs:read")] }, async (req, reply) => {
    const parsed = categoryListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros inválidos", parsed.error.flatten());
    reply.send(await categoriesService.listCategories(parsed.data));
  });

  app.get("/catalogs/categories/:id", { preHandler: [requirePermission("catalogs:read")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await categoriesService.getCategoryById(id));
  });

  app.post("/catalogs/categories", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const parsed = categoryCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de categoría inválidos", parsed.error.flatten());
    const category = await categoriesService.createCategory(parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(category);
  });

  app.put("/catalogs/categories/:id", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = categoryUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de categoría inválidos", parsed.error.flatten());
    reply.send(await categoriesService.updateCategory(id, parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.delete("/catalogs/categories/:id", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await categoriesService.softDeleteCategory(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(204).send();
  });

  // ---------- Pruebas (events) ----------
  app.get("/catalogs/events", { preHandler: [requirePermission("catalogs:read")] }, async (req, reply) => {
    const parsed = eventListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros inválidos", parsed.error.flatten());
    reply.send(await eventsService.listEvents(parsed.data));
  });

  app.get("/catalogs/events/:id", { preHandler: [requirePermission("catalogs:read")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await eventsService.getEventById(id));
  });

  app.post("/catalogs/events", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const parsed = eventCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de prueba inválidos", parsed.error.flatten());
    const event = await eventsService.createEvent(parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(event);
  });

  app.put("/catalogs/events/:id", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = eventUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de prueba inválidos", parsed.error.flatten());
    reply.send(await eventsService.updateEvent(id, parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.delete("/catalogs/events/:id", { preHandler: [requirePermission("catalogs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await eventsService.softDeleteEvent(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(204).send();
  });
}
