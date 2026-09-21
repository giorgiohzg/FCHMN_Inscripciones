/**
 * Fase 6, hallazgo 27 — el refresh token vive en una cookie HttpOnly.
 *
 * Antes `/auth/login` devolvía el refresh token en el JSON y el frontend lo
 * guardaba en `sessionStorage`. Cualquier script capaz de ejecutarse en la
 * página podía leerlo con una línea, y ese token vale siete días y permite
 * emitir tokens de acceso a voluntad.
 *
 * Lo que se comprueba aquí no se puede comprobar leyendo el código: que la
 * cookie salga con los atributos correctos, que el cuerpo NO traiga el token, y
 * que los cuatro momentos que tocan la sesión —login, refresco, cambio de
 * contraseña y cierre— creen, roten o borren la cookie como corresponde.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, TEST_PASSWORD } from "./helpers/seedRbac";

const COOKIE = "fchmn_refresh";
const COOKIE_CSRF = "fchmn_csrf";

let app: FastifyInstance;

/** La cookie de sesión tal como sale en `Set-Cookie`, con todos sus atributos. */
function cookieDeSesion(res: { cookies: Array<Record<string, unknown>> }) {
  const c = res.cookies.find((x) => x.name === COOKIE);
  if (!c) throw new Error("la respuesta no trae la cookie de sesión");
  return c as { name: string; value: string; httpOnly?: boolean; secure?: boolean; sameSite?: string; path?: string; maxAge?: number; domain?: string };
}

const conCookie = (valor: string) => ({ cookie: `${COOKIE}=${valor}` });

/**
 * Cabeceras de una petición de sesión legítima: cookie de refresco, cookie de
 * CSRF y la cabecera con el mismo valor. Es lo que envía el cliente real desde
 * que la comprobación CSRF se exige siempre.
 */
function conSesion(login: { cookies: Array<Record<string, unknown>>; json: () => any }, valorSesion?: string) {
  const sesion = valorSesion ?? cookieDeSesion(login as never).value;
  const csrf = login.json().csrfToken as string;
  const cookieCsrf = (login.cookies.find((c) => c.name === COOKIE_CSRF)?.value as string) ?? "";
  return { cookie: `${COOKIE}=${sesion}; ${COOKIE_CSRF}=${cookieCsrf}`, "x-csrf-token": csrf };
}

