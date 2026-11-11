/**
 * C-02 — limitador de login (política B), contra los servicios y la API reales sobre la base
 * DESECHABLE. Solo datos sintéticos: direcciones de documentación (192.0.2.0/24,
 * 198.51.100.0/24, 203.0.113.0/24) y cuentas creadas por la prueba.
 *
 * Las ventanas de tiempo no se esperan: se desplazan las marcas temporales en la base.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { env } from "../src/shared/env";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createPerson, createUser, TEST_PASSWORD } from "./helpers/seedRbac";
import * as personsService from "../src/modules/persons/persons.service";
import * as limitador from "../src/modules/auth/limitadorLogin";
import { PERFIL, claveDe, type TipoDeClave } from "../src/modules/auth/limitadorClaves";
import { configurarSemaforoArgon2, estadoSemaforoArgon2 } from "../src/modules/auth/password.util";

const INCORRECTA = "ClaveIncorrecta1";
const MIN = 60_000;
const LIMITADO = { error: "LOGIN_THROTTLED", message: limitador.MENSAJE_LOGIN_LIMITADO };

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
  configurarSemaforoArgon2({ max: env.ARGON2_MAX_SIMULTANEAS, cola: env.ARGON2_MAX_EN_COLA, esperaMs: env.ARGON2_ESPERA_MAX_MS });
});

afterAll(async () => {
  await app.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

const login = (username: string, password: string, ip = "192.0.2.10") =>
  app.inject({ method: "POST", url: "/auth/login", payload: { username, password }, remoteAddress: ip });

/** La fila exacta de una clave, calculando su HMAC con el secreto de pruebas. */
const fila = (tipo: TipoDeClave, ...valores: string[]) =>
  prisma.limClave.findFirst({ where: { tipo, claveHmac: claveDe(env.AUTH_LIMITER_SECRET, tipo, valores) } });
const filaDeOrigen = (ip: string) => fila("origen", `4:${ip}`);
const filaDeCuenta = (username: string) => fila("cuenta", username);
const filaDePar = (username: string, ip: string) => fila("par", username, `4:${ip}`);
const intento = (username: string, ip: string) => ({ username, origen: `4:${ip}`, ip });

async function fallosDelPar(username: string, ip: string) {
  const par = await filaDePar(username, ip);
  return par ? prisma.limFalloPar.count({ where: { parId: par.id } }) : 0;
}

function diferido<T>() {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((res) => (resolver = res));
  return { promesa, resolver };
}

describe("par usuario–origen: 5 fallos en 15 min, ventana deslizante", () => {
  it("el sexto intento recibe el 429 uniforme sin calcular Argon2, y vuelve a admitirse al salir de la ventana", async () => {
    await createUser({ username: "ana", roleNames: ["swimmer"] });
    for (let i = 0; i < PERFIL.parMaxFallos; i++) expect((await login("ana", INCORRECTA)).statusCode).toBe(401);

    const verificar = vi.spyOn(argon2, "verify");
    const sexto = await login("ana", TEST_PASSWORD);
    expect(sexto.statusCode).toBe(429);
    expect(sexto.json()).toEqual(LIMITADO);
    expect(verificar, "un rechazo no verifica nada").not.toHaveBeenCalled();

    // Desliza la ventana: los cinco fallos pasan a tener más de 15 min.
    const par = (await filaDePar("ana", "192.0.2.10"))!;
    await prisma.limFalloPar.updateMany({ where: { parId: par.id }, data: { creadoEn: new Date(Date.now() - 16 * MIN) } });
    expect((await login("ana", TEST_PASSWORD)).statusCode).toBe(200);
  });

  it("un usuario inexistente recibe exactamente el mismo 429", async () => {
    await createUser({ username: "existe", roleNames: ["swimmer"] });
    for (let i = 0; i < PERFIL.parMaxFallos; i++) {
      await login("existe", INCORRECTA);
      await login("no_existe", INCORRECTA);
    }
    const a = await login("existe", INCORRECTA);
    const b = await login("no_existe", INCORRECTA);
    expect(a.statusCode).toBe(429);
    expect(b.statusCode).toBe(429);
    expect(a.body).toBe(b.body);
  });

  it("otro origen tiene su propio par y entra", async () => {
    await createUser({ username: "beto", roleNames: ["swimmer"] });
    for (let i = 0; i < PERFIL.parMaxFallos; i++) await login("beto", INCORRECTA, "192.0.2.10");
    expect((await login("beto", TEST_PASSWORD, "192.0.2.10")).statusCode).toBe(429);
    expect((await login("beto", TEST_PASSWORD, "198.51.100.7")).statusCode).toBe(200);
    expect((await prisma.user.findFirstOrThrow({ where: { username: "beto" } })).status).toBe("active");
  });
});

