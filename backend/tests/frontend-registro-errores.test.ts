/**
 * GUARDA DEL RECEPTOR DE ERRORES DE PETICIÓN DE NGINX (AUD-03, capa Nginx).
 *
 * Dos partes:
 *   - El MANEJADOR njs (`frontend/nginx/njs/registro-errores.js`), ejecutado aquí con Node: la salida
 *     solo puede tener la forma permitida, nunca copia el datagrama, y ninguna excepción —forzada en cada
 *     etapa— escapa ni produce otra cosa que el respaldo constante.
 *   - La CONFIGURACIÓN (`nginx.conf`, `default.conf.template`, `Dockerfile`): receptor solo en loopback,
 *     sin bucle, errores del servidor por syslog y la configuración principal de la imagen conservada.
 *
 * QUÉ NO COMPRUEBA. No ejecuta Nginx ni njs: el motor real (njs 1.0.2) se comprobó con la imagen
 * candidata, fuera de la integración continua (ver el plan de seguridad). Node y njs comparten la
 * semántica de lo que usa este archivo (cadenas, `RegExp` simples, `try`/`catch`).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RAIZ = path.join(__dirname, "..", "..");
const leer = (...partes: string[]) => readFileSync(path.join(RAIZ, ...partes), "utf8").replace(/\r\n/g, "\n");

type Sesion = { on: (ev: string, cb: (data: unknown) => void) => void; off: (ev: string) => void; warn: (l: string) => void; done: () => void };
type Etapas = { texto: (d: unknown) => unknown; proyectar: (t: unknown) => unknown; serializar: (r: unknown) => unknown };
type Modulo = {
  recibir: (s: Sesion) => void;
  procesar: (s: Sesion, data: unknown) => void;
  proyectar: (t: string) => { nivel: string; clase: string; errno: number | string };
  serializar: (r: unknown) => string;
  texto: (d: unknown) => string;
  crearProcesador: (e: Etapas) => (s: Sesion, data: unknown) => void;
  crearReceptor: (p: (s: Sesion, data: unknown) => void) => (s: Sesion) => void;
  PERMITIDA: RegExp;
  RESPALDO: string;
};

let m: Modulo;
beforeAll(async () => {
  const url = pathToFileURL(path.join(RAIZ, "frontend", "nginx", "njs", "registro-errores.js")).href;
  m = ((await import(url)) as { default: Modulo }).default;
});

const MARCA = "MARCA_SINT_7Q2";
const CLAVES = ["canal", "clase", "errno", "nivel"];

/** Sesión falsa: guarda lo emitido y permite hacer fallar cualquier método. */
function sesion(falla: Partial<Record<keyof Sesion, boolean>> = {}) {
  const emitidas: string[] = [];
  const llamadas: string[] = [];
  let cb: ((data: unknown) => void) | undefined;
  const s: Sesion = {
    on: (_ev, f) => { llamadas.push("on"); if (falla.on) throw new Error(`on ${MARCA}`); cb = f; },
    off: () => { llamadas.push("off"); if (falla.off) throw new Error(`off ${MARCA}`); },
    warn: (l) => { llamadas.push("warn"); if (falla.warn) throw new Error(`warn ${MARCA} ${l}`); emitidas.push(l); },
    done: () => { llamadas.push("done"); if (falla.done) throw new Error(`done ${MARCA}`); },
  };
  return { s, emitidas, llamadas, entregar: (d: unknown) => cb?.(d) };
}

/** Una línea emitida: forma permitida, esquema exacto y sin rastro del marcador. */
function permitida(linea: string) {
  expect(linea).toMatch(m.PERMITIDA);
  expect(linea).not.toContain(MARCA);
  expect(Object.keys(JSON.parse(linea) as object).sort()).toEqual(CLAVES);
}

const H = "<187>Nov  9 13:00:00 fchmn: 2026/11/09 13:00:00 [error] 30#30: *1 ";
const CTX = `, client: 127.0.0.1, server: , request: "GET /api/persons?search=${MARCA} HTTP/1.1", upstream: "http://10.0.0.1:3000/persons?search=${MARCA}", host: "x", referrer: "http://x/?q=${MARCA}"`;