async function entrar(instancia: FastifyInstance, username: string) {
  return instancia.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  await createUser({ username: "sesion_cookie", roleNames: ["admin"] });
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("login entrega la sesión por cookie, no por JSON", () => {
  it("el cuerpo NO contiene el refresh token", async () => {
    const res = await entrar(app, "sesion_cookie");

    expect(res.statusCode, res.body).toBe(200);
    const cuerpo = res.json();
    expect(cuerpo, "es todo el punto del hallazgo").not.toHaveProperty("refreshToken");
    // El access token sí: es de corta duración y vive en memoria del cliente.
    expect(cuerpo.accessToken).toBeTypeOf("string");
    expect(cuerpo.user.username).toBe("sesion_cookie");
  });

  it("la cookie es HttpOnly, con Path y Max-Age acotados, y sin Domain", async () => {
    const res = await entrar(app, "sesion_cookie");
    const c = cookieDeSesion(res);

    expect(c.httpOnly, "si no es HttpOnly, document.cookie la lee").toBe(true);
    expect(c.path, "no se envía a las ~100 rutas que no la necesitan").toBe("/auth");
    expect(c.domain, "host-only: sin Domain no se comparte con subdominios").toBeUndefined();

    // Max-Age igual a la vida del refresh token: sin él sería una cookie de
    // sesión y moriría al cerrar el navegador, desperdiciando los 7 días.
    const { env } = await import("../src/shared/env");
    expect(c.maxAge).toBe(env.JWT_REFRESH_EXPIRES_IN_DAYS * 86_400);
  });

  it("el token de la cookie es el que la base reconoce", async () => {
    const res = await entrar(app, "sesion_cookie");

    // Se comprueba usándolo: si la cookie no correspondiera al token emitido,
    // el refresco fallaría.
    const refrescado = await app.inject({ method: "POST", url: "/auth/refresh", headers: conSesion(res) });
    expect(refrescado.statusCode, refrescado.body).toBe(200);
  });
});

describe("el refresco rota la cookie", () => {
  it("devuelve una cookie NUEVA y distinta de la anterior", async () => {
    const login = await entrar(app, "sesion_cookie");
    const original = cookieDeSesion(login).value;

    const refrescado = await app.inject({ method: "POST", url: "/auth/refresh", headers: conSesion(login) });

    expect(refrescado.statusCode, refrescado.body).toBe(200);
    const rotada = cookieDeSesion(refrescado).value;
    expect(rotada, "la rotación revoca el anterior en la base").not.toBe(original);
    expect(refrescado.json()).not.toHaveProperty("refreshToken");
  });

  /**
   * Si la cookie no se actualizara en la respuesta, el navegador seguiría
   * mandando el token ya revocado y el servicio lo leería como REUSO —indicio
   * de robo— revocando la sesión completa. Es decir: olvidar el `setCookie`
   * aquí no rompe "un poco", desconecta al usuario.
   */
  it("la cookie rotada sirve y la anterior ya no", async () => {
    const login = await entrar(app, "sesion_cookie");
    const original = cookieDeSesion(login).value;
    const refrescado = await app.inject({ method: "POST", url: "/auth/refresh", headers: conSesion(login) });
    const rotada = cookieDeSesion(refrescado).value;

    const conNueva = await app.inject({ method: "POST", url: "/auth/refresh", headers: conSesion(login, rotada) });
    expect(conNueva.statusCode, conNueva.body).toBe(200);

    const conVieja = await app.inject({ method: "POST", url: "/auth/refresh", headers: conSesion(login, original) });
    expect(conVieja.statusCode, "reuso detectado").toBe(401);
  });

  it("sin cookie responde 401, no 400", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/refresh" });

    // El cliente distingue: 401 en /auth/refresh significa "la sesión terminó".
    expect(res.statusCode).toBe(401);
  });
});

describe("el cambio de contraseña reemplaza la cookie", () => {
  it("entrega una sesión utilizable y no expone el token", async () => {
    await createUser({ username: "cambia_cookie", roleNames: ["admin"], mustChangePassword: true });
    const login = await entrar(app, "cambia_cookie");
    const accessToken = login.json().accessToken;

    const cambio = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { currentPassword: TEST_PASSWORD, newPassword: "NuevaClave123", confirmPassword: "NuevaClave123" },
    });

    expect(cambio.statusCode, cambio.body).toBe(200);
    expect(cambio.json()).not.toHaveProperty("refreshToken");

    // El cambio revoca TODAS las sesiones anteriores, incluida la que hizo esta
    // llamada: la cookie nueva tiene que funcionar de inmediato.
    const refrescado = await app.inject({ method: "POST", url: "/auth/refresh", headers: conSesion(cambio) });
    expect(refrescado.statusCode, refrescado.body).toBe(200);

    // Y la anterior no.
    expect((await app.inject({ method: "POST", url: "/auth/refresh", headers: conSesion(login) })).statusCode).toBe(401);
  });
});

describe("el cierre de sesión borra la cookie", () => {
  it("responde 204 y ordena al navegador eliminarla", async () => {
    const login = await entrar(app, "sesion_cookie");
    const valor = cookieDeSesion(login).value;

    const salida = await app.inject({ method: "POST", url: "/auth/logout", headers: conSesion(login) });

    expect(salida.statusCode, salida.body).toBe(204);
    const borrada = cookieDeSesion(salida);
    expect(borrada.value, "valor vacío = eliminación").toBe("");
    // El borrado debe llevar el MISMO path: uno con "/" no tocaría la de /auth.
    expect(borrada.path, "sin el path correcto la cookie sobreviviría").toBe("/auth");

    // Y el token queda revocado en la base, no solo olvidado en el navegador.
    const despues = await app.inject({ method: "POST", url: "/auth/refresh", headers: conSesion(login, valor) });
    expect(despues.statusCode).toBe(401);
  });

  it("cerrar sesión SIN cookie no es un error", async () => {
    // Pasa por lo más normal: la sesión ya expiró, o se cerró en otra pestaña.
    const res = await app.inject({ method: "POST", url: "/auth/logout" });

    expect(res.statusCode, "'ya estás fuera' no es un fallo").toBe(204);
  });
});

