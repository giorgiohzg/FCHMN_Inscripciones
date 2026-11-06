import { fork, type ChildProcess } from "node:child_process";
import { extname, join } from "node:path";
import { ValidationError } from "../../../shared/errors";
import { LIMITES_XLSX, type LibroAnalizado, type LimitesXlsx, type RespuestaDelAnalisis } from "./limites";

/**
 * Lanza el análisis en un PROCESO aparte y lo MATA al vencer el plazo.
 *
 * Es un proceso y no un `worker_thread` por un fallo medido: al agotar el montón, una
 * reserva grande en un hilo con `resourceLimits` aborta el proceso ENTERO (salida 134),
 * no solo el hilo, porque V8 lo trata como un error fatal. Un proceso hijo sí contiene
 * ese fallo, y `SIGKILL` lo corta también dentro de código nativo. Un `Promise.race` no
 * cancela nada: el trabajo seguiría consumiendo CPU y memoria después de responder.
 *
 * La promesa no se resuelve hasta que el hijo terminó de verdad, así que quien libera el
 * turno de la carga sabe que ya no queda nada corriendo.
 *
 * `--max-old-space-size` acota solo el montón de V8. NO cubre los buffers externos (el
 * archivo, la salida de zlib): esos los acotan los presupuestos de `inspeccion-zip.ts`, que
 * son previos. Y el hijo comparte la memoria de la instancia: si la agota, el sistema puede
 * matar a cualquiera de los dos. Lo que la protege es la suma de presupuestos, una sola
 * carga activa y este límite; ninguno de ellos por sí solo.
 *
 * El entorno va vacío: el analizador no necesita ninguna variable, y procesa un archivo ajeno.
 */
function lanzamiento(): { ruta: string; execArgv: string[]; env: Record<string, string> } {
  // Con `tsx` y con Vitest este archivo es el .ts; en producción, el .js de `dist`.
  if (extname(__filename) === ".js") return { ruta: join(__dirname, "analizador.proceso.js"), execArgv: [], env: {} };

  // En desarrollo, `tsx` necesita saber la carpeta temporal para su caché. Nada más.
  const temporales = ["TEMP", "TMP", "TMPDIR"].flatMap((clave) => {
    const valor = process.env[clave];
    return valor ? [[clave, valor] as const] : [];
  });
  return { ruta: join(__dirname, "analizador.proceso.ts"), execArgv: ["--import", "tsx"], env: Object.fromEntries(temporales) };
}

/** Lo que no lleva respuesta: agotó su memoria, o la instancia lo mató por eso. */
function murioPorMemoria(codigo: number | null, senal: NodeJS.Signals | null): boolean {
  return codigo === 134 || senal === "SIGABRT" || senal === "SIGKILL";
}

/**
 * Se resuelve cuando el hijo ya no existe. Hay que pedirlo ANTES de nada, recién creado: un
 * proceso que no pudo crearse no emite `exit`, sino `error` y `close`, y sin PID ni `kill`
 * funciona (en Windows lanza). La promesa ignora las resoluciones repetidas.
 */
function seguirFinalizacion(hijo: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    hijo.once("exit", () => resolve());
    hijo.once("close", () => resolve());
    hijo.on("error", () => {
      if (hijo.pid === undefined) resolve();
    });
  });
}

export async function analizarXlsxAislado(archivo: Buffer, limites: LimitesXlsx = LIMITES_XLSX): Promise<LibroAnalizado> {
  const { ruta, execArgv, env } = lanzamiento();
  const hijo = fork(ruta, [], {
    execArgv: [...execArgv, `--max-old-space-size=${limites.monticuloAnalisisMb}`],
    env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced", // conserva las fechas y los bytes
  });
  const finalizado = seguirFinalizacion(hijo);

  let temporizador: NodeJS.Timeout | undefined;
  try {
    return await new Promise<LibroAnalizado>((resolve, reject) => {
      temporizador = setTimeout(() => {
        reject(new ValidationError(`El análisis del archivo superó el tiempo máximo (${Math.round(limites.plazoAnalisisMs / 1000)} s). No se importó ninguna fila.`));
      }, limites.plazoAnalisisMs);

      hijo.once("message", (mensaje) => {
        const respuesta = mensaje as RespuestaDelAnalisis;
        if (respuesta.tipo === "listo") resolve(respuesta.libro);
        else if (respuesta.tipo === "rechazo") reject(new ValidationError(respuesta.mensaje));
        else reject(new Error("El análisis del archivo falló."));
      });
      // Sin el texto original: lo inesperado responde el 500 genérico de `resolveErrorResponse`.
      // `on`, no `once`: un segundo `error` sin escuchar derribaría a la API.
      hijo.on("error", () => reject(new Error("El proceso de análisis del archivo falló.")));
      // `close` y no `exit`: llega tras vaciar el canal, así que una respuesta enviada justo
      // antes de salir ya se leyó. Sale también cuando el proceso no pudo crearse.
      hijo.once("close", (codigo, senal) => {
        if (murioPorMemoria(codigo, senal)) reject(new ValidationError("El archivo necesita demasiada memoria para analizarlo. No se importó ninguna fila."));
        else reject(new Error("El proceso de análisis del archivo terminó sin responder."));
      });

      hijo.send({ archivo, limites }, (err) => {
        if (err) reject(new Error("No se pudo entregar el archivo al proceso de análisis."));
      });
    });
  } finally {
    clearTimeout(temporizador);
    // Sin PID no hay proceso: nada que matar ni que esperar, y el turno puede liberarse.
    if (hijo.pid !== undefined) {
      hijo.kill("SIGKILL");
      await finalizado;
    }
  }
}
