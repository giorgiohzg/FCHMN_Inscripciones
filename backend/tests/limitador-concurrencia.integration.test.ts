/**
 * C-02 — rechazo temprano por origen, concurrencia y atomicidad del limitador, y C-04 con la
 * contraseña actual CORRECTA. Contra los servicios y la API reales, sobre la base DESECHABLE.
 *
 * MÉTODO de los solapamientos, sin esperas arbitrarias ni ganchos en el código: una conexión
 * `pg` independiente RETIENE una fila de `lim_capacidad` que una de las operaciones tiene que
 * actualizar al final de su transacción (L7). Esa operación queda detenida con todo lo demás
 * hecho y SIN confirmar; la otra se lanza entonces y también se detiene. Cada espera se
 * CONFIRMA en `pg_stat_activity` (backends esperando un cerrojo) antes de seguir, así que el
 * intercalado es el que la prueba declara. Las transacciones del limitador tienen
 * `lock_timeout = 2s`: la retención se suelta en cuanto la cola está confirmada.
 *
 * Solo datos sintéticos (direcciones de documentación y cuentas creadas por la prueba).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { Client } from "pg";
import { AsyncResource } from "node:async_hooks";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { env } from "../src/shared/env";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createPerson, createUser, TEST_PASSWORD } from "./helpers/seedRbac";
import * as personsService from "../src/modules/persons/persons.service";
import * as limitador from "../src/modules/auth/limitadorLogin";
import { PERFIL, claveDe, clavesDeIntento, fragmentoDe, recursoDeFragmento, type TipoDeClave } from "../src/modules/auth/limitadorClaves";
import { configurarSemaforoArgon2, conArgon2, estadoSemaforoArgon2 } from "../src/modules/auth/password.util";

const INCORRECTA = "ClaveIncorrecta1";
const MIN = 60_000;
const LIMITADO = { error: "LOGIN_THROTTLED", message: limitador.MENSAJE_LOGIN_LIMITADO };

let app: FastifyInstance;
let observador: Client;
const conexiones: Client[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  observador = await abrirConexion();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  // Las filas de capacidad deben existir para poder retenerlas.
  await limitador.asegurarCapacidad();
});

afterEach(() => {
  vi.restoreAllMocks();
  configurarSemaforoArgon2({ max: env.ARGON2_MAX_SIMULTANEAS, cola: env.ARGON2_MAX_EN_COLA, esperaMs: env.ARGON2_ESPERA_MAX_MS });
});

afterAll(async () => {
  await Promise.all(conexiones.map((c) => c.end().catch(() => undefined)));
  await app.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function abrirConexion(): Promise<Client> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  conexiones.push(c);
  return c;
}

/** Retiene una fila de `lim_capacidad` en una transacción abierta de otra conexión. */
async function retenerCapacidad(recurso: string): Promise<Client> {
  const c = await abrirConexion();
  await c.query("BEGIN");
  const r = await c.query("SELECT recurso FROM lim_capacidad WHERE recurso = $1 FOR UPDATE", [recurso]);
  expect(r.rowCount, `la fila ${recurso} existe`).toBe(1);
  return c;
}

/** Espera a que haya exactamente `n` backends detenidos por un cerrojo (confirmación del motor). */
async function enCola(n: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const { rows } = await observador.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    );
    if (rows[0]!.n === n) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`No se llegó a ${n} operaciones esperando un cerrojo`);
}

const desenlace = <T>(p: Promise<T>) =>
  p.then(
    (valor) => ({ ok: true as const, valor }),
    (error: unknown) => ({ ok: false as const, error })
  );

const login = (username: string, password: string, ip: string) =>
  app.inject({ method: "POST", url: "/auth/login", payload: { username, password }, remoteAddress: ip });

const intento = (username: string, ip: string) => ({ username, origen: `4:${ip}`, ip });
const clavesDe = (username: string, ip: string) => clavesDeIntento(env.AUTH_LIMITER_SECRET, username, `4:${ip}`);
const fila = (tipo: TipoDeClave, ...valores: string[]) =>
  prisma.limClave.findFirst({ where: { tipo, claveHmac: claveDe(env.AUTH_LIMITER_SECRET, tipo, valores) } });
