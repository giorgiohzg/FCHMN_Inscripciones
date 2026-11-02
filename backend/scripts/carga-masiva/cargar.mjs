// =============================================================================
// CARGADOR DE CARGA MASIVA INICIAL
//
// Conduce las TRES etapas por la API, con su autenticación, sus validaciones y
// su auditoría. Ni un INSERT directo.
//
//   etapa 1   POST /clubs                         una llamada por club
//   etapa 2   POST /persons/bulk-import           una llamada (sube el .xlsx)
//   etapa 3   POST /swimmer-assignments/bulk-assign  una llamada por club con
//                                                 nadadores
//
// QUÉ NO VIVE AQUÍ. Ni las planillas, ni las credenciales, ni ningún parámetro
// de una carga concreta: fechas, totales, nombres de archivo y huellas van en un
// MANIFIESTO externo (`--manifiesto`), y las credenciales en el entorno. Este
// archivo está en un repositorio público; las planillas llevan datos personales
// y no deben acercarse a él.
//
// USO
//   API_BASE=https://…/api  CARGA_USUARIO=…  CARGA_CLAVE=…  \
//   node backend/scripts/carga-masiva/cargar.mjs \
//        --manifiesto <ruta/manifiesto.json> \
//        --salida <carpeta FUERA del repositorio> \
//        --etapa todas
//
// SIN `--confirmar` hace una PASADA EN SECO: lee, concilia y no escribe nada.
// Para escribir hacen falta DOS llaves: `--confirmar` y `--fecha-efectiva` con
// la misma fecha que declara el manifiesto. Ver «las cuatro guardas», abajo.
//
// -----------------------------------------------------------------------------
// EL PRINCIPIO QUE GOBIERNA ESTE GUION: **UN MENSAJE NO ES UNA PRUEBA**
//
// La primera versión trataba «ya existe» como suficiente para seguir. No lo es.
// Que el sistema diga que algo ya existe no dice QUÉ existe: podría ser otro
// club con el mismo nombre de usuario, una persona con el mismo RUN y otra
// fecha de nacimiento, o una membresía en otro club o con otra fecha efectiva.
//
// Así que aquí ningún «ya existe» se acepta por su mensaje. Cada registro que
// ya está se LEE de la API y se COMPARA campo a campo con la planilla
// aprobada. Si todo coincide, se da por hecho. Si algo difiere, el guion se
// DETIENE y no sobrescribe nada: nunca hay un `PATCH`, ni un `PUT`, ni un
// reintento que «arregle» la diferencia.
//
// -----------------------------------------------------------------------------
// LAS CUATRO GUARDAS, Y POR QUÉ NINGUNA ES OPCIONAL
//
//   1. HUELLAS. Cada planilla se compara con el `sha256` que declara el
//      manifiesto. Una huella ausente, mal formada o distinta detiene el guion
//      ANTES de abrir sesión. Sin esto, «la planilla aprobada» es una creencia.
//   2. DESTINO EXPLÍCITO. `API_BASE` no tiene valor por omisión. Nunca.
//   3. SECO POR OMISIÓN. Sin `--confirmar` no se envía ni un POST.
//   4. LA FECHA, DOS VECES. El campo `fechaEfectiva` de la API es OPCIONAL: si
//      no se envía, el servicio graba HOY. Una carga que lo omitiera pondría la
//      fecha de ejecución en todas las membresías, sin error y sin aviso. Antes
//      era una constante con guarda dentro del guion; al salir al manifiesto
//      dejaría de ser una decisión y pasaría a ser un parámetro cualquiera, así
//      que para escribir hay que repetirla en la línea de órdenes.
// =============================================================================

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Blob } from "node:buffer";
import { setTimeout as esperar } from "node:timers/promises";
import ExcelJS from "exceljs";

// `fetch` y `FormData` son globales de Node desde la 18. Se toman de
// `globalThis` en lugar de usarlos sueltos para que el linter —que en los
// `.mjs` sí aplica `no-undef`— no tenga que adivinar de dónde vienen. Es la
// misma razón por la que los demás guiones de esta carpeta importan `Buffer`
// de `node:buffer` en vez de darlo por hecho.
const { fetch, FormData } = globalThis;

// `fileURLToPath` y no `new URL(...).pathname`: el segundo deja la ruta
// porcentualmente codificada —«/C:/mis%20datos/…»— y con espacios no abre nada.
const AQUI = path.dirname(fileURLToPath(import.meta.url));

// --- El manifiesto: todo lo propio de UNA carga, fuera de este guion ---------
//
// Se rellenan al arrancar, desde el archivo que indique `--manifiesto`. Son
// `let` y no `const` por eso, pero nada los vuelve a tocar después.

/** Fecha efectiva de las membresías, en `AAAA-MM-DD`. */
let FECHA_EFECTIVA = null;
/** `{ clubes: {archivo, hoja, sha256}, personas: {...}, asignaciones: {...} }` */
let PLANILLAS = null;
/** Carpeta que contiene las planillas, resuelta respecto del manifiesto. */
let DIR_PLANILLAS = null;
/** Totales aprobados. Cualquier desviación detiene todo antes de escribir. */
let ESPERADO = null;
/** Solo para el registro: el límite de la API, `RATE_LIMIT_GLOBAL_MAX`. */
let LIMITE_POR_MINUTO = 300;

/** Ruta absoluta del manifiesto en uso; se registra para dejar traza. */
let MANIFIESTO_RUTA = null;

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const huellaDe = (ruta) => crypto.createHash("sha256").update(fs.readFileSync(ruta)).digest("hex");

/**
 * Lee y valida el manifiesto.
 *
 * Valida con dureza a propósito: un manifiesto a medias —una huella con el
 * texto de relleno del ejemplo, un total ausente— tiene que detener el guion
 * aquí, no convertirse en una comprobación que silenciosamente no comprueba
 * nada. Por eso el manifiesto de ejemplo que acompaña a este guion **no es
 * ejecutable**: sus huellas no son hexadecimales y mueren en esta función.
 */
