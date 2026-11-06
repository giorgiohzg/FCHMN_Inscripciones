/**
 * El multipart de analizar e importar Meet Events (SEC-01): límites, campos truncados y archivos.
 *
 * SIMULADO: autenticación y servicio de importación sustituidos (el servicio es un espía). Lo que se
 * ejercita es el código REAL de las rutas, del lector compartido y del plugin multipart instalado,
 * con cuerpos multipart construidos a mano (`app.inject`). Cada caso se ejecuta en las DOS fases.
 *
 * Todo rechazo debe (a) terminar, sin dejar la solicitud bloqueada, y (b) no llamar al servicio.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { appConRutas, conPlazo, cuerpoMultipart, CABECERA_MULTIPART, ARCHIVO_MAXIMO_GLOBAL_BYTES, type ParteMultipart } from "./helpers/app-rutas";
import { meetImportRoutes } from "../src/modules/meet-import/meet-import.routes";
import { leerMultipartDeImportacion, CAMPOS_ADMITIDOS } from "../src/modules/meet-import/meet-import.multipart";
import { confirmacionDeRelevosSchema } from "../src/modules/meet-import/meet-import.schemas";
import { LIMITES_MULTIPART_IMPORTACION, LONGITUD_MAXIMA_NOMBRE_DE_CAMPO } from "../src/shared/limites-listas";

const sim = vi.hoisted(() => {
  const analizar = vi.fn(async () => ({ analizado: true }));
  const importar = vi.fn(async () => ({ importado: true }));
  const requireAuth = vi.fn(async (req: { authUser?: unknown }) => {
    req.authUser = { sub: "usuario-sintetico", ownerType: "user", personId: null, clubId: null, roles: ["admin"], permissions: [] };
  });
  return { analizar, importar, requireAuth };
});

vi.mock("../src/modules/auth/rbac.middleware", () => ({
  requireAuth: sim.requireAuth,
  requirePermission: () => async () => undefined,
  requireRole: () => async () => undefined,
}));
vi.mock("../src/modules/meet-import/meet-import.service", () => ({
  analizarArchivoDeImportacion: sim.analizar,
  importCompetitionFromMeetEventsZip: sim.importar,
}));

const FASES = [
  { nombre: "analizar", url: "/competitions/import-meet-events/analyze", servicio: sim.analizar, ok: 200 },
  { nombre: "importar", url: "/competitions/import-meet-events", servicio: sim.importar, ok: 201 },
] as const;

const KIB = 1024;
const HUELLA = "a".repeat(64);
const archivo: ParteMultipart = { nombre: "file", archivo: "programa.ev3", valor: "contenido sintético" };
const maximo: ParteMultipart = { nombre: "maxIndividualEventsPerSwimmer", valor: "2" };
const decisiones = (cantidad = 0): ParteMultipart => ({
  nombre: "relayDecisions",
  valor: JSON.stringify({ fileHash: HUELLA, decisiones: Array.from({ length: cantidad }, (_, i) => ({ eventNumber: i + 1, decision: "omitir" })) }),
});

let app: FastifyInstance;

beforeAll(async () => {
  app = await appConRutas([meetImportRoutes]);
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  sim.analizar.mockClear();
  sim.importar.mockClear();
});

async function enviar(url: string, partes: ParteMultipart[]) {
  return conPlazo(app.inject({ method: "POST", url, headers: CABECERA_MULTIPART, payload: cuerpoMultipart(partes) }));
}

const serviciosLlamados = () => sim.analizar.mock.calls.length + sim.importar.mock.calls.length;

describe.each(FASES)("fase $nombre", (fase) => {
  describe("lo legítimo sigue funcionando", () => {
    it("archivo + campos dentro de los límites llega al servicio", async () => {
      const res = await enviar(fase.url, [archivo, maximo, decisiones(3)]);

      expect(res.statusCode).toBe(fase.ok);
      expect(fase.servicio).toHaveBeenCalledTimes(1);
    });

    it("un campo de EXACTAMENTE 64 KiB no está truncado y pasa", async () => {
      const exacto = "x".repeat(LIMITES_MULTIPART_IMPORTACION.fieldSize);
      const res = await enviar(fase.url, [archivo, maximo, { nombre: "otro", valor: exacto }]);

      expect(res.statusCode).toBe(fase.ok);
    });

    it("cuatro campos y un archivo (los cinco permitidos) pasan", async () => {
      const res = await enviar(fase.url, [archivo, maximo, decisiones(), { nombre: "a", valor: "1" }, { nombre: "b", valor: "2" }]);

      expect(res.statusCode).toBe(fase.ok);
    });

    it("un nombre de campo de EXACTAMENTE 64 caracteres pasa (el campo desconocido se descarta)", async () => {
      const res = await enviar(fase.url, [archivo, maximo, { nombre: "n".repeat(LONGITUD_MAXIMA_NOMBRE_DE_CAMPO), valor: "1" }]);

      expect(res.statusCode).toBe(fase.ok);
    });
  });

  describe("campos truncados: se rechazan antes de guardarse o interpretarse", () => {
    it("relayDecisions de 64 KiB + 1: 413 PAYLOAD_TOO_LARGE, sin llamar al servicio", async () => {
      const res = await enviar(fase.url, [archivo, maximo, { nombre: "relayDecisions", valor: "x".repeat(LIMITES_MULTIPART_IMPORTACION.fieldSize + 1) }]);

      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe("PAYLOAD_TOO_LARGE");
      expect(serviciosLlamados()).toBe(0);
    });

    it("EL CASO PELIGROSO: un fragmento truncado que todavía sería JSON válido también se rechaza", async () => {
      // Confirmación sin decisiones seguida de espacios hasta pasar el límite: el trozo que conserva el plugin
      // es JSON válido y el esquema lo aceptaría.
      const valor = JSON.stringify({ fileHash: HUELLA, decisiones: [] }) + " ".repeat(LIMITES_MULTIPART_IMPORTACION.fieldSize + 100);
      const conservado = valor.slice(0, LIMITES_MULTIPART_IMPORTACION.fieldSize);
      // Control de sensibilidad: lo que quedaría tras el truncamiento SE ACEPTARÍA si se interpretara.
      expect(confirmacionDeRelevosSchema.safeParse(JSON.parse(conservado)).success).toBe(true);

      const res = await enviar(fase.url, [archivo, maximo, { nombre: "relayDecisions", valor }]);

      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe("PAYLOAD_TOO_LARGE");
      expect(serviciosLlamados()).toBe(0);
    });

    it("un campo desconocido truncado también se rechaza, sin nombrarlo ni reproducir su contenido", async () => {
      const res = await enviar(fase.url, [archivo, maximo, { nombre: "campoSecreto", valor: "contenido-recibido-".repeat(5_000) }]);

      expect(res.statusCode).toBe(413);
      expect(res.body).not.toContain("campoSecreto");
      expect(res.body).not.toContain("contenido-recibido");
      expect(serviciosLlamados()).toBe(0);
    });

    it("el campo truncado llega ANTES que el archivo: igualmente no se llama al servicio", async () => {
      const res = await enviar(fase.url, [{ nombre: "relayDecisions", valor: "x".repeat(LIMITES_MULTIPART_IMPORTACION.fieldSize + 1) }, archivo, maximo]);

      expect(res.statusCode).toBe(413);
      expect(serviciosLlamados()).toBe(0);
    });
  });

  describe("longitud del nombre de la parte", () => {
    it("un nombre de 65 caracteres: 413 sin reproducir el nombre", async () => {
      const nombre = "q".repeat(LONGITUD_MAXIMA_NOMBRE_DE_CAMPO + 1);
      const res = await enviar(fase.url, [archivo, maximo, { nombre, valor: "1" }]);

      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe("PAYLOAD_TOO_LARGE");
      expect(res.body).not.toContain(nombre);
      expect(serviciosLlamados()).toBe(0);
    });

    it("un nombre enorme (50 KiB): la respuesta sigue siendo breve y no lo contiene", async () => {
      const nombre = "z".repeat(50 * KIB);
      const res = await enviar(fase.url, [archivo, maximo, { nombre, valor: "1" }]);

      expect(res.statusCode).toBe(413);
      expect(res.body.length).toBeLessThan(400);
      expect(res.body).not.toContain("zzzzzzzzzz");
      expect(serviciosLlamados()).toBe(0);
    });
  });

  describe("exceso de campos, archivos y partes: se informa el primer límite alcanzado", () => {
    it("cinco campos (el quinto excede): 413 FST_FIELDS_LIMIT", async () => {
      const res = await enviar(fase.url, [archivo, maximo, decisiones(), { nombre: "a", valor: "1" }, { nombre: "b", valor: "2" }, { nombre: "c", valor: "3" }]);

      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe("FST_FIELDS_LIMIT");
      expect(serviciosLlamados()).toBe(0);
    });

    it("un segundo archivo: 413 FST_FILES_LIMIT", async () => {
      const res = await enviar(fase.url, [archivo, maximo, { nombre: "file", archivo: "otro.ev3", valor: "otro contenido" }]);

      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe("FST_FILES_LIMIT");
      expect(serviciosLlamados()).toBe(0);
    });

    it("siete partes (un archivo y seis campos): se rechaza con 413 de límite, el que se alcance primero", async () => {
      const campos = Array.from({ length: 6 }, (_, i) => ({ nombre: `c${i}`, valor: "1" }));
      const res = await enviar(fase.url, [archivo, ...campos]);

      expect(res.statusCode).toBe(413);
      expect(["FST_FIELDS_LIMIT", "FST_FILES_LIMIT", "FST_PARTS_LIMIT"]).toContain(res.json().error);
      expect(serviciosLlamados()).toBe(0);
    });

    it("partes sin nombre que no cuentan como campos ni archivos: sí alcanzan el límite de partes (FST_PARTS_LIMIT)", async () => {
      const res = await enviar(fase.url, [archivo, maximo, ...Array.from({ length: 6 }, () => ({}))]);

      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe("FST_PARTS_LIMIT");
      expect(serviciosLlamados()).toBe(0);
    });
  });

  describe("el archivo", () => {
    it("con un nombre de campo distinto de «file»: 400, termina (no se bloquea) y no llama al servicio", async () => {
      const res = await enviar(fase.url, [{ nombre: "campoRaroDeArchivo", archivo: "programa.ev3", valor: "x".repeat(200 * KIB) }, maximo]);

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
      expect(res.body).not.toContain("campoRaroDeArchivo");
      expect(serviciosLlamados()).toBe(0);
    });

    it("el de nombre incorrecto va ANTES del correcto: igualmente se rechaza", async () => {
      const res = await enviar(fase.url, [{ nombre: "otro", archivo: "x.ev3", valor: "x" }, archivo, maximo]);

      expect(res.statusCode).toBe(400);
      expect(serviciosLlamados()).toBe(0);
    });

    it("mayor que el máximo GLOBAL de 15 MB: sigue siendo 413 FST_REQ_FILE_TOO_LARGE (el límite por llamada no lo toca)", async () => {
      const grande = Buffer.alloc(ARCHIVO_MAXIMO_GLOBAL_BYTES + 1, 0x61);
      const res = await enviar(fase.url, [{ nombre: "file", archivo: "programa.ev3", valor: grande }, maximo]);

      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe("FST_REQ_FILE_TOO_LARGE");
      expect(serviciosLlamados()).toBe(0);
    });

    it("sin archivo: el 400 de siempre", async () => {
      const res = await enviar(fase.url, [maximo]);

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/Debe adjuntar el archivo/);
      expect(serviciosLlamados()).toBe(0);
    });

    it("extensión no admitida con un nombre larguísimo: el mensaje acota el nombre que devuelve", async () => {
      const nombre = `${"n".repeat(5_000)}.exe`;
      const res = await enviar(fase.url, [{ nombre: "file", archivo: nombre, valor: "x" }, maximo]);

      expect(res.statusCode).toBe(400);
      expect(res.body.length).toBeLessThan(600);
      expect(serviciosLlamados()).toBe(0);
    });
  });
});

describe("importar: la confirmación de relevos y sus decisiones", () => {
  const url = "/competitions/import-meet-events";

  it("501 decisiones (dentro de 64 KiB): 400 con el mensaje de siempre, sin llamar al servicio", async () => {
    const res = await enviar(url, [archivo, maximo, decisiones(501)]);

    expect(res.statusCode).toBe(400);
    expect(res.json().details.fieldErrors.decisiones).toEqual(["Demasiadas decisiones de relevo"]);
    expect(sim.importar).not.toHaveBeenCalled();
  });

  it("500 decisiones llegan al servicio", async () => {
    const res = await enviar(url, [archivo, maximo, decisiones(500)]);

    expect(res.statusCode).toBe(201);
    expect(sim.importar).toHaveBeenCalledTimes(1);
  });

  it("las 500 decisiones caben en el campo de 64 KiB (con decisiones de tipo, las más largas)", () => {
    const peor = JSON.stringify({
      fileHash: HUELLA,
      decisiones: Array.from({ length: 500 }, (_, i) => ({ eventNumber: 9_999 - i, decision: "tipo", testTypeId: "00000000-0000-4000-8000-000000000001" })),
    });
    expect(Buffer.byteLength(peor)).toBeLessThanOrEqual(LIMITES_MULTIPART_IMPORTACION.fieldSize);
  });
});

describe("el lector compartido, aislado (con una solicitud simulada)", () => {
  function solicitudCon(partes: Array<Record<string, unknown>>) {
    const parts = vi.fn(async function* (_opciones?: unknown) {
      for (const parte of partes) yield parte;
    });
    const raw = { unpipe: vi.fn(), resume: vi.fn() };
    return { req: { parts, raw } as never, parts, raw };
  }
  const campo = (extra: Record<string, unknown>) => ({ type: "field", fieldname: "relayDecisions", value: "{}", valueTruncated: false, fieldnameTruncated: false, ...extra });
  const adjunto = { type: "file", fieldname: "file", filename: "p.ev3", toBuffer: async () => Buffer.from("x") };

  it("pide los límites aprobados y NO incluye fileSize (rige el máximo global del archivo)", async () => {
    const { req, parts } = solicitudCon([adjunto]);

    await leerMultipartDeImportacion(req);

    expect(parts).toHaveBeenCalledWith({ limits: { fieldSize: 64 * 1024, fields: 4, files: 1, parts: 6 } });
    const limites = parts.mock.calls[0]?.[0] as unknown as { limits: Record<string, unknown> };
    expect(limites.limits).not.toHaveProperty("fileSize");
  });

  it("rechaza un nombre truncado (fieldnameTruncated) aunque el valor no lo esté", async () => {
    const { req } = solicitudCon([adjunto, campo({ fieldnameTruncated: true })]);

    await expect(leerMultipartDeImportacion(req)).rejects.toMatchObject({ statusCode: 413, code: "PAYLOAD_TOO_LARGE" });
  });

  it("rechaza un valor truncado (valueTruncated)", async () => {
    const { req } = solicitudCon([adjunto, campo({ valueTruncated: true })]);

    await expect(leerMultipartDeImportacion(req)).rejects.toMatchObject({ statusCode: 413, code: "PAYLOAD_TOO_LARGE" });
  });

  it("al rechazar deja de leer el resto de la solicitud", async () => {
    const { req, raw } = solicitudCon([campo({ valueTruncated: true })]);

    await expect(leerMultipartDeImportacion(req)).rejects.toBeDefined();

    expect(raw.unpipe).toHaveBeenCalled();
    expect(raw.resume).toHaveBeenCalled();
  });

  it("solo guarda los campos admitidos", async () => {
    const { req } = solicitudCon([adjunto, campo({ fieldname: "desconocido", value: "1" }), campo({ fieldname: "maxIndividualEventsPerSwimmer", value: "3" })]);

    const { campos } = await leerMultipartDeImportacion(req);

    expect(campos).toEqual({ maxIndividualEventsPerSwimmer: "3" });
    expect([...CAMPOS_ADMITIDOS]).toEqual(["maxIndividualEventsPerSwimmer", "relayDecisions"]);
  });
});

describe("la configuración global de cargas no cambió", () => {
  const leer = (...partes: string[]) => readFileSync(join(__dirname, "..", ...partes), "utf8");

  it("server.ts conserva el registro global de multipart con 15 MB de archivo", () => {
    expect(leer("src", "server.ts")).toContain("await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } });");
  });

  it("la carga masiva de personas conserva su propio límite por llamada", () => {
    expect(leer("src", "modules", "persons", "persons.routes.ts")).toContain("req.file({ limits: { fileSize: LIMITES_XLSX.comprimidoMaxBytes } })");
  });
});
