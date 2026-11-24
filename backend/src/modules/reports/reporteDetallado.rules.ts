/**
 * Reporte DETALLADO de inscripciones («Generar reporte»): la estructura de presentación COMÚN a la
 * pantalla y a las exportaciones CSV, Excel y PDF. Reglas puras, sin base de datos.
 *
 *   Competencia
 *   → Club y sus totales
 *   → Nadador numerado, edad, categoría y género
 *   → Fecha y jornada
 *   → Pruebas de esa fecha y jornada: número de programa, descripción y tiempo
 *
 * PRESENTACIÓN. Pantalla, Excel y PDF disponen las pruebas en DOS BLOQUES por fila (`enDosBloques`):
 *
 *   Fecha y jornada | Prueba | Tiempo | Prueba | Tiempo
 *
 * El CSV, en cambio, lleva UNA prueba por fila: los dos bloques son una disposición visual, y en una
 * tabla de datos repartirían la misma columna en dos. La información y su orden son los mismos.
 *
 * `armarReporteDetallado` produce esa estructura UNA vez, ya agrupada (`groupReportByClubAndSwimmer`),
 * ordenada y con sus textos. Cada línea de nadador es una combinación de club y persona: quien tiene
 * inscripciones en dos clubes aparece en ambos, con lo de cada uno. La pantalla la recorre tal cual y los archivos la recorren con
 * `filasDelReporteDetallado`: ninguno vuelve a agrupar, ordenar, contar ni armar nombres.
 *
 * Datos personales: nombre, edad a la fecha de corte, categoría y género. Nunca el RUN ni la fecha
 * de nacimiento, para ningún rol. El alcance (club o persona) ya viene aplicado en las entradas.
 */
import {
  groupReportByClubAndSwimmer,
  neutralizeSpreadsheetFormula,
  type ClubGroup,
  type ClubGroupSwimmerRow,
  type JornadaDelNadador,
  type PruebaDeJornada,
  type SwimmerEventEntry,
} from "./reports.rules";
import { nombreDelReporte } from "./clubesYNadadores.rules";

export interface NadadorDetallado extends ClubGroupSwimmerRow {
  /** Número dentro de su club, desde 1. */
  numero: number;
  /** `PATERNO MATERNO, NOMBRE`, o el nombre completo almacenado si el registro está incompleto. */
  nombrePresentado: string;
  /** `(EDAD) - Categoría - Género`. */
  detalle: string;
}

export interface ClubDetallado extends Omit<ClubGroup, "swimmers"> {
  /** `6 nadadores, 41 pruebas individuales, 0 relevos`. */
  totalesTexto: string;
  swimmers: NadadorDetallado[];
}

export interface ReporteDetallado {
  competitionName: string;
  groupedByClub: ClubDetallado[];
}

/** Encabezados visibles de los dos bloques, los mismos en pantalla, Excel y PDF. */
export const ENCABEZADOS_DE_BLOQUES = ["Fecha y jornada", "Prueba", "Tiempo", "Prueba", "Tiempo"] as const;

export const TEXTO_SIN_INSCRIPCIONES = "Sin inscripciones para estos filtros.";

export function armarReporteDetallado(
  competitionName: string,
  entradas: SwimmerEventEntry[],
  fechaDeCorte: Date,
  equiposPorClubId: Map<string, number>
): ReporteDetallado {
  return {
    competitionName,
    groupedByClub: groupReportByClubAndSwimmer(entradas, fechaDeCorte, equiposPorClubId).map((club) => ({
      ...club,
      totalesTexto: `${club.totalNadadores} nadadores, ${club.totalPruebasIndividuales} pruebas individuales, ${club.totalRelevos} relevos`,
      swimmers: club.swimmers.map((s, i) => ({
        ...s,
        numero: i + 1,
        nombrePresentado: nombreDelReporte({
          fullName: s.nombreCompleto,
          paternalLastName: s.apellidoPaterno,
          maternalLastName: s.apellidoMaterno,
          firstName: s.nombres,
        }),
        detalle: `(${s.edad}) - ${s.categoria} - ${s.genero}`,
      })),
    })),
  };
}

// ----------------------------------------------------------------------------- Textos comunes

export const textoDelClub = (c: ClubDetallado) => `${c.clubName} (${c.totalesTexto})`;
/** Sin la numeración, que cada formato ubica a su manera. */
export const textoDelNadador = (s: NadadorDetallado) => `${s.nombrePresentado} ${s.detalle}`;
/** `[5]`, o vacío si la prueba no tiene número de programa. */
export const numeroEntreCorchetes = (p: PruebaDeJornada) => (p.numero === null ? "" : `[${p.numero}]`);
export const etiquetaDeTipo = (p: PruebaDeJornada) => (p.tipo === "relevo" ? "Relevo" : "Individual");

