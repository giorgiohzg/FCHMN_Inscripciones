import argon2 from "argon2";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "../../shared/errors";

// Argon2id — recomendado por OWASP sobre bcrypt para nuevos proyectos.
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // ~19 MB, valores OWASP 2023
  timeCost: 2,
  parallelism: 1,
};

/**
 * SEMÁFORO DE ARGON2 (C-02 / C-04).
 *
 * Cada derivación de Argon2 reserva ~19 MB y tiempo de CPU. Sin tope, una ráfaga de
 * logins podía agotar la memoria del proceso. Toda derivación —verificar, calcular un hash,
 * la verificación ficticia y la generación de su hash— pasa por aquí. Cada OPERACIÓN ocupa
 * UN cupo para todas sus derivaciones: la verificación ficticia genera su hash dentro del
 * suyo, y el cambio de contraseña (C-04) verifica la actual y calcula la nueva sin soltarlo.
 *
 *  - `max` derivaciones en curso a la vez; las siguientes esperan en una cola de `cola`.
 *  - Con la cola llena, o si la espera supera `esperaMs`, se lanza `SaturacionArgon2`
 *    SIN calcular nada. Quien llama lo trata como un resultado NEUTRO: no es una
 *    contraseña incorrecta.
 *  - Una excepción de la biblioteca se lanza como `ErrorTecnicoArgon2`. Tampoco es una
 *    contraseña incorrecta: antes `verifyPassword` la convertía en `false` y el cambio de
 *    contraseña (C-04) la contaba como un fallo.
 *
 * SIN ADQUISICIONES ANIDADAS: dentro de un cupo se usan solo las primitivas internas, que
 * no adquieren. Pedir otro cupo desde dentro de uno lanza un error de programación (con
 * todos los cupos ocupados por llamadas anidadas, el proceso quedaría bloqueado).
 *
 * Las cifras por omisión (4 en curso, 16 en cola, 10 s) son CANDIDATAS: se configuran con
 * `configurarSemaforoArgon2` desde la configuración del servidor.
 */
export interface ConfiguracionSemaforoArgon2 {
  max: number;
  cola: number;
  esperaMs: number;
}

/**
 * No hay cupo para derivar Argon2 ahora: cola llena o espera vencida. Nada se calculó.
 * Es un 503: el manejador de errores lo responde así en cualquier ruta.
 */
export class SaturacionArgon2 extends AppError {
  constructor() {
    super(503, "SERVICE_UNAVAILABLE", "El servicio está ocupado en este momento. Intente nuevamente en unos instantes.");
    this.name = "SaturacionArgon2";
  }
}

/** La biblioteca de Argon2 falló. No dice nada sobre la contraseña. También es un 503. */
export class ErrorTecnicoArgon2 extends AppError {
  constructor(causa: unknown) {
    super(503, "SERVICE_UNAVAILABLE", "El servicio no está disponible en este momento. Intente nuevamente en unos instantes.");
    this.name = "ErrorTecnicoArgon2";
    (this as { cause?: unknown }).cause = causa;
  }
}

/** ¿Es un error de Argon2 que debe tratarse como resultado neutro (503)? */
export function esErrorNeutroDeArgon2(err: unknown): boolean {
  return err instanceof SaturacionArgon2 || err instanceof ErrorTecnicoArgon2;
}

let configuracion: ConfiguracionSemaforoArgon2 = { max: 4, cola: 16, esperaMs: 10_000 };
let enCurso = 0;
const enEspera: Array<{ conceder: () => void; temporizador: NodeJS.Timeout }> = [];
const dentroDeUnCupo = new AsyncLocalStorage<true>();

export function configurarSemaforoArgon2(nueva: ConfiguracionSemaforoArgon2): void {
  configuracion = { ...nueva };
}

/** Estado actual, para pruebas y mediciones. */
export function estadoSemaforoArgon2(): { enCurso: number; enEspera: number } & ConfiguracionSemaforoArgon2 {
  return { enCurso, enEspera: enEspera.length, ...configuracion };
}

function adquirir(): Promise<void> {
  if (enCurso < configuracion.max) {
    enCurso++;
    return Promise.resolve();
  }
  if (enEspera.length >= configuracion.cola) return Promise.reject(new SaturacionArgon2());
  return new Promise<void>((resolver, rechazar) => {
    const turno = {
      conceder: () => {
        clearTimeout(turno.temporizador);
        resolver();
      },
      temporizador: setTimeout(() => {
        const i = enEspera.indexOf(turno);
        if (i >= 0) enEspera.splice(i, 1);
        rechazar(new SaturacionArgon2());
      }, configuracion.esperaMs),
    };
    enEspera.push(turno);
  });
}

function liberar(): void {
  const siguiente = enEspera.shift();
  // El cupo pasa directamente al siguiente: `enCurso` no cambia.
  if (siguiente) siguiente.conceder();
  else enCurso--;
}

