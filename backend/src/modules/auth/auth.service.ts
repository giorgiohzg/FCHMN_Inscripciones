import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { env } from "../../shared/env";
import { audit } from "../audit/audit.service";
import { signAccessToken, verifyAccessToken, type SessionOwnerType } from "./jwt.util";
import { loadRolesAndPermissions, resolvePersonClubId } from "./authorization";
import { hashPassword, verifyPassword, generateOpaqueToken, hashOpaqueToken } from "./password.util";
import {
  OPCIONES_TX_SESION,
  bloquearSesion,
  bloquearToken,
  bloquearUsuario,
  crearSesion,
  terminarSesion,
  terminarSesionesDelUsuario,
  vencimientoDeRefresh,
  type UsuarioBloqueado,
} from "./sessions";
import { AccountLockedError, ConflictError, UnauthorizedError, ValidationError, type AppError } from "../../shared/errors";
import type { LoginInput, ChangePasswordInput } from "./auth.schemas";

interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

type Tx = Prisma.TransactionClient;

/** Un bloqueo temporal cuyo plazo ya pasó. Uno administrativo no tiene `lockedUntil` y nunca vence. */
function bloqueoTemporalVencido(cuenta: Pick<UsuarioBloqueado, "status" | "lockedUntil">, ahora: Date): boolean {
  return cuenta.status === "locked" && cuenta.lockedUntil !== null && cuenta.lockedUntil <= ahora;
}

/**
 * RB-15: bloqueo temporal tras N intentos fallidos de login.
 *
 * Este intento se verificó FUERA del bloqueo contra el hash H0, así que para
 * cuando llega aquí la cuenta pudo cambiar. Todo se decide con su estado actual,
 * en UNA transacción: antes eran dos escrituras sin condición, y un intento
 * iniciado antes de un bloqueo administrativo o una inhabilitación podía
 * sobrescribirlos con un bloqueo temporal, que luego vencía y dejaba la cuenta
 * activa.
 *
 * Un intento descartado no escribe nada. Quien llama responde igual en todos los
 * casos.
 */
async function registerFailedAttempt(userId: string, hashVerificado: string, ip?: string) {
  await prisma.$transaction(async (tx) => {
    const cuenta = await bloquearUsuario(tx, userId);
    const ahora = new Date();

    if (!cuenta || cuenta.deletedAt !== null) return;
    // La contraseña cambió: el intento fue contra una credencial que ya no existe.
    if (cuenta.passwordHash !== hashVerificado) return;
    if (cuenta.status === "disabled") return;

    const vencido = bloqueoTemporalVencido(cuenta, ahora);
    // Administrativo o temporal vigente: prevalece, y el intento no cuenta.
    if (cuenta.status === "locked" && !vencido) return;

    if (cuenta.failedLoginAttempts + 1 >= env.LOGIN_MAX_ATTEMPTS) {
      const lockedUntil = new Date(ahora.getTime() + env.LOGIN_LOCKOUT_MINUTES * 60_000);
      await tx.user.update({ where: { id: userId }, data: { status: "locked", lockedUntil, failedLoginAttempts: 0 } });
      await audit(
        { userId, action: "USER_LOCKED", entityType: "User", entityId: userId, ipAddress: ip, after: { lockedUntil } },
        { tx }
      );
      return;
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: cuenta.failedLoginAttempts + 1,
        // Reactivar un bloqueo vencido va aquí, con la cuenta bloqueada y su
        // estado releído. Antes se escribía sin condición ANTES de verificar la
        // contraseña, y podía deshacer un bloqueo administrativo recién aplicado.
        ...(vencido ? { status: "active" as const, lockedUntil: null } : {}),
      },
    });
  }, OPCIONES_TX_SESION);
}

/**
 * Por qué esta cuenta no puede iniciar sesión, o `null` si puede.
 *
 * Se evalúa antes de verificar la contraseña y otra vez bajo bloqueo, para que
 * un estado aplicado entre medias responda exactamente igual. Un bloqueo temporal
 * vencido no impide entrar: se levanta al confirmar.
 */