// ----------------------------------------------------------------------------- Secuencia

/** Una fila de la secuencia, con el contexto al que pertenece. */
export type FilaDetallada =
  | { tipo: "club"; club: ClubDetallado }
  | { tipo: "nadador"; club: ClubDetallado; nadador: NadadorDetallado }
  | { tipo: "jornada"; club: ClubDetallado; nadador: NadadorDetallado; jornada: JornadaDelNadador }
  | { tipo: "prueba"; club: ClubDetallado; nadador: NadadorDetallado; jornada: JornadaDelNadador; prueba: PruebaDeJornada };

/** El reporte como secuencia de filas, en el orden de la pantalla. Es lo que recorren los tres archivos. */
export function filasDelReporteDetallado(r: ReporteDetallado): FilaDetallada[] {
  const filas: FilaDetallada[] = [];
  for (const club of r.groupedByClub) {
    filas.push({ tipo: "club", club });
    for (const nadador of club.swimmers) {
      filas.push({ tipo: "nadador", club, nadador });
      for (const jornada of nadador.jornadas) {
        filas.push({ tipo: "jornada", club, nadador, jornada });
        for (const prueba of jornada.pruebas) filas.push({ tipo: "prueba", club, nadador, jornada, prueba });
      }
    }
  }
  return filas;
}

// ----------------------------------------------------------------------------- Dos bloques

/** Una fila visual: la prueba del bloque izquierdo y, si la hay, la del derecho. */
export interface FilaDeBloques {
  izquierda: PruebaDeJornada;
  derecha: PruebaDeJornada | null;
}

/**
 * Las pruebas de UNA jornada de UN nadador en filas de dos, de izquierda a derecha y siguiendo en la
 * fila siguiente, en el orden que traen. Con una cantidad impar, el último bloque derecho queda vacío.
 * Recibe una sola jornada: nunca empareja pruebas de jornadas, días, nadadores o clubes distintos.
 */
export function enDosBloques(pruebas: readonly PruebaDeJornada[]): FilaDeBloques[] {
  const filas: FilaDeBloques[] = [];
  for (let i = 0; i < pruebas.length; i += 2) filas.push({ izquierda: pruebas[i]!, derecha: pruebas[i + 1] ?? null });
  return filas;
}

/** El reporte como lo presentan Excel y PDF: títulos a todo el ancho y filas de dos bloques. */
export type FilaVisual =
  | { tipo: "club"; club: ClubDetallado }
  | { tipo: "nadador"; club: ClubDetallado; nadador: NadadorDetallado }
  | { tipo: "bloques"; club: ClubDetallado; nadador: NadadorDetallado; jornada: JornadaDelNadador; fila: FilaDeBloques };

export function filasVisuales(r: ReporteDetallado): FilaVisual[] {
  return filasDelReporteDetallado(r).flatMap((f): FilaVisual[] => {
    if (f.tipo === "club" || f.tipo === "nadador") return [f];
    if (f.tipo === "jornada") return enDosBloques(f.jornada.pruebas).map((fila) => ({ ...f, tipo: "bloques" as const, fila }));
    return []; // las pruebas ya van en sus bloques
  });
}

// ----------------------------------------------------------------------------- Saltos de impresión

/** Una fila de la planilla con su alto (puntos), en el orden en que se imprime. */
export interface FilaImpresa {
  tipo: FilaVisual["tipo"];
  alto: number;
}

/**
 * Filas (por su índice) tras las cuales la planilla debe saltar de página, para que al imprimir:
 *  - un título de club o de nadador nunca quede solo al pie: va con su primera fila de pruebas;
 *  - un nadador que cabe entero en una página no se parta, porque la planilla, a diferencia del PDF,
 *    no puede repetir su nombre en la página siguiente. Uno más alto que una página sí se parte, entre
 *    filas.
 * `alto` es el espacio de una página, descontados los títulos que se repiten en todas.
 */
export function saltosDeImpresion(filas: readonly FilaImpresa[], alto: number): number[] {
  const saltos: number[] = [];
  let libre = alto;
  let enPagina = 0;
  const saltarAntesDe = (i: number) => {
    if (enPagina === 0) return;
    saltos.push(i - 1);
    libre = alto;
    enPagina = 0;
  };
  const poner = (f: FilaImpresa) => {
    libre -= f.alto;
    enPagina++;
  };
  for (let i = 0; i < filas.length; ) {
    // Un grupo: los títulos que lo abren (club, si empieza, y nadador) y todas sus filas de pruebas.
    let titulos = i;
    while (titulos < filas.length && filas[titulos]!.tipo !== "bloques") titulos++;
    let fin = titulos;
    while (fin < filas.length && filas[fin]!.tipo === "bloques") fin++;
    const altoDe = (desde: number, hasta: number) => filas.slice(desde, hasta).reduce((suma, f) => suma + f.alto, 0);
    const minimo = Math.min(titulos + 1, fin); // los títulos con su primera fila
    const entero = altoDe(i, fin);
    if (entero > libre && (entero <= alto || altoDe(i, minimo) > libre)) saltarAntesDe(i);
    for (let k = i; k < fin; k++) {
      if (k >= minimo && filas[k]!.alto > libre) saltarAntesDe(k);
      poner(filas[k]!);
    }
    i = Math.max(fin, i + 1);
  }
  return saltos;
}

