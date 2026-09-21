import type { FastifyInstance } from "fastify";
import * as authService from "./auth.service";
import { loginSchema, changePasswordSchema } from "./auth.schemas";
import { requireAuthDuringPasswordChange } from "./rbac.middleware";
import { ValidationError } from "../../shared/errors";
import { env, type Env } from "../../shared/env";
import {
  establecerCookieDeSesion,
  limpiarCookieDeSesion,
  leerRefreshTokenDeCookie,
  verificarCsrf,
  tokenCsrfVigente,
  puedeEmitirCsrf,
  NOMBRE_COOKIE_REFRESH,
} from "./session.cookie";

/**
 * EL REFRESH TOKEN YA NO VIAJA EN EL CUERPO — ni de ida ni de vuelta.
 *
 * Antes `/auth/login` lo devolvía en el JSON y `/auth/refresh` y `/auth/logout`
 * lo esperaban en el `body`, lo que obligaba al frontend a guardarlo en algún
 * lugar accesible desde JavaScript (`sessionStorage`). Ahora lo transporta una
 * cookie `HttpOnly` que el navegador adjunta solo a `/auth/*`, y el código de
 * la página nunca lo ve.
 *
 * Consecuencia para el cliente: estas rutas necesitan `credentials: "include"`.
 */
