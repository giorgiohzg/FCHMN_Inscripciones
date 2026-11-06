import { analizarLibro } from "./analizador";
import { RechazoXlsx, type LimitesXlsx, type RespuestaDelAnalisis } from "./limites";

/**
 * Proceso aislado del análisis. No toca la base ni el entorno: `analisis-aislado.ts` lo
 * crea con el entorno vacío. Solo puede responder un resultado, un rechazo escrito por
 * este sistema o un fallo sin texto: el mensaje de una excepción de una biblioteca no
 * cruza al proceso principal.
 */
async function analizar(archivo: Buffer, limites: LimitesXlsx): Promise<RespuestaDelAnalisis> {
  try {
    return { tipo: "listo", libro: await analizarLibro(archivo, limites) };
  } catch (err) {
    return err instanceof RechazoXlsx ? { tipo: "rechazo", mensaje: err.message } : { tipo: "fallo" };
  }
}

process.once("message", (mensaje) => {
  const { archivo, limites } = mensaje as { archivo: Uint8Array; limites: LimitesXlsx };
  const bytes = Buffer.from(archivo.buffer, archivo.byteOffset, archivo.byteLength);
  void analizar(bytes, limites).then((respuesta) => process.send!(respuesta, () => process.exit(0)));
});
