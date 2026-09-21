#!/usr/bin/env node
/*
 * GENERADOR DE AVISOS DE TERCEROS
 *
 * Produce las cuatro salidas autosuficientes a partir del inventario extraído
 * de las imágenes. Determinista y SIN RED: dos ejecuciones sobre la misma
 * entrada producen los mismos bytes.
 *
 *   notices/frontend-web.txt    lo que se envía al navegador y nada más
 *   notices/frontend-image.txt  todo lo que contiene la imagen del frontend
 *   notices/backend.txt         todo lo que contiene la imagen del backend
 *   notices/migrate.txt         lo anterior más el CLI de Prisma aislado
 *
 * ENTRADAS
 *   notices/inventario/<artefacto>.json   hechos extraídos de cada imagen
 *   notices/textos/<sha256>.txt           textos tal como viajan, deduplicados
 *   notices/textos-canonicos/<SPDX>.txt   textos canónicos, solo por excepción
 *   notices/excepciones.json              casos sin texto en el artefacto
 *
 * AUTOSUFICIENCIA. La deduplicación es una técnica de esta herramienta, no del
 * artefacto: cada archivo emitido incluye TODO lo necesario para entenderlo.
 * `migrate.txt` no remite a `backend.txt` aunque compartan 239 paquetes.
 *
 *   node scripts/generar-avisos.mjs             escribe las cuatro salidas
 *   node scripts/generar-avisos.mjs --verificar no escribe; falla si divergen
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(RAIZ, "notices");
const SEP = "=".repeat(78);
const SUB = "-".repeat(78);

const ARTEFACTOS = [
  {
    nombre: "frontend-web",
    titulo: "AVISOS DE TERCEROS - Aplicacion web del frontend",
    alcance: [
      "Este aviso cubre EXCLUSIVAMENTE el codigo de terceros que se envia al",
      "navegador: el HTML, el CSS y el JavaScript que compone la aplicacion.",
      "",
      "NO cubre la imagen que sirve esos archivos. El servidor web, sus modulos",
      "y los paquetes del sistema operativo permanecen en el servidor y NO se",
      "entregan al navegador; su aviso es notices/frontend-image.txt.",
    ],
  },
  {
    nombre: "frontend-image",
    titulo: "AVISOS DE TERCEROS - Imagen del frontend",
    alcance: [
      "Este aviso cubre TODO lo que contiene la imagen del frontend: el servidor",
      "web y sus modulos, los paquetes del sistema operativo de la capa base, y",
      "el codigo de terceros de la aplicacion web que la imagen sirve.",
      "",
      "El aviso de lo que efectivamente se envia al navegador, que es un",
      "subconjunto, se publica aparte en notices/frontend-web.txt.",
    ],
  },
  {
    nombre: "backend",
    titulo: "AVISOS DE TERCEROS - Imagen del backend",
    alcance: [
      "Este aviso cubre TODO lo que contiene la imagen del backend: sus",
      "dependencias Node, los paquetes del sistema operativo de la capa base y",
      "los componentes que aporta la imagen base de Node.js.",
    ],
  },
  {
    nombre: "migrate",
    titulo: "AVISOS DE TERCEROS - Imagen de migraciones",
    alcance: [
      "Este aviso cubre TODO lo que contiene la imagen de migraciones: sus",
      "dependencias Node, la herramienta de linea de ordenes de Prisma aislada,",
      "los paquetes del sistema operativo y los componentes de la imagen base.",
      "",
      "Es AUTOSUFICIENTE: aunque comparte arbol de dependencias con la imagen",
      "del backend, aqui se reproduce entero y no remite a otro aviso.",
    ],
  },
];

function leerJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

function textoPorSha(sha) {
  const p = path.join(DIR, "textos", sha + ".txt");
  if (!existsSync(p)) throw new Error(`falta el texto ${sha}.txt referido por el inventario`);
  return readFileSync(p, "utf8");
}

function canonico(spdx, titular) {
  const p = path.join(DIR, "textos-canonicos", spdx + ".txt");
  if (!existsSync(p)) throw new Error(`falta el texto canonico ${spdx}.txt`);
  const bruto = readFileSync(p, "utf8");
  if (titular) return bruto.replace("<TITULAR>", titular);
  // Sin titular verificable no se inventa uno: se retira la linea y se deja
  // constancia de por que.
  return bruto.replace(/^Copyright \(c\) <TITULAR>\n\n/m,
    "(Sin aviso de copyright verificable en el artefacto ni en sus metadatos.\n" +
    "No se atribuye titular alguno: ver notices/excepciones.json.)\n\n");
}

function recortar(s) { return s.replace(/\s+$/, ""); }

function bloqueEncabezado(art) {
  return [
    SEP,
    art.titulo,
    SEP,
    "",
    ...art.alcance,
    "",
    "Generado por scripts/generar-avisos.mjs a partir de",
    `notices/inventario/${art.nombre}.json. NO EDITAR A MANO.`,
    "",
    "El software de FCHMN es propietario y se distribuye bajo los terminos de su",
    "propio archivo LICENSE. Los componentes que siguen son de terceros y se",
    "rigen por las licencias que aqui se reproducen.",
    "",
  ].join("\n");
}

function bloqueNode(paquetes, excepciones) {
  if (paquetes.length === 0) return "";
  const porNombre = new Map();
  for (const c of excepciones.casos) porNombre.set(c.paquete + "@" + c.version, c);
  const noUnicas = new Map();
  for (const c of excepciones.expresionesNoUnicas) noUnicas.set(c.paquete + "@" + c.version, c);

  const partes = [SEP, `DEPENDENCIAS NODE  (${paquetes.length} paquetes)`, SEP, ""];
  for (const p of paquetes) {
    const clave = p.nombre + "@" + p.version;
    const exc = porNombre.get(clave);
    const nu = noUnicas.get(clave);
    partes.push(SUB);
    partes.push(`${p.nombre}@${p.version}`);
    partes.push(`Licencia declarada: ${p.expresion || "(el manifiesto no declara licencia)"}`);
    if (p.repositorio) partes.push(`Repositorio: ${p.repositorio.replace(/^git\+/, "").replace(/\.git$/, "")}`);
    if (nu) {
      partes.push(`Expresion ${nu.tipo}. ${nu.eleccion ? "Alternativa elegida: " + nu.eleccion + "." : "No se elige: se cumplen todas."}`);
      partes.push(`  ${nu.justificacion}`);
    }
    if (exc) {
      partes.push(`ORIGEN DEL TEXTO: ${exc.textoIncorporado}`);
      if (exc.advertencia) partes.push(`ADVERTENCIA: ${exc.advertencia}`);
      if (exc.titularNota) partes.push(`Titular: ${exc.titular || "no atribuido"} - ${exc.titularNota}`);
      if (exc.avisosConservados) partes.push(`Avisos conservados: ${exc.avisosConservados}`);
      if (exc.riesgoResidual) partes.push("RIESGO RESIDUAL REGISTRADO: ver notices/excepciones.json");
    }
    partes.push(SUB);
    partes.push("");

    // La decision se toma sobre CAMPOS, nunca sobre la prosa de la excepcion:
    // una redaccion distinta no debe cambiar lo que se emite.
    if (p.licencias && p.licencias.length > 0) {
      for (const l of p.licencias) {
        if (p.licencias.length > 1) partes.push(`--- ${l.archivo} ---`);
        partes.push(recortar(textoPorSha(l.sha256)));
        partes.push("");
      }
    } else if (!exc) {
      throw new Error(`${clave}: sin texto de licencia y sin entrada en notices/excepciones.json`);
    } else if (exc.textoDesde === "etiqueta") {
      if (!exc.sha256) throw new Error(`${clave}: textoDesde=etiqueta pero falta sha256`);
      partes.push(recortar(textoPorSha(exc.sha256)));
      partes.push("");
    } else if (exc.textoDesde === "canonico") {
      if (!exc.textoCanonico) throw new Error(`${clave}: textoDesde=canonico pero falta textoCanonico`);
      partes.push(`(Texto canonico SPDX de ${exc.textoCanonico}. NO procede del lanzamiento.)`);
      partes.push("");
      partes.push(recortar(canonico(exc.textoCanonico, exc.titularCanonico)));
      partes.push("");
      if (exc.capaAdicional) {
        partes.push(`--- Ademas, codigo vendorizado bajo ${exc.capaAdicional.tipo} ---`);
        partes.push(`Copyright: ${exc.capaAdicional.titular}`);
        partes.push("");
        partes.push(recortar(textoPorSha(exc.capaAdicional.sha256)));
        partes.push("");
      }
    } else if (exc.textoDesde === "artefacto") {
      throw new Error(`${clave}: la excepcion dice que el texto viaja en el artefacto, pero el inventario no lo registra`);
    } else {
      throw new Error(`${clave}: textoDesde desconocido o ausente en notices/excepciones.json`);
    }
  }
  return partes.join("\n");
}

/** Descompone una expresion SPDX en sus atomos, sin interpretarla. */
export function atomos(expresion) {
  if (!expresion || !expresion.trim()) return [];
  return expresion.replace(/[()]/g, " ").split(/\s+(?:OR|AND|or|and)\s+/)
    .map((s) => s.trim()).filter(Boolean);
}

