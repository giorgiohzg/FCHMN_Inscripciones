/**
 * CONTRAPRUEBA DEL FILTRO REAL DE DOCKER.
 *
 * `backend/tests/dockerignore-contexto.test.ts` comprueba un MODELO de las
 * reglas de `.dockerignore`, escrito a mano. Un modelo puede estar mal y dar
 * un veredicto tranquilizador: lo único que demuestra de verdad que un archivo
 * no entra es que Docker, con su propio filtro, no lo meta.
 *
 * Esto es lo que hace este guion:
 *
 *   1. fabrica un contexto SINTÉTICO en un directorio temporal —ningún dato
 *      local, ningún archivo del proyecto—, con las mismas rutas relativas
 *      que importan;
 *   2. copia ahí el `backend/.dockerignore` REAL, sin modificarlo;
 *   3. construye una imagen mínima `FROM scratch` que solo hace `COPY . /ctx`,
 *      de modo que la imagen contiene exactamente lo que el filtro dejó pasar;
 *   4. exporta esa imagen y lista su contenido;
 *   5. exige que los archivos prohibidos NO estén y que los esperados SÍ.
 *
 * `FROM scratch` no descarga nada y no ejecuta nada: por eso el listado se
 * obtiene exportando el sistema de archivos del contenedor, no con `ls`.
 *
 * HOY NO CORRE EN LA INTEGRACIÓN CONTINUA, y conviene decir por qué con
 * precisión: el flujo de `.github/workflows/ci.yml` **no construye imágenes**.
 * No es que allí falte Docker: ese mismo flujo levanta PostgreSQL como
 * contenedor de servicio, de modo que el ejecutor lo tiene. Incorporar esta
 * contraprueba sería posible; hoy simplemente no está hecho, y mientras no lo
 * esté es **manual**, en la máquina de construcción.
 *
 * La limitación está declarada también en
 * `backend/tests/dockerignore-contexto.test.ts` y en
 * `scripts/construir-y-revalidar.md`: en CI queda el MODELO de las reglas, y
 * la verificación con el filtro real y la inspección de las imágenes
 * construidas son puertas **locales obligatorias** antes de promover.
 *
 * No toca el repositorio, no reconstruye las candidatas del proyecto y
 * elimina solo lo que él mismo crea.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCKERIGNORE = path.join(RAIZ, "backend", ".dockerignore");

/** Deben quedar FUERA del contexto. */
const PROHIBIDOS = [
  "prisma/migrations/AUDITORIA_MIGRACIONES.md",
  "prisma/migrations/PROPUESTA_SESSION_ID.md",
  "prisma/migrations/PROPUESTA_HALLAZGO_22.md",
  "prisma/migrations/PROPUESTA_INVENTADA_PARA_LA_CONTRAPRUEBA.md",
  "prisma/seed-revision.ts",
  ".env",
  "node_modules/dependencia-sintetica/index.js",
  "tests/sintetica.test.ts",
];

/** Deben ENTRAR: el filtro no puede excluir de más. */
const ESPERADOS = [
  "prisma/schema.prisma",
  "prisma/seed.ts",
  "prisma/seed-admin.ts",
  "prisma/migrations/migration_lock.toml",
  "prisma/migrations/20260101000000_sintetica/migration.sql",
  "package.json",
  ".env.example",
  "src/server.ts",
];

import { randomUUID } from "node:crypto";

/**
 * Etiqueta ÚNICA por ejecución. Un sello de fecha puede repetirse si dos
 * corridas caen en el mismo milisegundo; un identificador aleatorio, no.
 */
const etiqueta = `fchmn-contraprueba-dockerignore:${randomUUID().replace(/-/g, "")}`;
const temporal = fs.mkdtempSync(path.join(os.tmpdir(), "fchmn-ctx-"));
/** ID de la imagen que ESTE guion creó. Solo se retira si coincide. */
let imagenId = null;

function docker(args, opciones = {}) {
  return execFileSync("docker", args, { maxBuffer: 64 * 1024 * 1024, ...opciones });
}

/** ID al que apunta una etiqueta, o `null` si no existe. */
function idDe(ref) {
  try {
    return docker(["image", "inspect", ref, "--format", "{{.Id}}"], { stdio: "pipe" }).toString("utf8").trim();
  } catch {
    return null;
  }
}

