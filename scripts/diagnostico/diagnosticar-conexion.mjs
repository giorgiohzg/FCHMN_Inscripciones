// =============================================================================
// DIAGNÓSTICO DE LA CONEXIÓN DE NODE A UN DESTINO HTTP(S)
//
//   node scripts/diagnostico/diagnosticar-conexion.mjs --url https://…/api/health
//   API_BASE=https://…/api  node scripts/diagnostico/diagnosticar-conexion.mjs
//
// POR QUÉ EXISTE. `fetch` de Node envuelve TODO fallo de transporte en un
// `TypeError: fetch failed` cuyo `stack` no menciona ni el host, ni el código,
// ni el motivo: lo útil vive en `e.cause`, y a veces un nivel más abajo. Un
// guion que no lo desarma deja al operador sin nada que mirar. Esto separa las
// capas —nombre, puerto, saludo TLS, petición— y dice en cuál se rompió.
//
// NO envía credenciales, NO escribe nada en el sistema remoto y hace una sola
// petición GET a la ruta que se le indique. Apúntelo a un extremo público de
// comprobación de salud, no a uno que requiera sesión.
//
// NO desactiva la validación TLS, y no la desactive usted: el objetivo es
// averiguar POR QUÉ falla, y para eso hay que dejarla activa y leer el error
// exacto. `NODE_TLS_REJECT_UNAUTHORIZED=0` no arregla la validación, la apaga
// para todo el proceso, incluidas las conexiones por las que viajan
// credenciales.
// =============================================================================

import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

function argumento(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

// Sin destino por omisión, a propósito: un diagnóstico que apunta solo a un sitio
// sirve una vez, y un destino escrito en el guion acaba siendo el de alguien.
const destino = argumento("url") ?? (process.env.API_BASE ? process.env.API_BASE.replace(/\/+$/, "") + "/health" : null);
if (!destino) {
  console.error("Falta el destino. Use --url https://…/api/health o exporte API_BASE.");
  process.exit(2);
}

let url;
try {
  url = new URL(destino);
} catch {
  console.error(`«${destino}» no es una URL válida.`);
  process.exit(2);
}
if (url.protocol !== "https:" && url.protocol !== "http:") {
  console.error(`Protocolo no admitido: ${url.protocol}`);
  process.exit(2);
}
const HOST = url.hostname;
const PORT = Number(url.port || (url.protocol === "https:" ? 443 : 80));
const ES_TLS = url.protocol === "https:";

function tit(t) {
  console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));
}

// Enmascara una URL de proxy: deja host y puerto, borra usuario y clave.
function proxySinSecreto(v) {
  if (!v) return null;
  try {
    const u = new URL(v.includes("://") ? v : "http://" + v);
    const cred = u.username || u.password ? " (lleva usuario/clave: OCULTOS)" : "";
    return `${u.protocol}//${u.hostname}:${u.port || "(sin puerto)"}${cred}`;
  } catch {
    return "(valor no interpretable como URL; no se muestra)";
  }
}

// Recorre toda la cadena de causas de un error y saca lo útil de cada nivel.
function explicar(e) {
  const capas = [];
  let cur = e;
  let n = 0;
  while (cur && n < 10) {
    capas.push({
      nivel: n,
      name: cur.name,
      message: cur.message,
      code: cur.code,
      errno: cur.errno,
      syscall: cur.syscall,
      address: cur.address,
      port: cur.port,
      hostname: cur.hostname,
      // Propios de undici / fetch
      ...(cur.cert ? { cert_asunto: cur.cert.subject, cert_emisor: cur.cert.issuer } : {}),
    });
    cur = cur.cause;
    n++;
  }
  return capas;
}

