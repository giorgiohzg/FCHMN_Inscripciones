import type { FastifyInstance } from "fastify";
import * as clubsService from "./clubs.service";
import { clubCreateSchema, clubUpdateSchema, clubListQuerySchema } from "./clubs.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError, ForbiddenError } from "../../shared/errors";
import { buildActorContext } from "../../shared/actorContext";

export async function clubsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/clubs", { preHandler: [requirePermission("clubs:read")] }, async (req, reply) => {
    const parsed = clubListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros de búsqueda inválidos", parsed.error.flatten());
    reply.send(await clubsService.listClubs(parsed.data, buildActorContext(req)));
  });

  app.get("/clubs/:id", { preHandler: [requirePermission("clubs:read")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const roles: string[] = req.authUser!.roles;
    const isAdmin = roles.includes("admin");
    const actorClubId = req.authUser!.clubId ?? null;
    // Si no es admin y no tiene un club real detrás (ej. tiene el rol
    // "delegado" marcado en Personas pero nunca quedó asignado como
    // delegado/entrenador de ningún club), se le niega el acceso —
    // igual que a un nadador, que ni siquiera tiene este permiso.
    if (!isAdmin && actorClubId !== id) {
      throw new ForbiddenError("No tiene permiso para ver la información de otro club");
    }
    reply.send(await clubsService.getClubById(id));
  });

  app.post("/clubs", { preHandler: [requirePermission("clubs:write")] }, async (req, reply) => {
    const parsed = clubCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de club inválidos", parsed.error.flatten());

    const club = await clubsService.createClub(parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(club);
  });

  app.put("/clubs/:id", { preHandler: [requirePermission("clubs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = clubUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de club inválidos", parsed.error.flatten());

    const club = await clubsService.updateClub(id, parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.send(club);
  });

  app.delete("/clubs/:id", { preHandler: [requirePermission("clubs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await clubsService.softDeleteClub(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(204).send();
  });

  app.post("/clubs/:id/block", { preHandler: [requirePermission("clubs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await clubsService.blockClub(id, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.post("/clubs/:id/disable", { preHandler: [requirePermission("clubs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await clubsService.disableClub(id, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.post("/clubs/:id/reactivate", { preHandler: [requirePermission("clubs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await clubsService.reactivateClub(id, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.post("/clubs/:id/credentials", { preHandler: [requirePermission("clubs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await clubsService.createClubCredentials(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(result);
  });

  app.post("/clubs/:id/credentials/reset", { preHandler: [requirePermission("clubs:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await clubsService.resetClubCredentials(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.send(result);
  });
}
