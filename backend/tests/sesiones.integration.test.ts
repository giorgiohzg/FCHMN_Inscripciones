/**
 * Sesiones: revocación efectiva del JWT, clasificación de refresh tokens, límite
 * absoluto y corte de los tokens anteriores a `refresh_sessions`.
 *
 * Integración REAL contra la base desechable de `docker-compose.test.yml`, con los
 * servicios y la API de verdad y datos sintéticos. Lo único simulado es el reloj en
 * las pruebas de frontera del límite absoluto (solo `Date`).
 *
 * Los intercalados concurrentes están en `sesiones-concurrencia.integration.test.ts`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { env } from "../src/shared/env";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, TEST_PASSWORD } from "./helpers/seedRbac";
import * as authService from "../src/modules/auth/auth.service";
import * as personsService from "../src/modules/persons/persons.service";
import * as clubsService from "../src/modules/clubs/clubs.service";
import { OPCIONES_TX_SESION, sesionVigente, vencimientoDeRefresh } from "../src/modules/auth/sessions";
import { AccountLockedError, UnauthorizedError } from "../src/shared/errors";

const HORA = 3_600_000;
const NUEVA_CLAVE = "ClaveNuevaSintetica1";

let app: FastifyInstance;
let admin: { id: string };
const actor = () => ({ userId: admin.id });

const entrar = (username: string) => authService.login({ username, password: TEST_PASSWORD }, {});

/** Estado HTTP de una petición autenticada: lo que de verdad decide `authenticate`. */
async function estadoDelJwt(accessToken: string): Promise<number> {
  const res = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${accessToken}` } });
  return res.statusCode;
}

const sidDe = (accessToken: string) => (jwt.decode(accessToken) as { sid: string }).sid;
const sesion = (id: string) => prisma.refreshSession.findUniqueOrThrow({ where: { id } });
const sesionesActivas = (userId: string) => prisma.refreshSession.count({ where: { userId, revokedAt: null } });
const reusosAuditados = () => prisma.auditLog.count({ where: { action: "REFRESH_TOKEN_REUSE_DETECTED" } });

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  admin = await createUser({ username: "admin_sesiones", roleNames: ["admin"] });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await app.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("el JWT lleva su sesión y se comprueba en cada petición", () => {
  it("login emite `sid` de una sesión propia del usuario, sin exponerlo en /auth/me", async () => {
    const usuario = await createUser({ username: "con_sid", roleNames: ["swimmer"] });
    const { accessToken } = await entrar("con_sid");

    const fila = await sesion(sidDe(accessToken));
    expect(fila.userId).toBe(usuario.id);
    expect(fila.revokedAt).toBeNull();

    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).not.toHaveProperty("sid");
  });

  it("la rotación conserva la sesión y el `sid`", async () => {
    await createUser({ username: "rota", roleNames: ["swimmer"] });
    const primera = await entrar("rota");
    const segunda = await authService.refresh(primera.refreshToken, {});

    expect(sidDe(segunda.accessToken)).toBe(sidDe(primera.accessToken));
    expect(await prisma.refreshSession.count()).toBe(1);
  });

  it("las transacciones de sesión declaran READ COMMITTED y plazos explícitos", () => {
    expect(OPCIONES_TX_SESION.isolationLevel).toBe("ReadCommitted");
    expect(OPCIONES_TX_SESION.maxWait).toBeGreaterThan(0);
    expect(OPCIONES_TX_SESION.timeout).toBeGreaterThan(OPCIONES_TX_SESION.maxWait);
  });
});

describe("logout", () => {
  it("invalida el JWT DE INMEDIATO, y solo el de esa sesión", async () => {
    const usuario = await createUser({ username: "dos_equipos", roleNames: ["swimmer"] });
    const equipoA = await entrar("dos_equipos");
    const equipoB = await entrar("dos_equipos");

    await authService.logout(equipoA.refreshToken);

    expect(await estadoDelJwt(equipoA.accessToken), "su JWT sigue vigente por fecha, pero no por sesión").toBe(401);
    expect(await estadoDelJwt(equipoB.accessToken), "la otra sesión no se toca").toBe(200);
    expect(await sesionesActivas(usuario.id)).toBe(1);
    expect((await sesion(sidDe(equipoA.accessToken))).revokedReason).toBe("logout");
  });

  it("con un token YA ROTADO termina la sesión completa, sucesor incluido", async () => {
    await createUser({ username: "logout_rotado", roleNames: ["swimmer"] });
    const inicio = await entrar("logout_rotado");
    const sucesor = await authService.refresh(inicio.refreshToken, {});

    await authService.logout(inicio.refreshToken);

    await expect(authService.refresh(sucesor.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await estadoDelJwt(sucesor.accessToken)).toBe(401);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } }), "ningún token de la sesión queda vivo").toBe(0);
  });

  it("un token desconocido no hace nada", async () => {
    const usuario = await createUser({ username: "desconocido", roleNames: ["swimmer"] });
    await entrar("desconocido");

    await expect(authService.logout("token-sintetico-inexistente")).resolves.toBeUndefined();

    expect(await sesionesActivas(usuario.id)).toBe(1);
  });
});

describe("cookies antiguas y reuso", () => {
  it("un token rotado de una familia TERMINADA no cierra sesiones nuevas", async () => {
    const usuario = await createUser({ username: "familia_cerrada", roleNames: ["swimmer"] });
    const vieja = await entrar("familia_cerrada");
    const rotada = await authService.refresh(vieja.refreshToken, {});
    await authService.logout(rotada.refreshToken);

    const nueva = await entrar("familia_cerrada");

    // Tiene `replaced_by`, pero su sesión ya terminó: no es un robo, es una cookie vieja.
    await expect(authService.refresh(vieja.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);

    expect(await reusosAuditados(), "no hay falsa alarma").toBe(0);
    expect(await sesionesActivas(usuario.id)).toBe(1);
    expect(await estadoDelJwt(nueva.accessToken)).toBe(200);
    await expect(authService.refresh(nueva.refreshToken, {})).resolves.toBeDefined();
  });

  it("reuso en una sesión ACTIVA: termina solo esa sesión, y queda confirmado aunque se deniegue", async () => {
    const usuario = await createUser({ username: "reuso_activo", roleNames: ["swimmer"] });
    const robada = await entrar("reuso_activo");
    const otra = await entrar("reuso_activo");
    const rotada = await authService.refresh(robada.refreshToken, {});

    await expect(authService.refresh(robada.refreshToken, { ipAddress: "192.0.2.10" })).rejects.toThrow(/Vuelva a iniciar sesión/);

    // La denegación no revirtió ni la revocación ni su auditoría.
    expect((await sesion(sidDe(robada.accessToken))).revokedReason).toBe("reuse_detected");
    expect(await reusosAuditados()).toBe(1);
    expect(await estadoDelJwt(rotada.accessToken)).toBe(401);
    await expect(authService.refresh(rotada.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);

    expect(await estadoDelJwt(otra.accessToken), "las demás sesiones se conservan").toBe(200);
    expect(await sesionesActivas(usuario.id)).toBe(1);
  });

  it("presentar el mismo token rotado otra vez no audita un segundo reuso", async () => {
    await createUser({ username: "reuso_doble", roleNames: ["swimmer"] });
    const inicio = await entrar("reuso_doble");
    await authService.refresh(inicio.refreshToken, {});

    await expect(authService.refresh(inicio.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(authService.refresh(inicio.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);

    expect(await reusosAuditados()).toBe(1);
  });
});

describe("cambio de contraseña", () => {
  const cambio = { currentPassword: TEST_PASSWORD, newPassword: NUEVA_CLAVE, confirmPassword: NUEVA_CLAVE };

  it("revoca todas las sesiones y deja una sola, la nueva", async () => {
    const usuario = await createUser({ username: "cambia", roleNames: ["swimmer"] });
    const esta = await entrar("cambia");
    const otroEquipo = await entrar("cambia");

    const nueva = await authService.changePassword(usuario.id, cambio, {});

    expect(await estadoDelJwt(esta.accessToken)).toBe(401);
    expect(await estadoDelJwt(otroEquipo.accessToken)).toBe(401);
    expect(await estadoDelJwt(nueva.accessToken)).toBe(200);
    expect(await sesionesActivas(usuario.id)).toBe(1);
    expect((await sesion(sidDe(esta.accessToken))).revokedReason).toBe("password_change");
  });

  it("la cookie de otro dispositivo no cierra la sesión creada por el cambio", async () => {
    const usuario = await createUser({ username: "cookie_vieja", roleNames: ["swimmer"] });
    await entrar("cookie_vieja");
    const otroEquipo = await entrar("cookie_vieja");
    const nueva = await authService.changePassword(usuario.id, cambio, {});

    await expect(authService.refresh(otroEquipo.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);

    expect(await reusosAuditados()).toBe(0);
    expect(await estadoDelJwt(nueva.accessToken)).toBe(200);
    await expect(authService.refresh(nueva.refreshToken, {})).resolves.toBeDefined();
  });
});

describe("revocaciones administrativas", () => {
  async function cuentaDePersona() {
    const persona = await createPerson({ run: "90000001", username: "persona_sesion", firstName: "Ana", gender: "female" });
    const cuenta = await createUser({ username: "persona_sesion", roleNames: ["swimmer"], personId: persona.id });
    return { persona, cuenta };
  }

  async function cuentaDeClub() {
    const club = await createClub("Club Sesiones", "CSES", "club_sesion");
    const cuenta = await createUser({ username: "club_sesion", roleNames: ["club"], clubId: club.id });
    return { club, cuenta };
  }

  it.each([
    ["bloquear persona", async (id: string) => personsService.blockPerson(id, actor())],
    ["inhabilitar persona", async (id: string) => personsService.disablePerson(id, actor())],
    ["eliminar persona", async (id: string) => personsService.softDeletePerson(id, actor())],
    ["restablecer credenciales de persona", async (id: string) => personsService.resetCredentials(id, actor())],
  ])("%s termina sus sesiones y el JWT deja de valer", async (_nombre, accion) => {
    const { persona, cuenta } = await cuentaDePersona();
    const abierta = await entrar("persona_sesion");

    await accion(persona.id);

    expect(await estadoDelJwt(abierta.accessToken)).toBe(401);
    expect(await sesionesActivas(cuenta.id)).toBe(0);
    expect((await sesion(sidDe(abierta.accessToken))).revokedReason).toBe("admin_revocation");
    await expect(authService.refresh(abierta.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it.each([
    ["bloquear club", async (id: string) => clubsService.blockClub(id, actor())],
    ["inhabilitar club", async (id: string) => clubsService.disableClub(id, actor())],
    ["eliminar club", async (id: string) => clubsService.softDeleteClub(id, actor())],
    ["restablecer credenciales de club", async (id: string) => clubsService.resetClubCredentials(id, actor())],
  ])("%s termina sus sesiones y el JWT deja de valer", async (_nombre, accion) => {
    const { club, cuenta } = await cuentaDeClub();
    const abierta = await entrar("club_sesion");

    await accion(club.id);

    expect(await estadoDelJwt(abierta.accessToken)).toBe(401);
    expect(await sesionesActivas(cuenta.id)).toBe(0);
    expect((await sesion(sidDe(abierta.accessToken))).revokedReason).toBe("admin_revocation");
  });

  it("retirar el acceso administrativo termina las sesiones de esa cuenta, y solo de esa", async () => {
    const persona = await createPerson({ run: "90000002", username: "ex_admin", firstName: "Eva", gender: "female" });
    const cuenta = await createUser({ username: "ex_admin", roleNames: ["admin"], personId: persona.id });
    await prisma.person.update({ where: { id: persona.id }, data: { adminAccess: true } });
    const abierta = await entrar("ex_admin");
    const ajena = await authService.login({ username: "admin_sesiones", password: TEST_PASSWORD }, {});

    await personsService.setAdminAccess(persona.id, false, actor());

    expect(await estadoDelJwt(abierta.accessToken)).toBe(401);
    expect(await sesionesActivas(cuenta.id)).toBe(0);
    expect(await estadoDelJwt(ajena.accessToken)).toBe(200);
  });

  it("REACTIVAR una persona no revive sus sesiones", async () => {
    const { persona } = await cuentaDePersona();
    const abierta = await entrar("persona_sesion");

    await personsService.blockPerson(persona.id, actor());
    await personsService.reactivatePerson(persona.id, actor());

    expect(await estadoDelJwt(abierta.accessToken), "el JWT seguiría vigente por fecha").toBe(401);
    await expect(authService.refresh(abierta.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);
    // Y la cuenta sí puede volver a entrar: lo que no vuelve es la sesión anterior.
    await expect(entrar("persona_sesion")).resolves.toBeDefined();
  });

  it("REACTIVAR un club no revive sus sesiones", async () => {
    const { club } = await cuentaDeClub();
    const abierta = await entrar("club_sesion");

    await clubsService.blockClub(club.id, actor());
    await clubsService.reactivateClub(club.id, actor());

    expect(await estadoDelJwt(abierta.accessToken)).toBe(401);
    await expect(authService.refresh(abierta.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("la autorización se resuelve ANTES de consumir el refresh token", () => {
  it("si falla la resolución del club, el token sigue vigente y puede reintentarse", async () => {
    const norte = await createClub("Club Norte Sesion", "CNS");
    const sur = await createClub("Club Sur Sesion", "CSS");
    const persona = await createPerson({ run: "90000003", username: "dos_clubes", firstName: "Bea", gender: "female" });
    await prisma.clubStaff.create({ data: { clubId: norte.id, personId: persona.id, roleType: "delegate" } });
    await createUser({ username: "dos_clubes", roleNames: ["delegate"], personId: persona.id });
    const abierta = await entrar("dos_clubes");

    // El estado contradictorio solo puede venir de datos anteriores a la restricción.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE club_staff DISABLE TRIGGER club_staff_un_solo_club_por_persona`);
      await tx.clubStaff.create({ data: { clubId: sur.id, personId: persona.id, roleType: "coach" } });
      await tx.$executeRawUnsafe(`ALTER TABLE club_staff ENABLE TRIGGER club_staff_un_solo_club_por_persona`);
    });

    await expect(authService.refresh(abierta.refreshToken, {})).rejects.toThrow(/más de un club/);

    const token = await prisma.refreshToken.findFirstOrThrow({ where: { sessionId: sidDe(abierta.accessToken) } });
    expect(token.revokedAt, "el token no se consumió").toBeNull();
    expect(token.replacedBy).toBeNull();
    expect(await prisma.refreshToken.count({ where: { sessionId: sidDe(abierta.accessToken) } }), "ni nació un sucesor").toBe(1);

    // Corregido el dato, la MISMA cookie funciona: no se interpreta como reuso.
    await prisma.clubStaff.deleteMany({ where: { clubId: sur.id, personId: persona.id } });
    await expect(authService.refresh(abierta.refreshToken, {})).resolves.toBeDefined();
    expect(await reusosAuditados()).toBe(0);
  });
});

