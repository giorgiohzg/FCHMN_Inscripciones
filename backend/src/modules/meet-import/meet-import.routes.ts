import type { FastifyInstance, FastifyRequest } from "fastify";
import * as meetImportService from "./meet-import.service";
import { meetImportOptionsSchema, confirmacionDeRelevosSchema } from "./meet-import.schemas";
import { requireAuth, requirePermission } from "../auth/rbac.middleware";
import { ValidationError } from "../../shared/errors";
import { EXTENSIONES_ADMITIDAS, extensionAdmitida } from "./meet-file-detector";

export async function meetImportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /**
   * Lee el archivo subido y devuelve la parte del multipart que interesa.
   *
   * Se comparte entre las dos fases para que la criba por extensión y el
   * mensaje de "falta el archivo" sean idénticos en ambas: si divergieran, un
   * archivo aceptado en el análisis podría rechazarse en la confirmación
   * después de que el usuario ya tomó todas las decisiones.
   */
  async function leerMultipart(req: FastifyRequest) {
    let fileBuffer: Buffer | null = null;
    let fileName = "";
    const campos: Record<string, string> = {};

    for await (const part of req.parts()) {
      if (part.type === "file" && part.fieldname === "file") {
        fileBuffer = await part.toBuffer();
        fileName = part.filename ?? "";
      } else if (part.type === "field") {
        campos[part.fieldname] = part.value as string;
      }
    }

    if (!fileBuffer) {
      throw new ValidationError(`Debe adjuntar el archivo exportado desde Meet Manager (${EXTENSIONES_ADMITIDAS.join(", ")}).`);
    }

    /**
     * Primera barrera, por nombre: barata y suficiente para atajar un
     * adjunto claramente equivocado. NO es la que decide — el contenido se
     * comprueba después, en el servicio, y manda sobre esto.
     */
    if (fileName && !extensionAdmitida(fileName)) {
      throw new ValidationError(
        `La extensión de "${fileName}" no está admitida. Se aceptan: ${EXTENSIONES_ADMITIDAS.join(", ")}. ` +
          "El contenido se verifica igualmente después de subirlo."
      );
    }

    return { fileBuffer, fileName, campos };
  }

  /**
   * FASE 1 — analizar sin importar.
   *
   * Devuelve qué trae el archivo y, una por una, sus pruebas de relevo con las
   * opciones del catálogo. No crea la competencia ni entradas de catálogo —lo
   * único que escribe es el registro de auditoría si el análisis falla—, de
   * modo que quien importa pueda decidir antes de que exista nada.
   *
   * Pide el mismo permiso que la importación: enseña el contenido de un
   * archivo de competencia y la lista de tipos de prueba del catálogo.
   */
  app.post("/competitions/import-meet-events/analyze", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { fileBuffer, fileName } = await leerMultipart(req);

    const analisis = await meetImportService.analizarArchivoDeImportacion(
      fileBuffer,
      { userId: req.authUser!.sub, ipAddress: req.ip },
      fileName
    );
    reply.code(200).send(analisis);
  });

  /**
   * multipart/form-data con dos partes:
   *  - "file": la exportación de Hy-Tek Meet Manager ("Meet Events"), en
   *    cualquiera de las formas admitidas: `.zip` con un `.ev3` dentro,
   *    `.ev3` suelto, o `.hyv` cuyo contenido sea una de las dos anteriores.
   *    Lo que decide es el CONTENIDO (ver `meet-file-detector.ts`); la
   *    extensión es solo una primera criba.
   *  - "maxIndividualEventsPerSwimmer": campo de texto (la competencia lo exige y el archivo no lo trae).
   */
  app.post("/competitions/import-meet-events", { preHandler: [requirePermission("competitions:write")] }, async (req, reply) => {
    const { fileBuffer, fileName, campos } = await leerMultipart(req);

    const parsedOptions = meetImportOptionsSchema.safeParse({
      maxIndividualEventsPerSwimmer: campos.maxIndividualEventsPerSwimmer,
    });
    if (!parsedOptions.success) throw new ValidationError("Datos inválidos", parsedOptions.error.flatten());

    /**
     * FASE 2 — la confirmación de relevos, si viene.
     *
     * Es OPCIONAL en el transporte y obligatoria en el servicio cuando hace
     * falta: aquí solo se comprueba que lo recibido tenga la forma correcta.
     * Quién debe confirmar qué lo decide el servicio, que es el único que ha
     * leído el archivo y sabe si trae relevos.
     *
     * Un JSON ilegible se rechaza con un mensaje propio en vez de dejar que
     * reviente el `JSON.parse`: llega desde el navegador y el usuario tiene
     * que poder entender qué pasó.
     */
    let confirmacionDeRelevos: meetImportService.ConfirmacionDeRelevosEntrada | undefined;
    if (campos.relayDecisions !== undefined) {
      let crudo: unknown;
      try {
        crudo = JSON.parse(campos.relayDecisions);
      } catch {
        throw new ValidationError("La confirmación de relevos no se pudo leer. Vuelva a analizar el archivo y confirme de nuevo.");
      }
      const parsed = confirmacionDeRelevosSchema.safeParse(crudo);
      if (!parsed.success) throw new ValidationError("La confirmación de relevos no es válida", parsed.error.flatten());
      confirmacionDeRelevos = parsed.data;
    }

    const summary = await meetImportService.importCompetitionFromMeetEventsZip(
      fileBuffer,
      { ...parsedOptions.data, confirmacionDeRelevos },
      {
        userId: req.authUser!.sub,
        ipAddress: req.ip,
      },
      fileName
    );
    reply.code(201).send(summary);
  });
}