const filaDeOrigen = (ip: string) => fila("origen", `4:${ip}`);
const filaDeCuenta = (username: string) => fila("cuenta", username);
const filaDePar = (username: string, ip: string) => fila("par", username, `4:${ip}`);
const clavesDeCuentaYPar = () => prisma.limClave.count({ where: { tipo: { in: ["cuenta", "par"] } } });

/**
 * La capacidad CUADRA con lo que hay: cada fragmento usa tantas plazas como claves tiene, y
 * `reservas` tantas como reservas vivas. Se comprueba sin reconciliar nada.
 */
async function expectCapacidadCuadra() {
  const claves = await prisma.$queryRaw<{ fragmento: number; n: number }[]>`
    SELECT fragmento, count(*)::int AS n FROM lim_clave GROUP BY fragmento`;
  const reales = new Map(claves.map((c) => [recursoDeFragmento(c.fragmento), c.n]));
  reales.set("reservas", await prisma.limReserva.count());
  for (const f of await prisma.limCapacidad.findMany()) {
    expect(f.usadas, `capacidad de ${f.recurso}`).toBe(reales.get(f.recurso) ?? 0);
  }
}

function diferido<T = void>() {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((res) => (resolver = res));
  return { promesa, resolver };
}

// ---------------------------------------------------------------------------
// 1. Rechazo temprano por origen
// ---------------------------------------------------------------------------

describe("origen agotado: rechazo temprano", () => {
  it("nombres nuevos desde un origen agotado reciben 429 sin crear cuentas, pares ni reservas, y sin Argon2", async () => {
    const IP = "203.0.113.20";
    await login("semilla", INCORRECTA, IP);
    const origen = (await filaDeOrigen(IP))!;
    await prisma.limClave.update({ where: { id: origen.id }, data: { fallos: PERFIL.origenMaxFallos, ventanaInicio: new Date() } });

    const clavesAntes = await clavesDeCuentaYPar();
    const capacidadAntes = await prisma.limCapacidad.findMany({ orderBy: { recurso: "asc" } });
    const verificar = vi.spyOn(argon2, "verify");
    const hashear = vi.spyOn(argon2, "hash");

    for (const nombre of ["nuevo_a", "nuevo_b", "nuevo_c", "nuevo_d", "nuevo_e"]) {
      const res = await login(nombre, TEST_PASSWORD, IP);
      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual(LIMITADO);
    }

    expect(await clavesDeCuentaYPar(), "ninguna cuenta ni par nuevos").toBe(clavesAntes);
    expect(await filaDeCuenta("nuevo_a")).toBeNull();
    expect(await filaDePar("nuevo_a", IP)).toBeNull();
    expect(await prisma.limReserva.count(), "ninguna reserva").toBe(0);
    expect(await prisma.limCapacidad.findMany({ orderBy: { recurso: "asc" } }), "capacidad intacta").toEqual(capacidadAntes);
    expect(verificar, "un rechazo no verifica").not.toHaveBeenCalled();
    expect(hashear, "ni calcula el hash ficticio").not.toHaveBeenCalled();
    // Rechazos agregados en el ORIGEN: un aviso y los cuatro siguientes acumulados.
    expect((await filaDeOrigen(IP))!.rechazos).toBe(4);
    expect(await prisma.auditLog.findMany({ where: { action: "LOGIN_THROTTLED" }, select: { after: true } })).toEqual([
      { after: { capa: "origen", rechazos: 1 } },
    ]);
    await expectCapacidadCuadra();
  });

  it("las reservas pendientes del origen siguen contando para su presupuesto", async () => {
    const IP = "203.0.113.21";
    await login("semilla", INCORRECTA, IP);
    const origen = (await filaDeOrigen(IP))!;
    await prisma.limClave.update({ where: { id: origen.id }, data: { fallos: PERFIL.origenMaxFallos - 1, ventanaInicio: new Date() } });

    const pendiente = await limitador.admitir(intento("pendiente", IP)); // 49 fallos + 1 reserva = 50
    const clavesAntes = await clavesDeCuentaYPar();
    await expect(limitador.admitir(intento("otro_nombre", IP))).rejects.toBeInstanceOf(limitador.LoginLimitadoError);
    expect(await clavesDeCuentaYPar()).toBe(clavesAntes);

    expect(await limitador.liquidar(pendiente, "neutro")).toBe("aplicada");
    const admitida = await limitador.admitir(intento("otro_nombre", IP));
    expect(await limitador.liquidar(admitida, "neutro")).toBe("aplicada");
    await expectCapacidadCuadra();
  });
});