describe("duración absoluta", () => {
  it("el valor por omisión del entorno de pruebas es 8 horas", () => {
    expect(env.SESSION_ABSOLUTE_HOURS).toBe(8);
  });

  it("nace a 8 horas de la creación, y el token no la supera aunque el refresh dure 7 días", async () => {
    await createUser({ username: "ocho_horas", roleNames: ["swimmer"] });
    const antes = Date.now();
    const abierta = await entrar("ocho_horas");
    const despues = Date.now();

    const fila = await sesion(sidDe(abierta.accessToken));
    expect(fila.absoluteExpiresAt.getTime()).toBeGreaterThanOrEqual(antes + 8 * HORA);
    expect(fila.absoluteExpiresAt.getTime()).toBeLessThanOrEqual(despues + 8 * HORA);

    const token = await prisma.refreshToken.findFirstOrThrow({ where: { sessionId: fila.id } });
    expect(token.expiresAt.getTime()).toBe(fila.absoluteExpiresAt.getTime());
  });

  it("el vencimiento del refresh es el MÍNIMO entre el habitual y el límite absoluto", () => {
    const ahora = Date.UTC(2030, 0, 1);
    const habitual = ahora + env.JWT_REFRESH_EXPIRES_IN_DAYS * 86_400_000;

    expect(vencimientoDeRefresh(new Date(ahora + 8 * HORA), ahora).getTime(), "manda el límite").toBe(ahora + 8 * HORA);
    expect(vencimientoDeRefresh(new Date(habitual + HORA), ahora).getTime(), "manda el habitual").toBe(habitual);
  });

  it("fronteras: un milisegundo antes vale; al alcanzar el límite, ya no", async () => {
    const usuario = await createUser({ username: "frontera", roleNames: ["swimmer"] });
    const abierta = await entrar("frontera");
    const sid = sidDe(abierta.accessToken);
    const { absoluteExpiresAt } = await sesion(sid);

    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(absoluteExpiresAt.getTime() - 1);
    expect(await sesionVigente(sid, usuario.id)).toBe(true);

    vi.setSystemTime(absoluteExpiresAt.getTime());
    expect(await sesionVigente(sid, usuario.id)).toBe(false);
    await expect(authService.refresh(abierta.refreshToken, {})).rejects.toThrow("Sesión expirada");

    vi.setSystemTime(absoluteExpiresAt.getTime() + 1);
    expect(await sesionVigente(sid, usuario.id)).toBe(false);
  });

  it("renovar no extiende el límite, por muchas veces que se renueve", async () => {
    await createUser({ username: "renueva", roleNames: ["swimmer"] });
    const inicio = await entrar("renueva");
    const sid = sidDe(inicio.accessToken);
    const { absoluteExpiresAt } = await sesion(sid);
    const creada = absoluteExpiresAt.getTime() - 8 * HORA;

    vi.useFakeTimers({ toFake: ["Date"] });
    let cookie = inicio.refreshToken;
    for (const horas of [2, 4, 6, 7.5]) {
      vi.setSystemTime(creada + horas * HORA);
      cookie = (await authService.refresh(cookie, {})).refreshToken;
    }

    const fila = await sesion(sid);
    expect(fila.absoluteExpiresAt.getTime(), "el límite no se movió").toBe(absoluteExpiresAt.getTime());
    const ultimo = await prisma.refreshToken.findFirstOrThrow({ where: { sessionId: sid, revokedAt: null } });
    expect(ultimo.expiresAt.getTime(), "tampoco lo supera el último token").toBe(absoluteExpiresAt.getTime());

    vi.setSystemTime(absoluteExpiresAt.getTime());
    await expect(authService.refresh(cookie, {})).rejects.toThrow("Sesión expirada");
  });

  it("un JWT cuya sesión venció no vale aunque su propia fecha lo permita", async () => {
    await createUser({ username: "vencida", roleNames: ["swimmer"] });
    const abierta = await entrar("vencida");
    await prisma.refreshSession.update({
      where: { id: sidDe(abierta.accessToken) },
      data: { absoluteExpiresAt: new Date(Date.now() - 1) },
    });

    expect(await estadoDelJwt(abierta.accessToken)).toBe(401);
  });
});

