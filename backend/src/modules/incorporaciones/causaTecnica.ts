/**
 * C-05: la CAUSA de un error técnico de la postulación, reducida a metadatos controlados.
 *
 * Los fallos técnicos de la postulación responden un 503 genérico (`ServiceUnavailableError`). Ese
 * 503 SÍ se registraba —el manejador registra todo 5xx por el canal seguro (`shared/registro.ts`,
 * `errorSeguro`)—, pero sin causa: se perdía qué había fallado. Aquí se adjunta como `cause` del
 * 503 un objeto NUEVO, sin prototipo, con solo dos campos elegidos de LISTAS PERMITIDAS:
 *
 *  - `name`: la clase del error, decidida por `instanceof` contra clases conocidas (nunca leída del
 *    `name` ni del constructor del error, que pueden traer cualquier texto);
 *  - `code`: solo si es un código CONOCIDO de una lista explícita para esa clase (abajo, con su
 *    procedencia). Un código desconocido se omite aunque tenga forma de código: la forma no
 *    garantiza que no sea un valor arbitrario. Las listas son fijas; nunca se construyen con lo
 *    que llega en el error.
 *
 * Nunca se copian el mensaje, la pila, `meta`, los argumentos ni el error original: el 503 no lo
 * conserva. La respuesta HTTP no cambia (el cuerpo de un 5xx no incluye la causa).
 */
import { Prisma } from "@prisma/client";
import { AppError, ServiceUnavailableError } from "../../shared/errors";

type Clase = abstract new (...args: never[]) => unknown;

/** Clases conocidas, en orden: las más específicas primero. El nombre es FIJO, no se lee del error. */
const CLASES: readonly (readonly [Clase, string])[] = [
  [Prisma.PrismaClientKnownRequestError, "PrismaClientKnownRequestError"],
  [Prisma.PrismaClientUnknownRequestError, "PrismaClientUnknownRequestError"],
  [Prisma.PrismaClientRustPanicError, "PrismaClientRustPanicError"],
  [Prisma.PrismaClientInitializationError, "PrismaClientInitializationError"],
  [Prisma.PrismaClientValidationError, "PrismaClientValidationError"],
  [AppError, "AppError"],
  [TypeError, "TypeError"],
  [RangeError, "RangeError"],
  [ReferenceError, "ReferenceError"],
  [SyntaxError, "SyntaxError"],
  [Error, "Error"],
];

/**
 * Prisma, errores de consulta conocidos (`PrismaClientKnownRequestError.code`). Procedencia: la
 * referencia de errores de Prisma ORM (serie P2xxx), limitada a los que una transacción de la
 * postulación puede producir: unicidad, clave foránea, nulos, restricción, valor largo, registro
 * inexistente, consulta cruda fallida, tiempo de espera del pool y de la transacción, y conflicto
 * de escritura o interbloqueo.
 */
const CODIGOS_PRISMA_CONSULTA: ReadonlySet<string> = new Set([
  "P2000", "P2002", "P2003", "P2004", "P2010", "P2011", "P2014", "P2024", "P2025", "P2028", "P2034",
]);
/**
 * Prisma, errores de inicialización y de conexión (`PrismaClientInitializationError.errorCode`).
 * Procedencia: la misma referencia (serie P1xxx): base inalcanzable, tiempo de conexión agotado,
 * operaciones agotadas y conexión cerrada por el servidor.
 */
const CODIGOS_PRISMA_INICIO: ReadonlySet<string> = new Set(["P1001", "P1002", "P1008", "P1017"]);
/**
 * Errores de sistema de Node (`err.code`). Procedencia: la documentación de Node.js, «Common system
 * errors» y los errores de DNS (`ENOTFOUND`, `EAI_AGAIN`), limitados a la red con la base.
 */
const CODIGOS_SISTEMA: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH",
]);
/**
 * Códigos de ESTA aplicación (`AppError.code`). Procedencia: las clases de `shared/errors.ts` y los
 * códigos de dominio de C-05 (`incorporaciones/*` y `swimmer-assignment/membresias.protocolo.ts`).
 * Un código nuevo hay que agregarlo aquí a mano.
 */
const CODIGOS_APLICACION: ReadonlySet<string> = new Set([
  // shared/errors.ts
  "VALIDATION_ERROR", "UNAUTHORIZED", "PAYLOAD_TOO_LARGE", "FORBIDDEN", "ACCOUNT_LOCKED", "NOT_FOUND", "CONFLICT",
  "SERVICE_UNAVAILABLE", "PASSWORD_CHANGE_REQUIRED",
  // C-05
  "CLUB_NO_DISPONIBLE", "COINCIDENCIA_ELIMINADA", "CONFIRMACION_REQUERIDA", "CONFLICTO_DE_FECHAS", "CUOTA_AGOTADA", "DUPLICADO",
  "FECHA_FUTURA", "HISTORIAL_INCOMPLETO", "IDEMPOTENCIA_CONFLICTO", "IDEMPOTENCIA_REQUERIDA", "INTENTO_INTERRUMPIDO",
  "MEMBRESIA_ACTIVA_FUERA_DE_PERIODO", "MEMBRESIA_NO_ACTIVA", "OPERACION_EN_CURSO", "PASO_NO_DISPONIBLE", "PASO_NO_ENCONTRADO",
  "PASO_VENCIDO", "PASO_YA_UTILIZADO", "PERIODO_EN_EL_PASADO", "PERIODO_FECHAS_INVALIDAS", "PERIODO_SOLAPADO", "PERIODO_YA_CERRADO",
  "PERSONA_DISTINTA", "PERSONA_NO_REGISTRADA", "PERSONA_YA_REGISTRADA", "REVISAR_DE_NUEVO", "RUN_INVALIDO", "SOLICITUD_YA_RESUELTA",
  "YA_PERTENECE",
]);

export interface CausaTecnica {
  name: string;
  code?: string;
}

export function causaSaneada(err: unknown): CausaTecnica {
  const nombre = CLASES.find(([clase]) => err instanceof clase)?.[1] ?? "NoEsError";
  const causa = Object.create(null) as CausaTecnica;
  causa.name = nombre;

  let codigo: unknown;
  let conocidos: ReadonlySet<string> | null = null;
  if (nombre === "PrismaClientKnownRequestError") {
    codigo = (err as { code?: unknown }).code;
    conocidos = CODIGOS_PRISMA_CONSULTA;
  } else if (nombre === "PrismaClientInitializationError") {
    codigo = (err as { errorCode?: unknown }).errorCode;
    conocidos = CODIGOS_PRISMA_INICIO;
  } else if (nombre === "AppError") {
    codigo = (err as AppError).code;
    conocidos = CODIGOS_APLICACION;
  } else if (nombre !== "NoEsError" && !nombre.startsWith("Prisma")) {
    codigo = (err as { code?: unknown }).code;
    conocidos = CODIGOS_SISTEMA;
  }
  // Pertenencia EXACTA a la lista: un código desconocido se omite y queda solo la clase.
  if (conocidos && typeof codigo === "string" && conocidos.has(codigo)) causa.code = codigo;
  return causa;
}

/** El 503 genérico de siempre, con la causa saneada para el registro. */
export function errorTecnico(err: unknown): ServiceUnavailableError {
  const e = new ServiceUnavailableError();
  Object.defineProperty(e, "cause", { value: causaSaneada(err), enumerable: false, writable: true, configurable: true });
  return e;
}
