#!/usr/bin/env node
/**
 * GUARDIA B — el árbol instalado es exactamente el que el lockfile promete.
 *
 * Se ejecuta DENTRO de la construcción, en la etapa `deps`, inmediatamente
 * después de `npm ci`. Sin dependencias: solo módulos de Node, porque en esa
 * etapa no hay nada de desarrollo instalado.
 *
 * POR QUÉ EXISTE
 * --------------
 * `npm ci --omit=dev` NO omite las entradas marcadas `devOptional`. El CLI de
 * Prisma y su cadena —seis paquetes, unos 46 MiB— viajaban así hasta la imagen
 * de ejecución, que nunca los usa, sin que nada lo advirtiera. La omisión
 * correcta es `--omit=dev --omit=optional`, y esta guardia comprueba que el
 * resultado es el esperado en CADA construcción, sin depender de una lista de
 * excepciones que envejece.
 *
 * QUÉ COMPRUEBA, por RUTA, NOMBRE y VERSIÓN
 * -----------------------------------------
 *   1. Toda entrada del lockfile SIN marcas de omisión está instalada.
 *   2. Ninguna entrada marcada `dev`, `devOptional`, `optional` o `peer` está
 *      instalada.
 *   3. No hay ningún paquete instalado que el lockfile no declare.
 *   4. Los artefactos generados —`.bin`, `.prisma`, `.package-lock.json` y
 *      cualquier otra entrada con punto inicial— NO se cuentan como paquetes.
 *      Se enumeran aparte para que su omisión sea visible, nunca silenciosa.
 *
 * NO se contempla ninguna excepción por plataforma. Hoy no existe ninguna
 * entrada sin marcas con restricción `os`/`cpu`; si mañana apareciera, esta
 * guardia debe FALLAR y forzar una decisión explícita, que es justamente su
 * propósito.
 *
 * FALLA CERRADA: cualquier error de lectura, de formato o de argumentos
 * termina con código distinto de cero. Nunca aprueba por omisión.
 *
 * Módulo ESM (`.mjs`), no por gusto: la etapa `deps` no tiene ninguna
 * herramienta instalada, así que el guion se ejecuta con `node` a secas y la
 * extensión debe fijar el sistema de módulos sin depender del `package.json`
 * que tenga al lado.
 *
 * Uso:
 *   node scripts/verificar-arbol-instalado.mjs --raiz /app
 *   node scripts/verificar-arbol-instalado.mjs --lockfile <ruta> --node-modules <ruta>
 *
 * Códigos: 0 conforme; 1 discrepancias; 2 error de entrada o de lectura.
 */
import fs from "node:fs";
import path from "node:path";

const MARCAS = ["dev", "devOptional", "optional", "peer"];

function salirConError(mensaje, detalle) {
  console.error("GUARDIA B: " + mensaje + (detalle ? " — " + detalle : ""));
  process.exit(2);
}

// --- argumentos --------------------------------------------------------------
const opciones = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const clave = argv[i];
  if (!clave.startsWith("--")) salirConError("argumento inesperado", clave);
  const valor = argv[i + 1];
  if (valor === undefined || valor.startsWith("--")) salirConError("falta el valor de", clave);
  opciones[clave.slice(2)] = valor;
  i++;
}

let rutaLockfile = opciones["lockfile"];
let rutaNodeModules = opciones["node-modules"];
if (opciones["raiz"]) {
  if (rutaLockfile === undefined) rutaLockfile = path.join(opciones["raiz"], "package-lock.json");
  if (rutaNodeModules === undefined) rutaNodeModules = path.join(opciones["raiz"], "node_modules");
}
if (!rutaLockfile || !rutaNodeModules) {
  salirConError("se requiere --raiz, o bien --lockfile y --node-modules");
}

// --- lockfile ----------------------------------------------------------------
let lockfile;
try {
  lockfile = JSON.parse(fs.readFileSync(rutaLockfile, "utf8"));
} catch (e) {
  salirConError("no se pudo leer el lockfile " + rutaLockfile, e.message);
}
if (!lockfile || typeof lockfile.packages !== "object" || lockfile.packages === null) {
  salirConError("el lockfile no tiene el objeto `packages`; se requiere lockfileVersion 2 o 3", rutaLockfile);
}

const esperadas = new Map(); // ruta -> { nombre, version }
const prohibidas = new Map(); // ruta -> { nombre, version, marcas }

for (const [ruta, entrada] of Object.entries(lockfile.packages)) {
  if (ruta === "") continue; // la raíz del proyecto no es un paquete instalado
  if (!entrada || typeof entrada !== "object") {
    salirConError("entrada de lockfile malformada", ruta);
  }
  const corte = ruta.lastIndexOf("node_modules/");
  if (corte === -1) {
    // Un `workspace` u otra entrada que no cuelga de node_modules. No se
    // interpreta a la ligera: se rechaza para que alguien lo mire.
    salirConError("entrada de lockfile fuera de node_modules; revise el diseño de esta guardia", ruta);
  }
  const nombre = ruta.slice(corte + "node_modules/".length);
  const marcas = MARCAS.filter((m) => entrada[m] === true);
  if (marcas.length > 0) prohibidas.set(ruta, { nombre, version: entrada.version, marcas: marcas.join(",") });
  else esperadas.set(ruta, { nombre, version: entrada.version });
}

