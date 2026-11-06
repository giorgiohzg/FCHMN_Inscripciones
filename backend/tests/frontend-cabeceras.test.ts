/**
 * GUARDA DE LAS CABECERAS DE SEGURIDAD DEL FRONTEND (Fase 3).
 *
 * POR QUÉ EXISTE. La política vive en TRES archivos que se entienden entre sí y que se
 * pueden romper con una edición inocente sin que nada falle al construir:
 *
 *   - `frontend/nginx/snippets/cabeceras-seguridad.conf.template`: las cabeceras;
 *   - `frontend/nginx/default.conf.template`: DÓNDE se incluyen (solo en las ubicaciones
 *     estáticas, nunca en `/api/` ni a nivel `server`);
 *   - `frontend/Dockerfile`: qué variables sustituye `envsubst` y dónde queda el fragmento.
 *
 * Los síntomas serían cabeceras duplicadas en `/api/`, una CSP que se queda sin
 * `connect-src` (la web carga y no puede llamar a la API) o un fragmento cargado como
 * configuración global por el `include conf.d/*.conf` de la imagen.
 *
 * QUÉ NO COMPRUEBA. No construye la imagen ni ejecuta Nginx: lee archivos y ejecuta el guion
 * de validación con `sh`. Que lo construido se comporte como lo escrito se comprobó con la
 * imagen real y un navegador, fuera de la integración continua (ver el plan de seguridad).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const RAIZ = path.join(__dirname, "..", "..");
const leer = (...partes: string[]) => readFileSync(path.join(RAIZ, ...partes), "utf8").replace(/\r\n/g, "\n");

const SNIPPET = leer("frontend", "nginx", "snippets", "cabeceras-seguridad.conf.template");
const SERVIDOR = leer("frontend", "nginx", "default.conf.template");
const DOCKERFILE = leer("frontend", "Dockerfile");
const COMPOSE = leer("docker-compose.yml");
const GUION = path.join(RAIZ, "frontend", "nginx", "18-validar-csp.sh");

const INCLUDE = "include /etc/nginx/conf.d/snippets/cabeceras-seguridad.conf;";

/** Líneas efectivas del fragmento: sin comentarios ni vacías. */
const directivas = SNIPPET.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

/** El cuerpo de un bloque `location ... { ... }` del servidor, por su encabezado exacto. */
function bloque(encabezado: string): string {
  const inicio = SERVIDOR.indexOf(`${encabezado} {`);
  if (inicio < 0) throw new Error(`no hay «${encabezado}»`);
  let prof = 0;
  for (let i = SERVIDOR.indexOf("{", inicio); i < SERVIDOR.length; i++) {
    if (SERVIDOR[i] === "{") prof++;
    if (SERVIDOR[i] === "}" && --prof === 0) return SERVIDOR.slice(inicio, i + 1);
  }
  throw new Error(`bloque sin cerrar: ${encabezado}`);
}

