import { z } from "zod";

/**
 * Definición y validación de la configuración (hallazgo 25).
 *
 * Vive aparte de `env.ts` a propósito: este módulo NO lee `process.env` ni
 * valida nada al importarse, así que las pruebas pueden ejercitar cada regla
 * con el conjunto de variables que quieran. `env.ts` es la capa delgada que
 * lo aplica una vez al arrancar.
 *
 * Hallazgo 25 — configuración validada por entorno.
 *
 * Antes el esquema comprobaba tipos y largos mínimos, pero no las condiciones
 * que solo importan en producción: que los dos secretos JWT sean DISTINTOS,
 * que exista una lista de orígenes permitidos, o que no se despliegue con los
 * valores de ejemplo. Un despliegue con `CORS_ORIGINS` sin definir abría la API
 * a cualquier origen, y con los dos secretos iguales un token de refresco
 * servía como token de acceso.
 */

/** Entero positivo dentro de un rango razonable, con un mensaje que dice cuál. */
const enteroEnRango = (min: number, max: number, unidad: string) =>
  z.coerce
    .number()
    .int(`Debe ser un número entero de ${unidad}`)
    .min(min, `Debe ser al menos ${min} ${unidad}`)
    .max(max, `No puede superar ${max} ${unidad}`);

/**
 * Duración de un token de acceso, en el formato que entiende `jsonwebtoken`:
 * un número de segundos, o un número seguido de unidad (`15m`, `2h`, `7d`).
 *
 * No se validaba, y `jsonwebtoken` no avisa: un valor sin sentido como
 * `"quince minutos"` o `"0"` produce tokens que caducan de inmediato o que no
 * caducan nunca, y eso no se descubre hasta que alguien no puede entrar —o
 * hasta que un token robado sigue sirviendo semanas después.
 */
const SEGUNDOS_POR_UNIDAD = { s: 1, m: 60, h: 3_600, d: 86_400 } as const;

/** Un token de acceso de más de un día anula el sentido del refresh token. */
const DURACION_MAXIMA_SEGUNDOS = 86_400;

/**
 * Duración del token de acceso, normalizada a un NÚMERO ENTERO DE SEGUNDOS.
 *
 * Devolver la cadena era el defecto: `jsonwebtoken` interpreta una cadena SIN
 * unidad como MILISEGUNDOS, así que `JWT_ACCESS_EXPIRES_IN="900"` —que esta
 * validación aceptaba leyéndolo como 900 segundos— firmaba tokens de 900 ms,
 * con `exp - iat = 0`: caducados al nacer. Y `" 15m "` pasaba la validación
 * (que compara sobre `trim()`) pero se guardaba con los espacios, que
 * `jsonwebtoken` rechaza al firmar. En los dos casos la configuración parecía
 * correcta y el sistema quedaba inutilizable en tiempo de ejecución.
 *
 * Al entregar un número, la ambigüedad desaparece: `jsonwebtoken` siempre lee
 * un número como segundos. La conversión ocurre una sola vez, al arrancar, y
 * un valor imposible impide el arranque en vez de descubrirse en el primer
 * login.
 */
const duracionDeToken = z
  .string()
  .default("15m")
  .transform((valor, ctx): number => {
    const invalido = (message: string): typeof z.NEVER => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      return z.NEVER;
    };

    // El `trim()` es el valor que se usa, no solo el que se comprueba.
    const m = valor.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
    if (!m) {
      return invalido(`Formato inválido: "${valor}". Use segundos ("900") o número y unidad ("15m", "2h", "1d").`);
    }

    const unidad = (m[2] ?? "s").toLowerCase() as keyof typeof SEGUNDOS_POR_UNIDAD;
    const enSegundos = Number(m[1]) * SEGUNDOS_POR_UNIDAD[unidad];

    // Se comprueba antes que la parte entera para que "0.5s" reciba el
    // mensaje que corresponde a su problema real.
    if (enSegundos < 1) {
      return invalido(`"${valor}" equivale a menos de un segundo: la duración mínima es 1 segundo.`);
    }
    if (!Number.isInteger(enSegundos)) {
      return invalido(`"${valor}" equivale a ${enSegundos} segundos: la duración debe ser un número entero de segundos.`);
    }
    if (enSegundos > DURACION_MAXIMA_SEGUNDOS) {
      return invalido("Un token de ACCESO no debería durar más de un día (use el refresh token).");
    }

    return enSegundos;
  });

