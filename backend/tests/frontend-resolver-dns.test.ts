/**
 * GUARDA DE LA RESOLUCIÓN DE LA API EN SEGUNDO PLANO (`frontend/nginx`).
 *
 * REGRESIÓN QUE VIGILA. Con el `proxy_pass` por variable, Nginx resolvía el nombre de la API dentro de la
 * petición, y una respuesta DNS perdida la dejaba 5 s esperando y terminaba en un 502. Con `upstream`, `zone`
 * y `server … resolve`, la resuelve aparte y la petición usa la última dirección conocida.
 *
 * CÓMO SE COMPRUEBA. Se ejecuta el GUION REAL del resolutor con `sh` sobre un `resolv.conf` sintético, y se
 * lee el `upstream` de la plantilla. Se exige cada valor ELEGIDO, no un rango.
 *
 * QUÉ NO COMPRUEBA. Solo verifica la configuración: no ejecuta Nginx. El COMPORTAMIENTO —qué fallos de DNS se
 * toleran, cuáles no, la recuperación y la salida sanitizada— lo comprueba
 * `scripts/diagnostico/simular-dns-nginx.mjs` con la imagen web y DNS controlados; necesita Docker y queda
 * fuera de la integración continua.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const RAIZ = path.join(__dirname, "..", "..");
const leer = (archivo: string) => readFileSync(path.join(RAIZ, "frontend", "nginx", archivo), "utf8");
const GUION = leer("25-resolver.sh");
const efectivas = (t: string) => t.split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
const PLANTILLA = efectivas(leer("default.conf.template").replace(/\r\n/g, "\n"));

/** Reemplaza un texto que debe aparecer una sola vez: si el guion cambia, la prueba lo dice en vez de no probar nada. */
function reemplazarUno(texto: string, de: string, a: string): string {
  expect(texto.split(de), `una sola vez: ${de}`).toHaveLength(2);
  return texto.replace(de, a);
}

function generar(resolvConf: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fchmn-resolver-"));
  try {
    let t = reemplazarUno(GUION.replace(/\r\n/g, "\n"), "DESTINO=/etc/nginx/conf.d/00-resolver.conf", "DESTINO=salida.conf");
    t = reemplazarUno(t, " /etc/resolv.conf 2>/dev/null", " resolv.conf 2>/dev/null");
    writeFileSync(path.join(dir, "guion.sh"), t);
    writeFileSync(path.join(dir, "resolv.conf"), resolvConf);
    const r = spawnSync("sh", ["guion.sh"], { cwd: dir, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return efectivas(readFileSync(path.join(dir, "salida.conf"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("el guion usa finales de línea LF (con CRLF no arrancaría en la imagen)", () => {
  expect(GUION).not.toContain("\r");
});

describe("upstream de la API", () => {
  it("resuelve en segundo plano, con zona compartida y una conexión por petición", () => {
    const inicio = PLANTILLA.indexOf("upstream api_interna {");
    expect(PLANTILLA.slice(inicio, PLANTILLA.indexOf("}", inicio) + 1)).toEqual([
      "upstream api_interna {",
      "zone api_interna 64k;",
      "server ${API_INTERNA} resolve;",
      "keepalive 0;",
      "}",
    ]);
    // A nivel `http`: antes del único `server {`.
    expect(inicio).toBeLessThan(PLANTILLA.indexOf("server {"));
  });

  it("el proxy usa el upstream y ninguna variable vuelve a resolver dentro de la petición", () => {
    expect(PLANTILLA.filter((l) => l.startsWith("proxy_pass"))).toEqual(["proxy_pass http://api_interna;"]);
    expect(PLANTILLA.filter((l) => l.includes("API_INTERNA"))).toEqual(["server ${API_INTERNA} resolve;"]);
    expect(PLANTILLA.filter((l) => /^(proxy_next_upstream|resolver|resolver_timeout)\b/.test(l))).toEqual([]);
  });
});

describe.skipIf(spawnSync("sh", ["-c", "echo ok"]).status !== 0)("resolutor generado, con `sh` disponible", () => {
  it("los dos servidores IPv4, en orden, con la caché de 10 s, sin desactivar IPv6 y con el plazo de 5 s", () => {
    expect(generar("search ejemplo.prueba\nnameserver 192.0.2.53\nnameserver 2001:db8::53\nnameserver 198.51.100.53\noptions ndots:5\n")).toEqual([
      "resolver 192.0.2.53 198.51.100.53 valid=10s;",
      "resolver_timeout 5s;",
    ]);
  });
});
