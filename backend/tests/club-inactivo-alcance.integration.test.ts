/**
 * AUD-04 / AUD-11 — el estado del club se aplica a todos los que actúan por él.
 *
 * El defecto: bloquear, inhabilitar o eliminar un club apagaba solo SU cuenta. El
 * personal (delegado, entrenador, representante legal) entra con su cuenta de persona,
 * y su club salía de `club_staff` sin mirar el estado del club: seguía operando por él.
 * Además, crear o restablecer las credenciales de un club bloqueado dejaba su cuenta
 * activa, y el club recuperaba el acceso.
 *
 * Qué se comprueba, siempre por HTTP salvo el cambio de contraseña:
 *
 *  - Matriz de autorización: administrador, cuenta del club, personal SIN rol de nadador y
 *    personal que TAMBIÉN es nadador; con el club activo, bloqueado, inhabilitado,
 *    eliminado y reactivado.
 *  - Coherencia entre la respuesta del login o de la renovación, los claims del token y
 *    la autorización por solicitud (`/auth/me`).
 *  - Un token obtenido ANTES del cambio de estado se evalúa con el estado nuevo en la
 *    siguiente solicitud.
 *  - El acceso personal se conserva: los listados personales responden 200 sin datos
 *    ajenos, y lo operativo por el club se rechaza.
 *  - Los roles persistidos no se tocan, y reactivar el club los devuelve.
 *  - No hay revocaciones nuevas de sesiones del personal ni del administrador.
 *  - Matriz completa de creación y restablecimiento de credenciales del club.
 *
 * Datos sintéticos. Solo contra la base desechable (ver `helpers/testDb.ts`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addClubStaff, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";
import { verifyAccessToken } from "../src/modules/auth/jwt.util";
import * as authService from "../src/modules/auth/auth.service";
import { ROLES } from "../src/modules/auth/rbac.definitions";

let app: FastifyInstance;

const UUID_SINTETICO = "00000000-0000-4000-8000-000000000001";
const PERMISOS_NADADOR = [...ROLES.swimmer!].sort();
const PERMISOS_PERSONAL = [...ROLES.coach!].sort();

interface Sesion {
  status: number;
  body: any;
  accessToken: string;
  refreshCookie: string;
  csrf: { token: string; cookie: string };
}

async function login(username: string, password = TEST_PASSWORD): Promise<Sesion> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
  const body = res.json();
  const cookie = (nombre: string) => res.cookies.find((c) => c.name === nombre)?.value ?? "";
  return {
    status: res.statusCode,
    body,
    accessToken: body.accessToken ?? "",
    refreshCookie: cookie("fchmn_refresh"),
    csrf: { token: body.csrfToken ?? "", cookie: cookie("fchmn_csrf") },
  };
}

function renovar(s: Sesion) {
  return app.inject({
    method: "POST",
    url: "/auth/refresh",
    headers: { cookie: `fchmn_refresh=${s.refreshCookie}; fchmn_csrf=${s.csrf.cookie}`, "x-csrf-token": s.csrf.token },
  });
}

function get(token: string, url: string) {
  return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

function post(token: string, url: string, payload?: object) {
  return app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
}

async function sesionesVivas(userId: string): Promise<number> {
  return prisma.refreshSession.count({ where: { userId, revokedAt: null } });
}

async function rolesPersistidos(userId: string): Promise<string[]> {
  const filas = await prisma.userRole.findMany({ where: { userId }, include: { role: true } });
  return filas.map((f) => f.role.name).sort();
}

/** Lo que dicen de una sesión la respuesta, el token y `/auth/me`, en un mismo formato. */
async function vistaDeSesion(respuesta: any) {
  const claims = verifyAccessToken(respuesta.accessToken);
  const me = (await get(respuesta.accessToken, "/auth/me")).json();
  return {
    respuesta: { roles: [...respuesta.user.roles].sort(), clubId: respuesta.user.clubId },
    claims: { roles: [...claims.roles].sort(), permissions: [...claims.permissions].sort(), clubId: claims.clubId ?? null },
    me: { roles: [...me.roles].sort(), permissions: [...me.permissions].sort(), clubId: me.clubId ?? null },
  };
}

