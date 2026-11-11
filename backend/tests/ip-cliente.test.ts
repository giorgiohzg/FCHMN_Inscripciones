/**
 * IP del cliente (`src/shared/ipCliente.ts`): análisis y forma canónica, aceptación de
 * `CF-Connecting-IP`, respaldo al socket y efecto real sobre `req.ip`, el límite de tasa y el
 * registro «incoming request».
 *
 * Todo con direcciones SINTÉTICAS de documentación (192.0.2.0/24, 198.51.100.0/24,
 * 203.0.113.0/24, 2001:db8::/32) y privadas o loopback de ejemplo. No hay base de datos: el
 * servidor de prueba replica la parte de `server.ts` que decide la IP (las mismas opciones de
 * `opcionesDeOrigenIp`, el mismo registrador y el mismo límite de tasa); la prueba de integración
 * `http-hardening` lo comprueba además sobre `buildServer()`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { connect } from "node:net";
import { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { analizarIp, aceptableComoClientePublico, opcionesDeOrigenIp, origenIpDe, type FuenteIpCliente } from "../src/shared/ipCliente";
import { opcionesDeRegistro, ControladorDeRegistroSeguro } from "../src/shared/registro";

describe("analizarIp: sintaxis y forma canónica (no autentica nada)", () => {
  it.each([
    ["192.0.2.10", "192.0.2.10"],
    ["10.0.0.5", "10.0.0.5"],
    ["127.0.0.1", "127.0.0.1"],
    ["2001:db8::1", "2001:db8::1"],
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:0db8::0001", "2001:db8::1"],
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
    ["2001:db8:0:0:1:1:0:0", "2001:db8::1:1:0:0"],
    ["0:0:0:0:0:0:0:0", "::"],
    ["::1", "::1"],
    ["fe80::1", "fe80::1"],
    ["::ffff:192.0.2.10", "192.0.2.10"],
    ["::FFFF:c000:20a", "192.0.2.10"],
    ["0:0:0:0:0:ffff:192.0.2.10", "192.0.2.10"],
    ["::ffff:10.0.0.5", "10.0.0.5"],
    ["::ffff:127.0.0.1", "127.0.0.1"],
    ["2001:db8::192.0.2.10", "2001:db8::c000:20a"],
  ])("%s → %s", (entrada, canonica) => {
    expect(analizarIp(entrada)?.texto).toBe(canonica);
  });

  it("las IPv4 mapeadas se clasifican como IPv4", () => {
    expect(analizarIp("::ffff:192.0.2.10")?.familia).toBe(4);
    expect(analizarIp("2001:db8::1")?.familia).toBe(6);
  });

  it.each([
    "abc",
    "999.1.1.1",
    "01.2.3.4",
    "1.2.3.04",
    "0x1.2.3.4",
    "1.2.3",
    "",
    " 192.0.2.10",
    "192.0.2.10 ",
    "192.0.2.10:443",
    "[2001:db8::1]",
    "2001:db8::1%eth0",
    "1:2:3:4:5:6:7:8:9",
    "2001:db8:::1",
    "192.0.2.10, 198.51.100.7",
    "1".repeat(46),
  ])("RECHAZA %j", (entrada) => {
    expect(analizarIp(entrada)).toBeNull();
  });

  it("rechaza lo que no es texto", () => {
    expect(analizarIp(undefined)).toBeNull();
    expect(analizarIp(null)).toBeNull();
  });
});

describe("aceptableComoClientePublico: restricción SOLO para CF-Connecting-IP", () => {
  it.each(["192.0.2.10", "10.0.0.5", "172.16.0.1", "240.0.0.1", "2001:db8::1", "fe80::1", "ff:1::1"])("acepta %s", (ip) => {
    const analizada = analizarIp(ip);
    expect(analizada).not.toBeNull();
    expect(aceptableComoClientePublico(analizada!)).toBe(true);
  });

  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "127.0.0.1",
    "224.0.0.1",
    "239.255.255.255",
    "255.255.255.255",
    "::",
    "::1",
    "ff02::1",
    "::ffff:127.0.0.1",
  ])("no acepta %s", (ip) => {
    const analizada = analizarIp(ip);
    expect(analizada).not.toBeNull();
    expect(aceptableComoClientePublico(analizada!)).toBe(false);
  });
});

/** Servidor mínimo con la misma decisión de IP que `server.ts`. Devuelve también las líneas de registro. */
async function servidor(fuente: FuenteIpCliente, opciones: { limite?: number } = {}) {
  const lineas: Record<string, unknown>[] = [];
  const flujo = new Writable({
    write(trozo, _codificacion, listo) {
      for (const linea of String(trozo).split("\n").filter(Boolean)) lineas.push(JSON.parse(linea));
      listo();
    },
  });
  const app = Fastify({
    logger: opcionesDeRegistro(flujo),
    logController: new ControladorDeRegistroSeguro(),
    ...opcionesDeOrigenIp(fuente),
  });
  if (opciones.limite) await app.register(rateLimit, { global: true, max: opciones.limite, timeWindow: "1 minute" });
  app.get("/eco", async (req) => ({
    ip: req.ip,
    origen: origenIpDe(req.raw),
    host: req.host,
    protocolo: req.protocol,
    cabeceras: {
      xff: req.headers["x-forwarded-for"],
      cf: req.headers["cf-connecting-ip"],
      realIp: req.headers["x-real-ip"],
    },
  }));
  await app.ready();
  return { app, lineas };
}