/** Primitivas que SOLO existen dentro de un cupo. No adquieren nada. */
export interface OperacionesArgon2 {
  verificar(hash: string, plain: string): Promise<"correcta" | "incorrecta">;
  hashear(plain: string): Promise<string>;
  hashFicticio(): Promise<string>;
}

async function verificarPrimitiva(hash: string, plain: string): Promise<"correcta" | "incorrecta"> {
  let coincide: boolean;
  try {
    coincide = await argon2.verify(hash, plain);
  } catch (err) {
    throw new ErrorTecnicoArgon2(err);
  }
  return coincide ? "correcta" : "incorrecta";
}

async function hashearPrimitiva(plain: string): Promise<string> {
  try {
    return await argon2.hash(plain, ARGON2_OPTIONS);
  } catch (err) {
    throw new ErrorTecnicoArgon2(err);
  }
}

/**
 * VERIFICACIÓN FICTICIA: el mismo trabajo de Argon2 que una verificación real, contra un
 * hash que no pertenece a nadie.
 *
 * El login responde igual cuando no hay una contraseña real que comprobar —usuario
 * inexistente, persona inutilizable, bloqueo temporal vigente—, y sin este cálculo esas
 * respuestas serían las únicas que no pagan el coste de Argon2: la diferencia de tiempo
 * delataría qué nombres de usuario existen y cuáles están bloqueados.
 *
 *  - El hash se calcula UNA vez por proceso, de forma perezosa, con los mismos parámetros
 *    que `hashPassword` (el coste de verificar lo fijan los del hash). Generar uno nuevo
 *    por petición duplicaría el coste y abriría a cualquiera un camino barato de agotar CPU.
 *    Su generación ocupa el MISMO cupo que la verificación que la necesita: no adquiere otro.
 *  - Se hace sobre un secreto aleatorio de 32 bytes que nunca sale de aquí, y el resultado
 *    se DESCARTA: la función devuelve siempre `false`, así que ninguna entrada puede
 *    autenticar a nadie, ni siquiera por una coincidencia con ese secreto.
 *
 * No iguala los tiempos de respuesta: las demás consultas del login siguen existiendo.
 * Elimina únicamente el camino que se saltaba el cálculo de la contraseña.
 */
let hashFicticio: Promise<string> | null = null;

function hashFicticioPrimitiva(): Promise<string> {
  if (!hashFicticio) {
    hashFicticio = hashearPrimitiva(crypto.randomBytes(32).toString("hex")).catch((err) => {
      // Un fallo no queda guardado: el siguiente intento vuelve a calcularlo.
      hashFicticio = null;
      throw err;
    });
  }
  return hashFicticio;
}

const OPERACIONES: OperacionesArgon2 = {
  verificar: verificarPrimitiva,
  hashear: hashearPrimitiva,
  hashFicticio: hashFicticioPrimitiva,
};

/** Ejecuta `fn` ocupando UN cupo del semáforo. Lanza `SaturacionArgon2` si no lo hay. */
export async function conArgon2<T>(fn: (ops: OperacionesArgon2) => Promise<T>): Promise<T> {
  if (dentroDeUnCupo.getStore()) {
    throw new Error("Adquisición anidada del semáforo de Argon2: use las primitivas del cupo actual");
  }
  await adquirir();
  try {
    return await dentroDeUnCupo.run(true, () => fn(OPERACIONES));
  } finally {
    liberar();
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return conArgon2((ops) => ops.hashear(plain));
}

/**
 * `true` si la contraseña coincide, `false` si NO coincide. Cualquier otra cosa —saturación
 * o error de la biblioteca— se LANZA (`SaturacionArgon2`, `ErrorTecnicoArgon2`): nunca se
 * confunde con una contraseña incorrecta.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return (await conArgon2((ops) => ops.verificar(hash, plain))) === "correcta";
}

export async function verificacionFicticia(plain: string): Promise<false> {
  await conArgon2(async (ops) => ops.verificar(await ops.hashFicticio(), plain));
  return false;
}

/** Calcula el hash ficticio por adelantado (al arrancar), en su propio cupo. */
export async function prepararHashFicticio(): Promise<void> {
  await conArgon2((ops) => ops.hashFicticio());
}

/**
 * Política mínima de contraseña. Se aplica en el schema de validación (Zod)
 * y aquí como defensa en profundidad.
 */
export function isPasswordStrong(plain: string): boolean {
  const minLength = 10;
  const hasUpper = /[A-Z]/.test(plain);
  const hasLower = /[a-z]/.test(plain);
  const hasNumber = /\d/.test(plain);
  return plain.length >= minLength && hasUpper && hasLower && hasNumber;
}

/**
 * Genera un token opaco (para refresh tokens y reset de contraseña) y
 * retorna tanto el valor en claro (se entrega al cliente) como su hash
 * SHA-256 (lo único que se persiste en base de datos).
 */
export function generateOpaqueToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(48).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
