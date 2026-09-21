import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import { authRoutes } from "./modules/auth/auth.routes";
import { personsRoutes } from "./modules/persons/persons.routes";
import { clubsRoutes } from "./modules/clubs/clubs.routes";
import { poolsRoutes } from "./modules/pools/pools.routes";
import { swimmerAssignmentRoutes } from "./modules/swimmer-assignment/assignment.routes";
import { catalogsRoutes } from "./modules/catalogs/catalogs.routes";
import { competitionsRoutes } from "./modules/competitions/competitions.routes";
import { registrationsRoutes } from "./modules/registrations/registrations.routes";
import { relayRegistrationsRoutes } from "./modules/relay-registrations/relay-registrations.routes";
import { reportsRoutes } from "./modules/reports/reports.routes";
import { teamManagerExportRoutes } from "./modules/team-manager-export/team-manager-export.routes";
import { auditRoutes } from "./modules/audit/audit.routes";
import { dashboardRoutes } from "./modules/dashboard/dashboard.routes";
import { meetImportRoutes } from "./modules/meet-import/meet-import.routes";
import { resolveErrorResponse } from "./shared/httpErrorResponse";
import { prisma } from "./shared/prisma.client";
import { env, swaggerHabilitadoEn, urlPublicaApiDe, type Env } from "./shared/env";

/**
 * Métodos que la aplicación expone.
 *
 * @fastify/cors 11 responde por omisión solo GET, HEAD y POST. Con la versión
 * 9 anterior no hacía falta declararlos, así que al subir de versión un
 * preflight de PUT o DELETE —editar una competencia, eliminar una prueba—
 * habría empezado a fallar desde el navegador sin que ningún cambio de código
 * lo explicara. Se declaran explícitamente para que la lista no dependa del
 * valor por omisión de una dependencia.
 */
const METODOS_HTTP = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/**
 * `config` existe para poder construir el servidor con otra configuración en
 * las pruebas —por ejemplo, con una lista blanca de CORS— sin manipular
 * `process.env`. En producción siempre se usa el `env` del proceso.
 */
