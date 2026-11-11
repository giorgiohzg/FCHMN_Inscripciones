/**
 * Fase 2 — contrato del login, contra los servicios y la API reales sobre la base desechable.
 *
 * Qué se responde depende de lo que quien llama PROBÓ:
 *
 *   - usuario inexistente o eliminado, contraseña incorrecta, incoherencia entre la persona y
 *     su cuenta (persona eliminada, estados que no se corresponden) y bloqueo temporal VIGENTE
 *     (aunque la contraseña sea correcta): un único 401 genérico, con el mismo código y el
 *     mismo mensaje;
 *   - cuenta inhabilitada o bloqueada por un administrador, sola o junto a su persona con el
 *     mismo estado (lo que dejan `blockPerson` / `disablePerson`): el motivo, solo tras
 *     comprobar una contraseña correcta frente al hash vigente;
 *   - bloqueo temporal vencido: el flujo normal de la Fase 1.
 *
 * Donde no hay una contraseña real que comprobar se hace una verificación FICTICIA de Argon2.
 * Se mide observando `argon2.verify` y `argon2.hash`: lo que se afirma es QUÉ camino se recorre,
 * no cuánto tarda. Los tiempos de respuesta no se comparan, y no se afirma que sean iguales:
 * las demás consultas del login siguen existiendo y producen diferencias residuales.
 *
 * Solo datos sintéticos.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { env } from "../src/shared/env";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createPerson, createUser, TEST_PASSWORD } from "./helpers/seedRbac";
import * as authService from "../src/modules/auth/auth.service";
import * as personsService from "../src/modules/persons/persons.service";
import { verificacionFicticia } from "../src/modules/auth/password.util";
import { UnauthorizedError } from "../src/shared/errors";
import { PERFIL } from "../src/modules/auth/limitadorClaves";
import { MENSAJE_LOGIN_LIMITADO } from "../src/modules/auth/limitadorLogin";

const HORA = 3_600_000;
const INCORRECTA = "ClaveIncorrecta1";
const GENERICO = { error: "UNAUTHORIZED", message: "Usuario o contraseña incorrectos" };

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

const http = (username: string, password: string) => app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
const cuenta = (username: string) => prisma.user.findFirstOrThrow({ where: { username } });
const sesiones = () => prisma.refreshSession.count();
const fallosAuditados = () => prisma.auditLog.count({ where: { action: "LOGIN_FAILED" } });

/** Crea una cuenta en cada situación del contrato. Devuelve los nombres de usuario. */
async function montarEstados() {
  await createUser({ username: "activa", roleNames: ["swimmer"] });
  await createUser({ username: "inhabilitada", roleNames: ["swimmer"], status: "disabled" });
  await createUser({ username: "bloq_admin", roleNames: ["swimmer"], status: "locked", lockedUntil: null });
  await createUser({ username: "bloq_vigente", roleNames: ["swimmer"], status: "locked", lockedUntil: new Date(Date.now() + HORA) });
  await createUser({ username: "bloq_vencido", roleNames: ["swimmer"], status: "locked", lockedUntil: new Date(Date.now() - 1000) });

  const eliminada = await createUser({ username: "eliminada", roleNames: ["swimmer"] });
  await prisma.user.update({ where: { id: eliminada.id }, data: { deletedAt: new Date() } });

  const persona = await createPerson({ run: "92000001", username: "persona_inutil", firstName: "Eva", gender: "female" });
  await createUser({ username: "persona_inutil", roleNames: ["swimmer"], personId: persona.id });
  await prisma.person.update({ where: { id: persona.id }, data: { status: "disabled" } });
}

