import { AppError } from "./errors";
import { translatePrismaError } from "./prismaErrors";

/**
 * Texto de un error que SÍ puede leer quien usa el sistema, para los lugares donde un
 * fallo no corta la respuesta sino que se anota por fila (carga masiva de personas,
 * asignación masiva de nadadores).
 *
 * Antes cada fila copiaba `err.message`. Un error de Prisma trae la consulta, sus
 * parámetros y a veces fragmentos del dato que la provocó; uno del sistema, rutas
 * del servidor. Como el resultado se devuelve al navegador, un fallo interno se
 * convertía en una filtración, y el mismo texto no se anotaba en ningún registro de
 * forma controlada.
 *
 * QUÉ SE PUBLICA, y solo esto:
 *
 *   - un `AppError`: son textos escritos por este sistema para quien opera
 *     (validaciones, conflictos de dominio, «no encontrado»), y se conservan tal cual;
 *   - un error de Prisma que `translatePrismaError` reconoce (duplicado, vínculo
 *     obligatorio, base no disponible…), con SU mensaje redactado, nunca el del motor.
 *
 * Todo lo demás —`TypeError`, errores de Prisma sin traducción, fallos del sistema de
 * archivos— responde un mensaje genérico, y el detalle técnico queda en el registro
 * interno sin su texto.
 */
export const MENSAJE_FILA_INTERNA = "No se pudo procesar esta fila por un error interno. Informe al administrador con la fecha y hora de la carga.";

export function mensajePublicable(err: unknown, contexto: string, referencia?: string | number): string {
  if (err instanceof AppError) return err.message;

  const traducido = translatePrismaError(err);
  if (traducido) return traducido.message;

  registrarFalloInesperado(err, contexto, referencia);
  return MENSAJE_FILA_INTERNA;
}

/**
 * Una sola línea JSON con un nombre de evento estable. Clase y código, NUNCA el
 * mensaje ni la traza: el texto de un error de Prisma lleva la consulta y sus valores,
 * y estos registros suelen enviarse a un agregador externo. Mismo criterio que
 * `audit_write_failed`.
 */
function registrarFalloInesperado(err: unknown, contexto: string, referencia?: string | number): void {
  const codigo = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      event: "fila_fallo_inesperado",
      level: "error",
      contexto,
      ...(referencia !== undefined ? { referencia } : {}),
      errorName: err instanceof Error ? err.constructor.name : typeof err,
      ...(codigo ? { errorCode: codigo } : {}),
    })
  );
}