/** Lista separada por comas: "https://a.cl, https://b.cl" -> ["https://a.cl", "https://b.cl"] */
const listaDeOrigenes = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
  );

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),

    /**
     * Único secreto JWT del sistema: firma los tokens de ACCESO.
     *
     * Los refresh tokens NO se firman. Son valores opacos aleatorios de los que
     * la base guarda solo un hash SHA-256, y se revocan por sus filas en
     * `refresh_tokens` (ver `modules/auth/password.util.ts` y `auth.service.ts`).
     *
     * Por eso **rotar este secreto no revoca las sesiones**: invalida los tokens
     * de acceso emitidos, pero una cookie de refresco vigente obtiene uno nuevo
     * de inmediato. Cerrar sesiones exige revocar en `refresh_tokens`.
     */
    JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET debe tener al menos 32 caracteres"),
    JWT_ACCESS_EXPIRES_IN: duracionDeToken,
    /** Vigencia del refresh token opaco. La leen `session.cookie.ts` y `auth.service.ts`. */
    JWT_REFRESH_EXPIRES_IN_DAYS: enteroEnRango(1, 365, "días").default(7),

    LOGIN_MAX_ATTEMPTS: enteroEnRango(1, 100, "intentos").default(5),
    LOGIN_LOCKOUT_MINUTES: enteroEnRango(1, 1440, "minutos").default(15),

    PORT: enteroEnRango(1, 65535, "puerto").default(3000),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    /**
     * Orígenes permitidos por CORS, separados por coma. Vacío en desarrollo
     * significa "cualquiera"; en producción es un error de configuración y el
     * refinamiento de más abajo lo rechaza.
     */
    CORS_ORIGINS: listaDeOrigenes,

    /**
     * Cuántos proxies de confianza hay por delante (0 = ninguno).
     *
     * Estaba fijo en `trustProxy: true`, que le dice a Fastify que confíe en el
     * `X-Forwarded-For` COMPLETO venga de donde venga: cualquiera podía
     * declarar la IP que quisiera y con eso falsear el registro de auditoría y
     * escaparse del límite de tasa por IP. Con un número, Fastify solo confía
     * en esa cantidad de saltos desde el final de la cadena.
     */
    TRUST_PROXY_HOPS: enteroEnRango(0, 10, "saltos").default(0),

    // Límites de tasa configurables. Estaban fijos en el código, lo que hacía
    // imposible ejecutar una suite de pruebas de integración (que hace decenas
    // de logins) sin chocar con el límite de `/auth/*`.
    RATE_LIMIT_GLOBAL_MAX: enteroEnRango(1, 100_000, "solicitudes").default(300),
    RATE_LIMIT_AUTH_MAX: enteroEnRango(1, 100_000, "solicitudes").default(20),

    /** URL pública de la API; alimenta el documento OpenAPI. */
    PUBLIC_API_URL: z.string().url("PUBLIC_API_URL debe ser una URL completa").optional(),

    /**
     * Documentación interactiva. Por omisión sigue el entorno: encendida fuera
     * de producción, apagada en producción. Se puede forzar con "true"/"false"
     * para publicarla puntualmente en un servidor real.
     */
    ENABLE_SWAGGER: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),

    /**
     * `SameSite` de la cookie del refresh token.
     *
     *   lax  — web y API bajo el MISMO sitio (mismo dominio registrable). Es lo
     *          preferible: el navegador no manda la cookie en peticiones POST
     *          que nazcan en otro sitio, y con eso el CSRF queda cubierto por
     *          construcción.
     *   none — web y API en sitios DISTINTOS. El navegador manda la cookie en
     *          peticiones entre sitios, así que hace falta protección CSRF
     *          explícita (ver `csrf.ts`) y `Secure` obligatorio.
     */
    AUTH_COOKIE_SAMESITE: z.enum(["lax", "none"]).default("lax"),

    /**
     * `Secure` de la cookie. Por omisión sigue al entorno: obligatorio en
     * producción, opcional fuera (donde el desarrollo es sobre http://localhost
     * y una cookie `Secure` no se guardaría).
     */
    AUTH_COOKIE_SECURE: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
  })
  .superRefine((valores, ctx) => {
    /**
     * `SameSite=None` sin `Secure` es una combinación que los navegadores
     * RECHAZAN: la cookie sencillamente no se guarda, y el síntoma es una
     * sesión que muere en cada recarga sin ningún error visible. Se detiene el
     * arranque en vez de dejar que se descubra probando.
     */
    const secure = valores.AUTH_COOKIE_SECURE ?? valores.NODE_ENV === "production";
    if (valores.AUTH_COOKIE_SAMESITE === "none" && !secure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_COOKIE_SAMESITE"],
        message:
          "AUTH_COOKIE_SAMESITE=none exige AUTH_COOKIE_SECURE=true: los navegadores descartan una cookie SameSite=None que no sea Secure.",
      });
    }

    /**
     * Con `SameSite=None` la cookie viaja entre sitios, así que el origen
     * permitido tiene que ser una lista EXACTA. Con `origin: true` la API
     * refleja el origen de quien pregunte y, sumado a `credentials: true`,
     * cualquier sitio podría usar la sesión del usuario.
     */
    if (valores.AUTH_COOKIE_SAMESITE === "none" && valores.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ORIGINS"],
        message:
          "Con AUTH_COOKIE_SAMESITE=none hay que declarar CORS_ORIGINS con los orígenes exactos: " +
          "la cookie de sesión viaja entre sitios y reflejar cualquier origen la deja al alcance de todos.",
      });
    }

    if (valores.NODE_ENV !== "production") return;

    // ---- Exigencias que solo aplican en producción ----

    /**
     * En producción la cookie de sesión SIEMPRE va `Secure`, con cualquier
     * `SameSite`.
     *
     * La regla anterior solo lo exigía junto a `SameSite=None`, así que
     * `AUTH_COOKIE_SECURE=false` con `lax` pasaba la validación: el refresh
     * token —siete días de sesión— viajaría en claro por HTTP y cualquiera en
     * la red podría copiarlo. `Secure` no es un detalle de la combinación con
     * `None`; es lo que impide que la credencial salga sin cifrar.
     */
    if (valores.AUTH_COOKIE_SECURE === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_COOKIE_SECURE"],
        message:
          "AUTH_COOKIE_SECURE=false no se admite en producción: la cookie del refresh token viajaría por HTTP sin cifrar. " +
          "Quite la variable (sigue al entorno) o póngala en true.",
      });
    }

    if (valores.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ORIGINS"],
        message:
          "En producción hay que declarar los orígenes permitidos (CORS_ORIGINS), separados por coma. " +
          "Sin la lista, la API acepta solicitudes con credenciales desde cualquier sitio web.",
      });
    }

    for (const origen of valores.CORS_ORIGINS) {
      if (!/^https?:\/\/[^/]+$/.test(origen)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CORS_ORIGINS"],
          message: `Origen inválido: "${origen}". Use esquema y host sin ruta final, por ejemplo https://inscripciones.fchmn.cl`,
        });
      }
    }

    /**
     * `PUBLIC_API_URL` solo hace falta si se va a PUBLICAR el documento
     * OpenAPI: es la URL que ese documento declara como servidor. Exigirla
     * siempre obligaba a inventar un valor en un despliegue con la
     * documentación apagada, que es el caso normal en producción.
     */
    if (swaggerHabilitadoEn(valores as Env) && !valores.PUBLIC_API_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PUBLIC_API_URL"],
        message:
          "Con la documentación habilitada (ENABLE_SWAGGER=true) hay que declarar PUBLIC_API_URL: " +
          "de lo contrario el documento OpenAPI publicaría localhost como servidor.",
      });
    }

    // El secreto de ejemplo del `.env.example` no puede llegar a producción.
    // Los prefijos son los de los valores que trae esa plantilla.
    if (/^(reemplazar|replace|cambiar|change|example|ejemplo|secret|test)/i.test(valores.JWT_ACCESS_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_ACCESS_SECRET"],
        message: "JWT_ACCESS_SECRET parece un valor de ejemplo. Genere uno con: openssl rand -hex 32",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Valida un conjunto de variables y devuelve la configuración, o el detalle de
 * qué está mal.
 *
 * Es una función PURA sobre el objeto que recibe —no lee `process.env` por su
 * cuenta— para que las pruebas puedan ejercitar cada regla sin manipular el
 * entorno del proceso ni recargar módulos.
 */
export function parseEnv(source: Record<string, string | undefined>): { ok: true; env: Env } | { ok: false; errores: string[] } {
  const resultado = envSchema.safeParse(source);
  if (resultado.success) return { ok: true, env: resultado.data };
  return { ok: false, errores: resultado.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`) };
}

/** ¿Se publica la documentación interactiva con esta configuración? */
export const swaggerHabilitadoEn = (e: Env): boolean => e.ENABLE_SWAGGER ?? e.NODE_ENV !== "production";

/** URL que declara el documento OpenAPI como servidor. */
export const urlPublicaApiDe = (e: Env): string => e.PUBLIC_API_URL ?? `http://localhost:${e.PORT}`;