function cargarManifiesto(ruta) {
  if (!ruta) abortar("Falta --manifiesto. Sin él no hay fecha, ni totales, ni huellas que comprobar.");
  const absoluta = path.resolve(ruta);
  if (!fs.existsSync(absoluta)) abortar(`No existe el manifiesto ${absoluta}`);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(absoluta, "utf8"));
  } catch (e) {
    abortar(`El manifiesto ${absoluta} no es JSON válido`, e.message);
  }

  if (!FECHA_ISO.test(String(m.fechaEfectiva ?? ""))) {
    abortar("El manifiesto no declara una fechaEfectiva con forma AAAA-MM-DD", m.fechaEfectiva ?? "(ausente)");
  }
  FECHA_EFECTIVA = m.fechaEfectiva;

  // Las planillas se buscan junto al manifiesto salvo que éste diga otra cosa.
  // Relativo al MANIFIESTO y no al directorio de trabajo: así el manifiesto y
  // sus planillas se mueven juntos sin reescribir nada.
  DIR_PLANILLAS = path.resolve(path.dirname(absoluta), m.directorioDePlanillas ?? ".");

  PLANILLAS = {};
  for (const clave of ["clubes", "personas", "asignaciones"]) {
    const p = m.planillas?.[clave];
    if (!p?.archivo) abortar(`El manifiesto no declara la planilla «${clave}»`);
    if (!p.hoja) abortar(`El manifiesto no declara el nombre de hoja de «${clave}»`);
    if (!SHA256.test(String(p.sha256 ?? "").toLowerCase())) {
      abortar(`La huella declarada para «${clave}» no es un sha256 hexadecimal de 64 caracteres`, p.sha256 ?? "(ausente)");
    }
    PLANILLAS[clave] = { archivo: p.archivo, hoja: p.hoja, sha256: String(p.sha256).toLowerCase() };
  }

  ESPERADO = {};
  for (const clave of ["clubes", "personas", "asignaciones", "clubesConNadadores"]) {
    const n = m.totales?.[clave];
    if (!Number.isInteger(n) || n < 0) abortar(`El manifiesto no declara un total entero para «${clave}»`, n ?? "(ausente)");
    ESPERADO[clave] = n;
  }

  if (m.limiteDeSolicitudesPorMinuto !== undefined) {
    const n = Number(m.limiteDeSolicitudesPorMinuto);
    if (!Number.isFinite(n) || n <= 0) abortar("limiteDeSolicitudesPorMinuto tiene que ser un número positivo");
    LIMITE_POR_MINUTO = n;
  }

  MANIFIESTO_RUTA = absoluta;
  return m;
}

function verificarHuellas() {
  anotar(`huella de este guion: ${huellaDe(fileURLToPath(import.meta.url))}`);
  anotar(`manifiesto: ${MANIFIESTO_RUTA}`);
  anotar(`  huella del manifiesto: ${huellaDe(MANIFIESTO_RUTA)}`);
  for (const [clave, p] of Object.entries(PLANILLAS)) {
    const ruta = path.join(DIR_PLANILLAS, p.archivo);
    if (!fs.existsSync(ruta)) abortar(`Falta la planilla de ${clave}: ${ruta}`);
    const real = huellaDe(ruta);
    if (real !== p.sha256) {
      abortar(`La planilla de ${clave} NO es la aprobada`, { archivo: p.archivo, esperada: p.sha256, encontrada: real });
    }
    anotar(`  ${p.archivo}: huella correcta`);
  }
}

// --- Registro y parada -------------------------------------------------------

let registro = null;

function anotar(linea) {
  const salida = `${new Date().toISOString()}  ${linea}`;
  console.log(salida);
  if (registro) {
    try {
      fs.appendFileSync(registro, salida + "\n", "utf8");
    } catch {
      /* el registro es ayuda, no requisito */
    }
  }
}

/** Señal interna de parada. No es un error del programa: es su decisión. */
class Parada extends Error {}

/**
 * Detiene la carga con código de salida 2. Nunca intenta arreglar nada.
 *
 * LANZA en lugar de llamar a `process.exit()`, y la diferencia no es de estilo.
 * Medido el 2026-11-01 en Windows con Node 24: `process.exit()` con conexiones
 * HTTP todavía abiertas aborta el proceso con
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` y un código de
 * salida 3221226505 (0xC0000409) en lugar de 2. Es decir: el guion se detenía
 * por el motivo correcto y **mentía sobre cómo**. Lanzando, el bucle de
 * eventos se vacía solo y el código de salida es el que se anuncia.
 */
function abortar(motivo, detalle) {
  anotar(`DETENIDO: ${motivo}`);
  if (detalle !== undefined) {
    const t = typeof detalle === "string" ? detalle : JSON.stringify(detalle, null, 1);
    for (const l of String(t).split("\n")) anotar(`  ${l}`);
  }
  anotar("No se sobrescribe nada. Lo ya hecho queda en los resultados por etapa.");
  process.exitCode = 2;
  throw new Parada(motivo);
}

/**
 * Desarma un error de red hasta su causa real y la explica.
 *
 * `fetch` de Node envuelve TODO fallo de transporte en un `TypeError: fetch
 * failed` cuyo `stack` no menciona ni el host, ni el código, ni el motivo: lo
 * útil vive en `e.cause`, y a veces un nivel más abajo. Medido el 2026-11-01:
 * la pasada en seco se detuvo con ese texto y nada más, y el diagnóstico hubo
 * que hacerlo por fuera con otro guion, porque el cargador había tirado la
 * única información que importaba. Esto lo arregla.
 *
 * No intenta reconectar ni reintentar: informa. Decidir qué hacer con una red
 * que no responde no es asunto del cargador.
 */
