#!/usr/bin/env node
/*
 * DISTRIBUIR LOS AVISOS DENTRO DE CADA CONTEXTO DE CONSTRUCCIÓN.
 *
 * POR QUÉ EXISTE.
 *
 * Los avisos de terceros se generan en `notices/`, en la raíz del repositorio,
 * porque ahí viven también sus entradas (inventario, textos, corpus) y porque
 * una sola fuente evita que dos copias divergan. Pero los contextos de
 * construcción son `./backend` y `./frontend`, y una instrucción `COPY` no
 * puede salir de su contexto.
 *
 * Hasta ahora eso se resolvía con un CONTEXTO DE CONSTRUCCIÓN ADICIONAL llamado
 * `avisos` (`additional_contexts` en Compose, `--build-context` en buildx). Es
 * la solución correcta cuando quien construye es Docker en la máquina de
 * construcción, y **sigue siendo posible**: este guion no la sustituye, le quita
 * la exclusividad.
 *
 * El problema es que las plataformas que construyen desde un repositorio Git
 * —Railway entre ellas— solo ofrecen UN contexto: el directorio raíz del
 * servicio. Su documentación de Dockerfiles cubre la detección del archivo,
 * `RAILWAY_DOCKERFILE_PATH`, las variables por `ARG` y los montajes de caché, y
 * no menciona contextos adicionales. Con `COPY --from=avisos`, la construcción
 * se detiene en la primera instrucción.
 *
 * QUÉ HACE. Copia, byte a byte, el subconjunto DISTRIBUIBLE de `notices/`
 * dentro de `backend/avisos/` y `frontend/avisos/`, que sí están en contexto.
 * Nada más: las entradas del generador (inventario, textos, corpus,
 * excepciones, procedencia) no se copian, porque no viajan en ninguna imagen.
 *
 * LO QUE NO CAMBIA, y conviene decirlo explícitamente:
 *
 *   - `notices/` sigue siendo la ÚNICA fuente de verdad. Estas copias son
 *     derivadas, igual que los avisos son derivados del inventario.
 *   - El contenido de las imágenes no cambia: los mismos archivos, en las
 *     mismas rutas de destino, con los mismos bytes. La exigencia de igualdad
 *     byte a byte de `scripts/construir-y-revalidar.md` se sigue cumpliendo.
 *   - `backend/tests/avisos-terceros.test.ts` sigue validando `notices/`, que
 *     es donde se genera.
 *
 * POR QUÉ `licencias/` QUEDA DUPLICADO. Es el corpus de textos de licencia, y
 * las dos imágenes lo entregan: el aviso de cada una remite a él en su propia
 * ruta (`/usr/share/licenses/licencias`). Un aviso que remitiera a un archivo
 * ausente no sería un aviso. Son unos 260 KiB por contexto.
 *
 * MODOS
 *
 *   node scripts/distribuir-avisos.mjs             copia y deja constancia
 *   node scripts/distribuir-avisos.mjs --verificar no escribe; falla si divergen
 *
 * El modo `--verificar` es el que convierte esto en una guarda: si alguien
 * regenera los avisos y no vuelve a distribuirlos, las imágenes llevarían
 * dentro una descripción obsoleta de sí mismas y nadie se enteraría. Con la
 * verificación, la divergencia se declara y el proceso termina con error.
 *
 * SE FALLA ANTE LA DUDA. Si un archivo de origen no existe, esto termina con
 * error en vez de dejar un destino a medio escribir: un aviso incompleto es
 * peor que una construcción detenida.
 *
 * No borra nada fuera de los destinos que él mismo gobierna, y dentro de ellos
 * solo retira lo que ya no corresponde a ningún origen (una licencia que salió
 * del corpus, por ejemplo), informándolo.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGEN = path.join(RAIZ, "notices");

/**
 * Qué se distribuye y a dónde.
 *
 * Es una lista EXPLÍCITA, no un copiado del directorio entero: `notices/`
 * contiene además las entradas del generador y los inventarios, que describen
 * el proceso y no viajan en ninguna imagen. Copiarlo completo metería 2,5 MiB
 * de material interno en los dos contextos de construcción.
 *
 * Cada archivo nombrado aquí corresponde a un `COPY` de algún `Dockerfile`:
 *
 *   backend/avisos/backend.txt         -> etapa `runtime`  (imagen de la API)
 *   backend/avisos/migrate.txt         -> etapa `migrate`  (migraciones y seeds)
 *   frontend/avisos/frontend-web.txt   -> se SIRVE por HTTP
 *   frontend/avisos/frontend-image.txt -> aviso de la imagen, no servido
 *   */
const DESTINOS = [
  { contexto: "backend", archivos: ["backend.txt", "migrate.txt"], directorios: ["licencias"] },
  { contexto: "frontend", archivos: ["frontend-web.txt", "frontend-image.txt"], directorios: ["licencias"] },
];

