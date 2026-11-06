import { RechazoXlsx, MENSAJE_XLSX_INVALIDO, type LimitesXlsx } from "./limites";

/**
 * Escaneo de las partes XML ANTES de que ExcelJS las vea.
 *
 * `workbook.xlsx.load` construye el modelo completo sin presupuesto propio, y varias de
 * sus estructuras recorren lo que el archivo DECLARA, no lo que contiene:
 *
 *   - `<mergeCell ref>`, `<dataValidation sqref>` y `<definedName>` recorren su rango
 *     celda por celda: `A1:XFD1048576` son 17.000 millones de vueltas;
 *   - `<col max>` crea una columna por cada número;
 *   - el número de fila fija el recorrido de las filas (`sheet.rowCount`).
 *
 * El escaneo mide todo eso con bytes ya descomprimidos y acotados. Es un recorrido de
 * etiquetas, no un analizador XML: no valida el documento, y lo mal formado que deje
 * pasar lo rechaza después el analizador de ExcelJS. Lo que importa es que distinga lo
 * mismo que un analizador real —comentarios, CDATA y atributos entre comillas—, y que
 * rechace lo que no pueda medir: `<!DOCTYPE`, UTF-16 y entidades en un atributo medido.
 *
 * `<dimension>` no se mira: es una declaración, ExcelJS no la usa y aquí se mide lo real.
 */

const LT = 0x3c;
const GT = 0x3e;
const BARRA = 0x2f;
const EXCLAMACION = 0x21;
const INTERROGACION = 0x3f;
const IGUAL = 0x3d;
const COMILLA = 0x22;
const APOSTROFE = 0x27;

const esBlanco = (c: number | undefined) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const estructuraInvalida = () => new RechazoXlsx(MENSAJE_XLSX_INVALIDO);

type Visitante = (nombre: string, atributos: Map<string, string>, finDeEtiqueta: number) => void;

/** Llama a `visitar` por cada etiqueta de apertura cuyo nombre esté en `nombres`. */
export function recorrerEtiquetas(xml: Buffer, nombres: ReadonlySet<string>, visitar: Visitante): void {
  if ((xml[0] === 0xff && xml[1] === 0xfe) || (xml[0] === 0xfe && xml[1] === 0xff)) throw estructuraInvalida();

  const saltarHasta = (marca: string, desde: number) => {
    const fin = xml.indexOf(marca, desde);
    if (fin < 0) throw estructuraInvalida();
    return fin + marca.length;
  };

  const n = xml.length;
  let i = 0;
  for (;;) {
    i = xml.indexOf(LT, i);
    if (i < 0) return;
    const siguiente = xml[i + 1];

    if (siguiente === EXCLAMACION) {
      if (xml.subarray(i, i + 4).toString("latin1") === "<!--") i = saltarHasta("-->", i + 4);
      else if (xml.subarray(i, i + 9).toString("latin1") === "<![CDATA[") i = saltarHasta("]]>", i + 9);
      else throw estructuraInvalida(); // `<!DOCTYPE`: ninguna parte de un .xlsx la lleva
      continue;
    }
    if (siguiente === INTERROGACION) {
      i = saltarHasta("?>", i + 2);
      continue;
    }
    if (siguiente === BARRA) {
      i = saltarHasta(">", i + 2);
      continue;
    }

    let p = i + 1;
    while (p < n && !esBlanco(xml[p]) && xml[p] !== GT && xml[p] !== BARRA) p++;
    const nombre = xml.toString("latin1", i + 1, p);
    const atributos = nombres.has(nombre) ? new Map<string, string>() : null;

    for (;;) {
      while (esBlanco(xml[p])) p++;
      if (p >= n) throw estructuraInvalida();
      if (xml[p] === GT) {
        p++;
        break;
      }
      if (xml[p] === BARRA && xml[p + 1] === GT) {
        p += 2;
        break;
      }
      const inicioDeNombre = p;
      while (p < n && !esBlanco(xml[p]) && xml[p] !== IGUAL && xml[p] !== GT) p++;
      const finDeNombre = p;
      while (esBlanco(xml[p])) p++;
      if (xml[p] !== IGUAL) throw estructuraInvalida();
      p++;
      while (esBlanco(xml[p])) p++;
      const comilla = xml[p];
      if (comilla !== COMILLA && comilla !== APOSTROFE) throw estructuraInvalida();
      const cierre = xml.indexOf(comilla, p + 1);
      if (cierre < 0) throw estructuraInvalida();
      atributos?.set(xml.toString("latin1", inicioDeNombre, finDeNombre), xml.toString("latin1", p + 1, cierre));
      p = cierre + 1;
    }

    if (atributos) visitar(nombre, atributos, p);
    i = p;
  }
}

interface Celda {
  columna: number;
  fila: number;
}

const RE_CELDA = /^\$?([A-Z]{1,7})\$?(\d{1,10})$/;
/** Lo que `DefinedNames` de ExcelJS registra, y con ello recorre. */
const RE_REGISTRADO_EN_NOMBRE = /[$](\w+)[$](\d+)(:[$](\w+)[$](\d+))?/;
/** El prefijo de hoja que retira `colCache.decodeEx`. */
const RE_HOJA_EN_NOMBRE = /(?:(?:(?:'(?:[^']|'')*')|[^'^ !]*)!)?(.*)/s;
const ENTIDADES: Record<string, string> = { "&apos;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&amp;": "&" };

