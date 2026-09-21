import type { FastifyInstance } from "fastify";
import * as assignmentService from "./assignment.service";
import {
  proposeAssignmentSchema,
  rejectAssignmentSchema,
  assignmentListQuerySchema,
  swimmersByClubFilterQuerySchema,
  bulkAssignSwimmersSchema,
  reassignSwimmerSchema,
} from "./assignment.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError, ForbiddenError } from "../../shared/errors";
import { buildActorContext, scopedClubId } from "../../shared/actorContext";
import type { FastifyRequest } from "fastify";

/**
 * A qué club se acota un listado.
 *
 * `undefined` significa "sin restricción" y es exclusivo del administrador;
 * `null` significa "ninguna asignación" y es lo que recibe un nadador, que no
 * opera a nivel de club. La distinción entre los dos importa: confundirlos
 * convertiría al actor más restringido en el menos restringido.
 *
 * Aquí vivía un adaptador que añadía `actorClubId` al contexto compartido para
 * encajar con un `ActorContext` local del servicio. Ese contrato paralelo, con
 * campos opcionales, dejó pasar un contexto incompatible en dos rutas. El
 * servicio usa ahora el contexto compartido y `assertClubAccess`, así que el
 * adaptador sobra.
 */
function alcanceDeListado(req: FastifyRequest): string | null | undefined {
  const actor = buildActorContext(req);
  return actor.scope.kind === "admin" ? undefined : scopedClubId(actor);
}

export async function swimmerAssignmentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/swimmer-assignments", { preHandler: [requirePermission("swimmer-assignment:read")] }, async (req, reply) => {
    const parsed = assignmentListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros de búsqueda inválidos", parsed.error.flatten());
    reply.send(await assignmentService.listAssignments(parsed.data, alcanceDeListado(req)));
  });

  app.get("/swimmer-assignments/:id", { preHandler: [requirePermission("swimmer-assignment:read")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const assignment = await assignmentService.getAssignmentById(id);

    // El detalle traía nombre y RUN del nadador sin comprobar de qué club es
    // la solicitud: cualquier club podía leer las asignaciones de los demás
    // probando ids.
    const actor = buildActorContext(req);
    if (actor.scope.kind === "club" && assignment.clubId !== actor.scope.clubId) {
      throw new ForbiddenError("No tiene permiso para consultar solicitudes de otro club.");
    }
    if (actor.scope.kind === "swimmer" && assignment.personId !== actor.scope.personId) {
      throw new ForbiddenError("Solo puede consultar sus propias solicitudes.");
    }
    reply.send(assignment);
  });

  /**
   * Asignación directa (solo administrador): agrega un nadador a un club
   * ya como ACTIVO, sin pasar por el flujo de propuesta/aprobación —
   * mismo permiso que aprobar (`swimmer-assignment:approve`, exclusivo de `admin`).
   */
  app.post("/swimmer-assignments/direct", { preHandler: [requirePermission("swimmer-assignment:approve")] }, async (req, reply) => {
    const parsed = proposeAssignmentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de solicitud inválidos", parsed.error.flatten());

    const assignment = await assignmentService.assignSwimmerDirectly(parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(assignment);
  });

  /**
   * Filtro de nadadores por club actual (para la asignación masiva):
   * `clubFilter` es un ID de club o el literal "none" ("Sin club").
   */
  app.get("/swimmer-assignments/swimmers-by-club", { preHandler: [requirePermission("swimmer-assignment:approve")] }, async (req, reply) => {
    const parsed = swimmersByClubFilterQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros inválidos", parsed.error.flatten());
    reply.send(await assignmentService.listSwimmersByClubFilter(parsed.data));
  });

  /** Asigna varios nadadores al mismo club de una sola vez (solo administrador). */
  app.post("/swimmer-assignments/bulk-assign", { preHandler: [requirePermission("swimmer-assignment:approve")] }, async (req, reply) => {
    const parsed = bulkAssignSwimmersSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());
    reply.send(await assignmentService.bulkAssignSwimmers(parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  /**
   * Club actual de un nadador (para mostrar en la ficha de Personas) — null
   * si no tiene ninguno activo.
   *
   * Alcance: un nadador solo puede consultarse a sí mismo. Un club SÍ puede
   * consultar a cualquier persona, deliberadamente: lo necesita el flujo de
   * propuesta (A-05), donde busca a un nadador que todavía no es suyo y debe
   * ver si ya pertenece a otro club antes de proponerlo. Lo único que expone
   * es el nombre del club, no datos personales.
   */
  app.get("/swimmer-assignments/current-club/:personId", { preHandler: [requirePermission("swimmer-assignment:read")] }, async (req, reply) => {
    const { personId } = req.params as { personId: string };
    const actor = buildActorContext(req);
    if (actor.scope.kind === "swimmer" && actor.scope.personId !== personId) {
      throw new ForbiddenError("Solo puede consultar su propia información.");
    }
    reply.send(await assignmentService.getCurrentClubForPerson(personId));
  });

  /** Cambia de club a un nadador en un solo paso (finaliza el anterior si existía, y activa el nuevo). */
  app.post("/swimmer-assignments/reassign/:personId", { preHandler: [requirePermission("swimmer-assignment:approve")] }, async (req, reply) => {
    const { personId } = req.params as { personId: string };
    const parsed = reassignSwimmerSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());
    reply.send(await assignmentService.reassignSwimmerToClub(personId, parsed.data.newClubId, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  /**
   * El club o su personal proponen (A-05). Requiere `swimmer-assignment:write`,
   * que en el seed tienen `admin`, `club` y **todo** el personal del club
   * —`delegate`, `coach` y `legal_representative` comparten
   * `CLUB_STAFF_PERMISSIONS`—. El rol `swimmer` no lo tiene.
   */
  app.post("/swimmer-assignments", { preHandler: [requirePermission("swimmer-assignment:write")] }, async (req, reply) => {
    const parsed = proposeAssignmentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de solicitud inválidos", parsed.error.flatten());

    const assignment = await assignmentService.proposeAssignment(parsed.data, buildActorContext(req));
    reply.code(201).send(assignment);
  });

  /**
   * APROBAR y RECHAZAR son del administrador (A-05): exigen
   * `swimmer-assignment:approve`, que en el seed solo tiene el rol `admin`.
   *
   * **FINALIZAR no.** Está más abajo y exige `swimmer-assignment:write`, porque
   * dar de baja a un nadador del propio plantel es la operación inversa de
   * proponerlo y no necesita al administrador. Lo que impide finalizar membresías
   * ajenas no es el permiso sino el alcance, que comprueba `endAssignment`.
   */
  app.post("/swimmer-assignments/:id/approve", { preHandler: [requirePermission("swimmer-assignment:approve")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await assignmentService.approveAssignment(id, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.post("/swimmer-assignments/:id/reject", { preHandler: [requirePermission("swimmer-assignment:approve")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = rejectAssignmentSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());

    reply.send(await assignmentService.rejectAssignment(id, parsed.data.reason, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  /**
   * Finalizar una membresía activa: `swimmer-assignment:write` **y** alcance por
   * club. El administrador puede con cualquiera; el personal del club, solo con
   * las de su propio club (`endAssignment` responde 403 en caso contrario).
   */
  app.post("/swimmer-assignments/:id/end", { preHandler: [requirePermission("swimmer-assignment:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await assignmentService.endAssignment(id, buildActorContext(req)));
  });
}
