/**
 * Archivos Excel y PDF del reporte DETALLADO de inscripciones. Ambos recorren la estructura común de
 * `reporteDetallado.rules.ts` (la misma de la pantalla y del CSV), con las pruebas de cada jornada en
 * dos bloques: aquí solo hay formato.
 */
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { neutralizeSpreadsheetFormula, type PruebaDeJornada } from "./reports.rules";
import {
  ENCABEZADOS_DE_BLOQUES,
  filasVisuales,
  paginarReporteDetallado,
  saltosDeImpresion,
  TEXTO_SIN_INSCRIPCIONES,
  textoDelClub,
  textoDelNadador,
  type BloqueDelPdf,
  type FilaImpresa,
  type LineaDelPdf,
  type ReporteDetallado,
} from "./reporteDetallado.rules";

// ----------------------------------------------------------------------------------------- Excel

const NAVY = "FF31446F";
const FONDO_CLUB = "FFDFE5EF";
const FONDO_ENCABEZADO = "FFEEF1F6";
const GRIS = "FF7A8594";
/** Fecha y jornada, y dos bloques de número, descripción y tiempo. */
const COLUMNA_JORNADA = 1;
const COLUMNAS_DE_BLOQUES = [
  { numero: 2, prueba: 3, tiempo: 4 },
  { numero: 5, prueba: 6, tiempo: 7 },
] as const;
const ULTIMA_COLUMNA = 7;
/**
 * En caracteres, para el ancho útil de una carta vertical. Al imprimir, Excel ensancha las columnas un
 * 8 % respecto de la pantalla; con estos anchos la escala de «una página de ancho» queda cerca de 97 %.
 */
const ANCHOS = [18, 6, 28, 9.5, 6, 28, 9.5] as const;
/** Puntos de una columna (7 píxeles por carácter) y el relleno lateral que la planilla deja en cada celda. */
const puntosDe = (caracteres: number) => caracteres * 5.25;
const RELLENO_DE_CELDA = 5;
const ANCHO_TOTAL = puntosDe(ANCHOS.reduce((suma, a) => suma + a, 0));

/** Alto de una carta vertical, en puntos; los márgenes, en pulgadas, como los pide la planilla. */
const ALTO_CARTA = 792;
const PAPEL_CARTA = 1 as ExcelJS.PaperSize; // código de Excel; ExcelJS no lo nombra en su enumeración
const MARGENES = { left: 0.25, right: 0.25, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 } as const;
/** Fracción del alto útil que se llena: la impresora redondea el alto de las filas. */
const HOLGURA_DE_PAGINA = 0.97;

const FUENTE_EXCEL = "Calibri";
const TITULOS = {
  competencia: { tamano: 14, linea: 19, relleno: 6 },
  club: { tamano: 12, linea: 16, relleno: 6 },
  nadador: { tamano: 11, linea: 15, relleno: 4 },
} as const;
/** Las filas de pruebas. */
const FILA_EXCEL = { tamano: 10, linea: 13, relleno: 3 } as const;

/**
 * Cuántas líneas ocupa un texto en la planilla, ajustado por palabras a un ancho en puntos. Se mide
 * con Helvetica, cuyas métricas trae pdfkit, llevada al ancho de Calibri (algo menor) con holgura: en
 * la duda sobra una línea, nunca falta.
 */
