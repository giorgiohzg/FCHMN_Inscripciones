/**
 * C-04 — intentos de `/auth/change-password` por SESIÓN.
 *
 * Política: cinco contraseñas actuales incorrectas durante la vida de la sesión; en la
 * quinta se termina SOLO esa sesión. La cuenta, las demás sesiones y los logins futuros no
 * cambian; el refresh no reinicia el contador; rige igual para el cambio obligatorio.
 *
 * Datos sintéticos; solo la base desechable de `docker-compose.test.yml` (el guard de
 * `testDb.ts` lo exige).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, TEST_PASSWORD } from "./helpers/seedRbac";
import * as authService from "../src/modules/auth/auth.service";
import { verifyPassword } from "../src/modules/auth/password.util";
import {
  aplicarFallo,
  liberarReserva,
  reservarCambio,
  CambioDeContrasenaEnCursoError,
  IntentosDeCambioAgotadosError,
  MAX_FALLOS_CAMBIO_CONTRASENA,
} from "../src/modules/auth/cambioContrasena";
import { ConflictError, UnauthorizedError, ValidationError } from "../src/shared/errors";

/**
 * Controles de la prueba, compartidos con los dobles de abajo (`vi.hoisted`: los `vi.mock`
 * se evalúan antes que el resto del archivo).
 *
 *  - `fallarEn`: acciones de auditoría que fallan, para simular una caída DESPUÉS del
 *    incremento y la revocación del quinto intento y ANTES del commit.
 *  - `barrera`: si está puesta, la PRÓXIMA verificación de contraseña avisa al llegar y
 *    queda retenida hasta que la prueba la suelte. Hace determinista el solapamiento.
 *  - `verificaciones`: cuántas verificaciones de contraseña se calcularon.
 *
 * Sin barrera ni fallos, los dobles delegan en el código real.
 */
const control = vi.hoisted(() => ({
  fallarEn: new Set<string>(),
  barrera: null as null | { alcanzada: () => void; suelta: Promise<void> },
  verificaciones: 0,
}));
vi.mock("../src/modules/audit/audit.service", async (original) => {
  const real = await original<typeof import("../src/modules/audit/audit.service")>();
  return {
    ...real,
    audit: (...args: Parameters<typeof real.audit>) =>
      control.fallarEn.has(args[0].action) ? Promise.reject(new Error("caída inyectada")) : real.audit(...args),
  };
});
vi.mock("../src/modules/auth/password.util", async (original) => {
  const real = await original<typeof import("../src/modules/auth/password.util")>();
  const contarYRetener = async () => {
    control.verificaciones++;
    const barrera = control.barrera;
    if (barrera) {
      control.barrera = null;
      barrera.alcanzada();
      await barrera.suelta;
    }
  };
  return {
    ...real,
    verifyPassword: async (...args: Parameters<typeof real.verifyPassword>) => {
      await contarYRetener();
      return real.verifyPassword(...args);
    },
    // El cambio de contraseña verifica DENTRO de su cupo (verificación y hash nuevo en una sola
    // adquisición): el doble envuelve esa verificación con el mismo recuento y la misma barrera.
    conArgon2: <T,>(fn: Parameters<typeof real.conArgon2<T>>[0]) =>
      real.conArgon2<T>((ops) =>
        fn({
          ...ops,
          verificar: async (hash, plain) => {
            await contarYRetener();
            return ops.verificar(hash, plain);
          },
        })
      ),
  };
});

let app: FastifyInstance;
const CTX = { ipAddress: "127.0.0.1" };
const NUEVA = "ClaveNuevaSintetica9";
const INCORRECTA = "ClaveIncorrecta9";
const sidDe = (accessToken: string) => (jwt.decode(accessToken) as { sid: string }).sid;
const cambio = (actual: string, nueva = NUEVA) => ({ currentPassword: actual, newPassword: nueva, confirmPassword: nueva });