type Escenario = Awaited<ReturnType<typeof montarEscenario>>;

/**
 * Club Alfa con: su cuenta; una delegada SOLO delegada; un entrenador que también
 * nada en el club; y otra nadadora del club, sin cuenta, que hace de «dato ajeno».
 */
async function montarEscenario() {
  const admin = await createUser({ username: "admin_auda", roleNames: ["admin"] });
  const club = await createClub("Club Alfa Sintético", "ALF");
  const cuentaClub = await createUser({ username: club.username, roleNames: ["club"], clubId: club.id });

  const delegada = await createPerson({ run: "30000001", username: "deleg_alf", firstName: "Delia", gender: "female", roles: ["delegate"] });
  await addClubStaff(club.id, delegada.id, "delegate");
  const cuentaDelegada = await createUser({ username: "deleg_alf", roleNames: ["delegate"], personId: delegada.id });

  const entrenador = await createPerson({ run: "30000002", username: "coach_alf", firstName: "Ciro", gender: "male", roles: ["coach", "swimmer"] });
  await addClubStaff(club.id, entrenador.id, "coach");
  await addActiveMembership(club.id, entrenador.id, admin.id);
  const cuentaEntrenador = await createUser({ username: "coach_alf", roleNames: ["coach", "swimmer"], personId: entrenador.id });

  const otraNadadora = await createPerson({ run: "30000003", username: "nad_alf", firstName: "Nora", gender: "female", roles: ["swimmer"] });
  await addActiveMembership(club.id, otraNadadora.id, admin.id);

  const sesiones = {
    admin: await login("admin_auda"),
    club: await login(club.username),
    delegada: await login("deleg_alf"),
    entrenador: await login("coach_alf"),
  };
  for (const [quien, s] of Object.entries(sesiones)) {
    if (s.status !== 200) throw new Error(`el login inicial de ${quien} respondió ${s.status}`);
  }

  return { admin, club, cuentaClub, delegada, cuentaDelegada, entrenador, cuentaEntrenador, otraNadadora, sesiones };
}

type Cambio = "bloquear" | "inhabilitar" | "eliminar";

async function cambiarEstado(e: Escenario, cambio: Cambio) {
  const token = e.sesiones.admin.accessToken;
  const res =
    cambio === "eliminar"
      ? await app.inject({ method: "DELETE", url: `/clubs/${e.club.id}`, headers: { authorization: `Bearer ${token}` } })
      : await post(token, `/clubs/${e.club.id}/${cambio === "bloquear" ? "block" : "disable"}`);
  expect(res.statusCode, `${cambio} el club`).toBeLessThan(300);
}

beforeAll(async () => {
  app = await buildServer();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
});

