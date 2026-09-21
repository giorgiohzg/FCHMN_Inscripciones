import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { env, type Env } from "../../shared/env";
import { UnauthorizedError, ForbiddenError } from "../../shared/errors";

/**
 * El refresh token vive en una COOKIE, no en el cuerpo de la respuesta.
 *
 * Antes se devolvía en el JSON de `/auth/login` y el frontend lo guardaba en
 * `sessionStorage`. Cualquier script que llegara a ejecutarse en la página
 * —una dependencia comprometida, un `dangerouslySetInnerHTML`, una extensión—
 * podía leerlo con una línea, y un refresh token vale SIETE DÍAS.
 *
 * Propiedades, y el porqué de cada una:
 *
 *   HttpOnly  — invisible para `document.cookie`. Es el punto del cambio.
 *   Secure    — solo viaja por HTTPS. Obligatorio en producción.
 *   SameSite  — `lax` si web y API comparten sitio, `none` si están en sitios
 *               distintos. Es defensa en profundidad: la comprobación CSRF se
 *               exige en los dos casos (ver más abajo).
 *   Path      — `/auth`. La cookie solo se envía a las rutas que la necesitan;
 *               ninguna de las ~100 rutas restantes de la API la recibe.
 *   Max-Age   — igual a la vida del refresh token en la base. Sin esto sería
 *               una cookie de sesión, que muere al cerrar el navegador y
 *               desperdicia la duración real del token.
 *   host-only — NO se declara `Domain`. Con `Domain=fchmn.cl` la cookie se
 *               enviaría también a cualquier subdominio; sin él queda atada al
 *               host exacto que la emitió.
 */
export const NOMBRE_COOKIE_REFRESH = "fchmn_refresh";

/**
 * Cookie que sostiene la comprobación CSRF. Es `HttpOnly` como la anterior, y
 * se emite SIEMPRE, con cualquier `SameSite`.
 *
 * LA VERSIÓN ANTERIOR DE ESTO ESTABA ROTA. Se emitía sin `HttpOnly` para que
 * el cliente la copiara a la cabecera con `document.cookie`, que es el
 * double-submit clásico. Pero ese patrón solo funciona cuando la cookie
 * pertenece al mismo sitio que ejecuta el JavaScript, y aquí ocurre lo
 * contrario por definición: `SameSite=None` existe justamente porque la web y
 * la API están en HOSTS DISTINTOS. `document.cookie` en la web nunca puede leer
 * una cookie host-only del dominio de la API. Y aunque compartieran host,
 * `Path=/auth` la haría invisible desde `/competencias`.
 *
 * El mecanismo correcto es el de abajo: el token se entrega en el CUERPO de la
 * respuesta —que una página atacante no puede leer, porque CORS se lo impide—
 * y el cliente lo guarda en memoria.
 */
export const NOMBRE_COOKIE_CSRF = "fchmn_csrf";

export const CABECERA_CSRF = "x-csrf-token";

/**
 * LA COMPROBACIÓN CSRF SE EXIGE SIEMPRE, con cualquier `SameSite`.
 *
 * Antes solo se aplicaba con `SameSite=None`, con el argumento de que `lax`
 * impide que el navegador adjunte la cookie a un POST nacido en otro sitio. Ese
 * argumento es correcto pero incompleto, y apoyarse solo en él deja huecos
 * reales:
 *
 *   - `SameSite` es de SITIO, no de origen. `lax` no separa
 *     `https://otra.fchmn.cl` de `https://inscripciones.fchmn.cl`: un
 *     subdominio comprometido —o cualquier servicio bajo el mismo dominio
 *     registrable— puede hacer peticiones con la cookie adjunta.
 *   - La protección depende del navegador. Un cliente que no implemente
 *     `SameSite` trata la cookie como `None` y la envía siempre.
 *   - Cambiar `AUTH_COOKIE_SAMESITE` a `none` es una línea de configuración. Si
 *     la defensa CSRF dependiera de ese valor, ese cambio la desactivaría sin
 *     que nada avisara.
 *
 * `SameSite` queda como defensa en profundidad —sigue siendo la primera
 * barrera— y el token como la comprobación que no depende del despliegue. El
 * coste es una petición más al arrancar la aplicación.
 *
 * ÚNICA excepción, deliberada: cerrar sesión SIN cookie de refresco (ver
 * `auth.routes.ts`). Ahí no hay nada que revocar, así que no hay acción que
 * proteger, y exigir el token convertía el caso más normal —la sesión ya
 * expiró— en un 403.
 *
 * NO HAY FUNCIÓN QUE LO CONDICIONE: el contrato es fijo. Existió una
 * `csrfRequeridoEn(config)` que devolvía `config.AUTH_COOKIE_SAMESITE === "none"`,
 * y su rastro dejaba tipos `string | null` y campos `requerido` repartidos por
 * todo el sistema, dando a entender que la protección podía estar apagada —y
 * permitiendo que el cliente se desactivara solo al recibir un `null`—. Al ser
 * siempre obligatoria, el token es un `string` y punto.
 */

/** Ámbito de las cookies de sesión: solo las rutas de autenticación. */
const RUTA_COOKIE = "/auth";

