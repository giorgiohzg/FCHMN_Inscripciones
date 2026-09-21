import type { FastifyInstance } from "fastify";
import * as personsService from "./persons.service";
import * as bulkImportService from "./persons-bulk-import.service";
import {
  personCreateSchema,
  personUpdateSchema,
  personListQuerySchema,
} from "./persons.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";

export async function personsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/persons", { preHandler: [requirePermission("persons:read")] }, async (req, reply) => {
    const parsed = personListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parámetros de búsqueda inválidos", parsed.error.flatten());
    reply.send(await personsService.listPersons(parsed.data));
  });

  app.get("/persons/:id", { preHandler: [requirePermission("persons:read")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await personsService.getPersonById(id));
  });

  app.post("/persons", { preHandler: [requirePermission("persons:write")] }, async (req, reply) => {
    const parsed = personCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de persona inválidos", parsed.error.flatten());

    const person = await personsService.createPerson(parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(person);
  });

  app.put("/persons/:id", { preHandler: [requirePermission("persons:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = personUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de persona inválidos", parsed.error.flatten());

    const person = await personsService.updatePerson(id, parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.send(person);
  });

  app.delete("/persons/:id", { preHandler: [requirePermission("persons:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await personsService.softDeletePerson(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(204).send();
  });

  app.post("/persons/:id/block", { preHandler: [requirePermission("persons:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await personsService.blockPerson(id, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.post("/persons/:id/disable", { preHandler: [requirePermission("persons:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await personsService.disablePerson(id, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.post("/persons/:id/reactivate", { preHandler: [requirePermission("persons:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send(await personsService.reactivatePerson(id, { userId: req.authUser!.sub, ipAddress: req.ip }));
  });

  app.post("/persons/:id/credentials", { preHandler: [requirePermission("persons:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await personsService.createCredentials(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.code(201).send(result);
  });

  app.post("/persons/:id/credentials/reset", { preHandler: [requirePermission("persons:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await personsService.resetCredentials(id, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.send(result);
  });

  // ---------- Carga masiva (Excel) ----------

  app.get("/persons/bulk-import/template", { preHandler: [requirePermission("persons:write")] }, async (_req, reply) => {
    const buffer = await bulkImportService.buildPersonsImportTemplate();
    reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", 'attachment; filename="Plantilla_Carga_Masiva_Personas.xlsx"')
      .send(buffer);
  });

  app.post("/persons/bulk-import", { preHandler: [requirePermission("persons:write")] }, async (req, reply) => {
    const file = await req.file();
    if (!file) throw new ValidationError("Debe adjuntar un archivo Excel (.xlsx).");

    const buffer = await file.toBuffer();
    const summary = await bulkImportService.importPersonsFromExcel(buffer, { userId: req.authUser!.sub, ipAddress: req.ip });
    reply.send(summary);
  });
}
