import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";
import { configuracionDeLaSolicitud } from "./accesos.middleware";
import { funcionesDeshabilitadas, guardarConfiguracion, leerConfiguracionAdministrativa } from "./accesos.service";

const guardadoSchema = z.object({
  version: z.number().int().min(0),
  valores: z.record(z.string(), z.unknown()),
});

export async function accesosRoutes(app: FastifyInstance) {
  /**
   * FUNCIONES EFECTIVAS de la sesión: las del catálogo que hoy tiene DENEGADAS, con la versión
   * con que se evaluaron y la cuenta. La interfaz las pide al iniciar o restaurar la sesión, al
   * renovar y al recibir `FUNCION_DESHABILITADA`, y solo las usa para OCULTAR controles: la
   * decisión de verdad la toma el servidor en cada solicitud.
   *
   * Exige `requireAuth`: con el cambio OBLIGATORIO pendiente responde 403
   * `PASSWORD_CHANGE_REQUIRED`, y la interfaz no la pide en ese estado.
   */
  app.get("/auth/accesos", { preHandler: [requireAuth] }, async (req, reply) => {
    const config = await configuracionDeLaSolicitud(req);
    reply.code(200).send({
      userId: req.authUser!.sub,
      version: config.version,
      deshabilitadas: funcionesDeshabilitadas(req.authUser!.roles, config),
    });
  });

  /** Configuración para la pantalla de administración: valores, versión, última modificación y catálogo. */
  app.get("/accesos-por-rol", { preHandler: [requireAuth, requireRole("admin")] }, async (_req, reply) => {
    reply.code(200).send(await leerConfiguracionAdministrativa());
  });

  /**
   * Guarda el estado COMPLETO de la matriz. Exige la versión leída: si otra administración
   * guardó entretanto responde 409 `CONFIGURACION_CAMBIADA` con el estado vigente y no escribe.
   */
  app.put("/accesos-por-rol", { preHandler: [requireAuth, requireRole("admin")] }, async (req, reply) => {
    const parsed = guardadoSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());
    const resultado = await guardarConfiguracion(parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(200).send(resultado);
  });
}
