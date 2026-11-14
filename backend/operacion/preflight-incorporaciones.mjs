#!/usr/bin/env node
/**
 * PREFLIGHT DE INCORPORACIONES (C-05), de SOLO LECTURA, previo a las migraciones
 * `20261112000000_c05_incorporaciones` y `20261114000000_competencia_predeterminada`.
 *
 * Uso, con una orden SIMPLE (sin shell, sin comillas y sin SQL en el comando):
 *
 *   node /app/operacion/preflight-incorporaciones.mjs
 *
 * Qué hace, en este orden:
 *   1. Lee `preflight-incorporaciones.sql`, junto a este archivo, y comprueba que existe, que no
 *      está vacío y que su SHA-256 es exactamente `SHA256_ESPERADO`. Si algo falla, termina con 2
 *      SIN tocar la base.
 *   2. Ejecuta Prisma DIRECTAMENTE (`spawn` con argumentos fijos y `shell: false`): ninguna
 *      orden de shell se arma con datos. El SQL abre `BEGIN READ ONLY`, comprueba dentro que
 *      `transaction_read_only` está activo, fija límites de espera y cuenta las dos condiciones.
 *   3. Solo si Prisma termina con 0 e informa «Script executed successfully» imprime la línea
 *      `PREFLIGHT_OK sha256=<hash>` y termina con 0.
 *
 * Códigos de salida:
 *   0  PREFLIGHT_OK          sin datos incompatibles.
 *   1  PREFLIGHT_BLOQUEA     hay datos que requieren revisión humana (solo se informan conteos).
 *   2  PREFLIGHT_ERROR       el SQL no está, está vacío o no coincide con su hash (no se consultó).
 *   3  PREFLIGHT_ERROR       Prisma o la conexión fallaron, o se agotó el tiempo.
 *
 * Nunca imprime la salida original de Prisma, variables de entorno, la URL de conexión ni datos de
 * personas: solo un mensaje propio y, si se reconoce, un código técnico o los dos conteos.
 *
 * Sin dependencias: solo módulos de Node. Se copia a la imagen `migrate` (y a su alias
 * `mantenimiento`) con un `COPY` expreso de `backend/Dockerfile`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** SHA-256 del SQL validado. Cambiar el SQL exige cambiar esto y volver a validarlo. */
export const SHA256_ESPERADO = "1faaf4f4755c7dbd5cc22fbcbc37b03f5935ef9e5f66b9076354c59f30ac21d0";
export const ESQUEMA = "/app/prisma/schema.prisma";
/** Tope total para Prisma, por encima de los límites del propio SQL (60 s por sentencia). */
export const LIMITE_MS = 180_000;
/** Cuánta salida de Prisma se conserva para clasificarla (nunca se imprime). */
const MAXIMO_SALIDA = 64 * 1024;

export const SALIDA = Object.freeze({ OK: 0, BLOQUEA: 1, INTEGRIDAD: 2, EJECUCION: 3 });

/** Comprueba el SQL antes de usarlo. No lanza: devuelve el motivo. */
export function verificarSql(ruta, esperado = SHA256_ESPERADO) {
  let contenido;
  try {
    contenido = readFileSync(ruta);
  } catch {
    return { ok: false, motivo: "el archivo SQL no existe o no se puede leer" };
  }
  if (contenido.length === 0) return { ok: false, motivo: "el archivo SQL está vacío" };
  const hash = createHash("sha256").update(contenido).digest("hex");
  if (hash !== esperado) return { ok: false, motivo: "el archivo SQL no coincide con su SHA-256 esperado" };
  return { ok: true, hash };
}

/**
 * Reduce la salida de Prisma a algo publicable: los dos conteos del bloqueo, o una descripción
 * propia del error. Nunca devuelve el texto original.
 */