describe("proyección de mensajes reales de Nginx", () => {
  const casos: [string, string, number | string, string][] = [
    ["connect() failed (111: Connection refused) while connecting to upstream", "conexion_rechazada", 111, "error"],
    ["api.interna could not be resolved (3: Host not found)", "dns", "otro", "error"],
    ["upstream timed out (110: Operation timed out) while reading response header from upstream", "timeout", 110, "error"],
    ["upstream sent no valid HTTP/1.0 header while reading response header from upstream", "respuesta_invalida", "ninguno", "error"],
    ["readv() failed (104: Connection reset by peer) while reading upstream", "lectura_upstream", 104, "error"],
    ["upstream prematurely closed connection while reading response header from upstream", "cierre_prematuro", "ninguno", "error"],
    ["client intended to send too large body: 30000000 bytes", "cuerpo_excesivo", "ninguno", "error"],
    ['open() "/usr/share/nginx/html/assets/x.js" failed (2: No such file or directory)', "archivo", 2, "error"],
  ];
  for (const [mensaje, clase, errno, nivel] of casos) {
    it(`${clase}`, () => {
      const { s, emitidas } = sesion();
      m.procesar(s, H + mensaje + CTX);
      expect(emitidas).toHaveLength(1);
      permitida(emitidas[0]!);
      expect(JSON.parse(emitidas[0]!)).toEqual({ canal: "errores_peticion", nivel, clase, errno });
    });
  }

  it("el alert que copia uri?args en su propio texto no deja pasar nada", () => {
    const { s, emitidas } = sesion();
    m.procesar(s, `<185>x: [alert] 1#1: *1 http finalize non-active request: "/api/persons?search=${MARCA}"` + CTX);
    permitida(emitidas[0]!);
    expect(JSON.parse(emitidas[0]!)).toMatchObject({ nivel: "alert", clase: "finalizacion_no_activa" });
  });
});

describe("entradas hostiles, desconocidas, truncadas o codificadas: solo campos permitidos", () => {
  const entradas: [string, string][] = [
    ["formato desconocido", `hola ${MARCA}`],
    ["truncado", `${H}connect() failed (11`],
    ["errno fuera del conjunto", `<187>x connect() failed (9999: ${MARCA})`],
    ["clase solo en el contexto", `<187>x algo, client: 1.2.3.4, request: "GET /?q=connect() failed (111: ${MARCA}"`],
    ["PRI fuera de rango", `<999>x upstream timed out (110: ${MARCA})`],
    ["PRI de texto", `<abc>x ${MARCA}`],
    ["comillas y saltos", `${H}connect() failed (111: x) "${MARCA}"\r\nInyect: ${MARCA}` + CTX],
    ["codificado", `${H}open() "/x" failed (2: x), request: "GET /a?q=${MARCA}%22%0A%C3%91+%2B HTTP/1.1"`],
    ["inyección JSON", `<187>x "}{"clase":"${MARCA}","nivel":"${MARCA}`],
    ["bytes no UTF-8", `<187>x ÿþÃ ${MARCA}`],
    ["muy largo", `<187>x upstream prematurely closed ${"A".repeat(20000)} ${MARCA}`],
    ["vacío", ""],
  ];
  for (const [nombre, entrada] of entradas) {
    it(nombre, () => {
      const { s, emitidas } = sesion();
      m.procesar(s, entrada);
      expect(emitidas).toHaveLength(1);
      permitida(emitidas[0]!);
    });
  }

  it("datos que no son cadena (Buffer, número, nulo, objeto)", () => {
    for (const d of [Buffer.from(`${H}connect() failed (111: x)${CTX}`), 42, null, undefined, { a: MARCA }]) {
      const { s, emitidas } = sesion();
      m.procesar(s, d);
      permitida(emitidas[0]!);
    }
  });
});

describe("excepciones forzadas en cada etapa: nada escapa y solo se emite el respaldo", () => {
  const lanza = () => { throw new Error(`fallo ${MARCA}`); };
  const etapasReales = (): Etapas => ({ texto: m.texto, proyectar: m.proyectar as Etapas["proyectar"], serializar: m.serializar as Etapas["serializar"] });

  const forzados: [string, Partial<Etapas>][] = [
    ["conversión", { texto: lanza }],
    ["clasificación", { proyectar: lanza }],
    ["serialización", { serializar: lanza }],
    ["serialización que devuelve datos", { serializar: () => `{"canal":"errores_peticion","nivel":"${MARCA}"}` }],
    ["serialización que devuelve un objeto hostil", { serializar: () => ({ toString: lanza }) }],
    ["clasificación que devuelve valores hostiles", { proyectar: () => ({ nivel: MARCA, clase: MARCA, errno: MARCA }) }],
  ];
  for (const [etapa, cambio] of forzados) {
    it(etapa, () => {
      const p = m.crearProcesador({ ...etapasReales(), ...cambio });
      const { s, emitidas, llamadas } = sesion();
      expect(() => p(s, `${H}connect() failed (111: x)${CTX}`)).not.toThrow();
      expect(emitidas).toEqual([m.RESPALDO]);
      permitida(emitidas[0]!);
      expect(llamadas).toEqual(["warn", "off", "done"]);
    });
  }

  it("datos cuyo toString lanza con contenido o devuelve un objeto", () => {
    for (const d of [{ toString: lanza }, { toString: () => ({}) }, Object.create(null)]) {
      const { s, emitidas } = sesion();
      expect(() => m.procesar(s, d)).not.toThrow();
      expect(emitidas).toEqual([m.RESPALDO]);
    }
  });

  for (const metodo of ["warn", "off", "done"] as const) {
    it(`s.${metodo} lanza: no escapa y los pasos siguientes se ejecutan`, () => {
      const { s, llamadas } = sesion({ [metodo]: true });
      expect(() => m.procesar(s, `${H}connect() failed (111: x)${CTX}`)).not.toThrow();
      expect(llamadas).toEqual(["warn", "off", "done"]);
    });
  }

  it("si la emisión falla no hay reintento ni recursión: un solo intento", () => {
    const { s, llamadas } = sesion({ warn: true });
    m.procesar(s, `${H}connect() failed (111: x)${CTX}`);
    expect(llamadas.filter((l) => l === "warn")).toHaveLength(1);
  });

  it("el respaldo tiene exactamente el esquema normal", () => {
    permitida(m.RESPALDO);
    expect(JSON.parse(m.RESPALDO)).toEqual({ canal: "errores_peticion", nivel: "desconocido", clase: "error_interno", errno: "ninguno" });
  });
});

