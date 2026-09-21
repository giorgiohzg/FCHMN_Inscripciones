/**
 * Fase 6, hallazgo 27 — la cookie de sesión bajo las reglas de ALMACENAMIENTO
 * de cookies (RFC 6265).
 *
 * Las demás pruebas usan `app.inject()` y ponen la cabecera `Cookie` a mano.
 * Eso comprueba la lógica del servidor pero NO puede detectar los defectos que
 * dependen de a qué URL decide un cliente enviar cada cookie: poniendo la
 * cabecera uno mismo, la cookie "funciona" siempre, incluso si en un navegador
 * nunca llegaría a enviarse.
 *
 * Aquí el servidor escucha de verdad en un puerto y las peticiones pasan por un
 * `CookieJar` de `tough-cookie`, que implementa el RFC 6265: el mismo algoritmo
 * de coincidencia de dominio y ruta que usa un navegador.
 *
 * QUÉ CUBRE ESTO, Y QUÉ NO
 * ------------------------
 * SÍ cubre, con el mismo algoritmo que un navegador:
 *   - `Path`: a qué rutas se envía la cookie y a cuáles no;
 *   - `Domain` / host-only: qué hosts la reciben;
 *   - `HttpOnly`: qué vería `document.cookie` (acceso no-HTTP);
 *   - el ciclo completo login → rotación → recarga → cierre.
 *
 * NO cubre, y no debe presentarse como si lo hiciera:
 *   - **`SameSite`**: `tough-cookie` lo almacena, pero aquí no hay contexto de
 *     navegación ni origen de la petición, así que no se ejercita la decisión
 *     de enviar o no la cookie entre sitios. Esa regla la aplica el navegador.
 *   - **HTTPS y `Secure`**: estas pruebas corren sobre http, así que el atributo
 *     `Secure` se comprueba en la respuesta (`session-cookie.integration`) y en
 *     la validación de entorno, no en su efecto real de transporte.
 *   - **CORS**: se comprueban las CABECERAS que emite el servidor, pero quien
 *     bloquea la lectura de una respuesta es el navegador. Aquí `fetch` de Node
 *     las ignora y lee el cuerpo igualmente.
 *   - **Políticas de cookies de terceros**: bloqueo por omisión en Safari,
 *     partición por sitio (CHIPS), modo incógnito, extensiones. Cualquiera de
 *     ellas puede impedir que la cookie de la API se guarde con
 *     `SameSite=None`, y ninguna se puede reproducir aquí.
 *
 * PENDIENTE: un smoke test manual en navegadores reales (Chrome, Firefox y
 * Safari, en ventana normal y privada) contra un despliegue con HTTPS y la web
 * en un host distinto del de la API. Es la única forma de verificar los cuatro
 * puntos de arriba. Está declarado en el README como comprobación no ejecutada.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { CookieJar } from "tough-cookie";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, TEST_PASSWORD } from "./helpers/seedRbac";

/**
 * `Response.json()` devuelve `unknown`. Estas pruebas navegan el cuerpo por sus
 * campos, así que se lee a través de un tipo laxo declarado UNA vez, en lugar de
 * salpicar `as any` por todo el archivo.
 */
type CuerpoJson = Record<string, any>;
const leerJson = async (res: Response): Promise<CuerpoJson> => (await res.json()) as CuerpoJson;

const COOKIE_REFRESH = "fchmn_refresh";
const COOKIE_CSRF = "fchmn_csrf";

let app: FastifyInstance;
let base: string;

/**
 * Cliente HTTP con tarro de cookies: guarda las de cada respuesta y adjunta las
 * que correspondan a la URL siguiente, aplicando las reglas del RFC 6265.
 */
function navegador() {
  const jar = new CookieJar();

  async function pedir(ruta: string, init: RequestInit = {}): Promise<Response> {
    const url = `${base}${ruta}`;
    const headers = new Headers(init.headers);

    // El navegador adjunta solo lo que corresponde a ESTA url.
    const cookie = await jar.getCookieString(url);
    if (cookie) headers.set("cookie", cookie);

    const res = await fetch(url, { ...init, headers, redirect: "manual" });

    for (const sc of res.headers.getSetCookie?.() ?? []) {
      await jar.setCookie(sc, url).catch(() => undefined);
    }
    return res;
  }

  return {
    jar,
    pedir,
    /** Lo que la petición a `ruta` llevaría en la cabecera Cookie. */
    cookiesPara: (ruta: string) => jar.getCookieString(`${base}${ruta}`),
    /**
     * Lo que `document.cookie` vería.
     *
     * `http: false` le dice a tough-cookie que simule un acceso NO-HTTP —el de
     * un script de la página—, que es justamente donde las cookies `HttpOnly`
     * quedan excluidas.
     */
    documentCookie: async (ruta = "/") => {
      const cookies = await jar.getCookies(`${base}${ruta}`, { http: false });
      return cookies.map((c) => `${c.key}=${c.value}`).join("; ");
    },
  };
}

