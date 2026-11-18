import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";
import { guardarMensajeLogin, leerMensajeLoginAdministrativo, leerMensajeLoginPublico } from "./parametros.service";

const guardadoSchema = z.object({ texto: z.string() }).strict();

export async function parametrosRoutes(app: FastifyInstance) {
  /**
   * PÚBLICA, sin sesión: el login la pide al cargarse. Responde SOLO `{ texto }`. Si falla,
   * la interfaz muestra el texto por defecto y el inicio de sesión sigue disponible.
   */
  app.get("/mensaje-de-acceso", async (_req, reply) => {
    reply.code(200).send(await leerMensajeLoginPublico());
  });

  /** Estado completo para la pantalla de administración. */
  app.get("/administracion/mensaje-de-acceso", { preHandler: [requireAuth, requireRole("admin")] }, async (_req, reply) => {
    reply.code(200).send(await leerMensajeLoginAdministrativo());
  });

  /** Guarda el mensaje. Exclusivo de administración; se audita en la misma transacción. */
  app.put("/administracion/mensaje-de-acceso", { preHandler: [requireAuth, requireRole("admin")] }, async (req, reply) => {
    const parsed = guardadoSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());
    reply.code(200).send(await guardarMensajeLogin(parsed.data.texto, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });
}
