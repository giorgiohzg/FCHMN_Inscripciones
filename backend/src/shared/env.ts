import { parseEnv, swaggerHabilitadoEn, urlPublicaApiDe, type Env } from "./env.schema";

export type { Env } from "./env.schema";
export { parseEnv, swaggerHabilitadoEn, urlPublicaApiDe } from "./env.schema";

const SALTO = String.fromCharCode(10);

/**
 * Configuración del proceso, validada UNA vez al arrancar.
 *
 * Falla de arranque LEGIBLE: `envSchema.parse` lanzaba un `ZodError` crudo que
 * el proceso imprimía como un volcado de objeto, sin decir qué variable
 * faltaba. Al arrancar un contenedor eso es lo único que se ve.
 */
function cargarEntorno(): Env {
  const resultado = parseEnv(process.env);
  if (resultado.ok) return resultado.env;

  const detalle = resultado.errores.map((e) => `  - ${e}`);
  // eslint-disable-next-line no-console
  console.error(["", "Configuración inválida. Revise las variables de entorno:", "", ...detalle, ""].join(SALTO));
  throw new Error("Configuración de entorno inválida");
}

export const env = cargarEntorno();
export const swaggerHabilitado = swaggerHabilitadoEn(env);
export const urlPublicaApi = urlPublicaApiDe(env);