function detallarRed(e) {
  const lineas = [];
  const codigos = new Set();
  let cur = e;
  for (let n = 0; cur && n < 10; n++) {
    const campos = [];
    for (const k of ["name", "code", "errno", "syscall", "address", "port", "hostname"]) {
      if (cur[k] !== undefined && cur[k] !== null) campos.push(`${k}=${cur[k]}`);
    }
    if (cur.code) codigos.add(String(cur.code));
    lineas.push(`causa[${n}] ${cur.message ?? ""}${campos.length ? "   " + campos.join(" ") : ""}`);
    cur = cur.cause;
  }

  // Pistas por código. Cada una dice qué mirar, no qué desactivar.
  const PISTAS = {
    ENOTFOUND: "el nombre del host no se resuelve: revise el DESTINO de la primera línea y el DNS",
    EAI_AGAIN: "el DNS no respondió a tiempo: fallo de red temporal",
    ECONNREFUSED: "nadie escucha en ese puerto: ¿API_BASE apunta a una dirección local que no está corriendo?",
    ETIMEDOUT: "la conexión no obtuvo respuesta: cortafuegos silencioso o proxy obligatorio",
    UND_ERR_CONNECT_TIMEOUT: "la conexión no se estableció en el plazo: red lenta, proxy o servicio dormido",
    ECONNRESET: "la conexión se cortó a mitad de camino: inspección de tráfico, proxy o caída momentánea",
    UND_ERR_SOCKET: "el socket se cerró antes de terminar la respuesta",
    EPROTO: "el otro extremo no habló TLS como se esperaba",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "AUTORIDAD CORPORATIVA: falta su raíz en la confianza de Node",
    SELF_SIGNED_CERT_IN_CHAIN: "AUTORIDAD CORPORATIVA: falta su raíz en la confianza de Node",
    DEPTH_ZERO_SELF_SIGNED_CERT: "AUTORIDAD CORPORATIVA: falta su raíz en la confianza de Node",
    CERT_SIGNATURE_FAILURE: "AUTORIDAD CORPORATIVA: la cadena no valida contra la confianza de Node",
    CERT_HAS_EXPIRED: "certificado vencido, o el reloj de esta máquina está desajustado",
  };
  const pistas = [...codigos].map((c) => PISTAS[c]).filter(Boolean);
  if (pistas.length) {
    lineas.push("");
    for (const p of new Set(pistas)) lineas.push(`pista: ${p}`);
  }
  if ([...codigos].some((c) => PISTAS[c]?.startsWith("AUTORIDAD"))) {
    lineas.push("");
    lineas.push("Si es una autoridad corporativa, la salida es que Node CONFÍE en ella,");
    lineas.push("no que deje de validar. En esta máquina:");
    lineas.push("  node --use-system-ca backend/scripts/carga-masiva/cargar.mjs ...");
    lineas.push("o bien exportar la raíz y apuntar NODE_EXTRA_CA_CERTS a ese archivo.");
    lineas.push("NUNCA NODE_TLS_REJECT_UNAUTHORIZED=0: eso acepta cualquier");
    lineas.push("suplantación del destino, y aquí se envían credenciales.");
  }
  return lineas;
}

// --- Normalización: comparar significados, no apariencias --------------------

const cad = (v) => String(v ?? "").trim();
const normRun = (v) => cad(v).replace(/[.\-\s]/g, "").toUpperCase();
const normCorreo = (v) => cad(v).toLowerCase();

/**
 * Cualquier forma en que viaja una fecha aquí -> `AAAA-MM-DD`.
 *
 * Acepta separador `-` o `/` y día o mes de una cifra, con el MISMO patrón que
 * usa el importador del servidor (`parseSpanishDate`). Medido el 2026-11-01:
 * la hoja «Personas» trae las fechas con BARRAS (`15/07/1989`), no con
 * guiones, aunque el encabezado diga `DD-MM-AAAA`. Un normalizador que solo
 * admitiera guiones daría por «distinta» una fecha idéntica.
 */
function normFecha(v) {
  const s = cad(v);
  if (!s) return "";
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  return s;
}

function normGenero(v) {
  const s = cad(v).toLowerCase();
  if (["femenino", "female", "f"].includes(s)) return "female";
  if (["masculino", "male", "m"].includes(s)) return "male";
  return s;
}

function normBooleano(v, donde) {
  if (typeof v === "boolean") return v;
  const s = cad(v).toLowerCase();
  if (["sí", "si", "true", "1", "x", "verdadero"].includes(s)) return true;
  if (["no", "false", "0", "", "falso"].includes(s)) return false;
  abortar(`Valor booleano que no sé interpretar${donde ? ` (${donde})` : ""}: «${v}»`);
}

const texto = (celda) => {
  const v = celda && celda.value;
  if (v == null) return "";
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((x) => x.text).join("");
    if (v instanceof Date) return v.toISOString();
    return String(v.text ?? v.result ?? "");
  }
  return String(v);
};

// --- Conciliación ------------------------------------------------------------
//
// Cada función devuelve la lista de diferencias. Lista vacía = el registro que
// ya está en el sistema ES el aprobado.

function diferencias(campos) {
  const d = [];
  for (const [campo, esperado, actual] of campos) {
    if (esperado !== actual) d.push({ campo, aprobado: esperado, enElSistema: actual });
  }
  return d;
}

function conciliarClub(aprobado, actual) {
  return diferencias([
    ["name", cad(aprobado.name), cad(actual.name)],
    ["code", cad(aprobado.code), cad(actual.code)],
    ["username", cad(aprobado.username), cad(actual.username)],
    ["email", normCorreo(aprobado.email), normCorreo(actual.email)],
    // `null` es «pendiente de verificar» y NO es lo mismo que `false`.
    ["hasLegalStatus", "null", actual.hasLegalStatus === null ? "null" : String(actual.hasLegalStatus)],
    ["rut", normRun(aprobado.rut), normRun(actual.rut)],
    ["legalName", cad(aprobado.legalName), cad(actual.legalName)],
    ["isAchmnMember", normBooleano(aprobado.isAchmnMember), Boolean(actual.isAchmnMember)],
    ["isAchmnCollaborator", normBooleano(aprobado.isAchmnCollaborator), Boolean(actual.isAchmnCollaborator)],
    ["isFchmnMember", normBooleano(aprobado.isFchmnMember), Boolean(actual.isFchmnMember)],
    ["isFchmnCollaborator", normBooleano(aprobado.isFchmnCollaborator), Boolean(actual.isFchmnCollaborator)],
  ]);
}

function conciliarPersona(aprobado, actual) {
  return diferencias([
    ["run", normRun(aprobado.run), normRun(actual.run)],
    ["username", cad(aprobado.username), cad(actual.username)],
    ["firstName", cad(aprobado.firstName), cad(actual.firstName)],
    ["paternalLastName", cad(aprobado.paternalLastName), cad(actual.paternalLastName)],
    ["maternalLastName", cad(aprobado.maternalLastName), cad(actual.maternalLastName)],
    ["birthDate", normFecha(aprobado.birthDate), normFecha(actual.birthDate)],
    ["gender", normGenero(aprobado.gender), normGenero(actual.gender)],
    ["email", normCorreo(aprobado.email), normCorreo(actual.email)],
    ["phone", cad(aprobado.phone), cad(actual.phone)],
  ]);
}

/** Identidad del club Y fecha efectiva. Las dos, siempre. */
function conciliarMembresia(aprobado, actual) {
  return diferencias([
    ["clubId", cad(aprobado.clubId), cad(actual.clubId)],
    ["startDate", FECHA_EFECTIVA, normFecha(actual.startDate)],
    ["status", "active", cad(actual.status)],
  ]);
}

// --- Resultados por etapa: JSONL escrito en el momento -----------------------
//
// JSONL y no JSON: se añade una línea por registro EN CUANTO se conoce, así que
// un corte a mitad de etapa deja un archivo legible con todo lo hecho. Un JSON
// completo se escribe al final, y al final es justo cuando ya no sirve.
//
// IMPORTANTE: este archivo es una AYUDA para reanudar, no la verdad. La verdad
// está en la API, y por eso cada reanudación concilia contra ella. Un registro
// que la API guardó y este archivo no alcanzó a anotar se detecta igual.

