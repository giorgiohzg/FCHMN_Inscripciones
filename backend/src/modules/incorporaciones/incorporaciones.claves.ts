/**
 * C-05: parámetros y claves de las incorporaciones por RUN. Funciones PURAS: sin base de datos
 * ni entorno, para poder probarlas en aislamiento.
 *
 * HUELLAS CON PROPÓSITO PROPIO. Se usa el mismo secreto que el limitador de login
 * (`AUTH_LIMITER_SECRET`), pero con un prefijo distinto (`fchmn-incorporaciones`) y la
 * operación como parte del mensaje: una huella de incorporación nunca coincide con una clave
 * del limitador ni con la de otra operación, aunque el texto de entrada sea el mismo. Este
 * módulo no toca el limitador ni su estado.
 *
 * No se guarda el RUN en claro para comparar contenidos: el universo de RUN es pequeño, así que
 * un hash sin secreto sería reversible por enumeración.
 */
import crypto from "node:crypto";

/** Cuota funcional aprobada: intentos por club y por día calendario de Santiago. */
export const CUOTA_DIARIA_POR_CLUB = 30;

/** Parámetros técnicos (no funcionales). */
export const PLAZOS = {
  /** Un intento `en_curso` más antiguo que esto se considera interrumpido. T2 dura mucho menos. */
  enCursoMs: 2 * 60_000,
  /** Vigencia del segundo paso (nombre y apellido) desde que el RUN resultó no registrado. */
  segundoPasoMs: 15 * 60_000,
  /** Tope de la transacción de resolución (T2); muy por debajo de `enCursoMs`. */
  resolucionMs: 10_000,
  /** Mantenimiento en el proceso de la API: al arrancar y cada este tiempo, en lotes. */
  intervaloMantenimientoMs: 5 * 60_000,
  loteMantenimiento: 500,
} as const;

/** Cabecera `Idempotency-Key`: lo que admite `intentos_incorporacion_clave_check` (8 a 64). */
export const FORMATO_CLAVE_IDEMPOTENCIA = /^[A-Za-z0-9_-]{8,64}$/;

function hmac(secreto: string, partes: readonly string[]): Buffer {
  // JSON: separación inequívoca entre partes, cualquiera sea su contenido.
  return crypto.createHmac("sha256", secreto).update(JSON.stringify(["fchmn-incorporaciones", "v1", ...partes])).digest();
}

/** Contenido de una postulación: la operación, el club y el RUN normalizado (32 bytes). */
export function huellaDePostulacion(secreto: string, clubId: string, runNormalizado: string): Buffer {
  return hmac(secreto, ["postular", clubId, runNormalizado]);
}

/** Contenido del segundo paso: ligado al intento original y a los nombres declarados. */
export function huellaDeAlta(secreto: string, intentoId: string, nombres: string, apellidos: string): Buffer {
  return hmac(secreto, ["completar-alta", intentoId, nombres, apellidos]);
}

/**
 * Claves de los bloqueos consultivos (`pg_advisory_xact_lock(hashtextextended(clave, 0))`).
 * Que dos claves coincidan en su número solo serializa de más; nunca mezcla filas.
 *
 * ORDEN DE ADQUISICIÓN (para no invertir bloqueos entre vías): club → RUN → persona → filas.
 * La cuota vive solo en T1, una transacción aparte, y no se cruza con las demás.
 */
export const CLAVES_DE_BLOQUEO = {
  cuota: (clubId: string, dia: string) => `c05:cuota:${clubId}:${dia}`,
  club: (clubId: string) => `c05:club:${clubId}`,
  run: (runNormalizado: string) => `c05:run:${runNormalizado}`,
  persona: (personId: string) => `c05:persona:${personId}`,
  periodos: () => "c05:periodos",
} as const;