/**
 * LA COMPROBACIÓN CSRF SE EXIGE TAMBIÉN CON `SameSite=Lax`.
 *
 * Antes solo se aplicaba con `None`, apoyándose en que `lax` impide que el
 * navegador adjunte la cookie a un POST nacido en otro sitio. Ese argumento es
 * correcto pero incompleto: `SameSite` es de SITIO, no de origen, así que no
 * separa `https://otra.fchmn.cl` de la web legítima bajo el mismo dominio
 * registrable; depende de que el navegador lo implemente; y bastaba cambiar una
 * variable de entorno a `none` para desactivar la defensa sin que nada avisara.
 *
 * `SameSite` queda como defensa en profundidad y el token como la comprobación
 * que no depende del despliegue.
 */
describe("SameSite=Lax: el CSRF se exige igual (defensa en profundidad)", () => {
  it("la cookie sale con SameSite=Lax", async () => {
    const res = await entrar(app, "sesion_cookie");
    expect(String(cookieDeSesion(res).sameSite).toLowerCase()).toBe("lax");
  });

  it("el login entrega token CSRF también en modo Lax", async () => {
    const res = await entrar(app, "sesion_cookie");

    expect(res.json().csrfToken, "ya no depende de SameSite").toBeTypeOf("string");
    expect(res.cookies.find((c) => c.name === COOKIE_CSRF)).toBeDefined();
  });

  it("/auth/csrf entrega un token también en modo Lax", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/csrf" });

    expect(res.statusCode).toBe(200);
    expect(res.json().csrfToken, "el contrato es fijo: siempre hay token").toBeTypeOf("string");
    // Ya no existe un campo `requerido`: anunciar que la protección puede estar
    // apagada permitía que el cliente se desactivara solo.
    expect(res.json()).not.toHaveProperty("requerido");
  });

  /**
   * El ataque que `lax` NO cubre: un subdominio del mismo sitio. Para el
   * navegador `https://otra.fchmn.cl` y la web legítima son el mismo sitio, así
   * que la cookie viajaría; lo único que lo detiene es el token.
   */
  it("RECHAZA un refresco sin la cabecera, aunque la cookie viaje", async () => {
    const login = await entrar(app, "sesion_cookie");

    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: `${COOKIE}=${cookieDeSesion(login).value}` },
    });

    expect(res.statusCode, "un subdominio comprometido es same-site").toBe(403);
  });

  it("ACEPTA el refresco con la cabecera correcta", async () => {
    const login = await entrar(app, "sesion_cookie");
    const csrf = login.json().csrfToken as string;
    const cookieCsrf = login.cookies.find((c) => c.name === COOKIE_CSRF)!.value;

    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: `${COOKIE}=${cookieDeSesion(login).value}; ${COOKIE_CSRF}=${cookieCsrf}`, "x-csrf-token": csrf },
    });

    expect(res.statusCode, res.body).toBe(200);
  });

  it("cerrar sesión SIN cookie sigue siendo 204 (única excepción)", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/logout" });

    // Sin sesión no hay nada que revocar, así que no hay acción que proteger.
    expect(res.statusCode).toBe(204);
  });
});

/**
 * EL REFRESCO NO ROTA EL TOKEN CSRF.
 *
 * Rotarlo creaba una carrera entre pestañas: la que renovaba obtenía uno nuevo
 * y la otra se quedaba con el viejo hasta que le llegara el aviso por
 * `BroadcastChannel`, que es asíncrono. En esa ventana, cualquier operación de
 * la segunda fallaba con 403.
 */