function rechazoDeLogin(cuenta: Pick<UsuarioBloqueado, "status" | "lockedUntil">, ahora: Date): AppError | null {
  if (cuenta.status === "disabled") {
    return new UnauthorizedError("Cuenta inhabilitada. Contacte al administrador.");
  }

  if (cuenta.status === "locked") {
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
    if (!cuenta.lockedUntil) {
      return new UnauthorizedError("Cuenta bloqueada por un administrador. Contacte al administrador.");
    }
    if (cuenta.lockedUntil > ahora) {
      return new AccountLockedError(cuenta.lockedUntil);
    }
  }
  return null;
}

/**
 * ¿La persona dueña de la cuenta sigue utilizable? Se lee sin bloquearla: nada que
 * tenga `users` puede bloquear `persons`. Va en una sentencia aparte de la que
 * bloquea la cuenta para que, tras esperar ese bloqueo, vea lo ya confirmado.
 */
async function personaUtilizable(tx: Tx, personId: string | null): Promise<boolean> {
  if (!personId) return true;
  const persona = await tx.person.findUnique({ where: { id: personId }, select: { status: true, deletedAt: true } });
  return persona !== null && persona.status === "active" && persona.deletedAt === null;
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
async function resolveEffectiveClubId(user: SessionUser, esAdministrador: boolean): Promise<string | null> {
  /**
   * Un administrador no pasa por la resolución de club, igual que en
   * `loadAuthorizationState`. No es una optimización: `resolvePersonClubId`
   * LANZA si la persona figura como personal de más de un club, y eso dejaría
   * a un administrador en esa situación sin poder ni iniciar sesión, pese a
   * que su alcance no depende de ningún club.
   */
  if (esAdministrador) return null;

  switch (user.ownerType) {
    case "club":
      return user.clubId;
    case "system":
      return null;
    case "person":
      return resolvePersonClubId(user.personId);
  }
}

interface AutorizacionDeSesion {
  roles: string[];
  permissions: string[];
  effectiveClubId: string | null;
}

/**
 * Roles, permisos y club con los que se firmará el token.
 *
 * Se resuelve SIEMPRE fuera de la transacción y antes de escribir: puede lanzar
 * (una persona con vínculos en más de un club), y lanzar después de consumir un
 * refresh token deja al navegador con una cookie ya rotada, que el siguiente
 * intento leería como un reuso.
 */
async function resolverAutorizacion(user: SessionUser): Promise<AutorizacionDeSesion> {
  const { roles, permissions } = await loadRolesAndPermissions(user.id);
  return { roles, permissions, effectiveClubId: await resolveEffectiveClubId(user, roles.includes("admin")) };
}

/**
 * Firma el access token de una sesión. Es una operación pura en memoria: no
 * puede fallar por estado externo, así que queda fuera de la transacción.
 */
function firmarAccessToken(user: SessionUser, sid: string, autorizacion: AutorizacionDeSesion): string {
  return signAccessToken({
    sub: user.id,
    sid,
    ownerType: user.ownerType,
    personId: user.personId,
    clubId: autorizacion.effectiveClubId,
    roles: autorizacion.roles,
    permissions: autorizacion.permissions,
  });
}

export async function login(input: LoginInput, ctx: RequestContext) {
  /**
   * `findFirst` y no `findUnique`: desde el hallazgo 20, `users.username` es
   * único solo entre cuentas VIGENTES, así que puede haber varias filas con el
   * mismo nombre —las eliminadas lógicamente conservan el suyo como historial—
   * y solo una de ellas está activa. Se busca directamente esa; el rechazo por
   * `deletedAt` de más abajo se conserva por si alguna llegara igual.
   */
  const user = await prisma.user.findFirst({
    where: { username: input.username, deletedAt: null },
    include: { person: { select: { status: true, deletedAt: true } } },
  });

  // Mensaje genérico: no revelar si el usuario existe o no (evita user enumeration).
  const genericError = () => new UnauthorizedError("Usuario o contraseña incorrectos");

  if (!user || user.deletedAt) {
    throw genericError();
  }

  /**
   * El estado de la PERSONA dueña también decide, no solo el de la cuenta.
   *
   * `users.status` y `persons.status` son columnas distintas y nada en la
   * base obliga a que coincidan. Bastaba una incoherencia —una persona
   * inhabilitada o eliminada cuya cuenta siguiera activa— para que entrara
   * con normalidad. Los caminos que inhabilitan a una persona ya inhabilitan
   * su cuenta, así que esto no debería ocurrir; precisamente por eso es una
   * red de seguridad y no una comprobación de rutina.
   *
   * Se responde con el error GENÉRICO, no con «cuenta inhabilitada»: por qué
   * no puede entrar es asunto de la administración, no de quien lo intenta.
   *
   * Las cuentas `system` y `club` no tienen persona, así que para ellas esto
   * no cambia nada.
   */
  if (user.person && (user.person.status !== "active" || user.person.deletedAt !== null)) {
    throw genericError();
  }

  const previo = rechazoDeLogin(user, new Date());
  if (previo) throw previo;

  // Argon2, fuera de cualquier bloqueo. `user.passwordHash` es H0: lo que se
  // verifique aquí vale solo mientras ese siga siendo el hash de la cuenta.
  const validPassword = await verifyPassword(user.passwordHash, input.password);
  if (!validPassword) {
    await registerFailedAttempt(user.id, user.passwordHash, ctx.ipAddress);
    await audit({
      userId: user.id,
      action: "LOGIN_FAILED",
      entityType: "User",
      entityId: user.id,
      ipAddress: ctx.ipAddress,
    });
    throw genericError();
  }

  const autorizacion = await resolverAutorizacion(user);

  /**
   * LA CREDENCIAL SE REVALIDA BAJO BLOQUEO, antes de emitir nada.
   *
   * Entre la verificación y este punto la cuenta pudo cambiar de contraseña, o
   * ser bloqueada, inhabilitada o eliminada. Sin esto, un login iniciado antes
   * terminaba con una sesión viva que nadie iba a revocar. Lanzar aquí no pierde
   * nada: todavía no se escribió.
   */
  const { sessionId, refreshToken, mustChangePassword } = await prisma.$transaction(async (tx) => {
    const cuenta = await bloquearUsuario(tx, user.id);
    const ahora = new Date();

    if (!cuenta || cuenta.deletedAt !== null || cuenta.passwordHash !== user.passwordHash) throw genericError();
    const rechazo = rechazoDeLogin(cuenta, ahora);
    if (rechazo) throw rechazo;
    if (!(await personaUtilizable(tx, cuenta.personId))) throw genericError();

    // Login exitoso: resetear contador, actualizar último acceso y, si había un
    // bloqueo temporal ya vencido, levantarlo aquí, con el estado releído.
    await tx.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lastLoginAt: ahora,
        ...(bloqueoTemporalVencido(cuenta, ahora) ? { status: "active" as const, lockedUntil: null } : {}),
      },
    });

    const sesion = await crearSesion(tx, user.id, ctx);
    return { ...sesion, mustChangePassword: cuenta.mustChangePassword };
  }, OPCIONES_TX_SESION);

  const accessToken = firmarAccessToken(user, sessionId, autorizacion);

  await audit({ userId: user.id, action: "LOGIN", entityType: "User", entityId: user.id, ipAddress: ctx.ipAddress });

  return {
    accessToken,
    refreshToken,
    mustChangePassword,
    user: {
      id: user.id,
      username: user.username,
      ownerType: user.ownerType,
      personId: user.personId,
      clubId: autorizacion.effectiveClubId,
      roles: autorizacion.roles,
    },
  };
}

