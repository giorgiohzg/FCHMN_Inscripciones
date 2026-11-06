import { inflateRawSync } from "node:zlib";
import { RechazoXlsx, MENSAJE_XLSX_INVALIDO, type LimitesXlsx } from "./limites";
import { Presupuesto, escanearCadenasCompartidas, escanearHoja, escanearLibro } from "./escaneo-xml";

/**
 * Inspección del ZIP ANTES de entregárselo a ExcelJS.
 *
 * Los tamaños que declara un ZIP no prueban nada, así que cada entrada se descomprime
 * de verdad con un tope: `inflateRawSync` con `maxOutputLength` cuenta los bytes reales a
 * medida que salen y corta en cuanto lo supera, sin acumular el resto.
 *
 * La lectura es deliberadamente más estricta que la de JSZip (el lector de ExcelJS)
 * para que ambos vean las mismas entradas: el fin de directorio debe ser el último del
 * archivo y ocuparlo hasta el final, el directorio debe terminar justo ahí, y se
 * rechazan ZIP64, el cifrado y el campo extra de ruta Unicode, con el que JSZip renombra
 * una entrada.
 *
 * LOS NOMBRES SON LA PARTE DELICADA. El directorio central da uno y JSZip usa el del
 * encabezado LOCAL, que además normaliza (`a/../x`, `./x`, `a//x`). Si un inspector y un
 * lector no coinciden en el nombre, una hoja se inspecciona como si fuera otra cosa. Por
 * eso ambos nombres deben ser idénticos byte a byte, UTF-8 válido y ya canónicos: lo que
 * la normalización cambiaría se rechaza, en vez de normalizarlo aquí también. La única
 * excepción es una barra inicial, que ExcelJS retira a propósito.
 */

const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_LOCAL = 0x04034b50;
const TAM_FIN = 22;
const TAM_CENTRAL = 46;
const TAM_LOCAL = 30;
const MARCA_ZIP64_32 = 0xffffffff;
const MARCA_ZIP64_16 = 0xffff;
const EXTRA_RUTA_UNICODE = 0x7075;
const EXTRA_COMENTARIO_UNICODE = 0x6375;
const METODO_ALMACENADO = 0;
const METODO_DEFLATE = 8;