describe("matriz por estado y contraseña (por HTTP)", () => {
  /** Estado, contraseña presentada y respuesta esperada. `null` = el 401 genérico. */
  const matriz: Array<[string, string, "correcta" | "incorrecta", string | null]> = [
    ["inexistente", "no_existe", "correcta", null],
    ["inexistente", "no_existe", "incorrecta", null],
    ["eliminada", "eliminada", "correcta", null],
    ["eliminada", "eliminada", "incorrecta", null],
    ["activa", "activa", "incorrecta", null],
    ["persona inutilizable", "persona_inutil", "correcta", null],
    ["persona inutilizable", "persona_inutil", "incorrecta", null],
    ["inhabilitada", "inhabilitada", "incorrecta", null],
    ["inhabilitada", "inhabilitada", "correcta", "Cuenta inhabilitada. Contacte al administrador."],
    ["bloqueada por un administrador", "bloq_admin", "incorrecta", null],
    ["bloqueada por un administrador", "bloq_admin", "correcta", "Cuenta bloqueada por un administrador. Contacte al administrador."],
    ["bloqueo temporal vigente", "bloq_vigente", "incorrecta", null],
    ["bloqueo temporal vigente", "bloq_vigente", "correcta", null],
    ["bloqueo temporal vencido", "bloq_vencido", "incorrecta", null],
  ];

  it.each(matriz)("%s, contraseña %s → %s", async (_estado, username, tipo, mensaje) => {
    await montarEstados();
    const res = await http(username, tipo === "correcta" ? TEST_PASSWORD : INCORRECTA);

    expect(res.statusCode).toBe(401);
    if (mensaje === null) {
      expect(res.json(), "respuesta genérica: mismo código y mismo mensaje").toEqual(GENERICO);
    } else {
      expect(res.json()).toEqual({ error: "UNAUTHORIZED", message: mensaje });
    }
    expect(res.headers["set-cookie"], "ningún rechazo emite sesión").toBeUndefined();
    expect(await sesiones()).toBe(0);
  });

  it("todas las respuestas genéricas son idénticas entre sí (estado, cuerpo y cabeceras de sesión)", async () => {
    await montarEstados();
    const intentos: Array<[string, string]> = [
      ["no_existe", TEST_PASSWORD],
      ["eliminada", TEST_PASSWORD],
      ["activa", INCORRECTA],
      ["persona_inutil", TEST_PASSWORD],
      ["bloq_vigente", TEST_PASSWORD],
      ["bloq_vigente", INCORRECTA],
      ["inhabilitada", INCORRECTA],
      ["bloq_admin", INCORRECTA],
    ];
    const respuestas = [];
    for (const [u, p] of intentos) respuestas.push(await http(u, p));

    const [primera, ...resto] = respuestas;
    for (const r of resto) {
      expect(r.statusCode).toBe(primera!.statusCode);
      expect(r.body).toBe(primera!.body);
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("cuenta activa con la contraseña correcta entra (200) y emite sesión", async () => {
    await montarEstados();
    const res = await http("activa", TEST_PASSWORD);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("accessToken");
    expect(await sesiones()).toBe(1);
  });

  it("bloqueo temporal VENCIDO con la contraseña correcta: entra y se levanta", async () => {
    await montarEstados();
    const res = await http("bloq_vencido", TEST_PASSWORD);

    expect(res.statusCode).toBe(200);
    const c = await cuenta("bloq_vencido");
    expect(c.status).toBe("active");
    expect(c.lockedUntil).toBeNull();
  });

  /**
   * C-02: un fallo ya no escribe en `users`. El bloqueo temporal antiguo, vencido, solo se
   * levanta con el próximo login CORRECTO (prueba anterior); el fallo lo cuenta el limitador.
   */
  it("bloqueo temporal VENCIDO con contraseña incorrecta: genérico, sin escribir la cuenta; el fallo lo cuenta el limitador", async () => {
    await montarEstados();
    const res = await http("bloq_vencido", INCORRECTA);

    expect(res.json()).toEqual(GENERICO);
    const c = await cuenta("bloq_vencido");
    expect(c.status, "no se reactiva con un fallo").toBe("locked");
    expect(c.failedLoginAttempts, "RB-15 ya no cuenta intentos en la cuenta").toBe(0);
    expect(await prisma.limFalloPar.count(), "el par registró un fallo").toBe(1);
  });
});

describe("el bloqueo temporal vigente no se toca ni se expone", () => {
  it("no expone `lockedUntil` ni ninguna fecha, con contraseña correcta o incorrecta", async () => {
    const hasta = new Date(Date.now() + HORA);
    await createUser({ username: "vigente", roleNames: ["swimmer"], status: "locked", lockedUntil: hasta });

    for (const clave of [TEST_PASSWORD, INCORRECTA]) {
      const res = await http("vigente", clave);
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain("lockedUntil");
      expect(res.body).not.toContain(hasta.toISOString().slice(0, 10));
      expect(res.body.toLowerCase()).not.toContain("bloquead");
      expect(res.body).not.toContain("ACCOUNT_LOCKED");
    }
  });

  it("no cuenta intentos, no prolonga el bloqueo, no audita un fallo y no emite sesión", async () => {
    const hasta = new Date(Date.now() + HORA);
    await createUser({ username: "vigente", roleNames: ["swimmer"], status: "locked", lockedUntil: hasta });

    for (const clave of [TEST_PASSWORD, INCORRECTA, INCORRECTA]) await http("vigente", clave);

    const c = await cuenta("vigente");
    expect(c.status).toBe("locked");
    expect(c.lockedUntil?.getTime()).toBe(hasta.getTime());
    expect(c.failedLoginAttempts).toBe(0);
    expect(c.lastLoginAt).toBeNull();
    expect(await fallosAuditados(), "como antes: un bloqueo vigente no se audita como intento").toBe(0);
    expect(await sesiones()).toBe(0);
  });

  /**
   * C-02 sustituye a RB-15: los fallos de un tercero ya no bloquean la cuenta entera. Se limita
   * el PAR (5 en 15 min) con un 429 uniforme, y la cuenta sigue entrando desde otro origen.
   */
  it("C-02: los fallos ya no bloquean la cuenta; se limita el par y la contraseña correcta entra desde otro origen", async () => {
    await createUser({ username: "atacada", roleNames: ["swimmer"] });
    for (let i = 0; i < PERFIL.parMaxFallos; i++) {
      expect((await http("atacada", INCORRECTA)).json()).toEqual(GENERICO);
    }

    const limitado = await http("atacada", TEST_PASSWORD);
    expect(limitado.statusCode, "el par agotó su presupuesto: ni la correcta se verifica").toBe(429);
    expect(limitado.json()).toEqual({ error: "LOGIN_THROTTLED", message: MENSAJE_LOGIN_LIMITADO });
    expect((await cuenta("atacada")).status, "la cuenta NO se bloquea").toBe("active");

    const otroOrigen = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "atacada", password: TEST_PASSWORD },
      remoteAddress: "192.0.2.50",
    });
    expect(otroOrigen.statusCode, "desde otra red entra").toBe(200);
    expect(await sesiones()).toBe(1);
  });
});

