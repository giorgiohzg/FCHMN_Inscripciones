import { prisma } from "../../shared/prisma.client";
import { env } from "../../shared/env";
import { audit } from "../audit/audit.service";
import { signAccessToken, verifyAccessToken, type SessionOwnerType } from "./jwt.util";
import { loadRolesAndPermissions, resolvePersonClubId } from "./authorization";
import { hashPassword, verifyPassword, generateOpaqueToken, hashOpaqueToken } from "./password.util";
import { AccountLockedError, UnauthorizedError, ValidationError } from "../../shared/errors";
import type { LoginInput, ChangePasswordInput } from "./auth.schemas";

interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

/**
 * RB-15: bloqueo temporal tras N intentos fallidos de login.
 */
async function registerFailedAttempt(userId: string, ip?: string) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: { increment: 1 } },
  });

  if (user.failedLoginAttempts >= env.LOGIN_MAX_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + env.LOGIN_LOCKOUT_MINUTES * 60_000);
    await prisma.user.update({
      where: { id: userId },
      data: { status: "locked", lockedUntil, failedLoginAttempts: 0 },
    });
    await audit({
      userId,
      action: "USER_LOCKED",
      entityType: "User",
      entityId: userId,
      ipAddress: ip,
      after: { lockedUntil },
    });
  }
}

// `loadRolesAndPermissions` y `resolvePersonClubId` viven ahora en
// `./authorization`, compartidos con `rbac.middleware`: el login, el refresco
// y cada solicitud autenticada resuelven la autorización exactamente igual.

interface SessionUser {
  id: string;
  ownerType: SessionOwnerType;
  personId: string | null;
  clubId: string | null;
  username: string;
}

/**
 * Club al que queda acotada la sesión, resuelto de forma EXHAUSTIVA sobre el
 * tipo de dueño. Las tres ramas eran antes dos, y la del administrador
 * (`system`) se colaba por la de `person`: terminaba llamando a
 * `resolvePersonClubId(null)`, que devuelve `null` porque no hay persona, no
 * porque se hubiera decidido que un administrador no tiene club.
 */
async function resolveEffectiveClubId(user: SessionUser): Promise<string | null> {
  switch (user.ownerType) {
    case "club":
      return user.clubId;
    case "system":
      return null;
    case "person":
      return resolvePersonClubId(user.personId);
  }
}

/**
 * Emite un par access + refresh para un usuario ya autenticado. Centraliza
 * lo que antes estaba duplicado entre `login` y `refresh`, y permite que
 * `changePassword` devuelva una sesión utilizable en vez de dejar al cliente
 * con un refresh token que el propio backend acaba de revocar.
 */
async function issueSession(user: SessionUser, ctx: RequestContext) {
  const { roles, permissions } = await loadRolesAndPermissions(user.id);
  const effectiveClubId = await resolveEffectiveClubId(user);

  const accessToken = signAccessToken({
    sub: user.id,
    ownerType: user.ownerType,
    personId: user.personId,
    clubId: effectiveClubId,
    roles,
    permissions,
  });

  const { token: refreshToken, tokenHash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRES_IN_DAYS * 86_400_000);
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash, expiresAt, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
  });

  return { accessToken, refreshToken, roles, effectiveClubId };
}

export async function login(input: LoginInput, ctx: RequestContext) {
  /**
   * `findFirst` y no `findUnique`: desde el hallazgo 20, `users.username` es
   * único solo entre cuentas VIGENTES, así que puede haber varias filas con el
   * mismo nombre —las eliminadas lógicamente conservan el suyo como historial—
   * y solo una de ellas está activa. Se busca directamente esa; el rechazo por
   * `deletedAt` de más abajo se conserva por si alguna llegara igual.
   */
  const user = await prisma.user.findFirst({ where: { username: input.username, deletedAt: null } });

  // Mensaje genérico: no revelar si el usuario existe o no (evita user enumeration).
  const genericError = () => new UnauthorizedError("Usuario o contraseña incorrectos");

  if (!user || user.deletedAt) {
    throw genericError();
  }

  if (user.status === "disabled") {
    throw new UnauthorizedError("Cuenta inhabilitada. Contacte al administrador.");
  }

  if (user.status === "locked") {
    // Se distinguen DOS bloqueos distintos que antes se trataban igual:
    //
    //  - Temporal (RB-15, N intentos fallidos): tiene `lockedUntil`. Al
    //    vencer, la cuenta se reactiva sola.
    //  - Administrativo (un admin bloqueó la cuenta): NO tiene `lockedUntil`,
    //    es indefinido y solo un administrador puede levantarlo.
    //
    // Antes, el bloqueo administrativo caía en la rama de "el bloqueo
    // expiró" (porque `lockedUntil` es null) y la cuenta se reactivaba sola
    // en el siguiente intento de login: el bloqueo no servía de nada.
    if (!user.lockedUntil) {
      throw new UnauthorizedError("Cuenta bloqueada por un administrador. Contacte al administrador.");
    }
    if (user.lockedUntil > new Date()) {
      throw new AccountLockedError(user.lockedUntil);
    }
    await prisma.user.update({ where: { id: user.id }, data: { status: "active", lockedUntil: null } });
  }

  const validPassword = await verifyPassword(user.passwordHash, input.password);
  if (!validPassword) {
    await registerFailedAttempt(user.id, ctx.ipAddress);
    await audit({
      userId: user.id,
      action: "LOGIN_FAILED",
      entityType: "User",
      entityId: user.id,
      ipAddress: ctx.ipAddress,
    });
    throw genericError();
  }

  // Login exitoso: resetear contador, actualizar último acceso.
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lastLoginAt: new Date() },
  });

  const { accessToken, refreshToken, roles, effectiveClubId } = await issueSession(user, ctx);

  await audit({ userId: user.id, action: "LOGIN", entityType: "User", entityId: user.id, ipAddress: ctx.ipAddress });

  return {
    accessToken,
    refreshToken,
    mustChangePassword: user.mustChangePassword,
    user: { id: user.id, username: user.username, ownerType: user.ownerType, personId: user.personId, clubId: effectiveClubId, roles },
  };
}