afterAll(async () => {
  await app.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("con el club ACTIVO nada cambia", () => {
  it("personal y cuenta del club operan por el club; respuesta, token y /auth/me coinciden", async () => {
    const e = await montarEscenario();

    for (const s of [e.sesiones.delegada, e.sesiones.entrenador]) {
      const vista = await vistaDeSesion(s.body);
      expect(vista.respuesta.clubId).toBe(e.club.id);
      expect(vista.claims.clubId).toBe(e.club.id);
      expect(vista.me.clubId).toBe(e.club.id);
      expect(vista.claims.roles).toEqual(vista.respuesta.roles);
      expect(vista.me.roles).toEqual(vista.claims.roles);
      expect(vista.me.permissions).toEqual(vista.claims.permissions);
      expect((await get(s.accessToken, `/clubs/${e.club.id}`)).statusCode).toBe(200);
    }
    expect((await get(e.sesiones.club.accessToken, `/clubs/${e.club.id}`)).statusCode).toBe(200);

    // El listado de asignaciones del club, visto por su personal, incluye a la otra nadadora.
    const lista = (await get(e.sesiones.delegada.accessToken, "/swimmer-assignments")).json();
    expect(lista.items.map((a: any) => a.personId)).toContain(e.otraNadadora.id);
  });
});

describe.each<Cambio>(["bloquear", "inhabilitar", "eliminar"])("club no activo: %s", (cambio) => {
  it("personal SIN rol de nadador: conserva su sesión y su acceso personal; pierde todo lo del club", async () => {
    const e = await montarEscenario();
    const vivasAntes = await sesionesVivas(e.cuentaDelegada.id);
    const rolesAntes = await rolesPersistidos(e.cuentaDelegada.id);

    await cambiarEstado(e, cambio);

    // Token obtenido ANTES del cambio: la siguiente solicitud ya usa el estado nuevo.
    const token = e.sesiones.delegada.accessToken;
    const me = await get(token, "/auth/me");
    expect(me.statusCode, "su acceso personal sigue: /auth/me").toBe(200);
    expect(me.json()).toMatchObject({ roles: [], permissions: [], clubId: null });

    expect((await get(token, `/clubs/${e.club.id}`)).statusCode).toBe(403);
    expect((await get(token, "/clubs")).statusCode).toBe(403);
    expect((await get(token, "/swimmer-assignments")).statusCode).toBe(403);
    expect((await get(token, `/registrations/club-swimmers?clubId=${e.club.id}`)).statusCode).toBe(403);
    expect((await get(token, `/export/team-manager/hy3?competitionId=${UUID_SINTETICO}&clubId=${e.club.id}`)).statusCode).toBe(403);
    expect((await post(token, "/swimmer-assignments", { clubId: e.club.id, personId: e.otraNadadora.id })).statusCode).toBe(403);

    // Renovación de la sesión anterior y login nuevo: coherentes con la solicitud.
    const renovada = await renovar(e.sesiones.delegada);
    expect(renovada.statusCode, "la sesión no se revocó: renueva").toBe(200);
    const nuevo = await login("deleg_alf");
    expect(nuevo.status, "puede iniciar sesión: no queda bloqueada").toBe(200);
    for (const cuerpo of [renovada.json(), nuevo.body]) {
      const vista = await vistaDeSesion(cuerpo);
      expect(vista.respuesta).toEqual({ roles: [], clubId: null });
      expect(vista.claims).toEqual({ roles: [], permissions: [], clubId: null });
      expect(vista.me).toEqual(vista.claims);
    }

    expect(await rolesPersistidos(e.cuentaDelegada.id), "la reducción es efectiva, no persistida").toEqual(rolesAntes);
    expect(await sesionesVivas(e.cuentaDelegada.id), "ninguna sesión suya se revocó").toBeGreaterThanOrEqual(vivasAntes);
  });

  it("personal que TAMBIÉN es nadador: queda como nadador, solo con lo suyo", async () => {
    const e = await montarEscenario();
    const vivasAntes = await sesionesVivas(e.cuentaEntrenador.id);
    const rolesAntes = await rolesPersistidos(e.cuentaEntrenador.id);

    await cambiarEstado(e, cambio);

    const token = e.sesiones.entrenador.accessToken;
    const me = (await get(token, "/auth/me")).json();
    expect(me.clubId).toBeNull();
    expect(me.roles).toEqual(["swimmer"]);
    expect([...me.permissions].sort(), "exactamente los permisos de nadador, ni uno más").toEqual(PERMISOS_NADADOR);

    // Lo operativo del club: rechazado.
    expect((await get(token, `/clubs/${e.club.id}`)).statusCode).toBe(403);
    expect((await get(token, `/export/team-manager/hy3?competitionId=${UUID_SINTETICO}&clubId=${e.club.id}`)).statusCode).toBe(403);
    expect((await post(token, "/swimmer-assignments", { clubId: e.club.id, personId: e.otraNadadora.id })).statusCode).toBe(403);

    // Listados personales: 200, sin datos ajenos.
    const asignaciones = await get(token, "/swimmer-assignments");
    expect(asignaciones.statusCode).toBe(200);
    expect(asignaciones.json().items.map((a: any) => a.personId), "no ve las asignaciones de la otra nadadora").not.toContain(e.otraNadadora.id);

    const plantel = await get(token, `/registrations/club-swimmers?clubId=${e.club.id}`);
    expect(plantel.statusCode).toBe(200);
    const ids = plantel.json().map((p: any) => p.id);
    expect(ids, "no ve a la otra nadadora del club").not.toContain(e.otraNadadora.id);
    expect(ids.every((id: string) => id === e.entrenador.id), "a lo sumo se ve a sí mismo").toBe(true);

    const propio = await get(token, `/swimmer-assignments/current-club/${e.entrenador.id}`);
    expect(propio.statusCode, "su propio club como nadador").toBe(200);
    expect((await get(token, `/swimmer-assignments/current-club/${e.otraNadadora.id}`)).statusCode, "el de otra persona no").toBe(403);

    // Renovación, login nuevo y cambio de contraseña: coherentes.
    const renovada = await renovar(e.sesiones.entrenador);
    expect(renovada.statusCode).toBe(200);
    const nuevo = await login("coach_alf");
    expect(nuevo.status).toBe(200);
    for (const cuerpo of [renovada.json(), nuevo.body]) {
      const vista = await vistaDeSesion(cuerpo);
      expect(vista.respuesta).toEqual({ roles: ["swimmer"], clubId: null });
      expect(vista.claims).toEqual({ roles: ["swimmer"], permissions: PERMISOS_NADADOR, clubId: null });
      expect(vista.me).toEqual(vista.claims);
    }
    expect(await rolesPersistidos(e.cuentaEntrenador.id)).toEqual(rolesAntes);
    expect(await sesionesVivas(e.cuentaEntrenador.id), "ninguna sesión suya se revocó").toBeGreaterThanOrEqual(vivasAntes);

    const cambiada = await authService.changePassword(
      e.cuentaEntrenador.id,
      verifyAccessToken(nuevo.accessToken).sid as string,
      { currentPassword: TEST_PASSWORD, newPassword: "OtraClaveSintetica456", confirmPassword: "OtraClaveSintetica456" },
      { ipAddress: "127.0.0.1" }
    );
    const vistaCambio = await vistaDeSesion(cambiada);
    expect(vistaCambio.claims).toEqual({ roles: ["swimmer"], permissions: PERMISOS_NADADOR, clubId: null });
    expect(vistaCambio.me).toEqual(vistaCambio.claims);
  });

  it("cuenta del club: no opera, no renueva y no inicia sesión", async () => {
    const e = await montarEscenario();

    await cambiarEstado(e, cambio);

    expect((await get(e.sesiones.club.accessToken, `/clubs/${e.club.id}`)).statusCode).toBe(401);
    expect((await renovar(e.sesiones.club)).statusCode).toBe(401);
    expect((await login(e.club.username)).status).toBe(401);
  });

  it("administrador: sin cambios, y sin sesiones revocadas", async () => {
    const e = await montarEscenario();
    const vivasAntes = await sesionesVivas(e.admin.id);

    await cambiarEstado(e, cambio);

    const token = e.sesiones.admin.accessToken;
    const me = (await get(token, "/auth/me")).json();
    expect(me.roles).toEqual(["admin"]);
    expect(me.permissions.length).toBe(ROLES.admin!.length);
    // Ver el club: sí bloqueado o inhabilitado; eliminado responde 404 como siempre.
    expect((await get(token, `/clubs/${e.club.id}`)).statusCode).toBe(cambio === "eliminar" ? 404 : 200);
    expect((await renovar(e.sesiones.admin)).statusCode).toBe(200);
    expect(await sesionesVivas(e.admin.id)).toBe(vivasAntes);
  });
});

describe.each<"bloquear" | "inhabilitar">(["bloquear", "inhabilitar"])("reactivar tras %s", (cambio) => {
  it("el personal recupera roles y club en la siguiente solicitud, con su token anterior", async () => {
    const e = await montarEscenario();
    const tokenDelegada = e.sesiones.delegada.accessToken;
    const tokenEntrenador = e.sesiones.entrenador.accessToken;

    await cambiarEstado(e, cambio);
    expect((await get(tokenDelegada, `/clubs/${e.club.id}`)).statusCode).toBe(403);

    expect((await post(e.sesiones.admin.accessToken, `/clubs/${e.club.id}/reactivate`)).statusCode).toBe(200);

    expect((await get(tokenDelegada, `/clubs/${e.club.id}`)).statusCode).toBe(200);
    expect((await get(tokenDelegada, "/auth/me")).json()).toMatchObject({ roles: ["delegate"], clubId: e.club.id });

    const meEntrenador = (await get(tokenEntrenador, "/auth/me")).json();
    expect([...meEntrenador.roles].sort()).toEqual(["coach", "swimmer"]);
    expect(meEntrenador.clubId).toBe(e.club.id);
    expect([...meEntrenador.permissions].sort()).toEqual([...new Set([...PERMISOS_PERSONAL, ...PERMISOS_NADADOR])].sort());

    // La cuenta del club vuelve a entrar (setStatus la reactiva, como antes).
    expect((await login(e.club.username)).status).toBe(200);
  });
});

describe("cuenta de club incoherente: activa con el club bloqueado", () => {
  it("la defensa no depende de que coincidan las dos columnas", async () => {
    const e = await montarEscenario();
    // Se fuerza la incoherencia que dejaba el restablecimiento anterior.
    await prisma.club.update({ where: { id: e.club.id }, data: { status: "locked" } });

    expect((await get(e.sesiones.club.accessToken, `/clubs/${e.club.id}`)).statusCode).toBe(401);
    expect((await renovar(e.sesiones.club)).statusCode).toBe(401);
    const intento = await login(e.club.username);
    expect(intento.status).toBe(401);
    expect(intento.body.message, "genérico: no revela el estado").toBe("Usuario o contraseña incorrectos");
  });
});

// ---------------------------------------------------------------------------
// Credenciales del club
// ---------------------------------------------------------------------------

async function adminYClub(estadoClub: "active" | "locked" | "disabled" = "active") {
  const admin = await createUser({ username: "admin_cred", roleNames: ["admin"] });
  const club = await createClub("Club Beta Sintético", "BET");
  if (estadoClub !== "active") await prisma.club.update({ where: { id: club.id }, data: { status: estadoClub } });
  const sesion = await login("admin_cred");
  return { admin, club, token: sesion.accessToken };
}

describe("crear credenciales", () => {
  it("club activo: se crean, activas", async () => {
    const { club, token } = await adminYClub("active");
    const res = await post(token, `/clubs/${club.id}/credentials`);
    expect(res.statusCode).toBe(201);
    const cuenta = await prisma.user.findUniqueOrThrow({ where: { clubId: club.id } });
    expect(cuenta).toMatchObject({ status: "active", lockedUntil: null, failedLoginAttempts: 0, mustChangePassword: true });
  });

  it.each<"locked" | "disabled">(["locked", "disabled"])("club %s: se rechazan y no se crea ninguna cuenta", async (estado) => {
    const { club, token } = await adminYClub(estado);
    const res = await post(token, `/clubs/${club.id}/credentials`);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/no está activo/);
    expect(await prisma.user.count({ where: { clubId: club.id } })).toBe(0);
  });

  it("club eliminado: 404, como antes", async () => {
    const { club, token } = await adminYClub("active");
    await prisma.club.update({ where: { id: club.id }, data: { deletedAt: new Date() } });
    expect((await post(token, `/clubs/${club.id}/credentials`)).statusCode).toBe(404);
    expect(await prisma.user.count({ where: { clubId: club.id } })).toBe(0);
  });
});

type EstadoCuenta = { status: "active" | "locked" | "disabled"; lockedUntil: Date | null; failedLoginAttempts: number };

const EN_UNA_HORA = () => new Date(Date.now() + 60 * 60_000);

const CUENTAS: Record<string, () => EstadoCuenta> = {
  activa: () => ({ status: "active", lockedUntil: null, failedLoginAttempts: 2 }),
  "bloqueo temporal": () => ({ status: "locked", lockedUntil: EN_UNA_HORA(), failedLoginAttempts: 4 }),
  "bloqueo administrativo": () => ({ status: "locked", lockedUntil: null, failedLoginAttempts: 1 }),
  inhabilitada: () => ({ status: "disabled", lockedUntil: null, failedLoginAttempts: 3 }),
};

/** [estado del club, estado previo de la cuenta, estado esperado tras restablecer]. */
const MATRIZ_RESTABLECIMIENTO: [("active" | "locked" | "disabled"), string, "active" | "locked" | "disabled"][] = [
  ["active", "activa", "active"],
  ["active", "bloqueo temporal", "active"],
  ["active", "bloqueo administrativo", "active"],
  ["active", "inhabilitada", "active"],
  ["locked", "activa", "locked"],
  ["locked", "bloqueo temporal", "locked"],
  ["locked", "bloqueo administrativo", "locked"],
  ["locked", "inhabilitada", "locked"],
  ["disabled", "activa", "disabled"],
  ["disabled", "bloqueo temporal", "disabled"],
  ["disabled", "bloqueo administrativo", "disabled"],
  ["disabled", "inhabilitada", "disabled"],
];

describe("restablecer credenciales: status, lockedUntil y failedLoginAttempts juntos", () => {
  it.each(MATRIZ_RESTABLECIMIENTO)("club %s, cuenta %s → %s", async (estadoClub, cuentaAntes, esperado) => {
    const { club, token } = await adminYClub("active");
    const cuenta = await createUser({ username: club.username, roleNames: ["club"], clubId: club.id });
    const sesionCuenta = await login(club.username);
    expect(sesionCuenta.status).toBe(200);
    await prisma.user.update({ where: { id: cuenta.id }, data: CUENTAS[cuentaAntes]!() });
    if (estadoClub !== "active") await prisma.club.update({ where: { id: club.id }, data: { status: estadoClub } });

    const res = await post(token, `/clubs/${club.id}/credentials/reset`);
    expect(res.statusCode).toBe(200);
    const temporal = res.json().temporaryPassword as string;

    const despues = await prisma.user.findUniqueOrThrow({ where: { id: cuenta.id } });
    expect({ status: despues.status, lockedUntil: despues.lockedUntil, failedLoginAttempts: despues.failedLoginAttempts }).toEqual({
      status: esperado,
      lockedUntil: null,
      failedLoginAttempts: 0,
    });
    expect(despues.mustChangePassword).toBe(true);
    expect(await sesionesVivas(cuenta.id), "las sesiones de la cuenta se terminan, como antes").toBe(0);

    // Con la clave temporal: entra solo si el club está activo.
    const intento = await login(club.username, temporal);
    expect(intento.status).toBe(estadoClub === "active" ? 200 : 401);
  });

  it("club eliminado: 404, como antes", async () => {
    const { club, token } = await adminYClub("active");
    await createUser({ username: club.username, roleNames: ["club"], clubId: club.id });
    await prisma.club.update({ where: { id: club.id }, data: { deletedAt: new Date() } });
    expect((await post(token, `/clubs/${club.id}/credentials/reset`)).statusCode).toBe(404);
  });

  it("restablecida con el club bloqueado, la cuenta vuelve a entrar al reactivarlo", async () => {
    const { club, token } = await adminYClub("active");
    await createUser({ username: club.username, roleNames: ["club"], clubId: club.id });
    expect((await post(token, `/clubs/${club.id}/block`)).statusCode).toBe(200);
    const temporal = (await post(token, `/clubs/${club.id}/credentials/reset`)).json().temporaryPassword as string;

    expect((await login(club.username, temporal)).status).toBe(401);
    expect((await post(token, `/clubs/${club.id}/reactivate`)).statusCode).toBe(200);
    const sesion = await login(club.username, temporal);
    expect(sesion.status).toBe(200);
    expect(sesion.body.mustChangePassword).toBe(true);
  });
});
