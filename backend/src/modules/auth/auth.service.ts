import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { audit } from "../audit/audit.service";
import { signAccessToken, verifyAccessToken, type SessionOwnerType } from "./jwt.util";
import { resolverAutorizacionEfectiva, type AutorizacionEfectiva } from "./authorization";
import { conArgon2, verifyPassword, verificacionFicticia, generateOpaqueToken, hashOpaqueToken } from "./password.util";
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
import { ConflictError, UnauthorizedError, type AppError } from "../../shared/errors";
import type { LoginInput, ChangePasswordInput } from "./auth.schemas";
import { aplicarFallo, estadoDeReserva, liberarReserva, reservarCambio, resultadoObsoleto, MENSAJE_SESION_NO_VALIDA } from "./cambioContrasena";
import * as limitador from "./limitadorLogin";
import { origenParaLimites } from "../../shared/ipCliente";

interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
  /**
   * Origen para los límites de login (`origenParaLimites`): IPv4, /64 de IPv6 o respaldo.
   * Sin él (llamadas internas y pruebas) se deriva de `ipAddress`.
   */
  origen?: string;
}

type Tx = Prisma.TransactionClient;

/** Un bloqueo temporal cuyo plazo ya pasó. Uno administrativo no tiene `lockedUntil` y nunca vence. */
function bloqueoTemporalVencido(cuenta: Pick<UsuarioBloqueado, "status" | "lockedUntil">, ahora: Date): boolean {
  return cuenta.status === "locked" && cuenta.lockedUntil !== null && cuenta.lockedUntil <= ahora;
}

/**
 * C-02: ya NO se crean bloqueos temporales de la cuenta entera por intentos fallidos (RB-15).
 * Los fallos los cuenta el limitador de login (`limitadorLogin.ts`), que nunca cambia el
 * estado de la cuenta ni sus sesiones. Los bloqueos temporales ANTIGUOS que queden en `users`
 * se respetan hasta su vencimiento (`bloqueoTemporalVigente`) y se levantan en el siguiente
 * login correcto (`bloqueoTemporalVencido`), como antes.
 */

/** Un bloqueo temporal (RB-15) que sigue vigente. El administrativo no tiene `lockedUntil`. */
function bloqueoTemporalVigente(cuenta: Pick<UsuarioBloqueado, "status" | "lockedUntil">, ahora: Date): boolean {
  return cuenta.status === "locked" && cuenta.lockedUntil !== null && cuenta.lockedUntil > ahora;
}

/** Respuesta única de credenciales rechazadas: no distingue usuario, contraseña ni estado. */
const MENSAJE_CREDENCIALES = "Usuario o contraseña incorrectos";
const credencialesRechazadas = () => new UnauthorizedError(MENSAJE_CREDENCIALES);

/**
 * El rechazo ESPECÍFICO de una cuenta cuyo estado impide entrar, o `null` si puede.
 *
 * Solo se llama BAJO BLOQUEO y después de comprobar que la contraseña verificada es la
 * vigente: el estado de la cuenta únicamente se revela a quien probó conocerla. Quien no
 * la prueba recibe `credencialesRechazadas`, igual que si el usuario no existiera.
 *
 *  - Inhabilitada y bloqueada por un administrador: mensaje específico.
 *  - Bloqueo temporal VIGENTE: siempre el genérico, aunque la contraseña sea la correcta, y
 *    sin `lockedUntil`. Revelar «bloqueada hasta…» dejaba a cualquiera averiguar que el
 *    usuario existe y cuándo vence. Un bloqueo temporal ya vencido no impide entrar: se
 *    levanta al confirmar.
 *
 * Se distinguen DOS bloqueos que antes se trataban igual: el temporal tiene `lockedUntil` y
 * al vencer la cuenta se reactiva sola; el administrativo no lo tiene, es indefinido y solo
 * un administrador puede levantarlo. Antes el administrativo caía en la rama de «el bloqueo
 * expiró» (porque `lockedUntil` es null) y la cuenta se reactivaba sola.
 */
function rechazoDeLogin(cuenta: Pick<UsuarioBloqueado, "status" | "lockedUntil">, ahora: Date): AppError | null {
  if (cuenta.status === "disabled") {
    return new UnauthorizedError("Cuenta inhabilitada. Contacte al administrador.");
  }
  if (cuenta.status === "locked") {
    if (!cuenta.lockedUntil) {
      return new UnauthorizedError("Cuenta bloqueada por un administrador. Contacte al administrador.");
    }
    if (cuenta.lockedUntil > ahora) return credencialesRechazadas();
  }
  return null;
}