/** Desenlace de un refresco, decidido bajo bloqueo. Ver la nota en `refresh`. */
type DesenlaceDeRefresco =
  | { tipo: "rotado"; sessionId: string; refreshToken: string; mustChangePassword: boolean }
  | { tipo: "rechazado"; mensaje: string };

/**
 * Rotación de refresh token: el token usado se consume y se emite el siguiente,
 * dentro de la misma sesión.
 *
 * EL ESTADO DE LA SESIÓN DECIDE PRIMERO, y solo después el del token. Clasificar
 * solo por `revokedAt` trataba como robo cualquier cookie antigua: tras un cambio
 * de contraseña, el dispositivo que seguía con la cookie vieja revocaba la sesión
 * nueva. Y `replaced_by` tampoco basta por sí solo: un token rotado puede pertenecer
 * a una familia que luego terminó legítimamente.
 *
 *   | Bajo bloqueo                                 | Resultado                    |
 *   |----------------------------------------------|------------------------------|
 *   | Token desconocido o sin sesión (histórico)   | 401, sin efectos             |
 *   | Sesión terminada o vencida                   | 401, sin efectos             |
 *   | Sesión activa, token ya rotado               | Reuso: termina ESA sesión    |
 *   | Sesión activa, token vigente                 | Rota                         |
 *
 * Un reuso termina solo la sesión afectada: las demás sesiones de la cuenta no
 * aportan indicio alguno y no se tocan.
 *
 * NUNCA SE LANZA DENTRO DE LA TRANSACCIÓN DESPUÉS DE ESCRIBIR. Un error ahí
 * revertiría la revocación por reuso y su auditoría justo cuando la respuesta es
 * una denegación. La transacción devuelve el desenlace, confirma, y recién
 * entonces se lanza.
 */