const SEGUNDOS_POR_DIA = 86_400;

interface OpcionesCookie {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "none";
  path: string;
  maxAge: number;
}

/** ¿Se marca `Secure`? Por omisión sigue al entorno. */
export function cookieSeguraEn(config: Env): boolean {
  return config.AUTH_COOKIE_SECURE ?? config.NODE_ENV === "production";
}

function opcionesDe(config: Env): OpcionesCookie {
  return {
    httpOnly: true,
    secure: cookieSeguraEn(config),
    sameSite: config.AUTH_COOKIE_SAMESITE,
    path: RUTA_COOKIE,
    maxAge: config.JWT_REFRESH_EXPIRES_IN_DAYS * SEGUNDOS_POR_DIA,
  };
}

/**
 * Emite un token CSRF nuevo: lo deja en una cookie `HttpOnly` y DEVUELVE su
 * valor para que el llamador lo incluya en el cuerpo de la respuesta.
 *
 * Por qué esto es seguro sin que la cookie sea legible:
 *
 *   - El servidor compara la cabecera `X-CSRF-Token` contra la cookie.
 *   - Una página atacante SÍ puede provocar la petición con las cookies de la
 *     víctima —eso es el CSRF—, pero NO puede conocer el valor: para eso
 *     tendría que leer el cuerpo de una respuesta de esta API, y CORS se lo
 *     impide salvo que su origen esté en la lista blanca.
 *   - Por eso el valor se entrega por el CUERPO y no por una cookie legible:
 *     el cuerpo está protegido por CORS; la cookie, en un escenario entre
 *     sitios, sencillamente no es accesible.
 */
export function emitirTokenCsrf(reply: FastifyReply, config: Env = env): string {
  const token = randomBytes(32).toString("hex");
  reply.setCookie(NOMBRE_COOKIE_CSRF, token, opcionesDe(config));
  return token;
}

/**
 * Devuelve el token CSRF vigente, y solo emite uno nuevo si NO había.
 *
 * Es lo que usa `GET /auth/csrf`, y la diferencia con `emitirTokenCsrf` importa:
 * rotar el token en cada llamada desincroniza las pestañas. Si una segunda
 * pestaña pide el bootstrap, la primera se queda con un valor que ya no es el
 * de la cookie y su siguiente refresco falla con 403. Peor: como este endpoint
 * no exige credenciales, cualquiera podría invalidar la sesión de trabajo del
 * usuario invocándolo en bucle.
 *
 * Reutilizar el valor existente es seguro: sigue siendo un secreto que solo
 * conoce quien puede leer respuestas de esta API.
 */
export function tokenCsrfVigente(req: FastifyRequest, reply: FastifyReply, config: Env = env): string {
  const existente = req.cookies?.[NOMBRE_COOKIE_CSRF];
  if (existente) return existente;

  return emitirTokenCsrf(reply, config);
}

/**
 * ¿Puede esta petición emitir un token CSRF nuevo?
 *
 * CORS impide LEER la respuesta desde otro origen, pero no impide EJECUTAR la
 * petición: un sitio cualquiera puede provocar un `GET /auth/csrf` en el
 * navegador de la víctima. Reutilizar el token vigente ya cierra el caso
 * normal; esta comprobación cubre el primer bootstrap, cuando todavía no hay
 * cookie que reutilizar.
 *
 * LA REGLA ES EL `Origin`, NO `Sec-Fetch-Site`
 * --------------------------------------------
 * La versión anterior rechazaba `Sec-Fetch-Site: cross-site` de entrada, y eso
 * ROMPÍA el despliegue legítimo: con la web y la API en hosts distintos —que es
 * exactamente el motivo de existir de `SameSite=None`— TODA petición del
 * frontend es `cross-site`. El primer bootstrap de un usuario legítimo fallaba
 * con 403, y con él la restauración de sesión al recargar.
 *
 * "Cross-site" describe de dónde nace la petición; "no autorizado" describe si
 * ese origen puede hablar con esta API. Son cosas distintas, y aquí decide la
 * segunda:
 *
 *   1. Si viene `Origin`, se valida contra `CORS_ORIGINS` — exacto, sin
 *      comodines. Vale igual que `Sec-Fetch-Site` diga `cross-site`: es
 *      precisamente lo que hace el frontend en un despliegue de dos hosts. Un
 *      origen fuera de la lista se rechaza, venga como venga.
 *   2. Sin `Origin`, se mira `Sec-Fetch-Site`, que pone el navegador y no es
 *      falsificable desde JavaScript. Se acepta salvo `cross-site`: una
 *      petición entre sitios sin `Origin` no puede venir de un `fetch` del
 *      frontend, que siempre lo envía.
 *   3. Sin ninguna de las dos cabeceras se acepta. No hay navegador de por
 *      medio —es `curl`, una sonda, una prueba— y por tanto no hay cookies de
 *      una víctima que aprovechar. Un navegador sí las manda, y es el único
 *      vector de CSRF.
 *
 * Fuera de producción `CORS_ORIGINS` puede estar vacía (equivale a "cualquier
 * origen", ver `server.ts`) y entonces esto no restringe nada: es coherente con
 * el CORS abierto de desarrollo. En producción la lista es obligatoria.
 */
