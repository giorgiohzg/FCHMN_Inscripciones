// =============================================================================
// SIMULACIÓN LOCAL DE FALLOS DE DNS ENTRE EL NGINX DE LA WEB Y LA API
//
//   node scripts/diagnostico/simular-dns-nginx.mjs                        (la configuración de este repositorio)
//   node scripts/diagnostico/simular-dns-nginx.mjs --imagen-web IMG --sin-montar 1   (la que trae una imagen)
//   Opciones: --solo a,b  --cpus 0-3 (varios workers)  --subred 10.253.77  --raiz DIR  --salida archivo.json
//
// QUÉ COMPRUEBA. Que `upstream api_interna` (`zone` + `server … resolve`, ver `default.conf.template`) tolera
// fallos TEMPORALES de la actualización DNS mientras haya una dirección conocida y operativa; cuáles NO
// tolera; y que nada de una petición ni el nombre interno de la API llega a la salida del contenedor.
// Usa el Nginx REAL de la imagen web. Las guardas de la integración continua (`frontend-resolver-dns` y
// `frontend-registro-errores`) no ejecutan Nginx; esta sí, y hace falta Docker. No reproduce la causa de las
// pérdidas observadas en producción, que se desconoce.
//
// AISLAMIENTO. Red Docker interna (sin salida), sin puertos publicados, sin volúmenes, sin credenciales y con
// nombres ficticios. No descarga imágenes (`--pull never`). Crea recursos con la etiqueta `fchmn.sim-dns=<id>`
// y retira SOLO esos al terminar, también si falla o se interrumpe.
//
// CÓMO SE CONTROLA. Cada escenario usa un Nginx nuevo. Con un worker (`--cpus 0`) el resolutor empieza por el
// primer servidor y rota. Una RETRANSMISIÓN se reconoce porque llega otra vez el mismo identificador DNS.
//
// LÍMITES DE SEGURIDAD. Cada petición se corta a los LIMITE_MS, por encima de todos los plazos de Nginx que se
// esperan, y cada orden de Docker tiene el suyo: una regresión falla la comprobación, no la deja colgada.
// =============================================================================
import { spawn, spawnSync } from "node:child_process";
import dgram from "node:dgram";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ESTE = fileURLToPath(import.meta.url);
const opcion = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};

const NOMBRE = "api-sintetica";
/** Va en la consulta, el `Referer`, la cookie, las cabeceras y el cuerpo: no puede aparecer en la salida. */
const MARCA = "MARCA_SINT_7Q2";
const RED = opcion("subred", "10.253.77");
const IP = { dns1: `${RED}.11`, dns2: `${RED}.12`, api1: `${RED}.21`, api2: `${RED}.22`, web: `${RED}.31` };
const LIMITE_MS = 25000;
/** Lo que tarda, como mucho, en verse un cambio o una recuperación: intento (5) + pausa (5), o `valid` + 1 (11), y margen. */
const RECUPERA_MS = 13000;
/** Una petición que no espera al DNS: muy por debajo de los 5 s de `resolver_timeout`. */
const RAPIDA_MS = 1000;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const cuerpoDe = async (req) => {
  let t = "";
  for await (const p of req) t += p;
  return t;
};