/**
 * Rotación de refresh token: el token usado se invalida y se emite uno nuevo.
 * Si se detecta reuso de un token ya revocado, se revocan TODOS los tokens
 * del usuario (indicio de robo de token).
 */
export async function refresh(refreshTokenPlain: string, ctx: RequestContext) {
  const tokenHash = hashOpaqueToken(refreshTokenPlain);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });

  if (!stored) throw new UnauthorizedError("Sesión inválida");

  if (stored.revokedAt) {
    // Reuso de token revocado: posible robo -> invalidar toda la sesión.
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({
      userId: stored.userId,
      action: "REFRESH_TOKEN_REUSE_DETECTED",
      entityType: "User",
      entityId: stored.userId,
      ipAddress: ctx.ipAddress,
    });
    throw new UnauthorizedError("Sesión inválida. Vuelva a iniciar sesión.");
  }

  if (stored.expiresAt < new Date()) {
    throw new UnauthorizedError("Sesión expirada");
  }

  const user = stored.user;
  if (user.status !== "active" || user.deletedAt) {
    throw new UnauthorizedError("Cuenta no disponible");
  }

  const { token: newRefreshToken, tokenHash: newHash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRES_IN_DAYS * 86_400_000);

  // Rotación ATÓMICA. La lectura de arriba solo sirve para decidir; el
  // consumo real es este `updateMany` condicionado a `revokedAt: null`, y se
  // comprueba cuántas filas cambió. Dos solicitudes concurrentes con el
  // mismo refresh token entran ambas al `findUnique` y ven `revokedAt: null`,
  // pero solo UNA logra `count === 1`: la otra se rechaza en vez de emitir
  // una segunda sesión válida a partir del mismo token.
  await prisma.$transaction(async (tx) => {
    const consumed = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedBy: newHash },
    });

    if (consumed.count !== 1) {
      throw new UnauthorizedError("Sesión inválida. Vuelva a iniciar sesión.");
    }

    await tx.refreshToken.create({
      data: { userId: user.id, tokenHash: newHash, expiresAt, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    });
  });

  const { roles, permissions } = await loadRolesAndPermissions(user.id);
  const effectiveClubId = await resolveEffectiveClubId(user);
  const accessToken = signAccessToken({
    sub: user.id,
    ownerType: user.ownerType,
    personId: user.personId,
    clubId: effectiveClubId,
    roles,
    permissions,
  });

  /**
   * Devuelve el PERFIL COMPLETO, igual que el login.
   *
   * Antes solo devolvía los tokens. Desde que el access token vive en memoria,
   * el refresco es la única vía de reconstruir la sesión al recargar la página:
   * si no trae el usuario, el cliente queda autenticado pero sin saber quién es
   * —sin nombre, sin `ownerType`, sin `mustChangePassword`—, y todo lo que
   * dependa de eso deja de funcionar. Que el frontend lo tuviera guardado en
   * `sessionStorage` no puede ser la fuente: ese almacenamiento puede estar
   * vacío (pestaña nueva, modo privado, datos borrados) mientras la cookie
   * sigue siendo válida.
   */
  return {
    accessToken,
    refreshToken: newRefreshToken,
    mustChangePassword: user.mustChangePassword,
    user: { id: user.id, username: user.username, ownerType: user.ownerType, personId: user.personId, clubId: effectiveClubId, roles },
  };
}

/**
 * Hallazgo 23 — la revocación de sesión no dejaba rastro.
 *
 * `LOGIN` sí se auditaba; el cierre, no. El registro mostraba sesiones que se
 * abrían y nunca terminaban, y no había forma de distinguir "sigue conectado"
 * de "cerró sesión hace horas" al revisar un incidente.
 *
 * Es best-effort: si no se puede anotar, el cierre igual ocurre. Dejar una
 * sesión viva porque falló una escritura de auditoría sería peor que perder la
 * anotación, y la pérdida queda avisada como `audit_write_failed`.
 */