function numeroDeColumna(letras: string): number {
  let numero = 0;
  for (const letra of letras.toUpperCase()) numero = numero * 26 + letra.charCodeAt(0) - 64;
  return numero;
}

function leerCelda(referencia: string): Celda {
  const m = RE_CELDA.exec(referencia);
  if (!m) throw estructuraInvalida();
  const fila = Number(m[2]);
  if (fila < 1) throw estructuraInvalida();
  return { columna: numeroDeColumna(m[1]!), fila };
}

/**
 * Lee un extremo igual que `colCache.decodeAddress`, que es muy tolerante: toma las
 * mayúsculas previas al primer dígito y los dígitos que sigan, salte lo que salte en medio.
 */
function leerExtremoDeNombre(extremo: string): Partial<Celda> {
  let columna = 0;
  let fila = 0;
  let hayFila = false;
  for (const caracter of extremo) {
    if (!hayFila && caracter >= "A" && caracter <= "Z") columna = columna * 26 + caracter.charCodeAt(0) - 64;
    else if (caracter >= "0" && caracter <= "9") {
      hayFila = true;
      fila = fila * 10 + Number(caracter);
    } else if (hayFila && columna > 0 && caracter !== "$") break;
  }
  return { ...(columna > 0 ? { columna } : {}), ...(hayFila ? { fila } : {}) };
}

const areaEntre = (a: Celda, b: Celda) => (Math.abs(a.columna - b.columna) + 1) * (Math.abs(a.fila - b.fila) + 1);

/**
 * Mide una lista de rangos separados por espacios: `A1:B2 D4`. Cada extremo debe caber en
 * los límites por sí mismo: un rango de una celda en la fila 900.000 tiene área 1, y aun
 * así ExcelJS crearía esa posición.
 */
function medirRangos(rangos: string, presupuesto: Presupuesto): void {
  for (const rango of rangos.trim().split(/\s+/)) {
    if (rango === "") continue;
    const [desde, hasta, ...resto] = rango.split(":");
    if (!desde || resto.length > 0) throw estructuraInvalida();
    const inicio = leerCelda(desde);
    const fin = hasta === undefined ? inicio : leerCelda(hasta);
    presupuesto.comprobarCelda(inicio);
    presupuesto.comprobarCelda(fin);
    presupuesto.sumarArea(areaEntre(inicio, fin));
  }
}