describe("origen: 50 fallos por ventana fija de 1 h", () => {
  it("al llegar a 50 rechaza cualquier cuenta desde ese origen; otro origen sigue; la ventana nueva lo libera", async () => {
    await login("u1", INCORRECTA, "203.0.113.5");
    const origen = (await filaDeOrigen("203.0.113.5"))!;
    await prisma.limClave.update({ where: { id: origen.id }, data: { fallos: PERFIL.origenMaxFallos - 1 } });

    expect((await login("u2", INCORRECTA, "203.0.113.5")).statusCode, "el 50.º fallo todavía se admite").toBe(401);
    expect((await login("u3", INCORRECTA, "203.0.113.5")).json()).toEqual(LIMITADO);
    expect((await login("u3", INCORRECTA, "203.0.113.6")).statusCode, "otro origen").toBe(401);

    // Ventana FIJA: cuando vence, se abre una nueva con el siguiente fallo.
    await prisma.limClave.update({ where: { id: origen.id }, data: { ventanaInicio: new Date(Date.now() - 61 * MIN) } });
    expect((await login("u3", INCORRECTA, "203.0.113.5")).statusCode).toBe(401);
    expect((await filaDeOrigen("203.0.113.5"))!.fallos, "la ventana nueva empieza en 1").toBe(1);
  });
});