export async function logout(refreshTokenPlain: string, ctx: RequestContext = {}) {
  const tokenHash = hashOpaqueToken(refreshTokenPlain);

  // Se lee antes de revocar para saber QUÉ sesión y de quién: `updateMany` no
  // devuelve las filas afectadas.
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash }, select: { id: true, userId: true, revokedAt: true } });

  const { count } = await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // Solo se audita una revocación REAL: reintentar el logout con un token ya
  // revocado no agrega nada al rastro.
  if (count > 0 && stored) {
    await audit({
      // `entityId` identifica la ENTIDAD auditada, que aquí es el token
      // revocado, no su dueño: repetir el `userId` en los dos campos hacía
      // imposible distinguir cuál de las sesiones de una persona se cerró.
      userId: stored.userId,
      action: "LOGOUT",
      entityType: "RefreshToken",
      entityId: stored.id,
      ipAddress: ctx.ipAddress,
    });
  }
}

/**
 * Cambia la contraseña y devuelve una sesión NUEVA.
 *
 * Antes revocaba todos los refresh tokens y no devolvía nada: el cliente se
 * quedaba con un refresh token que el backend acababa de invalidar, y el
 * siguiente `/auth/refresh` lo expulsaba. Ahora el cambio revoca las sesiones
 * anteriores y emite una sola sesión válida para quien acaba de cambiarla —
 * las sesiones abiertas en otros dispositivos sí se cierran, que es el
 * comportamiento buscado.
 */
export async function changePassword(userId: string, input: ChangePasswordInput, ctx: RequestContext) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const valid = await verifyPassword(user.passwordHash, input.currentPassword);
  if (!valid) throw new ValidationError("La contraseña actual es incorrecta");

  const newHash = await hashPassword(input.newPassword);

  // Todo en una sola transacción: cambiar la contraseña, revocar las
  // sesiones anteriores y crear la nueva. Si la creación de la sesión fallara
  // fuera de la transacción, el usuario recibiría un error DESPUÉS de que su
  // contraseña ya cambió y con todas sus sesiones revocadas — quedaría
  // fuera del sistema sin saber con qué contraseña volver a entrar.
  const { roles, permissions } = await loadRolesAndPermissions(user.id);
  const effectiveClubId = await resolveEffectiveClubId(user);
  const { token: refreshToken, tokenHash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRES_IN_DAYS * 86_400_000);

  /**
   * Cambiar la contraseña SÍ es una acción trazable —no un evento de sesión
   * como el login—, así que su registro va dentro de la misma transacción que
   * el cambio: no puede quedar una contraseña nueva sin constancia de quién la
   * cambió y desde dónde.
   */
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash: newHash, mustChangePassword: false },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.refreshToken.create({
      data: { userId: user.id, tokenHash, expiresAt, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    });
    await audit({ userId, action: "PASSWORD_CHANGED", entityType: "User", entityId: userId, ipAddress: ctx.ipAddress }, { tx });
  });

  // Firmar el token es una operación pura en memoria: no puede fallar por
  // estado externo, así que puede quedar fuera de la transacción.
  const accessToken = signAccessToken({
    sub: user.id,
    ownerType: user.ownerType,
    personId: user.personId,
    clubId: effectiveClubId,
    roles,
    permissions,
  });

  /**
   * Devuelve la SESIÓN COMPLETA, igual que `login` y `refresh`.
   *
   * Antes devolvía solo `{ accessToken, refreshToken, mustChangePassword }`, sin
   * el usuario. El cliente adopta la sesión que sale de aquí, así que se quedaba
   * sin perfil: sin nombre, sin `ownerType`, sin club. La validación en tiempo
   * de ejecución del frontend exige ese perfil, y la incoherencia solo no se
   * notaba porque las pruebas de allá lo añadían en sus dobles.
   */
  return {
    accessToken,
    refreshToken,
    mustChangePassword: false,
    user: { id: user.id, username: user.username, ownerType: user.ownerType, personId: user.personId, clubId: effectiveClubId, roles },
  };
}

/**
 * NOTA sobre la recuperación de contraseña.
 *
 * El flujo de auto-recuperación (`/auth/forgot-password` + `/auth/reset-password`)
 * se eliminó por decisión explícita: el sistema no dispone de un servidor de
 * correo, y la implementación anterior generaba un token que devolvía en la
 * respuesta HTTP — cualquiera que supiera un nombre de usuario podía obtener
 * el token de restablecimiento de esa cuenta y tomarla.
 *
 * El único camino de recuperación es el restablecimiento administrativo, que
 * ya existía y sigue vigente:
 *   POST /persons/:id/credentials/reset   (persons.service)
 *   POST /clubs/:id/credentials/reset     (clubs.service)
 * Ambos generan una contraseña temporal, la muestran UNA sola vez a quien
 * administra, marcan `mustChangePassword = true` y revocan las sesiones
 * activas de esa cuenta.
 */

export { verifyAccessToken };