// ----------------------------------------------------------------------------- servidor DNS controlado
function rolDns() {
  const inicial = () => ({ direcciones: [IP.api1], descartar: { A: 0, AAAA: 0 }, responder: { A: "normal", AAAA: "normal" } }); // descartar: -1 = siempre
  let regla = inicial();
  let registro = [];
  const udp = dgram.createSocket("udp4");
  udp.on("message", (m, origen) => {
    let p = 12;
    while (m[p]) p += m[p] + 1;
    const nombre = m.subarray(13, p).toString("latin1");
    const tipo = { 1: "A", 28: "AAAA" }[m.readUInt16BE(p + 1)] ?? "otro";
    const anota = (accion) => registro.push({ t: Date.now(), id: m.readUInt16BE(0), tipo, accion });
    const quedan = regla.descartar[tipo] ?? 0;
    if (quedan !== 0) {
      if (quedan > 0) regla.descartar[tipo]--;
      return anota("descartada");
    }
    const modo = nombre === NOMBRE ? regla.responder[tipo] : "nxdomain";
    // AAAA normal: NOERROR sin registros, como un nombre que solo tiene IPv4.
    const dirs = tipo === "A" && modo === "normal" ? regla.direcciones : [];
    const cab = Buffer.alloc(12);
    cab.writeUInt16BE(m.readUInt16BE(0), 0);
    cab.writeUInt16BE(0x8180 | ({ nxdomain: 3, servfail: 2 }[modo] ?? 0), 2);
    cab.writeUInt16BE(1, 4);
    cab.writeUInt16BE(dirs.length, 6);
    const rr = dirs.map((d) => Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 5, 0, 4, ...d.split(".").map(Number)]));
    udp.send(Buffer.concat([cab, m.subarray(12, p + 5), ...rr]), origen.port, origen.address);
    anota(dirs.length ? `respondida ${dirs.map((d) => (d === IP.api1 ? "api1" : "api2")).join("+")}` : `respondida ${modo === "normal" ? "sin registros" : modo}`);
  });
  udp.bind(53);
  http
    .createServer(async (req, res) => {
      if (req.url === "/limpiar") (regla = inicial()), (registro = []);
      if (req.url === "/regla") {
        const r = JSON.parse(await cuerpoDe(req));
        regla = { ...regla, ...r, descartar: { ...regla.descartar, ...r.descartar }, responder: { ...regla.responder, ...r.responder } };
      }
      res.end(JSON.stringify(registro));
    })
    .listen(8053);
}

// ----------------------------------------------------------------------------- API sintética
function rolApi(nombre) {
  let recibidas = [];
  let muda = false;
  const vivos = new Set();
  const srv = http.createServer(async (req, res) => {
    await cuerpoDe(req);
    recibidas.push({ t: Date.now(), metodo: req.method });
    if (muda) return req.socket.destroy(); // recibió la petición completa y muere sin responder
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ api: nombre }));
  });
  srv.on("connection", (s) => (vivos.add(s), s.on("close", () => vivos.delete(s))));
  srv.listen(3000);
  http
    .createServer((req, res) => {
      if (req.url === "/limpiar") (recibidas = []), (muda = false), srv.listening || srv.listen(3000);
      if (req.url === "/apagar") srv.close(), vivos.forEach((s) => s.destroy());
      if (req.url === "/muda") muda = true;
      res.end(JSON.stringify(recibidas));
    })
    .listen(3001);
}