// ---------------------------------------------------------------------------
// 2. Concurrencia y atomicidad
// ---------------------------------------------------------------------------

describe("cupo de reservas con una sola plaza", () => {
  it("de cuatro admisiones solapadas con claves distintas solo una la obtiene; las demás no dejan nada", async () => {
    await prisma.limCapacidad.update({ where: { recurso: "reservas" }, data: { cupo: 1 } });
    const retencion = await retenerCapacidad("reservas");

    const intentos = [0, 1, 2, 3].map((i) => desenlace(limitador.admitir(intento(`plaza_${i}`, `192.0.2.${150 + i}`))));
    await enCola(4); // las cuatro llegaron a L7 con sus claves creadas y sin confirmar
    await retencion.query("COMMIT");
    const resultados = await Promise.all(intentos);

    const admitidas = resultados.filter((r) => r.ok);
    expect(admitidas, "una sola plaza").toHaveLength(1);
    for (const r of resultados.filter((x) => !x.ok)) {
      expect((r as { error: { statusCode?: number } }).error.statusCode, "sin plaza: 503").toBe(503);
    }
    expect(await prisma.limReserva.count()).toBe(1);
    expect((await prisma.limCapacidad.findUniqueOrThrow({ where: { recurso: "reservas" } })).usadas).toBe(1);
    expect(await prisma.limClave.count(), "solo las tres claves de la admitida: las otras se revirtieron enteras").toBe(3);
    await expectCapacidadCuadra();

    const ganadora = admitidas[0] as { valor: limitador.Admision };
    expect(await limitador.liquidar(ganadora.valor, "neutro")).toBe("aplicada");
    await expectCapacidadCuadra();
  });
});

describe("admisión frente a purga", () => {
  async function clavesVencidas(username: string, ip: string) {
    const a = await limitador.admitir(intento(username, ip));
    expect(await limitador.liquidar(a, "fallo")).toBe("aplicada");
    await prisma.limClave.updateMany({ data: { venceEn: new Date(Date.now() - MIN) } });
    await prisma.limFalloPar.updateMany({ data: { creadoEn: new Date(Date.now() - 20 * MIN) } });
  }

  it("la purga borra primero: la admisión espera, recrea las claves y nada queda huérfano", async () => {
    const IP = "192.0.2.160";
    await clavesVencidas("purgado", IP);
    const retencion = await retenerCapacidad(recursoDeFragmento(fragmentoDe(clavesDe("purgado", IP).par)));

    const purga = desenlace(limitador.purgar());
    await enCola(1); // la purga borró las tres claves y espera L7, sin confirmar
    const admision = desenlace(limitador.admitir(intento("purgado", IP)));
    await enCola(2); // la admisión espera las filas que la purga está borrando
    await retencion.query("COMMIT");

    const p = await purga;
    const a = await admision;
    expect(p.ok && p.valor, "la purga borró par, origen y cuenta vencidos").toBe(3);
    expect(a.ok).toBe(true);

    const origen = (await filaDeOrigen(IP))!;
    const cuenta = (await filaDeCuenta("purgado"))!;
    const par = (await filaDePar("purgado", IP))!;
    expect(await prisma.limClave.count(), "exactamente las tres claves recreadas").toBe(3);
    expect(par.cuentaId, "el par apunta a la cuenta nueva").toBe(cuenta.id);
    const reserva = await prisma.limReserva.findFirstOrThrow();
    expect(reserva).toMatchObject({ origenId: origen.id, cuentaId: cuenta.id, parId: par.id, anulada: false });
    await expectCapacidadCuadra();

    if (a.ok) expect(await limitador.liquidar(a.valor, "fallo"), "se liquida normalmente, no como anulada").toBe("aplicada");
    expect(await prisma.limFalloPar.count({ where: { parId: par.id } })).toBe(1);
    await expectCapacidadCuadra();
  });

  it("la admisión va primero: la purga salta sus claves y no pierden su estado ni su reserva", async () => {
    const IP = "192.0.2.161";
    await clavesVencidas("admitido", IP);
    const antes = { origen: (await filaDeOrigen(IP))!, cuenta: (await filaDeCuenta("admitido"))!, par: (await filaDePar("admitido", IP))! };
    const retencion = await retenerCapacidad("reservas");

    const admision = desenlace(limitador.admitir(intento("admitido", IP)));
    await enCola(1); // claves bloqueadas y reserva insertada, sin confirmar
    expect(await limitador.purgar(), "la purga no espera ni borra claves bloqueadas").toBe(0);
    await retencion.query("COMMIT");
    const a = await admision;
    expect(a.ok).toBe(true);

    expect(await limitador.purgar(), "con la reserva viva tampoco se purgan").toBe(0);
    const despues = { origen: (await filaDeOrigen(IP))!, cuenta: (await filaDeCuenta("admitido"))!, par: (await filaDePar("admitido", IP))! };
    expect(despues.origen.id).toBe(antes.origen.id);
    expect(despues.cuenta.id).toBe(antes.cuenta.id);
    expect(despues.par.id).toBe(antes.par.id);
    expect(despues.origen.fallos, "el origen conserva su recuento").toBe(antes.origen.fallos);
    expect(despues.cuenta.fallos).toBe(antes.cuenta.fallos);
    expect(despues.par.venceEn.getTime(), "la admisión aplaza el vencimiento de las claves que usa").toBeGreaterThan(Date.now());
    await expectCapacidadCuadra();

    if (a.ok) expect(await limitador.liquidar(a.valor, "fallo")).toBe("aplicada");
    expect(await limitador.purgar()).toBe(0);
    await expectCapacidadCuadra();
  });
});