function bloqueCorpus(paquetes, corpus) {
  const usados = new Set();
  for (const p of paquetes) for (const a of atomos(p.expresion)) usados.add(a);
  if (usados.size === 0) return "";
  const porId = new Map(corpus.licencias.map((l) => [l.identificador, l]));

  const partes = [SEP, `TEXTOS DE LICENCIA  (${usados.size} licencias distintas)`, SEP, "",
    "Un identificador no es un aviso. Alpine Linux NO incluye los textos de",
    "licencia dentro de sus paquetes binarios, asi que se entregan aparte: el",
    "directorio `licencias/`, junto a este archivo dentro de la imagen, contiene",
    "el texto completo de cada licencia que obliga a entregarlo.",
    "",
    `Origen de los textos canonicos: ${corpus.fuenteCanonica.nombre} ${corpus.fuenteCanonica.version},`,
    `commit ${corpus.fuenteCanonica.commit}.`,
    "",
  ];
  for (const id of [...usados].sort()) {
    const l = porId.get(id);
    if (!l) { partes.push(`  ${id}  -> SIN REGISTRAR EN EL CORPUS`); continue; }
    if (l.archivo) {
      partes.push(`  ${id.padEnd(30)} -> licencias/${path.basename(l.archivo)}`);
    } else if (l.resuelto) {
      partes.push(`  ${id.padEnd(30)} -> ${l.tratamiento}`);
      partes.push(`  ${" ".repeat(30)}    ${l.nota}`);
    } else {
      partes.push(`  ${id.padEnd(30)} -> SIN RESOLVER: ${l.nota}`);
    }
  }
  partes.push("");
  return partes.join("\n");
}