// --- árbol instalado ---------------------------------------------------------
const instaladas = new Map(); // ruta -> { nombre, version }
const artefactosGenerados = []; // entradas con punto inicial: .bin, .prisma, …
const sinManifiesto = [];

function leerManifiesto(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch (e) {
    return null;
  }
}

function recorrer(dirNodeModules, claveNodeModules) {
  let entradas;
  try {
    entradas = fs.readdirSync(dirNodeModules, { withFileTypes: true });
  } catch (e) {
    return; // no existe ese node_modules anidado: no es un error por sí mismo
  }
  for (const e of entradas) {
    if (!e.isDirectory()) continue;
    // `.bin` son enlaces a ejecutables y `.prisma` es el cliente generado.
    // Ninguno es un paquete npm y ninguno figura en el lockfile.
    if (e.name.startsWith(".")) {
      artefactosGenerados.push(claveNodeModules + "/" + e.name);
      continue;
    }
    if (e.name.startsWith("@")) {
      let hijos;
      try {
        hijos = fs.readdirSync(path.join(dirNodeModules, e.name), { withFileTypes: true });
      } catch (err) {
        salirConError("no se pudo leer el ámbito " + e.name, err.message);
      }
      for (const h of hijos) {
        if (h.isDirectory()) registrar(path.join(dirNodeModules, e.name, h.name), claveNodeModules + "/" + e.name + "/" + h.name);
      }
      continue;
    }
    registrar(path.join(dirNodeModules, e.name), claveNodeModules + "/" + e.name);
  }
}

function registrar(dir, clave) {
  const pj = leerManifiesto(dir);
  if (pj === null || typeof pj.version !== "string") sinManifiesto.push(clave);
  else instaladas.set(clave, { nombre: pj.name, version: pj.version });
  recorrer(path.join(dir, "node_modules"), clave + "/node_modules");
}

if (!fs.existsSync(rutaNodeModules)) {
  salirConError("no existe el árbol instalado", rutaNodeModules);
}
recorrer(rutaNodeModules, "node_modules");

// --- comparación -------------------------------------------------------------
const faltantes = [];
const versionDistinta = [];
const nombreDistinto = [];
const prohibidasPresentes = [];
const noDeclaradas = [];

for (const [ruta, e] of esperadas) {
  const i = instaladas.get(ruta);
  if (!i) { faltantes.push(ruta + "@" + e.version); continue; }
  if (i.version !== e.version) versionDistinta.push(ruta + " lockfile=" + e.version + " instalado=" + i.version);
  if (i.nombre !== e.nombre) nombreDistinto.push(ruta + " lockfile=" + e.nombre + " instalado=" + i.nombre);
}
for (const [ruta, e] of prohibidas) {
  if (instaladas.has(ruta)) prohibidasPresentes.push(ruta + "@" + e.version + " [" + e.marcas + "]");
}
for (const ruta of instaladas.keys()) {
  if (!esperadas.has(ruta) && !prohibidas.has(ruta)) noDeclaradas.push(ruta);
}

// --- informe -----------------------------------------------------------------
console.log("GUARDIA B — arbol instalado frente al lockfile");
console.log("  lockfile                     : " + rutaLockfile);
console.log("  arbol                        : " + rutaNodeModules);
console.log("  entradas sin marcas (exigidas): " + esperadas.size);
console.log("  entradas marcadas (prohibidas): " + prohibidas.size);
console.log("  paquetes instalados           : " + instaladas.size);
console.log("  artefactos generados, no son paquetes: " + artefactosGenerados.length +
  (artefactosGenerados.length ? "  [" + artefactosGenerados.join(" ") + "]" : ""));

let fallos = 0;
function informar(titulo, lista) {
  if (lista.length === 0) { console.log("  OK    " + titulo); return; }
  fallos += lista.length;
  console.log("  FALLA " + titulo + ": " + lista.length);
  for (const x of lista) console.log("          " + x);
}

informar("todas las entradas sin marcas estan instaladas", faltantes);
informar("ninguna version difiere del lockfile", versionDistinta);
informar("ningun nombre difiere del lockfile", nombreDistinto);
informar("ninguna entrada marcada esta instalada", prohibidasPresentes);
informar("ningun paquete instalado falta en el lockfile", noDeclaradas);
informar("todo paquete instalado tiene manifiesto legible", sinManifiesto);

if (fallos === 0) {
  console.log("GUARDIA B: conforme. " + instaladas.size + " paquetes, exactamente los declarados sin marcas de omision.");
  process.exit(0);
}
console.log("GUARDIA B: " + fallos + " discrepancias. La construccion se detiene.");
process.exit(1);