/** El texto sin las líneas de comentario, para no confundir la prosa con la configuración. */
const sinComentarios = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("fragmento de cabeceras", () => {
  const valor = (nombre: string) => {
    const l = directivas.filter((d) => d.startsWith(`add_header ${nombre} `));
    expect(l, `una sola cabecera ${nombre}`).toHaveLength(1);
    return l[0]!;
  };

  it("declara exactamente las cinco cabeceras, todas con `always`", () => {
    expect(directivas).toHaveLength(5);
    for (const d of directivas) {
      expect(d.startsWith("add_header ")).toBe(true);
      expect(d.endsWith(" always;"), d).toBe(true);
    }
  });

  it("la CSP tiene las directivas previstas y `connect-src` viene de CSP_CONNECT_SRC", () => {
    const csp = valor("Content-Security-Policy");
    for (const d of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self'",
      "font-src 'self'",
      "connect-src ${CSP_CONNECT_SRC}",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ]) {
      expect(csp, d).toContain(d);
    }
  });

  it("la CSP no abre nada por comodidad: sin comodines, unsafe-*, data:, blob: ni esquemas sueltos", () => {
    const csp = valor("Content-Security-Policy");
    expect(csp).not.toMatch(/unsafe-/);
    expect(csp).not.toMatch(/\*/);
    expect(csp).not.toMatch(/\bdata:|\bblob:|\bhttps?:(?!\/\/)/);
    expect(csp).not.toMatch(/report-uri|report-to/);
    expect(csp).not.toMatch(/Report-Only/i);
  });

  it("enmarcado: X-Frame-Options DENY coherente con frame-ancestors 'none'", () => {
    expect(valor("X-Frame-Options")).toContain('"DENY"');
    expect(valor("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("nosniff y no-referrer", () => {
    expect(valor("X-Content-Type-Options")).toContain('"nosniff"');
    expect(valor("Referrer-Policy")).toContain('"no-referrer"');
  });

  it("HSTS: el mismo valor que envía la API con helmet, y sin `preload`", async () => {
    const helmet = (await import("helmet")).default;
    const cabeceras: Record<string, string> = {};
    helmet()(
      { headers: {} } as never,
      { setHeader: (k: string, v: string) => (cabeceras[k] = v), removeHeader: () => undefined, getHeader: () => undefined } as never,
      () => undefined
    );
    const api = cabeceras["Strict-Transport-Security"];
    expect(api, "helmet debe enviar HSTS").toBeTruthy();
    expect(valor("Strict-Transport-Security")).toContain(`"${api}"`);
    expect(valor("Strict-Transport-Security")).not.toMatch(/preload/i);
  });

  it("la única variable de la plantilla es CSP_CONNECT_SRC", () => {
    const usadas = [...sinComentarios(SNIPPET).matchAll(/\$\{?([A-Za-z_]+)\}?/g)].map((m) => m[1]);
    expect(new Set(usadas)).toEqual(new Set(["CSP_CONNECT_SRC"]));
  });
});

describe("dónde se incluye el fragmento", () => {
  it("en `/`, `/assets/` y `= /index.html`, y en ningún otro sitio", () => {
    for (const enc of ["location /", "location /assets/", "location = /index.html"]) {
      expect(bloque(enc), enc).toContain(INCLUDE);
    }
    expect(sinComentarios(SERVIDOR).split(INCLUDE).length - 1).toBe(3);
  });

  it("NO en `/api/`: la API ya envía sus cabeceras y se duplicarían", () => {
    const api = sinComentarios(bloque("location /api/"));
    expect(api).not.toContain("snippets");
    expect(api).not.toMatch(/add_header/);
  });

  it("NO a nivel `server` ni `http`: ningún add_header suelto fuera de las ubicaciones", () => {
    let resto = SERVIDOR;
    for (const enc of ["location /api/", "location /assets/", "location = /index.html", "location /"]) {
      resto = resto.replace(bloque(enc), "");
    }
    resto = sinComentarios(resto);
    expect(resto).toContain("server_tokens off;"); // lo que queda es el resto del servidor
    expect(resto).not.toMatch(/add_header/);
    expect(resto).not.toContain(INCLUDE);
  });

  it("conserva el caché de los assets y el no-store de index.html", () => {
    expect(bloque("location /assets/")).toContain('add_header Cache-Control "public, immutable";');
    expect(bloque("location /assets/")).toContain("expires 1y;");
    expect(bloque("location /assets/")).toContain("try_files $uri =404;");
    expect(bloque("location = /index.html")).toContain('add_header Cache-Control "no-store";');
  });

  it("conserva el fallback de la SPA, el proxy de /api y la reescritura de cookies", () => {
    expect(bloque("location /")).toContain("try_files $uri $uri/ /index.html;");
    const api = bloque("location /api/");
    expect(api).toContain('set $destino_api "${API_INTERNA}";');
    expect(api).toContain("proxy_cookie_path /auth /api/auth;");
    expect(SERVIDOR).toContain("listen ${PORT};");
  });
});

describe("Dockerfile del frontend", () => {
  const filtro = /ENV NGINX_ENVSUBST_FILTER="([^"]+)"/.exec(DOCKERFILE)?.[1];

  it("el filtro de envsubst sustituye SOLO PORT, API_INTERNA y CSP_CONNECT_SRC", () => {
    expect(filtro).toBe("^(PORT|API_INTERNA|CSP_CONNECT_SRC)$");
    const re = new RegExp(filtro!);
    for (const si of ["PORT", "API_INTERNA", "CSP_CONNECT_SRC"]) expect(re.test(si), si).toBe(true);
    // Las variables propias de Nginx y nombres parecidos NO deben alcanzarse.
    for (const no of ["uri", "host", "esquema_original", "destino_api", "MY_PORT", "PORT2", "API_INTERNA_X", "XCSP_CONNECT_SRC", "API_URL_COMPILADA"]) {
      expect(re.test(no), no).toBe(false);
    }
  });

  it("CSP_CONNECT_SRC vale 'self' por omisión y se guarda la URL compilada del bundle", () => {
    expect(DOCKERFILE).toContain(`ENV CSP_CONNECT_SRC="'self'"`);
    expect(DOCKERFILE).toMatch(/ARG VITE_API_URL=http:\/\/localhost:3000\nENV API_URL_COMPILADA=\$\{VITE_API_URL\}/);
  });

  it("el fragmento va a templates/snippets (no a conf.d) y el validador a entrypoint.d", () => {
    expect(DOCKERFILE).toContain("/etc/nginx/templates/snippets/cabeceras-seguridad.conf.template");
    expect(DOCKERFILE).not.toMatch(/COPY [^\n]*\/etc\/nginx\/conf\.d/);
    expect(DOCKERFILE).toMatch(/COPY --chmod=0755 nginx\/18-validar-csp\.sh \/docker-entrypoint\.d\/18-validar-csp\.sh/);
    // El validador corre antes de `20-envsubst-on-templates.sh`, que escribe la configuración.
    expect(Number(/docker-entrypoint\.d\/(\d+)-validar-csp/.exec(DOCKERFILE)?.[1])).toBeLessThan(20);
  });

  it("conserva PORT, API_INTERNA y el guion del resolutor", () => {
    expect(DOCKERFILE).toContain("ENV PORT=80");
    expect(DOCKERFILE).toContain("ENV API_INTERNA=backend:3000");
    expect(DOCKERFILE).toContain("25-resolver.sh");
  });
});