function medidorDeLineas(): (texto: string, ancho: number, tamano: number, negrita: boolean) => number {
  const regla = new PDFDocument({ autoFirstPage: false });
  const CALIBRI_FRENTE_A_HELVETICA = 0.96;
  const conocidos = new Map<string, number>();
  return (texto, ancho, tamano, negrita) => {
    const clave = `${tamano}|${negrita}|${ancho}|${texto}`;
    const guardado = conocidos.get(clave);
    if (guardado !== undefined) return guardado;
    regla.font(negrita ? "Helvetica-Bold" : "Helvetica").fontSize(tamano);
    const medir = (t: string) => regla.widthOfString(t) * CALIBRI_FRENTE_A_HELVETICA;
    const util = ancho - RELLENO_DE_CELDA;
    let lineas = 1;
    let usado = 0;
    for (const palabra of texto.split(/(?<=[\s-])/)) {
      const largo = medir(palabra);
      if (usado > 0 && usado + medir(palabra.trimEnd()) > util) {
        lineas++;
        usado = 0;
      }
      // Una palabra más ancha que la celda se parte en varias líneas.
      if (largo > util) lineas += Math.ceil(largo / util) - 1;
      usado += largo > util ? largo % util : largo;
    }
    conocidos.set(clave, lineas);
    return lineas;
  };
}

/**
 * IMPRESIÓN: carta vertical y una página de ancho. Todas las filas llevan su alto (el del
 * más alto de sus bloques), porque de él dependen los saltos de página que evitan títulos solos al pie
 * (`saltosDeImpresion`) y porque la planilla no autoajusta las combinadas.
 *
 * El título de un nadador se combina SOLO si necesita más de una línea: si cabe en una, se extiende
 * igual sobre las celdas vacías de su fila. ExcelJS compara cada combinación con todas las anteriores,
 * y con miles de nadadores combinarlas todas tardaba más de un minuto.
 */