/** Lo que el login necesita saber de la persona dueña de una cuenta. */
type PersonaDeCuenta = { status: "active" | "locked" | "disabled"; deletedAt: Date | null };

/**
 * Cómo está la persona dueña respecto de su cuenta, para decidir el login.
 *
 *  - `utilizable`: la cuenta no tiene persona, o la persona está activa y no eliminada.
 *  - `administrativa`: la persona está bloqueada o inhabilitada Y su cuenta tiene el MISMO
 *    estado, con bloqueo indefinido (`lockedUntil` nulo). Es lo que dejan `blockPerson` y
 *    `disablePerson`, que cambian ambas filas a la vez: el estado administrativo HABITUAL.
 *    El login le da el motivo, igual que a una cuenta sin persona, pero solo tras comprobar
 *    la contraseña vigente.
 *  - `incoherente`: cualquier otra cosa: persona eliminada o inexistente, o estados que no se
 *    corresponden (cuenta activa con persona inhabilitada, persona bloqueada con cuenta
 *    inhabilitada, bloqueo temporal sobre persona no activa…). Nada de esto lo produce el
 *    sistema; es la red de seguridad. Se responde SIEMPRE el genérico, con cualquier
 *    contraseña, y sin tocar la cuenta.
 */
type SituacionDePersona = "utilizable" | "administrativa" | "incoherente";