export async function refresh(refreshTokenPlain: string, ctx: RequestContext) {
  const tokenHash = hashOpaqueToken(refreshTokenPlain);

  // Lectura de ORIENTACIÓN, sin bloqueo: solo dice a quién bloquear. Nada de lo
  // que se lee aquí se da por válido más abajo.
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: {
      session: { select: { revokedAt: true, absoluteExpiresAt: true } },
      user: { include: { person: { select: { status: true, deletedAt: true } } } },
    },
  });

  if (!stored || !stored.sessionId) throw new UnauthorizedError("Sesión inválida");
  const { user, sessionId: sesionDelToken } = stored;

  /**
   * La autorización se resuelve ANTES de consumir el token, y solo si la lectura
   * dice que hay algo que rotar: un token inservible no llega a consultarla y
   * responde su 401. Si puede rotar, puede dejar de poder, pero nunca al revés.
   */
  const ahoraOrientacion = new Date();
  const puedeRotar =
    stored.revokedAt === null &&
    stored.expiresAt >= ahoraOrientacion &&
    stored.session?.revokedAt === null &&
    stored.session.absoluteExpiresAt > ahoraOrientacion &&
    user.status === "active" &&
    user.deletedAt === null &&
    (user.person === null || (user.person.status === "active" && user.person.deletedAt === null));
  const autorizacion = puedeRotar ? await resolverAutorizacion(user) : null;

  const desenlace = await prisma.$transaction(async (tx): Promise<DesenlaceDeRefresco> => {
    const cuenta = await bloquearUsuario(tx, user.id);
    const sesion = await bloquearSesion(tx, sesionDelToken);
    const token = await bloquearToken(tx, tokenHash);
    const ahora = new Date();

    if (!cuenta || !sesion || !token) return { tipo: "rechazado", mensaje: "Sesión inválida" };

    // 1. La sesión. Terminada o vencida: no hay nada que proteger ni que revocar.
    if (sesion.revokedAt) return { tipo: "rechazado", mensaje: "Sesión inválida. Vuelva a iniciar sesión." };
    if (sesion.absoluteExpiresAt <= ahora) return { tipo: "rechazado", mensaje: "Sesión expirada" };

    // 2. El token. Rotado en una sesión ACTIVA: alguien más tiene una copia.
    if (token.replacedBy !== null) {
      await terminarSesion(tx, sesion.id, "reuse_detected");
      await audit(
        {
          userId: user.id,
          action: "REFRESH_TOKEN_REUSE_DETECTED",
          entityType: "User",
          entityId: user.id,
          ipAddress: ctx.ipAddress,
          after: { sessionId: sesion.id },
        },
        { tx }
      );
      return { tipo: "rechazado", mensaje: "Sesión inválida. Vuelva a iniciar sesión." };
    }
    // Revocado sin haber rotado, en una sesión activa: el invariante lo impide.
    if (token.revokedAt) return { tipo: "rechazado", mensaje: "Sesión inválida. Vuelva a iniciar sesión." };
    if (token.expiresAt < ahora) return { tipo: "rechazado", mensaje: "Sesión expirada" };

    // 3. La cuenta. El bloqueo temporal sigue rechazando aquí, igual que antes.
    if (cuenta.status !== "active" || cuenta.deletedAt !== null || !(await personaUtilizable(tx, cuenta.personId))) {
      return { tipo: "rechazado", mensaje: "Cuenta no disponible" };
    }

    // La orientación dijo que no se podía rotar y la lectura bajo bloqueo dice que
    // sí: esos estados no retroceden, así que no se emite nada con datos dudosos.
    if (!autorizacion) return { tipo: "rechazado", mensaje: "Sesión inválida. Vuelva a iniciar sesión." };

    const { token: newRefreshToken, tokenHash: newHash } = generateOpaqueToken();
    await tx.refreshToken.update({ where: { id: token.id }, data: { revokedAt: ahora, replacedBy: newHash } });
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        sessionId: sesion.id,
        tokenHash: newHash,
        // El límite absoluto no se mueve: renovar no extiende la sesión.
        expiresAt: vencimientoDeRefresh(sesion.absoluteExpiresAt, ahora.getTime()),
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      },
    });
    return { tipo: "rotado", sessionId: sesion.id, refreshToken: newRefreshToken, mustChangePassword: cuenta.mustChangePassword };
  }, OPCIONES_TX_SESION);

  if (desenlace.tipo === "rechazado" || !autorizacion) {
    throw new UnauthorizedError(desenlace.tipo === "rechazado" ? desenlace.mensaje : "Sesión inválida");
  }

  const accessToken = firmarAccessToken(user, desenlace.sessionId, autorizacion);

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
    refreshToken: desenlace.refreshToken,
    mustChangePassword: desenlace.mustChangePassword,
    user: {
      id: user.id,
      username: user.username,
      ownerType: user.ownerType,
      personId: user.personId,
      clubId: autorizacion.effectiveClubId,
      roles: autorizacion.roles,
    },
  };
}