export async function xlsxDelReporteDetallado(r: ReporteDetallado): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet("Inscripciones", {
    views: [{ state: "frozen", ySplit: 2 }],
    pageSetup: {
      paperSize: PAPEL_CARTA,
      orientation: "portrait",
      fitToPage: true, // una página de ancho; el largo, las que hagan falta
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      printTitlesRow: "1:2",
      margins: { ...MARGENES },
    },
    headerFooter: { oddFooter: "&RPágina &P de &N" },
  });
  hoja.columns = ANCHOS.map((width) => ({ width }));

  /** El texto se escribe siempre como texto y con la misma neutralización de fórmulas que el CSV. */
  const texto = neutralizeSpreadsheetFormula;
  const pintar = (fila: ExcelJS.Row, color: string) => {
    for (let c = 1; c <= ULTIMA_COLUMNA; c++) fila.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
  };
  const lineasDe = medidorDeLineas();
  /** Filas bajo los títulos que se repiten, con su alto, para calcular los saltos de página. */
  const impresas: FilaImpresa[] = [];
  /** Título a todo el ancho de la tabla. */
  const tituloCompleto = (valor: string, estilo: (typeof TITULOS)[keyof typeof TITULOS], color?: string, combinarSiempre = true) => {
    const fila = hoja.addRow([texto(valor)]);
    const lineas = lineasDe(valor, ANCHO_TOTAL, estilo.tamano, true);
    const combinar = combinarSiempre || lineas > 1;
    if (combinar) hoja.mergeCells(fila.number, 1, fila.number, ULTIMA_COLUMNA);
    fila.getCell(1).font = { name: FUENTE_EXCEL, bold: true, size: estilo.tamano, ...(color ? { color: { argb: color } } : {}) };
    fila.getCell(1).alignment = { wrapText: combinar, vertical: "middle" };
    fila.height = lineas * estilo.linea + estilo.relleno;
    return fila;
  };
  const fuente = (color?: string, cursiva = false): Partial<ExcelJS.Font> => ({
    name: FUENTE_EXCEL,
    size: FILA_EXCEL.tamano,
    ...(cursiva ? { italic: true } : {}),
    ...(color ? { color: { argb: color } } : {}),
  });
  /** Líneas de una descripción en su columna. */
  const lineasDePrueba = (p: PruebaDeJornada | null) => (p === null ? 1 : lineasDe(p.descripcion, puntosDe(ANCHOS[2]), FILA_EXCEL.tamano, false));
  const ponerBloque = (fila: ExcelJS.Row, columnas: (typeof COLUMNAS_DE_BLOQUES)[number], p: PruebaDeJornada) => {
    const numero = fila.getCell(columnas.numero);
    if (p.numero !== null) numero.value = p.numero;
    numero.numFmt = '"["0"]"';
    numero.alignment = { horizontal: "right", vertical: "top" };
    numero.font = fuente();
    const prueba = fila.getCell(columnas.prueba);
    prueba.value = texto(p.descripcion);
    prueba.alignment = { wrapText: true, vertical: "top" };
    prueba.font = fuente();
    const tiempo = fila.getCell(columnas.tiempo);
    tiempo.value = texto(p.tiempoTexto);
    tiempo.alignment = { horizontal: "right", vertical: "top" };
    tiempo.font = p.tiempo === null ? fuente(GRIS, true) : fuente();
  };

  const competencia = tituloCompleto(r.competitionName, TITULOS.competencia, NAVY);

  const [jornada, prueba, tiempo, prueba2, tiempo2] = ENCABEZADOS_DE_BLOQUES;
  // «Prueba» va sobre la descripción; la columna estrecha de su izquierda es la del número de programa.
  const encabezado = hoja.addRow([jornada, null, prueba, tiempo, null, prueba2, tiempo2]);
  encabezado.font = { name: FUENTE_EXCEL, bold: true, size: FILA_EXCEL.tamano };
  encabezado.height = FILA_EXCEL.linea + FILA_EXCEL.relleno;
  for (const b of COLUMNAS_DE_BLOQUES) encabezado.getCell(b.tiempo).alignment = { horizontal: "right" };
  pintar(encabezado, FONDO_ENCABEZADO);

  const primeraFila = hoja.rowCount + 1;
  for (const f of filasVisuales(r)) {
    let fila: ExcelJS.Row;
    if (f.tipo === "club") {
      fila = tituloCompleto(textoDelClub(f.club), TITULOS.club, NAVY);
      pintar(fila, FONDO_CLUB);
    } else if (f.tipo === "nadador") {
      fila = tituloCompleto(`${f.nadador.numero}. ${textoDelNadador(f.nadador)}`, TITULOS.nadador, undefined, false);
      for (let c = 1; c <= ULTIMA_COLUMNA; c++) fila.getCell(c).border = { top: { style: "thin", color: { argb: "FFBFC7D5" } } };
    } else {
      fila = hoja.addRow([texto(f.jornada.titulo)]);
      fila.getCell(COLUMNA_JORNADA).alignment = { wrapText: true, vertical: "top" };
      fila.getCell(COLUMNA_JORNADA).font = fuente("FF44546A");
      ponerBloque(fila, COLUMNAS_DE_BLOQUES[0], f.fila.izquierda);
      if (f.fila.derecha !== null) ponerBloque(fila, COLUMNAS_DE_BLOQUES[1], f.fila.derecha);
      const lineas = Math.max(lineasDe(f.jornada.titulo, puntosDe(ANCHOS[0]), FILA_EXCEL.tamano, false), lineasDePrueba(f.fila.izquierda), lineasDePrueba(f.fila.derecha));
      fila.height = lineas * FILA_EXCEL.linea + FILA_EXCEL.relleno;
    }
    impresas.push({ tipo: f.tipo, alto: fila.height });
  }
  const altoUtil = ALTO_CARTA - (MARGENES.top + MARGENES.bottom) * 72;
  for (const i of saltosDeImpresion(impresas, altoUtil * HOLGURA_DE_PAGINA - competencia.height - encabezado.height)) hoja.getRow(primeraFila + i).addPageBreak();
  if (r.groupedByClub.length === 0) hoja.addRow([TEXTO_SIN_INSCRIPCIONES]);

  return Buffer.from(await libro.xlsx.writeBuffer());
}

// ----------------------------------------------------------------------------------------- PDF

/**
 * MEDIDAS DEL PDF (puntos). Cada texto se mide con `heightOfString`, con la MISMA fuente, tamaño y
 * ancho con que se dibuja: lo largo ocupa las líneas que necesita, sin recortarse, y una fila avanza
 * lo que ocupe el más alto de sus textos.
 */
