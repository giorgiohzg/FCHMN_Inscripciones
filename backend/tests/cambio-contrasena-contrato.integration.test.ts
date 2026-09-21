/**
 * Fase 6 — el CONTRATO REAL de `POST /auth/change-password`.
 *
 * El frontend adopta la respuesta de esta ruta como sesión completa: guarda el
 * access token, el token CSRF y el PERFIL, y abre un ciclo nuevo. Eso solo es
 * legítimo si el servidor devuelve de verdad todas esas piezas.
 *
 * No lo hacía: `changePassword()` devolvía `{ accessToken, refreshToken,
 * mustChangePassword }` sin `user`, y ninguna prueba lo detectaba porque las que
 * había miraban el servicio, o el estado del cliente con una respuesta simulada.
 * Un mock puede devolver el perfil aunque el servidor no lo mande.
 *
 * Por eso esta prueba habla HTTP contra el servidor real, con un tarro de
 * cookies (`tough-cookie`) que aplica las reglas del RFC 6265 igual que un
 * navegador, y comprueba el ciclo entero: entrar con cambio obligatorio,
 * cambiar la contraseña, ADOPTAR lo que llega y seguir renovando con ello.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { CookieJar } from "tough-cookie";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createUser, TEST_PASSWORD } from "./helpers/seedRbac";

const CLAVE_NUEVA = "OtraClaveValida456";

let app: FastifyInstance;
let base: string;

/** Cliente con tarro de cookies: adjunta a cada URL lo que corresponde. */
function navegador() {
  const jar = new CookieJar();

  async function pedir(ruta: string, init: RequestInit = {}): Promise<Response> {
    const url = `${base}${ruta}`;
    const headers = new Headers(init.headers);
    const cookie = await jar.getCookieString(url);
    if (cookie) headers.set("cookie", cookie);

    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      await jar.setCookie(sc, url).catch(() => undefined);
    }
    return res;
  }

  return { jar, pedir, cookieDeSesion: () => jar.getCookieString(`${base}/auth/refresh`) };
}

/** Los claims del access token, sin verificar la firma: aquí solo se comparan. */
function claimsDe(accessToken: string): Record<string, unknown> {
  const [, payload] = accessToken.split(".");
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
}

async function entrar(nav: ReturnType<typeof navegador>, username: string, password = TEST_PASSWORD) {
  const res = await nav.pedir("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return { res, cuerpo: (await res.json()) as Record<string, any> };
}

async function cambiarContrasena(
  nav: ReturnType<typeof navegador>,
  opts: { accessToken: string; csrf: string; actual: string; nueva: string }
) {
  const res = await nav.pedir("/auth/change-password", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.accessToken}`,
      "x-csrf-token": opts.csrf,
    },
    body: JSON.stringify({ currentPassword: opts.actual, newPassword: opts.nueva, confirmPassword: opts.nueva }),
  });
  return { res, cuerpo: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const dir = app.server.address();
  if (!dir || typeof dir === "string") throw new Error("no se pudo determinar el puerto");
  base = `http://127.0.0.1:${dir.port}`;
});