export function clasificarSalida(texto) {
  const bloqueo = /PREFLIGHT_BLOQUEA grupos_pendientes_duplicados=(\d+) membresias_activas_inicio_futuro=(\d+)/.exec(texto);
  if (bloqueo) return { tipo: "bloqueo", duplicadas: Number(bloqueo[1]), inicioFuturo: Number(bloqueo[2]) };
  if (/PREFLIGHT_ERROR: la transaccion no es de solo lectura/.test(texto)) {
    return { tipo: "error", detalle: "la transacción no quedó en modo de solo lectura" };
  }
  if (/read-only transaction/i.test(texto)) return { tipo: "error", detalle: "una escritura fue rechazada por la transacción de solo lectura" };
  if (/statement timeout/i.test(texto)) return { tipo: "error", detalle: "se agotó el tiempo máximo de la consulta" };
  if (/lock timeout/i.test(texto)) return { tipo: "error", detalle: "se agotó la espera de un bloqueo" };
  const codigo = /\b(P[0-9]{4})\b/.exec(texto);
  if (codigo) return { tipo: "error", detalle: `Prisma informó el código ${codigo[1]}` };
  return { tipo: "error", detalle: "error no clasificado de Prisma o de la conexión" };
}

/** Ejecuta Prisma sin shell y resuelve con el código de salida que corresponde. */
export function ejecutarPrisma(rutaSql, { esquema = ESQUEMA, limiteMs = LIMITE_MS, binario = "prisma" } = {}) {
  return new Promise((resolver) => {
    let salida = "";
    let terminado = false;
    let reloj = null;
    const acumular = (trozo) => {
      if (salida.length < MAXIMO_SALIDA) salida += trozo.toString("utf8").slice(0, MAXIMO_SALIDA - salida.length);
    };
    const terminar = (resultado) => {
      if (terminado) return;
      terminado = true;
      if (reloj) clearTimeout(reloj);
      resolver(resultado);
    };

    let hijo;
    try {
      hijo = spawn(binario, ["db", "execute", "--file", rutaSql, "--schema", esquema], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      terminar({ codigo: SALIDA.EJECUCION, mensaje: "PREFLIGHT_ERROR: no se pudo iniciar Prisma" });
      return;
    }
    reloj = setTimeout(() => {
      hijo.kill("SIGKILL");
      terminar({ codigo: SALIDA.EJECUCION, mensaje: `PREFLIGHT_ERROR: se agotó el tiempo total (${limiteMs / 1000} s)` });
    }, limiteMs);

    hijo.stdout.on("data", acumular);
    hijo.stderr.on("data", acumular);
    hijo.on("error", () => terminar({ codigo: SALIDA.EJECUCION, mensaje: "PREFLIGHT_ERROR: no se pudo iniciar Prisma" }));
    hijo.on("close", (codigo, senal) => {
      if (codigo === 0 && senal === null && salida.includes("Script executed successfully")) {
        terminar({ codigo: SALIDA.OK });
        return;
      }
      const c = clasificarSalida(salida);
      if (c.tipo === "bloqueo") {
        terminar({
          codigo: SALIDA.BLOQUEA,
          mensaje: `PREFLIGHT_BLOQUEA grupos_pendientes_duplicados=${c.duplicadas} membresias_activas_inicio_futuro=${c.inicioFuturo}`,
        });
        return;
      }
      const como = senal ? `señal ${senal}` : `código ${codigo}`;
      terminar({ codigo: SALIDA.EJECUCION, mensaje: `PREFLIGHT_ERROR: ${c.detalle} (Prisma terminó con ${como})` });
    });
  });
}

export async function principal() {
  const rutaSql = join(dirname(fileURLToPath(import.meta.url)), "preflight-incorporaciones.sql");
  const verificacion = verificarSql(rutaSql);
  if (!verificacion.ok) {
    console.error(`PREFLIGHT_ERROR: ${verificacion.motivo}. No se consultó la base.`);
    return SALIDA.INTEGRIDAD;
  }
  const resultado = await ejecutarPrisma(rutaSql);
  if (resultado.codigo === SALIDA.OK) {
    console.log(`PREFLIGHT_OK sha256=${verificacion.hash}`);
    return SALIDA.OK;
  }
  console.error(resultado.mensaje);
  return resultado.codigo;
}

// Solo al ejecutarse como programa (no al importarse desde las pruebas).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().then(
    (codigo) => {
      process.exitCode = codigo;
    },
    () => {
      console.error("PREFLIGHT_ERROR: fallo inesperado del ejecutor");
      process.exitCode = SALIDA.EJECUCION;
    }
  );
}
