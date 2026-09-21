/**
 * Token CSRF, en memoria.
 *
 * POR QUÉ NO SE LEE DE `document.cookie`
 * --------------------------------------
 * La primera versión usaba el double-submit clásico: el servidor emitía una
 * cookie legible y el cliente la copiaba a la cabecera. Ese patrón NO PUEDE
 * funcionar aquí, por dos razones independientes:
 *
 *  1. Con `SameSite=None` —web y API en HOSTS DISTINTOS— la cookie pertenece al
 *     host de la API, y `document.cookie` en la web solo ve las de su propio
 *     host. Nunca la leería. (La comprobación se exige con cualquier
 *     `SameSite`; este escenario es el que hace imposible el patrón clásico.)
 *  2. Aunque compartieran host, la cookie va con `Path=/auth` y `document.cookie`
 *     desde `/competencias` tampoco la vería.
 *
 * El servidor entrega el token en el CUERPO de la respuesta (`/auth/csrf`, y
 * también en login, refresco y cambio de contraseña). El cuerpo está protegido
 * por CORS: una página atacante puede provocar la petición, pero no leer la
 * respuesta, así que nunca conoce el valor que tendría que poner en la cabecera.
 *
 * Vive en memoria y se pierde al recargar, igual que el access token. Por eso
 * existe `/auth/csrf`: para reconstruirlo antes del primer refresco.
 */

let token: string | null = null;

/** Bootstrap en curso, para no pedirlo varias veces a la vez. */
let enCurso: Promise<void> | null = null;

export function tokenCsrfActual(): string | null {
  return token;
}

/**
 * Guarda el token que viene en el cuerpo de una respuesta de sesión.
 *
 * Ya no admite `null`. Antes sí, y un `null` ponía `requerido = false`, con lo
 * que el cliente dejaba de mandar la cabecera para el resto de la sesión: un
 * campo vacío en una respuesta desactivaba la protección en silencio. La
 * comprobación se exige siempre, así que un token ausente es un error del
 * servidor, no una señal de configuración.
 */
export function recordarTokenCsrf(nuevo: string): void {
  if (nuevo) token = nuevo;
}

export function olvidarTokenCsrf(): void {
  token = null;
}

/**
 * Se asegura de tener un token antes de una petición que lo necesite.
 *
 * Se llama al arrancar la aplicación y antes de refrescar: al recargar la
 * página la memoria está vacía, y sin este paso el primer `/auth/refresh`
 * fallaría con 403 y la sesión se daría por perdida aunque la cookie siguiera
 * siendo válida.
 *
 * @param pedir función que llama a `GET /auth/csrf`.
 */
export async function asegurarTokenCsrf(pedir: () => Promise<{ csrfToken: string }>): Promise<void> {
  if (token) return;
  if (enCurso) return enCurso;

  enCurso = (async () => {
    try {
      token = (await pedir()).csrfToken;
    } finally {
      enCurso = null;
    }
  })();

  /**
   * El error se PROPAGA.
   *
   * Antes se tragaba en silencio, con el argumento de que la petición siguiente
   * fallaría por su cuenta. Pero el fallo que producía era el equivocado: sin
   * token, el refresco salía sin la cabecera y el servidor respondía 403, que
   * el cliente interpretaba como "sesión inválida" y borraba la sesión. Es
   * decir, un corte de red de un segundo terminaba expulsando al usuario.
   *
   * Propagándolo, quien llama distingue "no pude comprobar" de "la sesión no
   * vale", y nunca se llega a hacer un refresco sabiendo que le faltará la
   * cabecera.
   */
  return enCurso;
}

/**
 * Fuerza la obtención de un token NUEVO, descartando el que haya.
 *
 * Se usa tras un 403: significa que el que teníamos ya no coincide con la
 * cookie del servidor —otra pestaña lo rotó, o la cookie caducó—, así que hay
 * que pedirlo otra vez antes de reintentar.
 */
export async function renovarTokenCsrf(pedir: () => Promise<{ csrfToken: string }>): Promise<string | null> {
  token = null;
  await asegurarTokenCsrf(pedir);
  return token;
}

/** Solo para las pruebas. */
export function reiniciarCsrf(): void {
  token = null;
  enCurso = null;
}
