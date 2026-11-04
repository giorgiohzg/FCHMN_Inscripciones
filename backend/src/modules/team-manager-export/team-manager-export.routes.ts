import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as exportService from "./team-manager-export.service";
import { teamManagerExportQuerySchema } from "./team-manager-export.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";
import { buildActorContext } from "../../shared/actorContext";

export async function teamManagerExportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /**
   * Descarga un ZIP con un .CL2 y un .HY3 de las inscripciones individuales y de
   * relevo confirmadas de un club en una competencia. El permiso lo tienen el
   * administrador (cualquier club) y el rol `club`, el delegado, el entrenador y
   * el representante legal (solo el suyo); el alcance lo aplica el servicio, que
   * recibe el contexto del actor.
   */
  const exportar = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = teamManagerExportQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros inválidos", parsed.error.flatten());

    const { filename, zip } = await exportService.buildTeamManagerExport(
      parsed.data.competitionId,
      parsed.data.clubId,
      buildActorContext(req)
    );

    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(zip);
  };

  app.get("/export/team-manager/zip", { preHandler: [requirePermission("export:team-manager")] }, exportar);

  /**
   * Ruta anterior, conservada como alias: entrega el MISMO ZIP. Una pestaña que
   * siga abierta con la versión previa de la web la sigue pidiendo durante un
   * despliegue, y guarda el archivo con el nombre de `Content-Disposition`.
   */
  app.get("/export/team-manager/hy3", { preHandler: [requirePermission("export:team-manager")] }, exportar);
}