async function entrar(username: string) {
  return authService.login({ username, password: TEST_PASSWORD }, CTX);
}
async function sesionBd(sid: string) {
  return prisma.refreshSession.findUniqueOrThrow({ where: { id: sid } });
}
async function estadoDelJwt(accessToken: string) {
  const res = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${accessToken}` } });
  return res.statusCode;
}
async function cambiarHttp(accessToken: string, cuerpo: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/auth/change-password", headers: { authorization: `Bearer ${accessToken}` }, payload: cuerpo });
}
async function auditados(action: string, userId: string) {
  return prisma.auditLog.count({ where: { action, userId } });
}
async function resultado<T>(p: Promise<T>): Promise<{ ok: true; valor: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, valor: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();
});

beforeEach(() => {
  control.fallarEn.clear();
  control.barrera = null;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("política secuencial", () => {
  it("cambio voluntario: los cuatro primeros fallos no expulsan; el quinto termina SOLO esta sesión", async () => {
    const usuario = await createUser({ username: "c04_voluntario", roleNames: ["swimmer"] });
    const esta = await entrar("c04_voluntario");
    const otra = await entrar("c04_voluntario");

    for (let i = 1; i < MAX_FALLOS_CAMBIO_CONTRASENA; i++) {
      const res = await cambiarHttp(esta.accessToken, cambio(INCORRECTA));
      expect(res.statusCode, `intento ${i}`).toBe(400);
      expect(res.json().message).toBe("La contraseña actual es incorrecta");
      expect(await estadoDelJwt(esta.accessToken), `sigue con sesión tras ${i}`).toBe(200);
      expect((await sesionBd(sidDe(esta.accessToken))).passwordChangeFailures).toBe(i);
    }

    const quinto = await cambiarHttp(esta.accessToken, cambio(INCORRECTA));
    expect(quinto.statusCode).toBe(401);
    expect(quinto.json().error).toBe("PASSWORD_CHANGE_ATTEMPTS_EXCEEDED");

    const terminada = await sesionBd(sidDe(esta.accessToken));
    expect(terminada.revokedAt).not.toBeNull();
    expect(terminada.revokedReason).toBe("password_change_attempts");
    expect(await estadoDelJwt(esta.accessToken)).toBe(401);
    await expect(authService.refresh(esta.refreshToken, CTX)).rejects.toBeInstanceOf(UnauthorizedError);

    // La otra sesión, la cuenta y los logins futuros no cambian.
    expect(await estadoDelJwt(otra.accessToken)).toBe(200);
    const cuenta = await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } });
    expect(cuenta.status).toBe("active");
    expect(cuenta.failedLoginAttempts).toBe(0);
    expect(cuenta.lockedUntil).toBeNull();
    const nueva = await entrar("c04_voluntario");
    expect(await estadoDelJwt(nueva.accessToken)).toBe(200);

    expect(await auditados("PASSWORD_CHANGE_FAILED", usuario.id)).toBe(MAX_FALLOS_CAMBIO_CONTRASENA - 1);
    expect(await auditados("PASSWORD_CHANGE_ATTEMPTS_EXCEEDED", usuario.id)).toBe(1);

    // La sesión nueva tiene su propio presupuesto y el cambio correcto sigue funcionando.
    const correcto = await cambiarHttp(nueva.accessToken, cambio(TEST_PASSWORD));
    expect(correcto.statusCode).toBe(200);
    expect(await verifyPassword((await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } })).passwordHash, NUEVA)).toBe(true);
    expect(await estadoDelJwt(otra.accessToken), "el cambio correcto sí cierra las demás").toBe(401);
  });

  it("cambio obligatorio: misma política, y al volver a entrar el cambio sigue pendiente", async () => {
    const usuario = await createUser({ username: "c04_obligatorio", roleNames: ["swimmer"], mustChangePassword: true });
    const esta = await entrar("c04_obligatorio");
    expect(esta.mustChangePassword).toBe(true);

    for (let i = 1; i < MAX_FALLOS_CAMBIO_CONTRASENA; i++) {
      expect((await cambiarHttp(esta.accessToken, cambio(INCORRECTA))).statusCode).toBe(400);
    }
    const quinto = await cambiarHttp(esta.accessToken, cambio(INCORRECTA));
    expect(quinto.statusCode).toBe(401);
    expect(quinto.json().error).toBe("PASSWORD_CHANGE_ATTEMPTS_EXCEEDED");

    const otraVez = await entrar("c04_obligatorio");
    expect(otraVez.mustChangePassword).toBe(true);
    expect((await cambiarHttp(otraVez.accessToken, cambio(TEST_PASSWORD))).statusCode).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } })).mustChangePassword).toBe(false);
  });

  it("el refresh no reinicia el contador: misma sesión, mismo presupuesto", async () => {
    await createUser({ username: "c04_refresh", roleNames: ["swimmer"] });
    const inicio = await entrar("c04_refresh");
    const sid = sidDe(inicio.accessToken);

    for (let i = 0; i < 3; i++) expect((await cambiarHttp(inicio.accessToken, cambio(INCORRECTA))).statusCode).toBe(400);
    const renovada = await authService.refresh(inicio.refreshToken, CTX);
    expect(sidDe(renovada.accessToken)).toBe(sid);
    expect((await sesionBd(sid)).passwordChangeFailures).toBe(3);

    expect((await cambiarHttp(renovada.accessToken, cambio(INCORRECTA))).statusCode).toBe(400);
    expect((await cambiarHttp(renovada.accessToken, cambio(INCORRECTA))).statusCode).toBe(401);
    expect((await sesionBd(sid)).revokedReason).toBe("password_change_attempts");
  });

  it("los errores de la contraseña nueva no cuentan: se rechazan antes de reservar", async () => {
    await createUser({ username: "c04_validacion", roleNames: ["swimmer"] });
    const esta = await entrar("c04_validacion");

    const debil = await cambiarHttp(esta.accessToken, { currentPassword: INCORRECTA, newPassword: "corta", confirmPassword: "corta" });
    expect(debil.statusCode).toBe(400);
    expect(debil.json().error).toBe("VALIDATION_ERROR");
    const distinta = await cambiarHttp(esta.accessToken, { currentPassword: INCORRECTA, newPassword: NUEVA, confirmPassword: "OtraDistinta9" });
    expect(distinta.statusCode).toBe(400);

    const s = await sesionBd(sidDe(esta.accessToken));
    expect(s.passwordChangeFailures).toBe(0);
    expect(s.passwordChangeReservation).toBeNull();
  });

  it("el `sid` sale del token verificado: un campo del cuerpo no cambia la sesión que se cuenta", async () => {
    await createUser({ username: "c04_sid", roleNames: ["swimmer"] });
    const esta = await entrar("c04_sid");
    const otra = await entrar("c04_sid");

    const res = await cambiarHttp(esta.accessToken, { ...cambio(INCORRECTA), sessionId: sidDe(otra.accessToken), sid: sidDe(otra.accessToken) });
    expect(res.statusCode).toBe(400);
    expect((await sesionBd(sidDe(esta.accessToken))).passwordChangeFailures).toBe(1);
    expect((await sesionBd(sidDe(otra.accessToken))).passwordChangeFailures).toBe(0);
  });
});

describe("concurrencia", () => {
  it("solapamiento determinista: con la primera verificación retenida, las competidoras no verifican ni cuentan", async () => {
    const usuario = await createUser({ username: "c04_simultaneo", roleNames: ["swimmer"] });
    const esta = await entrar("c04_simultaneo");
    const sid = sidDe(esta.accessToken);

    let alcanzada!: () => void;
    let soltar!: () => void;
    const llego = new Promise<void>((r) => (alcanzada = r));
    const suelta = new Promise<void>((r) => (soltar = r));
    control.barrera = { alcanzada, suelta };
    const verificacionesAntes = control.verificaciones;

    // La primera toma la reserva y queda retenida DENTRO de la verificación.
    const primera = resultado(authService.changePassword(usuario.id, sid, cambio(INCORRECTA), CTX));
    await llego;
    expect((await sesionBd(sid)).passwordChangeReservation, "la primera tiene la reserva").not.toBeNull();

    // Competidoras con la reserva ocupada: 429 sin calcular Argon2 y sin contar.
    const competidoras = await Promise.all(
      Array.from({ length: 6 }, () => resultado(authService.changePassword(usuario.id, sid, cambio(INCORRECTA), CTX)))
    );
    for (const c of competidoras) {
      expect(c.ok).toBe(false);
      if (!c.ok) expect(c.error).toBeInstanceOf(CambioDeContrasenaEnCursoError);
    }
    expect(control.verificaciones - verificacionesAntes, "solo verificó la primera").toBe(1);
    const durante = await sesionBd(sid);
    expect(durante.passwordChangeFailures).toBe(0);
    expect(durante.passwordChangeReservation, "las competidoras no liberaron la reserva ajena").not.toBeNull();

    // Al soltarla, la primera aplica su fallo y libera su reserva.
    soltar();
    const r = await primera;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
    const despues = await sesionBd(sid);
    expect(despues.passwordChangeFailures).toBe(1);
    expect(despues.passwordChangeReservation).toBeNull();
    expect(await auditados("PASSWORD_CHANGE_FAILED", usuario.id)).toBe(1);
    expect(await estadoDelJwt(esta.accessToken)).toBe(200);
  });

  it("reserva vencida y tomada por otra solicitud: el resultado antiguo no produce efectos, falle o acierte", async () => {
    const usuario = await createUser({ username: "c04_vencida", roleNames: ["swimmer"] });
    const esta = await entrar("c04_vencida");
    const sid = sidDe(esta.accessToken);

    const antigua = await reservarCambio(sid, usuario.id);
    await prisma.refreshSession.update({ where: { id: sid }, data: { passwordChangeReservedUntil: new Date(Date.now() - 1000) } });
    const vigente = await reservarCambio(sid, usuario.id);

    // Fallo antiguo: obsoleto, sin contar.
    expect(await aplicarFallo(antigua, CTX)).toBeInstanceOf(ConflictError);
    // Acierto antiguo: obsoleto, MISMA respuesta y sin cambiar la contraseña.
    await expect(authService.cambiarConReserva(usuario.id, antigua, cambio(TEST_PASSWORD), CTX)).rejects.toBeInstanceOf(ConflictError);
    expect(await verifyPassword((await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } })).passwordHash, TEST_PASSWORD)).toBe(true);

    // Liberar la antigua no toca la vigente.
    await liberarReserva(antigua);
    let s = await sesionBd(sid);
    expect(s.passwordChangeFailures).toBe(0);
    expect(s.passwordChangeReservation).toBe(vigente.token);

    // La vigente sí produce efectos.
    expect(await aplicarFallo(vigente, CTX)).toBeInstanceOf(ValidationError);
    s = await sesionBd(sid);
    expect(s.passwordChangeFailures).toBe(1);
    expect(s.passwordChangeReservation).toBeNull();
    expect(await estadoDelJwt(esta.accessToken)).toBe(200);
  });

  it("caída entre el incremento y el cierre del quinto fallo: se revierte todo", async () => {
    const usuario = await createUser({ username: "c04_caida", roleNames: ["swimmer"] });
    const esta = await entrar("c04_caida");
    const sid = sidDe(esta.accessToken);
    await prisma.refreshSession.update({ where: { id: sid }, data: { passwordChangeFailures: MAX_FALLOS_CAMBIO_CONTRASENA - 1 } });

    control.fallarEn.add("PASSWORD_CHANGE_ATTEMPTS_EXCEEDED");
    const r = await resultado(authService.changePassword(usuario.id, sid, cambio(INCORRECTA), CTX));
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.error as Error).message).toBe("caída inyectada");

    const s = await sesionBd(sid);
    expect(s.passwordChangeFailures, "el incremento se revirtió").toBe(MAX_FALLOS_CAMBIO_CONTRASENA - 1);
    expect(s.revokedAt, "la revocación se revirtió").toBeNull();
    expect(s.passwordChangeReservation, "la reserva propia se liberó al fallar").toBeNull();
    expect(await auditados("PASSWORD_CHANGE_ATTEMPTS_EXCEEDED", usuario.id)).toBe(0);
    expect(await estadoDelJwt(esta.accessToken)).toBe(200);

    // Recuperación: sin la caída, el siguiente intento se aplica con normalidad.
    control.fallarEn.clear();
    await expect(authService.changePassword(usuario.id, sid, cambio(INCORRECTA), CTX)).rejects.toBeInstanceOf(IntentosDeCambioAgotadosError);
    expect((await sesionBd(sid)).revokedReason).toBe("password_change_attempts");
  });

  it("un error al auditar un fallo intermedio tampoco cuenta y libera la reserva", async () => {
    const usuario = await createUser({ username: "c04_error_intermedio", roleNames: ["swimmer"] });
    const esta = await entrar("c04_error_intermedio");
    const sid = sidDe(esta.accessToken);

    control.fallarEn.add("PASSWORD_CHANGE_FAILED");
    expect((await resultado(authService.changePassword(usuario.id, sid, cambio(INCORRECTA), CTX))).ok).toBe(false);
    const s = await sesionBd(sid);
    expect(s.passwordChangeFailures).toBe(0);
    expect(s.passwordChangeReservation).toBeNull();
  });
});

describe("cambio correcto frente a otras operaciones", () => {
  it("frente a la revocación de su sesión (logout): no cambia la contraseña y la respuesta no revela si acertó", async () => {
    const usuario = await createUser({ username: "c04_logout", roleNames: ["swimmer"] });
    const esta = await entrar("c04_logout");
    const sid = sidDe(esta.accessToken);

    const reserva = await reservarCambio(sid, usuario.id);
    await authService.logout(esta.refreshToken, CTX);

    await expect(authService.cambiarConReserva(usuario.id, reserva, cambio(TEST_PASSWORD), CTX)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await aplicarFallo(reserva, CTX)).toBeInstanceOf(UnauthorizedError);
    const cuenta = await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } });
    expect(await verifyPassword(cuenta.passwordHash, TEST_PASSWORD)).toBe(true);
    expect((await sesionBd(sid)).passwordChangeFailures).toBe(0);
  });

  it("frente a la terminación por el quinto fallo de otra solicitud de la misma sesión", async () => {
    const usuario = await createUser({ username: "c04_vs_quinto", roleNames: ["swimmer"] });
    const esta = await entrar("c04_vs_quinto");
    const sid = sidDe(esta.accessToken);
    await prisma.refreshSession.update({ where: { id: sid }, data: { passwordChangeFailures: MAX_FALLOS_CAMBIO_CONTRASENA - 1 } });

    // La correcta tomó la reserva, se quedó atrás y la perdió; otra solicitud reserva y falla por quinta vez.
    const correcta = await reservarCambio(sid, usuario.id);
    await prisma.refreshSession.update({ where: { id: sid }, data: { passwordChangeReservedUntil: new Date(Date.now() - 1000) } });
    const quinta = await reservarCambio(sid, usuario.id);
    expect(await aplicarFallo(quinta, CTX)).toBeInstanceOf(IntentosDeCambioAgotadosError);

    await expect(authService.cambiarConReserva(usuario.id, correcta, cambio(TEST_PASSWORD), CTX)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await verifyPassword((await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } })).passwordHash, TEST_PASSWORD)).toBe(true);
  });

  it("frente a una segunda solicitud de la misma sesión: la segunda recibe 429 y no cuenta", async () => {
    const usuario = await createUser({ username: "c04_segunda", roleNames: ["swimmer"] });
    const esta = await entrar("c04_segunda");
    const sid = sidDe(esta.accessToken);

    const reserva = await reservarCambio(sid, usuario.id);
    await expect(authService.changePassword(usuario.id, sid, cambio(INCORRECTA), CTX)).rejects.toBeInstanceOf(CambioDeContrasenaEnCursoError);
    expect((await sesionBd(sid)).passwordChangeFailures).toBe(0);

    const hecho = await authService.cambiarConReserva(usuario.id, reserva, cambio(TEST_PASSWORD), CTX);
    expect(hecho.accessToken).toBeTruthy();
    expect((await sesionBd(sid)).revokedReason).toBe("password_change");
  });

  it("frente a un cambio simultáneo desde otra sesión: gana uno y el otro no aplica nada", async () => {
    const usuario = await createUser({ username: "c04_dos_sesiones", roleNames: ["swimmer"] });
    const a = await entrar("c04_dos_sesiones");
    const b = await entrar("c04_dos_sesiones");

    const [ra, rb] = await Promise.all([
      resultado(authService.changePassword(usuario.id, sidDe(a.accessToken), cambio(TEST_PASSWORD, "ClaveDeA12345"), CTX)),
      resultado(authService.changePassword(usuario.id, sidDe(b.accessToken), cambio(TEST_PASSWORD, "ClaveDeB12345"), CTX)),
    ]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
    const perdedor = ra.ok ? rb : ra;
    if (!perdedor.ok) expect(perdedor.error instanceof UnauthorizedError || perdedor.error instanceof ConflictError).toBe(true);

    const hash = (await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } })).passwordHash;
    const ganoA = ra.ok;
    expect(await verifyPassword(hash, ganoA ? "ClaveDeA12345" : "ClaveDeB12345")).toBe(true);
    expect(await verifyPassword(hash, ganoA ? "ClaveDeB12345" : "ClaveDeA12345")).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: "PASSWORD_CHANGED", userId: usuario.id } })).toBe(1);
  });
});
