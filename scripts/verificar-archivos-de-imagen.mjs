/**
 * PUERTA OBLIGATORIA, previa a cualquier promoción de etiquetas: qué viaja
 * dentro de `/app/prisma/` en las imágenes ya construidas.
 *
 * Comprueba dos cosas, y las dos son de parada:
 *
 *   1. NADA SIN VERSIONAR. Todo archivo bajo `/app/prisma/` tiene que
 *      corresponder a una ruta versionada en Git. Es una regla positiva a
 *      propósito: enumerar los archivos prohibidos de hoy —tres documentos y
 *      un seed— envejecería, y el próximo documento interno pasaría.
 *   2. NADA ESENCIAL AUSENTE. El esquema y **todas** las migraciones del
 *      repositorio tienen que estar, comparadas por nombre. Una imagen vacía
 *      o recortada cumpliría la primera condición por vacuidad: pasaría la
 *      guarda y luego no migraría nada.
 *
 * SE FALLA ANTE LA DUDA. Si la imagen no se puede inspeccionar, si
 * `/app/prisma` no existe o si está vacío, esto termina con error. Antes la
 * orden era `find ... 2>/dev/null | sort`, que escondía el fallo dos veces:
 * el redirector se tragaba el mensaje y la tubería devolvía el código de
 * `sort`, siempre cero. Ahora `find` se ejecuta solo, su código se respeta y
 * la ordenación se hace aquí.
 *
 * POR QUÉ SOLO `/app/prisma/`. Es el directorio que se copia entero desde el
 * contexto (`COPY prisma ./prisma`), por donde se coló material interno. El
 * resto de `/app` —`node_modules`, `dist`— son artefactos de construcción que
 * por definición no están versionados, así que la regla no les aplica.
 *
 * POR QUÉ NO CORRE EN LA INTEGRACIÓN CONTINUA, dicho con precisión: porque el
 * flujo de hoy **no construye imágenes**, y esto inspecciona imágenes ya
 * construidas. No es que allí falte Docker —`.github/workflows/ci.yml` levanta
 * PostgreSQL como contenedor de servicio, así que el ejecutor lo tiene—; es
 * que no hay artefacto que inspeccionar. Mientras siga así, esta comprobación
 * es un paso manual en la máquina de construcción. Lo que sí corre en CI es
 * `backend/tests/dockerignore-contexto.test.ts`, que vigila el CONTEXTO.
 *
 * SOLO LECTURA: lista archivos en contenedores efímeros y consulta Git. No
 * escribe, no construye, no promociona y no borra nada.
 *
 * Uso:
 *   node scripts/verificar-archivos-de-imagen.mjs <imagen> [<imagen>...]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRECTORIO = "/app/prisma";

const imagenes = process.argv.slice(2);
if (imagenes.length === 0) {
  console.error("Uso: node scripts/verificar-archivos-de-imagen.mjs <imagen> [<imagen>...]");
  process.exit(2);
}

/** Migraciones que el repositorio declara, por nombre de directorio. */
function migracionesDelRepositorio() {
  const dir = path.join(RAIZ, "backend", "prisma", "migrations");
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * Lista los archivos de `/app/prisma`. LANZA si no puede: imagen que no se
 * deja inspeccionar, directorio ausente o vacío.
 */
function listarArchivos(imagen) {
  // `test -d` separado de `find`: distingue "no existe el directorio" de
  // "find fallo por otra razon", y los dos son motivo de parada.
  let salida;
  try {
    salida = execFileSync(
      "docker",
      // `--pull=never`: inspeccionar no es excusa para descargar nada; si la
      // imagen no está, se falla. `--read-only`: esto solo lee, y el propio
      // contenedor lo impone en vez de confiar en que la orden se porte bien.
      ["run", "--rm", "--network", "none", "--pull=never", "--read-only", "--entrypoint", "sh", imagen, "-c",
        `test -d ${DIRECTORIO} || { echo "AUSENTE" >&2; exit 3; }; find ${DIRECTORIO} -type f`],
      { maxBuffer: 32 * 1024 * 1024 }
    ).toString("utf8");
  } catch (e) {
    const codigo = e?.status ?? "desconocido";
    const motivo = codigo === 3 ? `${DIRECTORIO} no existe en la imagen` : `no se pudo inspeccionar (codigo ${codigo})`;
    throw new Error(motivo);
  }
  const archivos = salida.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
  if (archivos.length === 0) throw new Error(`${DIRECTORIO} existe pero está vacío`);
  return archivos;
}

/** ¿La ruta equivalente del árbol está versionada en Git? */
function versionado(rutaRepo) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", rutaRepo], { cwd: RAIZ, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const esperadas = migracionesDelRepositorio();
let fallos = 0;

for (const imagen of imagenes) {
  console.log(`\n=== ${imagen} ===`);

  let archivos;
  try {
    archivos = listarArchivos(imagen);
  } catch (e) {
    console.log(`  FALLO: ${e.message}`);
    fallos++;
    continue;
  }
  console.log(`  archivos bajo ${DIRECTORIO}: ${archivos.length}`);

  // --- 1. nada sin versionar ---------------------------------------------
  const intrusos = archivos
    .map((ruta) => ({ ruta, rutaRepo: "backend/" + ruta.replace(/^\/app\//, "") }))
    .filter((x) => !versionado(x.rutaRepo));
  if (intrusos.length === 0) {
    console.log("  [1/2] sin versionar: ninguno");
  } else {
    console.log(`  [1/2] NO CONFORME: ${intrusos.length} archivo(s) sin versionar viajan en la imagen`);
    for (const i of intrusos) console.log(`        ${i.ruta}   (equivalente: ${i.rutaRepo})`);
    console.log("        Revise backend/.dockerignore antes de promover nada.");
    fallos += intrusos.length;
  }

  // --- 2. nada esencial ausente ------------------------------------------
  const ausentes = [];
  if (!archivos.includes(`${DIRECTORIO}/schema.prisma`)) ausentes.push("schema.prisma");
  for (const m of esperadas) {
    if (!archivos.includes(`${DIRECTORIO}/migrations/${m}/migration.sql`)) ausentes.push(`migrations/${m}/migration.sql`);
  }
  if (ausentes.length === 0) {
    console.log(`  [2/2] esenciales presentes: schema.prisma y las ${esperadas.length} migraciones`);
  } else {
    console.log(`  [2/2] NO CONFORME: faltan ${ausentes.length} archivo(s) esencial(es)`);
    for (const a of ausentes) console.log(`        ${a}`);
    fallos += ausentes.length;
  }
}

console.log(`\nRESULTADO: ${fallos === 0 ? "conforme" : "NO conforme, " + fallos + " hallazgo(s)"}`);
process.exitCode = fallos === 0 ? 0 : 1;