describe("registro del callback", () => {
  it("recibir registra un único callback que procesa el datagrama", () => {
    const { s, emitidas, llamadas, entregar } = sesion();
    m.recibir(s);
    expect(llamadas).toEqual(["on"]);
    entregar(`${H}connect() failed (111: x)${CTX}`);
    permitida(emitidas[0]!);
    expect(JSON.parse(emitidas[0]!)).toMatchObject({ clase: "conexion_rechazada" });
  });

  it("s.on lanza: no escapa, emite el respaldo y termina la sesión", () => {
    const { s, emitidas, llamadas } = sesion({ on: true });
    expect(() => m.recibir(s)).not.toThrow();
    expect(emitidas).toEqual([m.RESPALDO]);
    expect(llamadas).toEqual(["on", "warn", "done"]);
  });

  it("s.on, s.warn y s.done lanzan a la vez: nada escapa", () => {
    const { s } = sesion({ on: true, warn: true, done: true });
    expect(() => m.recibir(s)).not.toThrow();
  });

  it("un procesador que lanzara dentro del callback tampoco escapa", () => {
    const r = m.crearReceptor(vi.fn(() => { throw new Error(`fallo ${MARCA}`); }));
    const { s, entregar } = sesion();
    r(s);
    expect(() => entregar("x")).not.toThrow();
  });
});

describe("configuración", () => {
  const NGINX = leer("frontend", "nginx", "nginx.conf");
  const SERVIDOR = leer("frontend", "nginx", "default.conf.template");
  const DOCKERFILE = leer("frontend", "Dockerfile");
  const efectivas = (t: string) => t.split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
  const nginx = efectivas(NGINX);
  const servidor = efectivas(SERVIDOR);

  it("conserva la configuración principal de la imagen oficial", () => {
    for (const d of [
      "user  nginx;", "error_log  /var/log/nginx/error.log notice;", "pid        /run/nginx.pid;",
      "worker_connections  1024;", "include       /etc/nginx/mime.types;", "default_type  application/octet-stream;",
      "access_log  /var/log/nginx/access.log  main;", "sendfile        on;", "keepalive_timeout  65;",
      "include /etc/nginx/conf.d/*.conf;",
    ]) expect(nginx, d).toContain(d);
    // `30-tune-worker-processes.sh` busca la directiva al principio de línea.
    expect(NGINX).toMatch(/^worker_processes {2}auto;$/m);
  });

  it("carga solo el módulo njs de stream", () => {
    expect(nginx.filter((l) => l.startsWith("load_module"))).toEqual(["load_module modules/ngx_stream_js_module.so;"]);
  });

  it("el receptor escucha solo en loopback por UDP y su registro no es syslog (sin bucle)", () => {
    const stream = NGINX.slice(NGINX.indexOf("\nstream {"));
    const lineas = efectivas(stream);
    expect(lineas.filter((l) => l.startsWith("listen"))).toEqual(["listen 127.0.0.1:5140 udp;"]);
    expect(lineas.filter((l) => l.startsWith("error_log"))).toEqual(["error_log  /var/log/nginx/error.log notice;"]);
    expect(stream).not.toMatch(/syslog:/);
    expect(lineas).toContain("js_import registro_errores from /etc/nginx/njs/registro-errores.js;");
    expect(lineas).toContain("js_preread registro_errores.recibir;");
  });

  it("el servidor web envía sus errores al receptor y ninguna location lo reemplaza", () => {
    expect(servidor.filter((l) => l.startsWith("error_log"))).toEqual(["error_log syslog:server=127.0.0.1:5140,nohostname,tag=fchmn notice;"]);
  });

  it("el Dockerfile copia la configuración y el manejador donde nginx.conf los espera, sin publicar UDP", () => {
    expect(DOCKERFILE).toMatch(/^COPY nginx\/nginx\.conf \/etc\/nginx\/nginx\.conf$/m);
    expect(DOCKERFILE).toMatch(/^COPY nginx\/njs\/registro-errores\.js \/etc\/nginx\/njs\/registro-errores\.js$/m);
    expect(efectivas(DOCKERFILE).filter((l) => l.startsWith("EXPOSE"))).toEqual(["EXPOSE 80"]);
  });
});