function imprimirError(e) {
  for (const c of explicar(e)) {
    const bits = Object.entries(c)
      .filter(([k, v]) => k !== "nivel" && v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
    console.log(`  causa[${c.nivel}]  ${bits.join("  ")}`);
  }
}

// ---------------------------------------------------------------- 0. entorno
tit("0. ENTORNO DE ESTE PROCESO");
console.log(`Node:     ${process.version}  (${process.platform}/${process.arch})`);
console.log(`destino:  ${url.href}`);
console.log(`host:     ${HOST}   puerto: ${PORT}`);

const VARS_PROXY = [
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
];
let hayProxy = false;
console.log("\nvariables de proxy en este proceso:");
for (const v of VARS_PROXY) {
  if (process.env[v]) {
    hayProxy = true;
    const val = /NO_PROXY/i.test(v) ? process.env[v] : proxySinSecreto(process.env[v]);
    console.log(`  ${v} = ${val}`);
  }
}
if (!hayProxy) console.log("  ninguna definida");

console.log("\nvariables de certificados:");
for (const v of ["NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"]) {
  console.log(`  ${v} = ${process.env[v] ?? "(no definida)"}`);
}
console.log(`  NODE_TLS_REJECT_UNAUTHORIZED = ${process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "(no definida: validación ACTIVA, como debe ser)"}`);
console.log(`  almacén de confianza del sistema cargado: ${tls.rootCertificates.length} raíces integradas de Node`);

// -------------------------------------------------------------------- 1. DNS
tit("1. DNS");
let direcciones = [];
try {
  direcciones = await dns.lookup(HOST, { all: true, verbatim: true });
  for (const d of direcciones) console.log(`  ${HOST} -> ${d.address}  (IPv${d.family})`);
  console.log(`  servidores DNS en uso: ${dns.getServers().join(", ")}`);
} catch (e) {
  console.log("  FALLA la resolución de nombre:");
  imprimirError(e);
}

// ---------------------------------------------------------------- 2. TCP 443
tit(`2. CONEXIÓN TCP AL PUERTO ${PORT}`);
async function probarTcp(direccion) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host: direccion, port: PORT });
    s.setTimeout(10000);
    s.once("connect", () => {
      console.log(`  ${direccion}:${PORT}  ABIERTO  (${Date.now() - t0} ms)`);
      s.destroy();
      resolve(true);
    });
    s.once("timeout", () => {
      console.log(`  ${direccion}:${PORT}  TIEMPO AGOTADO a los 10 s (sin respuesta: cortafuegos silencioso o proxy obligatorio)`);
      s.destroy();
      resolve(false);
    });
    s.once("error", (e) => {
      console.log(`  ${direccion}:${PORT}  ERROR  code=${e.code} syscall=${e.syscall}`);
      s.destroy();
      resolve(false);
    });
  });
}
let algunTcp = false;
for (const d of direcciones.slice(0, 4)) {
  if (await probarTcp(d.address)) algunTcp = true;
}
if (direcciones.length === 0) console.log("  omitido: sin direcciones del paso 1");

// ----------------------------------------------------------- 3. TLS y cadena
tit("3. SALUDO TLS Y CADENA DE CERTIFICADOS");
console.log("Si el emisor del certificado no es el del sitio, hay inspección de tráfico");
console.log("en el camino: una autoridad intermedia está reemitiendo el certificado.\n");
await new Promise((resolve) => {
  if (!ES_TLS) {
    console.log("  omitido: el destino es http://, sin TLS");
    return resolve();
  }
  if (!algunTcp) {
    console.log("  omitido: ninguna conexión TCP se estableció");
    return resolve();
  }
  const s = tls.connect(
    { host: HOST, port: PORT, servername: HOST, rejectUnauthorized: true, timeout: 15000 },
    () => {
      console.log(`  saludo TLS COMPLETADO`);
      console.log(`  autorizado por el almacén de Node: ${s.authorized}`);
      if (s.authorizationError) console.log(`  authorizationError: ${s.authorizationError}`);
      console.log(`  protocolo: ${s.getProtocol()}   ALPN negociado: ${s.alpnProtocol ?? "(ninguno)"}`);
      let c = s.getPeerCertificate(true);
      let i = 0;
      const vistos = new Set();
      while (c && c.fingerprint256 && !vistos.has(c.fingerprint256) && i < 8) {
        vistos.add(c.fingerprint256);
        console.log(`\n  cadena[${i}]`);
        console.log(`    asunto:  ${c.subject?.CN ?? "?"}${c.subject?.O ? "  O=" + c.subject.O : ""}`);
        console.log(`    emisor:  ${c.issuer?.CN ?? "?"}${c.issuer?.O ? "  O=" + c.issuer.O : ""}`);
        console.log(`    validez: ${c.valid_from}  ->  ${c.valid_to}`);
        if (i === 0 && c.subjectaltname) console.log(`    nombres: ${String(c.subjectaltname).slice(0, 200)}`);
        c = c.issuerCertificate;
        i++;
      }
      s.end();
      resolve();
    },
  );
  s.once("timeout", () => { console.log("  TIEMPO AGOTADO en el saludo TLS (15 s)"); s.destroy(); resolve(); });
  s.once("error", (e) => {
    console.log("  saludo TLS RECHAZADO:");
    imprimirError(e);
    // Reintento SIN validar, solo para LEER quién firma. No se envía nada.
    console.log("\n  Reintento de solo lectura de la cadena (no se transmite ningún dato,");
    console.log("  no se usa esta conexión para nada más, y la validación sigue exigida");
    console.log("  en todo lo demás del procedimiento):");
    const s2 = tls.connect({ host: HOST, port: PORT, servername: HOST, rejectUnauthorized: false, timeout: 15000 }, () => {
      let c = s2.getPeerCertificate(true);
      let i = 0;
      const vistos = new Set();
      while (c && c.fingerprint256 && !vistos.has(c.fingerprint256) && i < 8) {
        vistos.add(c.fingerprint256);
        console.log(`    cadena[${i}]  asunto=${c.subject?.CN ?? "?"}  emisor=${c.issuer?.CN ?? "?"}  O=${c.issuer?.O ?? "?"}`);
        c = c.issuerCertificate;
        i++;
      }
      s2.end();
      resolve();
    });
    s2.once("error", () => resolve());
    s2.once("timeout", () => { s2.destroy(); resolve(); });
  });
});

