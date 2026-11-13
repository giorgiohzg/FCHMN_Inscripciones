/**
 * C-05: rutas de incorporaciones por RUN (fase 2, solo API; las pantallas son fases 3 y 4).
 *
 * La postulación (`POST /swimmer-assignments`) vive en `assignment.routes.ts`, que conserva su
 * ruta y permiso. Aquí: cuota, periodos, segundo paso y solicitudes de alta.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ForbiddenError, ValidationError } from "../../shared/errors";
import { buildActorContext } from "../../shared/actorContext";
import { segundoPasoSchema } from "../swimmer-assignment/assignment.schemas";
import * as postulacion from "./postulacion.service";
import * as periodos from "./periodos.service";
import * as altas from "./altas.service";
import {
  aprobarSolicitudSchema,
  cerrarPeriodoSchema,
  crearPeriodoSchema,
  cuotaQuerySchema,
  listarSolicitudesQuerySchema,
  rechazarSolicitudSchema,
} from "./incorporaciones.schemas";

const actorDeAuditoria = (req: FastifyRequest) => ({ userId: req.authUser!.sub, ipAddress: req.ip });

function datos<T>(esquema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } }, valor: unknown): T {
  const r = esquema.safeParse(valor);
  if (!r.success) throw new ValidationError("Datos inválidos", r.error.flatten());
  return r.data;
}

export async function incorporacionesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** Cuota del día (Santiago): el club ve la suya; administración indica el club. */
  app.get("/swimmer-assignments/cuota", { preHandler: [requirePermission("swimmer-assignment:write")] }, async (req, reply) => {
    const { clubId } = datos(cuotaQuerySchema, req.query);
    const actor = buildActorContext(req);
    let club: string;
    if (actor.scope.kind === "club") {
      if (clubId && clubId !== actor.scope.clubId) throw new ForbiddenError("No tiene permiso para consultar datos de otro club.");
      club = actor.scope.clubId;
    } else if (actor.scope.kind === "admin") {
      if (!clubId) throw new ValidationError("Administración debe indicar el club (clubId).");
      club = clubId;
    } else {
      throw new ForbiddenError("No tiene permiso para operar a nivel de club.");
    }
    reply.send(await postulacion.cuotaDelClub(club));
  });

  /** Si hay un periodo de cambio vigente hoy. Sin datos personales. */
  app.get("/swimmer-assignments/periodos-cambio/vigente", { preHandler: [requirePermission("swimmer-assignment:write")] }, async (_req, reply) => {
    reply.send(await periodos.periodoVigente());
  });

  // --- Periodos: solo administración -------------------------------------
  app.get("/swimmer-assignments/periodos-cambio", { preHandler: [requirePermission("swimmer-assignment:approve")] }, async (_req, reply) => {
    reply.send(await periodos.listarPeriodos());
  });

  app.post("/swimmer-assignments/periodos-cambio", { preHandler: [requirePermission("swimmer-assignment:approve")] }, async (req, reply) => {
    reply.code(201).send(await periodos.crearPeriodo(datos(crearPeriodoSchema, req.body), actorDeAuditoria(req)));
  });

  app.post("/swimmer-assignments/periodos-cambio/:id/cerrar", { preHandler: [requirePermission("swimmer-assignment:approve")] }, async (req, reply) => {
    datos(cerrarPeriodoSchema, req.body ?? {});
    const { id } = req.params as { id: string };
    reply.send(await periodos.cerrarPeriodo(id, actorDeAuditoria(req)));
  });

  // --- Segundo paso y solicitudes de alta ----------------------------------
  app.post("/swimmer-assignments/altas", { preHandler: [requirePermission("swimmer-assignment:write")] }, async (req, reply) => {
    const r = await postulacion.completarAlta(datos(segundoPasoSchema, req.body), buildActorContext(req));
    reply.code(r.http).send(r.cuerpo);
  });

  app.get("/swimmer-assignments/altas", { preHandler: [requirePermission("swimmer-assignment:write")] }, async (req, reply) => {
    reply.send(await altas.listarSolicitudes(datos(listarSolicitudesQuerySchema, req.query), buildActorContext(req)));
  });

  app.get("/swimmer-assignments/altas/:id", { preHandler: [requirePermission("swimmer-assignment:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await altas.obtenerSolicitud(id, buildActorContext(req)));
  });

  /** Resolver crea o vincula a una persona: exige aprobar asignaciones Y escribir personas. */
  app.post(
    "/swimmer-assignments/altas/:id/aprobar",
    { preHandler: [requirePermission("swimmer-assignment:approve"), requirePermission("persons:write")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      reply.send(await altas.aprobarSolicitud(id, datos(aprobarSolicitudSchema, req.body), buildActorContext(req)));
    }
  );

  app.post("/swimmer-assignments/altas/:id/rechazar", { preHandler: [requirePermission("swimmer-assignment:approve")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await altas.rechazarSolicitud(id, datos(rechazarSolicitudSchema, req.body ?? {}).motivo, buildActorContext(req)));
  });
}