const verificar = process.argv.includes("--verificar");

/** Rutas relativas de todos los archivos bajo `dir`, ordenadas. */
function listarArchivos(dir) {
  if (!existsSync(dir)) return [];
  const encontradas = [];
  (function recorrer(actual, prefijo) {
    for (const entrada of readdirSync(actual, { withFileTypes: true })) {
      const rel = prefijo ? `${prefijo}/${entrada.name}` : entrada.name;
      if (entrada.isDirectory()) recorrer(path.join(actual, entrada.name), rel);
      else encontradas.push(rel);
    }
  })(dir, "");
  return encontradas.sort();
}

/**
 * Pares origen/destino que este guion gobierna, resueltos a rutas absolutas.
 *
 * Se resuelve ANTES de escribir o comparar nada, para que la ausencia de un
 * origen detenga el proceso antes de haber tocado un solo destino.
 */
function resolverPares() {
  const pares = [];
  const faltantes = [];

  for (const destino of DESTINOS) {
    const base = path.join(RAIZ, destino.contexto, "avisos");

    for (const archivo of destino.archivos) {
      const origen = path.join(ORIGEN, archivo);
      if (!existsSync(origen)) faltantes.push(path.relative(RAIZ, origen));
      else pares.push({ origen, destino: path.join(base, archivo), rel: `${destino.contexto}/avisos/${archivo}` });
    }

    for (const directorio of destino.directorios) {
      const origenDir = path.join(ORIGEN, directorio);
      if (!existsSync(origenDir) || !statSync(origenDir).isDirectory()) {
        faltantes.push(path.relative(RAIZ, origenDir) + "/");
        continue;
      }
      for (const rel of listarArchivos(origenDir)) {
        pares.push({
          origen: path.join(origenDir, rel),
          destino: path.join(base, directorio, rel),
          rel: `${destino.contexto}/avisos/${directorio}/${rel}`,
        });
      }
    }
  }

  if (faltantes.length > 0) {
    console.error("No se puede distribuir: faltan archivos de origen en notices/:");
    for (const f of faltantes) console.error(`  ${f}`);
    console.error("\nGenere los avisos primero: node scripts/generar-avisos.mjs");
    process.exit(1);
  }

  return pares;
}

/**
 * Archivos que sobran en los destinos.
 *
 * Una licencia que sale del corpus dejaría su texto huérfano dentro de los dos
 * contextos, y de ahí a las imágenes: un aviso describiría un archivo que ya no
 * corresponde a ninguna dependencia. Se detecta comparando el contenido real
 * del destino con la lista que gobierna este guion.
 */
function sobrantesEn(pares) {
  const gobernados = new Set(pares.map((p) => p.destino));
  const sobrantes = [];
  for (const destino of DESTINOS) {
    const base = path.join(RAIZ, destino.contexto, "avisos");
    for (const rel of listarArchivos(base)) {
      const absoluta = path.join(base, rel);
      if (!gobernados.has(absoluta)) sobrantes.push({ absoluta, rel: `${destino.contexto}/avisos/${rel}` });
    }
  }
  return sobrantes;
}

const pares = resolverPares();
const sobrantes = sobrantesEn(pares);
let divergen = 0;

for (const par of pares) {
  const contenido = readFileSync(par.origen);
  const actual = existsSync(par.destino) ? readFileSync(par.destino) : null;
  const iguales = actual !== null && actual.equals(contenido);

  if (verificar) {
    if (!iguales) {
      divergen++;
      console.error(`DIVERGE: ${par.rel} ${actual === null ? "no existe" : "no coincide con notices/"}`);
    }
    continue;
  }

  if (iguales) continue;
  mkdirSync(path.dirname(par.destino), { recursive: true });
  writeFileSync(par.destino, contenido);
  console.log(`  escrito ${par.rel}  (${contenido.byteLength} bytes)`);
}

for (const sobrante of sobrantes) {
  if (verificar) {
    divergen++;
    console.error(`SOBRA: ${sobrante.rel} no corresponde a ningún archivo de notices/`);
  } else {
    rmSync(sobrante.absoluta);
    console.log(`  retirado ${sobrante.rel}  (ya no está en notices/)`);
  }
}

if (verificar) {
  if (divergen > 0) {
    console.error(`\n${divergen} divergencia(s). Ejecute: node scripts/distribuir-avisos.mjs`);
    process.exit(1);
  }
  console.log(`  OK  ${pares.length} archivo(s) distribuido(s) coinciden con notices/`);
} else {
  console.log(`\n${pares.length} archivo(s) distribuido(s) desde notices/ a backend/avisos y frontend/avisos.`);
}