describe("contraseña incorrecta en estados que no cuentan intentos", () => {
  it("inhabilitada y bloqueada por un administrador: genérico, sin contar intentos ni cambiar de estado", async () => {
    await createUser({ username: "inhab", roleNames: ["swimmer"], status: "disabled" });
    await createUser({ username: "adm", roleNames: ["swimmer"], status: "locked", lockedUntil: null });

    // Cinco fallos por cuenta: el sexto ya lo limita el par (C-02), sin tocar la cuenta.
    for (let i = 0; i < PERFIL.parMaxFallos; i++) {
      expect((await http("inhab", INCORRECTA)).json()).toEqual(GENERICO);
      expect((await http("adm", INCORRECTA)).json()).toEqual(GENERICO);
    }
    expect((await http("inhab", INCORRECTA)).statusCode).toBe(429);
    expect((await http("adm", INCORRECTA)).statusCode).toBe(429);

    const inhab = await cuenta("inhab");
    expect(inhab.status).toBe("disabled");
    expect(inhab.failedLoginAttempts).toBe(0);
    const adm = await cuenta("adm");
    expect(adm.status).toBe("locked");
    expect(adm.lockedUntil, "sigue siendo administrativo: nunca se convierte en temporal").toBeNull();
    expect(adm.failedLoginAttempts).toBe(0);
  });
});