export function puedeEmitirCsrf(req: FastifyRequest, config: Env = env): boolean {
  const origen = req.headers.origin;

  if (origen) {
    // Lista vacía = CORS abierto (solo posible fuera de producción).
    return config.CORS_ORIGINS.length === 0 || config.CORS_ORIGINS.includes(origen);
  }

  const fetchSite = req.headers["sec-fetch-site"];
  const sitio = Array.isArray(fetchSite) ? fetchSite[0] : fetchSite;
  if (sitio) return sitio !== "cross-site";

  return true;
}

/**
 * Escribe la cookie del refresh token.
 *
 * Se llama en login, en cada rotación por refresco y tras el cambio de
 * contraseña: los tres emiten un refresh token nuevo y revocan el anterior, así
 * que la cookie tiene que seguir esa rotación o la sesión se rompe en el
 * siguiente uso.
 *
 * EL TOKEN CSRF NO SE ROTA EN EL REFRESCO. Antes sí, y eso creaba una carrera
 * entre pestañas: la que renovaba obtenía un token nuevo y la otra se quedaba
 * con el viejo hasta que le llegara el aviso por `BroadcastChannel`, que es
 * asíncrono. En esa ventana, cualquier operación de la segunda fallaba con 403.
 *
 * El token CSRF no es una credencial de sesión: es la prueba de que quien pide
 * puede leer respuestas de esta API. No gana nada rotando en cada refresco, y
 * mantenerlo estable durante la vida de la sesión elimina la carrera de raíz.
 * Se emite cuando la sesión EMPIEZA o cambia de dueño: login, cambio de
 * contraseña, y el bootstrap cuando no existe ninguno.
 *
 * @param csrf `"emitir"` para generar uno nuevo (login, cambio de contraseña),
 *             `"conservar"` para dejar intacto el que haya (refresco).
 * @returns el token CSRF que el cliente debe usar. Siempre un valor.
 */
export function establecerCookieDeSesion(
  reply: FastifyReply,
  refreshToken: string,
  config: Env = env,
  csrf: "emitir" | "conservar" = "emitir",
  req?: FastifyRequest
): string {
  reply.setCookie(NOMBRE_COOKIE_REFRESH, refreshToken, opcionesDe(config));

  if (csrf === "emitir") return emitirTokenCsrf(reply, config);

  // Conservar: se devuelve el vigente sin tocar la cookie. Si no hubiera
  // ninguno —sesión anterior a este cambio— se emite, que es lo correcto.
  const vigente = req?.cookies?.[NOMBRE_COOKIE_CSRF];
  return vigente ?? emitirTokenCsrf(reply, config);
}

/**
 * Borra las cookies de sesión.
 *
 * `clearCookie` tiene que recibir el MISMO `path` (y `sameSite`/`secure`) con
 * el que se escribió: el navegador identifica una cookie por nombre + dominio +
 * ruta, y un borrado con la ruta por omisión (`/`) no toca la que está en
 * `/auth`, dejándola viva hasta su expiración.
 */
export function limpiarCookieDeSesion(reply: FastifyReply, config: Env = env): void {
  const { maxAge: _maxAge, ...resto } = opcionesDe(config);
  reply.clearCookie(NOMBRE_COOKIE_REFRESH, resto);
  reply.clearCookie(NOMBRE_COOKIE_CSRF, resto);
}

/**
 * Lee el refresh token de la cookie.
 *
 * Falta de cookie = 401, no 400: la diferencia importa porque el cliente
 * reacciona distinto —un 401 en `/auth/refresh` significa "la sesión terminó,
 * hay que volver a entrar"—.
 */
export function leerRefreshTokenDeCookie(req: FastifyRequest): string {
  const token = req.cookies?.[NOMBRE_COOKIE_REFRESH];
  if (!token) {
    throw new UnauthorizedError("No hay una sesión activa en este navegador.");
  }
  return token;
}

/** Comparación en tiempo constante, tolerante a longitudes distintas. */
function igualesEnTiempoConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Comprobación CSRF. Se aplica SIEMPRE, con cualquier `SameSite`.
 *
 * La cabecera tiene que repetir el valor de la cookie. El cliente lo consigue
 * del cuerpo de una respuesta anterior (`/auth/csrf`, login o cambio de
 * contraseña) y lo guarda en memoria; un atacante no puede, porque leer ese
 * cuerpo requiere que CORS lo autorice.
 */
export function verificarCsrf(req: FastifyRequest, _config: Env = env): void {
  const cookie = req.cookies?.[NOMBRE_COOKIE_CSRF];
  const cabecera = req.headers[CABECERA_CSRF];
  const enviado = Array.isArray(cabecera) ? cabecera[0] : cabecera;

  if (!cookie || !enviado || !igualesEnTiempoConstante(cookie, enviado)) {
    throw new ForbiddenError(
      "Comprobación de seguridad fallida. Recargue la página; si el problema persiste, vuelva a iniciar sesión."
    );
  }
}
