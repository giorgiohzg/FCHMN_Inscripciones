/**
 * Fase 5, hallazgo 25 — validación de la configuración.
 *
 * El esquema comprobaba tipos y largos, pero no las condiciones que solo
 * importan al desplegar: que los dos secretos JWT sean distintos, que exista
 * una lista de orígenes permitidos, o que no se salga a producción con los
 * valores de ejemplo del `.env.example`. Cada una de esas omisiones es una
 * puerta abierta que nadie ve hasta que alguien la usa.
 *
 * Se ejercita `env.schema.ts`, que es una función pura sobre el objeto de
 * variables: no lee `process.env` ni valida al importarse, así que cada caso
 * puede probar su combinación sin tocar el entorno del proceso.
 */
import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { parseEnv, swaggerHabilitadoEn, urlPublicaApiDe } from "../src/shared/env.schema";

/** Ejecuta la validación real sobre un conjunto de variables controlado. */
function validar(vars: Record<string, string | undefined>) {
  return parseEnv(vars);
}

const BASE = {
  DATABASE_URL: "postgresql://u:clave-de-prueba@localhost:5432/db",
  JWT_ACCESS_SECRET: "a".repeat(40),
  NODE_ENV: "development",
  CORS_ORIGINS: undefined,
  PUBLIC_API_URL: undefined,
  ENABLE_SWAGGER: undefined,
  TRUST_PROXY_HOPS: undefined,
};

const PRODUCCION = {
  ...BASE,
  NODE_ENV: "production",
  CORS_ORIGINS: "https://inscripciones.fchmn.cl",
  PUBLIC_API_URL: "https://api.fchmn.cl",
};

/**
 * INTERFAZ DE ESCUCHA.
 *
 * `server.ts` tenía `host: "0.0.0.0"` escrito fijo. Se movió a configuración
 * para que la instancia de revisión visual —que lleva datos de prueba— escuche
 * solo en loopback, y la condición que estas pruebas protegen es que ese cambio
 * NO altere el backend principal: sin `HOST` definido, el valor tiene que
 * seguir siendo exactamente `0.0.0.0`.
 */