function bloqueSistema(paquetes, sources, corpus) {
  if (paquetes.length === 0) return "";
  const porFuente = new Map();
  for (const c of sources.componentes) porFuente.set(`${c.paqueteFuente}|${c.versionDistribuida}`, c);
  const porId = new Map(corpus.licencias.map((l) => [l.identificador, l]));

  const partes = [SEP, `PAQUETES DEL SISTEMA OPERATIVO  (${paquetes.length} paquetes)`, SEP, "",
    "Distribuidos como parte de la capa base de la imagen. Cada uno indica su",
    "licencia, el paquete fuente del que sale y en que archivo del directorio",
    "`licencias/` esta su texto completo.",
    ""];
  const anchoN = Math.max(...paquetes.map((p) => p.nombre.length));
  const anchoV = Math.max(...paquetes.map((p) => (p.version || "").length));
  for (const p of paquetes) {
    partes.push(`  ${p.nombre.padEnd(anchoN)}  ${(p.version || "").padEnd(anchoV)}  ${p.expresion || "(sin declarar)"}`);
    const sangria = `  ${" ".repeat(anchoN)}  ${" ".repeat(anchoV)}  `;
    if (p.origen && p.origen !== p.nombre) partes.push(`${sangria}paquete fuente: ${p.origen}`);
    const destinos = atomos(p.expresion).map((a) => {
      const l = porId.get(a);
      if (!l) return `${a}: SIN REGISTRAR`;
      if (l.archivo) return `${a}: licencias/${path.basename(l.archivo)}`;
      if (l.resuelto) return `${a}: ${l.tratamiento}`;
      return `${a}: SIN RESOLVER`;
    });
    if (destinos.length > 0) partes.push(`${sangria}texto: ${destinos.join("  |  ")}`);
  }
  partes.push("");

  const copyleft = paquetes.filter((p) => /GPL|MPL/i.test(p.expresion || ""));
  if (copyleft.length > 0) {
    partes.push(SUB);
    partes.push(`COMPONENTES CON COPYLEFT  (${copyleft.length} binarios)`);
    partes.push(SUB);
    partes.push("");
    partes.push("Estos componentes obligan a poner a disposicion del destinatario la");
    partes.push("fuente CORRESPONDIENTE a las versiones binarias entregadas, no una");
    partes.push("version cualquiera ni un enlace generico que pueda caducar.");
    partes.push("");
    partes.push(`Estado actual: ${sources.estadoDeDisponibilidad.nota}`);
    partes.push("");
    partes.push(`Escenario: ${sources.escenarioActual.consecuencia}`);
    partes.push("");
    partes.push(`Mecanismo previsto: ${sources.mecanismoPrevisto.descripcion}`);
    partes.push("");
    partes.push(`Enlace LGPL: ${sources.mecanismoPrevisto.lgpl.mecanismoDeEnlace}. ${sources.mecanismoPrevisto.lgpl.consecuencia}`);
    partes.push("");
    const vistos = new Set();
    for (const p of copyleft) {
      const c = porFuente.get(`${p.origen}|${p.version}`);
      if (!c || vistos.has(c.paqueteFuente + c.versionDistribuida)) continue;
      vistos.add(c.paqueteFuente + c.versionDistribuida);
      partes.push(`  ${c.paqueteFuente} ${c.versionDistribuida}  [${c.expresion}]`);
      partes.push(`      proyecto        : ${c.proyectoUpstream || "(no registrado)"}`);
      partes.push(`      construido el   : ${c.construido || "(no registrado)"}`);
      if (c.resuelto) {
        // El commit viene del propio artefacto, no de consultar la rama.
        partes.push(`      commit aports   : ${c.commitAports}`);
        partes.push(`      APKBUILD        : ${c.apkbuild}`);
        partes.push(`      espejo oficial  : ${c.espejoOficial}`);
      } else {
        partes.push(`      commit aports   : NO RESUELTO -- ${c.nota}`);
      }
      partes.push("");
    }
  }
  return partes.join("\n");
}

