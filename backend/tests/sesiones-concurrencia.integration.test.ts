/**
 * Concurrencia REAL del protocolo de sesiones, sobre la base desechable.
 *
 * MÉTODO, sin ganchos en el código de producción. Una conexión `pg` independiente
 * RETIENE la fila de `users`. Los servicios reales —`login`, `refresh`, `logout`,
 * `changePassword`, las revocaciones— se lanzan con sus propias conexiones de Prisma
 * y llegan hasta ese bloqueo; cada espera se CONFIRMA en `pg_stat_activity` antes de
 * lanzar la siguiente, así que el orden de la cola es el de las llamadas: PostgreSQL
 * atiende por turno a quienes esperan una misma fila. Al confirmar la retención, se
 * resuelven en ese orden.
 *
 * Eso fija cada intercalado por construcción: `Promise.all` sobre dos llamadas no
 * obligaría a que se solaparan. Y como Argon2 corre ANTES del bloqueo, una llamada
 * que espera ya verificó su credencial contra el hash anterior: la retención puede
 * cambiar la cuenta justo en la ventana que hay que probar.
 *
 * Solo datos sintéticos. Nada de esto es simulado salvo los propios datos.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Client } from "pg";
import jwt from "jsonwebtoken";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, TEST_PASSWORD } from "./helpers/seedRbac";
import * as authService from "../src/modules/auth/auth.service";
import * as personsService from "../src/modules/persons/persons.service";
import * as clubsService from "../src/modules/clubs/clubs.service";
import { hashPassword, verifyPassword } from "../src/modules/auth/password.util";
import { sesionVigente } from "../src/modules/auth/sessions";
import { AccountLockedError, ConflictError, UnauthorizedError } from "../src/shared/errors";

const INCORRECTA = "ClaveIncorrecta1";

const conexiones: Client[] = [];
let observador: Client;
let admin: { id: string };
const actor = () => ({ userId: admin.id });

async function abrirConexion(): Promise<Client> {
  const cliente = new Client({ connectionString: process.env.DATABASE_URL });
  await cliente.connect();
  conexiones.push(cliente);
  return cliente;
}

/** Abre una transacción que retiene la fila de la cuenta, como haría otra operación de sesión. */
async function retener(userId: string): Promise<Client> {
  const retencion = await abrirConexion();
  await retencion.query("BEGIN");
  await retencion.query("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [userId]);
  return retencion;
}

/**
 * Espera a que haya exactamente `n` backends detenidos por un CERROJO. Es la
 * confirmación del motor, no un plazo: distingue «esperando a otra transacción» de
 * «tardando». Sin esto, el orden de la cola no estaría garantizado.
 */
async function enCola(n: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const { rows } = await observador.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    );
    if (rows[0]!.n === n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No se llegó a ${n} operaciones esperando un cerrojo`);
}

/** Captura el desenlace para poder inspeccionarlo después de soltar la retención. */
const desenlace = <T>(p: Promise<T>) =>
  p.then(
    (valor) => ({ ok: true as const, valor }),
    (error: unknown) => ({ ok: false as const, error })
  );

const sidDe = (accessToken: string) => (jwt.decode(accessToken) as { sid: string }).sid;
const entrar = (username: string, password = TEST_PASSWORD) => authService.login({ username, password }, {});
const cuenta = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });
const sesionesActivas = (userId: string) => prisma.refreshSession.count({ where: { userId, revokedAt: null } });
const tokensActivos = (userId: string) => prisma.refreshToken.count({ where: { userId, revokedAt: null } });

/** Ningún token vivo, ninguna sesión viva: el estado que deja una revocación de alcance usuario. */
async function expectSinNadaVivo(userId: string) {
  expect(await sesionesActivas(userId), "ninguna sesión activa").toBe(0);
  expect(await tokensActivos(userId), "ningún refresh token activo").toBe(0);
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  admin = await createUser({ username: "admin_concurrencia", roleNames: ["admin"] });
  observador = await abrirConexion();
});

afterAll(async () => {
  await Promise.all(conexiones.map((c) => c.end().catch(() => void 0)));
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("refresh contra logout", () => {
  it("el refresh entra primero: el logout alcanza al sucesor recién insertado", async () => {
    const usuario = await createUser({ username: "r_antes_l", roleNames: ["swimmer"] });
    const inicio = await entrar("r_antes_l");

    const retencion = await retener(usuario.id);
    const refresco = desenlace(authService.refresh(inicio.refreshToken, {}));
    await enCola(1);
    const salida = desenlace(authService.logout(inicio.refreshToken));
    await enCola(2);
    await retencion.query("COMMIT");

    const r = await refresco;
    expect(r.ok, "el refresco se atendió primero").toBe(true);
    expect((await salida).ok).toBe(true);

    await expectSinNadaVivo(usuario.id);
    if (r.ok) await expect(authService.refresh(r.valor.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await sesionVigente(sidDe(inicio.accessToken), usuario.id)).toBe(false);
  });

  it("el logout entra primero: el refresh aborta sin insertar nada", async () => {
    const usuario = await createUser({ username: "l_antes_r", roleNames: ["swimmer"] });
    const inicio = await entrar("l_antes_r");

    const retencion = await retener(usuario.id);
    const salida = desenlace(authService.logout(inicio.refreshToken));
    await enCola(1);
    const refresco = desenlace(authService.refresh(inicio.refreshToken, {}));
    await enCola(2);
    await retencion.query("COMMIT");

    expect((await salida).ok).toBe(true);
    const r = await refresco;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(UnauthorizedError);

    await expectSinNadaVivo(usuario.id);
    expect(await prisma.refreshToken.count({ where: { userId: usuario.id } }), "no nació ningún sucesor").toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "REFRESH_TOKEN_REUSE_DETECTED" } }), "no es un reuso").toBe(0);
  });
});

describe("dos refrescos con el mismo token", () => {
  it("solo uno rota; el segundo es un reuso que termina esa sesión y queda auditado", async () => {
    const usuario = await createUser({ username: "doble_r", roleNames: ["swimmer"] });
    const inicio = await entrar("doble_r");
    const otra = await entrar("doble_r");

    const retencion = await retener(usuario.id);
    const a = desenlace(authService.refresh(inicio.refreshToken, {}));
    await enCola(1);
    const b = desenlace(authService.refresh(inicio.refreshToken, {}));
    await enCola(2);
    await retencion.query("COMMIT");

    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(false);

    expect(await sesionVigente(sidDe(inicio.accessToken), usuario.id)).toBe(false);
    expect(await sesionVigente(sidDe(otra.accessToken), usuario.id), "la otra sesión sigue").toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "REFRESH_TOKEN_REUSE_DETECTED" } })).toBe(1);
  });
});

describe("refresh contra cambio de contraseña", () => {
  const cambio = { currentPassword: TEST_PASSWORD, newPassword: "ClaveNuevaUno1", confirmPassword: "ClaveNuevaUno1" };

  it("el refresh entra primero: el cambio alcanza también al sucesor", async () => {
    const usuario = await createUser({ username: "r_antes_c", roleNames: ["swimmer"] });
    const inicio = await entrar("r_antes_c");

    const retencion = await retener(usuario.id);
    const refresco = desenlace(authService.refresh(inicio.refreshToken, {}));
    await enCola(1);
    const cambiar = desenlace(authService.changePassword(usuario.id, cambio, {}));
    await enCola(2);
    await retencion.query("COMMIT");

    const r = await refresco;
    const c = await cambiar;
    expect(r.ok).toBe(true);
    expect(c.ok).toBe(true);

    expect(await sesionesActivas(usuario.id), "solo la sesión del cambio").toBe(1);
    expect(await tokensActivos(usuario.id)).toBe(1);
    if (r.ok) await expect(authService.refresh(r.valor.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);
    if (c.ok) await expect(authService.refresh(c.valor.refreshToken, {})).resolves.toBeDefined();
  });

  it("el cambio entra primero: el refresh aborta y la sesión nueva no se entera", async () => {
    const usuario = await createUser({ username: "c_antes_r", roleNames: ["swimmer"] });
    const inicio = await entrar("c_antes_r");

    const retencion = await retener(usuario.id);
    const cambiar = desenlace(authService.changePassword(usuario.id, cambio, {}));
    await enCola(1);
    const refresco = desenlace(authService.refresh(inicio.refreshToken, {}));
    await enCola(2);
    await retencion.query("COMMIT");

    const c = await cambiar;
    expect(c.ok).toBe(true);
    expect((await refresco).ok).toBe(false);

    expect(await sesionesActivas(usuario.id)).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "REFRESH_TOKEN_REUSE_DETECTED" } })).toBe(0);
    if (c.ok) expect(await sesionVigente(sidDe(c.valor.accessToken), usuario.id)).toBe(true);
  });
});

describe("refresh contra revocaciones administrativas", () => {
  async function conPersona(username: string, run: string) {
    const persona = await createPerson({ run, username, firstName: "Sara", gender: "female" });
    const usuario = await createUser({ username, roleNames: ["swimmer"], personId: persona.id });
    return { persona, usuario, inicio: await entrar(username) };
  }

  async function conClub(username: string, code: string) {
    const club = await createClub(`Club ${code}`, code, username);
    const usuario = await createUser({ username, roleNames: ["club"], clubId: club.id });
    return { club, usuario, inicio: await entrar(username) };
  }

  it("restablecer credenciales después del refresh alcanza al sucesor", async () => {
    const { persona, usuario, inicio } = await conPersona("reset_tras_r", "91000001");

    const retencion = await retener(usuario.id);
    const refresco = desenlace(authService.refresh(inicio.refreshToken, {}));
    await enCola(1);
    const reset = desenlace(personsService.resetCredentials(persona.id, actor()));
    await enCola(2);
    await retencion.query("COMMIT");

    const r = await refresco;
    expect(r.ok).toBe(true);
    expect((await reset).ok).toBe(true);
    await expectSinNadaVivo(usuario.id);
    if (r.ok) await expect(authService.refresh(r.valor.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("restablecer credenciales antes del refresh: el refresh aborta sin insertar", async () => {
    const { persona, usuario, inicio } = await conPersona("reset_antes_r", "91000002");

    const retencion = await retener(usuario.id);
    const reset = desenlace(personsService.resetCredentials(persona.id, actor()));
    await enCola(1);
    const refresco = desenlace(authService.refresh(inicio.refreshToken, {}));
    await enCola(2);
    await retencion.query("COMMIT");

    expect((await reset).ok).toBe(true);
    expect((await refresco).ok).toBe(false);
    await expectSinNadaVivo(usuario.id);
    expect(await prisma.refreshToken.count({ where: { userId: usuario.id } })).toBe(1);
  });

  it("bloquear un club después del refresh alcanza al sucesor (READ COMMITTED)", async () => {
    const { club, usuario, inicio } = await conClub("club_tras_r", "CTR");

    const retencion = await retener(usuario.id);
    const refresco = desenlace(authService.refresh(inicio.refreshToken, {}));
    await enCola(1);
    const bloqueo = desenlace(clubsService.blockClub(club.id, actor()));
    await enCola(2);
    await retencion.query("COMMIT");

    expect((await refresco).ok).toBe(true);
    expect((await bloqueo).ok).toBe(true);
    await expectSinNadaVivo(usuario.id);
  });

  it("bloquear un club antes del refresh: el refresh aborta", async () => {
    const { club, usuario, inicio } = await conClub("club_antes_r", "CAR");

    const retencion = await retener(usuario.id);
    const bloqueo = desenlace(clubsService.blockClub(club.id, actor()));
    await enCola(1);
    const refresco = desenlace(authService.refresh(inicio.refreshToken, {}));
    await enCola(2);
    await retencion.query("COMMIT");

    expect((await bloqueo).ok).toBe(true);
    expect((await refresco).ok).toBe(false);
    await expectSinNadaVivo(usuario.id);
  });

  /**
   * `disablePerson` corre en `Serializable` por la guarda del último administrador.
   * Su instantánea es anterior al refresh, así que PostgreSQL la aborta al encontrar
   * el token ya consumido (`P2034`, que la API traduce a un 409 «vuelva a intentarlo»).
   * Eso es FALLAR CERRADO: no se aplica nada, y reintentar la deja completa. Lo que no
   * puede ocurrir es una inhabilitación confirmada con un token vivo.
   */
  it("inhabilitar una persona (Serializable) después del refresh falla cerrado y el reintento la completa", async () => {
    const { persona, usuario, inicio } = await conPersona("disable_tras_r", "91000003");

    const retencion = await retener(usuario.id);
    const refresco = desenlace(authService.refresh(inicio.refreshToken, {}));
    await enCola(1);
    const inhabilitar = desenlace(personsService.disablePerson(persona.id, actor()));
    await enCola(2);
    await retencion.query("COMMIT");

    expect((await refresco).ok).toBe(true);
    const i = await inhabilitar;

    expect(i.ok, "el motor aborta la transacción serializable").toBe(false);
    if (!i.ok) expect((i.error as { code?: string }).code).toBe("P2034");

    // No se aplicó NADA, ni a medias.
    expect((await cuenta(usuario.id)).status).toBe("active");
    expect((await prisma.person.findUniqueOrThrow({ where: { id: persona.id } })).status).toBe("active");
    expect(await sesionesActivas(usuario.id)).toBe(1);

    await personsService.disablePerson(persona.id, actor());

    expect((await cuenta(usuario.id)).status).toBe("disabled");
    await expectSinNadaVivo(usuario.id);
  });

  it("inhabilitar una persona antes del refresh: el refresh aborta", async () => {
    const { persona, usuario, inicio } = await conPersona("disable_antes_r", "91000004");

    const retencion = await retener(usuario.id);
    const inhabilitar = desenlace(personsService.disablePerson(persona.id, actor()));
    await enCola(1);
    const refresco = desenlace(authService.refresh(inicio.refreshToken, {}));
    await enCola(2);
    await retencion.query("COMMIT");

    expect((await inhabilitar).ok).toBe(true);
    expect((await refresco).ok).toBe(false);
    await expectSinNadaVivo(usuario.id);
  });
});

describe("login con la cuenta cambiando bajo sus pies", () => {
  it("credencial sustituida durante el login: 401, sin sesión y sin escribir", async () => {
    const usuario = await createUser({ username: "h0_login", roleNames: ["swimmer"] });
    await prisma.user.update({ where: { id: usuario.id }, data: { failedLoginAttempts: 2 } });
    const hashNuevo = await hashPassword("ClaveSustituta1");

    const retencion = await retener(usuario.id);
    const login = desenlace(entrar("h0_login"));
    await enCola(1); // Argon2 ya verificó contra el hash anterior
    await retencion.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hashNuevo, usuario.id]);
    await retencion.query("COMMIT");

    const l = await login;
    expect(l.ok).toBe(false);
    if (!l.ok) expect((l.error as Error).message).toBe("Usuario o contraseña incorrectos");

    expect(await prisma.refreshSession.count({ where: { userId: usuario.id } }), "no se emitió nada").toBe(0);
    expect((await cuenta(usuario.id)).failedLoginAttempts, "tampoco se tocó el contador").toBe(2);
    expect((await cuenta(usuario.id)).lastLoginAt).toBeNull();
  });

  it.each([
    ["bloqueo administrativo", "UPDATE users SET status = 'locked', locked_until = NULL WHERE id = $1", "Cuenta bloqueada por un administrador. Contacte al administrador."],
    ["inhabilitación", "UPDATE users SET status = 'disabled' WHERE id = $1", "Cuenta inhabilitada. Contacte al administrador."],
    ["eliminación", "UPDATE users SET deleted_at = now() WHERE id = $1", "Usuario o contraseña incorrectos"],
  ])("%s durante el login: prevalece y no se emite sesión", async (_nombre, sentencia, mensaje) => {
    const usuario = await createUser({ username: "estado_login", roleNames: ["swimmer"] });

    const retencion = await retener(usuario.id);
    const login = desenlace(entrar("estado_login"));
    await enCola(1);
    await retencion.query(sentencia, [usuario.id]);
    await retencion.query("COMMIT");

    const l = await login;
    expect(l.ok).toBe(false);
    if (!l.ok) expect((l.error as Error).message).toBe(mensaje);
    expect(await prisma.refreshSession.count({ where: { userId: usuario.id } })).toBe(0);
  });

  it("inhabilitar a la PERSONA durante el login: se lee tras el bloqueo y prevalece", async () => {
    const persona = await createPerson({ run: "91000005", username: "persona_login", firstName: "Rosa", gender: "female" });
    const usuario = await createUser({ username: "persona_login", roleNames: ["swimmer"], personId: persona.id });

    const retencion = await retener(usuario.id);
    const login = desenlace(entrar("persona_login"));
    await enCola(1);
    await retencion.query("UPDATE persons SET status = 'disabled' WHERE id = $1", [persona.id]);
    await retencion.query("COMMIT");

    expect((await login).ok).toBe(false);
    expect(await prisma.refreshSession.count({ where: { userId: usuario.id } })).toBe(0);
  });

  it("login antes del cambio de contraseña: su sesión queda revocada por el cambio", async () => {
    const usuario = await createUser({ username: "login_tras_c", roleNames: ["swimmer"] });
    const cambio = { currentPassword: TEST_PASSWORD, newPassword: "ClaveNuevaDos2", confirmPassword: "ClaveNuevaDos2" };

    const retencion = await retener(usuario.id);
    const login = desenlace(entrar("login_tras_c"));
    await enCola(1);
    const cambiar = desenlace(authService.changePassword(usuario.id, cambio, {}));
    await enCola(2);
    await retencion.query("COMMIT");

    const l = await login;
    const c = await cambiar;
    expect(l.ok).toBe(true);
    expect(c.ok).toBe(true);
    if (l.ok) expect(await sesionVigente(sidDe(l.valor.accessToken), usuario.id)).toBe(false);
    if (c.ok) expect(await sesionVigente(sidDe(c.valor.accessToken), usuario.id)).toBe(true);
    expect(await sesionesActivas(usuario.id)).toBe(1);
  });

  it("cambio de contraseña antes del login: el login con la credencial anterior falla", async () => {
    const usuario = await createUser({ username: "c_antes_login", roleNames: ["swimmer"] });
    const cambio = { currentPassword: TEST_PASSWORD, newPassword: "ClaveNuevaTres3", confirmPassword: "ClaveNuevaTres3" };

    const retencion = await retener(usuario.id);
    const cambiar = desenlace(authService.changePassword(usuario.id, cambio, {}));
    await enCola(1);
    const login = desenlace(entrar("c_antes_login"));
    await enCola(2);
    await retencion.query("COMMIT");

    expect((await cambiar).ok).toBe(true);
    expect((await login).ok).toBe(false);
    expect(await sesionesActivas(usuario.id), "solo la sesión del cambio").toBe(1);
  });
});

describe("cambios de contraseña concurrentes", () => {
  it("dos cambios que verificaron la misma contraseña: gana el primero y el segundo no sobrescribe", async () => {
    const usuario = await createUser({ username: "dos_cambios", roleNames: ["swimmer"] });
    const inicio = await entrar("dos_cambios");
    const primera = { currentPassword: TEST_PASSWORD, newPassword: "ClavePrimera11", confirmPassword: "ClavePrimera11" };
    const segunda = { currentPassword: TEST_PASSWORD, newPassword: "ClaveSegunda22", confirmPassword: "ClaveSegunda22" };

    const retencion = await retener(usuario.id);
    const a = desenlace(authService.changePassword(usuario.id, primera, {}));
    await enCola(1);
    const b = desenlace(authService.changePassword(usuario.id, segunda, {}));
    await enCola(2);
    await retencion.query("COMMIT");

    const ra = await a;
    const rb = await b;
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(rb.error).toBeInstanceOf(ConflictError);

    const final = await cuenta(usuario.id);
    expect(await verifyPassword(final.passwordHash, "ClavePrimera11"), "vale la del primero").toBe(true);
    expect(await verifyPassword(final.passwordHash, "ClaveSegunda22"), "la del segundo no se aplicó").toBe(false);

    expect(await sesionesActivas(usuario.id), "una sola sesión: la del primero").toBe(1);
    if (ra.ok) expect(await sesionVigente(sidDe(ra.valor.accessToken), usuario.id)).toBe(true);
    expect(await sesionVigente(sidDe(inicio.accessToken), usuario.id)).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: "PASSWORD_CHANGED" } })).toBe(1);
  });
});

describe("un intento fallido no sobrescribe un estado posterior", () => {
  /** En el umbral: sin la revalidación, este intento aplicaría un bloqueo temporal. */
  async function enElUmbral(username: string) {
    const usuario = await createUser({ username, roleNames: ["swimmer"] });
    await prisma.user.update({ where: { id: usuario.id }, data: { failedLoginAttempts: 4 } });
    return usuario;
  }

  it("un bloqueo ADMINISTRATIVO prevalece: no se convierte en temporal", async () => {
    const usuario = await enElUmbral("fallo_admin");

    const retencion = await retener(usuario.id);
    const intento = desenlace(entrar("fallo_admin", INCORRECTA));
    await enCola(1);
    await retencion.query("UPDATE users SET status = 'locked', locked_until = NULL WHERE id = $1", [usuario.id]);
    await retencion.query("COMMIT");

    const i = await intento;
    expect(i.ok).toBe(false);
    if (!i.ok) expect((i.error as Error).message, "la respuesta no cambia").toBe("Usuario o contraseña incorrectos");

    const final = await cuenta(usuario.id);
    expect(final.status).toBe("locked");
    expect(final.lockedUntil, "sigue siendo administrativo: nunca vence").toBeNull();
    expect(final.failedLoginAttempts).toBe(4);
    expect(await prisma.auditLog.count({ where: { action: "USER_LOCKED" } })).toBe(0);
  });

  it("una INHABILITACIÓN prevalece", async () => {
    const usuario = await enElUmbral("fallo_disabled");

    const retencion = await retener(usuario.id);
    const intento = desenlace(entrar("fallo_disabled", INCORRECTA));
    await enCola(1);
    await retencion.query("UPDATE users SET status = 'disabled' WHERE id = $1", [usuario.id]);
    await retencion.query("COMMIT");

    await intento;
    const final = await cuenta(usuario.id);
    expect(final.status).toBe("disabled");
    expect(final.lockedUntil).toBeNull();
    expect(final.failedLoginAttempts).toBe(4);
  });

  it("una ELIMINACIÓN prevalece", async () => {
    const usuario = await enElUmbral("fallo_eliminada");

    const retencion = await retener(usuario.id);
    const intento = desenlace(entrar("fallo_eliminada", INCORRECTA));
    await enCola(1);
    await retencion.query("UPDATE users SET status = 'disabled', deleted_at = now() WHERE id = $1", [usuario.id]);
    await retencion.query("COMMIT");

    await intento;
    const final = await cuenta(usuario.id);
    expect(final.status).toBe("disabled");
    expect(final.lockedUntil).toBeNull();
    expect(final.failedLoginAttempts).toBe(4);
  });

  it("un intento contra un hash SUSTITUIDO no cuenta: no bloquea la credencial nueva", async () => {
    const usuario = await enElUmbral("fallo_hash");
    const hashNuevo = await hashPassword("ClaveRestablecida1");

    const retencion = await retener(usuario.id);
    const intento = desenlace(entrar("fallo_hash", INCORRECTA));
    await enCola(1);
    await retencion.query("UPDATE users SET password_hash = $1, failed_login_attempts = 0 WHERE id = $2", [hashNuevo, usuario.id]);
    await retencion.query("COMMIT");

    await intento;
    const final = await cuenta(usuario.id);
    expect(final.status).toBe("active");
    expect(final.failedLoginAttempts, "el restablecimiento dejó 0, y sigue en 0").toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "USER_LOCKED" } })).toBe(0);
  });

  it("el intento se sigue auditando aunque no cuente", async () => {
    const usuario = await enElUmbral("fallo_auditado");

    const retencion = await retener(usuario.id);
    const intento = desenlace(entrar("fallo_auditado", INCORRECTA));
    await enCola(1);
    await retencion.query("UPDATE users SET status = 'disabled' WHERE id = $1", [usuario.id]);
    await retencion.query("COMMIT");

    await intento;
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_FAILED", userId: usuario.id } })).toBe(1);
  });
});

describe("la reactivación de un bloqueo temporal vencido no deshace estados posteriores", () => {
  const vencida = async (username: string) =>
    createUser({ username, roleNames: ["swimmer"], status: "locked", lockedUntil: new Date(Date.now() - 60_000) });

  it.each([
    ["contraseña correcta", TEST_PASSWORD],
    ["contraseña incorrecta", INCORRECTA],
  ])("%s + bloqueo administrativo concurrente: no vuelve a activa", async (_nombre, clave) => {
    const usuario = await vencida("vencida_admin");

    const retencion = await retener(usuario.id);
    const intento = desenlace(entrar("vencida_admin", clave));
    await enCola(1);
    await retencion.query("UPDATE users SET status = 'locked', locked_until = NULL WHERE id = $1", [usuario.id]);
    await retencion.query("COMMIT");

    expect((await intento).ok).toBe(false);
    const final = await cuenta(usuario.id);
    expect(final.status).toBe("locked");
    expect(final.lockedUntil).toBeNull();
    expect(await prisma.refreshSession.count({ where: { userId: usuario.id } })).toBe(0);
  });

  it.each([
    ["contraseña correcta", TEST_PASSWORD],
    ["contraseña incorrecta", INCORRECTA],
  ])("%s + inhabilitación concurrente: no vuelve a activa", async (_nombre, clave) => {
    const usuario = await vencida("vencida_disabled");

    const retencion = await retener(usuario.id);
    const intento = desenlace(entrar("vencida_disabled", clave));
    await enCola(1);
    await retencion.query("UPDATE users SET status = 'disabled', locked_until = NULL WHERE id = $1", [usuario.id]);
    await retencion.query("COMMIT");

    expect((await intento).ok).toBe(false);
    expect((await cuenta(usuario.id)).status).toBe("disabled");
    expect(await prisma.refreshSession.count({ where: { userId: usuario.id } })).toBe(0);
  });
});

describe("umbral de intentos fallidos con solapamiento", () => {
  it("tres fallos en cola desde 3: bloquea una vez y el tercero ya no cuenta", async () => {
    const usuario = await createUser({ username: "umbral_cola", roleNames: ["swimmer"] });
    await prisma.user.update({ where: { id: usuario.id }, data: { failedLoginAttempts: 3 } });

    const retencion = await retener(usuario.id);
    const uno = desenlace(entrar("umbral_cola", INCORRECTA));
    await enCola(1);
    const dos = desenlace(entrar("umbral_cola", INCORRECTA));
    await enCola(2);
    const tres = desenlace(entrar("umbral_cola", INCORRECTA));
    await enCola(3);
    await retencion.query("COMMIT");
    await Promise.all([uno, dos, tres]);

    const final = await cuenta(usuario.id);
    expect(final.status).toBe("locked");
    expect(final.lockedUntil).not.toBeNull();
    expect(final.failedLoginAttempts, "el bloqueo reinicia el contador, y el tercero no lo mueve").toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "USER_LOCKED" } }), "un solo bloqueo").toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_FAILED" } }), "tres intentos auditados").toBe(3);
  });

  it("un fallo que bloquea, delante de un login correcto: el login ve el bloqueo", async () => {
    const usuario = await createUser({ username: "umbral_y_ok", roleNames: ["swimmer"] });
    await prisma.user.update({ where: { id: usuario.id }, data: { failedLoginAttempts: 4 } });

    const retencion = await retener(usuario.id);
    const fallo = desenlace(entrar("umbral_y_ok", INCORRECTA));
    await enCola(1);
    const correcto = desenlace(entrar("umbral_y_ok"));
    await enCola(2);
    await retencion.query("COMMIT");

    expect((await fallo).ok).toBe(false);
    const c = await correcto;
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error).toBeInstanceOf(AccountLockedError);
    expect(await prisma.refreshSession.count({ where: { userId: usuario.id } })).toBe(0);
  });

  it("un login correcto delante de un fallo: el contador parte de cero", async () => {
    const usuario = await createUser({ username: "ok_y_fallo", roleNames: ["swimmer"] });
    await prisma.user.update({ where: { id: usuario.id }, data: { failedLoginAttempts: 4 } });

    const retencion = await retener(usuario.id);
    const correcto = desenlace(entrar("ok_y_fallo"));
    await enCola(1);
    const fallo = desenlace(entrar("ok_y_fallo", INCORRECTA));
    await enCola(2);
    await retencion.query("COMMIT");

    expect((await correcto).ok).toBe(true);
    expect((await fallo).ok).toBe(false);
    const final = await cuenta(usuario.id);
    expect(final.status).toBe("active");
    expect(final.failedLoginAttempts).toBe(1);
  });
});
