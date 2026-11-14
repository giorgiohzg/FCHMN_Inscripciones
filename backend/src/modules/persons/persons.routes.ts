import type { FastifyInstance, FastifyRequest } from "fastify";
import * as personsService from "./persons.service";
import * as bulkImportService from "./persons-bulk-import.service";
import {
  personCreateSchema,
  personUpdateSchema,
  personListQuerySchema,
  adminAccessSchema,
  createCredentialsSchema,
} from "./persons.schemas";
import { requireAuth, requirePermission, requireRole } from "../auth/rbac.middleware";
import { ConflictError, ValidationError } from "../../shared/errors";
import { LIMITES_XLSX } from "./xlsx/limites";
import { tomarTurnoDeCarga } from "./xlsx/turno-de-carga";

/**
 * Recibe el archivo de la carga masiva con su propio tope, que corta el flujo antes de
 * acumularlo. El plazo cierra la conexión: un envío detenido no retiene el turno.
 */
async function recibirArchivoDeCarga(req: FastifyRequest): Promise<Buffer> {
  const plazo = setTimeout(() => req.raw.destroy(), LIMITES_XLSX.plazoSubidaMs);
  try {
    const file = await req.file({ limits: { fileSize: LIMITES_XLSX.comprimidoMaxBytes } });
    if (!file) throw new ValidationError("Debe adjuntar un archivo Excel (.xlsx).");
    return await file.toBuffer();
  } catch (err) {
    if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw new ValidationError(`El archivo pesa más de ${LIMITES_XLSX.comprimidoMaxBytes / (1024 * 1024)} MB. No se importó ninguna fila.`);
    }
    throw err;
  } finally {
    clearTimeout(plazo);
  }
}

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

    const person = await personsService.createPersonWithOptionalClub(parsed.data, { userId: req.authUser!.sub, ipAddress: req.ip });
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

  /**
   * Casilla «Habilitar permisos de administrador».
   *
   * Exige el ROL `admin`, no solo el permiso `persons:write`. Hoy ese permiso
   * lo tiene únicamente `admin`, así que la comprobación parece redundante —y
   * no lo es—: el día que alguien conceda `persons:write` a otro rol para que
   * edite fichas, ese rol podría repartir permisos de administrador sin que
   * nadie lo advirtiera. Conceder administración es una decisión de otro
   * orden que editar una ficha, y se comprueba como tal.
   *
   * `requirePermission` se mantiene además del rol: los dos guardas son
   * independientes y quitar uno no debe dejar la ruta abierta.
   */
  app.put(
    "/persons/:id/admin-access",
    { preHandler: [requirePermission("persons:write"), requireRole("admin")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = adminAccessSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());

      reply.send(
        await personsService.setAdminAccess(id, parsed.data.adminAccess, { userId: req.authUser!.sub, ipAddress: req.ip })
      );
    }
  );

  app.post("/persons/:id/credentials", { preHandler: [requirePermission("persons:write")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Cuerpo opcional: `{ username? }`. Sin cuerpo, se usa el nombre guardado.
    const cuerpo = createCredentialsSchema.safeParse(req.body ?? undefined);
    if (!cuerpo.success) throw new ValidationError("Datos inválidos", cuerpo.error.flatten());
    const result = await personsService.createCredentials(
      id,
      { userId: req.authUser!.sub, ipAddress: req.ip },
      { username: cuerpo.data?.username ?? null }
    );
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
    // El turno se toma ANTES de recibir el archivo: dos cargas no acumulan buffers a la vez.
    const liberarTurno = tomarTurnoDeCarga();
    if (!liberarTurno) {
      req.raw.resume(); // se descarta lo que falte del cuerpo, sin guardarlo
      throw new ConflictError("Ya hay una carga masiva en curso. Espere a que termine y vuelva a intentarlo.");
    }
    try {
      const buffer = await recibirArchivoDeCarga(req);
      // Incorporar personas a un club exige además el permiso de asignación: se decide aquí,
      // con el token, y el servicio rechaza el archivo entero si trae clubes sin él.
      const summary = await bulkImportService.importPersonsFromExcel(
        buffer,
        { userId: req.authUser!.sub, ipAddress: req.ip },
        { puedeAsignarClub: req.authUser!.permissions.includes(bulkImportService.PERMISO_ASIGNAR_CLUB) }
      );
      reply.send(summary);
    } finally {
      liberarTurno();
    }
  });
}