describe("corte: JWT sin `sid` y tokens sin sesión", () => {
  const firmar = (claims: Record<string, unknown>) =>
    jwt.sign({ ownerType: "system", roles: [], permissions: [], ...claims }, env.JWT_ACCESS_SECRET, {
      issuer: "natacion-api",
      expiresIn: 900,
    });

  /** Token anterior a `refresh_sessions`: la fila que deja la API previa. */
  async function tokenHistorico(userId: string, extra: { revokedAt?: Date; replacedBy?: string } = {}) {
    const { generateOpaqueToken } = await import("../src/modules/auth/password.util");
    const { token, tokenHash } = generateOpaqueToken();
    await prisma.refreshToken.create({
      data: { userId, tokenHash, expiresAt: new Date(Date.now() + 86_400_000), ...extra },
    });
    return token;
  }

  it("un JWT válido por firma pero sin `sid` se rechaza", async () => {
    const usuario = await createUser({ username: "sin_sid", roleNames: ["swimmer"] });
    expect(await estadoDelJwt(firmar({ sub: usuario.id }))).toBe(401);
  });

  it("un `sid` inexistente, vacío o de otro usuario se rechaza", async () => {
    const usuario = await createUser({ username: "sid_ajeno", roleNames: ["swimmer"] });
    await createUser({ username: "dueno_sid", roleNames: ["swimmer"] });
    const ajena = await entrar("dueno_sid");

    expect(await estadoDelJwt(firmar({ sub: usuario.id, sid: "no-existe" }))).toBe(401);
    expect(await estadoDelJwt(firmar({ sub: usuario.id, sid: "" }))).toBe(401);
    expect(await estadoDelJwt(firmar({ sub: usuario.id, sid: 42 }))).toBe(401);
    expect(await estadoDelJwt(firmar({ sub: usuario.id, sid: sidDe(ajena.accessToken) }))).toBe(401);
  });

  it("un refresh token sin sesión se rechaza SIN cascada y sin consumirse", async () => {
    const usuario = await createUser({ username: "historico", roleNames: ["swimmer"] });
    const vigente = await entrar("historico");
    const antiguo = await tokenHistorico(usuario.id);

    await expect(authService.refresh(antiguo, {})).rejects.toThrow("Sesión inválida");

    expect(await estadoDelJwt(vigente.accessToken), "la sesión vigente no se entera").toBe(200);
    expect(await sesionesActivas(usuario.id)).toBe(1);
    expect(await reusosAuditados()).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId: usuario.id, sessionId: null, revokedAt: null } }), "no se modifica").toBe(1);
  });

  it("un token histórico ya rotado tampoco provoca cascada", async () => {
    const usuario = await createUser({ username: "historico_rotado", roleNames: ["swimmer"] });
    const vigente = await entrar("historico_rotado");
    const antiguo = await tokenHistorico(usuario.id, { revokedAt: new Date(), replacedBy: "hash-sintetico" });

    await expect(authService.refresh(antiguo, {})).rejects.toBeInstanceOf(UnauthorizedError);

    expect(await reusosAuditados()).toBe(0);
    await expect(authService.refresh(vigente.refreshToken, {})).resolves.toBeDefined();
  });

  it("logout con un token histórico lo revoca a él, sin tocar sesiones", async () => {
    const usuario = await createUser({ username: "historico_logout", roleNames: ["swimmer"] });
    const vigente = await entrar("historico_logout");
    const antiguo = await tokenHistorico(usuario.id);

    await authService.logout(antiguo);

    expect(await prisma.refreshToken.count({ where: { userId: usuario.id, sessionId: null, revokedAt: null } })).toBe(0);
    expect(await estadoDelJwt(vigente.accessToken)).toBe(200);
  });

  it("las revocaciones de alcance usuario alcanzan también a los tokens históricos", async () => {
    const usuario = await createUser({ username: "historico_cambio", roleNames: ["swimmer"] });
    await tokenHistorico(usuario.id);

    await authService.changePassword(usuario.id, { currentPassword: TEST_PASSWORD, newPassword: NUEVA_CLAVE, confirmPassword: NUEVA_CLAVE }, {});

    expect(await prisma.refreshToken.count({ where: { userId: usuario.id, sessionId: null, revokedAt: null } })).toBe(0);
  });
});

