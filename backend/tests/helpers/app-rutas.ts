/**
 * Utilidades de las pruebas de RUTAS sin base de datos (SEC-01).
 *
 * Construye un Fastify mínimo con el MISMO manejador de errores del servidor
 * (`resolveErrorResponse`) y el MISMO registro de multipart (15 MB de archivo), y un «servicio espía»
 * que permite afirmar que, tras un rechazo, ninguna función de negocio llegó a llamarse.
 *
 * Todo lo que se simula aquí es SIMULADO: la autenticación se sustituye en cada archivo de prueba y
 * los servicios son espías. Lo observado contra la base real está en las pruebas de integración.
 */
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import multipart from "@fastify/multipart";
import { resolveErrorResponse } from "../../src/shared/httpErrorResponse";

/** El mismo máximo global de archivo que registra `server.ts`. */
export const ARCHIVO_MAXIMO_GLOBAL_BYTES = 15 * 1024 * 1024;

export async function appConRutas(plugins: FastifyPluginAsync[]): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = resolveErrorResponse(err);
    reply.status(status).send(body);
  });
  await app.register(multipart, { limits: { fileSize: ARCHIVO_MAXIMO_GLOBAL_BYTES } });
  for (const plugin of plugins) await app.register(plugin);
  await app.ready();
  return app;
}

/** Falla con un mensaje claro si la solicitud no termina: un rechazo que deja la solicitud colgada es un defecto. */
export async function conPlazo<T>(promesa: Promise<T>, milisegundos = 5_000): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const plazo = new Promise<never>((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error(`La solicitud no terminó en ${milisegundos} ms: quedó bloqueada.`)), milisegundos);
  });
  try {
    return await Promise.race([promesa, plazo]);
  } finally {
    clearTimeout(temporizador);
  }
}

export interface ParteMultipart {
  /** Nombre del campo. Si falta, la parte va sin `Content-Disposition` (el analizador la descarta). */
  nombre?: string;
  valor?: string | Buffer;
  /** Si se indica, la parte es un archivo con ese nombre de archivo. */
  archivo?: string;
}

const FRONTERA = "----frontera-sintetica-sec01";

export const CABECERA_MULTIPART = { "content-type": `multipart/form-data; boundary=${FRONTERA}` };

export function cuerpoMultipart(partes: ParteMultipart[]): Buffer {
  const trozos: Buffer[] = [];
  for (const parte of partes) {
    let cabecera = `--${FRONTERA}\r\n`;
    if (parte.nombre === undefined) {
      cabecera += "X-Parte-Sin-Nombre: 1\r\n\r\n";
    } else if (parte.archivo !== undefined) {
      cabecera += `Content-Disposition: form-data; name="${parte.nombre}"; filename="${parte.archivo}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    } else {
      cabecera += `Content-Disposition: form-data; name="${parte.nombre}"\r\n\r\n`;
    }
    trozos.push(Buffer.from(cabecera, "utf8"), Buffer.isBuffer(parte.valor) ? parte.valor : Buffer.from(parte.valor ?? "", "utf8"), Buffer.from("\r\n", "utf8"));
  }
  trozos.push(Buffer.from(`--${FRONTERA}--\r\n`, "utf8"));
  return Buffer.concat(trozos);
}