describe("verificación ficticia de Argon2", () => {
  const verificar = () => vi.spyOn(argon2, "verify");
  const hashear = () => vi.spyOn(argon2, "hash");

  /** Lo que `argon2.verify` recibió y devolvió en cada llamada. */
  async function resultados(espia: ReturnType<typeof verificar>) {
    return Promise.all(espia.mock.results.map((r) => r.value as Promise<boolean>));
  }

  it("usuario inexistente: se verifica contra un hash que no es de nadie y el resultado es falso", async () => {
    await createUser({ username: "otra", roleNames: ["swimmer"] });
    const hashDeLaOtra = (await cuenta("otra")).passwordHash;
    const espia = verificar();

    await expect(authService.login({ username: "no_existe", password: TEST_PASSWORD }, {})).rejects.toBeInstanceOf(UnauthorizedError);

    expect(espia, "una sola verificación: el camino rápido ya no existe").toHaveBeenCalledTimes(1);
    expect(espia.mock.calls[0]![0]).not.toBe(hashDeLaOtra);
    expect(await resultados(espia)).toEqual([false]);
  });

  it.each([
    ["usuario eliminado", "eliminada"],
    ["persona dueña inutilizable", "persona_inutil"],
    ["bloqueo temporal vigente", "bloq_vigente"],
  ])("%s, con la contraseña REAL de la cuenta: verificación ficticia, nunca la real", async (_nombre, username) => {
    await montarEstados();
    const real = (await prisma.user.findFirstOrThrow({ where: { username } })).passwordHash;
    const espia = verificar();

    await expect(authService.login({ username, password: TEST_PASSWORD }, {})).rejects.toMatchObject({ statusCode: 401, code: GENERICO.error, message: GENERICO.message });

    expect(espia).toHaveBeenCalledTimes(1);
    expect(espia.mock.calls[0]![0], "no se comprueba el hash de la cuenta").not.toBe(real);
    expect(await resultados(espia), "la contraseña correcta NO autentica: es una verificación ficticia").toEqual([false]);
    expect(await sesiones()).toBe(0);
  });

  it("cuenta real (activa, inhabilitada, bloqueada por un administrador): se verifica el hash REAL de la cuenta", async () => {
    await montarEstados();
    for (const username of ["activa", "inhabilitada", "bloq_admin", "bloq_vencido"]) {
      const real = (await cuenta(username)).passwordHash;
      const espia = verificar();

      await authService.login({ username, password: INCORRECTA }, {}).catch(() => undefined);

      expect(espia, username).toHaveBeenCalledTimes(1);
      expect(espia.mock.calls[0]![0], username).toBe(real);
      espia.mockRestore();
    }
  });

  it("el hash ficticio se calcula UNA vez por proceso, no por petición", async () => {
    // Calienta la caché (puede haberse calculado ya en una prueba anterior del archivo).
    await verificacionFicticia("calentamiento");

    const hash = hashear();
    for (let i = 0; i < 3; i++) {
      await authService.login({ username: `no_existe_${i}`, password: TEST_PASSWORD }, {}).catch(() => undefined);
    }
    expect(hash, "ningún hash nuevo en tres peticiones").not.toHaveBeenCalled();
  });

  it("la verificación ficticia nunca devuelve verdadero, con cualquier entrada", async () => {
    const entradas = [TEST_PASSWORD, "", " ", "a".repeat(5000), "ClaveValida123".toUpperCase(), "\u0000", "ñandú-ΩΩ"];
    for (const entrada of entradas) {
      expect(await verificacionFicticia(entrada)).toBe(false);
    }
  });

  it("un fallo al calcular el hash ficticio no queda guardado: el siguiente intento lo recalcula", async () => {
    // Un proceso nuevo, sin hash guardado.
    vi.resetModules();
    const fresco = await import("../src/modules/auth/password.util");
    const hash = vi.spyOn(argon2, "hash").mockRejectedValueOnce(new Error("fallo sintético"));

    // C-02: el fallo llega como error técnico (503), con el original como causa.
    await expect(fresco.verificacionFicticia("x")).rejects.toMatchObject({
      statusCode: 503,
      cause: expect.objectContaining({ message: "fallo sintético" }),
    });
    await expect(fresco.verificacionFicticia("x")).resolves.toBe(false);
    expect(hash).toHaveBeenCalledTimes(2);
  });
});

/**
 * Hace fallar UNA vez un método de un delegado de Prisma y lo restituye tal cual estaba.
 *
 * No se usa `vi.spyOn` sobre `prisma.user`: tras `restoreAllMocks` el método quedaba como
 * `undefined` para el resto del archivo. Aquí se guarda el original y se reasigna.
 */
async function fallarUnaVez(delegado: object, metodo: string, error: unknown, prueba: () => Promise<void>) {
  const d = delegado as Record<string, unknown>;
  const original = d[metodo];
  d[metodo] = () => {
    d[metodo] = original;
    return Promise.reject(error);
  };
  try {
    await prueba();
  } finally {
    d[metodo] = original;
  }
}