// -------------------------------------------------- 4. node:https (sin fetch)
tit(`4. PETICIÓN CON node:${ES_TLS ? "https" : "http"} (camino clásico, NO undici)`);
let respondioElClasico = false;
await new Promise((resolve) => {
  const t0 = Date.now();
  const req = (ES_TLS ? https : http).request(
    { host: HOST, port: PORT, path: url.pathname + url.search, method: "GET", timeout: 30000, headers: { "user-agent": "diagnostico-de-conexion" } },
    (res) => {
      let cuerpo = "";
      res.on("data", (d) => (cuerpo += d));
      res.on("end", () => {
        respondioElClasico = true;
        console.log(`  HTTP ${res.statusCode} en ${Date.now() - t0} ms`);
        console.log(`  cuerpo: ${cuerpo.slice(0, 300)}`);
        resolve();
      });
    },
  );
  req.once("timeout", () => { console.log("  TIEMPO AGOTADO (30 s)"); req.destroy(); resolve(); });
  req.once("error", (e) => { console.log("  ERROR:"); imprimirError(e); resolve(); });
  req.end();
});

// ------------------------------------------------------ 5. fetch (lo que usa el cargador)
tit("5. PETICIÓN CON fetch (undici: el camino que usan los guiones del proyecto)");
let respondioFetch = false;
for (const ms of [15000, 60000]) {
  const t0 = Date.now();
  try {
    const r = await fetch(url.href, { signal: AbortSignal.timeout(ms) });
    const txt = await r.text();
    respondioFetch = true;
    console.log(`  espera ${ms / 1000}s -> HTTP ${r.status} en ${Date.now() - t0} ms`);
    console.log(`  cuerpo: ${txt.slice(0, 300)}`);
    break;
  } catch (e) {
    console.log(`  espera ${ms / 1000}s -> FALLA tras ${Date.now() - t0} ms`);
    imprimirError(e);
  }
}

tit("FIN");
console.log("Ninguna credencial se usó ni se transmitió. Nada se escribió en el destino.");

// El código de salida lleva el veredicto. Un diagnóstico que imprime fallos y
// termina en 0 es inútil en cualquier automatización: no se puede encadenar.
if (respondioElClasico && respondioFetch) {
  console.log("VEREDICTO: el destino responde por los dos caminos.");
} else if (respondioElClasico !== respondioFetch) {
  console.log(
    `VEREDICTO: responde por node:${ES_TLS ? "https" : "http"} = ${respondioElClasico}, por fetch = ${respondioFetch}. ` +
      "Que uno funcione y el otro no apunta al cliente, no a la red."
  );
  process.exitCode = 1;
} else {
  console.log("VEREDICTO: el destino NO respondió. Mire en qué paso se rompió, más arriba.");
  process.exitCode = 1;
}