/** Mide lo que ExcelJS registraría de un nombre definido, con sus mismas reglas. */
function medirNombreDefinido(texto: string, presupuesto: Presupuesto): void {
  const decodificado = texto.replace(/&(?:apos|quot|lt|gt|amp);/g, (entidad) => ENTIDADES[entidad]!);
  if ((decodificado.match(/'/g)?.length ?? 0) % 2 !== 0) throw estructuraInvalida();

  // Las comas separan rangos, salvo dentro de un nombre de hoja entre comillas.
  for (const item of decodificado.match(/(?:[^,']|'[^']*')+/g) ?? []) {
    if (!RE_REGISTRADO_EN_NOMBRE.test(item.split("!").pop() ?? "")) continue;
    const referencia = RE_HOJA_EN_NOMBRE.exec(item)?.[1] ?? "";
    const partes = referencia.split(":");
    const inicio = leerExtremoDeNombre(partes[0]!);
    const fin = partes.length > 1 ? leerExtremoDeNombre(partes[1]!) : inicio;

    if (inicio.fila === 0 || fin.fila === 0) throw estructuraInvalida();
    presupuesto.comprobarCelda({ columna: inicio.columna ?? 1, fila: inicio.fila ?? 1 });
    presupuesto.comprobarCelda({ columna: fin.columna ?? 1, fila: fin.fila ?? 1 });
    presupuesto.sumarArea(
      areaEntre({ columna: inicio.columna ?? 1, fila: inicio.fila ?? 1 }, { columna: fin.columna ?? 1, fila: fin.fila ?? 1 })
    );
  }
}

function entero(valor: string | undefined): number | null {
  if (valor === undefined) return null;
  if (!/^\d{1,10}$/.test(valor)) throw estructuraInvalida();
  return Number(valor);
}

const miles = (n: number) => n.toLocaleString("es-CL");

/** Lo acumulado entre todas las partes del libro. */
export class Presupuesto {
  private filas = 0;
  private celdas = 0;
  private area = 0;

  constructor(private readonly limites: LimitesXlsx) {}

  contarFila(numero: number | null): void {
    if (numero === 0) throw estructuraInvalida();
    if (++this.filas > this.limites.filasMax) {
      throw new RechazoXlsx(`El archivo tiene más de ${miles(this.limites.filasMax)} filas. No se importó ninguna fila.`);
    }
    if (numero !== null && numero > this.limites.indiceFilaMax) {
      throw new RechazoXlsx(`El archivo usa la fila ${miles(numero)}, y el máximo es la ${miles(this.limites.indiceFilaMax)}. Borre las filas que sobran. No se importó ninguna fila.`);
    }
  }

  contarCelda(celda: Celda | null): void {
    if (++this.celdas > this.limites.celdasMax) {
      throw new RechazoXlsx(`El archivo tiene más de ${miles(this.limites.celdasMax)} celdas. No se importó ninguna fila.`);
    }
    if (celda) this.comprobarCelda(celda);
  }

  /** Un extremo de `<col>`: declara formato, no celdas, y tiene su propio tope. */
  contarExtremoDeFormato(numero: number): void {
    if (numero > this.limites.columnasDeFormatoMax) {
      throw new RechazoXlsx(
        `El archivo declara formato de columnas hasta la número ${miles(numero)}, y el máximo es la ${miles(this.limites.columnasDeFormatoMax)}. No se importó ninguna fila.`
      );
    }
  }

  /** Una coordenada, venga de una celda o de un extremo de un rango. */
  comprobarCelda(celda: Celda): void {
    this.comprobarDimensiones(celda.columna, celda.fila);
  }

  sumarArea(area: number): void {
    this.area += area;
    if (this.area > this.limites.areaDeclaradaMax) {
      throw new RechazoXlsx(
        "El archivo declara combinaciones de celdas, validaciones o nombres definidos sobre demasiadas celdas " +
          `(el máximo son ${miles(this.limites.areaDeclaradaMax)}). Limítelos a las filas con datos. No se importó ninguna fila.`
      );
    }
  }

  private comprobarDimensiones(columna: number, fila: number): void {
    if (columna > this.limites.columnaMax) {
      throw new RechazoXlsx(`El archivo usa la columna número ${miles(columna)}, y el máximo es la ${miles(this.limites.columnaMax)}. No se importó ninguna fila.`);
    }
    if (fila > this.limites.indiceFilaMax) {
      throw new RechazoXlsx(`El archivo usa la fila ${miles(fila)}, y el máximo es la ${miles(this.limites.indiceFilaMax)}. Borre las filas que sobran. No se importó ninguna fila.`);
    }
  }
}

/** Un atributo medido: con entidades no se puede saber qué dirá después de decodificarlo. */
function atributoMedible(atributos: Map<string, string>, nombre: string): string | undefined {
  const valor = atributos.get(nombre);
  if (valor?.includes("&")) throw estructuraInvalida();
  return valor;
}

const ETIQUETAS_DE_HOJA = new Set(["row", "c", "col", "mergeCell", "dataValidation"]);

export function escanearHoja(xml: Buffer, presupuesto: Presupuesto): void {
  recorrerEtiquetas(xml, ETIQUETAS_DE_HOJA, (nombre, atributos) => {
    switch (nombre) {
      case "row":
        presupuesto.contarFila(entero(atributoMedible(atributos, "r")));
        break;
      case "c": {
        const referencia = atributoMedible(atributos, "r");
        presupuesto.contarCelda(referencia === undefined ? null : leerCelda(referencia));
        break;
      }
      case "col":
        // Los dos extremos: ExcelJS rellena desde 1 hasta `min`, aunque `max` sea menor.
        presupuesto.contarExtremoDeFormato(entero(atributoMedible(atributos, "max")) ?? 0);
        presupuesto.contarExtremoDeFormato(entero(atributoMedible(atributos, "min")) ?? 0);
        break;
      case "mergeCell":
        medirRangos(atributoMedible(atributos, "ref") ?? "", presupuesto);
        break;
      case "dataValidation":
        medirRangos(atributoMedible(atributos, "sqref") ?? "", presupuesto);
        break;
    }
  });
}

/** Devuelve cuántas hojas declara `xl/workbook.xml` y suma el área de sus nombres definidos. */
export function escanearLibro(xml: Buffer, presupuesto: Presupuesto): number {
  let hojas = 0;
  recorrerEtiquetas(xml, new Set(["sheet", "definedName"]), (nombre, _atributos, fin) => {
    if (nombre === "sheet") {
      hojas++;
      return;
    }
    // ExcelJS une todo el texto del elemento: un comentario o un CDATA en medio lo partiría
    // aquí en dos y la parte medida no sería la que él recorre.
    const cierre = xml.indexOf(LT, fin);
    if (cierre < 0 || xml.toString("latin1", cierre, cierre + 14) !== "</definedName>") throw estructuraInvalida();
    const texto = xml.toString("latin1", fin, cierre);
    if (texto.includes("&#")) throw estructuraInvalida();
    medirNombreDefinido(texto, presupuesto);
  });
  return hojas;
}

export function escanearCadenasCompartidas(xml: Buffer, limites: LimitesXlsx): void {
  let cadenas = 0;
  recorrerEtiquetas(xml, new Set(["si"]), () => {
    if (++cadenas > limites.cadenasCompartidasMax) {
      throw new RechazoXlsx(`El archivo tiene más de ${miles(limites.cadenasCompartidasMax)} textos distintos. No se importó ninguna fila.`);
    }
  });
}
