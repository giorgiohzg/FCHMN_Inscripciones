import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyAccessToken, type AccessTokenPayload } from "./jwt.util";
import { loadAuthorizationState } from "./authorization";
import { ForbiddenError, PasswordChangeRequiredError, UnauthorizedError } from "../../shared/errors";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Identidad y autorización VIGENTES del solicitante.
     *
     * Ojo: aunque el tipo coincide con el payload del JWT, los campos
     * `roles`, `permissions` y `clubId` NO salen del token — se recargan de
     * la base en cada solicitud (ver `authenticate`). El token solo aporta
     * la identidad (`sub`).
     */
    authUser?: AccessTokenPayload;
    authState?: { mustChangePassword: boolean };
  }
}

/**
 * Autentica y revalida la autorización contra la base de datos.
 *
 * Un access token vive 15 minutos y lleva dentro roles, permisos y club.
 * Confiar en esa copia significaba que, durante esos 15 minutos:
 *   - un usuario al que se le retiraba un rol conservaba sus permisos;
 *   - una persona removida como delegado de un club seguía operando sobre
 *     ese club, porque el `clubId` viajaba dentro del token;
 *   - una cuenta bloqueada, inhabilitada o eliminada seguía trabajando.
 *
 * Por eso el estado se recarga entero en cada solicitud y el token queda
 * reducido a un portador de identidad. El costo son dos consultas indexadas
 * por solicitud; a cambio, revocar un permiso surte efecto de inmediato y no
 * hay que acordarse de invalidar tokens en cada punto que cambie roles o
 * asignaciones (que es justo lo que un esquema de versionado exigiría).
 */
async function authenticate(req: FastifyRequest): Promise<{ mustChangePassword: boolean }> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Token de acceso no provisto");
  }
  const token = header.slice("Bearer ".length);

  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new UnauthorizedError("Token de acceso inválido o expirado");
  }

  const state = await loadAuthorizationState(payload.sub);

  // Mensaje único para todos los casos: a quien porta un token no se le
  // informa si la cuenta fue bloqueada, inhabilitada o eliminada.
  if (!state || state.deletedAt || state.status !== "active") {
    throw new UnauthorizedError("La sesión ya no es válida. Vuelva a iniciar sesión.");
  }

  req.authUser = {
    sub: state.userId,
    ownerType: state.ownerType,
    personId: state.personId,
    clubId: state.clubId,
    roles: state.roles,
    permissions: state.permissions,
  };
  req.authState = { mustChangePassword: state.mustChangePassword };
  return { mustChangePassword: state.mustChangePassword };
}

/**
 * Autenticación para todas las rutas protegidas. Deniega por omisión
 * mientras el usuario tenga `mustChangePassword = true`: cualquier ruta
 * nueva queda cubierta sin tener que acordarse de agregar el guard.
 *
 * Las operaciones que SÍ deben funcionar en ese estado (ver la sesión y
 * cambiar la contraseña) usan `requireAuthDuringPasswordChange`.
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  const { mustChangePassword } = await authenticate(req);
  if (mustChangePassword) {
    throw new PasswordChangeRequiredError();
  }
}

/**
 * Igual que `requireAuth` pero permite operar con la contraseña pendiente
 * de cambio. Uso EXCLUSIVO de `/auth/me` y `/auth/change-password`.
 */
export async function requireAuthDuringPasswordChange(req: FastifyRequest, _reply: FastifyReply) {
  await authenticate(req);
}

/**
 * Factory de middleware: exige que el usuario autenticado tenga AL MENOS
 * uno de los permisos indicados (evaluado en backend, nunca confiar solo
 * en lo que oculta/muestra el frontend).
 */
export function requirePermission(...anyOf: string[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.authUser) throw new UnauthorizedError();
    const hasPermission = anyOf.some((p) => req.authUser!.permissions.includes(p));
    if (!hasPermission) {
      throw new ForbiddenError(`Requiere uno de los siguientes permisos: ${anyOf.join(", ")}`);
    }
  };
}

export function requireRole(...anyOf: string[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.authUser) throw new UnauthorizedError();
    const hasRole = anyOf.some((r) => req.authUser!.roles.includes(r));
    if (!hasRole) {
      throw new ForbiddenError(`Requiere uno de los siguientes roles: ${anyOf.join(", ")}`);
    }
  };
}
