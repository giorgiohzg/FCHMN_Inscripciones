import AdmZip from "adm-zip";
import { ValidationError } from "./errors";

/**
 * Lectura DEFENSIVA de archivos .zip subidos por usuarios.
 *
 * El único ZIP que procesa el sistema es el "Meet Events" que exporta Hy-Tek
 * Meet Manager: un archivo de texto pequeño dentro de un contenedor. Antes se
 * abría con `new AdmZip(buffer)` y se recorrían sus entradas sin ningún
 * límite, lo que dejaba tres problemas abiertos:
 *
 *  - **Zip bomb**: unos pocos kilobytes comprimidos pueden expandirse a
 *    gigabytes. `getData()` descomprime en memoria; bastaba un ZIP de 1 MB
 *    para tumbar el proceso.
 *  - **Path traversal**: los nombres de entrada pueden contener `..` o rutas
 *    absolutas. Hoy no se extrae nada a disco, pero cualquier cambio futuro
 *    que use `extractAllTo` heredaría el agujero, y el nombre de entrada se
 *    usa en mensajes de error.
 *  - **Agotamiento por cantidad**: un ZIP con cientos de miles de entradas
 *    consume tiempo y memoria solo al listarlas.
 *
 * Los límites de abajo son holgados para el caso real (un .ev3 de unos pocos
 * cientos de kB) y estrechos frente a un abuso.
 */

export interface ZipLimits {
  /** Tamaño máximo del archivo .zip recibido. */
  maxCompressedBytes: number;
  /** Suma máxima de todo lo descomprimido. */
  maxTotalUncompressedBytes: number;
  /** Tamaño máximo de UNA entrada descomprimida. */
  maxEntryUncompressedBytes: number;
  /** Cantidad máxima de entradas. */
  maxEntries: number;
  /** Relación máxima descomprimido/comprimido (detector de zip bomb). */
  maxCompressionRatio: number;
  /**
   * Presupuesto de tiempo, comprobado ENTRE pasos. **No es un timeout duro.**
   *
   * La comprobación ocurre después de cada etapa (abrir el archivo, listar
   * entradas, validar cada una, descomprimir la buscada), así que si una
   * sola llamada a la librería se cuelga o tarda muchísimo, este valor no la
   * interrumpe: se detecta al terminar. `adm-zip` es síncrona y bloquea el
   * hilo, de modo que un corte real exigiría aislar la descompresión en un
   * worker cancelable — trabajo mayor que no está hecho.
   *
   * Lo que sí evita: encadenar muchos pasos costosos (un ZIP con cientos de
   * entradas grandes) hasta consumir el proceso. La defensa principal contra
   * el caso patológico son los límites de tamaño y de tasa de compresión,
   * que se evalúan ANTES de descomprimir.
   */
  maxProcessingMs: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxCompressedBytes: 15 * 1024 * 1024, // igual al límite de subida de Fastify
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  maxEntryUncompressedBytes: 32 * 1024 * 1024,
  maxEntries: 512,
  maxCompressionRatio: 200,
  maxProcessingMs: 10_000,
};

/** Un nombre de entrada seguro: relativo, sin `..`, sin unidad de Windows. */
export function isSafeEntryName(entryName: string): boolean {
  if (entryName.length === 0 || entryName.length > 255) return false;
  // Se normalizan las barras invertidas: algunos generadores usan `\`.
  const normalized = entryName.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false; // ruta absoluta
  if (/^[a-zA-Z]:/.test(normalized)) return false; // unidad de Windows
  if (normalized.split("/").some((segment) => segment === "..")) return false; // traversal
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F]/.test(normalized)) return false; // control characters
  return true;
}

/**
 * Abre un ZIP y devuelve el contenido de la PRIMERA entrada cuyo nombre
 * termine en alguna de las extensiones indicadas, aplicando todos los
 * límites. Nunca escribe a disco.
 */
export function readSingleEntryFromZip(
  buffer: Buffer,
  options: {
    allowedExtensions: string[];
    /** Codificación del contenido; los archivos Hy-Tek son Latin-1. */
    encoding: BufferEncoding;
    notFoundMessage: string;
    limits?: Partial<ZipLimits>;
  }
): { entryName: string; content: string } {
  const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...options.limits };
  const startedAt = Date.now();

  /**
   * Comprobación de presupuesto de tiempo ENTRE pasos — no interrumpe un
   * paso en curso. Ver la nota en `ZipLimits.maxProcessingMs`.
   */
  const assertTimeBudget = () => {
    if (Date.now() - startedAt > limits.maxProcessingMs) {
      throw new ValidationError("El archivo comprimido tardó demasiado en procesarse y se descartó por seguridad.");
    }
  };

  if (buffer.length > limits.maxCompressedBytes) {
    throw new ValidationError(
      `El archivo comprimido pesa ${(buffer.length / 1024 / 1024).toFixed(1)} MB y el máximo admitido es ` +
        `${(limits.maxCompressedBytes / 1024 / 1024).toFixed(0)} MB.`
    );
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new ValidationError("El archivo no es un .zip válido o está dañado.");
  }

  const entries = zip.getEntries();
  assertTimeBudget();

  if (entries.length > limits.maxEntries) {
    throw new ValidationError(`El archivo comprimido contiene ${entries.length} entradas y el máximo admitido es ${limits.maxEntries}.`);
  }

  // Recorrido de control: se validan nombres y tamaños ANTES de descomprimir
  // nada. `header.size` es el tamaño declarado en el índice del ZIP; se
  // verifica también contra lo realmente descomprimido más abajo.
  let totalDeclared = 0;
  for (const entry of entries) {
    assertTimeBudget();

    if (!isSafeEntryName(entry.entryName)) {
      throw new ValidationError("El archivo comprimido contiene una ruta interna no permitida y se descartó por seguridad.");
    }
    if (entry.isDirectory) continue;

    const declared = entry.header.size;
    const compressed = entry.header.compressedSize;

    if (declared > limits.maxEntryUncompressedBytes) {
      throw new ValidationError(
        `Una entrada del archivo comprimido ocupa ${(declared / 1024 / 1024).toFixed(1)} MB al descomprimirse, por sobre el máximo admitido.`
      );
    }
    if (compressed > 0 && declared / compressed > limits.maxCompressionRatio) {
      throw new ValidationError("El archivo comprimido tiene una tasa de compresión anómala (posible archivo malicioso) y se descartó.");
    }

    totalDeclared += declared;
    if (totalDeclared > limits.maxTotalUncompressedBytes) {
      throw new ValidationError("El contenido total descomprimido supera el máximo admitido.");
    }
  }

  const wanted = entries.find(
    (e) => !e.isDirectory && options.allowedExtensions.some((ext) => e.entryName.toLowerCase().endsWith(ext.toLowerCase()))
  );
  if (!wanted) {
    throw new ValidationError(options.notFoundMessage);
  }

  assertTimeBudget();
  const data = wanted.getData();

  // El tamaño declarado en el índice puede mentir: se comprueba lo realmente
  // descomprimido.
  if (data.length > limits.maxEntryUncompressedBytes) {
    throw new ValidationError("El contenido descomprimido supera el máximo admitido.");
  }
  assertTimeBudget();

  return { entryName: wanted.entryName, content: data.toString(options.encoding) };
}