describe("errores técnicos y límite por IP conservan su clasificación", () => {
  it("una base que no responde al buscar la cuenta es 503, no un error de credenciales", async () => {
    await createUser({ username: "activa", roleNames: ["swimmer"] });
    const falla = Object.assign(new Error("sin conexión sintética"), { code: "P1001" });

    await fallarUnaVez(prisma.user, "findFirst", falla, async () => {
      const res = await http("activa", TEST_PASSWORD);

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("SERVICE_UNAVAILABLE");
      expect(res.body).not.toContain("sin conexión sintética");
    });
  });

  it("un fallo inesperado al buscar la cuenta es un 500 genérico, sin el texto interno", async () => {
    await fallarUnaVez(prisma.user, "findFirst", new Error("SELECT secreto FROM interno"), async () => {
      const res = await http("activa", TEST_PASSWORD);

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "INTERNAL_ERROR", message: "Error interno del servidor" });
    });
  });

  it("una base que se cae DESPUÉS de comprobar la contraseña correcta es 503, sin sesión y sin contar un intento", async () => {
    const usuario = await createUser({ username: "cae_despues", roleNames: ["swimmer"] });
    const falla = Object.assign(new Error("conexión cerrada sintética"), { code: "P1017" });
    const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>;
    let llamadas = 0;
    // C-02: las dos primeras transacciones son la admisión y la liquidación del acierto en el
    // limitador; la TERCERA es la de la sesión, la que se hace fallar.
    vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) => {
      llamadas++;
      return llamadas === 3 ? Promise.reject(falla) : original(...args);
    }) as never);

    const res = await http("cae_despues", TEST_PASSWORD);

    expect(llamadas).toBe(3);
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("conexión cerrada sintética");
    expect(await sesiones()).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } })).failedLoginAttempts).toBe(0);
    expect(await prisma.limFalloPar.count(), "un acierto no cuenta como fallo").toBe(0);
  });

  it("el límite por IP sigue respondiendo 429, con su propio código", async () => {
    const limitado = await buildServer({ ...env, RATE_LIMIT_AUTH_MAX: 1 });
    try {
      await limitado.inject({ method: "POST", url: "/auth/login", payload: { username: "x", password: INCORRECTA } });
      const res = await limitado.inject({ method: "POST", url: "/auth/login", payload: { username: "x", password: INCORRECTA } });
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe("RATE_LIMIT_EXCEEDED");
    } finally {
      await limitado.close();
    }
  });
});