// ----------------------------------------------------------------------------- cliente: ejecuta los pasos
async function rolCliente(pasos, previo) {
  const ctl = (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(5000) }).then((r) => r.text());
  if (previo) {
    for (const s of ["dns1", "dns2"]) await ctl(`http://${IP[s]}:8053/limpiar`);
    for (const s of ["api1", "api2"]) await ctl(`http://${IP[s]}:3001/limpiar`);
  } else {
    let listo = false;
    for (let i = 0; i < 100 && !listo; i++) {
      listo = await fetch(`http://${IP.web}/`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false); // estático: no usa el DNS
      if (!listo) await dormir(100);
    }
    if (!listo) throw new Error("la web sintética no arrancó");
  }
  const t0 = Date.now();
  const peticiones = [];
  const fondo = [];
  const marcas = {};
  const pedir = async ({ metodo = "GET", ruta = "/api/sonda" }) => {
    const i = Date.now();
    const r = { inicio: i - t0, metodo, estado: 0, api: null };
    try {
      const x = await fetch(`http://${IP.web}${ruta}?buscar=${MARCA}&run=${MARCA}`, {
        method: metodo,
        headers: { referer: `http://ejemplo.prueba/x?q=${MARCA}`, cookie: `sesion=${MARCA}`, authorization: `Bearer ${MARCA}`, "x-csrf-token": MARCA, "x-real-ip": MARCA },
        body: metodo === "POST" ? `{"clave":"${MARCA}"}` : undefined,
        signal: AbortSignal.timeout(LIMITE_MS),
      });
      r.estado = x.status;
      r.api = /"api":"(\w+)"/.exec(await x.text())?.[1] ?? null;
    } catch (e) {
      r.cortada = e.name; // TimeoutError: pasó el límite de seguridad sin respuesta
    }
    peticiones.push({ ...r, duracion: Date.now() - i });
  };
  const muestreo = async ({ cada, durante, ...p }) => {
    const fin = Date.now() + durante;
    const todas = [];
    while (Date.now() < fin) {
      todas.push(pedir(p));
      await dormir(cada);
    }
    await Promise.all(todas);
  };
  for (const p of pasos) {
    if (p.esperar) await dormir(p.esperar);
    else if (p.regla) for (const s of ["dns1", "dns2"]) await ctl(`http://${IP[s]}:8053/regla`, { method: "POST", body: JSON.stringify(p.regla) });
    else if (p.api) await ctl(`http://${IP[p.api]}:3001${p.orden}`);
    else if (p.anfitrion) console.log(`@@ANFITRION ${p.anfitrion}`);
    else if (p.muestreo) fondo.push(muestreo(p.muestreo));
    else if (p.aparte) fondo.push(pedir(p.aparte));
    else await pedir(p);
    if (p.marca) marcas[p.marca] = Date.now() - t0;
  }
  await Promise.all(fondo);
  if (previo) return console.log("{}");
  const dns = [];
  for (const s of ["dns1", "dns2"]) for (const e of JSON.parse(await ctl(`http://${IP[s]}:8053/registro`))) dns.push({ servidor: s, ...e, t: e.t - t0 });
  dns.sort((a, b) => a.t - b.t);
  const vistos = new Set();
  for (const e of dns) (e.retransmision = vistos.has(`${e.tipo}/${e.id}`)), vistos.add(`${e.tipo}/${e.id}`);
  const api = {};
  for (const s of ["api1", "api2"]) api[s] = JSON.parse(await ctl(`http://${IP[s]}:3001/`).catch(() => "[]"));
  console.log(JSON.stringify({ http: peticiones.sort((a, b) => a.inicio - b.inicio), dns, api, marcas }));
}

// ----------------------------------------------------------------------------- escenarios
const GET = {};
const POST = { metodo: "POST", ruta: "/api/auth/login" };
const cada = (ms, durante, p = {}) => ({ muestreo: { cada: ms, durante, ...p } });
const callan = { regla: { descartar: { A: -1, AAAA: -1 } }, marca: "callan" };
const vuelven = { regla: { descartar: { A: 0, AAAA: 0 }, responder: { A: "normal", AAAA: "normal" } }, marca: "vuelven" };
const aApi2 = { regla: { direcciones: [IP.api2] }, marca: "cambia" };
const responden = (A, AAAA) => ({ regla: { responder: { A, AAAA } }, marca: "responden" });
const espera = (ms) => ({ esperar: ms });

const todas200 = (r) => [r.http.every((h) => h.estado === 200), "todas 200"];
const sinEsperas = (r) => [r.http.every((h) => h.duracion < RAPIDA_MS), "ninguna petición espera al DNS"];
const unaVez = (r) => [r.api.api1.length + r.api.api2.length === r.http.filter((h) => h.estado === 200).length, "cada 200 llegó una sola vez a la API"];
const desde = (r, t) => r.http.filter((h) => h.inicio >= t);
const recupera = (r, api) => [
  desde(r, r.marcas.vuelven + RECUPERA_MS).length > 0 && desde(r, r.marcas.vuelven + RECUPERA_MS).every((h) => h.estado === 200 && (!api || h.api === api)),
  `se recupera en ${RECUPERA_MS / 1000} s tras volver el DNS`,
];
const general = (r, errno) => [r.errores.some((l) => l.canal === "errores_generales" && l.clase === "dns" && l.errno === errno), `la actualización fallida se registra: errores_generales, dns, ${errno}`];
const sinErrorDePeticion = (r) => [!r.errores.some((l) => l.canal === "errores_peticion" && l.nivel === "error"), "ningún error de petición"];
const conservaDireccion = (errno) => (r) => [todas200(r), sinEsperas(r), unaVez(r), general(r, errno), sinErrorDePeticion(r)];
const sinDestino = (r, malas) => [
  [malas.length > 0 && malas.every((h) => h.estado === 502 && h.duracion < RAPIDA_MS), "502 inmediatos (límite conocido)"],
  [r.errores.some((l) => l.canal === "errores_peticion" && l.clase === "sin_destino"), "se registran como sin_destino"],
];