const MARGEN = 30;
const PIE = 18; // espacio de «Página N de M» dentro del área útil
const ESTILO = {
  club: { fuente: "Helvetica-Bold", tamano: 11, arriba: 15, abajo: 5 },
  nadador: { fuente: "Helvetica-Bold", tamano: 10, arriba: 6, abajo: 2 },
  bloques: { fuente: "Helvetica", tamano: 9, arriba: 2, abajo: 2 },
  aviso: { fuente: "Helvetica-Oblique", tamano: 10, arriba: 6, abajo: 6 },
} as const;
const COLOR = { club: "#0b2545", nadador: "#000", jornada: "#44546a", texto: "#000", sinTiempo: "#777", aviso: "#555" } as const;
/** Sangría del texto del club dentro de su banda, y espacio blanco sobre ella (incluido en su `arriba`). */
const SANGRIA_CLUB = 8;
const SEPARACION_CLUB = 8;
const ENCABEZADO = { fuente: "Helvetica-Bold", tamano: 8.5, alto: 18 } as const;
/** Anchos fijos de una fila; las dos descripciones se reparten el resto. */
const FILA = { sangria: 6, jornada: 84, numero: 27, tiempo: 45, entreColumnas: 4, entreBloques: 6 } as const;

interface Caja {
  x: number;
  ancho: number;
}
interface CajasDeBloque {
  numero: Caja;
  descripcion: Caja;
  tiempo: Caja;
}
interface ParteDeLinea {
  texto: string;
  caja: Caja;
  color: string;
  alineadaDerecha?: boolean;
}

/** Posición de cada columna de una fila de dos bloques, para un área útil de `ancho` puntos. */
function columnasDelPdf(ancho: number): { jornada: Caja; bloques: [CajasDeBloque, CajasDeBloque] } {
  const jornada = { x: MARGEN + FILA.sangria, ancho: FILA.jornada };
  const inicio = jornada.x + jornada.ancho + FILA.entreColumnas;
  const anchoBloque = (MARGEN + ancho - FILA.sangria - inicio - FILA.entreBloques) / 2;
  const bloque = (x: number): CajasDeBloque => ({
    numero: { x, ancho: FILA.numero },
    descripcion: { x: x + FILA.numero + FILA.entreColumnas, ancho: anchoBloque - FILA.numero - FILA.tiempo - 2 * FILA.entreColumnas },
    tiempo: { x: x + anchoBloque - FILA.tiempo, ancho: FILA.tiempo },
  });
  return { jornada, bloques: [bloque(inicio), bloque(inicio + anchoBloque + FILA.entreBloques)] };
}

