/**
 * Reporte DETALLADO de inscripciones: estructura común y archivos CSV, Excel y PDF.
 *
 * Comprueba la jerarquía competencia → club → nadador → fecha y jornada → pruebas, su orden, los
 * totales, los relevos, y que los tres archivos llevan EXACTAMENTE los datos y la secuencia de la
 * estructura que recibe la pantalla. Funciones puras, datos sintéticos, sin base de datos.
 */
import { inflateSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import AdmZip from "adm-zip";
import { agruparPorJornada, compararJornadas, lineaDePrueba, tiempoDeInscripcion, type JornadaDeEntrada, type PruebaDeJornada } from "../src/modules/reports/reports.rules";
import {
  armarReporteDetallado,
  BOM,
  celdaCsv,
  csvDelReporteDetallado,
  ENCABEZADOS_DE_BLOQUES,
  enDosBloques,
  filasVisuales,
  ENCABEZADOS_CSV,
  filasDelReporteDetallado,
  paginarReporteDetallado,
  saltosDeImpresion,
  TEXTO_SIN_INSCRIPCIONES,
  textoDelClub,
  textoDelNadador,
  type LineaDelPdf,
  type ReporteDetallado,
} from "../src/modules/reports/reporteDetallado.rules";
import { pdfDelReporteDetallado, xlsxDelReporteDetallado } from "../src/modules/reports/reporteDetallado.archivos";
import {
  ANA,
  CLUB_A,
  CLUB_B,
  CORTE,
  DISTRIBUCION_DOS_CLUBES,
  entrada,
  entradasBase,
  entradasDosClubes,
  EQUIPOS_BASE,
  EQUIPOS_DOS_CLUBES,
  HOSTIL,
  idDeClub,
  JORNADAS,
  reporteBase,
  reporteDosClubes,
  bloqueDe,
  leerHojaDetallada,
  reporteGrande,
  textoDe,
} from "./helpers/reporteDetalladoSintetico";

const nadador = (r: ReporteDetallado, personId: string) => r.groupedByClub.flatMap((c) => c.swimmers).find((s) => s.personId === personId)!;
const permutar = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutar([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));

// ------------------------------------------------------------------------------- Estructura

describe("estructura común", () => {
  it("club con sus totales, y nadador numerado con nombre, edad, categoría y género", () => {
    const r = reporteBase();
    expect(r.competitionName).toBe("CAMPEONATO SINTÉTICO");
    expect(r.groupedByClub.map(textoDelClub)).toEqual([
      'Club "Raro"; =1+1, -S.A. (1 nadadores, 1 pruebas individuales, 0 relevos)',
      "CLUB DE PRUEBA (6 nadadores, 12 pruebas individuales, 2 relevos)",
    ]);
    expect(r.groupedByClub[1]!.swimmers.map((s) => `${s.numero}. ${textoDelNadador(s)}`)).toEqual([
      "1. ÁVILA ÜBER, DIEGO (43) - Master D - Varones",
      "2. FERNÁNDEZ-ECHEVERRÍA DE LA SANTÍSIMA TRINIDAD LARRAÍN UNDURRAGA Y GOYENECHE-ITURRALDE DEL SOLAR, MARÍA DE LOS ÁNGELES FERNANDA CONSTANZA GUADALUPE DEL CARMEN (43) - Master D - Damas",
      "3. ÑANDÚ, BRUNO (43) - Master E - Varones",
      "4. PRUEBA SINTÉTICA, ANA (43) - Master D - Damas",
      "5. RELEVISTA ÚNICA, ELENA (43) - Relevo 160-199 - Damas",
      "6. CARMEN DEL RÍO HISTÓRICA (43) - Master D - Damas",
    ]);
  });

  it("fechas cronológicas, jornadas según la programación y pruebas por número (2, 10, ausente), con relevos en su jornada", () => {
    expect(nadador(reporteBase(), "p-ana").jornadas.map((j) => [j.titulo, j.pruebas.map((p) => [p.numero, p.tipo, textoDe(p)])])).toEqual([
      [
        "06-01-2027 Mañana",
        [
          [2, "individual", "800m Libre 13:03,08"],
          [10, "individual", "100m Espalda 1:45,00"],
          [null, "individual", "50m Mariposa"],
        ],
      ],
      ["06-01-2027 Tarde", [[4, "individual", "50m Pecho 0:45,10"]]],
      [
        "07-01-2027 Mañana",
        [
          [5, "individual", "100m Pecho 1:39,07"],
          [7, "relevo", "Relevo 200m Libre (Mixto) 2:15,34"],
          [8, "individual", "200m Combinado 3:28,52"],
        ],
      ],
      ["07-01-2027 Noche", [[20, "individual", "50m Espalda"]]],
      ["07-01-2027 Especial", [[30, "individual", "400m Libre"]]],
    ]);
  });

  it("dos jornadas con el mismo nombre en días distintos no se unen", () => {
    const mananas = nadador(reporteBase(), "p-ana").jornadas.filter((j) => j.jornada === "Mañana");
    expect(mananas.map((j) => j.fecha)).toEqual(["06-01-2027", "07-01-2027"]);
  });

  it("agrupa por la sesión y no por el texto: dos sesiones con igual fecha y nombre siguen separadas", () => {
    const otra: JornadaDeEntrada = { ...JORNADAS.miercolesManana, id: "s-otra" };
    const j = agruparPorJornada([entrada(ANA, { jornada: JORNADAS.miercolesManana, eventNumber: 1 }), entrada(ANA, { jornada: otra, eventNumber: 2 })]);
    expect(j.map((x) => x.jornadaId)).toEqual(["s-mie-m", "s-otra"]);
  });

  it("la fecha es el día de calendario guardado (medianoche UTC), sin desplazarse con la zona horaria del servidor", () => {
    const previa = process.env.TZ;
    try {
      for (const tz of ["America/Santiago", "Pacific/Auckland", "UTC"]) {
        process.env.TZ = tz;
        const [j] = agruparPorJornada([entrada(ANA, { jornada: { id: "s", fecha: new Date("2027-01-01T00:00:00.000Z"), nombre: "Mañana", primerNumero: null } })]);
        expect(j!.fecha, tz).toBe("01-01-2027");
      }
    } finally {
      if (previa === undefined) delete process.env.TZ;
      else process.env.TZ = previa;
    }
  });

  it("orden de jornadas total y estable: no depende del orden de entrada", () => {
    const todas = Object.values(JORNADAS);
    const esperado = ["s-mie-m", "s-mie-t", "s-jue-m", "s-jue-n", "s-jue-e"];
    for (const p of permutar(todas)) expect([...p].sort(compararJornadas).map((j) => j.id)).toEqual(esperado);
    // Aunque la numeración se reinicie y la tarde abra antes el programa, la mañana va primero.
    const reiniciada = [
      { ...JORNADAS.miercolesTarde, primerNumero: 1 },
      { ...JORNADAS.miercolesManana, primerNumero: 3 },
    ];
    expect(reiniciada.sort(compararJornadas).map((j) => j.nombre)).toEqual(["Mañana", "Tarde"]);
  });

  it("números repetidos o ausentes: desempate estable por el texto visible", () => {
    const lineas = [
      entrada(ANA, { jornada: JORNADAS.juevesManana, eventNumber: 6, eventLabel: "100m Pecho" }),
      entrada(ANA, { jornada: JORNADAS.juevesManana, eventNumber: 6, eventLabel: "100m Espalda", timeLabel: "1:10,00" }),
      entrada(ANA, { jornada: JORNADAS.juevesManana, eventNumber: null, eventLabel: "200m Mariposa" }),
      entrada(ANA, { jornada: JORNADAS.juevesManana, eventNumber: null, eventLabel: "100m Mariposa" }),
      entrada(ANA, { jornada: JORNADAS.juevesManana, eventNumber: 2, eventLabel: "50m Libre" }),
    ];
    const esperado = ["2 50m Libre", "6 100m Espalda 1:10,00", "6 100m Pecho", "null 100m Mariposa", "null 200m Mariposa"];
    for (const p of permutar(lineas)) expect(agruparPorJornada(p)[0]!.pruebas.map((x) => `${x.numero} ${textoDe(x)}`)).toEqual(esperado);
  });

  it("relevos: quien solo participa en relevos aparece, y el total cuenta equipos, no participaciones", () => {
    const r = reporteBase();
    expect(nadador(r, "p-elena").jornadas.map((j) => [j.titulo, j.pruebas.map((p) => `${p.numero} ${p.tipo} ${textoDe(p)}`)])).toEqual([
      ["06-01-2027 Tarde", ["9 relevo Relevo 200m Combinado (Mixto)"]],
      ["07-01-2027 Mañana", ["7 relevo Relevo 200m Libre (Mixto) 2:15,34"]],
    ]);
    const club = r.groupedByClub[1]!;
    const participaciones = club.swimmers.flatMap((s) => s.jornadas).flatMap((j) => j.pruebas).filter((p) => p.tipo === "relevo");
    expect(participaciones).toHaveLength(8);
    expect(club.totalRelevos).toBe(2);
  });

  it("ninguna línea se pierde ni se duplica, y la jornada no cambia las listas ni la categoría anteriores", () => {
    const r = reporteGrande();
    for (const s of r.groupedByClub.flatMap((c) => c.swimmers)) {
      const lineas = s.jornadas.flatMap((j) => j.pruebas);
      const orden = (xs: string[]) => [...xs].sort();
      expect(orden(lineas.filter((p) => p.tipo === "individual").map((p) => `${p.numero}|${textoDe(p)}`))).toEqual(orden(s.pruebas.map((p) => `${p.number}|${p.text}`)));
      expect(orden(lineas.filter((p) => p.tipo === "relevo").map((p) => `${p.numero}|${textoDe(p)}`))).toEqual(orden(s.relevos.map((p) => `${p.number}|${p.text}`)));
    }
    // La categoría sigue siendo la de la individual aunque el relevo sea anterior en el programa.
    expect(nadador(reporteBase(), "p-diego").categoria).toBe("Master D");
  });

  it("un filtro (club, persona, fecha o jornada) solo quita filas: lo que queda conserva orden y textos", () => {
    const completo = reporteBase();
    const armar = (f: (e: ReturnType<typeof entradasBase>[number]) => boolean, equipos = EQUIPOS_BASE) =>
      armarReporteDetallado("CAMPEONATO SINTÉTICO", entradasBase().filter(f), CORTE, equipos);

    expect(armar((e) => e.clubName === "CLUB DE PRUEBA").groupedByClub).toEqual([completo.groupedByClub[1]]);
    const persona = armar((e) => e.personId === "p-ana", new Map([[idDeClub("CLUB DE PRUEBA"), 1]]));
    expect(persona.groupedByClub[0]!.totalesTexto).toBe("1 nadadores, 8 pruebas individuales, 1 relevos");
    expect(persona.groupedByClub[0]!.swimmers[0]!.jornadas).toEqual(nadador(completo, "p-ana").jornadas);
    const jueves = armar((e) => e.jornada.fecha.getUTCDate() === 7);
    expect(nadador(jueves, "p-ana").jornadas).toEqual(nadador(completo, "p-ana").jornadas.filter((j) => j.fecha === "07-01-2027"));
    const manana = armar((e) => e.jornada.nombre === "Mañana");
    expect(nadador(manana, "p-ana").jornadas).toEqual(nadador(completo, "p-ana").jornadas.filter((j) => j.jornada === "Mañana"));
  });

  it("no lleva RUN ni fecha de nacimiento", () => {
    const json = JSON.stringify(reporteGrande());
    expect(json).not.toMatch(/RUNSINTETICO|birth|nacimiento|1984/i);
  });
});

// ------------------------------------------------------------------------------- Dos bloques

/** Una jornada de Ana con `n` pruebas, del número 1 al `n`. */
const conPruebas = (n: number): PruebaDeJornada[] =>
  n === 0 ? [] : agruparPorJornada(Array.from({ length: n }, (_, i) => entrada(ANA, { jornada: JORNADAS.miercolesManana, eventNumber: i + 1, eventLabel: `${i + 1}00m Libre` })))[0]!.pruebas;

describe("dos bloques por fila", () => {
  it("una, dos, tres y varias pruebas: de izquierda a derecha y siguiendo abajo; con impar, el bloque derecho queda vacío", () => {
    const numeros = (n: number) => enDosBloques(conPruebas(n)).map((f) => [f.izquierda.numero, f.derecha?.numero ?? null]);
    expect(numeros(0)).toEqual([]);
    expect(numeros(1)).toEqual([[1, null]]);
    expect(numeros(2)).toEqual([[1, 2]]);
    expect(numeros(3)).toEqual([[1, 2], [3, null]]);
    expect(numeros(7)).toEqual([[1, 2], [3, 4], [5, 6], [7, null]]);
    expect(numeros(8)).toEqual([[1, 2], [3, 4], [5, 6], [7, 8]]);
  });

  it("respeta el orden del programa (2, 10, ausente), y no duplica ni omite", () => {
    const [manana] = nadador(reporteBase(), "p-ana").jornadas;
    const filas = enDosBloques(manana!.pruebas);
    expect(filas.map((f) => [bloqueDe(f.izquierda), f.derecha && bloqueDe(f.derecha)])).toEqual([
      ["[2] 800m Libre 13:03,08", "[10] 100m Espalda 1:45,00"],
      ["50m Mariposa Sin tiempo", null],
    ]);
    for (let n = 0; n <= 9; n++) expect(enDosBloques(conPruebas(n)).flatMap((f) => [f.izquierda, ...(f.derecha ? [f.derecha] : [])])).toEqual(conPruebas(n));
  });

  it("nunca empareja pruebas de jornadas, días, nadadores o clubes distintos", () => {
    for (const r of [reporteGrande(), reporteDosClubes()]) {
      const filas = filasVisuales(r).flatMap((f) => (f.tipo === "bloques" ? [f] : []));
      for (const f of filas) {
        const suya = r.groupedByClub.find((c) => c.clubId === f.club.clubId)!.swimmers.find((s) => s.personId === f.nadador.personId)!.jornadas.find((j) => j.jornadaId === f.jornada.jornadaId)!;
        expect(suya.pruebas).toContain(f.fila.izquierda);
        if (f.fila.derecha) expect(suya.pruebas).toContain(f.fila.derecha);
      }
      // Solo la última fila de cada jornada puede tener el bloque derecho vacío.
      filas.forEach((f, i) => {
        const siguiente = filas[i + 1];
        if (f.fila.derecha === null) expect(siguiente?.jornada === f.jornada, "vacío solo al final de la jornada").toBe(false);
      });
      // Recorridas en orden de lectura, son exactamente las pruebas del reporte.
      expect(filas.flatMap((f) => [f.fila.izquierda, ...(f.fila.derecha ? [f.fila.derecha] : [])])).toEqual(
        filasDelReporteDetallado(r).flatMap((f) => (f.tipo === "prueba" ? [f.prueba] : []))
      );
    }
  });
});

describe("saltosDeImpresion", () => {
  const filas = (patron: string, alto = 10) => [...patron].map((c) => ({ tipo: c === "C" ? ("club" as const) : c === "N" ? ("nadador" as const) : ("bloques" as const), alto }));

  it("un título no queda solo al pie: salta con él, aunque sobre espacio", () => {
    // Caben 4 filas: «N» (y «CN») quedarían en el pie de la primera página.
    expect(saltosDeImpresion(filas("CNbNb"), 40)).toEqual([2]);
    expect(saltosDeImpresion(filas("NbbNb"), 40)).toEqual([2]);
    expect(saltosDeImpresion(filas("NbCNb"), 40)).toEqual([1]);
  });

  it("un nadador que cabe entero no se parte; uno más alto que la página, sí, entre filas y sin separarse de su título", () => {
    expect(saltosDeImpresion(filas("NbNbbb"), 50)).toEqual([1]);
    expect(saltosDeImpresion(filas("Nbbbbbbb"), 30)).toEqual([2, 5]);
    expect(saltosDeImpresion(filas("NbNbbbbbbb"), 40)).toEqual([3, 7]);
  });

  it("sin nada que partir no hay saltos, y nunca salta antes de la primera fila", () => {
    expect(saltosDeImpresion([], 40)).toEqual([]);
    expect(saltosDeImpresion(filas("CNbNb"), 1000)).toEqual([]);
    expect(saltosDeImpresion(filas("CNb", 100), 40)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------- Tiempos

describe("tiempos", () => {
  it("un número guardado se presenta con sus centésimas, también el 0; solo null y undefined son ausencia", () => {
    const casos: [number | null | undefined, string | null][] = [
      [9907, "1:39,07"],
      [78308, "13:03,08"],
      [2000, "0:20,00"],
      [5, "0:00,05"],
      [1, "0:00,01"],
      [0, "0:00,00"],
      [null, null],
      [undefined, null],
    ];
    for (const [centesimas, esperado] of casos) expect(tiempoDeInscripcion(centesimas), String(centesimas)).toBe(esperado);
  });

  it("la línea no decide la ausencia por veracidad", () => {
    expect(lineaDePrueba(1, "50m Libre", "0:00,00").text).toBe("50m Libre 0:00,00");
    expect(lineaDePrueba(1, "50m Libre", null).text).toBe("50m Libre");
  });

  it("sin tiempo: «Sin tiempo», nunca un vacío, un cero ni el tiempo de otra prueba; y la ausencia es solo la de la inscripción", () => {
    const r = reporteGrande();
    const pruebas = r.groupedByClub.flatMap((c) => c.swimmers).flatMap((s) => s.jornadas).flatMap((j) => j.pruebas);
    expect(pruebas.filter((p) => p.tiempo === null).length).toBeGreaterThan(50);
    expect(pruebas.filter((p) => p.tiempo !== null).length).toBeGreaterThan(50);
    for (const p of pruebas) expect(p.tiempoTexto).toBe(p.tiempo ?? "Sin tiempo");
    // Una entrada por línea: cada tiempo es el de su propia entrada.
    const es = entradasBase();
    const base = reporteBase();
    const clave = (club: string, persona: string, jornada: string, numero: number | null, tiempo: string | null) => [club, persona, jornada, numero, tiempo].join("|");
    expect(base.groupedByClub.flatMap((c) => c.swimmers.flatMap((s) => s.jornadas.flatMap((j) => j.pruebas.map((p) => clave(c.clubId, s.personId, j.jornadaId, p.numero, p.tiempo))))).sort()).toEqual(
      es.map((e) => clave(e.clubId, e.personId, e.jornada.id, e.eventNumber, e.timeLabel)).sort()
    );
  });
});

// ------------------------------------------------------------------------------- Lo que debe llevar todo archivo

interface FilaEsperada {
  seccion: string;
  club: string;
  nadador: string;
  jornada: string;
  numero: string;
  prueba: string;
  tiempo: string;
}
/** La estructura de la pantalla, aplanada: contra ella se comparan los archivos leídos de vuelta. */
const esperadas = (r: ReporteDetallado): FilaEsperada[] =>
  r.groupedByClub.flatMap((c) => {
    const vacia = { club: c.clubName, nadador: "", jornada: "", numero: "", prueba: "", tiempo: "" };
    return [
      { ...vacia, seccion: "Club" },
      ...c.swimmers.flatMap((s) => {
        const n = { ...vacia, nadador: `${s.numero}. ${s.nombrePresentado} (${s.edad}) - ${s.categoria} - ${s.genero}` };
        return [
          { ...n, seccion: "Nadador" },
          ...s.jornadas.flatMap((j) => {
            const jj = { ...n, jornada: `${j.fecha} ${j.jornada}` };
            return [
              { ...jj, seccion: "Jornada" },
              ...j.pruebas.map((p) => ({ ...jj, seccion: "Prueba", numero: p.numero === null ? "" : String(p.numero), prueba: p.descripcion, tiempo: p.tiempo ?? "Sin tiempo" })),
            ];
          }),
        ];
      }),
    ];
  });

// ------------------------------------------------------------------------------- CSV

/** Lector de CSV con `;` (RFC 4180): sirve para comprobar el escapado leyendo lo escrito. */
function leerCsv(csv: string): string[][] {
  const texto = csv.startsWith(BOM) ? csv.slice(1) : csv;
  const filas: string[][] = [[""]];
  let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    const fila = filas[filas.length - 1]!;
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') {
        fila[fila.length - 1] += c;
        i++;
      } else if (c === '"') comillas = false;
      else fila[fila.length - 1] += c;
    } else if (c === '"') comillas = true;
    else if (c === ";") fila.push("");
    else if (c === "\r" && texto[i + 1] === "\n") {
      filas.push([""]);
      i++;
    } else fila[fila.length - 1] += c;
  }
  return filas;
}
const registros = (csv: string) => {
  const [cabecera, ...filas] = leerCsv(csv);
  return filas.map((f) => Object.fromEntries(cabecera!.map((h, i) => [h, f[i]!]))) as Record<(typeof ENCABEZADOS_CSV)[number], string>[];
};

describe("CSV", () => {
  it("BOM, `;`, encabezados claros y las mismas columnas en todas las filas", () => {
    const csv = csvDelReporteDetallado(reporteGrande());
    expect(csv.startsWith(BOM)).toBe(true);
    const filas = leerCsv(csv);
    expect(filas[0]).toEqual([...ENCABEZADOS_CSV]);
    expect(new Set(filas.map((f) => f.length))).toEqual(new Set([ENCABEZADOS_CSV.length]));
    expect(filas[1]!.slice(0, 2)).toEqual(["Competencia", "CAMPEONATO SINTÉTICO"]);
  });

  it("misma secuencia, datos y totales que la pantalla (sin los valores hostiles, que se neutralizan)", () => {
    const r = armarReporteDetallado("CAMPEONATO SINTÉTICO", entradasBase().filter((e) => e.personId !== HOSTIL.personId), CORTE, EQUIPOS_BASE);
    const leidas = registros(csvDelReporteDetallado(r)).slice(1);
    expect(
      leidas.map((f) => ({
        seccion: f["Sección"],
        club: f.Club,
        nadador: f.Nadador && `${f["N° nadador"]}. ${f.Nadador} (${f.Edad}) - ${f["Categoría"]!.trim()} - ${f["Género"]}`,
        jornada: f.Fecha && `${f.Fecha!.trim()} ${f.Jornada}`,
        numero: f["N° prueba"],
        prueba: f.Prueba,
        tiempo: f.Tiempo!.trim(),
      }))
    ).toEqual(esperadas(r));
    expect(leidas.filter((f) => f["Sección"] === "Club").map((f) => [f["Total nadadores"], f["Total pruebas individuales"], f["Total relevos"]])).toEqual([["6", "12", "2"]]);
    // Los totales están solo en la fila del club; el tipo de prueba, solo en las pruebas.
    expect(leidas.filter((f) => f["Sección"] !== "Club").every((f) => f["Total relevos"] === "")).toBe(true);
    expect(leidas.filter((f) => f["Tipo de prueba"] === "Relevo")).toHaveLength(8);
    expect(leidas.filter((f) => f["Tipo de prueba"] === "Individual")).toHaveLength(12);
  });

  it("tiempos, fechas y rangos quedan como texto exacto (espacio inicial); números y textos no se tocan", () => {
    for (const v of ["1:39,07", "13:03,08", "06-01-2027", "8-10", "25-29", "1.5"]) expect(celdaCsv(v).replace(/"/g, ""), v).toBe(` ${v}`);
    for (const v of ["", "43", "2027", "50m Libre", "Master D", "Relevo 160-199", "PRUEBA, ANA"]) expect(celdaCsv(v).replace(/"/g, ""), v).toBe(v);
  });

  it("escapa comillas, separadores, saltos de línea y tildes sin perder nada", () => {
    for (const v of ['Club "Raro"', "a;b", "a,b", "a\nb", "a\r\nb", "a|b", "Ñandú Ávila Über", 'x";y']) expect(leerCsv(`${celdaCsv(v)};fin`)[0], v).toEqual([v, "fin"]);
  });

  it("protección contra fórmulas con cualquier separador (coma, `;`, tabulador, barra) aunque se ignoren las comillas", () => {
    const hostiles = ["=1+1", "+1", "-1+1", "@x", "\t=1", "A;=1+1;B", "A,=1+1,B", "A|=1", "A\n=1", 'A;"=1', '"=1+1', "A, -1", "A;  +2"];
    for (const h of hostiles) {
      for (const trozo of `x;${celdaCsv(h)};y`.split(/[;,|\t\r\n]/)) expect(/^[ "]*[=+\-@]/.test(trozo), `${JSON.stringify(h)} → «${trozo}»`).toBe(false);
    }
    const csv = csvDelReporteDetallado(reporteBase());
    for (const trozo of csv.split(/[;,|\t\r\n]/)) expect(/^[ "]*[=+\-@]/.test(trozo), trozo).toBe(false);
    expect(csv).toContain("SUMA(A1)");
  });

  it("sin inscripciones: la competencia y un aviso", () => {
    const filas = registros(csvDelReporteDetallado(armarReporteDetallado("CAMPEONATO SINTÉTICO", [], CORTE, new Map())));
    expect(filas.map((f) => f["Sección"])).toEqual(["Competencia", TEXTO_SIN_INSCRIPCIONES]);
  });
});

// ------------------------------------------------------------------------------- Excel

async function leerXlsx(buffer: Buffer) {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(buffer as never);
  expect(libro.worksheets.map((h) => h.name)).toEqual(["Inscripciones"]);
  return libro.worksheets[0]!;
}

describe("Excel", () => {
  it("mismos títulos, filas de dos bloques, tiempos y totales que la estructura de la pantalla", async () => {
    for (const r of [reporteBase(), reporteGrande()]) {
      const hoja = await leerXlsx(await xlsxDelReporteDetallado(r));
      expect(hoja.getCell("A1").value).toBe("CAMPEONATO SINTÉTICO");
      expect([1, 3, 4, 6, 7].map((c) => hoja.getRow(2).getCell(c).value)).toEqual([...ENCABEZADOS_DE_BLOQUES]);
      expect(leerHojaDetallada(hoja)).toEqual(
        r.groupedByClub.map((c) => ({
          club: textoDelClub(c),
          nadadores: c.swimmers.map((s) => ({
            linea: `${s.numero}. ${textoDelNadador(s)}`,
            filas: s.jornadas.flatMap((j) =>
              enDosBloques(j.pruebas).map((f) => ({ jornada: j.titulo, bloques: [bloqueDe(f.izquierda), ...(f.derecha ? [bloqueDe(f.derecha)] : [])] }))
            ),
          })),
        }))
      );
    }
  });

  it("formato: títulos a todo el ancho, ajuste de línea, tiempos alineados, encabezado fijo e impresión en carta vertical, una página de ancho", async () => {
    const hoja = await leerXlsx(await xlsxDelReporteDetallado(reporteBase()));
    const filaDe = (texto: string, columna = 1) => {
      let hallada: ExcelJS.Row | undefined;
      hoja.eachRow((f) => {
        if (String(f.getCell(columna).value ?? "").includes(texto)) hallada ??= f;
      });
      return hallada!;
    };
    expect(hoja.getRow(1).getCell(7).isMerged).toBe(true);
    expect(filaDe("CLUB DE PRUEBA").getCell(7).isMerged).toBe(true);
    expect(filaDe("CLUB DE PRUEBA").getCell(1).font).toMatchObject({ bold: true });
    // Nadador: negrita; combinado solo si necesita más de una línea (los demás se extienden sobre celdas vacías).
    expect(filaDe("PRUEBA SINTÉTICA").getCell(1).font).toMatchObject({ bold: true });
    expect([2, 3, 4, 5, 6, 7].map((c) => filaDe("PRUEBA SINTÉTICA").getCell(c).value)).toEqual([null, null, null, null, null, null]);
    expect(filaDe("FERNÁNDEZ-ECHEVERRÍA").getCell(7).isMerged).toBe(true);
    expect(filaDe("FERNÁNDEZ-ECHEVERRÍA").getCell(1).alignment).toMatchObject({ wrapText: true });
    expect(filaDe("FERNÁNDEZ-ECHEVERRÍA").height).toBeGreaterThan(30);

    const fila = filaDe("100m Espalda", 6);
    expect([2, 5].map((c) => [fila.getCell(c).value, fila.getCell(c).numFmt])).toEqual([[2, '"["0"]"'], [10, '"["0"]"']]);
    expect([3, 6].map((c) => fila.getCell(c).alignment)).toEqual([expect.objectContaining({ wrapText: true }), expect.objectContaining({ wrapText: true })]);
    expect([4, 7].map((c) => [fila.getCell(c).value, fila.getCell(c).alignment?.horizontal])).toEqual([["13:03,08", "right"], ["1:45,00", "right"]]);
    const impar = filaDe("50m Mariposa", 3);
    expect([4, 5, 6, 7].map((c) => impar.getCell(c).value)).toEqual(["Sin tiempo", null, null, null]);

    expect(hoja.pageSetup).toMatchObject({ orientation: "portrait", paperSize: 1, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:2" });
    // Con el 8 % que Excel ensancha las columnas al imprimir, la escala apenas baja (97 %); y se lee a 10 puntos.
    const ancho = hoja.columns.reduce((suma, c) => suma + c.width! * 5.25 * 1.08, 0);
    expect((612 - 2 * 0.25 * 72) / ancho).toBeGreaterThan(0.96);
    expect([3, 4, 6, 7].map((c) => fila.getCell(c).font?.size)).toEqual([10, 10, 10, 10]);
    expect(hoja.views[0]).toMatchObject({ state: "frozen", ySplit: 2 });
  });

  it("el alto de una fila es el de su bloque más alto, y da igual cuál sea", async () => {
    const largo = "1500m Descripción sintética muy extensa que necesita varias líneas en su propio bloque";
    const alto = async (etiquetas: string[]) => {
      const es = etiquetas.map((eventLabel, i) => entrada(ANA, { jornada: JORNADAS.miercolesManana, eventNumber: i + 1, eventLabel }));
      const hoja = await leerXlsx(await xlsxDelReporteDetallado(armarReporteDetallado("C", es, CORTE, new Map())));
      return hoja.lastRow!.height;
    };
    const [corta, izquierda, derecha, ambas] = [await alto(["a", "b"]), await alto([largo, "b"]), await alto(["a", largo]), await alto([largo, largo])];
    expect(izquierda).toBeGreaterThan(corta * 2);
    expect([derecha, ambas]).toEqual([izquierda, izquierda]);
  });

  it("saltos de impresión: ningún título al pie, los nadadores que caben no se parten y ninguna página se excede", async () => {
    const r = reporteGrande();
    const buffer = await xlsxDelReporteDetallado(r);
    const hoja = await leerXlsx(buffer);
    const xml = new AdmZip(buffer).readAsText("xl/worksheets/sheet1.xml");
    expect(xml).toMatch(/<pageSetup [^>]*paperSize="1" orientation="portrait"/);
    const alto = (n: number) => hoja.getRow(n).height;
    const util = 792 - (0.5 + 0.6) * 72;
    // ExcelJS no lee los saltos al reabrir el libro: se toman del XML.
    const saltos = new Set([...xml.matchAll(/<brk id="([0-9]+)"[^>]* man="1"/g)].map((m) => Number(m[1])));
    expect(saltos.size).toBeGreaterThan(3);
    const visuales = filasVisuales(r);
    let enPagina = alto(1) + alto(2);
    visuales.forEach((f, i) => {
      const n = 3 + i;
      enPagina += alto(n);
      expect(enPagina, `fila ${n}`).toBeLessThanOrEqual(util);
      if (!saltos.has(n)) return;
      expect(f.tipo, `el salto tras la fila ${n} no deja un título al pie`).toBe("bloques");
      expect(visuales[i + 1]!.tipo, `tras la fila ${n} empieza otro nadador: ninguno de este reporte excede una página`).not.toBe("bloques");
      enPagina = alto(1) + alto(2);
    });
  });

  it("ninguna celda es una fórmula, y ninguna parte del libro lleva el RUN ni la fecha de nacimiento", async () => {
    const buffer = await xlsxDelReporteDetallado(reporteBase());
    const hoja = await leerXlsx(buffer);
    hoja.eachRow((f) => f.eachCell((c) => expect(c.type).not.toBe(ExcelJS.ValueType.Formula)));
    for (const parte of new AdmZip(buffer).getEntries()) expect(parte.getData().toString("utf8"), parte.entryName).not.toMatch(/RUNSINTETICO|1984-05|10-05-1984|<f>/);
  });

  it("sin inscripciones: el aviso", async () => {
    const hoja = await leerXlsx(await xlsxDelReporteDetallado(armarReporteDetallado("CAMPEONATO SINTÉTICO", [], CORTE, new Map())));
    expect(hoja.getCell("A3").value).toBe(TEXTO_SIN_INSCRIPCIONES);
  });
});

// ------------------------------------------------------------------------------- PDF

/** Texto de cada página del PDF, extrayendo el contenido generado (no se renderiza aquí). */
function paginasDelPdf(pdf: Buffer): string[][] {
  const paginas: string[][] = [];
  for (const m of pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let contenido: string;
    try {
      contenido = inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1");
    } catch {
      continue;
    }
    if (!contenido.includes("BT")) continue;
    paginas.push(
      [...contenido.matchAll(/\[((?:<[0-9a-fA-F]*>\s*-?[\d.]*\s*)+)\]\s*TJ/g)].map((t) =>
        [...t[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1]!, "hex").toString("latin1")).join("")
      )
    );
  }
  return paginas;
}

/** Coordenada vertical (en puntos, desde abajo) en que se dibuja un texto dado. */
function posicionVertical(pdf: Buffer, texto: string): number {
  for (const m of pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let contenido: string;
    try {
      contenido = inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const t of contenido.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm[\s\S]*?\[((?:<[0-9a-fA-F]*>\s*-?[\d.]*\s*)+)\]\s*TJ/g)) {
      if ([...t[2]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1]!, "hex").toString("latin1")).join("") === texto) return Number(t[1]);
    }
  }
  throw new Error(`no está en el PDF: ${texto}`);
}

const medidaSintetica = (l: LineaDelPdf) => (l.tipo === "club" ? 20 : l.tipo === "nadador" ? 16 : 12);

describe("PDF", () => {
  const textosDeFila = (l: Extract<LineaDelPdf, { tipo: "bloques" }>) =>
    [l.jornada, ...[l.izquierda, l.derecha].flatMap((b) => (b ? [b.numero, b.descripcion, b.tiempo] : []))].filter((t) => t !== "");
  const textosEsperados = (f: ReturnType<typeof filasVisuales>[number]) =>
    f.tipo === "club"
      ? [textoDelClub(f.club)]
      : f.tipo === "nadador"
        ? [`${f.nadador.numero}. ${textoDelNadador(f.nadador)}`]
        : [f.jornada.titulo, ...[f.fila.izquierda, f.fila.derecha].flatMap((p) => (p ? [...(p.numero === null ? [] : [`[${p.numero}]`]), p.descripcion, p.tiempoTexto] : []))];

  it("paginación: ningún título queda solo al pie, nada se omite y cada página repite su contexto", () => {
    for (const alto of [80, 100, 137, 200, 333, 500]) {
      const r = reporteGrande();
      const paginas = paginarReporteDetallado(r, { altoPrimera: alto - 10, alto, medir: medidaSintetica });
      expect(paginas.length).toBeGreaterThan(3);
      paginas.forEach((lineas, i) => {
        expect(lineas.reduce((s, l) => s + l.alto, 0), `página ${i}`).toBeLessThanOrEqual(i === 0 ? alto - 10 : alto);
        expect(lineas.at(-1)!.linea.tipo, `la página ${i} termina en una fila de pruebas`).toBe("bloques");
        // Empieza por el club y el nadador; y toda fila lleva su fecha y jornada.
        expect(lineas.map((l) => l.linea.tipo).slice(0, 3), `página ${i}`).toEqual(["club", "nadador", "bloques"]);
        for (const { linea } of lineas) if (linea.tipo === "bloques") expect(linea.jornada).toMatch(/^\d{2}-\d{2}-\d{4} \S/);
      });
      // Sin las continuaciones, la secuencia y los textos son exactamente los del reporte.
      const sinContinuaciones = paginas.flat().map((l) => l.linea).filter((l) => !("continuacion" in l && l.continuacion));
      expect(sinContinuaciones.map((l) => (l.tipo === "bloques" ? textosDeFila(l) : [l.texto]))).toEqual(filasVisuales(r).map(textosEsperados));
    }
  });

  it("continuación: repite club y nadador vigentes, marcados; la fila siguiente conserva su jornada", () => {
    const entradas = Array.from({ length: 12 }, (_, i) => entrada(ANA, { jornada: JORNADAS.miercolesManana, eventNumber: i + 1, eventLabel: `${i + 1}00m Libre` }));
    const paginas = paginarReporteDetallado(armarReporteDetallado("C", entradas, CORTE, new Map()), { altoPrimera: 72, alto: 72, medir: medidaSintetica });
    expect(paginas[1]!.slice(0, 3).map(({ linea: l }) => (l.tipo === "bloques" ? textosDeFila(l) : l.texto))).toEqual([
      "CLUB DE PRUEBA (continuación)",
      "1. PRUEBA SINTÉTICA, ANA (43) - Master D - Damas (continuación)",
      ["06-01-2027 Mañana", "[7]", "700m Libre", "Sin tiempo", "[8]", "800m Libre", "Sin tiempo"],
    ]);
  });

  it("una fila avanza según el más alto de sus dos bloques", async () => {
    const largo = "Descripción sintética muy extensa que necesita varias líneas dentro de su propio bloque del reporte";
    const alto = async (etiquetas: string[]) => {
      const es = [
        ...etiquetas.map((eventLabel, i) => entrada(ANA, { jornada: JORNADAS.miercolesManana, eventNumber: i + 1, eventLabel })),
        entrada(ANA, { jornada: JORNADAS.juevesManana, eventNumber: 99, eventLabel: "FINAL" }),
      ];
      const pdf = await pdfDelReporteDetallado(armarReporteDetallado("C", es, CORTE, new Map()));
      return posicionVertical(pdf, "FINAL");
    };
    const [corta, izquierda, derecha, ambas] = [await alto(["a", "b"]), await alto([largo, "b"]), await alto(["a", largo]), await alto([largo, largo])];
    // En el PDF, `y` crece hacia arriba: más abajo es menor. Da igual qué bloque sea el alto, y dos altos no suman.
    expect(izquierda).toBeLessThan(corta - 15);
    expect(derecha).toBe(izquierda);
    expect(ambas).toBe(izquierda);
  });

  it("el archivo: varias páginas, con la competencia y los encabezados en todas y todo el contenido en el orden del reporte", async () => {
    const r = reporteGrande();
    const pdf = await pdfDelReporteDetallado(r);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const paginas = paginasDelPdf(pdf);
    expect(paginas.length).toBeGreaterThan(4);
    // Carta vertical en todas las páginas.
    expect([...pdf.toString("latin1").matchAll(/MediaBox \[([^\]]*)\]/g)].map((m) => m[1])).toEqual(paginas.map(() => "0 0 612 792"));
    paginas.forEach((p, i) => {
      expect(p.slice(0, 6)).toEqual(["CAMPEONATO SINTÉTICO", ...ENCABEZADOS_DE_BLOQUES]);
      expect(p.at(-1)).toBe(`Página ${i + 1} de ${paginas.length}`);
    });
    // Todo el texto, sin los espacios en que se partieron las líneas largas.
    const compacto = (t: string) => t.replace(/\s+/g, "");
    const cuerpo = paginas.map((p) => compacto(p.slice(6, -1).join(""))).join("");
    let desde = 0;
    for (const f of filasVisuales(r)) {
      const texto = compacto(textosEsperados(f).join(""));
      const i = cuerpo.indexOf(texto, desde);
      expect(i, `falta o está fuera de orden: ${texto}`).toBeGreaterThanOrEqual(0);
      desde = i + texto.length;
    }
    expect(cuerpo).not.toMatch(/RUNSINTETICO|1984|Marca/);
  });

  it("sin inscripciones: una página con el aviso", async () => {
    const paginas = paginasDelPdf(await pdfDelReporteDetallado(armarReporteDetallado("CAMPEONATO SINTÉTICO", [], CORTE, new Map())));
    expect(paginas).toHaveLength(1);
    expect(paginas[0]).toEqual(["CAMPEONATO SINTÉTICO", TEXTO_SIN_INSCRIPCIONES, "Página 1 de 1"]);
  });
});

// ------------------------------------------------------------------------------- Dos clubes

describe("una misma persona con inscripciones en dos clubes", () => {
  const armar = (entradas = entradasDosClubes(), equipos = EQUIPOS_DOS_CLUBES) => armarReporteDetallado("CAMPEONATO SINTÉTICO", entradas, CORTE, equipos);
  const distribucion = (r: ReporteDetallado) =>
    r.groupedByClub.map((c) => ({
      club: textoDelClub(c),
      nadadores: c.swimmers.map((s) => ({
        personId: s.personId,
        linea: `${s.numero}. ${textoDelNadador(s)}`,
        pruebas: s.jornadas.flatMap((j) => j.pruebas.map((p) => `${j.titulo}: ${p.numero} ${textoDe(p)}`)),
      })),
    }));

  it("sin filtro: cada inscripción queda en su club, con su fecha, jornada, marca y categoría, y los totales de cada club", () => {
    expect(distribucion(reporteDosClubes())).toEqual(DISTRIBUCION_DOS_CLUBES);
  });

  it("filtrado por cada club (solo sus entradas): exactamente la parte de ese club", () => {
    expect(distribucion(armar(entradasDosClubes().filter((e) => e.clubName === CLUB_A), new Map()))).toEqual([DISTRIBUCION_DOS_CLUBES[0]]);
    expect(distribucion(armar(entradasDosClubes().filter((e) => e.clubName === CLUB_B)))).toEqual([DISTRIBUCION_DOS_CLUBES[1]]);
  });

  it("no depende del orden en que lleguen los clubes", () => {
    const todas = entradasDosClubes();
    const ind = todas.filter((e) => e.kind === "individual");
    const rel = todas.filter((e) => e.kind === "relay");
    for (const p of permutar(ind)) expect(distribucion(armar([...p, ...rel]))).toEqual(DISTRIBUCION_DOS_CLUBES);
  });

  it("no se pierde ni se traslada ninguna prueba: la misma relación club/persona/prueba que las entradas", () => {
    const claves = (xs: string[]) => [...xs].sort();
    const r = reporteDosClubes();
    const relacion = (clase: "pruebas" | "relevos" | "jornadas") =>
      r.groupedByClub.flatMap((c) =>
        c.swimmers.flatMap((s) =>
          clase === "jornadas"
            ? s.jornadas.flatMap((j) => j.pruebas.map((p) => [c.clubName, s.personId, j.jornadaId, p.tipo, p.numero, textoDe(p)].join("|")))
            : s[clase].map((l) => [c.clubName, s.personId, l.number, l.text].join("|"))
        )
      );
    const texto = (e: { eventLabel: string; timeLabel: string | null }) => (e.timeLabel ? `${e.eventLabel} ${e.timeLabel}` : e.eventLabel);
    const es = entradasDosClubes();
    expect(claves(relacion("jornadas"))).toEqual(
      claves(es.map((e) => [e.clubName, e.personId, e.jornada.id, e.kind === "relay" ? "relevo" : "individual", e.eventNumber, texto(e)].join("|")))
    );
    for (const [lista, clase] of [["pruebas", "individual"], ["relevos", "relay"]] as const) {
      expect(claves(relacion(lista))).toEqual(claves(es.filter((e) => e.kind === clase).map((e) => [e.clubName, e.personId, e.eventNumber, texto(e)].join("|"))));
    }
  });

  it("dos clubes DISTINTOS con el mismo nombre no se unen, ni se suman sus equipos", () => {
    const mismos = entradasDosClubes().map((e) => ({ ...e, clubName: "CLUB HOMÓNIMO" }));
    const grupos = armar(mismos).groupedByClub;
    expect(grupos.map((g) => [g.clubName, g.totalNadadores, g.totalPruebasIndividuales, g.totalRelevos])).toEqual([
      ["CLUB HOMÓNIMO", 3, 3, 0],
      ["CLUB HOMÓNIMO", 4, 1, 1],
    ]);
    expect(grupos.map((g) => g.clubId)).toEqual([idDeClub(CLUB_A), idDeClub(CLUB_B)]);
    // El orden entre ellos tampoco depende de la llegada.
    const primeroB = [...mismos].sort((x, y) => (x.clubId < y.clubId ? 1 : x.clubId > y.clubId ? -1 : 0));
    expect(primeroB[0]!.clubId).toBe(idDeClub(CLUB_B));
    expect(armar(primeroB).groupedByClub.map((g) => g.clubId)).toEqual(grupos.map((g) => g.clubId));
  });

  // ---- Los tres archivos, contra la distribución escrita a mano

  it("CSV: la misma distribución", () => {
    const filas = registros(csvDelReporteDetallado(reporteDosClubes())).slice(1);
    const leida = filas
      .filter((f) => f["Sección"] === "Prueba")
      .map((f) =>
        [f.Club, `${f["N° nadador"]}. ${f.Nadador} (${f.Edad}) - ${f["Categoría"]} - ${f["Género"]}`, `${f.Fecha!.trim()} ${f.Jornada}: ${f["N° prueba"]} ${f.Prueba}${f.Tiempo === "Sin tiempo" ? "" : ` ${f.Tiempo!.trim()}`}`].join(" / ")
      );
    expect(leida).toEqual(
      DISTRIBUCION_DOS_CLUBES.flatMap((c, i) => c.nadadores.flatMap((n) => n.pruebas.map((p) => [[CLUB_A, CLUB_B][i], n.linea, p].join(" / "))))
    );
    expect(
      filas.filter((f) => f["Sección"] === "Club").map((f) => `${f.Club} (${f["Total nadadores"]} nadadores, ${f["Total pruebas individuales"]} pruebas individuales, ${f["Total relevos"]} relevos)`)
    ).toEqual(DISTRIBUCION_DOS_CLUBES.map((c) => c.club));
  });

  it("Excel: la misma distribución", async () => {
    const leida = leerHojaDetallada(await leerXlsx(await xlsxDelReporteDetallado(reporteDosClubes())));
    expect(
      leida.map((c) => ({
        club: c.club,
        nadadores: c.nadadores.map((n) => [n.linea, ...n.filas.flatMap((f) => f.bloques.map((b) => `${f.jornada}: ${b.replace(/^\[(\d+)\]/, "$1").replace(/ Sin tiempo$/, "")}`))]),
      }))
    ).toEqual(DISTRIBUCION_DOS_CLUBES.map((c) => ({ club: c.club, nadadores: c.nadadores.map((n) => [n.linea, ...n.pruebas]) })));
  });

  it("PDF: la misma distribución", async () => {
    const paginas = paginasDelPdf(await pdfDelReporteDetallado(reporteDosClubes()));
    const compacto = (t: string) => t.replace(/\s+/g, "");
    // En este caso cada persona tiene una sola jornada por club, y a lo sumo dos pruebas: una fila.
    const fila = (pruebas: string[]) =>
      pruebas[0]!.split(": ")[0]! +
      pruebas
        .map((p) => p.split(": ").slice(1).join(": "))
        .map((p) => p.replace(/^(\d+) /, "[$1]") + (/\d:\d\d,\d\d$/.test(p) ? "" : "Sin tiempo"))
        .join("");
    const esperado = DISTRIBUCION_DOS_CLUBES.flatMap((c) => [c.club, ...c.nadadores.flatMap((n) => [n.linea, fila(n.pruebas)])]).join("");
    expect(paginas).toHaveLength(1);
    expect(compacto(paginas[0]!.slice(6, -1).join(""))).toBe(compacto(esperado));
  });
});
