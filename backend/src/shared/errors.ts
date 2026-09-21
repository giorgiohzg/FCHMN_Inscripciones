export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "VALIDATION_ERROR", message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Credenciales inválidas") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "No tiene permisos para realizar esta acción") {
    super(403, "FORBIDDEN", message);
  }
}

export class AccountLockedError extends AppError {
  constructor(lockedUntil: Date) {
    super(423, "ACCOUNT_LOCKED", `Cuenta bloqueada temporalmente hasta ${lockedUntil.toISOString()}`);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string) {
    super(404, "NOT_FOUND", `${entity} no encontrado`);
  }
}

/**
 * Conflicto con el estado actual del recurso: duplicado (P2002), operación
 * ya aplicada, o dos solicitudes concurrentes compitiendo por el mismo
 * recurso. Es reintentable desde el punto de vista del cliente, a
 * diferencia de un ValidationError.
 */
export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, "CONFLICT", message, details);
  }
}

/**
 * La aplicación está viva pero no puede atender: la base de datos no
 * responde, la conexión se cerró, una consulta agotó su tiempo. Es distinto de
 * un 500 —que dice "algo se rompió y no sabemos qué"— porque le indica al
 * cliente y a cualquier balanceador que reintentar más tarde tiene sentido.
 */
export class ServiceUnavailableError extends AppError {
  constructor(message = "El servicio no está disponible en este momento. Intente nuevamente en unos instantes.") {
    super(503, "SERVICE_UNAVAILABLE", message);
  }
}

/**
 * El usuario está autenticado pero tiene `mustChangePassword = true`: hasta
 * que cambie su contraseña solo puede consultar su sesión, cambiarla y
 * cerrar sesión. Código propio (no un 403 genérico) para que el frontend
 * pueda redirigir a la pantalla de cambio en vez de mostrar "sin permisos".
 */
export class PasswordChangeRequiredError extends AppError {
  constructor() {
    super(403, "PASSWORD_CHANGE_REQUIRED", "Debe cambiar su contraseña antes de usar el sistema.");
  }
}