function situacionDePersona(
  personId: string | null,
  persona: PersonaDeCuenta | null,
  cuenta: Pick<UsuarioBloqueado, "status" | "lockedUntil">
): SituacionDePersona {
  if (!personId) return "utilizable";
  if (!persona || persona.deletedAt !== null) return "incoherente";
  if (persona.status === "active") return "utilizable";
  return cuenta.status === persona.status && cuenta.lockedUntil === null ? "administrativa" : "incoherente";
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

/** Lo que el login necesita saber del club dueño de una cuenta de club. */
type ClubDeCuenta = { status: "active" | "locked" | "disabled"; deletedAt: Date | null };

/**
 * Cómo está el club dueño respecto de su cuenta (AUD-04/11). Mismas tres
 * situaciones y mismo criterio que `situacionDePersona`:
 *
 *  - `utilizable`: la cuenta no es de un club, o su club está activo y no eliminado.
 *  - `administrativa`: el club está bloqueado o inhabilitado y su cuenta tiene el MISMO
 *    estado con bloqueo indefinido. Es lo que deja `setStatus` en `clubs.service`; el
 *    login da el motivo tras comprobar la contraseña vigente.
 *  - `incoherente`: club eliminado o inexistente, o estados que no se corresponden —una
 *    cuenta activa de un club bloqueado, como la dejaba el restablecimiento anterior—.
 *    Siempre el genérico, con cualquier contraseña, y sin tocar la cuenta.
 */
function situacionDeClub(
  clubId: string | null,
  club: ClubDeCuenta | null,
  cuenta: Pick<UsuarioBloqueado, "status" | "lockedUntil">
): SituacionDePersona {
  if (!clubId) return "utilizable";
  if (!club || club.deletedAt !== null) return "incoherente";
  if (club.status === "active") return "utilizable";
  return cuenta.status === club.status && cuenta.lockedUntil === null ? "administrativa" : "incoherente";
}

/** El club dueño, releído dentro de la transacción en una sentencia aparte, como la persona. */
async function clubDeCuenta(tx: Tx, clubId: string | null): Promise<ClubDeCuenta | null> {
  if (!clubId) return null;
  return tx.club.findUnique({ where: { id: clubId }, select: { status: true, deletedAt: true } });
}

interface SessionUser {
  id: string;
  ownerType: SessionOwnerType;
  personId: string | null;
  clubId: string | null;
  username: string;
}

/**
 * Roles, permisos y club con los que se firmará el token.
 *
 * Es `resolverAutorizacionEfectiva`, la MISMA que aplica `requireAuth` en cada
 * solicitud: el token, la respuesta y la autorización por solicitud no pueden
 * discrepar (AUD-04).
 *
 * Se resuelve SIEMPRE fuera de la transacción y antes de escribir: puede lanzar
 * (una persona con vínculos en más de un club), y lanzar después de consumir un
 * refresh token deja al navegador con una cookie ya rotada, que el siguiente
 * intento leería como un reuso.
 */
const resolverAutorizacion = (user: SessionUser): Promise<AutorizacionEfectiva> => resolverAutorizacionEfectiva(user);

/**
 * Firma el access token de una sesión. Es una operación pura en memoria: no
 * puede fallar por estado externo, así que queda fuera de la transacción.
 */
function firmarAccessToken(user: SessionUser, sid: string, autorizacion: AutorizacionEfectiva): string {
  return signAccessToken({
    sub: user.id,
    sid,
    ownerType: user.ownerType,
    personId: user.personId,
    clubId: autorizacion.clubId,
    roles: autorizacion.roles,
    permissions: autorizacion.permissions,
  });
}

export async function login(input: LoginInput, ctx: RequestContext) {
  const user = await buscarCuentaDeLogin(input.username);

  // Mensaje genérico: no revelar si el usuario existe o no (evita user enumeration).
  const genericError = credencialesRechazadas;

  /**
   * CONTRATO DEL LOGIN. Qué se responde depende de lo que quien llama PROBÓ:
   *
   *   | Situación                                         | Respuesta                          |
   *   |---------------------------------------------------|------------------------------------|
   *   | Un límite del limitador de login (C-02)           | 429 uniforme, sin verificar nada   |
   *   | Sin capacidad, Argon2 saturado o error técnico,   | 503, sin contar ningún fallo       |
   *   |   o un resultado obsoleto                         |                                    |
   *   | Usuario inexistente o eliminado                   | 401 genérico                       |
   *   | Contraseña incorrecta, sea cual sea el estado     | 401 genérico                       |
   *   | Incoherencia persona/cuenta (persona eliminada, o | 401 genérico                       |
   *   |   estados que no se corresponden)                 |                                    |
   *   | Bloqueo temporal VIGENTE, aunque la clave sea ok  | 401 genérico, sin `lockedUntil`    |
   *   | Inhabilitada o bloqueada por un administrador     | 401 con el motivo, solo tras       |
   *   |   —cuenta sola, o persona y cuenta con el mismo   |   comprobar la contraseña vigente  |
   *   |   estado, como dejan blockPerson/disablePerson—,  |   y revalidarla bajo bloqueo       |
   *   |   y contraseña correcta                           |                                    |
   *   | Bloqueo temporal vencido                          | flujo normal (se levanta al entrar)|
   *
   * Donde no hay una contraseña real que comprobar se hace una verificación FICTICIA de
   * Argon2: sin ella esas respuestas serían las únicas que no pagan su coste, y el tiempo
   * delataría qué usuarios existen o están bloqueados. No iguala los tiempos —quedan las
   * demás consultas—, solo elimina ese camino rápido.
   *
   * C-02: la ADMISIÓN va antes de cualquier Argon2. Sus claves dependen del nombre RECIBIDO
   * y del origen, no de que la cuenta exista: el 429 es igual para todos. `userId` viaja solo
   * para la auditoría, que ya lo registra; el limitador no lo guarda.
   */
  const admision = await limitador.admitir({
    username: input.username,
    origen: ctx.origen ?? origenParaLimites(ctx.ipAddress, undefined),
    ip: ctx.ipAddress,
    userId: user?.id,
  });

  /**
   * Verificación de TRES estados: `correcta`, `incorrecta` o `ficticia`. Saturación o error
   * técnico de Argon2 NO son una contraseña incorrecta: la reserva se libera sin cargo
   * (resultado neutro) y el error, que ya es un 503, se propaga.
   */
  let verificacion: "correcta" | "incorrecta" | "ficticia";
  try {
    verificacion = await verificarIntento(user, input.password);
  } catch (err) {
    await limitador.liquidar(admision, "neutro").catch(() => undefined);
    throw err;
  }

  if (verificacion !== "correcta") {
    // Una reserva vencida o anulada responde 503 —igual que un acierto en la misma situación—
    // para no revelar cuál fue el resultado.
    if ((await limitador.liquidar(admision, "fallo")) !== "aplicada") throw limitador.loginNoCompletado();
    if (verificacion === "incorrecta" && user) {
      await audit({ userId: user.id, action: "LOGIN_FAILED", entityType: "User", entityId: user.id, ipAddress: ctx.ipAddress });
    }
    throw genericError();
  }

  // El acierto se liquida ANTES de crear la sesión: uno obsoleto nunca llega a emitir nada.
  if ((await limitador.liquidar(admision, "acierto")) !== "aplicada") throw limitador.loginNoCompletado();
  if (!user) throw genericError(); // inalcanzable: sin cuenta la verificación es ficticia

  return emitirSesionDeLogin(user, ctx);
}

function buscarCuentaDeLogin(username: string) {
  /**
   * `findFirst` y no `findUnique`: desde el hallazgo 20, `users.username` es
   * único solo entre cuentas VIGENTES, así que puede haber varias filas con el
   * mismo nombre —las eliminadas lógicamente conservan el suyo como historial—
   * y solo una de ellas está activa. Se busca directamente esa; el rechazo por
   * `deletedAt` de más abajo se conserva por si alguna llegara igual.
   */
  return prisma.user.findFirst({
    where: { username, deletedAt: null },
    include: { person: { select: { status: true, deletedAt: true } }, club: { select: { status: true, deletedAt: true } } },
  });
}

/** Cuenta tal como la busca el login, con su persona y su club. */
type CuentaDeLogin = NonNullable<Awaited<ReturnType<typeof buscarCuentaDeLogin>>>;

/**
 * Qué se verifica, según lo que la cuenta permite comprobar (ver el CONTRATO en `login`).
 * Una verificación FICTICIA cuenta como fallo igual que una real: el limitador no distingue.
 *
 * El estado de la PERSONA dueña también decide, no solo el de la cuenta. `users.status` y
 * `persons.status` son columnas distintas y nada en la base obliga a que coincidan. Bastaba
 * una incoherencia —una persona inhabilitada o eliminada cuya cuenta siguiera activa— para que
 * entrara con normalidad. Los caminos que inhabilitan a una persona ya inhabilitan su cuenta,
 * así que esa incoherencia no debería ocurrir; por eso rechazarla es una red de seguridad.
 *
 * DOS situaciones distintas, que antes se trataban igual:
 *  - Estado administrativo HABITUAL: `blockPerson` / `disablePerson` dejan a la persona y a su
 *    cuenta con el mismo estado. Sigue el flujo normal —se verifica la contraseña— y el motivo
 *    se decide bajo bloqueo, como para una cuenta sin persona.
 *  - INCOHERENCIA (persona eliminada, estados que no se corresponden): error GENÉRICO con
 *    cualquier contraseña. Lo mismo para la cuenta de un club cuyo club no está activo
 *    (AUD-04/11).
 *
 * Bloqueo temporal vigente: genérico SIEMPRE, sin mirar la contraseña real. Verificarla haría
 * que acertar o no cambiara la respuesta de una cuenta bloqueada.
 */
async function verificarIntento(user: CuentaDeLogin | null, password: string): Promise<"correcta" | "incorrecta" | "ficticia"> {
  const sinContrasenaReal =
    !user ||
    user.deletedAt !== null ||
    situacionDePersona(user.personId, user.person, user) === "incoherente" ||
    situacionDeClub(user.clubId, user.club, user) === "incoherente" ||
    bloqueoTemporalVigente(user, new Date());
  if (sinContrasenaReal) {
    await verificacionFicticia(password);
    return "ficticia";
  }
  // Argon2, fuera de cualquier bloqueo. `user.passwordHash` es H0: lo que se verifique aquí
  // vale solo mientras ese siga siendo el hash de la cuenta. Una cuenta inhabilitada o
  // bloqueada por un administrador también se verifica: su motivo solo se revela tras
  // comprobar la contraseña, dentro de la transacción de `emitirSesionDeLogin`.
  return (await verifyPassword(user.passwordHash, password)) ? "correcta" : "incorrecta";
}

/** La sesión de un login cuya contraseña se verificó y cuyo acierto ya se liquidó. */
async function emitirSesionDeLogin(user: CuentaDeLogin, ctx: RequestContext) {
  const genericError = credencialesRechazadas;

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

    // La persona se relee AQUÍ, en una sentencia aparte de la que bloqueó la cuenta, y se
    // decide ANTES de dar un motivo: el estado de la cuenta solo se revela si la persona
    // dueña es coherente con él. Una incoherencia es siempre el genérico.
    const persona = cuenta.personId
      ? await tx.person.findUnique({ where: { id: cuenta.personId }, select: { status: true, deletedAt: true } })
      : null;
    if (situacionDePersona(cuenta.personId, persona, cuenta) === "incoherente") throw genericError();
    if (situacionDeClub(user.clubId, await clubDeCuenta(tx, user.clubId), cuenta) === "incoherente") throw genericError();

    const rechazo = rechazoDeLogin(cuenta, ahora);
    if (rechazo) throw rechazo;

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
      clubId: autorizacion.clubId,
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
      user: { include: { person: { select: { status: true, deletedAt: true } }, club: { select: { status: true, deletedAt: true } } } },
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
    (user.person === null || (user.person.status === "active" && user.person.deletedAt === null)) &&
    (user.clubId === null || (user.club !== null && user.club.status === "active" && user.club.deletedAt === null));
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

    // 3. La cuenta. El bloqueo temporal sigue rechazando aquí, igual que antes. La de un
    // club, además, solo rota si su club está activo y no eliminado (AUD-04/11).
    if (
      cuenta.status !== "active" ||
      cuenta.deletedAt !== null ||
      !(await personaUtilizable(tx, cuenta.personId)) ||
      situacionDeClub(user.clubId, await clubDeCuenta(tx, user.clubId), cuenta) !== "utilizable"
    ) {
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
      clubId: autorizacion.clubId,
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
 *
 * C-04: `sessionId` es la sesión que `authenticate` verificó para esta solicitud. Antes de
 * calcular Argon2 se toma su RESERVA (`cambioContrasena.ts`); un fallo y un cambio correcto
 * solo producen efectos si, con usuario y sesión bloqueados, esa reserva sigue siendo la suya.
 * Si no se aplicó nada —error de ejecución o resultado descartado—, la reserva se libera.
 */
export async function changePassword(userId: string, sessionId: string, input: ChangePasswordInput, ctx: RequestContext) {
  const reserva = await reservarCambio(sessionId, userId);
  try {
    return await cambiarConReserva(userId, reserva, input, ctx);
  } finally {
    // Inofensivo si el efecto ya se aplicó (el fallo la libera y el cambio termina la
    // sesión) o si la reserva ya no es de este token.
    await liberarReserva(reserva).catch(() => undefined);
  }
}

/**
 * El cambio con una reserva YA tomada. Se exporta solo para que las pruebas puedan
 * presentar una reserva vencida o ajena; la ruta usa siempre `changePassword`.
 */
export async function cambiarConReserva(
  userId: string,
  reserva: Awaited<ReturnType<typeof reservarCambio>>,
  input: ChangePasswordInput,
  ctx: RequestContext
) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  // Argon2 FUERA de toda transacción y en UN SOLO cupo del semáforo: verificar la contraseña
  // actual y, si es la correcta, calcular el hash de la nueva, sin soltar el cupo entre ambas.
  // Así la saturación solo puede ocurrir ANTES de verificar (al pedir el cupo), nunca entre
  // una verificación correcta y el hash. «incorrecta» es SOLO una contraseña que no coincide:
  // la saturación (`SaturacionArgon2`) o un error de la biblioteca en la verificación o en el
  // hash (`ErrorTecnicoArgon2`) se LANZAN (503) y nunca llegan a `aplicarFallo`, así que no
  // suman un intento, no terminan la sesión ni cambian la contraseña; el `finally` de
  // `changePassword` libera la reserva. Antes `verifyPassword` convertía cualquier excepción
  // en `false` y ese error se contaba como contraseña incorrecta.
  const derivacion = await conArgon2(async (ops) => {
    if ((await ops.verificar(user.passwordHash, input.currentPassword)) === "incorrecta") return null;
    return ops.hashear(input.newPassword);
  });
  if (derivacion === null) throw await aplicarFallo(reserva, ctx);
  const newHash = derivacion;

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

    // La reserva primero: una sesión terminada o una reserva perdida no deben revelar,
    // con otra respuesta, que la contraseña actual era la correcta.
    const estado = await estadoDeReserva(tx, reserva);
    if (estado.tipo === "sesion_invalida") throw new UnauthorizedError(MENSAJE_SESION_NO_VALIDA);
    if (estado.tipo === "obsoleta") throw resultadoObsoleto();

    if (!cuenta || cuenta.passwordHash !== user.passwordHash) {
      throw new ConflictError("La contraseña cambió mientras se procesaba la solicitud. Vuelva a intentarlo.");
    }
    if (
      cuenta.status !== "active" ||
      cuenta.deletedAt !== null ||
      !(await personaUtilizable(tx, cuenta.personId)) ||
      situacionDeClub(user.clubId, await clubDeCuenta(tx, user.clubId), cuenta) !== "utilizable"
    ) {
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
      clubId: autorizacion.clubId,
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