describe("el token CSRF vive lo que dura la sesión", () => {
  it("el refresco CONSERVA el token, no lo rota", async () => {
    const login = await entrar(app, "sesion_cookie");
    const original = login.json().csrfToken as string;
    const cookieCsrf = login.cookies.find((c) => c.name === COOKIE_CSRF)!.value;

    const refrescado = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: `${COOKIE}=${cookieDeSesion(login).value}; ${COOKIE_CSRF}=${cookieCsrf}`, "x-csrf-token": original },
    });

    expect(refrescado.statusCode).toBe(200);
    expect(refrescado.json().csrfToken, "el mismo token: las demás pestañas siguen sirviendo").toBe(original);
  });

  it("dos refrescos seguidos siguen aceptando el token original", async () => {
    const login = await entrar(app, "sesion_cookie");
    const csrf = login.json().csrfToken as string;
    const cookieCsrf = login.cookies.find((c) => c.name === COOKIE_CSRF)!.value;
    let sesion = cookieDeSesion(login).value;

    for (const intento of [1, 2, 3]) {
      const r = await app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: { cookie: `${COOKIE}=${sesion}; ${COOKIE_CSRF}=${cookieCsrf}`, "x-csrf-token": csrf },
      });
      expect(r.statusCode, `refresco ${intento}`).toBe(200);
      sesion = cookieDeSesion(r).value;
    }
  });

  it("el LOGIN sí emite uno nuevo: empieza otra sesión", async () => {
    const primera = await entrar(app, "sesion_cookie");
    const segunda = await entrar(app, "sesion_cookie");

    expect(segunda.json().csrfToken).not.toBe(primera.json().csrfToken);
  });
});

/**
 * Con web y API en sitios DISTINTOS hace falta `SameSite=None`, y entonces el
 * navegador sí adjunta la cookie a peticiones entre sitios: ahí aparece el
 * CSRF y entra el double-submit.
 */