// ----------------------------------------------------------------------------- CSV

/**
 * CSV para abrir por doble clic en Excel con configuración es-CL (medido en Excel 16.0): UTF-8 con
 * BOM, para que las tildes se lean bien, y `;`, que es el separador de lista de esa configuración.
 * Con coma, Excel dejaba cada fila entera en una sola columna.
 */
export const SEPARADOR_CSV = ";";
export const BOM = "﻿";

export const ENCABEZADOS_CSV = [
  "Sección",
  "Competencia",
  "Club",
  "Total nadadores",
  "Total pruebas individuales",
  "Total relevos",
  "N° nadador",
  "Nadador",
  "Edad",
  "Categoría",
  "Género",
  "Fecha",
  "Jornada",
  "N° prueba",
  "Tipo de prueba",
  "Prueba",
  "Tiempo",
] as const;

/**
 * Límites de celda con cualquier separador que una planilla pudiera usar, incluida la COMA: si el
 * archivo se abre con otra configuración regional, el entrecomillado (que sigue al `;`) no protege
 * y `A,=1+1` se partiría con la fórmula al comienzo de una celda. Se antepone una comilla simple.
 */
const INICIO_DE_CELDA_CON_DISPARADOR = /(^|[;,|\t\r\n])([ \t"]*)(?=[=+\-@])/g;

/**
 * Valores formados solo por cifras y separadores (tiempos, fechas, rangos de edad): Excel los
 * convierte al abrir el CSV —«1:39,07» en la hora «01:39,1», «8-10» en «08-oct»— y se pierde lo
 * escrito. Un espacio inicial los deja como texto exacto. Los números enteros no se tocan.
 */
const CONVERTIBLE_POR_LA_PLANILLA = /^\d[\d.,:/-]*[.,:/-][\d.,:/-]*$/;

export function celdaCsv(valor: string): string {
  const seguro = neutralizeSpreadsheetFormula(valor).replace(INICIO_DE_CELDA_CON_DISPARADOR, "$1$2'");
  const texto = CONVERTIBLE_POR_LA_PLANILLA.test(seguro) ? ` ${seguro}` : seguro;
  return /[;,|"\t\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

/**
 * Filas del CSV: una fila de sección por competencia, club, nadador y jornada, y una por prueba, en
 * la misma secuencia de la pantalla (no en dos bloques: ver el comienzo del archivo). Todas tienen las mismas columnas y repiten su contexto (club,
 * nadador, fecha y jornada), así que filtrar por «Prueba» da una tabla completa. Los totales del
 * club van SOLO en su fila, para que sumar la columna no los repita.
 */
export function filasCsv(r: ReporteDetallado): string[][] {
  const fila = (valores: Partial<Record<(typeof ENCABEZADOS_CSV)[number], string>>) => ENCABEZADOS_CSV.map((h) => valores[h] ?? "");
  const competencia = { Competencia: r.competitionName };
  const filas = [fila({ Sección: "Competencia", ...competencia })];
  for (const f of filasDelReporteDetallado(r)) {
    const club = { ...competencia, Club: f.club.clubName };
    if (f.tipo === "club") {
      filas.push(
        fila({
          Sección: "Club",
          ...club,
          "Total nadadores": String(f.club.totalNadadores),
          "Total pruebas individuales": String(f.club.totalPruebasIndividuales),
          "Total relevos": String(f.club.totalRelevos),
        })
      );
      continue;
    }
    const nadador = {
      ...club,
      "N° nadador": String(f.nadador.numero),
      Nadador: f.nadador.nombrePresentado,
      Edad: String(f.nadador.edad),
      Categoría: f.nadador.categoria,
      Género: f.nadador.genero,
    };
    if (f.tipo === "nadador") {
      filas.push(fila({ Sección: "Nadador", ...nadador }));
      continue;
    }
    const jornada = { ...nadador, Fecha: f.jornada.fecha, Jornada: f.jornada.jornada };
    if (f.tipo === "jornada") {
      filas.push(fila({ Sección: "Jornada", ...jornada }));
      continue;
    }
    filas.push(
      fila({
        Sección: "Prueba",
        ...jornada,
        "N° prueba": f.prueba.numero === null ? "" : String(f.prueba.numero),
        "Tipo de prueba": etiquetaDeTipo(f.prueba),
        Prueba: f.prueba.descripcion,
        Tiempo: f.prueba.tiempoTexto,
      })
    );
  }
  if (r.groupedByClub.length === 0) filas.push(fila({ Sección: TEXTO_SIN_INSCRIPCIONES, ...competencia }));
  return filas;
}

export function csvDelReporteDetallado(r: ReporteDetallado): string {
  return BOM + [[...ENCABEZADOS_CSV], ...filasCsv(r)].map((f) => f.map(celdaCsv).join(SEPARADOR_CSV)).join("\r\n");
}

// ----------------------------------------------------------------------------- PDF

/** Un bloque del PDF, con sus textos ya presentados. */
export interface BloqueDelPdf {
  numero: string;
  descripcion: string;
  tiempo: string;
  /** Para distinguirlo a la vista; el texto ya dice «Sin tiempo». */
  sinTiempo: boolean;
}

/** Una línea del PDF. `continuacion`: título repetido al seguir en otra página. */
export type LineaDelPdf =
  | { tipo: "club" | "nadador"; texto: string; continuacion: boolean }
  | { tipo: "bloques"; jornada: string; izquierda: BloqueDelPdf; derecha: BloqueDelPdf | null }
  | { tipo: "aviso"; texto: string };

export interface LineaUbicada {
  linea: LineaDelPdf;
  alto: number;
}

const bloqueDelPdf = (p: PruebaDeJornada): BloqueDelPdf => ({
  numero: numeroEntreCorchetes(p),
  descripcion: p.descripcion,
  tiempo: p.tiempoTexto,
  sinTiempo: p.tiempo === null,
});

/**
 * Distribución en páginas por ALTURA REAL, PURA: `medir` devuelve los puntos que ocupa cada línea
 * con su texto ya ajustado al ancho; para una fila de bloques, el mayor de sus partes. Reglas:
 *  - una línea nunca se corta entre páginas ni se monta sobre otra;
 *  - un título (club o nadador) nunca queda solo al pie: va junto con los que le sigan y con su
 *    primera fila de pruebas;
 *  - al seguir en otra página se repite el contexto vigente, marcado «(continuación)»: el club y, si no
 *    empieza ahí, el nadador. La fecha y la jornada van en cada fila, así que no se pierden;
 *  - nada se omite ni se limita a una página.
 */
export function paginarReporteDetallado(
  r: ReporteDetallado,
  opciones: { altoPrimera: number; alto: number; medir: (l: LineaDelPdf) => number }
): LineaUbicada[][] {
  type Titulo = Exclude<FilaVisual, { tipo: "bloques" }>;
  const paginas: LineaUbicada[][] = [[]];
  let libre = opciones.altoPrimera;
  const actual = () => paginas[paginas.length - 1]!;
  const poner = (l: LineaUbicada) => {
    actual().push(l);
    libre -= l.alto;
  };
  const ubicar = (linea: LineaDelPdf): LineaUbicada => ({ linea, alto: opciones.medir(linea) });
  const titulo = (f: Titulo, continuacion: boolean): LineaDelPdf => {
    const texto = f.tipo === "nadador" ? `${f.nadador.numero}. ${textoDelNadador(f.nadador)}` : continuacion ? f.club.clubName : textoDelClub(f.club);
    return { tipo: f.tipo, texto: continuacion ? `${texto} (continuación)` : texto, continuacion };
  };

  if (r.groupedByClub.length === 0) poner(ubicar({ tipo: "aviso", texto: TEXTO_SIN_INSCRIPCIONES }));

  /** Títulos que aún esperan su primera fila de pruebas. */
  let pendientes: Titulo[] = [];
  for (const f of filasVisuales(r)) {
    if (f.tipo !== "bloques") {
      pendientes.push(f);
      continue;
    }
    const fila: LineaDelPdf = {
      tipo: "bloques",
      jornada: f.jornada.titulo,
      izquierda: bloqueDelPdf(f.fila.izquierda),
      derecha: f.fila.derecha === null ? null : bloqueDelPdf(f.fila.derecha),
    };
    const bloque = [...pendientes.map((p) => ubicar(titulo(p, false))), ubicar(fila)];
    if (bloque.reduce((suma, l) => suma + l.alto, 0) > libre && actual().length > 0) {
      paginas.push([]);
      libre = opciones.alto;
      const contexto: Titulo[] = [
        { tipo: "club", club: f.club },
        { tipo: "nadador", club: f.club, nadador: f.nadador },
      ];
      for (const c of contexto) if (!pendientes.some((p) => p.tipo === c.tipo)) poner(ubicar(titulo(c, true)));
    }
    bloque.forEach(poner);
    pendientes = [];
  }
  return paginas;
}
