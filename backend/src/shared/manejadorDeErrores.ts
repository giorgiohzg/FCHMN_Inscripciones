import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { resolveErrorResponse } from "./httpErrorResponse";

/**
 * El manejador de errores del servidor, aparte de `server.ts` para poder ejercitar
 * EXACTAMENTE el mismo en pruebas que no tocan la configuración ni la base.
 *
 * Toda la decisión vive en `resolveErrorResponse` para que las pruebas puedan ejercitar la
 * misma función que usa el servidor —incluida la traducción de errores de Prisma, que antes
 * solo se aplicaba en los servicios que la invocaban a mano.
 *
 * El error se registra con el registro de LA PETICIÓN (`req.log`), no con el global: así la
 * línea lleva su `reqId` y se puede correlacionar con el acceso. El objeto `err` pasa por
 * `errorSeguro` (serializador `err`, ver `shared/registro.ts`): ni mensaje ni valores.
 */
export function manejadorDeErrores(err: FastifyError & { statusCode?: number }, req: FastifyRequest, reply: FastifyReply): void {
  const { status, body, log } = resolveErrorResponse(err);
  if (log === "error") req.log.error({ err }, "error de solicitud");
  else if (log === "warn") req.log.warn({ err }, "error de solicitud");
  reply.status(status).send(body);
}
