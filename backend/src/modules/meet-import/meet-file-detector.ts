/**
 * Detección del contenido de un archivo de importación de competencias.
 *
 * La regla de fondo: **la extensión no decide nada**. Un archivo se acepta por
 * lo que contiene, no por cómo se llama. Alguien puede renombrar un `.pdf` a
 * `.ev3`, y Meet Manager puede entregar el mismo contenido con nombres
 * distintos según la versión y la opción de exportación elegida.
 *
 * Lo que sí decide la extensión es qué se deja SUBIR (el `accept` del
 * formulario y la comprobación de la ruta), como primera barrera cómoda. La
 * segunda barrera, la que manda, es esta.
 *
 * Formas reconocidas hoy:
 *   - contenedor ZIP con un `.ev3` dentro (lo que exporta "Meet Events");
 *   - un `.ev3` suelto, sin comprimir;
 *   - un `.hyv` con la gramática propia de ese formato.
 *
 * Las dos primeras terminan en `parseEv3File` y la tercera en `parseHyvFile`:
 * no hay un importador por extensión, hay uno por formato real. Un archivo
 * llamado `.hyv` cuyo contenido sea en realidad un `.ev3` se importa por la
 * rama `.ev3`, como siempre.
 *
 * Las dos gramáticas son MUTUAMENTE EXCLUYENTES por construcción: el `.ev3`
 * exige líneas terminadas en `*>` y el `.hyv` exige que no las haya. Ningún
 * archivo puede satisfacer las dos, así que el orden en que se comprueban no
 * cambia el resultado.
 */

import { parseUsDate } from "./ev3-parser";

/** Firmas de un archivo ZIP: local file header, empty archive y spanned. */
const FIRMAS_ZIP = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];

export type FormatoImportable =
  | { tipo: "zip" }
  | { tipo: "ev3"; contenido: string }
  | { tipo: "hyv"; contenido: string }
  | { tipo: "desconocido"; motivo: string };

/** Tamaño mínimo por debajo del cual no hay ni encabezado que mirar. */
const BYTES_MINIMOS = 16;

/**
 * ¿Es texto, y no un binario disfrazado?
 *
 * El byte 0 es el descarte más barato y más seguro: una base de datos, un
 * ZIP mal detectado o una imagen lo traen, y estos formatos de texto no pueden
 * tenerlo. Se mira solo el principio porque basta y no cuesta nada.
 */
function pareceTexto(buffer: Buffer): boolean {
  const muestra = buffer.subarray(0, Math.min(buffer.length, 4096));
  return !muestra.includes(0);
}

function lineasUtiles(buffer: Buffer): string[] {
  return buffer
    .toString("latin1")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
}

export function esZip(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  return FIRMAS_ZIP.some((firma) => firma.every((byte, i) => buffer[i] === byte));
}

/**
 * ¿Es esto el texto de un `.ev3`?
 *
 * El formato es texto separado por punto y coma, con una línea de encabezado
 * y una línea por prueba terminada en `*>`. Se exigen las dos marcas juntas:
 * el punto y coma solo aparecería en cualquier CSV, y `*>` solo, en cualquier
 * texto que lo contenga por casualidad.
 *
 * Se lee en latin1 (CP1252) porque es la codificación del formato; la
 * detección no depende de eso, pero leerlo de otra forma podría romper
 * caracteres acentuados antes de llegar al parser.
 */
export function pareceEv3(buffer: Buffer): boolean {
  // Un .ev3 real de una competencia mínima ronda el kilobyte; por debajo de
  // unas pocas decenas de bytes no hay ni encabezado.
  if (buffer.length < BYTES_MINIMOS) return false;
  if (!pareceTexto(buffer)) return false;

  const lineas = lineasUtiles(buffer);
  if (lineas.length < 2) return false;

  const encabezadoTienePuntoYComa = (lineas[0] ?? "").includes(";");
  const hayLineaDePrueba = lineas.slice(1).some((l) => l.trimEnd().endsWith("*>") && l.includes(";"));

  return encabezadoTienePuntoYComa && hayLineaDePrueba;
}

