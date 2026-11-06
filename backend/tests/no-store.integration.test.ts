/**
 * Fase 2 — `Cache-Control: no-store` en TODA respuesta de la API.
 *
 * Contra la aplicación real (`buildServer()` + `app.inject()`) y la base desechable. Lo que se
 * comprueba no se puede leer en `server.ts`: que el hook cubra también lo que responde ANTES de
 * llegar a una ruta (404, 429, errores de un `preHandler`, CORS) y que no altere cuerpos,
 * códigos ni cabeceras propias. Las descargas (reportes y Team Manager) se comprueban en
 * `import-export-services.integration.test.ts`, que ya monta una competencia completa.
 *
 * Solo datos sintéticos.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { env } from "../src/shared/env";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, TEST_PASSWORD } from "./helpers/seedRbac";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  await createUser({ username: "admin_nostore", roleNames: ["admin"] });
  await createUser({ username: "nadador_nostore", roleNames: ["swimmer"] });
});

afterAll(async () => {
  await app.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

const login = (username: string, password = TEST_PASSWORD) =>
  app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });

async function tokenDe(username: string): Promise<string> {
  const res = await login(username);
  expect(res.statusCode).toBe(200);
  return res.json().accessToken;
}

describe("respuestas correctas", () => {
  it("sondas, CSRF y rutas autenticadas", async () => {
    const token = await tokenDe("admin_nostore");
    const casos: Array<[string, string, Record<string, string>?]> = [
      ["GET", "/health"],
      ["GET", "/ready"],
      ["GET", "/auth/csrf"],
      ["GET", "/auth/me", { authorization: `Bearer ${token}` }],
      ["GET", "/persons", { authorization: `Bearer ${token}` }],
    ];
    for (const [method, url, headers] of casos) {
      const res = await app.inject({ method: method as "GET", url, headers });
      expect(res.statusCode, `${method} ${url}`).toBe(200);
      expect(res.headers["cache-control"], `${method} ${url}`).toBe("no-store");
    }
  });

  it("login correcto: no-store, y el cuerpo y la cookie de sesión no cambian", async () => {
    const res = await login("admin_nostore");

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toHaveProperty("accessToken");
    expect(res.json()).toHaveProperty("csrfToken");
    expect(res.json()).not.toHaveProperty("refreshToken");
    expect(String(res.headers["set-cookie"])).toContain("fchmn_refresh=");
  });

  it("la cabecera se ESTABLECE una sola vez, sin duplicarse con otras", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Array.isArray(res.headers["cache-control"])).toBe(false);
    // Las cabeceras de helmet siguen presentes.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("errores y respuestas que no llegan a una ruta", () => {
  it("credenciales incorrectas (401)", async () => {
    const res = await login("admin_nostore", "ClaveIncorrecta1");
    expect(res.statusCode).toBe(401);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("cuerpo de login inválido (400)", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().error).toBe("VALIDATION_ERROR");
  });

  it("sin token: 401 lanzado desde un preHandler", async () => {
    const res = await app.inject({ method: "GET", url: "/persons" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("sin permiso: 403 lanzado desde un preHandler", async () => {
    const token = await tokenDe("nadador_nostore");
    const res = await app.inject({ method: "POST", url: "/persons", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("ruta inexistente (404)", async () => {
    const res = await app.inject({ method: "GET", url: "/esta-ruta-no-existe" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("método no admitido en una ruta existente", async () => {
    const res = await app.inject({ method: "DELETE", url: "/health" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("CSRF: refresco con cookie y sin token (403)", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/refresh", headers: { cookie: "fchmn_refresh=cualquiera" } });
    expect(res.statusCode).toBe(403);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("CSRF: bootstrap desde un origen no autorizado (403)", async () => {
    const cors = await buildServer({ ...env, CORS_ORIGINS: ["https://web.ejemplo.test"] });
    try {
      const res = await cors.inject({ method: "GET", url: "/auth/csrf", headers: { origin: "https://otro-sitio.test" } });
      expect(res.statusCode, "la prueba solo vale si el bootstrap se rechaza").toBe(403);
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await cors.close();
    }
  });

  it("refresco sin cookie (401)", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/refresh" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("preflight CORS (OPTIONS)", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/persons",
      headers: { origin: "https://web.ejemplo.test", "access-control-request-method": "GET" },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("límites de solicitudes (429)", () => {
  it("límite global: el 429 lleva no-store y conserva su código", async () => {
    const limitado = await buildServer({ ...env, RATE_LIMIT_GLOBAL_MAX: 2 });
    try {
      const estados: number[] = [];
      let ultimo;
      for (let i = 0; i < 4; i++) {
        ultimo = await limitado.inject({ method: "GET", url: "/health" });
        estados.push(ultimo.statusCode);
      }
      expect(estados).toContain(429);
      const rechazada = (await limitado.inject({ method: "GET", url: "/health" }));
      expect(rechazada.statusCode).toBe(429);
      expect(rechazada.headers["cache-control"]).toBe("no-store");
      expect(rechazada.json().error).toBe("RATE_LIMIT_EXCEEDED");
    } finally {
      await limitado.close();
    }
  });

  it("límite del login: el 429 lleva no-store y NO se convierte en un error de credenciales", async () => {
    const limitado = await buildServer({ ...env, RATE_LIMIT_AUTH_MAX: 2 });
    try {
      const respuestas = [];
      for (let i = 0; i < 4; i++) {
        respuestas.push(await limitado.inject({ method: "POST", url: "/auth/login", payload: { username: "admin_nostore", password: "ClaveIncorrecta1" } }));
      }
      expect(respuestas.slice(0, 2).map((r) => r.statusCode)).toEqual([401, 401]);
      const limitada = respuestas[3]!;
      expect(limitada.statusCode).toBe(429);
      expect(limitada.headers["cache-control"]).toBe("no-store");
      expect(limitada.json().error).toBe("RATE_LIMIT_EXCEEDED");
      expect(limitada.json().message).not.toBe("Usuario o contraseña incorrectos");
    } finally {
      await limitado.close();
    }
  });
});