/**
 * Cierra la sesión de una cookie reconocida.
 *
 * Termina la SESIÓN COMPLETA, aunque el token presentado ya esté rotado: revocar
 * solo ese token dejaba vivo a su sucesor. Un token sin sesión (histórico) se
 * revoca él solo, y ninguna otra sesión de la cuenta se toca.
 *
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

  // Lectura de orientación: QUÉ sesión y de quién.
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash }, select: { id: true, userId: true, sessionId: true } });
  if (!stored) return;
  const { sessionId } = stored;

  const cerrada = await prisma.$transaction(async (tx) => {
    await bloquearUsuario(tx, stored.userId);
    if (!sessionId) {
      const { count } = await tx.refreshToken.updateMany({ where: { id: stored.id, revokedAt: null }, data: { revokedAt: new Date() } });
      return count > 0;
    }
    return (await bloquearSesion(tx, sessionId)) !== null && terminarSesion(tx, sessionId, "logout");
  }, OPCIONES_TX_SESION);

  // Solo se audita una revocación REAL: reintentar el logout con un token ya
  // revocado no agrega nada al rastro.
  if (cerrada) {
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
  const autorizacion = await resolverAutorizacion(user);

  /**
   * Cambiar la contraseña SÍ es una acción trazable —no un evento de sesión
   * como el login—, así que su registro va dentro de la misma transacción que
   * el cambio: no puede quedar una contraseña nueva sin constancia de quién la
   * cambió y desde dónde.
   *
   * COMPARE-AND-SWAP sobre el hash verificado: dos cambios que validaron la
   * misma contraseña actual no pueden aplicarse ambos. El segundo ve que el hash
   * ya no es el que verificó y se aborta, sin revocar nada.
   */
  const { sessionId, refreshToken } = await prisma.$transaction(async (tx) => {
    const cuenta = await bloquearUsuario(tx, userId);

    if (!cuenta || cuenta.passwordHash !== user.passwordHash) {
      throw new ConflictError("La contraseña cambió mientras se procesaba la solicitud. Vuelva a intentarlo.");
    }
    if (cuenta.status !== "active" || cuenta.deletedAt !== null || !(await personaUtilizable(tx, cuenta.personId))) {
      throw new UnauthorizedError("Cuenta no disponible");
    }

    const { count } = await tx.user.updateMany({
      where: { id: userId, passwordHash: user.passwordHash },
      data: { passwordHash: newHash, mustChangePassword: false },
    });
    if (count !== 1) {
      throw new ConflictError("La contraseña cambió mientras se procesaba la solicitud. Vuelva a intentarlo.");
    }

    await terminarSesionesDelUsuario(tx, userId, "password_change");
    const sesion = await crearSesion(tx, userId, ctx);
    await audit({ userId, action: "PASSWORD_CHANGED", entityType: "User", entityId: userId, ipAddress: ctx.ipAddress }, { tx });
    return sesion;
  }, OPCIONES_TX_SESION);

  const accessToken = firmarAccessToken(user, sessionId, autorizacion);

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
    user: {
      id: user.id,
      username: user.username,
      ownerType: user.ownerType,
      personId: user.personId,
      clubId: autorizacion.effectiveClubId,
      roles: autorizacion.roles,
    },
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