/**
 * ¿Es esto un archivo de la FAMILIA `.hyv`?
 *
 * Reconocer la familia y validar la variante son dos trabajos distintos, y
 * están separados a propósito:
 *
 *   - este detector decide **a qué parser mandar el archivo**;
 *   - `parseHyvFile` decide **si esa variante concreta se puede importar**, y
 *     rechaza cualquier disposición que no sea la verificada.
 *
 * Por eso aquí NO se exige el número exacto de campos. Si se exigiera, un
 * `.hyv` de otra versión de Meet Manager no se reconocería como `.hyv` en
 * absoluto y el usuario recibiría un "formato desconocido" que no le dice
 * nada, en vez del mensaje del parser, que nombra la versión verificada y le
 * ofrece exportar el `.ev3`. Los dos caminos rechazan el archivo; solo uno
 * explica por qué.
 *
 * Aflojar aquí no deja pasar nada nuevo: el parser es ahora MÁS estricto de lo
 * que era este detector, así que todo lo que llegue a importarse cumple la
 * disposición exacta de todos modos.
 *
 * La firma de familia, con todo, sigue siendo específica:
 *   - es texto, con al menos un encabezado y una línea más;
 *   - ninguna línea termina en `*>` — eso sería un `.ev3`, y las dos
 *     gramáticas no deben solaparse nunca;
 *   - el encabezado trae TRES fechas MM/DD/AAAA consecutivas en las
 *     posiciones [1], [2] y [3]. Esto es lo que más discrimina: un `.ev3`
 *     tiene el recinto en [1] y sus fechas en [2]..[4], así que no cuadra, y
 *     un CSV cualquiera no tiene tres fechas seguidas justo ahí;
 *   - alguna línea posterior empieza por un número de prueba positivo y trae
 *     el indicador "I"/"R" en [3].
 */
export function pareceHyv(buffer: Buffer): boolean {
  if (buffer.length < BYTES_MINIMOS) return false;
  if (!pareceTexto(buffer)) return false;

  const lineas = lineasUtiles(buffer);
  if (lineas.length < 2) return false;

  // Un `.ev3` nunca debe entrar por aquí.
  if (lineas.some((l) => l.trimEnd().endsWith("*>"))) return false;

  const encabezado = (lineas[0] ?? "").split(";");
  if (encabezado.length < 4) return false;
  if (![1, 2, 3].every((i) => parseUsDate(encabezado[i] ?? "") !== null)) return false;

  return lineas.slice(1).some((linea) => {
    const campos = linea.split(";");
    if (campos.length < 4) return false;

    const numero = Number(campos[0]);
    if (!campos[0]?.trim() || !Number.isInteger(numero) || numero <= 0) return false;

    return campos[3] === "I" || campos[3] === "R";
  });
}

/**
 * Clasifica el archivo subido.
 *
 * `nombreArchivo` es solo para el mensaje de error: ayuda a quien lo subió a
 * entender qué se miró, pero no influye en la decisión.
 */
export function detectarFormato(buffer: Buffer, nombreArchivo?: string): FormatoImportable {
  if (esZip(buffer)) return { tipo: "zip" };
  if (pareceEv3(buffer)) return { tipo: "ev3", contenido: buffer.toString("latin1") };
  if (pareceHyv(buffer)) return { tipo: "hyv", contenido: buffer.toString("latin1") };

  const nombre = nombreArchivo ? ` ("${nombreArchivo}")` : "";
  return {
    tipo: "desconocido",
    motivo:
      `El archivo${nombre} no tiene el contenido de una exportación de Meet Events. ` +
      "Se aceptan: un .zip que contenga un .ev3, un .ev3 suelto, o un .hyv. " +
      "La extensión por sí sola no basta: el contenido se comprueba siempre.",
  };
}

/**
 * Extensiones que el formulario y la ruta dejan subir.
 *
 * SOBRE `.hyv`, con precisión, porque es fácil leer de más en las dos
 * direcciones:
 *
 * Ya **se contrastó contra un archivo `.hyv` real**, junto con el `.ev3` del
 * mismo evento exportado por la misma instalación, y de ahí salió la gramática
 * que implementa `hyv-parser.ts`. Resultó ser un formato propio: texto con
 * otra disposición de campos, sin la marca `*>` del `.ev3` y con los estilos
 * en códigos numéricos. Ya no se importa reinterpretándolo como un `.ev3`.
 *
 * Lo que eso NO significa:
 *   - **Solo se acepta la versión 7.0Gb de Meet Manager**, y con la
 *     disposición exacta verificada. Cualquier otra se RECHAZA sin crear
 *     competencia: no se interpreta por posición confiando en un aviso.
 *   - El formato **no trae el día ni la jornada de cada prueba**, ni el número
 *     de postas de los relevos. Eso está comprobado, no supuesto, y el
 *     importador lo declara con avisos en vez de rellenarlo por su cuenta.
 *
 * Los archivos reales usados para decodificarlo **no están en el repositorio**
 * y no deben incorporarse: llevan el nombre de un evento y un recinto reales.
 * Los fixtures son sintéticos y los genera
 * `scripts/generar-fixtures-importacion.mjs`.
 *
 * La extensión, aquí, sigue sin decidir nada: solo deja **subir** el archivo.
 * Lo que manda es el contenido, y un `.hyv` cuyo contenido sea en realidad un
 * `.ev3` se importa por la rama `.ev3`.
 */
export const EXTENSIONES_ADMITIDAS = [".zip", ".ev3", ".hyv"] as const;

export function extensionAdmitida(nombreArchivo: string): boolean {
  const punto = nombreArchivo.lastIndexOf(".");
  if (punto < 0) return false;
  const ext = nombreArchivo.slice(punto).toLowerCase();
  return (EXTENSIONES_ADMITIDAS as readonly string[]).includes(ext);
}
