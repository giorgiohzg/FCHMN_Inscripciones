import type { FastifyInstance } from "fastify";
import * as relayService from "./relay-registrations.service";
import { createRelayRegistrationSchema, updateRelayRegistrationSchema, relayRegistrationListQuerySchema } from "./relay-registrations.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError, ForbiddenError } from "../../shared/errors";
import { buildActorContext } from "../../shared/actorContext";

/** Los nadadores pueden VER sus relevos, pero no inscribir, editar ni cancelar equipos. */
function assertCanOperateOnTeams(actor: ReturnType<typeof buildActorContext>, action: string) {
  if (actor.scope.kind === "swimmer") {
    throw new ForbiddenError(`Los nadadores solo pueden visualizar los relevos, no ${action}`);
  }
}

export async function relayRegistrationsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Nota: la lista de nadadores del club (paso "nadadores") y la lista de
  // pruebas habilitadas de la competencia (paso "prueba") se obtienen
  // reutilizando los endpoints ya existentes de Inscripciones individuales
  // (`GET /registrations/club-swimmers` y `GET /competitions/:id/enabled-events`)
  // — no se duplican aquí.

  app.get("/relay-registrations", { preHandler: [requirePermission("registrations:read")] }, async (req, reply) => {
    const parsed = relayRegistrationListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros inválidos", parsed.error.flatten());
    reply.send(await relayService.listRelayRegistrations(parsed.data, buildActorContext(req)));
  });

  app.post("/relay-registrations", { preHandler: [requirePermission("registrations:write")] }, async (req, reply) => {
    const actor = buildActorContext(req);
    assertCanOperateOnTeams(actor, "inscribir equipos");
    const parsed = createRelayRegistrationSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de inscripción de relevo inválidos", parsed.error.flatten());
    const relay = await relayService.createRelayRegistration(parsed.data, actor);
    reply.code(201).send(relay);
  });

  app.post("/relay-registrations/:id/cancel", { preHandler: [requirePermission("registrations:write")] }, async (req, reply) => {
    const actor = buildActorContext(req);
    assertCanOperateOnTeams(actor, "cancelarlos");
    const { id } = req.params as { id: string };
    reply.send(await relayService.cancelRelayRegistration(id, actor));
  });

  app.put("/relay-registrations/:id", { preHandler: [requirePermission("registrations:write")] }, async (req, reply) => {
    const actor = buildActorContext(req);
    assertCanOperateOnTeams(actor, "editarlos");
    const { id } = req.params as { id: string };
    const parsed = updateRelayRegistrationSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());
    reply.send(await relayService.updateRelayRegistration(id, parsed.data, actor));
  });
}
