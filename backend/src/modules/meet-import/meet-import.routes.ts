import type { FastifyInstance } from "fastify";
import * as meetImportService from "./meet-import.service";
import { meetImportOptionsSchema } from "./meet-import.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";

export async function meetImportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /**
   * multipart/form-data con dos partes:
   *  - "file": el .zip exportado desde Hy-Tek Meet Manager ("Meet Events").
   *  - "maxIndividualEventsPerSwimmer": campo de texto (la competencia lo exige y el archivo no lo trae).
   */
  app.post("/competitions/import-meet-events", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const parts = req.parts();
    let fileBuffer: Buffer | null = null;
    let maxIndividualEventsPerSwimmerRaw: string | undefined;

    for await (const part of parts) {
      if (part.type === "file" && part.fieldname === "file") {
        fileBuffer = await part.toBuffer();
      } else if (part.type === "field" && part.fieldname === "maxIndividualEventsPerSwimmer") {
        maxIndividualEventsPerSwimmerRaw = part.value as string;
      }
    }

    if (!fileBuffer) throw new ValidationError("Debe adjuntar el archivo .zip exportado desde Meet Manager.");

    const parsedOptions = meetImportOptionsSchema.safeParse({ maxIndividualEventsPerSwimmer: maxIndividualEventsPerSwimmerRaw });
    if (!parsedOptions.success) throw new ValidationError("Datos inválidos", parsedOptions.error.flatten());

    const summary = await meetImportService.importCompetitionFromMeetEventsZip(fileBuffer, parsedOptions.data, {
      userId: req.authUser!.sub,
      ipAddress: req.ip,
    });
    reply.code(201).send(summary);
  });
}