const invalido = () => new RechazoXlsx(MENSAJE_XLSX_INVALIDO);
const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString("es-CL", { maximumFractionDigits: 1 })} MB`;

export interface EntradaZip {
  /** El nombre con que ExcelJS decide qué es la entrada. */
  nombre: string;
  metodo: number;
  tamComprimido: number;
  tamDeclarado: number;
  /** Donde empiezan los datos comprimidos, según el encabezado local. */
  inicioDatos: number;
}

/**
 * El nombre tal como lo verá ExcelJS, o un rechazo si JSZip pudiera leer otra cosa: bytes
 * que no sean UTF-8 válido, controles, barras invertidas o segmentos que su normalización
 * cambiaría.
 */
function nombreEfectivo(crudo: Buffer): string {
  const nombre = crudo.toString("utf8");
  if (!Buffer.from(nombre, "utf8").equals(crudo)) throw invalido();
  if (crudo.some((byte) => byte < 0x20 || byte === 0x5c)) throw invalido();

  const efectivo = nombre.startsWith("/") ? nombre.slice(1) : nombre;
  const segmentos = efectivo.split("/");
  const ambiguo = segmentos.some((s, i) => s === "." || s === ".." || (s === "" && i !== segmentos.length - 1));
  if (efectivo === "" || ambiguo) throw invalido();
  return efectivo;
}

/** Comprueba el encabezado local, que es el que JSZip lee, y devuelve dónde empiezan los datos. */
function leerLocal(archivo: Buffer, offset: number, nombreCentral: Buffer): number {
  if (offset + TAM_LOCAL > archivo.length || archivo.readUInt32LE(offset) !== FIRMA_LOCAL) throw invalido();
  const largoNombre = archivo.readUInt16LE(offset + 26);
  const largoExtra = archivo.readUInt16LE(offset + 28);
  const inicioNombre = offset + TAM_LOCAL;
  if (inicioNombre + largoNombre + largoExtra > archivo.length) throw invalido();
  if (!archivo.subarray(inicioNombre, inicioNombre + largoNombre).equals(nombreCentral)) throw invalido();
  return inicioNombre + largoNombre + largoExtra;
}

/** Lee el directorio central sin descomprimir nada. */
export function leerDirectorio(archivo: Buffer, limites: LimitesXlsx): EntradaZip[] {
  if (archivo.length > limites.comprimidoMaxBytes) {
    throw new RechazoXlsx(`El archivo pesa más de ${mib(limites.comprimidoMaxBytes)}. No se importó ninguna fila.`);
  }
  if (archivo.length < TAM_FIN) throw invalido();

  const firmaFin = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const fin = archivo.lastIndexOf(firmaFin);
  if (fin < 0 || fin + TAM_FIN > archivo.length) throw invalido();
  if (fin + TAM_FIN + archivo.readUInt16LE(fin + 20) !== archivo.length) throw invalido();

  const disco = archivo.readUInt16LE(fin + 4);
  const discoCentral = archivo.readUInt16LE(fin + 6);
  const entradasDisco = archivo.readUInt16LE(fin + 8);
  const totalEntradas = archivo.readUInt16LE(fin + 10);
  const tamCentral = archivo.readUInt32LE(fin + 12);
  const offsetCentral = archivo.readUInt32LE(fin + 16);

  if (totalEntradas === MARCA_ZIP64_16 || tamCentral === MARCA_ZIP64_32 || offsetCentral === MARCA_ZIP64_32) throw invalido();
  if (disco !== 0 || discoCentral !== 0 || entradasDisco !== totalEntradas) throw invalido();
  if (offsetCentral + tamCentral !== fin) throw invalido();
  if (totalEntradas > limites.entradasMax) {
    throw new RechazoXlsx(`El archivo contiene más de ${limites.entradasMax} partes internas. No se importó ninguna fila.`);
  }

  const entradas: EntradaZip[] = [];
  const nombres = new Set<string>();
  let p = offsetCentral;

  for (let i = 0; i < totalEntradas; i++) {
    if (p + TAM_CENTRAL > fin || archivo.readUInt32LE(p) !== FIRMA_CENTRAL) throw invalido();

    const bandera = archivo.readUInt16LE(p + 8);
    const metodo = archivo.readUInt16LE(p + 10);
    const tamComprimido = archivo.readUInt32LE(p + 20);
    const tamDeclarado = archivo.readUInt32LE(p + 24);
    const largoNombre = archivo.readUInt16LE(p + 28);
    const largoExtra = archivo.readUInt16LE(p + 30);
    const largoComentario = archivo.readUInt16LE(p + 32);
    const offsetLocal = archivo.readUInt32LE(p + 42);

    const inicioExtra = p + TAM_CENTRAL + largoNombre;
    const siguiente = inicioExtra + largoExtra + largoComentario;
    if (siguiente > fin) throw invalido();
    if ((bandera & 0x1) !== 0) throw invalido(); // cifrada
    if (metodo !== METODO_ALMACENADO && metodo !== METODO_DEFLATE) throw invalido();
    if (tamComprimido === MARCA_ZIP64_32 || tamDeclarado === MARCA_ZIP64_32 || offsetLocal === MARCA_ZIP64_32) throw invalido();

    for (let e = inicioExtra; e + 4 <= inicioExtra + largoExtra; ) {
      const id = archivo.readUInt16LE(e);
      if (id === EXTRA_RUTA_UNICODE || id === EXTRA_COMENTARIO_UNICODE) throw invalido();
      e += 4 + archivo.readUInt16LE(e + 2);
    }

    const nombreCentral = archivo.subarray(p + TAM_CENTRAL, inicioExtra);
    const nombre = nombreEfectivo(nombreCentral);
    const inicioDatos = leerLocal(archivo, offsetLocal, nombreCentral);
    if (inicioDatos + tamComprimido > archivo.length) throw invalido();

    // Colisiones tras normalizar: `x`, `/x` y `x/` no pueden convivir.
    const clave = nombre.replace(/\/$/, "");
    if (nombres.has(clave)) throw invalido();
    nombres.add(clave);

    entradas.push({ nombre, metodo, tamComprimido, tamDeclarado, inicioDatos });
    p = siguiente;
  }
  if (p !== fin) throw invalido();
  return entradas;
}

function descomprimir(comprimido: Buffer, entrada: EntradaZip, tope: number, limites: LimitesXlsx): Buffer {
  const excede = () =>
    tope < limites.entradaMaxBytes
      ? new RechazoXlsx(`El contenido del archivo descomprimido supera los ${mib(limites.totalMaxBytes)}. No se importó ninguna fila.`)
      : new RechazoXlsx(`Una parte interna del archivo supera los ${mib(limites.entradaMaxBytes)} al descomprimirla. No se importó ninguna fila.`);

  if (entrada.metodo === METODO_ALMACENADO) {
    if (comprimido.length > tope) throw excede();
    return comprimido;
  }
  try {
    return inflateRawSync(comprimido, { maxOutputLength: tope });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw excede();
    throw invalido();
  }
}

/** Las mismas expresiones con que ExcelJS decide qué es cada entrada: sin anclar. */
const esHoja = (nombre: string) => /xl\/worksheets\/sheet\d+[.]xml/.test(nombre);

/**
 * Recorre el archivo entero midiendo la expansión real y las estructuras del libro. Cada
 * entrada se libera antes de pasar a la siguiente: la memoria no crece con el total. Si
 * termina sin lanzar, ExcelJS va a leer exactamente esos mismos bytes.
 */
export function inspeccionarArchivo(archivo: Buffer, limites: LimitesXlsx): void {
  const entradas = leerDirectorio(archivo, limites);
  const presupuesto = new Presupuesto(limites);
  let hojas = 0;
  let totalReal = 0;

  for (const entrada of entradas) {
    const restante = limites.totalMaxBytes - totalReal;
    const tope = Math.min(limites.entradaMaxBytes, restante);
    const comprimido = archivo.subarray(entrada.inicioDatos, entrada.inicioDatos + entrada.tamComprimido);
    const contenido = descomprimir(comprimido, entrada, tope, limites);
    if (contenido.length !== entrada.tamDeclarado) throw invalido(); // JSZip tampoco lo acepta
    totalReal += contenido.length;

    if (esHoja(entrada.nombre)) {
      if (++hojas > limites.hojasMax) throw demasiadasHojas(limites);
      escanearHoja(contenido, presupuesto);
    } else if (entrada.nombre === "xl/workbook.xml") {
      if (escanearLibro(contenido, presupuesto) > limites.hojasMax) throw demasiadasHojas(limites);
    } else if (entrada.nombre === "xl/sharedStrings.xml") {
      escanearCadenasCompartidas(contenido, limites);
    }
  }
}

const demasiadasHojas = (limites: LimitesXlsx) => new RechazoXlsx(`El archivo tiene más de ${limites.hojasMax} hojas. No se importó ninguna fila.`);
