import type { FastifyRequest } from "fastify";
import { PayloadTooLargeError, ValidationError } from "../../shared/errors";
import { LIMITES_MULTIPART_IMPORTACION, LONGITUD_MAXIMA_NOMBRE_DE_CAMPO } from "../../shared/limites-listas";
import { EXTENSIONES_ADMITIDAS, extensionAdmitida } from "./meet-file-detector";

/** Los únicos campos de texto que lee la importación. Cualquier otro se descarta sin guardarse. */
export const CAMPOS_ADMITIDOS = ["maxIndividualEventsPerSwimmer", "relayDecisions"] as const;
type CampoAdmitido = (typeof CAMPOS_ADMITIDOS)[number];

const esCampoAdmitido = (nombre: string): nombre is CampoAdmitido => (CAMPOS_ADMITIDOS as readonly string[]).includes(nombre);

/** Cuántos caracteres de un nombre de archivo se devuelven al cliente en un mensaje de error. */
const MAXIMO_NOMBRE_EN_MENSAJES = 80;

function nombreAcotado(nombre: string): string {
  return nombre.length > MAXIMO_NOMBRE_EN_MENSAJES ? `${nombre.slice(0, MAXIMO_NOMBRE_EN_MENSAJES)}…` : nombre;
}

/**
 * Deja de leer el resto de la solicitud tras rechazarla.
 *
 * El plugin sigue enviando el cuerpo a su analizador mientras no se cierre la solicitud: si una parte
 * quedó sin consumir (un archivo que se rechaza sin leerlo, por ejemplo), el flujo se detiene por
 * contrapresión y el cliente quedaría esperando. Se separa el analizador y se descarta lo que falte.
 */
function descartarResto(req: FastifyRequest): void {
  try {
    req.raw.unpipe();
    req.raw.resume();
  } catch {
    // Solo es una limpieza: el error que se informa es el del rechazo.
  }
}

/**
 * Lee el multipart de analizar e importar Meet Events y devuelve el archivo y los campos admitidos.
 *
 * Es el MISMO lector para las dos fases, para que sus criterios no diverjan: un archivo aceptado en
 * el análisis no puede rechazarse en la confirmación después de que el usuario ya decidió.
 *
 * Límites (SEC-01), por llamada y combinados con la configuración global del servidor:
 *  - `fieldSize`, `fields`, `files` y `parts` de `LIMITES_MULTIPART_IMPORTACION`;
 *  - NO se indica `fileSize`: el máximo global del archivo (15 MB) rige tal cual.
 *
 * Qué ocurre al excederlos (todas las respuestas son de texto fijo, sin reproducir lo recibido):
 *  - campo truncado por `fieldSize` (o con el nombre truncado): 413 `PAYLOAD_TOO_LARGE`. El plugin
 *    NO falla por esto: entrega el valor cortado con `valueTruncated`, y un fragmento cortado puede
 *    seguir siendo JSON válido (por ejemplo, `{…}` seguido de espacios), así que se rechaza ANTES de
 *    guardarlo o interpretarlo;
 *  - nombre de parte de más de `LONGITUD_MAXIMA_NOMBRE_DE_CAMPO` caracteres: 413 `PAYLOAD_TOO_LARGE`
 *    (busboy no limita la longitud del nombre);
 *  - demasiados campos, archivos o partes: 413 del propio plugin (`FST_FIELDS_LIMIT`,
 *    `FST_FILES_LIMIT`, `FST_PARTS_LIMIT`); se informa el PRIMER límite que se alcance;
 *  - un archivo cuyo campo no se llama `file`: 400 `VALIDATION_ERROR`, sin leerlo.
 */
export async function leerMultipartDeImportacion(req: FastifyRequest) {
  let fileBuffer: Buffer | null = null;
  let fileName = "";
  const campos: Partial<Record<CampoAdmitido, string>> = {};

  try {
    for await (const part of req.parts({ limits: { ...LIMITES_MULTIPART_IMPORTACION } })) {
      if (part.fieldname.length > LONGITUD_MAXIMA_NOMBRE_DE_CAMPO) {
        throw new PayloadTooLargeError(`El nombre de un campo del formulario supera los ${LONGITUD_MAXIMA_NOMBRE_DE_CAMPO} caracteres admitidos.`);
      }

      if (part.type === "file") {
        if (part.fieldname !== "file") {
          // Sin leerlo: no hay nada que hacer con un adjunto que no es el esperado, y dejarlo sin consumir bloquea la lectura.
          throw new ValidationError("Solo se admite un archivo, adjunto en el campo «file».");
        }
        fileBuffer = await part.toBuffer();
        fileName = part.filename ?? "";
        continue;
      }

      if (part.valueTruncated || part.fieldnameTruncated) {
        const nombre = esCampoAdmitido(part.fieldname) ? `«${part.fieldname}»` : "de un campo";
        throw new PayloadTooLargeError(`El valor ${nombre} del formulario supera el tamaño admitido (${LIMITES_MULTIPART_IMPORTACION.fieldSize / 1024} KiB).`);
      }
      if (esCampoAdmitido(part.fieldname)) campos[part.fieldname] = part.value as string;
    }
  } catch (error) {
    descartarResto(req);
    throw error;
  }

  if (!fileBuffer) {
    throw new ValidationError(`Debe adjuntar el archivo exportado desde Meet Manager (${EXTENSIONES_ADMITIDAS.join(", ")}).`);
  }

  /**
   * Primera barrera, por nombre: barata y suficiente para atajar un
   * adjunto claramente equivocado. NO es la que decide — el contenido se
   * comprueba después, en el servicio, y manda sobre esto.
   */
  if (fileName && !extensionAdmitida(fileName)) {
    throw new ValidationError(
      `La extensión de "${nombreAcotado(fileName)}" no está admitida. Se aceptan: ${EXTENSIONES_ADMITIDAS.join(", ")}. ` +
        "El contenido se verifica igualmente después de subirlo."
    );
  }

  return { fileBuffer, fileName, campos };
}