describe("interfaz de escucha (HOST)", () => {
  it("sin definir, escucha en todas las interfaces — como antes del cambio", () => {
    const r = validar({ ...BASE, HOST: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.HOST).toBe("0.0.0.0");
  });

  it("el valor por omisión tampoco cambia en producción", () => {
    // Es donde importa de verdad: un despliegue que no defina HOST no puede
    // quedarse sin escuchar en la interfaz por la que le llegan las peticiones.
    const r = validar({ ...PRODUCCION, HOST: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.HOST).toBe("0.0.0.0");
  });

  it("admite restringir a loopback, que es para lo que existe", () => {
    for (const valor of ["127.0.0.1", "::1", "localhost"]) {
      const r = validar({ ...BASE, HOST: valor });
      expect(r.ok, valor).toBe(true);
      if (r.ok) expect(r.env.HOST).toBe(valor);
    }
  });

  it("recorta espacios sobrantes en vez de intentar escuchar en un valor con espacios", () => {
    const r = validar({ ...BASE, HOST: "  127.0.0.1  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.HOST).toBe("127.0.0.1");
  });

  it("RECHAZA un valor vacío en vez de caer en el valor por omisión", () => {
    // Una cadena vacía es un error de configuración, no "no lo definí": si se
    // aceptara volviendo a 0.0.0.0, un intento de restringir mal escrito
    // ampliaría el alcance en silencio, que es justo lo contrario de lo que se
    // busca.
    for (const valor of ["", "   "]) {
      const r = validar({ ...BASE, HOST: valor });
      expect(r.ok, JSON.stringify(valor)).toBe(false);
    }
  });
});

describe("secretos JWT", () => {
  /**
   * Regresión: el único secreto JWT es el de acceso. Los refresh tokens son
   * opacos y no intervienen secretos en su emisión ni en su validación, así que
   * la configuración debe ser válida sin ninguna variable adicional, y una clave
   * desconocida que quede en un `.env` existente debe ignorarse sin impedir el
   * arranque ni llegar a la configuración resuelta.
   */
  it("ACEPTA una configuración con un solo secreto JWT", () => {
    const r = validar(BASE);
    expect(r.ok, "el refresh token es opaco: no necesita ningún secreto").toBe(true);
  });

  it("IGNORA una clave desconocida que quede en el .env", () => {
    const r = validar({ ...BASE, JWT_REFRESH_SECRET: "d".repeat(40) });

    expect(r.ok, "una variable sobrante no debe impedir el arranque").toBe(true);
    if (r.ok) {
      expect(Object.keys(r.env), "y no debe llegar a la configuración resuelta").not.toContain("JWT_REFRESH_SECRET");
    }
  });

  it("EXIGE JWT_ACCESS_SECRET con al menos 32 caracteres", () => {
    const r = validar({ ...BASE, JWT_ACCESS_SECRET: "corto" });
    expect(r.ok).toBe(false);
  });

  it("RECHAZA en producción un secreto que quedó con el valor de ejemplo", () => {
    const r = validar({
      ...PRODUCCION,
      JWT_ACCESS_SECRET: "reemplazar-por-un-secreto-de-al-menos-32-caracteres",
    });
    expect(r.ok).toBe(false);
  });
});

describe("CORS", () => {
  it("en producción EXIGE la lista de orígenes", () => {
    const r = validar({ ...PRODUCCION, CORS_ORIGINS: "" });
    expect(r.ok, "sin lista, cualquier sitio podría llamar a la API con credenciales").toBe(false);
  });

  it("en producción rechaza un origen mal formado", () => {
    const r = validar({ ...PRODUCCION, CORS_ORIGINS: "https://ok.cl, no-es-una-url/con/ruta" });
    expect(r.ok).toBe(false);
  });

  it("fuera de producción la lista puede quedar vacía", () => {
    const r = validar({ ...BASE, CORS_ORIGINS: "" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.CORS_ORIGINS).toEqual([]);
  });

  it("parte la lista por comas y limpia los espacios", () => {
    const r = validar({ ...BASE, CORS_ORIGINS: " https://a.cl , https://b.cl " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.CORS_ORIGINS).toEqual(["https://a.cl", "https://b.cl"]);
  });
});

describe("rangos numéricos", () => {
  it.each([
    ["PORT", "0"],
    ["PORT", "70000"],
    ["LOGIN_MAX_ATTEMPTS", "0"],
    ["LOGIN_LOCKOUT_MINUTES", "0"],
    ["JWT_REFRESH_EXPIRES_IN_DAYS", "0"],
    ["RATE_LIMIT_GLOBAL_MAX", "0"],
    ["TRUST_PROXY_HOPS", "-1"],
    ["TRUST_PROXY_HOPS", "99"],
  ])("RECHAZA %s = %s", (clave, valor) => {
    const r = validar({ ...BASE, [clave]: valor });
    expect(r.ok).toBe(false);
  });

  it("ACEPTA valores dentro de rango", () => {
    const r = validar({ ...BASE, PORT: "8080", TRUST_PROXY_HOPS: "1", LOGIN_MAX_ATTEMPTS: "3" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.TRUST_PROXY_HOPS).toBe(1);
  });
});

describe("documentación y URL pública", () => {
  it("en producción con la documentación APAGADA no exige PUBLIC_API_URL", () => {
    // Es el caso normal en producción: sin documento OpenAPI publicado, no hay
    // ninguna URL que declarar, y exigirla obligaba a inventar un valor.
    const r = validar({ ...PRODUCCION, PUBLIC_API_URL: undefined });
    expect(r.ok).toBe(true);
  });

  it("con la documentación ENCENDIDA sí la exige", () => {
    const r = validar({ ...PRODUCCION, PUBLIC_API_URL: undefined, ENABLE_SWAGGER: "true" });
    expect(r.ok, "el documento publicaría localhost como servidor").toBe(false);
  });

  it("fuera de producción la documentación está encendida, así que también la exige", () => {
    const r = validar({ ...BASE, PUBLIC_API_URL: undefined });
    // En desarrollo `urlPublicaApiDe` cae en localhost, que es correcto ahí:
    // la exigencia aplica cuando el valor por omisión no sirve.
    expect(r.ok).toBe(true);
  });

  it("Swagger queda apagado en producción por omisión", () => {
    const r = validar(PRODUCCION);
    expect(r.ok).toBe(true);
    if (r.ok) expect(swaggerHabilitadoEn(r.env)).toBe(false);
  });

  it("Swagger queda encendido fuera de producción por omisión", () => {
    const r = validar(BASE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(swaggerHabilitadoEn(r.env)).toBe(true);
  });

  it("ENABLE_SWAGGER=true lo fuerza incluso en producción", () => {
    const r = validar({ ...PRODUCCION, ENABLE_SWAGGER: "true" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(swaggerHabilitadoEn(r.env)).toBe(true);
  });

  it("la URL del documento OpenAPI sale de PUBLIC_API_URL", () => {
    const r = validar(PRODUCCION);
    expect(r.ok).toBe(true);
    if (r.ok) expect(urlPublicaApiDe(r.env)).toBe("https://api.fchmn.cl");
  });

  it("sin PUBLIC_API_URL (fuera de producción) cae en localhost con el puerto configurado", () => {
    const r = validar({ ...BASE, PORT: "4000" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(urlPublicaApiDe(r.env)).toBe("http://localhost:4000");
  });
});

/**
 * Fase 6, hallazgo 27 — la cookie de sesión.
 *
 * Las dos combinaciones inválidas fallan en tiempo de ARRANQUE porque sus
 * síntomas son invisibles: una cookie `SameSite=None` sin `Secure` la descarta
 * el navegador en silencio, y la sesión "muere sola" en cada recarga sin ningún
 * error que lo explique.
 */
describe("cookie de sesión", () => {
  it("por omisión es SameSite=Lax", () => {
    const r = validar(BASE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.AUTH_COOKIE_SAMESITE).toBe("lax");
  });

  it("RECHAZA SameSite=none sin Secure", () => {
    const r = validar({ ...BASE, AUTH_COOKIE_SAMESITE: "none", CORS_ORIGINS: "https://web.fchmn.cl" });

    expect(r.ok, "el navegador descartaría la cookie sin avisar").toBe(false);
    if (!r.ok) expect(r.errores.join(" ")).toMatch(/AUTH_COOKIE_SECURE/);
  });

  it("ACEPTA SameSite=none con Secure y lista de orígenes", () => {
    const r = validar({
      ...BASE,
      AUTH_COOKIE_SAMESITE: "none",
      AUTH_COOKIE_SECURE: "true",
      CORS_ORIGINS: "https://web.fchmn.cl",
    });

    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  /**
   * Con la cookie viajando entre sitios, reflejar cualquier origen sumado a
   * `credentials: true` deja la sesión al alcance de cualquier página.
   */
  it("RECHAZA SameSite=none sin CORS_ORIGINS", () => {
    const r = validar({ ...BASE, AUTH_COOKIE_SAMESITE: "none", AUTH_COOKIE_SECURE: "true", CORS_ORIGINS: "" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.join(" ")).toMatch(/CORS_ORIGINS/);
  });

  it("en producción es Secure por omisión, sin declararlo", () => {
    const r = validar(PRODUCCION);
    expect(r.ok).toBe(true);
    // `AUTH_COOKIE_SECURE` sin definir significa "sigue al entorno".
    if (r.ok) expect(r.env.AUTH_COOKIE_SECURE).toBeUndefined();
  });

  it("fuera de producción se puede desarrollar sobre http sin Secure", () => {
    const r = validar({ ...BASE, AUTH_COOKIE_SECURE: "false" });
    expect(r.ok, "en localhost una cookie Secure no se guardaría").toBe(true);
  });

  /**
   * `Secure` no es un detalle de la combinación con `SameSite=None`: es lo que
   * impide que el refresh token —siete días de sesión— salga sin cifrar. La
   * regla anterior solo lo exigía junto a `none`, así que en producción con
   * `lax` la credencial podía viajar por HTTP en claro.
   */
  it.each(["lax", "none"])("en producción RECHAZA AUTH_COOKIE_SECURE=false, también con SameSite=%s", (sameSite) => {
    const r = validar({
      ...PRODUCCION,
      AUTH_COOKIE_SAMESITE: sameSite,
      AUTH_COOKIE_SECURE: "false",
    });

    expect(r.ok, "la cookie viajaría en claro").toBe(false);
    if (!r.ok) expect(r.errores.join(" ")).toMatch(/AUTH_COOKIE_SECURE/);
  });

  it("en producción, no declarar la variable es válido: sigue al entorno", () => {
    const r = validar({ ...PRODUCCION, AUTH_COOKIE_SECURE: undefined });
    expect(r.ok).toBe(true);
  });

  it("en producción, declararla en true también", () => {
    const r = validar({ ...PRODUCCION, AUTH_COOKIE_SECURE: "true" });
    expect(r.ok).toBe(true);
  });

  it("RECHAZA un SameSite que no sea lax o none", () => {
    // `strict` rompería el login: tras volver de una navegación externa la
    // cookie no viajaría. Se admite solo lo que el sistema sabe manejar.
    expect(validar({ ...BASE, AUTH_COOKIE_SAMESITE: "strict" }).ok).toBe(false);
    expect(validar({ ...BASE, AUTH_COOKIE_SAMESITE: "cualquier-cosa" }).ok).toBe(false);
  });
});

describe("Redis", () => {
  it("REDIS_URL ya no forma parte de la configuración", () => {
    const r = validar({ ...BASE, REDIS_URL: "redis://localhost:6379" });
    expect(r.ok).toBe(true);
    // El límite de tasa es en memoria y el despliegue asume una sola
    // instancia: la variable existía sin que nada la usara.
    if (r.ok) expect(r.env).not.toHaveProperty("REDIS_URL");
  });
});

describe("el mensaje de error dice QUÉ variable está mal", () => {
  it("nombra cada variable conflictiva, no un volcado del objeto", () => {
    const r = validar({ ...PRODUCCION, CORS_ORIGINS: "", PUBLIC_API_URL: undefined, ENABLE_SWAGGER: "true" });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      const texto = r.errores.join(" | ");
      expect(texto).toContain("CORS_ORIGINS");
      expect(texto).toContain("PUBLIC_API_URL");
    }
  });
});

/**
 * `JWT_ACCESS_EXPIRES_IN` no se validaba y `jsonwebtoken` no avisa: un valor
 * sin sentido produce tokens que caducan de inmediato —nadie puede trabajar—
 * o que no caducan nunca, y eso último no se nota hasta que un token robado
 * sigue sirviendo semanas después.
 */
describe("duración del token de acceso", () => {
  /**
   * Aceptar el valor no bastaba: la prueba anterior solo miraba `ok` y por eso
   * no vio que "900" se conservaba como CADENA, que es como `jsonwebtoken`
   * entiende milisegundos. Ahora se comprueba a cuántos segundos equivale.
   */
  it.each([
    ["900", 900],
    ["900s", 900],
    ["15m", 900],
    ["2h", 7_200],
    ["1d", 86_400],
    ["30s", 30],
    ["1s", 1],
  ])("ACEPTA %s y lo normaliza a %i segundos", (valor, esperado) => {
    const r = validar({ ...BASE, JWT_ACCESS_EXPIRES_IN: valor });

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) {
      expect(r.env.JWT_ACCESS_EXPIRES_IN).toBe(esperado);
      expect(typeof r.env.JWT_ACCESS_EXPIRES_IN, "un número no es ambiguo; una cadena sí").toBe("number");
    }
  });

  /**
   * Los espacios exteriores se validaban sobre `trim()` pero se guardaba el
   * valor original: pasaba la comprobación y después `jsonwebtoken` lo
   * rechazaba al firmar.
   */
  it.each([" 15m ", "15m ", " 900", "\t2h\n"])("NORMALIZA los espacios exteriores de %j", (valor) => {
    const r = validar({ ...BASE, JWT_ACCESS_EXPIRES_IN: valor });

    expect(r.ok).toBe(true);
    if (r.ok) expect(typeof r.env.JWT_ACCESS_EXPIRES_IN).toBe("number");
  });

  it("acepta el espacio entre cantidad y unidad", () => {
    const r = validar({ ...BASE, JWT_ACCESS_EXPIRES_IN: "15 m" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.JWT_ACCESS_EXPIRES_IN).toBe(900);
  });

  /**
   * Fracciones. "0.5s" pasaba la validación (0.5 > 0) y terminaba en un token
   * de medio segundo o de cero, según cómo se redondeara.
   */
  it.each(["0.5s", "0.9s", "0.001s"])("RECHAZA %s: equivale a menos de un segundo", (valor) => {
    const r = validar({ ...BASE, JWT_ACCESS_EXPIRES_IN: valor });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.join(" | ")).toMatch(/menos de un segundo/i);
  });

  it("RECHAZA una fracción que no da segundos enteros", () => {
    const r = validar({ ...BASE, JWT_ACCESS_EXPIRES_IN: "1.5s" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.join(" | ")).toMatch(/entero de segundos/i);
  });

  it("una fracción que SÍ da segundos enteros es válida", () => {
    // 1.5 minutos son 90 segundos exactos: no hay nada que redondear.
    const r = validar({ ...BASE, JWT_ACCESS_EXPIRES_IN: "1.5m" });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.JWT_ACCESS_EXPIRES_IN).toBe(90);
  });

  it.each([
    ["texto libre", "quince minutos"],
    ["unidad desconocida", "15y"],
    ["vacío con unidad", "m"],
    ["cero", "0"],
    ["cero con unidad", "0m"],
    ["negativo", "-15m"],
    ["negativo en segundos", "-900"],
  ])("RECHAZA %s (%s)", (_caso, valor) => {
    expect(validar({ ...BASE, JWT_ACCESS_EXPIRES_IN: valor }).ok).toBe(false);
  });

  it("RECHAZA una duración de más de un día: deja de ser un token de corta duración", () => {
    expect(validar({ ...BASE, JWT_ACCESS_EXPIRES_IN: "2d" }).ok).toBe(false);
    expect(validar({ ...BASE, JWT_ACCESS_EXPIRES_IN: "25h" }).ok).toBe(false);
  });

  it("sin definir usa el valor por omisión, ya convertido", () => {
    const r = validar({ ...BASE, JWT_ACCESS_EXPIRES_IN: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.JWT_ACCESS_EXPIRES_IN, "15m = 900 segundos").toBe(900);
  });
});

/**
 * Comprobación de extremo a extremo: se firma un token de verdad con el valor
 * ya validado y se mira su caducidad real.
 *
 * Es la única prueba que habría detectado el defecto. Validar la configuración
 * no dice nada sobre lo que hace `jsonwebtoken` con ella, y ahí estaba todo el
 * problema: "900" pasaba la validación como 900 segundos y producía un token
 * con `exp - iat = 0`, caducado en el mismo instante en que se emitía.
 */
describe("la duración validada produce el token que promete", () => {
  /** Firma con `expiresIn` tal como lo entrega la validación y devuelve exp - iat. */
  function segundosDeVida(valorConfigurado: string): number {
    const r = validar({ ...BASE, JWT_ACCESS_EXPIRES_IN: valorConfigurado });
    if (!r.ok) throw new Error(`la configuración no debía ser rechazada: ${r.errores.join(" | ")}`);

    const token = jwt.sign({ sub: "u1" }, "secreto-de-prueba-de-al-menos-32-caracteres", {
      expiresIn: r.env.JWT_ACCESS_EXPIRES_IN,
    });
    const { exp, iat } = jwt.decode(token) as { exp: number; iat: number };
    return exp - iat;
  }

  it.each(["900", "900s", "15m", " 15m "])("%j produce un token de 900 segundos", (valor) => {
    expect(segundosDeVida(valor)).toBe(900);
  });

  it("las demás unidades también llegan intactas al token", () => {
    expect(segundosDeVida("2h")).toBe(7_200);
    expect(segundosDeVida("1d")).toBe(86_400);
    expect(segundosDeVida("30s")).toBe(30);
  });

  it("ningún valor aceptado produce un token ya caducado", () => {
    for (const valor of ["900", "900s", "15m", "2h", "1d", "1s", "1.5m"]) {
      expect(segundosDeVida(valor), `"${valor}" no puede caducar al nacer`).toBeGreaterThan(0);
    }
  });
});