const ESCENARIOS = {
  normal: {
    pasos: [GET, cada(1000, 24000), espera(24000)],
    espera: (r) => [todas200(r), sinEsperas(r), unaVez(r), sinErrorDePeticion(r), [r.dns.length >= 4 && r.dns.length <= 8, "una A y una AAAA cada ~11 s, sin depender de las peticiones"]],
  },
  perdidaBreve: { pasos: [GET, espera(8000), callan, cada(500, 20000), espera(6000), vuelven, espera(14000)], espera: conservaDireccion(110) },
  perdidaLarga: { pasos: [GET, espera(8000), callan, cada(1000, 45000), espera(32000), vuelven, espera(13000)], espera: conservaDireccion(110) },
  AAAANunca: { pasos: [GET, espera(3000), { regla: { descartar: { AAAA: -1 } } }, cada(1000, 25000), espera(25000)], espera: conservaDireccion(110) },
  servfail: { pasos: [GET, espera(3000), responden("servfail", "servfail"), cada(1000, 25000), espera(25000)], espera: conservaDireccion(2) },
  cambio: {
    pasos: [GET, espera(3000), aApi2, { api: "api1", orden: "/apagar" }, cada(500, 20000), espera(20000)],
    espera: (r) => [
      [desde(r, r.marcas.cambia + RECUPERA_MS).every((h) => h.estado === 200 && h.api === "api2"), `la dirección nueva se usa en ${RECUPERA_MS / 1000} s`],
      [r.http.every((h) => h.estado === 200 || (h.estado === 502 && h.duracion < RAPIDA_MS)), "hasta entonces, 502 inmediato (la anterior rechaza)"],
      unaVez(r),
    ],
  },
  cambioDuranteLaPerdida: {
    pasos: [GET, espera(3000), callan, aApi2, cada(1000, 42000), espera(22000), vuelven, espera(20000)],
    espera: (r) => [todas200(r), sinEsperas(r), unaVez(r), recupera(r, "api2"), [desde(r, r.marcas.callan).some((h) => h.api === "api1"), "mientras, atiende la anterior"]],
  },
  desapareceDuranteLaPerdida: {
    pasos: [
      GET, espera(3000), callan, aApi2, { anfitrion: "desconectar api1", marca: "desaparece" }, espera(1500),
      cada(2000, 56000), espera(4000), { aparte: POST }, espera(16000), vuelven, espera(RECUPERA_MS + 3000), { aparte: POST }, espera(19000),
    ],
    espera: (r) => {
      const post = r.http.filter((h) => h.metodo === "POST");
      const malas = r.http.filter((h) => h.estado !== 200);
      return [
        [malas.length > 0 && malas.every((h) => h.estado === 504 && h.duracion >= 9900 && h.duracion < 11000), "504 a los 10 s (`proxy_connect_timeout`), ni antes ni después"],
        recupera(r, "api2"),
        [post.length === 2 && post[0].estado === 504 && post[1].estado === 200, "el POST de la caída da 504 y el posterior 200"],
        [r.api.api2.filter((x) => x.metodo === "POST").length === 1, "solo el posterior llega a la API, una vez"],
      ];
    },
  },
  arranqueSinDns: {
    previo: [callan],
    pasos: [cada(1000, 32000), espera(14000), vuelven, espera(18000)],
    espera: (r) => [...sinDestino(r, r.http.filter((h) => h.inicio < r.marcas.vuelven)), recupera(r), general(r, 110)],
  },
  nxdomain: {
    pasos: [GET, espera(3000), responden("nxdomain", "nxdomain"), cada(1000, 38000), espera(20000), vuelven, espera(18000)],
    espera: (r) => [...sinDestino(r, r.http.filter((h) => h.estado !== 200)), recupera(r), general(r, 3)],
  },
  mueraTrasRecibirPost: {
    previo: [{ regla: { direcciones: [IP.api1, IP.api2] } }, { api: "api1", orden: "/muda" }, { api: "api2", orden: "/muda" }],
    pasos: [espera(1500), POST],
    espera: (r) => [[r.http[0].estado === 502 && r.api.api1.length + r.api.api2.length === 1, "un POST ya recibido no se repite en la otra dirección"]],
  },
};