describe("restablecimiento frente a liquidación", () => {
  async function titularConReserva(username: string, ip: string) {
    const persona = await createPerson({ run: username === "reset_a" ? "93100001" : "93100002", username, firstName: "Rosa", gender: "female" });
    await createUser({ username, roleNames: ["swimmer"], personId: persona.id });
    const admin = await createUser({ username: `admin_${username}`, roleNames: ["admin"] });
    await login(username, INCORRECTA, ip);
    await login(username, INCORRECTA, ip);
    const enCurso = await limitador.admitir(intento(username, ip));
    const origenAntes = (await filaDeOrigen(ip))!.fallos;
    return { persona, admin, enCurso, origenAntes };
  }

  it("el restablecimiento va primero: la liquidación espera, queda anulada, no recrea el par y cuenta en el origen", async () => {
    const IP = "192.0.2.170";
    const { persona, admin, enCurso, origenAntes } = await titularConReserva("reset_a", IP);
    const retencion = await retenerCapacidad(recursoDeFragmento(fragmentoDe(clavesDe("reset_a", IP).cuenta)));

    const reset = desenlace(personsService.resetCredentials(persona.id, { userId: admin.id, ipAddress: "127.0.0.1" }));
    await enCola(1); // anuló la reserva y borró cuenta y par; espera L7 sin confirmar
    const liquidacion = desenlace(limitador.liquidar(enCurso, "fallo"));
    await enCola(2); // la liquidación espera el bloqueo consultivo de la cuenta
    await retencion.query("COMMIT");

    expect((await reset).ok).toBe(true);
    const l = await liquidacion;
    expect(l.ok && l.valor).toBe("anulada");
    expect(await clavesDeCuentaYPar(), "ni cuenta ni par recreados").toBe(0);
    expect((await filaDeOrigen(IP))!.fallos, "el origen cuenta el fallo y no devuelve presupuesto").toBe(origenAntes + 1);
    expect(await prisma.limReserva.count()).toBe(0);
    await expectCapacidadCuadra();
  });

  it("la liquidación va primero: el restablecimiento espera y borra después cuenta y par, sin tocar el origen", async () => {
    const IP = "192.0.2.171";
    const { persona, admin, enCurso, origenAntes } = await titularConReserva("reset_b", IP);
    const retencion = await retenerCapacidad("reservas");

    const liquidacion = desenlace(limitador.liquidar(enCurso, "fallo"));
    await enCola(1); // el fallo ya está aplicado en par, cuenta y origen, sin confirmar
    const reset = desenlace(personsService.resetCredentials(persona.id, { userId: admin.id, ipAddress: "127.0.0.1" }));
    await enCola(2); // el restablecimiento espera el bloqueo consultivo de la cuenta
    await retencion.query("COMMIT");

    const l = await liquidacion;
    expect(l.ok && l.valor).toBe("aplicada");
    expect((await reset).ok).toBe(true);
    expect(await clavesDeCuentaYPar(), "el restablecimiento borró cuenta y par").toBe(0);
    expect(await prisma.limFalloPar.count(), "sus fallos cayeron en cascada").toBe(0);
    expect((await filaDeOrigen(IP))!.fallos, "el origen conserva el fallo: no se perdona").toBe(origenAntes + 1);
    expect(await prisma.limReserva.count()).toBe(0);
    await expectCapacidadCuadra();
  });
});