describe("CONTRASTE: la política del bloqueo temporal y las respuestas de login no cambian", () => {
  const login = (username: string, password: string) =>
    app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });

  it("mensajes y códigos de cada estado de cuenta", async () => {
    await createUser({ username: "inhabilitada", roleNames: ["swimmer"], status: "disabled" });
    await createUser({ username: "bloqueada_admin", roleNames: ["swimmer"], status: "locked", lockedUntil: null });
    await createUser({ username: "bloqueada_temporal", roleNames: ["swimmer"], status: "locked", lockedUntil: new Date(Date.now() + HORA) });
    await createUser({ username: "normal", roleNames: ["swimmer"] });

    const inhabilitada = await login("inhabilitada", "cualquiera");
    expect(inhabilitada.statusCode).toBe(401);
    expect(inhabilitada.json().message).toBe("Cuenta inhabilitada. Contacte al administrador.");

    const admin = await login("bloqueada_admin", "cualquiera");
    expect(admin.statusCode).toBe(401);
    expect(admin.json().message).toBe("Cuenta bloqueada por un administrador. Contacte al administrador.");

    const temporal = await login("bloqueada_temporal", "cualquiera");
    expect(temporal.statusCode).toBe(423);
    expect(temporal.json().error).toBe("ACCOUNT_LOCKED");

    const incorrecta = await login("normal", "ClaveIncorrecta1");
    expect(incorrecta.statusCode).toBe(401);
    expect(incorrecta.json().message).toBe("Usuario o contraseña incorrectos");

    const inexistente = await login("no_existe", "ClaveIncorrecta1");
    expect(inexistente.statusCode).toBe(401);
    expect(inexistente.json().message).toBe("Usuario o contraseña incorrectos");
  });

  it("el bloqueo temporal EXPULSA las sesiones activas mientras dura, sin revocarlas", async () => {
    const usuario = await createUser({ username: "bloqueo_activo", roleNames: ["swimmer"] });
    const abierta = await entrar("bloqueo_activo");

    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS; i++) {
      await expect(authService.login({ username: "bloqueo_activo", password: "ClaveIncorrecta1" }, {})).rejects.toBeInstanceOf(UnauthorizedError);
    }

    const cuenta = await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } });
    expect(cuenta.status).toBe("locked");
    expect(cuenta.lockedUntil).not.toBeNull();

    // Comportamiento actual, deliberadamente sin cambios: la petición se rechaza…
    expect(await estadoDelJwt(abierta.accessToken)).toBe(401);
    await expect(authService.refresh(abierta.refreshToken, {})).rejects.toThrow("Cuenta no disponible");
    // …y la sesión no se terminó: el bloqueo temporal no es una revocación.
    expect(await sesionesActivas(usuario.id)).toBe(1);

    // Al levantarse el bloqueo, esa misma sesión vuelve a operar.
    await prisma.user.update({ where: { id: usuario.id }, data: { status: "active", lockedUntil: null } });
    expect(await estadoDelJwt(abierta.accessToken)).toBe(200);
  });

  it("con el bloqueo temporal vigente, ni la contraseña correcta entra", async () => {
    await createUser({ username: "vigente", roleNames: ["swimmer"], status: "locked", lockedUntil: new Date(Date.now() + HORA) });

    await expect(entrar("vigente")).rejects.toBeInstanceOf(AccountLockedError);
  });

  it("bloqueo temporal VENCIDO + contraseña correcta: entra y se levanta", async () => {
    const usuario = await createUser({ username: "vencido_ok", roleNames: ["swimmer"], status: "locked", lockedUntil: new Date(Date.now() - 1000) });

    await expect(entrar("vencido_ok")).resolves.toBeDefined();

    const cuenta = await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } });
    expect(cuenta.status).toBe("active");
    expect(cuenta.lockedUntil).toBeNull();
  });

  it("bloqueo temporal VENCIDO + contraseña incorrecta: se levanta y cuenta un intento", async () => {
    const usuario = await createUser({ username: "vencido_mal", roleNames: ["swimmer"], status: "locked", lockedUntil: new Date(Date.now() - 1000) });

    await expect(authService.login({ username: "vencido_mal", password: "ClaveIncorrecta1" }, {})).rejects.toBeInstanceOf(UnauthorizedError);

    const cuenta = await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } });
    expect(cuenta.status).toBe("active");
    expect(cuenta.lockedUntil).toBeNull();
    expect(cuenta.failedLoginAttempts).toBe(1);
  });

  it("cada fallo se audita, y el umbral bloquea una sola vez", async () => {
    const usuario = await createUser({ username: "umbral", roleNames: ["swimmer"] });

    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS; i++) {
      await expect(authService.login({ username: "umbral", password: "ClaveIncorrecta1" }, {})).rejects.toBeInstanceOf(UnauthorizedError);
    }

    expect(await prisma.auditLog.count({ where: { action: "LOGIN_FAILED", userId: usuario.id } })).toBe(env.LOGIN_MAX_ATTEMPTS);
    expect(await prisma.auditLog.count({ where: { action: "USER_LOCKED", userId: usuario.id } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } })).failedLoginAttempts).toBe(0);
  });

  it("un login correcto reinicia el contador", async () => {
    const usuario = await createUser({ username: "reinicia", roleNames: ["swimmer"] });
    await expect(authService.login({ username: "reinicia", password: "ClaveIncorrecta1" }, {})).rejects.toBeInstanceOf(UnauthorizedError);

    await entrar("reinicia");

    expect((await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } })).failedLoginAttempts).toBe(0);
  });
});