class Resultados {
  constructor(salida, etapa, confirmar) {
    // En seco NO se escriben archivos de resultado: una pasada que anuncia que
    // no escribe nada no debe dejar rastro ni en disco.
    this.confirmar = confirmar;
    this.ruta = path.join(salida, `etapa${etapa}.jsonl`);
    this.previos = new Map();
    if (fs.existsSync(this.ruta)) {
      const lineas = fs.readFileSync(this.ruta, "utf8").split("\n").filter((l) => l.trim());
      for (const l of lineas) {
        let r;
        try {
          r = JSON.parse(l);
        } catch {
          abortar(`El archivo ${this.ruta} tiene una línea ilegible`, l.slice(0, 160));
        }
        if (r.clave) this.previos.set(r.clave, r);
      }
      anotar(`  resultados previos en ${path.basename(this.ruta)}: ${this.previos.size}`);
    }
  }
  escribir(fila) {
    if (this.confirmar) fs.appendFileSync(this.ruta, JSON.stringify(fila) + "\n", "utf8");
    this.previos.set(fila.clave, fila);
  }
}

// --- Sesión con la API -------------------------------------------------------

class Sesion {
  constructor(base) {
    this.base = base.replace(/\/+$/, "");
    this.accessToken = null;
    this.csrf = null;
    this.cookie = null;
    this.renovaciones = 0;
    this.esperasPorLimite = 0;
    // Cuenta de solicitudes y pico por minuto. Existe porque un ensayo que no
    // provoca ni un 429 deja sin saber con cuanto margen se paso: el pico
    // medido es lo unico que lo dice.
    this.solicitudes = 0;
    this.ventana = { desde: Date.now(), cuenta: 0 };
    this.picoPorMinuto = 0;
  }

  guardarGalletas(res) {
    const g = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (g.length) this.cookie = g.map((c) => c.split(";")[0]).join("; ");
  }