export function pdfDelReporteDetallado(r: ReporteDetallado): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGEN, size: "LETTER", layout: "portrait", autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const ancho = doc.page.width - 2 * MARGEN;
    const columnas = columnasDelPdf(ancho);
    const fijarEstilo = (tipo: keyof typeof ESTILO) => doc.font(ESTILO[tipo].fuente).fontSize(ESTILO[tipo].tamano);

    /** Los textos de una línea con la caja y alineación en que se dibujan: lo que se mide es lo que se dibuja. */
    const partes = (l: LineaDelPdf): ParteDeLinea[] => {
      if (l.tipo === "club") return [{ texto: l.texto, caja: { x: MARGEN + SANGRIA_CLUB, ancho: ancho - 2 * SANGRIA_CLUB }, color: COLOR.club }];
      if (l.tipo !== "bloques") return [{ texto: l.texto, caja: { x: MARGEN, ancho }, color: l.tipo === "aviso" ? COLOR.aviso : COLOR.nadador }];
      const deBloque = (b: BloqueDelPdf, c: CajasDeBloque): ParteDeLinea[] => [
        { texto: b.numero, caja: c.numero, alineadaDerecha: true, color: COLOR.texto },
        { texto: b.descripcion, caja: c.descripcion, color: COLOR.texto },
        { texto: b.tiempo, caja: c.tiempo, alineadaDerecha: true, color: b.sinTiempo ? COLOR.sinTiempo : COLOR.texto },
      ];
      return [
        { texto: l.jornada, caja: columnas.jornada, color: COLOR.jornada },
        ...deBloque(l.izquierda, columnas.bloques[0]),
        ...(l.derecha === null ? [] : deBloque(l.derecha, columnas.bloques[1])),
      ].filter((p) => p.texto !== "");
    };
    const medir = (l: LineaDelPdf) => {
      fijarEstilo(l.tipo);
      const alto = Math.max(...partes(l).map((p) => doc.heightOfString(p.texto, { width: p.caja.ancho })));
      return Math.ceil(alto + ESTILO[l.tipo].arriba + ESTILO[l.tipo].abajo);
    };

    // La competencia encabeza la primera página y se repite, más pequeña, en las siguientes; los
    // encabezados de los bloques van en todas.
    const hayPruebas = r.groupedByClub.length > 0;
    const cabecera = (primera: boolean) => doc.font("Helvetica-Bold").fontSize(primera ? 16 : 9);
    const altoCabecera = (primera: boolean) => {
      cabecera(primera);
      return Math.ceil(doc.heightOfString(r.competitionName, { width: ancho }) + (primera ? 10 : 8));
    };
    const altoTitulo = altoCabecera(true);
    const altoRepetido = altoCabecera(false);
    const altoEncabezado = hayPruebas ? ENCABEZADO.alto : 0;
    const dibujarEncabezado = (y: number) => {
      doc.rect(MARGEN, y, ancho, ENCABEZADO.alto).fill("#eef1f6");
      doc.font(ENCABEZADO.fuente).fontSize(ENCABEZADO.tamano).fillColor(COLOR.jornada);
      const [jornada, ...deBloques] = ENCABEZADOS_DE_BLOQUES;
      const poner = (t: string, caja: Caja, alineadaDerecha = false) =>
        doc.text(t, caja.x, y + 5, { width: caja.ancho, align: alineadaDerecha ? "right" : "left", lineBreak: false });
      poner(jornada, columnas.jornada);
      columnas.bloques.forEach((b, i) => {
        poner(deBloques[i * 2]!, b.descripcion);
        poner(deBloques[i * 2 + 1]!, b.tiempo, true);
      });
    };

    const util = doc.page.height - 2 * MARGEN - PIE - altoEncabezado;
    const paginas = paginarReporteDetallado(r, { altoPrimera: util - altoTitulo, alto: util - altoRepetido, medir });

    paginas.forEach((lineas, i) => {
      if (i > 0) doc.addPage();
      let y = MARGEN;
      cabecera(i === 0)
        .fillColor(i === 0 ? COLOR.club : "#555")
        .text(r.competitionName, MARGEN, y, { width: ancho });
      y += i === 0 ? altoTitulo : altoRepetido;
      if (hayPruebas) dibujarEncabezado(y);
      y += altoEncabezado;
      for (const { linea: l, alto } of lineas) {
        if (l.tipo === "club") doc.rect(MARGEN, y + SEPARACION_CLUB, ancho, alto - SEPARACION_CLUB).fill(l.continuacion ? "#eef1f6" : "#dfe5ef");
        fijarEstilo(l.tipo);
        for (const p of partes(l)) {
          doc.fillColor(p.color).text(p.texto, p.caja.x, y + ESTILO[l.tipo].arriba, { width: p.caja.ancho, align: p.alineadaDerecha ? "right" : "left" });
        }
        y += alto;
      }
      // El pie va dentro del margen inferior: sin bajarlo, pdfkit abriría una página nueva.
      const margenInferior = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#555")
        .text(`Página ${i + 1} de ${paginas.length}`, MARGEN, doc.page.height - MARGEN + 4, { width: ancho, align: "right", lineBreak: false });
      doc.page.margins.bottom = margenInferior;
    });
    doc.end();
  });
}