let abierto: FastifyInstance | undefined;
afterEach(async () => {
  await abierto?.close();
  abierto = undefined;
});

async function eco(fuente: FuenteIpCliente, headers: Record<string, string>, remoteAddress = "10.0.0.5") {
  const { app } = await servidor(fuente);
  abierto = app;
  const res = await app.inject({ method: "GET", url: "/eco", headers, remoteAddress });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("modo cf-connecting-ip (Render)", () => {
  it("toma CF-Connecting-IP válida, ya canónica", async () => {
    const r = await eco("cf-connecting-ip", { "cf-connecting-ip": "192.0.2.10" });
    expect(r.ip).toBe("192.0.2.10");
    expect(r.origen).toEqual({ fuente: "cf-connecting-ip" });
  });

  it.each([
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["::FFFF:c000:20a", "192.0.2.10"],
    ["  198.51.100.7\t", "198.51.100.7"],
  ])("normaliza %j → %s", async (valor, canonica) => {
    const r = await eco("cf-connecting-ip", { "cf-connecting-ip": valor });
    expect(r.ip).toBe(canonica);
  });

  it("sin la cabecera usa el respaldo del socket, marcado como ausente", async () => {
    const r = await eco("cf-connecting-ip", {}, "::ffff:10.0.0.5");
    expect(r.ip).toBe("10.0.0.5");
    expect(r.origen).toEqual({ fuente: "respaldo", motivo: "ausente" });
  });

  it.each(["abc", "999.1.1.1", "01.2.3.4", "1.2.3", "", "1".repeat(46), "2001:db8::1%eth0", "[2001:db8::1]", "192.0.2.10:443"])(
    "valor inválido %j → respaldo",
    async (valor) => {
      const r = await eco("cf-connecting-ip", { "cf-connecting-ip": valor });
      expect(r.ip).toBe("10.0.0.5");
      expect(r.origen).toEqual({ fuente: "respaldo", motivo: "invalida" });
    }
  );

  it("una lista en una sola línea es ambigua → respaldo, sin elegir ninguna", async () => {
    const r = await eco("cf-connecting-ip", { "cf-connecting-ip": "192.0.2.10, 198.51.100.7" });
    expect(r.ip).toBe("10.0.0.5");
    expect(r.origen).toEqual({ fuente: "respaldo", motivo: "repetida" });
  });

  it.each(["0.0.0.0", "127.0.0.1", "::1", "::", "224.0.0.1", "::ffff:127.0.0.1"])(
    "%s no es un cliente público → respaldo",
    async (valor) => {
      const r = await eco("cf-connecting-ip", { "cf-connecting-ip": valor });
      expect(r.ip).toBe("10.0.0.5");
      expect(r.origen).toEqual({ fuente: "respaldo", motivo: "no-aceptable" });
    }
  );

  it("descarta X-Forwarded-For y X-Real-IP del cliente: no hay contradicción posible", async () => {
    const r = await eco("cf-connecting-ip", {
      "cf-connecting-ip": "192.0.2.10",
      "x-forwarded-for": "203.0.113.7, 198.51.100.1",
      "x-real-ip": "203.0.113.8",
    });
    expect(r.ip).toBe("192.0.2.10");
    expect(r.cabeceras).toEqual({ xff: "192.0.2.10" });
  });

  it("sin CF-Connecting-IP, un X-Forwarded-For del cliente tampoco decide", async () => {
    const r = await eco("cf-connecting-ip", { "x-forwarded-for": "203.0.113.7" });
    expect(r.ip).toBe("10.0.0.5");
    expect(r.origen).toEqual({ fuente: "respaldo", motivo: "ausente" });
  });

  /**
   * FRONTERA DEL WORKSPACE (decisión documentada): una conexión por la red privada que llega
   * DIRECTO a la API con una cabecera inventada se acepta. Esta prueba fija ese comportamiento a
   * propósito para que no pase inadvertido; no es una garantía de autenticidad.
   */
  it("camino privado 1 (directo a la API): un par privado con CF inventada SE ACEPTA", async () => {
    const r = await eco("cf-connecting-ip", { "cf-connecting-ip": "203.0.113.9" }, "10.0.0.99");
    expect(r.ip).toBe("203.0.113.9");
    expect(r.origen).toEqual({ fuente: "cf-connecting-ip" });
  });

  it("el respaldo admite loopback y socket IPv6", async () => {
    expect((await eco("cf-connecting-ip", {}, "127.0.0.1")).ip).toBe("127.0.0.1");
    expect((await eco("cf-connecting-ip", {}, "::1")).ip).toBe("::1");
    expect((await eco("cf-connecting-ip", {}, "2001:DB8::0005")).ip).toBe("2001:db8::5");
  });
});

describe("modo socket (local y pruebas)", () => {
  it("ignora todas las cabeceras de identidad reenviadas", async () => {
    const r = await eco(
      "socket",
      {
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "203.0.113.7",
        "x-real-ip": "203.0.113.8",
        "x-forwarded-host": "falso.example",
        "x-forwarded-proto": "https",
        host: "localhost:8080",
      },
      "::ffff:172.18.0.3"
    );
    expect(r.ip).toBe("172.18.0.3");
    expect(r.origen).toEqual({ fuente: "socket" });
    expect(r.host, "el host reenviado no se acepta").toBe("localhost:8080");
    expect(r.protocolo, "el esquema reenviado no se acepta").toBe("http");
    expect(r.cabeceras).toEqual({ xff: "172.18.0.3" });
  });

  it("el cliente no puede fijar la fuente ni el motivo con una cabecera", async () => {
    const r = await eco("socket", { origenip: '{"fuente":"cf-connecting-ip"}', "x-origen-ip": "cf-connecting-ip" });
    expect(r.origen).toEqual({ fuente: "socket" });
  });
});

describe("efectos de req.ip", () => {
  it("representaciones equivalentes comparten la clave del límite de tasa", async () => {
    const { app } = await servidor("cf-connecting-ip", { limite: 3 });
    abierto = app;
    const formas = ["2001:db8::1", "2001:DB8:0:0:0:0:0:1", "2001:0db8::0001", "2001:db8:0::1"];
    const estados = [];
    for (const forma of formas) {
      estados.push((await app.inject({ method: "GET", url: "/eco", headers: { "cf-connecting-ip": forma } })).statusCode);
    }
    expect(estados).toEqual([200, 200, 200, 429]);

    const otra = await app.inject({ method: "GET", url: "/eco", headers: { "cf-connecting-ip": "2001:db8::2" } });
    expect(otra.statusCode, "otra dirección tiene su propia clave").toBe(200);
  });

  it("el saneamiento ocurre antes del registro inicial, también en una ruta inexistente", async () => {
    const { app, lineas } = await servidor("cf-connecting-ip");
    abierto = app;
    const res = await app.inject({
      method: "GET",
      url: "/no-existe?search=dato",
      headers: { "cf-connecting-ip": "2001:DB8::0001", "x-forwarded-for": "203.0.113.7" },
    });
    expect(res.statusCode).toBe(404);

    const entrada = lineas.find((l) => l.msg === "incoming request") as { req: Record<string, unknown> } | undefined;
    expect(entrada, JSON.stringify(lineas)).toBeDefined();
    expect(entrada!.req.remoteAddress).toBe("2001:db8::1");
    expect(entrada!.req.origenIp).toEqual({ fuente: "cf-connecting-ip" });
    expect(JSON.stringify(lineas), "la cadena declarada por el cliente no llega al registro").not.toContain("203.0.113.7");
  });

  it("el registro de una petición de respaldo dice el motivo, no un valor del cliente", async () => {
    const { app, lineas } = await servidor("cf-connecting-ip");
    abierto = app;
    await app.inject({ method: "GET", url: "/eco", headers: { "cf-connecting-ip": "no-es-ip" }, remoteAddress: "10.0.0.5" });
    const entrada = lineas.find((l) => l.msg === "incoming request") as { req: Record<string, unknown> };
    expect(entrada.req.remoteAddress).toBe("10.0.0.5");
    expect(entrada.req.origenIp).toEqual({ fuente: "respaldo", motivo: "invalida" });
    expect(JSON.stringify(lineas)).not.toContain("no-es-ip");
  });
});

/**
 * Cabeceras repetidas por HTTP REAL (no `inject`, que no puede enviar dos líneas con el mismo
 * nombre): se escribe la petición a mano sobre un socket y la analiza el parser de Node.
 */
describe("cabeceras repetidas por un socket real", () => {
  async function peticionCruda(lineasDeCabecera: string[]): Promise<{ ip: string; origen: unknown }> {
    const { app } = await servidor("cf-connecting-ip");
    abierto = app;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const direccion = app.server.address();
    if (typeof direccion !== "object" || direccion === null) throw new Error("sin dirección de escucha");

    const respuesta = await new Promise<string>((resolver, rechazar) => {
      const socket = connect(direccion.port, "127.0.0.1");
      let datos = "";
      socket.on("data", (d) => (datos += d.toString("utf8")));
      socket.on("end", () => resolver(datos));
      socket.on("error", rechazar);
      socket.write(["GET /eco HTTP/1.1", "Host: localhost", ...lineasDeCabecera, "Connection: close", "", ""].join("\r\n"));
    });
    const cuerpo = respuesta.slice(respuesta.indexOf("\r\n\r\n") + 4);
    const json = cuerpo.slice(cuerpo.indexOf("{"), cuerpo.lastIndexOf("}") + 1);
    return JSON.parse(json);
  }

  it("dos líneas distintas → respaldo, sin elegir ninguna", async () => {
    const r = await peticionCruda(["CF-Connecting-IP: 192.0.2.10", "CF-Connecting-IP: 198.51.100.7"]);
    expect(r.ip).toBe("127.0.0.1");
    expect(r.origen).toEqual({ fuente: "respaldo", motivo: "repetida" });
  });

  it("dos líneas IGUALES también → respaldo", async () => {
    const r = await peticionCruda(["CF-Connecting-IP: 192.0.2.10", "cf-connecting-ip: 192.0.2.10"]);
    expect(r.origen).toEqual({ fuente: "respaldo", motivo: "repetida" });
  });

  it("una sola línea válida se acepta", async () => {
    const r = await peticionCruda(["Cf-Connecting-Ip: 192.0.2.10"]);
    expect(r.ip).toBe("192.0.2.10");
    expect(r.origen).toEqual({ fuente: "cf-connecting-ip" });
  });
});