  /**
   * Ingreso.
   *
   * También espera ante un `429`, y no por simetría: el límite GLOBAL de la API
   * alcanza a `/auth/login`, que además tiene uno **más estricto** —20 por
   * minuto—. Sin esta espera, una carga reanudada poco después de otra se caía
   * en el ingreso, antes de poder hacer nada.
   */
  async entrar(usuario, clave) {
    let res;
    for (let intento = 0; ; intento++) {
      this.contar();
      res = await fetch(`${this.base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: usuario, password: clave }),
      });
      if (res.status !== 429) break;
      if (intento >= 12) abortar("El servidor sigue limitando el ingreso tras 12 esperas");
      await this.esperarPorLimite(res, "/auth/login");
    }
    const cuerpo = await res.json().catch(() => ({}));
    if (!res.ok) abortar(`El ingreso falló con ${res.status}`, cuerpo.message ?? "(sin mensaje)");
    if (cuerpo.mustChangePassword) {
      abortar("La cuenta exige cambiar la contraseña antes de operar. Hágalo en la interfaz y vuelva a lanzar.");
    }
    this.accessToken = cuerpo.accessToken ?? null;
    this.csrf = cuerpo.csrfToken ?? null;
    this.guardarGalletas(res);
    if (!this.accessToken) abortar("El ingreso no devolvió token de acceso");
    anotar(`Sesión iniciada. CSRF ${this.csrf ? "recibido" : "no recibido"}.`);
  }

  cabeceras(extra = {}) {
    const h = { ...extra };
    if (this.accessToken) h.authorization = `Bearer ${this.accessToken}`;
    if (this.csrf) h["x-csrf-token"] = this.csrf;
    if (this.cookie) h.cookie = this.cookie;
    return h;
  }

  /**
   * Renueva el token cuando caduca a mitad de una etapa larga.
   *
   * La etapa 3 del ensayo tardó dos minutos; la 2, casi dos. Con un token de
   * vida corta, una carga real puede cruzar su caducidad, y entonces una
   * llamada perfectamente válida responde 401. Reintentar UNA vez tras renovar
   * no es tapar un error: es continuar la misma operación.
   */
  async renovar() {
    if (!this.cookie) return false;
    const res = await fetch(`${this.base}/auth/refresh`, { method: "POST", headers: this.cabeceras() });
    if (!res.ok) return false;
    const c = await res.json().catch(() => ({}));
    if (c.accessToken) this.accessToken = c.accessToken;
    if (c.csrfToken) this.csrf = c.csrfToken;
    this.guardarGalletas(res);
    this.renovaciones++;
    anotar(`  token renovado (renovación nº ${this.renovaciones})`);
    return true;
  }

  /**
   * Espera cuando el servidor dice que vamos demasiado rápido.
   *
   * La API limita a `RATE_LIMIT_GLOBAL_MAX` solicitudes por minuto —300 por
   * omisión— y una carga grande hace del orden de un millar entre escrituras,
   * listados y comprobaciones, así que puede alcanzarlo. Se respeta
   * `Retry-After` cuando viene, y es el servidor quien dice cuánto esperar.
   */
  async esperarPorLimite(res, ruta) {
    const cabecera = Number(res.headers.get("retry-after"));
    const segundos = Number.isFinite(cabecera) && cabecera > 0 ? Math.min(cabecera, 120) : 20;
    this.esperasPorLimite++;
    anotar(`  límite de solicitudes en ${ruta}: esperando ${segundos} s (espera nº ${this.esperasPorLimite})`);
    await esperar(segundos * 1000);
  }

  contar() {
    this.solicitudes++;
    const ahora = Date.now();
    if (ahora - this.ventana.desde >= 60000) this.ventana = { desde: ahora, cuenta: 0 };
    this.ventana.cuenta++;
    if (this.ventana.cuenta > this.picoPorMinuto) this.picoPorMinuto = this.ventana.cuenta;
  }

  async pedir(metodo, ruta, { json, form } = {}, reintento = true, intentosPorLimite = 0) {
    const init = { method: metodo };
    if (json !== undefined) {
      init.headers = this.cabeceras({ "content-type": "application/json" });
      init.body = JSON.stringify(json);
    } else {
      init.headers = this.cabeceras();
      if (form !== undefined) init.body = form;
    }
    this.contar();
    const res = await fetch(`${this.base}${ruta}`, init);
    if (res.status === 429) {
      if (intentosPorLimite >= 12) abortar(`El servidor sigue limitando ${ruta} tras 12 esperas`);
      await this.esperarPorLimite(res, ruta);
      return this.pedir(metodo, ruta, { json, form }, reintento, intentosPorLimite + 1);
    }
    if (res.status === 401 && reintento) {
      if (await this.renovar()) return this.pedir(metodo, ruta, { json, form }, false, intentosPorLimite);
      abortar("La sesión caducó y no se pudo renovar. Vuelva a lanzar con --salida apuntando a esta misma carpeta.");
    }
    const cuerpo = await res.json().catch(() => null);
    return { estado: res.status, ok: res.ok, cuerpo };
  }

  /** Recorre un listado paginado completo. LECTURA, nunca escritura. */
  async listarTodo(ruta) {
    const items = [];
    let pagina = 1;
    for (;;) {
      const sep = ruta.includes("?") ? "&" : "?";
      const r = await this.pedir("GET", `${ruta}${sep}page=${pagina}&pageSize=100`);
      if (!r.ok) abortar(`No pude listar ${ruta} (página ${pagina}): ${r.estado}`, r.cuerpo);
      const lote = r.cuerpo?.items ?? [];
      items.push(...lote);
      const total = r.cuerpo?.total ?? items.length;
      if (items.length >= total || lote.length === 0) return items;
      pagina++;
      if (pagina > 500) abortar(`Paginación sin fin en ${ruta}`);
    }
  }
}

// --- Lectura de las planillas ------------------------------------------------

async function hoja(planilla) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(DIR_PLANILLAS, planilla.archivo));
  const h = wb.getWorksheet(planilla.hoja);
  if (!h) abortar(`La planilla ${planilla.archivo} no tiene la hoja «${planilla.hoja}»`);
  return h;
}

async function leerClubes() {
  const h = await hoja(PLANILLAS.clubes);
  const filas = [];
  h.eachRow((fila, n) => {
    if (n === 1) return;
    const c = (i) => texto(fila.getCell(i)).trim();
    if (!c(2)) return;
    filas.push({
      filaOriginal: c(1),
      name: c(2),
      code: c(3),
      username: c(4),
      email: c(5),
      personalidadPlanilla: c(6),
      rut: c(7),
      legalName: c(8),
      isAchmnMember: c(9),
      isAchmnCollaborator: c(10),
      isFchmnMember: c(11),
      isFchmnCollaborator: c(12),
    });
  });
  return filas;
}

async function leerPersonas() {
  const h = await hoja(PLANILLAS.personas);
  const filas = [];
  h.eachRow((fila, n) => {
    if (n === 1) return;
    const c = (i) => texto(fila.getCell(i)).trim();
    if (!c(1)) return;
    filas.push({
      fila: n,
      run: c(1),
      username: c(2),
      firstName: c(3),
      paternalLastName: c(4),
      maternalLastName: c(5),
      birthDate: c(6),
      gender: c(7),
      email: c(8),
      phone: c(9),
    });
  });
  return filas;
}

async function leerAsignaciones() {
  const h = await hoja(PLANILLAS.asignaciones);
  const filas = [];
  h.eachRow((fila, n) => {
    if (n === 1) return;
    const c = (i) => texto(fila.getCell(i)).trim();
    if (!c(3)) return;
    filas.push({ run: c(2), username: c(3), sigla: c(5), club: c(6) });
  });
  return filas;
}

/**
 * Carga útil de un club.
 *
 * `hasLegalStatus: null` va EXPLÍCITO porque el esquema del servidor es
 * `.nullable()` y NO `.optional()`: omitir el campo no deja «pendiente», falla
 * la validación. Es deliberado — omitirlo significaría declarar algo sin
 * querer.
 */
function construirClub(fila) {
  const p = fila.personalidadPlanilla.toLowerCase();
  if (p && !["", "pendiente", "null", "pendiente de verificar"].includes(p)) {
    abortar(
      `El club de la fila ${fila.filaOriginal} trae personalidad jurídica «${fila.personalidadPlanilla}» en la planilla, y este cargador solo admite que entren como PENDIENTES`
    );
  }
  const carga = {
    name: fila.name,
    code: fila.code,
    username: fila.username,
    email: fila.email,
    hasLegalStatus: null,
    isAchmnMember: normBooleano(fila.isAchmnMember, `club ${fila.code}`),
    isAchmnCollaborator: normBooleano(fila.isAchmnCollaborator, `club ${fila.code}`),
    isFchmnMember: normBooleano(fila.isFchmnMember, `club ${fila.code}`),
    isFchmnCollaborator: normBooleano(fila.isFchmnCollaborator, `club ${fila.code}`),
  };
  if (fila.rut) carga.rut = fila.rut;
  if (fila.legalName) carga.legalName = fila.legalName;
  return carga;
}

/** Última barrera antes de enviar: las dos exigencias, en la carga útil misma. */
function verificarCargaUtil(tipo, carga) {
  if (tipo === "club") {
    if (!("hasLegalStatus" in carga)) abortar("Carga útil de club sin el campo hasLegalStatus");
    if (carga.hasLegalStatus !== null) abortar("Carga útil de club con hasLegalStatus distinto de null", carga.hasLegalStatus);
  }
  if (tipo === "asignacion") {
    if (carga.fechaEfectiva !== FECHA_EFECTIVA) {
      abortar(`Carga útil de asignación con fechaEfectiva «${carga.fechaEfectiva}» en lugar de «${FECHA_EFECTIVA}»`);
    }
    if (!Array.isArray(carga.personIds) || carga.personIds.length === 0) abortar("Carga útil de asignación sin nadadores");
  }
}

// --- Etapa 1: clubes ---------------------------------------------------------

async function etapa1(ses, salida, clubes, confirmar) {
  anotar(`ETAPA 1 — clubes: ${clubes.length} aprobados`);
  const res = new Resultados(salida, "1_clubes", confirmar);

  const porUsuario = new Map((await ses.listarTodo("/clubs")).map((c) => [cad(c.username), c]));
  anotar(`  en el sistema ahora: ${porUsuario.size} clubes`);

  let creados = 0;
  let conciliados = 0;
  for (const fila of clubes) {
    const carga = construirClub(fila);
    verificarCargaUtil("club", carga);

    // Lo que ya está se CONCILIA, no se cree por su mensaje.
    const actual = porUsuario.get(cad(fila.username));
    if (actual) {
      const d = conciliarClub(fila, actual);
      if (d.length) {
        res.escribir({ clave: fila.username, estado: "DIFERENCIA", diferencias: d });
        abortar(`El club «${fila.code}» ya existe en el sistema con datos DISTINTOS de la planilla aprobada`, d);
      }
      conciliados++;
      if (!res.previos.has(fila.username)) {
        res.escribir({ clave: fila.username, estado: "ya_existia_conciliado", id: actual.id, code: fila.code });
      }
      continue;
    }

    if (!confirmar) continue;

    const r = await ses.pedir("POST", "/clubs", { json: carga });
    if (r.ok) {
      creados++;
      res.escribir({ clave: fila.username, estado: "creado", id: r.cuerpo?.id ?? null, code: fila.code });
      continue;
    }

    // Rechazo. No se interpreta el mensaje: se vuelve a LEER y se concilia.
    // Este es exactamente el caso del corte entre el guardado del servidor y
    // la anotación local — y también el de un homónimo que no es el nuestro.
    anotar(`  «${fila.code}» rechazado (${r.estado}); releyendo para conciliar`);
    const relectura = await ses.listarTodo(`/clubs?search=${encodeURIComponent(fila.username)}`);
    const encontrado = relectura.find((c) => cad(c.username) === cad(fila.username));
    if (!encontrado) {
      res.escribir({ clave: fila.username, estado: "inesperado", http: r.estado, cuerpo: r.cuerpo });
      abortar(`El club «${fila.code}» fue rechazado y NO existe en el sistema`, r.cuerpo);
    }
    const d = conciliarClub(fila, encontrado);
    if (d.length) {
      res.escribir({ clave: fila.username, estado: "DIFERENCIA", diferencias: d });
      abortar(`El club «${fila.code}» fue rechazado y el que ocupa su nombre de usuario tiene datos DISTINTOS`, d);
    }
    conciliados++;
    res.escribir({ clave: fila.username, estado: "ya_existia_conciliado", id: encontrado.id, code: fila.code, tras_rechazo: true });
  }

  anotar(`  creados: ${creados}   ya estaban y conciliados: ${conciliados}`);
  return { creados, conciliados };
}

// --- Etapa 2: personas -------------------------------------------------------

async function etapa2(ses, salida, personas, confirmar) {
  anotar(`ETAPA 2 — personas: ${personas.length} aprobadas`);
  if (personas.length !== ESPERADO.personas) {
    abortar(`La hoja de personas trae ${personas.length} filas y lo aprobado son ${ESPERADO.personas}`);
  }

  const leerPorRun = async () => new Map((await ses.listarTodo("/persons")).map((p) => [normRun(p.run), p]));
  let porRun = await leerPorRun();
  anotar(`  en el sistema ahora: ${porRun.size} personas`);

  // Conciliación ANTES de subir nada: si alguna de las que ya están difiere de
  // la planilla, se detiene sin tocar el importador.
  const yaEstaban = [];
  for (const p of personas) {
    const actual = porRun.get(normRun(p.run));
    if (!actual) continue;
    const d = conciliarPersona(p, actual);
    if (d.length) {
      abortar(`La persona de la fila ${p.fila} ya existe con datos DISTINTOS de la planilla aprobada`, {
        fila: p.fila,
        diferencias: d,
      });
    }
    yaEstaban.push(p);
  }
  anotar(`  ya estaban y conciliadas: ${yaEstaban.length}`);

  if (yaEstaban.length === personas.length) {
    anotar(`  las ${personas.length} están y coinciden: no se sube nada`);
    return { subido: false, conciliadas: yaEstaban.length };
  }
  if (!confirmar) return { subido: false, conciliadas: yaEstaban.length };

  const ruta = path.join(salida, "etapa2_personas.json");
  const form = new FormData();
  const archivoDePersonas = path.join(DIR_PLANILLAS, PLANILLAS.personas.archivo);
  form.append("file", new Blob([fs.readFileSync(archivoDePersonas)]), PLANILLAS.personas.archivo);
  const r = await ses.pedir("POST", "/persons/bulk-import", { form });
  // El resumen se guarda ANTES de interpretarlo: es el único registro que queda
  // de lo que respondió el importador.
  fs.writeFileSync(ruta, JSON.stringify(r.cuerpo ?? { http: r.estado }, null, 1), "utf8");
  anotar(`  resumen del importador guardado en ${ruta}`);
  if (!r.ok) abortar(`La carga de personas falló con ${r.estado}`, r.cuerpo);

  // Y después del importador, se concilian TODAS contra la API. El resumen
  // dice «created» o «error»; esto comprueba qué quedó de verdad.
  porRun = await leerPorRun();
  const faltan = [];
  for (const p of personas) {
    const actual = porRun.get(normRun(p.run));
    if (!actual) {
      faltan.push(p.fila);
      continue;
    }
    const d = conciliarPersona(p, actual);
    if (d.length) abortar(`Tras importar, la persona de la fila ${p.fila} quedó con datos DISTINTOS`, { fila: p.fila, diferencias: d });
  }
  if (faltan.length) abortar(`Tras importar faltan ${faltan.length} personas`, { primerasFilas: faltan.slice(0, 20) });
  anotar(`  las ${personas.length} personas están y coinciden`);
  return { subido: true, conciliadas: personas.length };
}

// --- Etapa 3: asignaciones ---------------------------------------------------

async function etapa3(ses, salida, asignaciones, clubes, confirmar) {
  anotar(`ETAPA 3 — asignaciones: ${asignaciones.length} aprobadas`);
  const res = new Resultados(salida, "3_asignaciones", confirmar);

  const clubPorUsuario = new Map((await ses.listarTodo("/clubs")).map((c) => [cad(c.username), c.id]));
  const personaPorUsuario = new Map((await ses.listarTodo("/persons")).map((p) => [cad(p.username), p.id]));
  // Sigla -> nombre de usuario, tomado de la PLANILLA: la hoja de asignaciones
  // identifica el club por su sigla (`code`) y la API por `username`.
  const usuarioPorSigla = new Map(clubes.map((c) => [cad(c.code), cad(c.username)]));

  const leerMembresias = async () => {
    const m = new Map();
    for (const a of await ses.listarTodo("/swimmer-assignments?status=active")) m.set(cad(a.personId), a);
    return m;
  };
  let membresias = await leerMembresias();
  anotar(`  membresías activas ahora: ${membresias.size}`);

  const porSigla = new Map();
  for (const a of asignaciones) {
    if (!porSigla.has(a.sigla)) porSigla.set(a.sigla, []);
    porSigla.get(a.sigla).push(a);
  }
  if (porSigla.size !== ESPERADO.clubesConNadadores) {
    abortar(`Las asignaciones se agrupan en ${porSigla.size} clubes y lo previsto son ${ESPERADO.clubesConNadadores}`);
  }

  let asignados = 0;
  let conciliados = 0;
  // En seco y sobre un sistema vacio, los clubes y las personas de las etapas 1
  // y 2 **todavia no existen**: no es un fallo, es el orden. Se cuenta y se
  // dice, en lugar de detenerse.
  let noComprobables = 0;

  for (const [sigla, filas] of porSigla) {
    const usuarioDelClub = usuarioPorSigla.get(cad(sigla));
    if (!usuarioDelClub) abortar(`La sigla «${sigla}» de la hoja de asignaciones no está en la planilla de clubes`);
    const targetClubId = clubPorUsuario.get(usuarioDelClub);
    if (!targetClubId) {
      if (!confirmar) {
        noComprobables += filas.length;
        continue;
      }
      abortar(`No encuentro en la API el club «${usuarioDelClub}» (sigla «${sigla}»). La etapa 1 tiene que haber terminado.`);
    }

    const pendientes = [];
    for (const f of filas) {
      const personId = personaPorUsuario.get(cad(f.username));
      if (!personId) {
        if (!confirmar) {
          noComprobables++;
          continue;
        }
        abortar(`No encuentro en la API a la persona «${f.username}». La etapa 2 tiene que haber terminado.`);
      }

      const actual = membresias.get(cad(personId));
      if (!actual) {
        pendientes.push(personId);
        continue;
      }
      // Ya tiene membresía activa: se concilia CLUB y FECHA EFECTIVA.
      const d = conciliarMembresia({ clubId: targetClubId }, actual);
      if (d.length) {
        res.escribir({ clave: sigla, estado: "DIFERENCIA", persona: f.username, diferencias: d });
        abortar(`La persona «${f.username}» ya tiene una membresía activa que NO coincide con lo aprobado`, {
          clubAprobado: sigla,
          diferencias: d,
        });
      }
      conciliados++;
    }

    if (pendientes.length === 0) {
      if (confirmar && !res.previos.has(sigla)) {
        res.escribir({ clave: sigla, estado: "ya_estaba_conciliado", nadadores: filas.length });
      }
      continue;
    }

    const carga = { targetClubId, personIds: pendientes, fechaEfectiva: FECHA_EFECTIVA };
    verificarCargaUtil("asignacion", carga);
    if (!confirmar) continue;

    const r = await ses.pedir("POST", "/swimmer-assignments/bulk-assign", { json: carga });
    if (!r.ok) {
      res.escribir({ clave: sigla, estado: "inesperado", http: r.estado, cuerpo: r.cuerpo });
      abortar(`Club «${sigla}»: la asignación masiva respondió ${r.estado}`, r.cuerpo);
    }
    // La respuesta es un RESUMEN con resultado por fila: puede traer 200 y
    // errores dentro. Se guarda tal cual y después se comprueba por lectura.
    res.escribir({ clave: sigla, estado: "enviado", enviados: pendientes.length, resumen: r.cuerpo });

    // Se relee SOLO este club, no todas las membresías. Releer el conjunto tras
    // cada club multiplicaría las peticiones para comprobar lo mismo.
    for (const a of await ses.listarTodo(`/swimmer-assignments?status=active&clubId=${encodeURIComponent(targetClubId)}`)) {
      membresias.set(cad(a.personId), a);
    }
    for (const personId of pendientes) {
      const actual = membresias.get(cad(personId));
      if (!actual) {
        abortar(`Club «${sigla}»: tras la asignación masiva, una persona sigue sin membresía activa`, { personId, resumen: r.cuerpo });
      }
      const d = conciliarMembresia({ clubId: targetClubId }, actual);
      if (d.length) abortar(`Club «${sigla}»: tras la asignación masiva, una membresía quedó distinta de lo aprobado`, d);
    }
    asignados += pendientes.length;
    res.escribir({ clave: sigla, estado: "creado", nadadores: filas.length, asignados: pendientes.length });
  }

  anotar(`  asignados ahora: ${asignados}   ya estaban y conciliados: ${conciliados}`);
  if (noComprobables) {
    anotar(`  NO comprobables en seco: ${noComprobables} — sus clubes o personas los crean las etapas 1 y 2,`);
    anotar(`  que en seco no se ejecutan. Con --confirmar existirán cuando llegue esta etapa.`);
  }
  return { asignados, conciliados, noComprobablesEnSeco: noComprobables };
}

// --- Programa ----------------------------------------------------------------

function argumento(nombre, porOmision) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : porOmision;
}

/**
 * La raíz del repositorio, si este guion vive dentro de uno.
 *
 * Sirve para una sola cosa: impedir que los resultados por etapa —que llevan
 * nombres de usuario y siglas de clubes reales— caigan dentro del árbol de Git.
 * El repositorio es público.
 */
function raizDelRepositorio() {
  let d = AQUI;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const arriba = path.dirname(d);
    if (arriba === d) break;
    d = arriba;
  }
  return null;
}

function resolverSalida() {
  const pedida = argumento("salida");
  if (!pedida) {
    abortar(
      "Falta --salida. No tiene valor por omisión a propósito: los resultados por etapa " +
        "llevan datos reales y usted elige dónde quedan, fuera del repositorio."
    );
  }
  const salida = path.resolve(pedida);
  const raiz = raizDelRepositorio();
  if (raiz) {
    const dentro = path.relative(raiz, salida);
    if (dentro && !dentro.startsWith("..") && !path.isAbsolute(dentro)) {
      abortar("La carpeta de --salida está DENTRO del repositorio, que es público", {
        salida,
        repositorio: raiz,
        queHacer: "Elija una carpeta fuera del árbol de Git.",
      });
    }
  }
  return salida;
}

async function main() {
  cargarManifiesto(argumento("manifiesto"));

  const etapas = argumento("etapa", "todas");
  const confirmar = process.argv.includes("--confirmar");

  /**
   * La segunda llave de la fecha.
   *
   * Cuando la fecha vivía dentro del guion, una guarda comparaba la constante
   * consigo misma: editarla a mano detenía el cargador. Al salir al manifiesto
   * esa guarda desaparecería, y la fecha —que es lo que la API graba en TODAS
   * las membresías y que, omitida, se convierte en el día de hoy sin avisar—
   * quedaría como un parámetro más de un archivo de configuración.
   *
   * Así que para ESCRIBIR hay que repetirla en la línea de órdenes. Leer no lo
   * exige: una pasada en seco es para ver, y no debe tener fricción.
   */
  if (confirmar) {
    const repetida = argumento("fecha-efectiva");
    if (!repetida) {
      abortar(
        `Para escribir hace falta repetir la fecha: --fecha-efectiva ${FECHA_EFECTIVA} ` +
          "(la que declara el manifiesto). Sin --confirmar no se pide."
      );
    }
    if (repetida !== FECHA_EFECTIVA) {
      abortar("La fecha de --fecha-efectiva no coincide con la del manifiesto", {
        enLaOrden: repetida,
        enElManifiesto: FECHA_EFECTIVA,
      });
    }
  }

  const salida = resolverSalida();
  fs.mkdirSync(salida, { recursive: true });
  registro = path.join(salida, "registro.log");

  anotar("=".repeat(70));
  anotar(`CARGADOR — ${confirmar ? "EJECUCIÓN REAL" : "PASADA EN SECO (no escribe nada)"}`);
  anotar(`fecha efectiva: ${FECHA_EFECTIVA}   etapas: ${etapas}   salida: ${salida}`);

  const base = process.env.API_BASE;
  const usuario = process.env.CARGA_USUARIO;
  const clave = process.env.CARGA_CLAVE;
  /**
   * `--sin-sesion`: comprueba TODO lo que se puede comprobar sin tocar el
   * sistema, y se detiene antes de ingresar.
   *
   * Existe porque la pasada en seco normal **sí** inicia sesión, y eso escribe:
   * un asiento `LOGIN`, una fila en `refresh_tokens` y el `last_login_at` de la
   * cuenta. No crea nada del negocio, pero no es «cero escrituras». Con esta
   * bandera, es cero de verdad.
   */
  const sinSesion = process.argv.includes("--sin-sesion");
  if (!base) abortar("Falta API_BASE en el entorno");
  if (!usuario) abortar("Falta CARGA_USUARIO en el entorno");
  if (!clave && !sinSesion) abortar("Falta CARGA_CLAVE en el entorno. No se escribe en ningún archivo.");

  anotar(`DESTINO: ${base}`);
  anotar(`cuenta: ${usuario}   (la clave viene del entorno y no se registra)`);

  verificarHuellas();

  const clubes = await leerClubes();
  const personas = await leerPersonas();
  const asignaciones = await leerAsignaciones();
  anotar(`planillas: ${clubes.length} clubes, ${personas.length} personas, ${asignaciones.length} asignaciones`);
  if (clubes.length !== ESPERADO.clubes) abortar(`La planilla trae ${clubes.length} clubes y lo aprobado son ${ESPERADO.clubes}`);
  if (personas.length !== ESPERADO.personas) abortar(`La planilla trae ${personas.length} personas y lo aprobado son ${ESPERADO.personas}`);
  if (asignaciones.length !== ESPERADO.asignaciones) {
    abortar(`La planilla trae ${asignaciones.length} asignaciones y lo aprobado son ${ESPERADO.asignaciones}`);
  }

  // Las cargas útiles se construyen y verifican ANTES de abrir sesión: una
  // planilla con un valor imprevisto detiene el proceso sin haber entrado al
  // sistema ni tocado la base.
  for (const c of clubes) verificarCargaUtil("club", construirClub(c));
  anotar(`las ${clubes.length} cargas útiles de club llevan hasLegalStatus = null`);

  if (sinSesion) {
    anotar("");
    anotar("--sin-sesion: todo lo comprobable sin tocar el sistema está comprobado.");
    anotar("NO se inició sesión, así que NO se escribió absolutamente nada: ni un asiento de");
    anotar("auditoría, ni una fila de sesión, ni una marca de último ingreso.");
    anotar("Para ver además el estado inicial del sistema, repita sin --sin-sesion.");
    return;
  }

  const ses = new Sesion(base);
  await ses.entrar(usuario, clave);

  // Estado inicial del DESTINO, junto y explícito, no repartido por etapas.
  const inicial = {
    clubes: (await ses.pedir("GET", "/clubs?page=1&pageSize=1")).cuerpo?.total ?? null,
    personas: (await ses.pedir("GET", "/persons?page=1&pageSize=1")).cuerpo?.total ?? null,
    membresiasActivas: (await ses.pedir("GET", "/swimmer-assignments?status=active&page=1&pageSize=1")).cuerpo?.total ?? null,
  };
  anotar(
    `ESTADO INICIAL DEL DESTINO: ${inicial.clubes} clubes, ${inicial.personas} personas, ${inicial.membresiasActivas} membresías activas`
  );
  if (!confirmar) {
    anotar("  (una carga limpia espera 0 / 0 / 0; cualquier otra cosa exige explicación antes de --confirmar)");
  }

  const r = {};
  if (etapas === "todas" || etapas === "1") r.etapa1 = await etapa1(ses, salida, clubes, confirmar);
  if (etapas === "todas" || etapas === "2") r.etapa2 = await etapa2(ses, salida, personas, confirmar);
  if (etapas === "todas" || etapas === "3") r.etapa3 = await etapa3(ses, salida, asignaciones, clubes, confirmar);

  r.renovacionesDeToken = ses.renovaciones;
  r.esperasPorLimiteDeSolicitudes = ses.esperasPorLimite;
  r.solicitudesTotales = ses.solicitudes;
  r.picoDeSolicitudesPorMinuto = ses.picoPorMinuto;
  anotar(
    `solicitudes: ${ses.solicitudes} en total, pico de ${ses.picoPorMinuto} por minuto ` +
      `(el limite declarado en el manifiesto son ${LIMITE_POR_MINUTO})`
  );
  fs.writeFileSync(path.join(salida, "resumen.json"), JSON.stringify({ destino: base, confirmar, etapas, estadoInicial: inicial, ...r }, null, 1), "utf8");
  anotar(`resumen general en ${path.join(salida, "resumen.json")}`);
  anotar(confirmar ? "CARGA TERMINADA. Verifique por SQL de solo lectura." : "PASADA EN SECO TERMINADA. No se escribió nada.");
}

main().catch((e) => {
  if (e instanceof Parada) return; // ya se anotó y ya se fijó el código 2
  const esDeRed =
    (e instanceof TypeError && /fetch failed/i.test(String(e.message))) || e?.cause !== undefined;
  anotar(esDeRed ? "DETENIDO: no se pudo hablar con el destino" : "DETENIDO: error no previsto");
  if (esDeRed) for (const l of detallarRed(e)) anotar(`  ${l}`);
  for (const l of String(e && e.stack ? e.stack : e).split("\n")) anotar(`  ${l}`);
  anotar("No se sobrescribe nada. Lo ya hecho queda en los resultados por etapa.");
  process.exitCode = 2;
});