describe("Docker Compose", () => {
  // Resolución de `${VAR}` / `${VAR:-por omisión}` como la hace Compose (con el
  // entorno dado), para comprobar los valores EFECTIVOS y no solo el texto del YAML.
  const resolver = (plantilla: string, entorno: Record<string, string>): string =>
    plantilla.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_m, nombre: string, defecto?: string) => {
      const v = entorno[nombre];
      return v !== undefined && v !== "" ? v : (defecto ?? "");
    });
  const linea = (clave: string) => {
    const m = COMPOSE.match(new RegExp(String.raw`^\s+${clave}:\s*(.+)$`, "m"));
    if (!m) throw new Error(`falta ${clave} en docker-compose.yml`);
    return m[1].trim().replace(/^"(.*)"$/, "$1");
  };
  const efectivos = (entorno: Record<string, string>) => ({
    compilada: resolver(linea("VITE_API_URL"), entorno),
    csp: resolver(linea("CSP_CONNECT_SRC"), entorno),
  });
  const hay = spawnSync("sh", ["-c", "echo ok"]).status === 0;
  const valida = (entorno: Record<string, string>) => {
    const { compilada, csp } = efectivos(entorno);
    const r = spawnSync("sh", [GUION], {
      env: { PATH: process.env.PATH ?? "", API_URL_COMPILADA: compilada, CSP_CONNECT_SRC: csp },
      encoding: "utf8",
    });
    return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
  };

  it("no confunde el connect-src del navegador con API_INTERNA y sigue pasando VITE_API_URL al build", () => {
    expect(COMPOSE).toContain("API_INTERNA: backend:3000");
    expect(linea("VITE_API_URL")).toBe("${VITE_API_URL:-http://localhost:3000}");
    expect(linea("CSP_CONNECT_SRC")).toBe("${CSP_CONNECT_SRC:-'self' http://localhost:3000}");
  });

  it("la CSP ya no se construye copiando VITE_API_URL (que puede llevar ruta)", () => {
    expect(linea("CSP_CONNECT_SRC")).not.toContain("VITE_API_URL");
  });

  describe.skipIf(!hay)("valores efectivos aceptados o rechazados por el validador", () => {
    it("uso local por omisión", () => {
      expect(efectivos({})).toEqual({ compilada: "http://localhost:3000", csp: "'self' http://localhost:3000" });
      expect(valida({}).codigo).toBe(0);
    });

    it("API relativa /api con 'self'", () => {
      const e = { VITE_API_URL: "/api", CSP_CONNECT_SRC: "'self'" };
      expect(efectivos(e).csp).toBe("'self'");
      expect(valida(e).codigo).toBe(0);
    });

    it("API absoluta con ruta: el origen, sin la ruta", () => {
      const e = { VITE_API_URL: "https://api.ejemplo.cl/api", CSP_CONNECT_SRC: "'self' https://api.ejemplo.cl" };
      expect(valida(e).codigo).toBe(0);
    });

    it("sobrescribir CSP_CONNECT_SRC prevalece sobre el valor por omisión", () => {
      const e = { CSP_CONNECT_SRC: "'self' http://localhost:3000 http://127.0.0.1:3000" };
      expect(efectivos(e).csp).toBe(e.CSP_CONNECT_SRC);
      expect(valida(e).codigo).toBe(0);
    });

    it("rechaza una política que no admite el destino compilado", () => {
      // Con /api y sin declarar nada se acepta (el valor local incluye 'self'), pero deja
      // abierto http://localhost:3000: en la nube conviene declarar solo 'self'.
      expect(valida({ VITE_API_URL: "/api" }).codigo).toBe(0);
      expect(valida({ VITE_API_URL: "/api", CSP_CONNECT_SRC: "https://api.ejemplo.cl" }).codigo).toBe(1);
      const r2 = valida({ VITE_API_URL: "https://api.ejemplo.cl/api" });
      expect(r2.codigo).toBe(1);
      expect(r2.salida).toContain("https://api.ejemplo.cl");
      const r3 = valida({ VITE_API_URL: "https://api.ejemplo.cl/api", CSP_CONNECT_SRC: "'self' https://otro.ejemplo.cl" });
      expect(r3.codigo).toBe(1);
    });

    it("rechaza declarar la URL con ruta en lugar del origen", () => {
      const r = valida({ VITE_API_URL: "https://api.ejemplo.cl/api", CSP_CONNECT_SRC: "'self' https://api.ejemplo.cl/api" });
      expect(r.codigo).toBe(1);
      expect(r.salida).toContain("ruta");
    });
  });
});

