/**
 * Fase 5, hallazgo 25 — endurecimiento HTTP, comprobado contra la aplicación
 * real (`buildServer()` + `app.inject()`), no contra la configuración.
 *
 * Lo que se verifica aquí no se puede verificar leyendo `server.ts`: que
 * `/ready` consulte de verdad la base, que `/health` NO lo haga, y que la
 * documentación quede publicada o no según el entorno.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";

let app: FastifyInstance;

beforeAll(async () => {
  await truncateAllTables(prisma);
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("sondas de vivacidad y disponibilidad", () => {
  it("/health responde sin consultar la base", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    const cuerpo = res.json();
    expect(cuerpo.status).toBe("ok");
    expect(cuerpo, "informa el tiempo en pie, útil para detectar reinicios").toHaveProperty("uptime");
    expect(cuerpo, "no dice nada de la base: no es lo que mide").not.toHaveProperty("database");
  });

  it("/ready SÍ consulta la base y la reporta", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", database: "ok" });
  });

  /**
   * La distinción importa: con una sola sonda que devolvía `{status:"ok"}` sin
   * mirar nada, una instancia sin base seguía recibiendo tráfico del
   * balanceador y respondiendo errores a cada solicitud.
   */
  it("/ready responde 503 cuando la base no contesta", async () => {
    const original = prisma.$queryRaw;
    // Se simula la caída interceptando la consulta de la sonda.
    (prisma as unknown as { $queryRaw: unknown }).$queryRaw = () => Promise.reject(new Error("no hay conexión"));
    try {
      const res = await app.inject({ method: "GET", url: "/ready" });

      expect(res.statusCode, "un balanceador debe poder sacarla de rotación").toBe(503);
      expect(res.json()).toEqual({ status: "unavailable", database: "unreachable" });
    } finally {
      (prisma as unknown as { $queryRaw: unknown }).$queryRaw = original;
    }
  });

  it("/health sigue respondiendo 200 aunque la base esté caída", async () => {
    const original = prisma.$queryRaw;
    (prisma as unknown as { $queryRaw: unknown }).$queryRaw = () => Promise.reject(new Error("no hay conexión"));
    try {
      const res = await app.inject({ method: "GET", url: "/health" });

      // Reiniciar el proceso no arregla una base caída: `/health` no debe
      // provocar ese reinicio.
      expect(res.statusCode).toBe(200);
    } finally {
      (prisma as unknown as { $queryRaw: unknown }).$queryRaw = original;
    }
  });
});

describe("documentación interactiva", () => {
  it("está publicada en este entorno (NODE_ENV=test, no producción)", async () => {
    const res = await app.inject({ method: "GET", url: "/docs" });
    // Swagger UI responde con una redirección a /docs/ o con el HTML.
    expect([200, 302]).toContain(res.statusCode);
  });

  it("el documento OpenAPI declara la URL configurada, no un localhost fijo", async () => {
    const { urlPublicaApi } = await import("../src/shared/env");
    const res = await app.inject({ method: "GET", url: "/docs/json" });

    expect(res.statusCode).toBe(200);
    expect(res.json().servers[0].url).toBe(urlPublicaApi);
  });
});

describe("CORS", () => {
  it("responde con credenciales habilitadas", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
    });

    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  /**
   * @fastify/cors 11 responde por omisión solo GET, HEAD y POST. Con la
   * versión 9 anterior no había que declarar nada, así que al subir de versión
   * el preflight de PUT y DELETE —editar una competencia, eliminar una prueba—
   * habría empezado a fallar desde el navegador sin ningún cambio de código
   * que lo explicara. La prueba anterior solo miraba `credentials` y no lo
   * habría detectado.
   */
  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"])("el preflight de %s queda autorizado", async (metodo) => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/competitions",
      headers: { origin: "http://localhost:5173", "access-control-request-method": metodo },
    });

    expect(res.statusCode, `preflight de ${metodo}`).toBeLessThan(400);
    const permitidos = String(res.headers["access-control-allow-methods"] ?? "");
    expect(permitidos, `${metodo} debe estar entre los métodos permitidos (llegó "${permitidos}")`).toContain(metodo);
  });
});

/**
 * La lista blanca se prueba construyendo el servidor con una configuración
 * propia. `buildServer` acepta la configuración justamente para esto: probarla
 * con el `env` del proceso —que en pruebas tiene la lista vacía— solo
 * ejercitaría el caso abierto de desarrollo.
 */
