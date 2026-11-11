/**
 * Registro de la API: qué se escribe de una petición y de un error (auditoría AUD-03).
 *
 * Dos defectos, los dos por quedarse con el comportamiento por omisión de Fastify:
 *
 *  1. El serializador de la petición registra `url` COMPLETA, con su cadena de consulta. Los
 *     listados aceptan `search` y ahí viaja un nombre, un RUN o un RUT
 *     (`GET /persons?search=...`), de modo que cada búsqueda quedaba escrita en los registros
 *     de acceso, que suelen salir hacia un agregador externo.
 *  2. Los errores se registraban con el serializador estándar, que escribe el mensaje, la pila
 *     y todas las propiedades. El mensaje de un error de Prisma trae la consulta y los VALORES
 *     que la provocaron, en varias líneas: quitar la primera línea de la pila no los elimina.
 *
 * La regla es una LISTA EXPLÍCITA de lo que se escribe, no una lista de lo que se quita:
 * lo que no está aquí no se registra, aunque mañana un error traiga una propiedad nueva.
 *
 * La correlación se conserva: cada línea lleva su `reqId`, y el error se registra con el
 * registro de la petición (`req.log`), no con el global.
 */
import { LogController, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { origenIpDe } from "./ipCliente";

/** Solo identificadores: letras, dígitos, `_`, `.`, `$` y `-`. Nada con espacios ni signos de valores. */
const IDENTIFICADOR = /^[\w.$-]{1,80}$/;

function identificador(valor: unknown): string | undefined {
  return typeof valor === "string" && IDENTIFICADOR.test(valor) ? valor : undefined;
}

/** La ruta de la petición, sin la cadena de consulta ni el fragmento. */
export function urlSinConsulta(url: string): string {
  const corte = url.search(/[?#]/);
  return corte === -1 ? url : url.slice(0, corte);
}

/**
 * La petición tal como se registra: los mismos campos que escribe Fastify por omisión
 * —método, ruta, versión, host y origen— con la ruta SIN la cadena de consulta. Las cabeceras
 * y el cuerpo nunca se han registrado y siguen sin registrarse.
 */
export function serializarPeticion(
  req: Pick<FastifyRequest, "method" | "url" | "headers" | "host" | "ip" | "socket"> & { raw?: FastifyRequest["raw"] }
) {
  return {
    method: req.method,
    url: urlSinConsulta(req.url),
    version: req.headers?.["accept-version"],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
    // De dónde salió `remoteAddress` (`shared/ipCliente.ts`): metadato interno, sin la IP.
    origenIp: origenIpDe(req.raw),
  };
}

/** Las líneas de la pila que son marcos de llamada (`    at función (archivo:línea:columna)`). */
const MARCO_DE_PILA = /^ {4}at [^\n]{1,300}:\d+:\d+\)?$/;
const MAXIMO_DE_MARCOS = 8;

function marcosDeLaPila(stack: unknown): string[] | undefined {
  if (typeof stack !== "string") return undefined;
  const marcos = stack.split("\n").filter((linea) => MARCO_DE_PILA.test(linea));
  return marcos.length > 0 ? marcos.slice(0, MAXIMO_DE_MARCOS).map((m) => m.trim()) : undefined;
}

/** `meta.target` de Prisma: nombres de columnas o de índice, nunca valores. */
function destinoDePrisma(target: unknown): string | string[] | undefined {
  if (typeof target === "string") return identificador(target);
  if (Array.isArray(target) && target.length > 0 && target.length <= 10) {
    const nombres = target.map(identificador);
    return nombres.every((n): n is string => n !== undefined) ? nombres : undefined;
  }
  return undefined;
}

/**
 * Un error tal como se registra. Campos, y SOLO estos:
 *
 *  - `tipo`: la clase del error.
 *  - `codigo`: su `code` si es un identificador (`P2002`, `ECONNREFUSED`, `VALIDATION_ERROR`…).
 *  - `estado`: su `statusCode`, si lo tiene.
 *  - `tipoCausa` y `codigoCausa`: lo mismo de `cause`, sin su mensaje.
 *  - Solo errores de Prisma: `versionDelCliente`, `modelo` y `destino` (columnas o índice).
 *  - Solo errores que NO son de Prisma: hasta 8 marcos de la pila (funciones y archivos).
 *
 * NUNCA: el mensaje, el resto de `meta`, los argumentos de la consulta ni la pila de un error
 * de Prisma. Su mensaje y su marco de código pueden ocupar varias líneas y llevar valores, así
 * que no se intenta limpiarlos: no se escriben. Los marcos de la pila de otros errores se
 * eligen por su FORMA (`    at ... archivo:línea:columna`), no por posición.
 */
export function errorSeguro(err: unknown): Record<string, unknown> {
  if (typeof err !== "object" || err === null) return { tipo: typeof err };

  const e = err as { name?: unknown; code?: unknown; statusCode?: unknown; stack?: unknown; cause?: unknown; clientVersion?: unknown; meta?: unknown };
  const tipo = identificador(err.constructor?.name) ?? identificador(e.name) ?? "Error";
  const esDePrisma = tipo.startsWith("PrismaClient") || (typeof e.name === "string" && e.name.startsWith("PrismaClient"));

  const salida: Record<string, unknown> = { tipo };
  const codigo = identificador(e.code);
  if (codigo) salida.codigo = codigo;
  if (typeof e.statusCode === "number" && Number.isInteger(e.statusCode) && e.statusCode >= 100 && e.statusCode <= 599) {
    salida.estado = e.statusCode;
  }

  if (typeof e.cause === "object" && e.cause !== null) {
    const causa = e.cause as { name?: unknown; code?: unknown };
    const tipoCausa = identificador((e.cause as object).constructor?.name) ?? identificador(causa.name);
    if (tipoCausa) salida.tipoCausa = tipoCausa;
    const codigoCausa = identificador(causa.code);
    if (codigoCausa) salida.codigoCausa = codigoCausa;
  }

  if (esDePrisma) {
    if (typeof e.clientVersion === "string" && /^[\d.]{1,20}$/.test(e.clientVersion)) salida.versionDelCliente = e.clientVersion;
    if (typeof e.meta === "object" && e.meta !== null) {
      const meta = e.meta as { modelName?: unknown; target?: unknown };
      const modelo = identificador(meta.modelName);
      if (modelo) salida.modelo = modelo;
      const destino = destinoDePrisma(meta.target);
      if (destino) salida.destino = destino;
    }
  } else {
    const marcos = marcosDeLaPila(e.stack);
    if (marcos) salida.pila = marcos;
  }

  return salida;
}

/**
 * Los mensajes que Fastify arma por su cuenta y que NO pasan por los serializadores.
 *
 * Tres de las líneas internas de Fastify llevan texto armado a mano: el 404 escribe
 * `Route GET:/ruta?search=... not found` —con la cadena de consulta completa—, y el registro
 * de un error por omisión y el de un fallo al escribir las cabeceras usan `error.message` como
 * mensaje de la línea. Aquí se reemplazan: la ruta del 404 va sin consulta y los demás llevan un
 * texto fijo; el error viaja en `err`, que sí pasa por `errorSeguro`.
 *
 * No cubre un aviso de Fastify por un fallo de programación (`Reply was already sent`, que
 * nombra la URL cruda): no ocurre en el uso normal y no hay un punto de enganche para él.
 */
export class ControladorDeRegistroSeguro extends LogController {
  override routeNotFound(request: FastifyRequest, _reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    request.log.info(`Route ${request.raw.method}:${urlSinConsulta(request.raw.url ?? "")} not found`);
  }

  override defaultErrorLog(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    if (reply.statusCode >= 500) reply.log.error({ req: request, res: reply, err: error }, "error de solicitud");
    else reply.log.info({ res: reply, err: error }, "error de solicitud");
  }

  override writeHeadError(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    reply.log.warn({ req: request, res: reply, err: error }, "error al escribir las cabeceras");
  }
}

/**
 * Opciones del registrador de Fastify. `stream` existe para que las pruebas capturen las
 * líneas en memoria; en producción no se pasa y se escribe en la salida estándar, como antes.
 *
 * El serializador `err` se reemplaza para TODO el servidor: cualquier `{ err }` que se registre
 * —también desde Fastify o un plugin— pasa por `errorSeguro`.
 */
export function opcionesDeRegistro(stream?: NodeJS.WritableStream): NonNullable<FastifyServerOptions["logger"]> {
  // Doble conversión: los tipos de Fastify piden que `err` devuelva `{ type, message, stack }`, que es
  // justo lo que `errorSeguro` deja de entregar.
  return {
    serializers: { req: serializarPeticion, err: errorSeguro },
    ...(stream ? { stream } : {}),
  } as unknown as NonNullable<FastifyServerOptions["logger"]>;
}