describe("guion de validación de CSP_CONNECT_SRC", () => {
  const hay = spawnSync("sh", ["-c", "echo ok"]).status === 0;
  const ejecutar = (csp: string | undefined, compilada: string) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", API_URL_COMPILADA: compilada };
    if (csp !== undefined) env.CSP_CONNECT_SRC = csp;
    const r = spawnSync("sh", [GUION], { env, encoding: "utf8" });
    return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
  };

  it("el guion usa finales de línea LF (con CRLF no arrancaría en la imagen)", () => {
    expect(readFileSync(GUION, "utf8")).not.toContain("\r");
  });

  describe.skipIf(!hay)("con `sh` disponible", () => {
    it.each([
      ["'self'", "/api"],
      ["'self'", ""],
      ["'self' https://api.ejemplo.cl", "/api"],
      ["'self' http://localhost:3000", "http://localhost:3000"],
      ["http://localhost:3000", "http://localhost:3000/"],
      ["'self' https://api.ejemplo.cl:8443 wss://api.ejemplo.cl", "https://api.ejemplo.cl:8443"],
      ["'self' http://[::1]:3000", "/api"],
    ])("acepta %j con el bundle compilado en %j", (csp, compilada) => {
      expect(ejecutar(csp, compilada).codigo).toBe(0);
    });

    it.each<[string, string | undefined, string]>([
      ["vacío", "", "está vacío"],
      ["sin definir", undefined, "está vacío"],
      ["comodín", "'self' *", "comodines"],
      ["comodín en el host", "'self' https://*.ejemplo.cl", "comodines"],
      ["unsafe-inline", "'self' 'unsafe-inline'", "no admite"],
      ["unsafe-eval", "'self' 'unsafe-eval'", "no admite"],
      ["none", "'none'", "no admite"],
      ["data:", "'self' data:", "esquema abierto"],
      ["blob:", "'self' blob:", "esquema abierto"],
      ["esquema suelto", "'self' https:", "esquema abierto"],
      ["con ruta", "'self' https://api.ejemplo.cl/v1", "ruta"],
      ["con consulta", "'self' https://api.ejemplo.cl?x=1", "ruta"],
      ["punto y coma (inyectaría otra directiva)", "'self'; script-src *", "punto y coma"],
      ["comillas dobles", "'self' https://a.cl\"x", "comillas dobles"],
      ["signo de dólar", "'self' https://$HOST", "dólar"],
      ["esquema desconocido", "'self' ftp://x.cl", "no entiendo"],
      ["origen sin host", "'self' http://", "no es un origen válido"],
      ["host inválido", "'self' https://exa_mple.cl", "no es un origen válido"],
      ["texto suelto", "'self' localhost", "no entiendo"],
    ])("rechaza %s", (_nombre, csp, texto) => {
      const r = ejecutar(csp, "/api");
      expect(r.codigo).toBe(1);
      expect(r.salida).toContain("CSP_CONNECT_SRC no es válido");
      expect(r.salida).toContain(texto);
    });

    it("el comodín se rechaza por sí mismo y no por expandirse contra los archivos del directorio", () => {
      expect(ejecutar("*", "/api").salida).toContain("comodines");
    });

    it("rechaza si el bundle llama a un origen que la política no admite", () => {
      const r = ejecutar("'self'", "http://localhost:3000");
      expect(r.codigo).toBe(1);
      expect(r.salida).toContain("http://localhost:3000");
      expect(ejecutar("'self' https://otra.cl", "https://api.ejemplo.cl").codigo).toBe(1);
    });

    it("rechaza si el bundle usa una ruta del mismo origen y falta 'self'", () => {
      const r = ejecutar("https://api.ejemplo.cl", "/api");
      expect(r.codigo).toBe(1);
      expect(r.salida).toContain("falta 'self'");
    });

    it("rechaza una URL compilada que no es ruta ni origen (p. ej. una ruta de Windows)", () => {
      const r = ejecutar("'self'", "C:/Program Files/Git/api");
      expect(r.codigo).toBe(1);
      expect(r.salida).toContain("no es una ruta ni un origen");
    });
  });
});
