#!/usr/bin/env node
/*
 * DERIVAR `backend/Dockerfile.mantenimiento` DE `backend/Dockerfile`.
 *
 * POR QUÉ EXISTE.
 *
 * `backend/Dockerfile` produce DOS imágenes desde el mismo archivo: la que
 * SIRVE la API (`runtime`) y la que trae las herramientas de MIGRACIÓN y seeds
 * (`migrate`). Compose elige cuál quiere con `target:`, y el procedimiento de
 * construcción y revalidación con `--target`.
 *
 * Las plataformas que construyen desde un repositorio Git no tienen `--target`.
 * Lo que sí tienen —y está en la documentación de Railway— es la posibilidad de
 * señalar OTRO archivo: `RAILWAY_DOCKERFILE_PATH`. Y construir un `Dockerfile`
 * sin elegir etapa produce LA ÚLTIMA. De ahí la solución, que no depende de
 * ningún comportamiento no documentado:
 *
 *   backend/Dockerfile                 termina en `runtime`  -> sale la API
 *   backend/Dockerfile.mantenimiento   termina en `migrate`  -> salen las herramientas
 *
 * POR QUÉ DERIVADO Y NO ESCRITO A MANO. El segundo archivo necesita las mismas
 * etapas `base`, `build`, `deps` y `cli-migrate` que el primero: los mismos
 * digests fijados, el mismo `npm ci` con sus banderas, la misma guarda del
 * árbol instalado. Dos copias escritas a mano divergen —alguien sube el digest
 * de Node en una y no en la otra— y entonces las dos imágenes dejan de ser las
 * que describen `notices/backend.txt` y `notices/migrate.txt`. El aviso de
 * licencias pasaría a describir algo que no es.
 *
 * Derivar elimina esa posibilidad: hay UN archivo fuente, y la regla de
 * derivación es tan simple que se puede comprobar de un vistazo.
 *
 * LA REGLA, completa:
 *
 *   1. un encabezado que advierte que el archivo es generado;
 *   2. el contenido de `backend/Dockerfile`, byte a byte;
 *   3. una etapa final `FROM migrate AS mantenimiento`, que es un ALIAS: `FROM`
 *      sin instrucciones detrás hereda `CMD`, `USER`, `WORKDIR`, `ENV` y `PATH`
 *      del origen, y no agrega ni quita capas.
 *
 * Nada más. No se reescribe, no se reordena y no se filtra ninguna línea.
 *
 * MODOS
 *
 *   node scripts/generar-dockerfile-mantenimiento.mjs             escribe
 *   node scripts/generar-dockerfile-mantenimiento.mjs --verificar falla si diverge
 *
 * El modo `--verificar` corre en la integración continua. Sin él, una edición
 * del archivo fuente dejaría el derivado describiendo una construcción que ya
 * no existe, y el servicio de mantenimiento se construiría con una base
 * distinta de la de la API sin que nadie lo notara.
 *
 * SOLO TOCA EL ARCHIVO DERIVADO. Nunca escribe en `backend/Dockerfile`.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUENTE = path.join(RAIZ, "backend", "Dockerfile");
const DERIVADO = path.join(RAIZ, "backend", "Dockerfile.mantenimiento");

/** Nombre de la etapa de la que cuelga el alias final. Debe existir en la fuente. */
const ETAPA = "migrate";

const ENCABEZADO = `# =============================================================================
# ARCHIVO GENERADO. NO EDITAR A MANO.
#
# Se deriva de \`backend/Dockerfile\` con:
#
#   node scripts/generar-dockerfile-mantenimiento.mjs
#
# y la integración continua comprueba que no haya divergido:
#
#   node scripts/generar-dockerfile-mantenimiento.mjs --verificar
#
# QUÉ ES. El mismo archivo que construye la API, con UNA etapa más al final que
# lo hace terminar en \`${ETAPA}\` en lugar de \`runtime\`. Así, construirlo sin
# elegir etapa produce la imagen de MIGRACIONES Y SEEDS.
#
# PARA QUÉ. Las plataformas que construyen desde un repositorio Git no admiten
# \`--target\`, pero sí señalar otro archivo. En Railway, el servicio de
# mantenimiento declara:
#
#   RAILWAY_DOCKERFILE_PATH=Dockerfile.mantenimiento
#
# Cualquier cambio en la construcción se hace en \`backend/Dockerfile\`, que es
# la fuente. Editar este archivo se pierde en la próxima generación, y mientras
# tanto hace divergir las dos imágenes.
#
# EN LOCAL no hace falta: Compose y el procedimiento de construcción y
# revalidación eligen la etapa con \`target:\` y \`--target\` sobre el archivo
# fuente, que es más directo.
#
#   docker build -f backend/Dockerfile.mantenimiento ./backend
#   docker buildx build --target ${ETAPA} ./backend          # equivalente
#
# EL FILTRO DEL CONTEXTO ES EL MISMO. Docker lee \`.dockerignore\` del directorio
# del CONTEXTO, no del archivo, así que este archivo usa \`backend/.dockerignore\`
# igual que la fuente. Las guardas de contexto siguen cubriendo las dos.
# =============================================================================

`;

const PIE = `
# --- Alias que hace de esta la última etapa ----------------------------------
#
# NO AGREGA NI QUITA NADA: \`FROM <etapa>\` sin instrucciones detrás hereda la
# configuración del origen —\`CMD\`, \`USER\`, \`WORKDIR\`, \`ENV\` y \`PATH\`— y sus
# mismas capas. Su único efecto es ser la última etapa del archivo, que es la
# que se construye cuando nadie elige una.
FROM ${ETAPA} AS mantenimiento
`;

if (!existsSync(FUENTE)) {
  console.error(`No existe el archivo fuente: ${path.relative(RAIZ, FUENTE)}`);
  process.exit(1);
}

const fuente = readFileSync(FUENTE, "utf8");

/**
 * SE FALLA ANTE LA DUDA. Si la etapa de la que cuelga el alias ya no existe en
 * la fuente —alguien la renombró—, el archivo derivado no construiría, y el
 * error aparecería en la plataforma y no aquí. Se comprueba ahora.
 */
const declaraEtapa = new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${ETAPA}\\s*$`, "im").test(fuente);
if (!declaraEtapa) {
  console.error(`La fuente ${path.relative(RAIZ, FUENTE)} no declara ninguna etapa llamada "${ETAPA}".`);
  console.error("Si la etapa se renombró, actualice la constante ETAPA de este guion.");
  process.exit(1);
}

const contenido = ENCABEZADO + fuente + PIE;
const verificar = process.argv.includes("--verificar");
const actual = existsSync(DERIVADO) ? readFileSync(DERIVADO, "utf8") : null;

if (verificar) {
  if (actual === contenido) {
    console.log("  OK  backend/Dockerfile.mantenimiento coincide con backend/Dockerfile");
    process.exit(0);
  }
  console.error(
    actual === null
      ? "DIVERGE: backend/Dockerfile.mantenimiento no existe"
      : "DIVERGE: backend/Dockerfile.mantenimiento no coincide con lo que produce la derivación"
  );
  console.error("\nEjecute: node scripts/generar-dockerfile-mantenimiento.mjs");
  process.exit(1);
}

if (actual === contenido) {
  console.log("  sin cambios  backend/Dockerfile.mantenimiento ya estaba al día");
} else {
  writeFileSync(DERIVADO, contenido);
  console.log(`  escrito backend/Dockerfile.mantenimiento  (${Buffer.byteLength(contenido, "utf8")} bytes)`);
}