describe("las garantías de sesión del login se conservan", () => {
  it("un login correcto crea una sola sesión con su token y su `sid`, y reinicia el contador", async () => {
    const usuario = await createUser({ username: "con_sesion", roleNames: ["swimmer"] });
    await prisma.user.update({ where: { id: usuario.id }, data: { failedLoginAttempts: 3 } });

    const res = await http("con_sesion", TEST_PASSWORD);

    expect(res.statusCode).toBe(200);
    expect(await sesiones()).toBe(1);
    expect(await prisma.refreshToken.count({ where: { userId: usuario.id, revokedAt: null } })).toBe(1);
    const c = await cuenta("con_sesion");
    expect(c.failedLoginAttempts).toBe(0);
    expect(c.lastLoginAt).not.toBeNull();
  });

  it("contraseña incorrecta: el limitador cuenta el intento y se audita, sin sesión", async () => {
    const usuario = await createUser({ username: "falla", roleNames: ["swimmer"] });

    await http("falla", INCORRECTA);

    expect((await cuenta("falla")).failedLoginAttempts, "C-02: RB-15 ya no escribe en la cuenta").toBe(0);
    expect(await prisma.limFalloPar.count({ where: { verificado: true } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_FAILED", entityId: usuario.id } })).toBe(1);
    expect(await sesiones()).toBe(0);
  });
});

/**
 * REGRESIÓN — personas bloqueadas o inhabilitadas POR EL SISTEMA.
 *
 * `personsService.blockPerson` / `disablePerson` cambian `persons.status` Y `users.status` de
 * la cuenta vinculada, y cortan sus sesiones. Ese es el estado administrativo HABITUAL de una
 * cuenta de persona, y el login debe darle el motivo (solo con la contraseña vigente correcta).
 * Las pruebas de la matriz de arriba usan cuentas sin `personId` y no pasan por este flujo: el
 * rechazo por el estado de la persona, que ocurría ANTES de comprobar la contraseña, nunca las
 * alcanzaba.
 *
 * Distinto de una INCOHERENCIA entre persona y cuenta (cuenta activa con persona inhabilitada,
 * estados que no se corresponden, persona eliminada): esas siguen dando el 401 genérico.
 */
describe("personas bloqueadas o inhabilitadas por el sistema (flujo real con cuenta vinculada)", () => {
  const MOTIVO_BLOQUEO = "Cuenta bloqueada por un administrador. Contacte al administrador.";
  const MOTIVO_INHABILITADA = "Cuenta inhabilitada. Contacte al administrador.";
  const ACTOR_IP = "127.0.0.1";

  /** Una persona con su cuenta de acceso vinculada (como las crea el sistema) y quien administra. */
  async function montar(username = "titular") {
    const persona = await createPerson({ run: "92100001", username, firstName: "Ana", gender: "female" });
    const usuario = await createUser({ username, roleNames: ["swimmer"], personId: persona.id });
    const admin = await createUser({ username: "quien_administra", roleNames: ["admin"] });
    return { persona, usuario, actor: { userId: admin.id, ipAddress: ACTOR_IP } };
  }

  const casos: Array<["blockPerson" | "disablePerson", "locked" | "disabled", string]> = [
    ["blockPerson", "locked", MOTIVO_BLOQUEO],
    ["disablePerson", "disabled", MOTIVO_INHABILITADA],
  ];

  describe.each(casos)("%s", (operacion, estado, motivo) => {
    it("contraseña vigente correcta: 401 con el motivo; ningún rechazo emite cookie ni sesión", async () => {
      const { persona, actor } = await montar();
      await personsService[operacion](persona.id, actor);
      // El flujo real dejó persona y cuenta con el mismo estado administrativo.
      expect((await prisma.person.findUniqueOrThrow({ where: { id: persona.id } })).status).toBe(estado);
      expect((await cuenta("titular")).status).toBe(estado);

      const res = await http("titular", TEST_PASSWORD);

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "UNAUTHORIZED", message: motivo });
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(await sesiones()).toBe(0);
    });

    it("contraseña incorrecta: 401 genérico, igual que un usuario inexistente; sin cookie ni sesión", async () => {
      const { persona, actor } = await montar();
      await personsService[operacion](persona.id, actor);

      const res = await http("titular", INCORRECTA);
      const inexistente = await http("no_existe", INCORRECTA);

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(GENERICO);
      expect(res.body).toBe(inexistente.body);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(await sesiones()).toBe(0);
    });

    it("el estado administrativo y la revocación de sesiones quedan intactos tras los intentos", async () => {
      const { persona, usuario, actor } = await montar();
      const antes = await http("titular", TEST_PASSWORD);
      expect(antes.statusCode, "antes de bloquear entra y crea una sesión").toBe(200);
      expect(await sesiones()).toBe(1);

      await personsService[operacion](persona.id, actor);
      const sesionRevocada = await prisma.refreshSession.findFirstOrThrow({ where: { userId: usuario.id } });
      expect(sesionRevocada.revokedAt, "el sistema cortó la sesión al bloquear").not.toBeNull();
      expect(sesionRevocada.revokedReason).toBe("admin_revocation");

      // Cada acierto perdona en su par los fallos anteriores (C-02), así que el par no se agota.
      for (let i = 0; i < PERFIL.parMaxFallos + 2; i++) {
        await http("titular", INCORRECTA);
        await http("titular", TEST_PASSWORD);
      }

      const p = await prisma.person.findUniqueOrThrow({ where: { id: persona.id } });
      expect(p.status).toBe(estado);
      const c = await cuenta("titular");
      expect(c.status).toBe(estado);
      expect(c.lockedUntil, "sigue siendo administrativo: nunca se convierte en temporal").toBeNull();
      expect(c.failedLoginAttempts).toBe(0);
      expect(await sesiones(), "ningún intento creó una sesión nueva").toBe(1);
      const despues = await prisma.refreshSession.findFirstOrThrow({ where: { userId: usuario.id } });
      expect(despues.id).toBe(sesionRevocada.id);
      expect(despues.revokedAt?.getTime()).toBe(sesionRevocada.revokedAt!.getTime());
      expect(despues.revokedReason).toBe("admin_revocation");
      expect(await prisma.refreshToken.count({ where: { userId: usuario.id, revokedAt: null } })).toBe(0);
    });

    it("tras reactivar a la persona, la contraseña correcta vuelve a entrar", async () => {
      const { persona, actor } = await montar();
      await personsService[operacion](persona.id, actor);
      expect((await http("titular", TEST_PASSWORD)).statusCode).toBe(401);

      await personsService.reactivatePerson(persona.id, actor);

      const res = await http("titular", TEST_PASSWORD);
      expect(res.statusCode).toBe(200);
      expect(await sesiones()).toBe(1);
    });

    it("el motivo solo se revela tras REVALIDAR la contraseña bajo bloqueo: si cambió mientras se verificaba, genérico", async () => {
      const { persona, usuario, actor } = await montar();
      await personsService[operacion](persona.id, actor);

      const original = argon2.verify;
      vi.spyOn(argon2, "verify").mockImplementation(async (...args: Parameters<typeof argon2.verify>) => {
        const coincide = await original(...args);
        // Entre la verificación y el bloqueo, alguien cambia la contraseña de la cuenta.
        await prisma.user.update({ where: { id: usuario.id }, data: { passwordHash: "$argon2id$cambiado-por-otro" } });
        return coincide;
      });

      const res = await http("titular", TEST_PASSWORD);

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(GENERICO);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(await sesiones()).toBe(0);
    });
  });

  describe("incoherencias entre persona y cuenta: la protección se conserva (siempre genérico, con cualquier contraseña)", () => {
    const intentar = async () => [await http("titular", TEST_PASSWORD), await http("titular", INCORRECTA)];

    const expectGenerico = async (respuestas: Awaited<ReturnType<typeof intentar>>) => {
      for (const r of respuestas) {
        expect(r.statusCode).toBe(401);
        expect(r.json()).toEqual(GENERICO);
        expect(r.headers["set-cookie"]).toBeUndefined();
      }
      expect(await sesiones()).toBe(0);
    };

    it("persona inhabilitada con la cuenta ACTIVA", async () => {
      const { persona } = await montar();
      await prisma.person.update({ where: { id: persona.id }, data: { status: "disabled" } });
      await expectGenerico(await intentar());
      expect((await cuenta("titular")).status, "no se toca la cuenta").toBe("active");
    });

    it("persona bloqueada con la cuenta ACTIVA", async () => {
      const { persona } = await montar();
      await prisma.person.update({ where: { id: persona.id }, data: { status: "locked" } });
      await expectGenerico(await intentar());
    });

    it("estados que no se corresponden: persona bloqueada y cuenta inhabilitada", async () => {
      const { persona, usuario } = await montar();
      await prisma.person.update({ where: { id: persona.id }, data: { status: "locked" } });
      await prisma.user.update({ where: { id: usuario.id }, data: { status: "disabled" } });
      await expectGenerico(await intentar());
    });

    it("estados que no se corresponden: persona inhabilitada y cuenta bloqueada por un administrador", async () => {
      const { persona, usuario } = await montar();
      await prisma.person.update({ where: { id: persona.id }, data: { status: "disabled" } });
      await prisma.user.update({ where: { id: usuario.id }, data: { status: "locked", lockedUntil: null } });
      await expectGenerico(await intentar());
    });

    it("persona bloqueada con la cuenta en bloqueo TEMPORAL (no administrativo), vigente o vencido", async () => {
      const { persona, usuario } = await montar();
      await prisma.person.update({ where: { id: persona.id }, data: { status: "locked" } });
      for (const lockedUntil of [new Date(Date.now() + HORA), new Date(Date.now() - 1000)]) {
        await prisma.user.update({ where: { id: usuario.id }, data: { status: "locked", lockedUntil } });
        await expectGenerico(await intentar());
        const c = await cuenta("titular");
        expect(c.status, "un bloqueo vencido no se levanta si la persona sigue sin estar activa").toBe("locked");
        expect(c.failedLoginAttempts).toBe(0);
      }
    });

    it("persona ELIMINADA, aunque su estado y el de la cuenta coincidan", async () => {
      const { persona, usuario } = await montar();
      await prisma.person.update({ where: { id: persona.id }, data: { status: "disabled", deletedAt: new Date() } });
      await prisma.user.update({ where: { id: usuario.id }, data: { status: "disabled", lockedUntil: null } });
      await expectGenerico(await intentar());
    });

    it("eliminación lógica real (softDeletePerson): genérico", async () => {
      const { persona, actor } = await montar();
      await personsService.softDeletePerson(persona.id, actor);
      await expectGenerico(await intentar());
    });
  });
});