try {
  // --- 1 y 2. contexto sintetico + el .dockerignore REAL -------------------
  for (const rel of [...PROHIBIDOS, ...ESPERADOS]) {
    const destino = path.join(temporal, rel);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, `contenido sintetico de ${rel}\n`);
  }
  fs.copyFileSync(DOCKERIGNORE, path.join(temporal, ".dockerignore"));
  fs.writeFileSync(path.join(temporal, "Dockerfile"), "FROM scratch\nCOPY . /ctx\n");
  console.log(`contexto sintetico en: ${temporal}`);
  console.log(`.dockerignore copiado del repositorio: ${DOCKERIGNORE}`);

  // --- 3. construir con el filtro real -------------------------------------
  // La etiqueta NO debe existir de antes: si existe, no es nuestra y no se
  // toca. Es la misma regla que gobierna la retirada del final.
  if (idDe(etiqueta) !== null) throw new Error(`la etiqueta ${etiqueta} ya existe: se detiene sin tocarla`);

  docker(["buildx", "build", "--network=none", "--pull=false", "--tag", etiqueta, temporal], { stdio: "pipe" });
  imagenId = idDe(etiqueta);
  if (imagenId === null) throw new Error("la construcción no dejó ninguna imagen con esa etiqueta");
  console.log(`imagen minima construida: ${etiqueta}`);
  console.log(`  id: ${imagenId}`);

  // --- 4. listar lo que quedo dentro ---------------------------------------
  // `FROM scratch` no tiene shell: el contenido se obtiene exportando el
  // sistema de archivos del contenedor, no ejecutando `ls`.
  // `FROM scratch` no declara CMD ni ENTRYPOINT, y `docker create` exige una
  // orden aunque no vaya a ejecutarla nunca: el contenedor solo se crea para
  // exportar su sistema de archivos. Cualquier cadena sirve.
  const contenedor = docker(["create", "--pull=never", etiqueta, "/sin-ejecutar"]).toString("utf8").trim();
  let dentro;
  try {
    const tar = docker(["export", contenedor]);
    dentro = new Set();
    // Lectura minima del formato tar: cabeceras de 512 bytes.
    for (let off = 0; off + 512 <= tar.length; ) {
      const nombre = tar.toString("utf8", off, off + 100).replace(/\0.*$/, "");
      if (!nombre) break;
      const tamano = parseInt(tar.toString("ascii", off + 124, off + 136).replace(/\0.*$/, "").trim() || "0", 8);
      const tipo = tar.toString("ascii", off + 156, off + 157);
      if (tipo === "0" || tipo === "\0") dentro.add(nombre.replace(/^\.?\//, ""));
      off += 512 + Math.ceil(tamano / 512) * 512;
    }
  } finally {
    docker(["rm", "-f", contenedor], { stdio: "pipe" });
  }
  console.log(`archivos dentro de la imagen: ${dentro.size}`);

  // --- 5. veredicto ---------------------------------------------------------
  const fallos = [];
  for (const rel of PROHIBIDOS) {
    if (dentro.has("ctx/" + rel)) fallos.push(`ENTRÓ y no debía: ${rel}`);
  }
  for (const rel of ESPERADOS) {
    if (!dentro.has("ctx/" + rel)) fallos.push(`NO entró y debía: ${rel}`);
  }

  console.log("");
  for (const rel of PROHIBIDOS) console.log(`  ${dentro.has("ctx/" + rel) ? "ENTRÓ  " : "fuera  "} ${rel}`);
  console.log("");
  for (const rel of ESPERADOS) console.log(`  ${dentro.has("ctx/" + rel) ? "dentro " : "AUSENTE"} ${rel}`);

  console.log("");
  if (fallos.length === 0) {
    console.log("RESULTADO: el filtro REAL de Docker se comporta como se espera");
  } else {
    console.log(`RESULTADO: ${fallos.length} fallo(s)`);
    for (const f of fallos) console.log("  - " + f);
    process.exitCode = 1;
  }
} finally {
  /**
   * RETIRADA CON IDENTIDAD COMPROBADA. `docker image rm` es irreversible
   * sobre lo que alcance: si la etiqueta ya no apunta al ID que construimos
   * —porque alguien la reasignó entremedio—, no es nuestra y no se toca. Y si
   * la retirada no se puede CONFIRMAR, esto termina con error informando el
   * residuo, en vez de dar por hecho que se limpió.
   */
  let retirada = false;
  if (imagenId === null) {
    retirada = true; // no se llegó a construir nada
  } else {
    const antes = idDe(etiqueta);
    if (antes === null) {
      retirada = true;
      console.log("la imagen ya no estaba: nada que retirar");
    } else if (antes !== imagenId) {
      console.log(`NO SE RETIRA: ${etiqueta} apunta ahora a ${antes}, no al ID construido (${imagenId})`);
    } else {
      try { docker(["image", "rm", etiqueta], { stdio: "pipe" }); } catch { /* se confirma abajo */ }
      retirada = idDe(etiqueta) === null;
    }
  }

  if (retirada) {
    console.log("imagen de la contraprueba retirada, y comprobado");
  } else {
    console.log(`ATENCIÓN: queda un residuo. etiqueta=${etiqueta}  id=${imagenId}`);
    console.log("  retírelo a mano tras comprobar que es el suyo.");
    process.exitCode = 1;
  }

  fs.rmSync(temporal, { recursive: true, force: true });
  console.log("contexto sintetico eliminado");
}