function bloqueAvisosFuente(paquetes, avisosFuente) {
  if (paquetes.length === 0) return "";
  // Deduplicado por paquete FUENTE: varios binarios salen del mismo fuente y
  // comparten sus avisos. Repetirlos por binario solo alargaria el archivo.
  const necesarios = new Map();
  for (const p of paquetes) necesarios.set(`${p.origen}|${p.version}`, p);
  const relevantes = avisosFuente.paquetes
    .filter((a) => necesarios.has(`${a.paqueteFuente}|${a.version}`))
    .sort((a, b) => a.paqueteFuente.localeCompare(b.paqueteFuente));
  if (relevantes.length === 0) return "";

  const con = relevantes.filter((a) => a.estado === "encontrado");
  const ausente = relevantes.filter((a) => a.estado === "verificado-ausente");
  const noVer = relevantes.filter((a) => a.estado === "no-verificable");

  const partes = [SEP, `AVISOS DE COPYRIGHT DE LOS PAQUETES DEL SISTEMA`, SEP, "",
    "El texto de una licencia no sustituye al aviso de copyright de cada",
    "proyecto: titulares, anos y textos propios hay que conservarlos aparte.",
    "",
    `Con aviso propio recuperado : ${con.length}`,
    `Verificado y sin aviso      : ${ausente.length}`,
    `No verificable              : ${noVer.length}`,
    "",
    "«No verificable» NO significa que no exista aviso: significa que la fuente",
    "exacta se publica solo como tarball y comprobarlo exigiria descargar un",
    "binario. No se afirma ausencia sin haber mirado.",
    "",
  ];

  for (const a of con) {
    partes.push(SUB);
    partes.push(`${a.paqueteFuente} ${a.version}`);
    partes.push(`Licencia: ${a.expresionAlpine || "(sin declarar)"}`);
    partes.push(`Binarios: ${a.binarios.join(", ")}`);
    partes.push(`Commit de aports: ${a.commitAports}`);
    partes.push(SUB);
    for (const av of a.avisos) {
      partes.push("");
      partes.push(`--- ${av.archivo} --- ${av.origen}`);
      partes.push(`--- ${av.url}`);
      partes.push("");
      partes.push(recortar(textoPorSha(av.sha256)));
    }
    partes.push("");
  }

  if (ausente.length > 0) {
    partes.push(SUB);
    partes.push("VERIFICADOS Y SIN AVISO PROPIO");
    partes.push(SUB);
    partes.push("");
    for (const a of ausente) {
      partes.push(`  ${a.paqueteFuente} ${a.version}: ${a.nota}`);
      for (const l of a.lugaresInspeccionados) partes.push(`      inspeccionado: ${l}`);
    }
    partes.push("");
  }

  if (noVer.length > 0) {
    partes.push(SUB);
    partes.push("NO VERIFICABLES DENTRO DEL ALCANCE AUTORIZADO");
    partes.push(SUB);
    partes.push("");
    for (const a of noVer) {
      partes.push(`  ${a.paqueteFuente} ${a.version}`);
      partes.push(`      fuente: ${a.fuenteTarball || a.fuenteSinResolver || "(no registrada)"}`);
    }
    partes.push("");
  }
  return partes.join("\n");
}