describe("error dentro de la liquidación", () => {
  it("revierte todo; el reintento se aplica una sola vez y después es obsoleto", async () => {
    const IP = "192.0.2.180";
    const a = await limitador.admitir(intento("inyectado", IP));
    const reservasAntes = (await prisma.limCapacidad.findUniqueOrThrow({ where: { recurso: "reservas" } })).usadas;

    // Error real del motor DENTRO de la transacción: después de borrar la reserva y antes de
    // terminar de aplicar el fallo. Solo en la base desechable; se retira en el `finally`.
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION prueba_falla_liquidacion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fallo inyectado'; END $$`
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER prueba_falla_liquidacion BEFORE INSERT ON lim_fallo_par FOR EACH ROW EXECUTE FUNCTION prueba_falla_liquidacion()`
    );
    try {
      await expect(limitador.liquidar(a, "fallo")).rejects.toThrow(/fallo inyectado/);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS prueba_falla_liquidacion ON lim_fallo_par`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS prueba_falla_liquidacion()`);
    }

    expect(await prisma.limReserva.count({ where: { token: a.token } }), "la reserva sigue: nada se confirmó").toBe(1);
    expect(await prisma.limFalloPar.count()).toBe(0);
    expect((await filaDeOrigen(IP))!.fallos).toBe(0);
    expect((await filaDeCuenta("inyectado"))!.fallos).toBe(0);
    expect((await prisma.limCapacidad.findUniqueOrThrow({ where: { recurso: "reservas" } })).usadas).toBe(reservasAntes);
    await expectCapacidadCuadra();

    expect(await limitador.liquidar(a, "fallo"), "el reintento se aplica").toBe("aplicada");
    expect(await limitador.liquidar(a, "fallo"), "y no se cobra dos veces").toBe("obsoleta");
    expect(await limitador.barrer(), "el barrido no encuentra nada que cobrar").toBe(0);
    expect(await prisma.limFalloPar.count()).toBe(1);
    expect((await filaDeOrigen(IP))!.fallos).toBe(1);
    expect((await filaDeCuenta("inyectado"))!.fallos).toBe(1);
    await expectCapacidadCuadra();
  });
});

// ---------------------------------------------------------------------------
// 3. C-04 con la contraseña actual CORRECTA
// ---------------------------------------------------------------------------

describe("C-04 con la contraseña actual correcta: saturación y errores técnicos", () => {
  const NUEVA = "ClaveNuevaSintetica9";

  async function sesionDe(username: string, ip: string) {
    const usuario = await createUser({ username, roleNames: ["swimmer"], mustChangePassword: false });
    const entrada = await login(username, TEST_PASSWORD, ip);
    expect(entrada.statusCode).toBe(200);
    const token = entrada.json().accessToken as string;
    const sid = (jwt.decode(token) as { sid: string }).sid;
    const cambiar = () =>
      app.inject({
        method: "POST",
        url: "/auth/change-password",
        headers: { authorization: `Bearer ${token}` },
        payload: { currentPassword: TEST_PASSWORD, newPassword: NUEVA, confirmPassword: NUEVA },
      });
    return { usuario, sid, cambiar };
  }

  /** Nada cambió: ni fallos, ni revocación, ni contraseña; la reserva quedó libre. */
  async function expectSinEfectos(userId: string, sid: string, hashAntes: string) {
    const sesion = await prisma.refreshSession.findUniqueOrThrow({ where: { id: sid } });
    expect(sesion.passwordChangeFailures, "no suma un intento").toBe(0);
    expect(sesion.revokedAt, "no termina la sesión").toBeNull();
    expect(sesion.passwordChangeReservation, "la reserva quedó libre").toBeNull();
    const cuenta = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(cuenta.passwordHash, "sin cambio parcial de contraseña").toBe(hashAntes);
    expect(await prisma.refreshSession.count({ where: { userId, revokedAt: null } }), "las sesiones siguen").toBe(1);
    expect(await prisma.auditLog.count({ where: { action: { in: ["PASSWORD_CHANGE_FAILED", "PASSWORD_CHANGED"] } } })).toBe(0);
  }

  async function expectCambioPosteriorCorrecto(userId: string, cambiar: () => Promise<{ statusCode: number; body: string }>, hashAntes: string) {
    const res = await cambiar();
    expect(res.statusCode, res.body).toBe(200);
    const cuenta = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(cuenta.passwordHash).not.toBe(hashAntes);
    expect(await argon2.verify(cuenta.passwordHash, NUEVA)).toBe(true);
  }

  it("semáforo saturado: 503 sin efectos, reserva liberada y el cambio posterior funciona", async () => {
    const { usuario, sid, cambiar } = await sesionDe("c04_sat", "192.0.2.190");
    const hashAntes = usuario.passwordHash;

    configurarSemaforoArgon2({ max: 1, cola: 0, esperaMs: 1_000 });
    const ocupado = diferido();
    const retenido = conArgon2(() => ocupado.promesa);
    expect(estadoSemaforoArgon2().enCurso).toBe(1);

    const res = await cambiar();
    expect(res.statusCode).toBe(503);
    await expectSinEfectos(usuario.id, sid, hashAntes);

    ocupado.resolver();
    await retenido;
    await expectCambioPosteriorCorrecto(usuario.id, cambiar, hashAntes);
  });

  it("excepción de argon2.hash al calcular la contraseña nueva: 503 sin efectos, y el cambio posterior funciona", async () => {
    const { usuario, sid, cambiar } = await sesionDe("c04_hash", "192.0.2.191");
    const hashAntes = usuario.passwordHash;

    vi.spyOn(argon2, "hash").mockRejectedValueOnce(new Error("fallo nativo sintético"));
    const res = await cambiar();
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("fallo nativo");
    await expectSinEfectos(usuario.id, sid, hashAntes);

    await expectCambioPosteriorCorrecto(usuario.id, cambiar, hashAntes);
  });

  /**
   * Verificar la contraseña actual y calcular la nueva ocupan UN solo cupo: entre las dos no se
   * suelta. Una tarea que espera en la cola (aquí, encolada mientras se verifica) corre DESPUÉS
   * del hash, no entre ambas derivaciones. Con dos adquisiciones separadas correría en medio.
   */
  it("verificación y hash de la contraseña nueva ocupan un único cupo del semáforo", async () => {
    const { usuario, cambiar } = await sesionDe("c04_cupo", "192.0.2.192");
    configurarSemaforoArgon2({ max: 1, cola: 1, esperaMs: 5_000 });
    const orden: string[] = [];
    let externa: Promise<void> | null = null;
    // Atada al contexto de la PRUEBA: se encola como una solicitud ajena, no como una
    // adquisición anidada dentro del cupo que la verificación está ocupando.
    const encolarTareaAjena = AsyncResource.bind(() => {
      externa = conArgon2(async () => void orden.push("tarea en cola"));
    });

    const verificarOriginal = argon2.verify.bind(argon2);
    const hashOriginal = argon2.hash.bind(argon2);
    vi.spyOn(argon2, "verify").mockImplementationOnce(async (...args: Parameters<typeof argon2.verify>) => {
      encolarTareaAjena();
      orden.push("verificar");
      return verificarOriginal(...args);
    });
    vi.spyOn(argon2, "hash").mockImplementationOnce((async (...args: Parameters<typeof argon2.hash>) => {
      orden.push("hash nuevo");
      return hashOriginal(...args);
    }) as typeof argon2.hash);

    const res = await cambiar();
    await externa;
    expect(res.statusCode, res.body).toBe(200);
    expect(orden).toEqual(["verificar", "hash nuevo", "tarea en cola"]);
    expect(await argon2.verify((await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } })).passwordHash, NUEVA)).toBe(true);
  });
});
