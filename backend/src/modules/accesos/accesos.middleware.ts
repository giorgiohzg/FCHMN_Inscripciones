import type { FastifyReply, FastifyRequest } from "fastify";
import { UnauthorizedError } from "../../shared/errors";
import { aplica, esRolConfigurable, funcionDelCatalogo } from "./catalogo";
import { cargarConfiguracionVigente, evaluarAlgunaFuncion, FuncionDeshabilitadaError, type ConfiguracionVigente } from "./accesos.service";

/**
 * GUARDA DE FUNCIÓN. Se agrega a una ruta ADEMÁS de su `requirePermission` (y de cualquier
 * `requireRole` o comprobación de alcance), nunca en su lugar: solo puede restar.
 *
 * Debe ir después de `requireAuth`, que deja en `req.authUser.roles` los roles EFECTIVOS
 * recargados de la base en esta misma solicitud (no los del JWT).
 */

/** Una lectura de la configuración por solicitud, aunque la ruta tenga varias guardas. */
const porSolicitud = new WeakMap<FastifyRequest, Promise<ConfiguracionVigente>>();

export function configuracionDeLaSolicitud(req: FastifyRequest): Promise<ConfiguracionVigente> {
  let p = porSolicitud.get(req);
  if (!p) {
    p = cargarConfiguracionVigente();
    porSolicitud.set(req, p);
  }
  return p;
}

function exigirDelCatalogo(funciones: readonly string[]): void {
  if (funciones.length === 0) throw new Error("requireFuncion necesita al menos una función");
  for (const f of funciones) if (!funcionDelCatalogo(f)) throw new Error(`requireFuncion: función fuera del catálogo: ${f}`);
}

/** Comprueba en la solicitud que ALGUNA de las funciones la permita (o que ninguna aplique). */
export async function verificarFunciones(req: FastifyRequest, funciones: readonly string[]): Promise<void> {
  if (!req.authUser) throw new UnauthorizedError();
  const roles = req.authUser.roles;
  /**
   * Sin consultar la configuración cuando NO puede cambiar la decisión: administración siempre
   * pasa, y si ningún rol CONFIGURABLE de la cuenta tiene alguna de estas funciones dentro de su
   * techo, el resultado es «no aplica» o «permitida» por un rol no configurable (cuenta de club,
   * representante legal). Es la misma decisión que daría `evaluarAlgunaFuncion`.
   */
  if (roles.includes("admin")) return;
  if (!funciones.some((f) => roles.some((r) => esRolConfigurable(r) && aplica(f, r)))) return;
  const config = await configuracionDeLaSolicitud(req);
  const { decision, funcion } = evaluarAlgunaFuncion(funciones, roles, config);
  if (decision === "denegada") throw new FuncionDeshabilitadaError(funcion);
}

/**
 * La ruta exige que ALGUNA de las funciones esté permitida. Con varias, es un endpoint
 * COMPARTIDO: apagar un menú no rompe otro que sigue encendido y usa la misma ruta.
 */
export function requireFuncion(...algunaDe: string[]) {
  exigirDelCatalogo(algunaDe);
  return async (req: FastifyRequest, _reply: FastifyReply) => verificarFunciones(req, algunaDe);
}

/**
 * Como `requireFuncion`, pero la función depende de la consulta. La usan las listas que sirven
 * a dos funciones: `GET /registrations` y `GET /relay-registrations` son la lista OPERATIVA del
 * panel con `status=confirmed` y el HISTORIAL con `status=cancelled` o sin estado.
 */
export function requireFuncionSegun(posibles: readonly string[], elegir: (req: FastifyRequest) => readonly string[]) {
  exigirDelCatalogo(posibles);
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const funciones = elegir(req);
    exigirDelCatalogo(funciones);
    return verificarFunciones(req, funciones);
  };
}

/** `status` de la consulta, tal como llegó (la validación de valores es del servicio). */
export function estadoDeLaConsulta(req: FastifyRequest): unknown {
  const q = req.query as Record<string, unknown> | undefined;
  return q?.status;
}
