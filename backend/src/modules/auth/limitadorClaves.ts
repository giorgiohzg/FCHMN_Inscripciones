/**
 * C-02: claves y parámetros del limitador de login. Funciones PURAS: sin base de datos ni
 * entorno, para poder probarlas en aislamiento. La parte con estado está en
 * `limitadorLogin.ts`.
 *
 * TRES CLAVES por intento:
 *  - `origen`: la IP de la solicitud (IPv4, o el /64 en IPv6; ver `origenParaLimites`).
 *  - `cuenta`: el nombre de usuario RECIBIDO, exista o no la cuenta. El limitador no sabe si
 *    existe, así que no puede delatarlo.
 *  - `par`: los dos juntos.
 *
 * En la base se guarda solo `HMAC-SHA256(AUTH_LIMITER_SECRET, propósito ‖ valor)`, con el
 * propósito separado por tipo: el mismo texto nunca produce la misma huella en dos tipos.
 */
import crypto from "node:crypto";

export type TipoDeClave = "origen" | "cuenta" | "par";

/**
 * PERFIL FUNCIONAL APROBADO (política B). Cambiarlo es una decisión funcional, no un ajuste.
 */
export const PERFIL = {
  /** Par usuario–origen: fallos en una ventana DESLIZANTE. */
  parMaxFallos: 5,
  parVentanaMs: 15 * 60_000,
  /** Origen: fallos en una ventana FIJA que abre su primer fallo. */
  origenMaxFallos: 50,
  origenVentanaMs: 60 * 60_000,
  /** Cuenta: fallos VERIFICADOS en una ventana fija que activan el periodo protegido. */
  cuentaUmbralProteccion: 20,
  cuentaVentanaMs: 60 * 60_000,
  /** Periodo protegido: dura esto desde el último fallo verificado (se prolonga). */
  proteccionMs: 60 * 60_000,
  /** Política B: durante la protección, cada fallo de un par impone su PROPIA espera. */
  esperaProtegidaMs: 15 * 60_000,
} as const;

/** Parámetros técnicos (no funcionales). Las cifras de capacidad son candidatas. */
export const TECNICO = {
  /** Vida de una reserva: cubre con holgura la cola del semáforo y una derivación. */
  reservaMs: 30_000,
  /** Fallos conservados por par: el umbral nunca necesita más. */
  fallosRetenidosPorPar: 5,
  /** Rechazos: un aviso agregado en la auditoría como mucho cada este tiempo, por clave. */
  avisoDeRechazosMs: 15 * 60_000,
  fragmentos: 16,
  cupoClavesPorFragmento: 6_250,
  cupoReservas: 200,
  avisoOcupacion: 0.8,
  lockTimeout: "2s",
  reintentos: 2,
  loteDeMantenimiento: 500,
  intervaloDeMantenimientoMs: 5 * 60_000,
} as const;

function hmac(secreto: string, partes: readonly string[]): Buffer {
  // JSON: separación inequívoca entre partes, cualquiera sea su contenido.
  return crypto.createHmac("sha256", secreto).update(JSON.stringify(partes)).digest();
}

/** Huella del secreto: identifica con qué secreto se calcularon las claves, sin revelarlo. */
export function huellaDelSecreto(secreto: string): Buffer {
  return hmac(secreto, ["fchmn-limitador", "huella", "v1"]).subarray(0, 8);
}

export interface ClavesDeIntento {
  origen: Buffer;
  cuenta: Buffer;
  par: Buffer;
}

export function claveDe(secreto: string, tipo: TipoDeClave, valores: readonly string[]): Buffer {
  return hmac(secreto, ["fchmn-limitador", "v1", tipo, ...valores]);
}

export function clavesDeIntento(secreto: string, username: string, origen: string): ClavesDeIntento {
  return {
    origen: claveDe(secreto, "origen", [origen]),
    cuenta: claveDe(secreto, "cuenta", [username]),
    par: claveDe(secreto, "par", [username, origen]),
  };
}

/**
 * Clave del bloqueo consultivo (`pg_advisory_xact_lock(bigint)`) de una clave. Dos claves que
 * coincidan aquí solo se serializan de más; nunca se confunden sus filas.
 */
export function claveDeBloqueo(clave: Buffer): bigint {
  return clave.readBigInt64BE(0);
}

/** Fragmento de capacidad de una clave nueva (se guarda en la fila y no se recalcula). */
export function fragmentoDe(clave: Buffer): number {
  return (clave[8] ?? 0) % TECNICO.fragmentos;
}

export const recursoDeFragmento = (fragmento: number): string => `claves:${String(fragmento).padStart(2, "0")}`;
export const RECURSO_RESERVAS = "reservas";