export async function buildServer(config: Env = env) {
  const app = Fastify({
    logger: true,
    /**
     * `trustProxy: true` le decía a Fastify que confiara en la cadena
     * `X-Forwarded-For` COMPLETA, viniera de donde viniera: cualquier cliente
     * podía declarar la IP que quisiera y con eso falsear el registro de
     * auditoría y saltarse el límite de tasa por IP. Ahora se declara cuántos
     * proxies propios hay por delante; con 0 (el valor por defecto) no se
     * confía en ninguna cabecera reenviada.
     */
    trustProxy:
      config.TRUST_PROXY_HOPS > 0
        ? // Se confía en los primeros N saltos contados desde el proxy más
          // cercano. Es la forma tipada de "trust N hops": los tipos de
          // Fastify 5 no admiten el número directo, pero sí una función.
          (_direccion: string, salto: number) => salto < config.TRUST_PROXY_HOPS
        : false,
  });

  /**
   * El manejador de errores se registra ANTES que las rutas.
   *
   * Estaba al final del archivo y no se aplicaba a los errores lanzados
   * desde los `preHandler` de los módulos ya registrados: esas respuestas
   * salían con el formato por defecto de Fastify (`{statusCode, error:
   * "Forbidden", message}`) en vez del formato propio (`{error: <código>,
   * message, details}`), así que el mismo tipo de error tenía dos formas
   * distintas según dónde se lanzara.
   */
  app.setErrorHandler((err: FastifyError & { statusCode?: number }, _req, reply) => {
    // Toda la decisión vive en `resolveErrorResponse` para que las pruebas
    // puedan ejercitar la misma función que usa el servidor — incluida la
    // traducción de errores de Prisma, que antes solo se aplicaba en los
    // servicios que la invocaban a mano.
    const { status, body, log } = resolveErrorResponse(err);
    if (log === "error") app.log.error(err);
    else if (log === "warn") app.log.warn(err);
    reply.status(status).send(body);
  });

  await app.register(helmet);

  /**
   * Lectura y escritura de cookies. El refresh token vive en una cookie
   * `HttpOnly` (ver `modules/auth/session.cookie.ts`), así que este plugin es
   * necesario para que `req.cookies` y `reply.setCookie` existan.
   *
   * Sin `secret`: la cookie NO se firma. Su contenido es un token opaco de 32
   * bytes aleatorios que además se valida contra la base en cada uso —se busca
   * su hash en `refresh_tokens`—, así que falsificarla exige adivinar el token,
   * no romper una firma. Firmarla añadiría un secreto más que rotar sin cambiar
   * lo que un atacante necesita.
   */
  await app.register(cookie);

  /**
   * CORS con lista blanca.
   *
   * `origin: true` refleja el origen de cualquier solicitud y, combinado con
   * `credentials: true`, permite que CUALQUIER sitio web haga peticiones
   * autenticadas con las credenciales del usuario. La lista sale de
   * `CORS_ORIGINS`, que en producción es obligatoria (ver `shared/env.ts`);
   * vacía —solo posible fuera de producción— conserva el comportamiento
   * abierto para no estorbar el desarrollo local.
   */
  await app.register(cors, {
    origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : true,
    credentials: true,
    methods: METODOS_HTTP,
    /**
     * Declaradas explícitamente por la misma razón que `methods`: no depender
     * del valor por omisión de una dependencia. `x-csrf-token` es la que usa el
     * comprobación CSRF, que se exige con cualquier `SameSite`; si no estuviera
     * permitida, el preflight rechazaría toda petición de sesión entre sitios.
     */
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
  });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB (carga masiva / importación de competencias)
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      code: "RATE_LIMIT_EXCEEDED",
      error: "RATE_LIMIT_EXCEEDED",
      message: `Demasiadas solicitudes seguidas — espere ${Math.ceil((context.ttl ?? 0) / 1000)} segundos e intente de nuevo.`,
    }),
  });

  /**
   * Documentación interactiva: apagada en producción.
   *
   * `/docs` estaba publicado sin autenticación en todos los entornos, con el
   * catálogo completo de rutas y esquemas de la API. Ahora sigue al entorno y
   * se puede forzar con `ENABLE_SWAGGER` si alguna vez hace falta publicarla.
   * La URL del servidor sale de `PUBLIC_API_URL`: antes el documento decía
   * `localhost`, inservible para cualquiera que lo abriera desde fuera.
   */
  if (swaggerHabilitadoEn(config)) {
    await app.register(swagger, {
      openapi: {
        info: { title: "API Natación", version: "1.0.0" },
        servers: [{ url: urlPublicaApiDe(config) }],
      },
    });
    await app.register(swaggerUI, { routePrefix: "/docs" });
  }

  // Rate limit más estricto específicamente para login (defensa adicional
  // sobre el bloqueo por cuenta de la sección de reglas de negocio RB-15).
  app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      max: config.RATE_LIMIT_AUTH_MAX,
      timeWindow: "1 minute",
      errorResponseBuilder: (_req, context) => ({
        statusCode: 429,
        code: "RATE_LIMIT_EXCEEDED",
        error: "RATE_LIMIT_EXCEEDED",
        message: `Demasiados intentos de inicio de sesión — espere ${Math.ceil((context.ttl ?? 0) / 1000)} segundos e intente de nuevo.`,
      }),
    });
    // La configuración de la cookie de sesión viaja con las rutas: los
    // atributos SameSite/Secure y la exigencia de CSRF salen de ella.
    await scoped.register(authRoutes, { config });
  });

  await app.register(personsRoutes);
  await app.register(clubsRoutes);
  await app.register(poolsRoutes);
  await app.register(swimmerAssignmentRoutes);
  await app.register(catalogsRoutes);
  await app.register(competitionsRoutes);
  await app.register(registrationsRoutes);
  await app.register(relayRegistrationsRoutes);
  await app.register(reportsRoutes);
  await app.register(teamManagerExportRoutes);
  await app.register(auditRoutes);
  await app.register(dashboardRoutes);
  await app.register(meetImportRoutes);

  /**
   * VIVACIDAD (`/health`) y DISPONIBILIDAD (`/ready`) son preguntas distintas y
   * antes había una sola respuesta para las dos.
   *
   * `/health` dice si el proceso responde: si contesta, el orquestador no debe
   * reiniciarlo. No toca la base a propósito — una base caída no es motivo
   * para matar y recrear el proceso, que volvería a levantarse igual de
   * inservible.
   *
   * `/ready` dice si puede ATENDER, y para eso sí consulta PostgreSQL. Es la
   * que debe mirar un balanceador para decidir si mandarle tráfico. Con un
   * solo `/health` que devolvía `{status:"ok"}` sin mirar nada, una instancia
   * sin base seguía recibiendo solicitudes y respondiendo errores.
   */
  app.get("/health", async () => ({ status: "ok", uptime: Math.round(process.uptime()) }));

  app.get("/ready", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ready", database: "ok" };
    } catch (err) {
      app.log.error({ err }, "sonda de disponibilidad: la base de datos no responde");
      return reply.status(503).send({ status: "unavailable", database: "unreachable" });
    }
  });

  return app;
}