export async function authRoutes(app: FastifyInstance, opciones: { config?: Env } = {}) {
  /**
   * La configuración llega desde `buildServer`, no se lee del proceso.
   *
   * Los atributos de la cookie (`SameSite`, `Secure`) y la exigencia de CSRF
   * dependen de ella, y las pruebas necesitan levantar el servidor con una
   * configuración distinta —web y API en sitios separados— sin manipular
   * `process.env`. Leer el `env` global aquí hacía que ese escenario fuera
   * imposible de probar.
   */
  const config = opciones.config ?? env;

  /**
   * POST /auth/login
   * Rate-limit dedicado (ver server.ts) además del bloqueo por intentos
   * fallidos a nivel de cuenta (RB-15).
   */
  app.post("/auth/login", {
    schema: {
      description: "Inicia sesión y retorna access + refresh token",
      tags: ["auth"],
      body: { type: "object" },
    },
  }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos de login inválidos", parsed.error.flatten());

    const { refreshToken, ...respuesta } = await authService.login(parsed.data, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    const csrfToken = establecerCookieDeSesion(reply, refreshToken, config);
    // `refreshToken` se descarta deliberadamente del cuerpo; `csrfToken` sí va,
    // porque es la única vía por la que el cliente puede conocerlo (ver
    // session.cookie.ts).
    reply.code(200).send({ ...respuesta, csrfToken });
  });

  app.post("/auth/refresh", async (req, reply) => {
    /**
     * El ORDEN importa: primero la sesión, después el CSRF.
     *
     * Sin cookie de sesión no hay nada que proteger, y comprobar el CSRF antes
     * devolvía 403 —"comprobación de seguridad fallida"— donde corresponde un
     * 401 —"la sesión terminó"—. El cliente reacciona distinto a cada uno: al
     * 403 rehace el bootstrap y reintenta; al 401 manda al login. Con el orden
     * invertido, una sesión simplemente expirada provocaba un reintento inútil
     * y un mensaje de seguridad alarmante.
     */
    const refreshTokenActual = leerRefreshTokenDeCookie(req);
    verificarCsrf(req, config);

    const { refreshToken, ...respuesta } = await authService.refresh(refreshTokenActual, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    // La rotación revoca el token anterior en la base: si la cookie no se
    // actualizara aquí, el navegador seguiría mandando uno ya revocado y el
    // servicio lo interpretaría como reuso —indicio de robo— revocando la
    // sesión entera.
    //
    // `"conservar"`: el refresco NO rota el token CSRF. Rotarlo dejaba a las
    // demás pestañas con un valor caduco hasta que les llegara el aviso, y en
    // esa ventana sus operaciones fallaban con 403.
    const csrfToken = establecerCookieDeSesion(reply, refreshToken, config, "conservar", req);
    reply.code(200).send({ ...respuesta, csrfToken });
  });

  app.post("/auth/logout", async (req, reply) => {
    /**
     * Cerrar sesión sin cookie NO es un error, y NO exige comprobación CSRF.
     *
     * El orden importa: primero se mira si hay algo que revocar. Sin sesión no
     * hay nada que un atacante pueda hacer que el usuario no pudiera hacer solo
     * —cerrar una sesión que no existe—, así que exigir el token CSRF ahí solo
     * conseguía devolver 403 en el caso más normal de todos: la sesión ya
     * expiró, o se cerró en otra pestaña. Con `SameSite=None` eso convertía un
     * "ya estás fuera" en un fallo que el frontend no sabía interpretar.
     *
     * Cuando SÍ hay sesión, el CSRF se comprueba: revocar la sesión ajena es
     * una acción real y no puede dispararla otro sitio.
     */
    const token = req.cookies?.[NOMBRE_COOKIE_REFRESH];
    if (!token) {
      limpiarCookieDeSesion(reply, config);
      return reply.code(204).send();
    }

    verificarCsrf(req, config);
    await authService.logout(token, { ipAddress: req.ip, userAgent: req.headers["user-agent"] });

    limpiarCookieDeSesion(reply, config);
    reply.code(204).send();
  });

  /**
   * Cambio de contraseña. Usa `requireAuthDuringPasswordChange` porque es una
   * de las tres únicas operaciones permitidas mientras la cuenta tiene el
   * cambio pendiente — con `requireAuth` sería imposible salir de ese estado.
   *
   * Devuelve una sesión nueva: el cambio revoca las sesiones anteriores, así
   * que el cliente debe reemplazar sus tokens por los de esta respuesta.
   */
  app.post("/auth/change-password", { preHandler: [requireAuthDuringPasswordChange] }, async (req, reply) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Datos inválidos", parsed.error.flatten());

    const { refreshToken, ...respuesta } = await authService.changePassword(req.authUser!.sub, parsed.data, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    // El cambio revoca TODAS las sesiones anteriores, incluida la que hizo esta
    // llamada. La cookie tiene que reemplazarse aquí mismo o el usuario quedaría
    // con una credencial recién revocada y perdería la sesión al instante.
    const csrfToken = establecerCookieDeSesion(reply, refreshToken, config);
    reply.code(200).send({ ...respuesta, csrfToken });
  });

  // `/auth/forgot-password` y `/auth/reset-password` se eliminaron: la
  // recuperación es administrativa (ver la nota en auth.service.ts).

  /**
   * BOOTSTRAP CSRF.
   *
   * Existe porque el token CSRF vive en memoria del cliente y esa memoria se
   * pierde al recargar la página, justo cuando hace falta para poder refrescar
   * la sesión. Este endpoint emite uno nuevo (cookie + cuerpo) sin exigir nada
   * a cambio.
   *
   * Es seguro que no exija comprobación previa:
   *   - Es un GET y no cambia ningún estado de negocio; lo único que hace es
   *     rotar un valor aleatorio destinado a proteger las peticiones siguientes.
   *   - Una página atacante puede invocarlo, pero no puede LEER la respuesta:
   *     CORS solo lo permite a los orígenes de la lista blanca. Sin leerla no
   *     obtiene el token, que es lo único que le serviría.
   *
   * Devuelve SIEMPRE un token: la comprobación se exige con cualquier
   * `SameSite`. No hay campo `requerido`, porque anunciar que la protección
   * podía estar apagada permitía que el cliente se desactivara solo.
   */
  app.get("/auth/csrf", async (req, reply) => {
    /**
     * NO rota el token si ya hay uno.
     *
     * Rotarlo en cada llamada desincronizaba las pestañas: la segunda pedía el
     * bootstrap y dejaba a la primera con un valor que ya no coincidía con la
     * cookie, así que su siguiente refresco fallaba con 403. Y como este
     * endpoint no exige credenciales, cualquier sitio podía provocar esa
     * rotación en bucle e inutilizar la sesión del usuario.
     */
    if (!puedeEmitirCsrf(req, config)) {
      // Petición nacida en otro sitio y sin token que reutilizar: no se emite
      // nada. CORS impide LEER la respuesta, pero no impide provocarla.
      return reply.code(403).send({ error: "FORBIDDEN", message: "Origen no autorizado para iniciar una sesión." });
    }

    // Sin campo `requerido`: la comprobación es obligatoria siempre, y anunciar
            // lo contrario permitía que el cliente se desactivara solo.
    reply.code(200).send({ csrfToken: tokenCsrfVigente(req, reply, config) });
  });

  app.get("/auth/me", { preHandler: [requireAuthDuringPasswordChange] }, async (req, reply) => {
    reply.code(200).send({ ...req.authUser, mustChangePassword: req.authState?.mustChangePassword ?? false });
  });
}
