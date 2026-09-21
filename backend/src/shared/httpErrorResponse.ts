import { AppError } from "./errors";
import { translatePrismaError } from "./prismaErrors";

/**
 * Resolución de la respuesta HTTP de un error, extraída del manejador global
 * de `server.ts`.
 *
 * Vive aquí, y no incrustada en el `setErrorHandler`, por dos razones:
 *
 *  1. La traducción de errores de Prisma solo servía donde el servicio
 *     llamaba explícitamente a `withTranslatedPrismaErrors`. Todos los demás
 *     —la mayoría— mandaban el P2002 crudo al manejador global, que no lo
 *     reconocía y respondía 500 "Error interno del servidor": exactamente el
 *     problema que la traducción existía para resolver. Ahora el traductor es
 *     el último filtro antes de declarar un error interno, así que cubre
 *     también lo que ningún servicio previó.
 *  2. Es la misma función que usa el servidor, así que una prueba puede
 *     ejercitar la decisión real en vez de una copia.
 */
export interface ErrorHttpResponse {
  status: number;
  body: { error: string; message: string; details?: unknown };
  /** Cómo registrarlo: `error` solo para lo verdaderamente inesperado. */
  log: "error" | "warn" | null;
}

interface ErrorConEstado {
  statusCode?: number;
  code?: string;
  message?: string;
}

export function resolveErrorResponse(err: unknown): ErrorHttpResponse {
  if (err instanceof AppError) {
    /**
     * Un `AppError` 4xx es una respuesta prevista y no se registra. Uno de
     * 5xx sí: `ServiceUnavailableError` significa que la base no responde, y
     * pasar eso en silencio dejaría una caída sin rastro en los registros
     * justo cuando hace falta mirarlos.
     */
    return {
      status: err.statusCode,
      body: { error: err.code, message: err.message, details: err.details },
      log: err.statusCode >= 500 ? "error" : null,
    };
  }

  // Errores con estado propio que NO son de la aplicación: rate limiting
  // (429), payload demasiado grande (413), JSON inválido (400)... Antes
  // caían en el `else` y se respondían como 500: un cliente frenado por el
  // rate limit recibía "Error interno del servidor".
  const conEstado = err as ErrorConEstado;
  if (typeof conEstado?.statusCode === "number" && conEstado.statusCode >= 400 && conEstado.statusCode < 500) {
    return {
      status: conEstado.statusCode,
      body: { error: conEstado.code ?? "REQUEST_ERROR", message: conEstado.message ?? "Solicitud inválida" },
      log: null,
    };
  }

  /**
   * Último filtro antes del 500: una violación de índice único o de clave
   * foránea es un conflicto de datos, no una falla del sistema. Se registra
   * como aviso —no como error— para no perder la traza, ya que aquí llega
   * justamente lo que ningún servicio esperaba.
   */
  const traducido = translatePrismaError(err);
  if (traducido) {
    return {
      status: traducido.statusCode,
      body: { error: traducido.code, message: traducido.message, details: traducido.details },
      // Mismo criterio que para un `AppError`: un conflicto de datos es un
      // aviso, pero una base que no responde (503) es un error que tiene que
      // quedar registrado como tal.
      log: traducido.statusCode >= 500 ? "error" : "warn",
    };
  }

  return { status: 500, body: { error: "INTERNAL_ERROR", message: "Error interno del servidor" }, log: "error" };
}