/**
 * Cierre ordenado.
 *
 * Sin esto, un SIGTERM —lo que manda Docker o Kubernetes en cada despliegue—
 * mataba el proceso de inmediato: las solicitudes en curso se cortaban a mitad
 * y las conexiones a PostgreSQL quedaban abiertas hasta que el motor las
 * recogía. `app.close()` deja de aceptar solicitudes nuevas, espera a que
 * terminen las que están en vuelo y recién entonces se desconecta.
 *
 * El temporizador es el límite: si algo queda colgado, el proceso sale igual
 * en vez de quedarse indefinidamente sin atender ni terminar.
 */
const MAXIMO_CIERRE_MS = 15_000;

async function cerrarOrdenadamente(app: Awaited<ReturnType<typeof buildServer>>, senal: string): Promise<void> {
  app.log.info({ senal }, "cierre ordenado: no se aceptan solicitudes nuevas");

  const limite = setTimeout(() => {
    app.log.error({ senal, ms: MAXIMO_CIERRE_MS }, "el cierre ordenado excedió su plazo: se termina el proceso");
    process.exit(1);
  }, MAXIMO_CIERRE_MS);
  limite.unref();

  try {
    await app.close();
    await prisma.$disconnect();
    app.log.info({ senal }, "cierre ordenado completo");
    process.exit(0);
  } catch (err) {
    app.log.error({ err, senal }, "error durante el cierre ordenado");
    process.exit(1);
  }
}

if (require.main === module) {
  /**
   * Arranque con manejo de errores: antes `buildServer().then(...)` no tenía
   * `catch`, así que un fallo al registrar un plugin o al escuchar el puerto
   * terminaba como promesa rechazada sin capturar — un proceso que se apaga
   * sin decir por qué.
   */
  buildServer()
    .then(async (app) => {
      try {
        await app.listen({ port: env.PORT, host: "0.0.0.0" });
      } catch (err) {
        app.log.error({ err }, "no se pudo abrir el puerto");
        process.exit(1);
      }

      for (const senal of ["SIGTERM", "SIGINT"] as const) {
        process.once(senal, () => {
          void cerrarOrdenadamente(app, senal);
        });
      }
    })
    .catch((err) => {
      // Todavía no hay logger de la aplicación: se escribe estructurado igual.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ event: "startup_failed", message: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    });
}