describe("cuenta: periodo protegido y política B", () => {
  it("20 fallos verificados lo activan; cada par espera SU propia 15 min; otros orígenes no la prolongan", async () => {
    const usuario = await createUser({ username: "victima", roleNames: ["swimmer"] });
    const abierta = await login("victima", TEST_PASSWORD, "192.0.2.200");
    expect(abierta.statusCode).toBe(200);

    await login("victima", INCORRECTA, "198.51.100.1");
    const cuenta = (await filaDeCuenta("victima"))!;
    await prisma.limClave.update({ where: { id: cuenta.id }, data: { fallos: PERFIL.cuentaUmbralProteccion - 1, ventanaInicio: new Date() } });

    // El fallo verificado número 20 (desde O2) activa la protección.
    expect((await login("victima", INCORRECTA, "198.51.100.2")).statusCode).toBe(401);
    const protegida = (await filaDeCuenta("victima"))!;
    expect(protegida.protegidoDesde).not.toBeNull();
    expect(protegida.protegidoHasta!.getTime()).toBeGreaterThan(Date.now() + 55 * MIN);
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_PROTECTION_STARTED" } })).toBe(1);

    // Durante la protección, un fallo de un par impone a ESE par su espera de 15 min.
    expect((await login("victima", TEST_PASSWORD, "198.51.100.2")).json(), "O2 espera").toEqual(LIMITADO);
    // Otro origen tiene su intento; su fallo prolonga el periodo pero no cambia `desde`.
    expect((await login("victima", INCORRECTA, "198.51.100.3")).statusCode).toBe(401);
    const prolongada = (await filaDeCuenta("victima"))!;
    expect(prolongada.protegidoDesde!.getTime()).toBe(protegida.protegidoDesde!.getTime());
    expect(prolongada.protegidoHasta!.getTime()).toBeGreaterThanOrEqual(protegida.protegidoHasta!.getTime());
    expect((await login("victima", TEST_PASSWORD, "198.51.100.3")).statusCode, "O3 ahora espera").toBe(429);

    // La víctima entra desde una red sin fallos, y su sesión abierta sigue operando.
    expect((await login("victima", TEST_PASSWORD, "198.51.100.4")).statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${abierta.json().accessToken}` } });
    expect(me.statusCode).toBe(200);

    // Política B: pasados 15 min desde SU fallo, O2 vuelve a tener un intento aunque O3 fallara después.
    const parO2 = (await filaDePar("victima", "198.51.100.2"))!;
    const antes = new Date(Date.now() - 16 * MIN);
    await prisma.limClave.update({ where: { id: parO2.id }, data: { ultimoFalloEn: antes } });
    await prisma.limFalloPar.updateMany({ where: { parId: parO2.id }, data: { creadoEn: antes } });
    expect((await login("victima", TEST_PASSWORD, "198.51.100.2")).statusCode).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } })).status, "la cuenta nunca se bloquea").toBe("active");
  });
});

describe("reservas: perdón por orden, vencidas y concurrencia", () => {
  it("un acierto perdona los fallos ANTERIORES del par aunque se liquiden después; nunca los posteriores", async () => {
    const a = await limitador.admitir(intento("orden", "192.0.2.30"));
    const b = await limitador.admitir(intento("orden", "192.0.2.30"));
    expect(await limitador.liquidar(b, "acierto")).toBe("aplicada");
    expect(await limitador.liquidar(a, "fallo")).toBe("aplicada");
    expect(await fallosDelPar("orden", "192.0.2.30"), "A (anterior a B) quedó perdonado en el par").toBe(0);
    expect((await filaDeOrigen("192.0.2.30"))!.fallos, "el origen sí lo cuenta").toBe(1);
    expect((await filaDeCuenta("orden"))!.fallos, "la cuenta también").toBe(1);

    const c = await limitador.admitir(intento("orden", "192.0.2.30"));
    expect(await limitador.liquidar(c, "fallo")).toBe("aplicada");
    expect(await fallosDelPar("orden", "192.0.2.30"), "C es posterior al acierto: cuenta").toBe(1);
  });

  it("una reserva vencida sigue ocupando presupuesto, se cobra una sola vez y su liquidación tardía es obsoleta", async () => {
    const a = await limitador.admitir(intento("vence", "192.0.2.40"));
    await prisma.limReserva.updateMany({ where: { token: a.token }, data: { reservaHasta: new Date(Date.now() - 1000) } });

    // Otro intento del mismo par antes del barrido: convierte la vencida en fallo no verificado.
    const b = await limitador.admitir(intento("vence", "192.0.2.40"));
    expect(await prisma.limFalloPar.count({ where: { verificado: false } })).toBe(1);
    expect((await filaDeOrigen("192.0.2.40"))!.fallos).toBe(1);

    // La liquidación antigua llega después: obsoleta, sin efectos (ni cobro doble ni perdón).
    expect(await limitador.liquidar(a, "acierto")).toBe("obsoleta");
    expect(await limitador.liquidar(a, "fallo")).toBe("obsoleta");
    expect(await prisma.limFalloPar.count()).toBe(1);
    expect((await filaDeOrigen("192.0.2.40"))!.fallos).toBe(1);

    expect(await limitador.liquidar(b, "neutro")).toBe("aplicada");
    expect((await prisma.limCapacidad.findUniqueOrThrow({ where: { recurso: "reservas" } })).usadas).toBe(0);
  });

  it("la vencida de OTRO par del mismo origen sigue contando hasta que el barrido la cobra", async () => {
    const a = await limitador.admitir(intento("p1", "192.0.2.41"));
    await prisma.limReserva.updateMany({ where: { token: a.token }, data: { reservaHasta: new Date(Date.now() - 1000) } });
    const b = await limitador.admitir(intento("p2", "192.0.2.41"));
    expect(await prisma.limReserva.count({ where: { token: a.token } }), "no se convirtió: no es de este par").toBe(1);

    expect(await limitador.barrer()).toBe(1);
    expect(await prisma.limReserva.count({ where: { token: a.token } })).toBe(0);
    expect((await filaDeOrigen("192.0.2.41"))!.fallos).toBe(1);
    expect(await limitador.liquidar(a, "fallo"), "sin cobro doble").toBe("obsoleta");
    expect((await filaDeOrigen("192.0.2.41"))!.fallos).toBe(1);
    await limitador.liquidar(b, "neutro");
  });

  it("admisiones simultáneas del mismo par no superan su presupuesto", async () => {
    for (let i = 0; i < PERFIL.parMaxFallos - 1; i++) await login("concurrente", INCORRECTA, "192.0.2.50");
    const resultados = await Promise.allSettled(Array.from({ length: 10 }, () => limitador.admitir(intento("concurrente", "192.0.2.50"))));
    const admitidas = resultados.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<limitador.Admision>[];
    expect(admitidas).toHaveLength(1);
    expect(resultados.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof limitador.LoginLimitadoError)).toBe(true);
    for (const r of admitidas) await limitador.liquidar(r.value, "neutro");
  });
});

describe("restablecimiento de credenciales", () => {
  it("borra cuenta y pares, anula las reservas en curso y no devuelve presupuesto al origen", async () => {
    const persona = await createPerson({ run: "93000001", username: "titular_reset", firstName: "Rosa", gender: "female" });
    await createUser({ username: "titular_reset", roleNames: ["swimmer"], personId: persona.id });
    const admin = await createUser({ username: "admin_reset", roleNames: ["admin"] });
    await login("titular_reset", INCORRECTA, "192.0.2.60");
    await login("titular_reset", INCORRECTA, "192.0.2.60");
    const enCurso = await limitador.admitir(intento("titular_reset", "192.0.2.60"));
    const enCurso2 = await limitador.admitir(intento("titular_reset", "192.0.2.60"));
    const origenAntes = (await filaDeOrigen("192.0.2.60"))!.fallos;

    await personsService.resetCredentials(persona.id, { userId: admin.id, ipAddress: "127.0.0.1" });

    expect(await filaDeCuenta("titular_reset")).toBeNull();
    expect(await filaDePar("titular_reset", "192.0.2.60")).toBeNull();
    const anulada = await prisma.limReserva.findUniqueOrThrow({ where: { token: enCurso.token } });
    expect(anulada).toMatchObject({ anulada: true, cuentaId: null, parId: null });
    expect((await filaDeOrigen("192.0.2.60"))!.fallos, "el origen no se toca").toBe(origenAntes);

    expect(await limitador.liquidar(enCurso, "fallo"), "solo cuenta en el origen").toBe("anulada");
    expect((await filaDeOrigen("192.0.2.60"))!.fallos).toBe(origenAntes + 1);
    expect(await limitador.liquidar(enCurso2, "acierto"), "un acierto anulado tampoco produce efectos").toBe("anulada");
    expect(await filaDeCuenta("titular_reset"), "no recrea la cuenta").toBeNull();
  });
});

describe("capacidad atómica", () => {
  it("sin cupo para claves nuevas: 503 sin Argon2; las claves existentes conservan sus límites", async () => {
    await createUser({ username: "con_fila", roleNames: ["swimmer"] });
    expect((await login("con_fila", INCORRECTA, "192.0.2.70")).statusCode).toBe(401);
    await prisma.$executeRaw`UPDATE lim_capacidad SET cupo = usadas WHERE recurso LIKE 'claves:%'`;

    const verificar = vi.spyOn(argon2, "verify");
    const nueva = await login("sin_fila", INCORRECTA, "192.0.2.70");
    expect(nueva.statusCode).toBe(503);
    expect(verificar, "un intento que no se puede contar no se verifica").not.toHaveBeenCalled();
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_LIMITER_SATURATED" } })).toBeLessThanOrEqual(1);

    expect((await login("con_fila", TEST_PASSWORD, "192.0.2.70")).statusCode, "la clave existente sigue").toBe(200);
  });

  it("sin cupo de reservas: 503 para todos, sin verificar", async () => {
    await createUser({ username: "res", roleNames: ["swimmer"] });
    await login("res", INCORRECTA, "192.0.2.71");
    await prisma.$executeRaw`UPDATE lim_capacidad SET cupo = 0 WHERE recurso = 'reservas'`;
    const verificar = vi.spyOn(argon2, "verify");
    expect((await login("res", TEST_PASSWORD, "192.0.2.71")).statusCode).toBe(503);
    expect(verificar).not.toHaveBeenCalled();
  });

  it("purga por tiempo y relaciones, y la reconciliación corrige `usadas`", async () => {
    await login("viejo", INCORRECTA, "192.0.2.80");
    const pendiente = await limitador.admitir(intento("pendiente", "192.0.2.80"));
    await prisma.limClave.updateMany({ data: { venceEn: new Date(Date.now() - MIN) } });
    await prisma.limFalloPar.updateMany({ data: { creadoEn: new Date(Date.now() - 20 * MIN) } });

    const borradas = await limitador.purgar();
    expect(borradas, "par y cuenta de `viejo`").toBe(2);
    expect(await filaDePar("viejo", "192.0.2.80")).toBeNull();
    expect(await filaDeCuenta("viejo")).toBeNull();
    expect(await filaDePar("pendiente", "192.0.2.80"), "con reserva: no se purga").not.toBeNull();
    expect(await filaDeCuenta("pendiente"), "con pares: no se purga").not.toBeNull();
    expect(await filaDeOrigen("192.0.2.80"), "con reserva: no se purga").not.toBeNull();
    expect(await limitador.reconciliarCapacidad(), "la capacidad ya cuadraba").toEqual([]);

    await prisma.$executeRaw`UPDATE lim_capacidad SET usadas = 0`;
    expect((await limitador.reconciliarCapacidad()).length).toBeGreaterThan(0);
    const claves = await prisma.limClave.count();
    const usadas = await prisma.limCapacidad.aggregate({ _sum: { usadas: true }, where: { recurso: { startsWith: "claves:" } } });
    expect(usadas._sum.usadas).toBe(claves);
    await limitador.liquidar(pendiente, "neutro");
  });
});

describe("auditoría agregada de rechazos", () => {
  it("un aviso como mucho cada 15 min por clave, con el recuento acumulado", async () => {
    for (let i = 0; i < PERFIL.parMaxFallos; i++) await login("ruido", INCORRECTA, "192.0.2.90");
    for (let i = 0; i < 3; i++) expect((await login("ruido", INCORRECTA, "192.0.2.90")).statusCode).toBe(429);
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_THROTTLED" } })).toBe(1);

    const par = (await filaDePar("ruido", "192.0.2.90"))!;
    await prisma.limClave.update({ where: { id: par.id }, data: { rechazoAvisadoEn: new Date(Date.now() - 16 * MIN) } });
    await login("ruido", INCORRECTA, "192.0.2.90");
    const avisos = await prisma.auditLog.findMany({ where: { action: "LOGIN_THROTTLED" }, orderBy: { createdAt: "asc" } });
    expect(avisos).toHaveLength(2);
    expect(avisos[1]!.after).toMatchObject({ capa: "par", rechazos: 3 });
    expect(avisos[1]!.ipAddress, "la auditoría conserva la IP completa").toBe("192.0.2.90");
  });
});

describe("Argon2: saturación y errores técnicos no son contraseñas incorrectas", () => {
  it("con el semáforo lleno el login recibe 503, sin contar un fallo y liberando la reserva", async () => {
    await createUser({ username: "sat1", roleNames: ["swimmer"] });
    await createUser({ username: "sat2", roleNames: ["swimmer"] });
    configurarSemaforoArgon2({ max: 1, cola: 0, esperaMs: 1_000 });
    const bloqueo = diferido<boolean>();
    vi.spyOn(argon2, "verify").mockImplementationOnce(() => bloqueo.promesa);

    const primera = login("sat1", INCORRECTA, "192.0.2.100");
    while (estadoSemaforoArgon2().enCurso === 0) await new Promise((r) => setTimeout(r, 10));
    const segunda = await login("sat2", INCORRECTA, "192.0.2.101");
    expect(segunda.statusCode).toBe(503);
    expect(await fallosDelPar("sat2", "192.0.2.101")).toBe(0);
    expect(await prisma.limReserva.count({ where: { origenId: (await filaDeOrigen("192.0.2.101"))!.id } })).toBe(0);

    bloqueo.resolver(false);
    expect((await primera).statusCode).toBe(401);
  });

  it("una excepción de argon2.verify en el login es 503 y no cuenta", async () => {
    await createUser({ username: "tecnico", roleNames: ["swimmer"] });
    vi.spyOn(argon2, "verify").mockRejectedValueOnce(new Error("fallo nativo sintético"));
    const res = await login("tecnico", INCORRECTA, "192.0.2.110");
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("fallo nativo");
    expect(await fallosDelPar("tecnico", "192.0.2.110")).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_FAILED" } })).toBe(0);
  });

  it("C-04 (corrección): una excepción de argon2.verify NO suma un intento ni termina la sesión", async () => {
    await createUser({ username: "c04", roleNames: ["swimmer"], mustChangePassword: false });
    const entrada = await login("c04", TEST_PASSWORD, "192.0.2.120");
    const token = entrada.json().accessToken as string;
    const sid = (jwt.decode(token) as { sid: string }).sid;
    const cambio = (actual: string) =>
      app.inject({
        method: "POST",
        url: "/auth/change-password",
        headers: { authorization: `Bearer ${token}` },
        payload: { currentPassword: actual, newPassword: "ClaveNuevaSintetica9", confirmPassword: "ClaveNuevaSintetica9" },
      });

    vi.spyOn(argon2, "verify").mockRejectedValueOnce(new Error("fallo nativo sintético"));
    const res = await cambio(INCORRECTA);
    expect(res.statusCode).toBe(503);
    const sesion = await prisma.refreshSession.findUniqueOrThrow({ where: { id: sid } });
    expect(sesion.passwordChangeFailures).toBe(0);
    expect(sesion.revokedAt).toBeNull();
    expect(sesion.passwordChangeReservation, "la reserva quedó libre").toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "PASSWORD_CHANGE_FAILED" } })).toBe(0);

    // La política de C-04 sigue igual: una contraseña actual incorrecta SÍ cuenta.
    expect((await cambio(INCORRECTA)).statusCode).toBe(400);
    expect((await prisma.refreshSession.findUniqueOrThrow({ where: { id: sid } })).passwordChangeFailures).toBe(1);
  });
});

describe("validación persistente del secreto", () => {
  it("un proceso con otro secreto se niega a arrancar, sin borrar ni reiniciar contadores", async () => {
    await limitador.verificarConfiguracionDelLimitador(env.AUTH_LIMITER_SECRET);
    await login("cualquiera", INCORRECTA, "192.0.2.130");
    const antes = await prisma.limClave.count();

    const otro = "otro-secreto-sintetico-de-al-menos-treinta-y-dos-caracteres";
    await expect(limitador.verificarConfiguracionDelLimitador(otro)).rejects.toThrow(/AUTH_LIMITER_SECRET/);
    const distinto = await buildServer({ ...env, AUTH_LIMITER_SECRET: otro });
    try {
      await expect(distinto.ready()).rejects.toThrow(/AUTH_LIMITER_SECRET/);
    } finally {
      await distinto.close().catch(() => undefined);
      limitador.configurarLimitador(env.AUTH_LIMITER_SECRET);
    }
    expect(await prisma.limClave.count()).toBe(antes);
    expect(await prisma.limConfiguracion.count()).toBe(1);
  });
});

describe("límites en memoria de /auth/*: presupuestos separados", () => {
  it("los logins agotan su presupuesto sin consumir el de las operaciones de sesión", async () => {
    const limitado = await buildServer({ ...env, RATE_LIMIT_AUTH_MAX: 2, RATE_LIMIT_SESION_MAX: 3 });
    await limitado.ready();
    try {
      const intentar = () => limitado.inject({ method: "POST", url: "/auth/login", payload: { username: "x", password: INCORRECTA }, remoteAddress: "192.0.2.140" });
      const csrf = () => limitado.inject({ method: "GET", url: "/auth/csrf", remoteAddress: "192.0.2.140" });
      await intentar();
      await intentar();
      const tercero = await intentar();
      expect(tercero.statusCode).toBe(429);
      expect(tercero.json().error).toBe("RATE_LIMIT_EXCEEDED");
      for (let i = 0; i < 3; i++) expect((await csrf()).statusCode, "la renovación conserva su presupuesto").toBe(200);
      expect((await csrf()).statusCode, "y tiene su propio tope").toBe(429);
    } finally {
      await limitado.close();
      limitador.configurarLimitador(env.AUTH_LIMITER_SECRET);
    }
  });
});