afterAll(async () => {
  await app?.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("cambio de contraseña obligatorio, extremo a extremo por HTTP", () => {
  it("devuelve la SESIÓN COMPLETA y con ella se sigue renovando", async () => {
    // Cuenta de club con cambio obligatorio: el perfil tiene club y roles, así
    // que un `user` incompleto se nota.
    const club = await createClub("Club Contrato", "CTR", "club_contrato");
    await createUser({
      username: "club_contrato",
      roleNames: ["club"],
      clubId: club.id,
      mustChangePassword: true,
    });

    const nav = navegador();
    const { res: login, cuerpo: sesionInicial } = await entrar(nav, "club_contrato");
    expect(login.status).toBe(200);
    expect(sesionInicial.mustChangePassword, "la cuenta entra obligada a cambiar").toBe(true);

    const { res, cuerpo } = await cambiarContrasena(nav, {
      accessToken: sesionInicial.accessToken,
      csrf: sesionInicial.csrfToken,
      actual: TEST_PASSWORD,
      nueva: CLAVE_NUEVA,
    });

    expect(res.status).toBe(200);

    /**
     * EL CONTRATO, campo a campo. El cliente adopta esto tal cual: si falta
     * `user`, la aplicación se queda sin perfil —sin nombre, sin club y sin
     * roles— justo después de cambiar la contraseña.
     */
    expect(cuerpo.accessToken, "sin access token no hay sesión que adoptar").toEqual(expect.any(String));
    expect(cuerpo.csrfToken, "y sin CSRF la siguiente operación daría 403").toEqual(expect.any(String));
    expect(cuerpo.mustChangePassword, "la obligación queda saldada").toBe(false);
    expect(cuerpo.user, "el PERFIL: esto era lo que faltaba").toEqual({
      id: expect.any(String),
      username: "club_contrato",
      ownerType: "club",
      personId: null,
      clubId: club.id,
      roles: ["club"],
    });

    // El refresh token NUNCA vuelve en el cuerpo: viaja en la cookie HttpOnly.
    expect(cuerpo).not.toHaveProperty("refreshToken");

    /**
     * COHERENCIA entre el token y el perfil. El cliente rechaza una respuesta en
     * la que no coincidan (`sessionSchema`), así que si el servidor emitiera un
     * token que no describe a este usuario, la sesión sería inadoptable.
     */
    const claims = claimsDe(cuerpo.accessToken);
    expect(claims.sub).toBe(cuerpo.user.id);
    expect(claims.clubId).toBe(club.id);
    expect(claims.roles).toEqual(["club"]);

    // La cookie de sesión se reemplazó: la anterior quedó revocada por el
    // cambio, y sin este reemplazo el usuario perdería la sesión al instante.
    expect(await nav.cookieDeSesion()).toContain("fchmn_refresh");

    /**
     * ADOPTAR Y SEGUIR. Esta es la comprobación que ninguna prueba con mocks
     * puede dar: el refresco siguiente usa el CSRF que vino en el cambio y la
     * cookie que el servidor acaba de poner.
     */
    const refresco = await nav.pedir("/auth/refresh", {
      method: "POST",
      headers: { "x-csrf-token": cuerpo.csrfToken },
    });
    expect(refresco.status, "la sesión emitida por el cambio es utilizable").toBe(200);

    const renovada = (await refresco.json()) as Record<string, any>;
    expect(renovada.user, "y el refresco también reconstruye el perfil completo").toEqual(cuerpo.user);
    expect(renovada.mustChangePassword).toBe(false);
  });

  it("la contraseña nueva es la que sirve para volver a entrar", async () => {
    const nav = navegador();
    const { res, cuerpo } = await entrar(nav, "club_contrato", CLAVE_NUEVA);
    expect(res.status, "la nueva funciona").toBe(200);
    expect(cuerpo.mustChangePassword, "y ya no obliga a cambiarla").toBe(false);

    const vieja = await entrar(navegador(), "club_contrato", TEST_PASSWORD);
    expect(vieja.res.status, "la anterior ya no").toBe(401);
  });

  it("las sesiones anteriores quedan revocadas: la cookie previa ya no renueva", async () => {
    const club = await createClub("Club Revoca", "RVC", "club_revoca");
    await createUser({ username: "club_revoca", roleNames: ["club"], clubId: club.id, mustChangePassword: true });

    const nav = navegador();
    const { cuerpo: inicial } = await entrar(nav, "club_revoca");

    // Se guarda la cookie de ANTES del cambio, tal como la tendría otra pestaña.
    const cookieVieja = await nav.cookieDeSesion();

    await cambiarContrasena(nav, {
      accessToken: inicial.accessToken,
      csrf: inicial.csrfToken,
      actual: TEST_PASSWORD,
      nueva: CLAVE_NUEVA,
    });

    /**
     * Con la cookie vieja, puesta a mano: es lo que enviaría esa otra pestaña,
     * y con el token CSRF de entonces, que es el que casa con esa cookie. Así el
     * 401 solo puede venir de la REVOCACIÓN, no de la comprobación CSRF.
     */
    const conLaVieja = await fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: { cookie: cookieVieja, "x-csrf-token": inicial.csrfToken },
    });
    expect(conLaVieja.status, "el cambio de contraseña revoca todo lo anterior").toBe(401);
  });
});