function bloqueSueltos(sueltos) {
  if (sueltos.length === 0) return "";
  const partes = [SEP, `COMPONENTES DE LAS IMAGENES BASE  (${sueltos.length})`, SEP, ""];
  for (const s of sueltos) {
    partes.push(SUB);
    partes.push(s.componente);
    partes.push(`Ubicacion en la imagen: ${s.ruta}`);
    partes.push(s.nota);
    partes.push(SUB);
    partes.push("");
    partes.push(recortar(textoPorSha(s.sha256)));
    partes.push("");
  }
  return partes.join("\n");
}

function generar(art, excepciones, sources, corpus, avisosFuente) {
  const inv = leerJson(path.join(DIR, "inventario", art.nombre + ".json"));
  const bloques = [
    bloqueEncabezado(art),
    bloqueNode(inv.node || [], excepciones),
    bloqueCorpus(inv.sistema || [], corpus),
    bloqueSistema(inv.sistema || [], sources, corpus),
    bloqueAvisosFuente(inv.sistema || [], avisosFuente),
    bloqueSueltos(inv.sueltos || []),
    SEP,
    "FIN DE LOS AVISOS",
    SEP,
    "",
  ];
  return bloques.filter((b) => b !== "").join("\n") + "\n";
}

const excepciones = leerJson(path.join(DIR, "excepciones.json"));
const sources = leerJson(path.join(DIR, "sources.json"));
const corpus = leerJson(path.join(DIR, "corpus.json"));
const avisosFuente = leerJson(path.join(DIR, "avisos-fuente.json"));
const verificar = process.argv.includes("--verificar");
let divergen = 0;

for (const art of ARTEFACTOS) {
  const contenido = generar(art, excepciones, sources, corpus, avisosFuente);
  const destino = path.join(DIR, art.nombre + ".txt");
  if (verificar) {
    const actual = existsSync(destino) ? readFileSync(destino, "utf8") : null;
    if (actual !== contenido) {
      divergen++;
      console.error(`DIVERGE: ${art.nombre}.txt no coincide con lo que produce el generador`);
    } else {
      console.log(`  OK  ${art.nombre}.txt`);
    }
  } else {
    writeFileSync(destino, contenido);
    console.log(`  escrito ${art.nombre}.txt  (${Buffer.byteLength(contenido, "utf8")} bytes)`);
  }
}

if (verificar && divergen > 0) {
  console.error(`\n${divergen} aviso(s) desactualizado(s). Ejecute: node scripts/generar-avisos.mjs`);
  process.exit(1);
}