// ----------------------------------------------------------------------------- anfitrión
async function anfitrion() {
  const raiz = path.resolve(opcion("raiz", path.join(path.dirname(ESTE), "..", "..")));
  const imagenWeb = opcion("imagen-web", "fchmn_inscripciones-frontend:latest");
  const imagenNode = opcion("imagen-node", "node:22-alpine");
  const cpus = opcion("cpus", "0");
  const sinMontar = opcion("sin-montar", "") !== "";
  const lista = opcion("solo", Object.keys(ESCENARIOS).join(",")).split(",");
  const id = `${Date.now().toString(36)}-${RED.replaceAll(".", "")}`;
  const etiqueta = `fchmn.sim-dns=${id}`;
  const red = `fchmn-sim-dns-${id}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fchmn-sim-dns-"));
  const entorno = { ...process.env, MSYS_NO_PATHCONV: "1" };
  const docker = (...args) => {
    const r = spawnSync("docker", args, { encoding: "utf8", timeout: 60000, env: entorno });
    if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")}: ${(r.stderr || r.error || "").toString().trim()}`);
    return r;
  };
  const monta = (src, dst) => ["--mount", `type=bind,src=${src},dst=${dst},readonly`];
  const contenedor = (nombre, ip, resto) =>
    docker("run", "-d", "--pull", "never", "--label", etiqueta, "--name", `${red}-${nombre}`, "--network", red, "--ip", ip, ...resto);

  let limpio = false;
  const limpiar = () => {
    if (limpio) return;
    limpio = true;
    const ids = spawnSync("docker", ["ps", "-aq", "--filter", `label=${etiqueta}`], { encoding: "utf8" }).stdout.split(/\s+/).filter(Boolean);
    if (ids.length) spawnSync("docker", ["rm", "-f", ...ids]);
    spawnSync("docker", ["network", "rm", red]);
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => (limpiar(), process.exit(130)));

  /** Una copia con LF de cada archivo de `frontend/nginx` que se prueba, montada donde la imagen los espera. */
  const DESTINOS = {
    "25-resolver.sh": "/docker-entrypoint.d/25-resolver.sh",
    "default.conf.template": "/etc/nginx/templates/default.conf.template",
    "nginx.conf": "/etc/nginx/nginx.conf",
    "njs/registro-errores.js": "/etc/nginx/njs/registro-errores.js",
  };
  const montajes = [];
  if (!sinMontar)
    for (const [origen, destino] of Object.entries(DESTINOS)) {
      const copia = path.join(tmp, path.basename(origen));
      fs.writeFileSync(copia, fs.readFileSync(path.join(raiz, "frontend", "nginx", origen), "utf8").replace(/\r\n/g, "\n"), { mode: 0o755 });
      montajes.push(...monta(copia, destino));
    }

  const resultados = [];
  let fallos = 0;
  try {
    docker("network", "create", "--internal", "--label", etiqueta, "--subnet", `${RED}.0/24`, red);
    const guion = path.join(tmp, "sim.mjs");
    fs.copyFileSync(ESTE, guion);
    fs.writeFileSync(path.join(tmp, "resolv.conf"), `nameserver ${IP.dns1}\nnameserver ${IP.dns2}\n`);
    const nodo = (rol, ...args) => [...monta(guion, "/sim.mjs"), "--cap-drop", "ALL", "--entrypoint", "node", imagenNode, "/sim.mjs", "--subred", RED, "--rol", rol, ...args];
    for (const s of ["dns1", "dns2"]) contenedor(s, IP[s], nodo("dns"));
    for (const s of ["api1", "api2"]) contenedor(s, IP[s], nodo("api", "--nombre", s));
    const cliente = (pasos, previo) =>
      new Promise((ok, mal) => {
        const p = spawn("docker", ["run", "--rm", "--pull", "never", "--label", etiqueta, "--network", red, ...nodo("cliente", "--previo", previo ? "1" : "", "--pasos", JSON.stringify(pasos))], { env: entorno });
        const corte = setTimeout(() => (p.kill(), mal(new Error("cliente: límite de seguridad"))), 60000 + pasos.reduce((n, x) => n + (x.esperar ?? LIMITE_MS), 0));
        let salida = "";
        let error = "";
        p.stdout.on("data", (d) => {
          salida += d;
          if (String(d).includes("@@ANFITRION desconectar api1")) docker("network", "disconnect", "-f", red, `${red}-api1`);
        });
        p.stderr.on("data", (d) => (error += d));
        p.on("close", (c) => (clearTimeout(corte), c === 0 ? ok(JSON.parse(salida.trim().split("\n").pop())) : mal(new Error(error.slice(0, 500)))));
      });

    for (const clave of lista) {
      const esc = ESCENARIOS[clave];
      await cliente(esc.previo ?? [], true);
      const web = `${red}-web`;
      contenedor("web", IP.web, ["--cpuset-cpus", cpus, ...monta(path.join(tmp, "resolv.conf"), "/etc/resolv.conf"), ...montajes, "-e", `API_INTERNA=${NOMBRE}:3000`, "-e", "CSP_CONNECT_SRC='self' http://localhost:3000", imagenWeb]);
      const r = await cliente(esc.pasos, false);
      const datos = docker("exec", web, "sh", "-c", "nginx -v 2>&1; nginx -T 2>/dev/null | grep -E '^ *(resolver|resolver_timeout|zone|server api-|keepalive|proxy_pass) '; echo workers=$(ps | grep -c '[w]orker process')").stdout.trim().split("\n").map((l) => l.trim());
      const log = docker("logs", web);
      const salida = `${log.stdout}\n${log.stderr}`;
      r.config = datos;
      r.errores = salida.split("\n").filter((l) => l.includes('{"canal"')).map((l) => JSON.parse(l.slice(l.indexOf('{"canal"'))));
      r.otras = salida.split("\n").filter((l) => /\[(emerg|alert|crit|error|warn|notice)\]/.test(l) && !l.includes('{"canal"'));
      docker("rm", "-f", web);
      if (esc.pasos.some((p) => p.anfitrion)) {
        docker("rm", "-f", `${red}-api1`);
        contenedor("api1", IP.api1, nodo("api", "--nombre", "api1"));
        await dormir(1000);
      }
      const comprobaciones = [
        ...esc.espera(r),
        [!salida.includes(MARCA), "la salida no contiene datos de la petición"],
        [!salida.includes(NOMBRE), "la salida no contiene el nombre interno de la API"],
        [r.http.every((h) => !h.cortada), "ninguna petición supera el límite de seguridad"],
      ];
      const malas = comprobaciones.filter(([ok]) => !ok).map(([, m]) => m);
      fallos += malas.length;
      resultados.push({ escenario: clave, cpus, ...r, malas });
      const porEstado = {};
      for (const h of r.http) porEstado[h.cortada ? "CORTADA" : h.estado] = (porEstado[h.cortada ? "CORTADA" : h.estado] ?? 0) + 1;
      console.log(
        `${datos.at(-1)} ${clave.padEnd(27)} ${JSON.stringify(porEstado)} máx=${Math.max(...r.http.map((h) => h.duracion))}ms ` +
          `dns=${r.dns.length} descartadas=${r.dns.filter((e) => e.accion === "descartada").length} api=${r.api.api1.length}+${r.api.api2.length}` +
          (malas.length ? `  FALLA: ${malas.join("; ")}` : "  correcto")
      );
    }
  } finally {
    limpiar();
  }
  if (opcion("salida", "")) fs.writeFileSync(opcion("salida", ""), JSON.stringify(resultados, null, 1));
  console.log(fallos ? `NO CUMPLE: ${fallos} comprobación(es)` : "CUMPLE");
  process.exitCode = fallos ? 1 : 0;
}

const rol = opcion("rol", "anfitrion");
if (rol === "dns") rolDns();
else if (rol === "api") rolApi(opcion("nombre", "api"));
else if (rol === "cliente") await rolCliente(JSON.parse(opcion("pasos", "[]")), opcion("previo", "") === "1");
else await anfitrion();