describe("CORS con lista blanca configurada", () => {
  const PERMITIDO = "https://inscripciones.fchmn.cl";
  const AJENO = "https://sitio-cualquiera.cl";
  let appConLista: FastifyInstance;

  beforeAll(async () => {
    const { env } = await import("../src/shared/env");
    appConLista = await buildServer({ ...env, CORS_ORIGINS: [PERMITIDO] });
    await appConLista.ready();
  });

  afterAll(async () => {
    await appConLista?.close();
  });

  it("AUTORIZA un origen de la lista", async () => {
    const res = await appConLista.inject({
      method: "OPTIONS",
      url: "/competitions",
      headers: { origin: PERMITIDO, "access-control-request-method": "PUT" },
    });

    expect(res.headers["access-control-allow-origin"]).toBe(PERMITIDO);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("NO autoriza un origen fuera de la lista", async () => {
    const res = await appConLista.inject({
      method: "OPTIONS",
      url: "/competitions",
      headers: { origin: AJENO, "access-control-request-method": "PUT" },
    });

    // Sin cabecera de origen permitido, el navegador descarta la respuesta:
    // es lo que impide que otro sitio use las credenciales del usuario.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("tampoco lo autoriza en una solicitud simple", async () => {
    const res = await appConLista.inject({ method: "GET", url: "/health", headers: { origin: AJENO } });

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("IP del cliente", () => {
  /**
   * Con `trustProxy: true` cualquiera podía mandar `X-Forwarded-For` y Fastify
   * lo tomaba como la IP real: bastaba para falsear el registro de auditoría y
   * para saltarse el límite de tasa por IP cambiando la cabecera en cada
   * intento. En modo `socket` (el valor por defecto, ver `shared/ipCliente.ts`)
   * ninguna cabecera de identidad reenviada decide la IP.
   */
  it("modo socket: ni X-Forwarded-For ni CF-Connecting-IP deciden la IP auditada", async () => {
    const { env } = await import("../src/shared/env");
    expect(env.IP_CLIENTE_FUENTE, "el entorno de prueba usa el socket").toBe("socket");

    const { seedRolesAndPermissions, createUser, TEST_PASSWORD } = await import("./helpers/seedRbac");
    await seedRolesAndPermissions();
    await createUser({ username: "admin_proxy", roleNames: ["admin"] });

    const IP_FALSEADA = "203.0.113.7";
    const CF_FALSEADA = "203.0.113.9";
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "x-forwarded-for": IP_FALSEADA, "cf-connecting-ip": CF_FALSEADA },
      payload: { username: "admin_proxy", password: TEST_PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);

    // El login deja un registro de auditoría con la IP de origen: es
    // exactamente el dato que se podía falsear.
    const registro = await prisma.auditLog.findFirstOrThrow({ where: { action: "LOGIN" }, orderBy: { createdAt: "desc" } });
    expect(registro.ipAddress, "la cabecera del cliente no puede decidir qué IP se audita").not.toBe(IP_FALSEADA);
    expect(registro.ipAddress).not.toBe(CF_FALSEADA);
    expect(registro.ipAddress, "inject usa 127.0.0.1 como socket").toBe("127.0.0.1");
  });

  /**
   * Modo `cf-connecting-ip` (Render) sobre `buildServer()` real: la IP que queda en la
   * auditoría es CF-Connecting-IP en forma canónica, y X-Forwarded-For no interviene.
   */
  it("modo cf-connecting-ip: la auditoría guarda CF-Connecting-IP canónica; con valor inválido, el socket", async () => {
    const { env } = await import("../src/shared/env");
    // Datos propios: no depende de que otro caso haya creado un usuario. Los roles se
    // siembran con `upsert` (idempotente) y la cuenta tiene un nombre exclusivo de este caso.
    const { seedRolesAndPermissions, createUser, TEST_PASSWORD } = await import("./helpers/seedRbac");
    await seedRolesAndPermissions();
    const usuario = await createUser({ username: "admin_proxy_cf", roleNames: ["admin"] });

    const appCf = await buildServer({ ...env, IP_CLIENTE_FUENTE: "cf-connecting-ip" });
    await appCf.ready();
    try {
      const login = (headers: Record<string, string>) =>
        appCf.inject({ method: "POST", url: "/auth/login", headers, payload: { username: "admin_proxy_cf", password: TEST_PASSWORD } });
      const ultimaIp = async () =>
        (
          await prisma.auditLog.findFirstOrThrow({
            where: { action: "LOGIN", userId: usuario.id },
            orderBy: { createdAt: "desc" },
          })
        ).ipAddress;

      const valida = await login({ "cf-connecting-ip": "2001:DB8:0:0:0:0:0:1", "x-forwarded-for": "203.0.113.7" });
      expect(valida.statusCode, valida.body).toBe(200);
      expect(await ultimaIp()).toBe("2001:db8::1");

      const invalida = await login({ "cf-connecting-ip": "no-es-una-ip", "x-forwarded-for": "203.0.113.7" });
      expect(invalida.statusCode, invalida.body).toBe(200);
      expect(await ultimaIp(), "respaldo: la dirección del socket").toBe("127.0.0.1");
    } finally {
      await appCf.close();
    }
  });
});