describe("sitios distintos: SameSite=None con double-submit de CSRF", () => {
  const ORIGEN_WEB = "https://inscripciones.fchmn.cl";
  let appNone: FastifyInstance;

  beforeAll(async () => {
    const { env } = await import("../src/shared/env");
    appNone = await buildServer({
      ...env,
      AUTH_COOKIE_SAMESITE: "none",
      AUTH_COOKIE_SECURE: true,
      CORS_ORIGINS: [ORIGEN_WEB],
    });
    await appNone.ready();
  });

  afterAll(async () => {
    await appNone?.close();
  });

  it("la cookie sale SameSite=None y Secure", async () => {
    const res = await entrar(appNone, "sesion_cookie");
    const c = cookieDeSesion(res);

    expect(String(c.sameSite).toLowerCase()).toBe("none");
    // Sin Secure el navegador descarta una cookie SameSite=None sin avisar.
    expect(c.secure).toBe(true);
  });

  /**
   * El token CSRF llega por el CUERPO, y su cookie de respaldo es `HttpOnly`.
   *
   * La versión anterior emitía esa cookie SIN `HttpOnly` para que el cliente la
   * copiara con `document.cookie` —el double-submit clásico—. Ese patrón no
   * puede funcionar aquí: `SameSite=None` existe justamente porque la web y la
   * API están en hosts distintos, y `document.cookie` en la web nunca puede leer
   * una cookie host-only de la API. Ver la comprobación con reglas reales de
   * navegador en `session-cookie-navegador.integration.test.ts`.
   */
  it("el token CSRF viene en el CUERPO y su cookie NO es legible por JavaScript", async () => {
    const res = await entrar(appNone, "sesion_cookie");
    const csrf = res.cookies.find((c) => c.name === COOKIE_CSRF);

    expect(res.json().csrfToken, "es la única vía por la que el cliente puede conocerlo").toBeTypeOf("string");
    expect(csrf, "la cookie de respaldo existe").toBeDefined();
    expect(csrf!.httpOnly, "ya no se pretende que el cliente la lea").toBe(true);
    expect(csrf!.value).toBe(res.json().csrfToken);
    expect(csrf!.value).not.toBe(cookieDeSesion(res).value);
  });

  it("GET /auth/csrf entrega un token nuevo sin exigir nada a cambio", async () => {
    // Es el bootstrap tras recargar la página: el token vivía en memoria del
    // cliente y se perdió, justo cuando hace falta para poder refrescar.
    const res = await appNone.inject({ method: "GET", url: "/auth/csrf" });

    expect(res.statusCode).toBe(200);
    const cuerpo = res.json();
    expect(cuerpo.csrfToken).toBeTypeOf("string");
    expect(res.cookies.find((c) => c.name === COOKIE_CSRF)?.value, "cookie y cuerpo deben coincidir").toBe(cuerpo.csrfToken);
  });

  it("RECHAZA el refresco sin la cabecera X-CSRF-Token", async () => {
    const login = await entrar(appNone, "sesion_cookie");
    const sesion = cookieDeSesion(login).value;
    // El cliente lo obtiene del CUERPO, que es lo que CORS protege.
    const csrf = login.json().csrfToken as string;

    // Es lo que puede hacer una página atacante: provocar el POST con las
    // cookies de la víctima, pero sin poder leerlas ni fijar cabeceras.
    const res = await appNone.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: `${COOKIE}=${sesion}; ${COOKIE_CSRF}=${csrf}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it("RECHAZA una cabecera que no coincide con la cookie", async () => {
    const login = await entrar(appNone, "sesion_cookie");
    const sesion = cookieDeSesion(login).value;
    // El cliente lo obtiene del CUERPO, que es lo que CORS protege.
    const csrf = login.json().csrfToken as string;

    const res = await appNone.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: `${COOKIE}=${sesion}; ${COOKIE_CSRF}=${csrf}`, "x-csrf-token": "valor-inventado" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("ACEPTA el refresco cuando cabecera y cookie coinciden", async () => {
    const login = await entrar(appNone, "sesion_cookie");
    const sesion = cookieDeSesion(login).value;
    // El cliente lo obtiene del CUERPO, que es lo que CORS protege.
    const csrf = login.json().csrfToken as string;

    const res = await appNone.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: `${COOKIE}=${sesion}; ${COOKIE_CSRF}=${csrf}`, "x-csrf-token": csrf },
    });

    expect(res.statusCode, res.body).toBe(200);
  });

  /**
   * Punto crítico del bootstrap: NO puede rotar el token si ya hay uno.
   *
   * Rotarlo en cada llamada desincroniza las pestañas —la segunda pide el
   * bootstrap y deja a la primera con un valor caduco, que fallará con 403— y,
   * como el endpoint no exige credenciales, permite que cualquier sitio
   * inutilice la sesión del usuario invocándolo en bucle.
   */
  it("un bootstrap repetido DEVUELVE EL MISMO token, no uno nuevo", async () => {
    const login = await entrar(appNone, "sesion_cookie");
    const original = login.json().csrfToken as string;
    const cookieCsrf = login.cookies.find((c) => c.name === COOKIE_CSRF)!.value;

    const segundo = await appNone.inject({
      method: "GET",
      url: "/auth/csrf",
      headers: { cookie: `${COOKIE_CSRF}=${cookieCsrf}` },
    });

    expect(segundo.json().csrfToken, "rotarlo desincronizaría las pestañas").toBe(original);
  });

  it("un bootstrap EXTERNO no puede desincronizar una sesión en curso", async () => {
    const login = await entrar(appNone, "sesion_cookie");
    const sesion = cookieDeSesion(login).value;
    const csrf = login.json().csrfToken as string;
    const cookieCsrf = login.cookies.find((c) => c.name === COOKIE_CSRF)!.value;

    /**
     * Un sitio cualquiera provoca el bootstrap en el navegador de la víctima.
     * CORS le impide LEER la respuesta, pero no ejecutar la petición; si eso
     * rotara la cookie, bastaría para dejarle la sesión inutilizable.
     */
    const ajeno = await appNone.inject({
      method: "GET",
      url: "/auth/csrf",
      headers: { cookie: `${COOKIE_CSRF}=${cookieCsrf}`, origin: "https://sitio-cualquiera.cl", "sec-fetch-site": "cross-site" },
    });
    expect([200, 403]).toContain(ajeno.statusCode);

    // Lo que importa: el token que tenía el cliente sigue sirviendo.
    const refrescado = await appNone.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: `${COOKIE}=${sesion}; ${COOKIE_CSRF}=${cookieCsrf}`, "x-csrf-token": csrf },
    });
    expect(refrescado.statusCode, "la sesión del usuario no puede quedar inutilizable desde fuera").toBe(200);
  });

  /**
   * MATRIZ Origin x Sec-Fetch-Site.
   *
   * La versión anterior rechazaba `Sec-Fetch-Site: cross-site` de entrada, y
   * eso ROMPÍA el caso legítimo: con la web y la API en hosts distintos —el
   * motivo de existir de `SameSite=None`— TODA petición del frontend es
   * cross-site, así que el primer bootstrap de un usuario legítimo fallaba con
   * 403 y con él la restauración de sesión al recargar.
   *
   * "Cross-site" describe de dónde nace la petición; "no autorizado" describe
   * si ese origen puede hablar con la API. Decide el `Origin`.
   */
  describe("quién puede pedir un token CSRF nuevo", () => {
    const AJENO = "https://sitio-cualquiera.cl";

    it("cross-site + Origin PERMITIDO → 200 (es el caso legítimo)", async () => {
      const res = await appNone.inject({
        method: "GET",
        url: "/auth/csrf",
        headers: { origin: ORIGEN_WEB, "sec-fetch-site": "cross-site" },
      });

      expect(res.statusCode, "el frontend en otro host es siempre cross-site").toBe(200);
      expect(res.json().csrfToken).toBeTypeOf("string");
    });

    it("cross-site + Origin NO permitido → 403", async () => {
      const res = await appNone.inject({
        method: "GET",
        url: "/auth/csrf",
        headers: { origin: AJENO, "sec-fetch-site": "cross-site" },
      });

      expect(res.statusCode).toBe(403);
    });

    it("same-site + Origin NO permitido → 403", async () => {
      // El `Origin` manda: venir del mismo sitio no basta si el origen exacto
      // no está declarado.
      const res = await appNone.inject({
        method: "GET",
        url: "/auth/csrf",
        headers: { origin: AJENO, "sec-fetch-site": "same-site" },
      });

      expect(res.statusCode).toBe(403);
    });

    it("same-origin + Origin PERMITIDO → 200", async () => {
      const res = await appNone.inject({
        method: "GET",
        url: "/auth/csrf",
        headers: { origin: ORIGEN_WEB, "sec-fetch-site": "same-origin" },
      });

      expect(res.statusCode).toBe(200);
    });

    /**
     * Sin `Origin` decide `Sec-Fetch-Site`, que pone el navegador y no es
     * falsificable desde JavaScript. Una petición entre sitios SIN `Origin` no
     * puede venir de un `fetch` del frontend, que siempre lo envía.
     */
    it("SIN Origin + cross-site → 403", async () => {
      const res = await appNone.inject({ method: "GET", url: "/auth/csrf", headers: { "sec-fetch-site": "cross-site" } });

      expect(res.statusCode).toBe(403);
    });

    it("SIN Origin + same-origin → 200", async () => {
      const res = await appNone.inject({ method: "GET", url: "/auth/csrf", headers: { "sec-fetch-site": "same-origin" } });

      expect(res.statusCode).toBe(200);
    });

    it("SIN Origin + same-site → 200", async () => {
      const res = await appNone.inject({ method: "GET", url: "/auth/csrf", headers: { "sec-fetch-site": "same-site" } });

      expect(res.statusCode).toBe(200);
    });

    it("SIN Origin + none (navegación directa) → 200", async () => {
      const res = await appNone.inject({ method: "GET", url: "/auth/csrf", headers: { "sec-fetch-site": "none" } });

      expect(res.statusCode).toBe(200);
    });

    /**
     * Sin ninguna de las dos cabeceras no hay navegador de por medio —es
     * `curl`, una sonda, una prueba— y por tanto no hay cookies de una víctima
     * que aprovechar. Un navegador siempre manda al menos una de las dos.
     */
    it("SIN Origin y SIN Sec-Fetch-Site → 200 (no es un navegador)", async () => {
      const res = await appNone.inject({ method: "GET", url: "/auth/csrf" });

      expect(res.statusCode).toBe(200);
    });

    it("un Origin permitido con cross-site permite completar la sesión", async () => {
      // El recorrido entero como lo haría el frontend en dos hosts distintos.
      const boot = await appNone.inject({
        method: "GET",
        url: "/auth/csrf",
        headers: { origin: ORIGEN_WEB, "sec-fetch-site": "cross-site" },
      });
      const csrf = boot.json().csrfToken as string;
      const cookieCsrf = boot.cookies.find((c) => c.name === COOKIE_CSRF)!.value;

      const login = await appNone.inject({
        method: "POST",
        url: "/auth/login",
        headers: { origin: ORIGEN_WEB, "sec-fetch-site": "cross-site", cookie: `${COOKIE_CSRF}=${cookieCsrf}` },
        payload: { username: "sesion_cookie", password: TEST_PASSWORD },
      });
      expect(login.statusCode, login.body).toBe(200);

      const csrfSesion = login.json().csrfToken as string;
      const cookieSesionCsrf = login.cookies.find((c) => c.name === COOKIE_CSRF)!.value;
      const refrescado = await appNone.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: {
          origin: ORIGEN_WEB,
          "sec-fetch-site": "cross-site",
          cookie: `${COOKIE}=${cookieDeSesion(login).value}; ${COOKIE_CSRF}=${cookieSesionCsrf}`,
          "x-csrf-token": csrfSesion,
        },
      });

      expect(refrescado.statusCode, "el recorrido legítimo completo").toBe(200);
      void csrf;
    });
  });

  it("sin cookie previa, un bootstrap desde OTRO sitio no emite nada", async () => {
    const res = await appNone.inject({
      method: "GET",
      url: "/auth/csrf",
      headers: { origin: "https://sitio-cualquiera.cl", "sec-fetch-site": "cross-site" },
    });

    // `Sec-Fetch-Site` lo pone el navegador y no se puede falsificar desde
    // JavaScript: es la señal fiable de que la petición nació en otro sitio.
    expect(res.statusCode).toBe(403);
    expect(res.cookies.find((c) => c.name === COOKIE_CSRF), "no se emite token para un tercero").toBeUndefined();
  });

  it("el bootstrap desde el propio sitio sí emite", async () => {
    const res = await appNone.inject({
      method: "GET",
      url: "/auth/csrf",
      headers: { origin: "https://inscripciones.fchmn.cl", "sec-fetch-site": "same-site" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().csrfToken).toBeTypeOf("string");
  });

  /**
   * Cerrar una sesión que no existe no es una acción que haya que proteger: no
   * hay nada que un atacante consiga que el usuario no pudiera hacer solo.
   * Exigir CSRF ahí devolvía 403 en el caso más normal de todos —la sesión ya
   * expiró, o se cerró en otra pestaña—, que el frontend no sabía interpretar.
   */
  it("cerrar sesión SIN cookies responde 204, no 403", async () => {
    const res = await appNone.inject({ method: "POST", url: "/auth/logout" });

    expect(res.statusCode, "'ya estás fuera' no es un fallo de seguridad").toBe(204);
  });

  it("con sesión activa SÍ exige el token para cerrarla", async () => {
    const login = await entrar(appNone, "sesion_cookie");
    const sesion = cookieDeSesion(login).value;

    const res = await appNone.inject({ method: "POST", url: "/auth/logout", headers: conCookie(sesion) });

    expect(res.statusCode, "sin CSRF, otro sitio podría cerrar la sesión ajena").toBe(403);
  });

  it("el preflight autoriza la cabecera X-CSRF-Token", async () => {
    const res = await appNone.inject({
      method: "OPTIONS",
      url: "/auth/refresh",
      headers: {
        origin: "https://inscripciones.fchmn.cl",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-csrf-token",
      },
    });

    // Si el preflight no la permitiera, el refresco entre sitios sería
    // imposible desde un navegador.
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("x-csrf-token");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});