async function entrar(nav: ReturnType<typeof navegador>, username = "nav_cookie") {
  return nav.pedir("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
}

/**
 * Igual que hace el cliente: guarda el token CSRF que viene en el CUERPO y lo
 * repite en la cabecera. El tarro se encarga de las cookies; la cabecera no,
 * porque el token no es legible desde una cookie (es `HttpOnly`).
 */
async function entrarConCsrf(nav: ReturnType<typeof navegador>, username = "nav_cookie") {
  const res = await entrar(nav, username);
  const cuerpo = await leerJson(res.clone());
  return { res, csrf: cuerpo.csrfToken as string };
}

const conCsrf = (csrf: string) => ({ "x-csrf-token": csrf });

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  await createUser({ username: "nav_cookie", roleNames: ["admin"] });

  app = await buildServer();
  // Puerto efímero: el servidor escucha de verdad, no es `inject`.
  await app.listen({ port: 0, host: "127.0.0.1" });
  const dir = app.server.address();
  if (!dir || typeof dir === "string") throw new Error("no se pudo determinar el puerto");
  base = `http://127.0.0.1:${dir.port}`;
});

afterAll(async () => {
  await app?.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("a qué URL se envía cada cookie (RFC 6265)", () => {
  it("la cookie de sesión NO viaja a las rutas de negocio", async () => {
    const nav = navegador();
    expect((await entrar(nav)).status).toBe(200);

    // Es el efecto de `Path=/auth`, y no se puede comprobar poniendo la
    // cabecera a mano: ninguna de las ~100 rutas restantes la recibe.
    expect(await nav.cookiesPara("/competitions"), "una ruta de negocio no debe verla").not.toContain(COOKIE_REFRESH);
    expect(await nav.cookiesPara("/persons")).not.toContain(COOKIE_REFRESH);
    expect(await nav.cookiesPara("/")).not.toContain(COOKIE_REFRESH);
  });

  it("sí viaja a las rutas de autenticación", async () => {
    const nav = navegador();
    await entrar(nav);

    expect(await nav.cookiesPara("/auth/refresh")).toContain(COOKIE_REFRESH);
    expect(await nav.cookiesPara("/auth/logout")).toContain(COOKIE_REFRESH);
  });

  /**
   * Es la prueba de que el double-submit por `document.cookie` NO PODÍA
   * funcionar: ni la cookie de sesión ni la de CSRF son legibles desde el
   * JavaScript de la página.
   */
  it("`document.cookie` no ve ninguna de las dos cookies", async () => {
    const nav = navegador();
    await entrar(nav);

    const visible = await nav.documentCookie("/auth/refresh");
    expect(visible, "HttpOnly: invisible para el script de la página").not.toContain(COOKIE_REFRESH);
    expect(visible, "la de CSRF también es HttpOnly ahora").not.toContain(COOKIE_CSRF);
  });

  it("es host-only: otro host no la recibiría", async () => {
    const nav = navegador();
    await entrar(nav);

    // Sin `Domain`, la cookie queda atada al host exacto que la emitió.
    const otroHost = await nav.jar.getCookieString("http://otro.example.com/auth/refresh");
    expect(otroHost).toBe("");

    // Un subdominio tampoco.
    const sub = await nav.jar.getCookieString("http://sub.127.0.0.1.nip.io/auth/refresh");
    expect(sub).toBe("");
  });
});

describe("el ciclo completo con un tarro de cookies real", () => {
  it("login → refresco → refresco: la rotación se sigue sola", async () => {
    const nav = navegador();
    const { res: login, csrf } = await entrarConCsrf(nav);
    expect(login.status).toBe(200);
    expect(await login.json(), "el refresh token no vuelve al cliente").not.toHaveProperty("refreshToken");

    // Las COOKIES las adjunta el tarro solo, igual que el navegador. Si la
    // rotación no actualizara la cookie, el segundo refresco mandaría un token
    // ya revocado y daría 401. El token CSRF, en cambio, lo repite el cliente
    // desde el cuerpo: no puede leerlo de la cookie.
    for (const intento of [1, 2, 3]) {
      const r = await nav.pedir("/auth/refresh", { method: "POST", headers: conCsrf(csrf) });
      expect(r.status, `refresco ${intento}`).toBe(200);
    }
  });

  /**
   * LA RECARGA DE PÁGINA, que es donde se concentran los defectos: el access
   * token vive en memoria y se pierde, así que la sesión tiene que reconstruirse
   * solo con lo que el navegador conserva — la cookie.
   */
  it("recarga: sin nada en memoria, la cookie basta para recuperar la sesión completa", async () => {
    const nav = navegador();
    await entrar(nav);

    /**
     * "Recargar" = olvidar todo lo que no sean las cookies, incluido el token
     * CSRF que estaba en memoria. Por eso hay que rehacer el bootstrap, que es
     * exactamente lo que hace el cliente al arrancar.
     */
    const boot = await nav.pedir("/auth/csrf");
    const { csrfToken } = await leerJson(boot);

    const r = await nav.pedir("/auth/refresh", { method: "POST", headers: conCsrf(csrfToken) });
    expect(r.status, await r.clone().text()).toBe(200);

    const cuerpo = await leerJson(r);
    expect(cuerpo.accessToken).toBeTypeOf("string");
    expect(cuerpo.user, "sin el perfil, la aplicación no sabe quién entró").toBeDefined();
    expect(cuerpo.user.username).toBe("nav_cookie");
    expect(cuerpo.user.roles).toContain("admin");
    expect(cuerpo.mustChangePassword).toBe(false);

    // Y el token sirve de inmediato contra una ruta de negocio.
    const clubs = await nav.pedir("/clubs", { headers: { authorization: `Bearer ${cuerpo.accessToken}` } });
    expect(clubs.status).toBe(200);
  });

  it("cerrar sesión deja el tarro sin la cookie y el token revocado", async () => {
    const nav = navegador();
    const { csrf } = await entrarConCsrf(nav);

    const salida = await nav.pedir("/auth/logout", { method: "POST", headers: conCsrf(csrf) });
    expect(salida.status, await salida.clone().text()).toBe(204);

    // El borrado tiene que llevar el MISMO Path: con "/" el navegador no
    // tocaría la que está en /auth y seguiría enviándola.
    expect(await nav.cookiesPara("/auth/refresh"), "la cookie debe desaparecer del navegador").not.toContain(COOKIE_REFRESH);

    const despues = await nav.pedir("/auth/refresh", { method: "POST", headers: conCsrf(csrf) });
    expect(despues.status, "y el token queda revocado en la base").toBe(401);
  });

  it("un navegador sin sesión no puede refrescar", async () => {
    const nav = navegador();

    const r = await nav.pedir("/auth/refresh", { method: "POST" });

    expect(r.status).toBe(401);
  });
});

/**
 * El escenario que rompía el mecanismo anterior: la web en un host y la API en
 * otro. Ahí `document.cookie` de la web NUNCA puede leer una cookie de la API,
 * así que el token CSRF tiene que llegar por el CUERPO de la respuesta.
 */
describe("sitios distintos: el CSRF se obtiene por respuesta HTTP", () => {
  let appNone: FastifyInstance;
  let baseNone: string;
  const ORIGEN_WEB = "https://inscripciones.fchmn.cl";

  /** Como `navegador()`, pero contra la instancia con SameSite=None. */
  function navegadorNone() {
    const jar = new CookieJar();
    return {
      jar,
      pedir: async (ruta: string, init: RequestInit = {}) => {
        const url = `${baseNone}${ruta}`;
        const headers = new Headers(init.headers);
        // La web está en otro origen: el navegador lo declara.
        headers.set("origin", ORIGEN_WEB);
        const cookie = await jar.getCookieString(url);
        if (cookie) headers.set("cookie", cookie);
        const res = await fetch(url, { ...init, headers, redirect: "manual" });
        for (const sc of res.headers.getSetCookie?.() ?? []) {
          await jar.setCookie(sc, url, { ignoreError: true }).catch(() => undefined);
        }
        return res;
      },
      documentCookie: async () => {
        // Lo que la WEB podría leer de sus propias cookies: nada de la API.
        const cookies = await jar.getCookies(`${baseNone}/auth/refresh`, { http: false });
        return cookies.map((c) => `${c.key}=${c.value}`).join("; ");
      },
    };
  }

  beforeAll(async () => {
    const { env } = await import("../src/shared/env");
    appNone = await buildServer({
      ...env,
      AUTH_COOKIE_SAMESITE: "none",
      // `Secure: false` a propósito: la prueba corre sobre http y una cookie
      // Secure no se guardaría en el tarro. Lo que se ejercita aquí es el
      // mecanismo CSRF, no el atributo Secure (cubierto en env-validation).
      AUTH_COOKIE_SECURE: false,
      CORS_ORIGINS: [ORIGEN_WEB],
    });
    await appNone.listen({ port: 0, host: "127.0.0.1" });
    const dir = appNone.server.address();
    if (!dir || typeof dir === "string") throw new Error("sin puerto");
    baseNone = `http://127.0.0.1:${dir.port}`;
  });

  afterAll(async () => {
    await appNone?.close();
  });

  it("el token CSRF llega en el CUERPO del login, no en una cookie legible", async () => {
    const nav = navegadorNone();

    const login = await nav.pedir("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nav_cookie", password: TEST_PASSWORD }),
    });
    const cuerpo = await leerJson(login);

    expect(cuerpo.csrfToken, "es la única vía por la que el cliente puede conocerlo").toBeTypeOf("string");
    // Y NO por `document.cookie`, que era el mecanismo roto.
    expect(await nav.documentCookie(), "la cookie de CSRF es HttpOnly").not.toContain(COOKIE_CSRF);
  });

  it("con el token del cuerpo, el refresco funciona", async () => {
    const nav = navegadorNone();
    const login = await nav.pedir("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nav_cookie", password: TEST_PASSWORD }),
    });
    const { csrfToken } = await leerJson(login);

    const r = await nav.pedir("/auth/refresh", { method: "POST", headers: { "x-csrf-token": csrfToken } });

    expect(r.status, await r.text()).toBe(200);
  });

  /**
   * LA RECARGA con SameSite=None: el token CSRF también vivía en memoria y se
   * perdió. Sin el endpoint de bootstrap, la sesión sería irrecuperable aunque
   * la cookie siguiera siendo válida — el refresco daría 403 para siempre.
   */
  it("tras recargar, /auth/csrf devuelve un token nuevo y la sesión se recupera", async () => {
    const nav = navegadorNone();
    await nav.pedir("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nav_cookie", password: TEST_PASSWORD }),
    });

    // Recarga: se olvida el token CSRF que estaba en memoria.
    const sinToken = await nav.pedir("/auth/refresh", { method: "POST" });
    expect(sinToken.status, "sin token la comprobación rechaza, como debe").toBe(403);

    // Bootstrap.
    const boot = await nav.pedir("/auth/csrf");
    expect(boot.status).toBe(200);
    const { csrfToken } = await leerJson(boot);
    expect(csrfToken).toBeTypeOf("string");

    const r = await nav.pedir("/auth/refresh", { method: "POST", headers: { "x-csrf-token": csrfToken } });
    expect(r.status, "la sesión se recupera tras la recarga").toBe(200);
    expect((await leerJson(r)).user.username).toBe("nav_cookie");
  });

  it("una petición SIN el token es rechazada aunque lleve las cookies", async () => {
    const nav = navegadorNone();
    await nav.pedir("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nav_cookie", password: TEST_PASSWORD }),
    });

    // Es exactamente lo que puede hacer una página atacante: provocar el POST
    // con las cookies de la víctima. No puede leer el cuerpo de ninguna
    // respuesta de esta API —CORS se lo impide— así que no conoce el token.
    const r = await nav.pedir("/auth/refresh", { method: "POST" });

    expect(r.status).toBe(403);
  });

  it("CORS solo autoriza a leer las respuestas al origen declarado", async () => {
    const permitido = await fetch(`${baseNone}/auth/csrf`, { headers: { origin: ORIGEN_WEB } });
    expect(permitido.headers.get("access-control-allow-origin")).toBe(ORIGEN_WEB);
    expect(permitido.headers.get("access-control-allow-credentials")).toBe("true");

    // Sin esta cabecera el navegador descarta la respuesta: es lo que impide
    // que un sitio cualquiera lea el token CSRF del cuerpo.
    const ajeno = await fetch(`${baseNone}/auth/csrf`, { headers: { origin: "https://sitio-cualquiera.cl" } });
    expect(ajeno.headers.get("access-control-allow-origin")).toBeNull();
  });
});
