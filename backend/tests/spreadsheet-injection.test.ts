/**
 * Hallazgo 17 — inyección de fórmulas en las exportaciones.
 *
 * Los reportes contienen texto que escriben los propios clubes (nombres de
 * personas, de clubes, razones sociales). Si ese texto empieza con `=`, `+`,
 * `-`, `@`, tabulador o retorno de carro, Excel, LibreOffice y Google Sheets
 * lo interpretan como FÓRMULA al abrir el archivo, y la ejecutan con los
 * permisos de quien abre — normalmente el administrador de la Federación.
 *
 * Escapar según RFC 4180 no protege de esto: resuelve el formato del CSV, no
 * cómo lo interpreta la planilla.
 */
import { describe, it, expect } from "vitest";
import { neutralizeSpreadsheetFormula, escapeCsvValue, rowsToCsv } from "../src/modules/reports/reports.rules";

const ATAQUES = [
  { nombre: "fórmula de hipervínculo", valor: '=HYPERLINK("http://malicioso.cl","Haga clic")' },
  { nombre: "ejecución de comando (DDE)", valor: "=cmd|'/c calc'!A1" },
  { nombre: "suma con +", valor: "+1+1" },
  { nombre: "resta con -", valor: "-2+3" },
  { nombre: "referencia con @", valor: "@SUM(A1:A9)" },
  { nombre: "tabulador inicial", valor: "\t=1+1" },
  { nombre: "retorno de carro inicial", valor: "\r=1+1" },
];

describe("neutralizeSpreadsheetFormula", () => {
  for (const ataque of ATAQUES) {
    it(`neutraliza ${ataque.nombre}`, () => {
      const resultado = neutralizeSpreadsheetFormula(ataque.valor);
      expect(resultado.startsWith("'"), `"${ataque.valor}" debería quedar precedido de comilla simple`).toBe(true);
      expect(resultado.slice(1)).toBe(ataque.valor);
    });
  }

  it("no toca los valores normales", () => {
    for (const valor of ["Club Deportivo Norte", "Ana Pérez", "12345678-9", "50m Libre", "1:25,67", ""]) {
      expect(neutralizeSpreadsheetFormula(valor)).toBe(valor);
    }
  });

  it("no toca un texto que solo CONTIENE los caracteres, sin empezar con ellos", () => {
    expect(neutralizeSpreadsheetFormula("Club A=B")).toBe("Club A=B");
    expect(neutralizeSpreadsheetFormula("Juan-Pablo")).toBe("Juan-Pablo");
  });
});

describe("escapeCsvValue", () => {
  it("neutraliza la fórmula ADEMÁS de escapar según RFC 4180", () => {
    // Coma dentro del valor: exige comillas; la fórmula, comilla simple.
    const resultado = escapeCsvValue('=SUM(1,2)');
    expect(resultado).toBe(`"'=SUM(1,2)"`);
  });

  it("mantiene el escapado clásico para valores no peligrosos", () => {
    expect(escapeCsvValue('Club "Los Andes"')).toBe('"Club ""Los Andes"""');
    expect(escapeCsvValue("Norte, Sur")).toBe('"Norte, Sur"');
    expect(escapeCsvValue("simple")).toBe("simple");
  });
});

describe("rowsToCsv", () => {
  it("un club con nombre malicioso no produce una celda ejecutable", () => {
    const csv = rowsToCsv(["Club", "Nadador"], [['=cmd|\'/c calc\'!A1', "Ana Pérez"]]);
    const lineas = csv.split("\r\n");

    expect(lineas[0]).toBe("Club,Nadador");
    expect(lineas[1]!.startsWith("'=cmd") || lineas[1]!.startsWith(`"'=cmd`)).toBe(true);
    // Lo esencial: ninguna celda comienza con un carácter de fórmula.
    for (const celda of lineas[1]!.split(",")) {
      const contenido = celda.replace(/^"/, "");
      expect(["=", "+", "@", "\t", "\r"].some((c) => contenido.startsWith(c))).toBe(false);
    }
  });

  it("también protege los encabezados", () => {
    const csv = rowsToCsv(["=peligro"], [["dato"]]);
    expect(csv.split("\r\n")[0]).toBe("'=peligro");
  });
});

/**
 * AUD-V — límites de celda y disparadores DESPUÉS de un separador.
 *
 * Reproducido en Excel 16.0 (es-CL, separador de lista `;`) abriendo por doble clic el CSV exportado:
 * `Club;=1+1;Z` se partía en tres celdas y la central se evaluaba. Un apóstrofo al principio del valor
 * no protegía los trozos internos.
 */
import { neutralizeCsvCellBoundaries } from "../src/modules/reports/reports.rules";
import { buildCsv } from "../src/modules/reports/reports.service";

/** Modelo del peor caso: la planilla parte por `;` ignorando las comillas, y quita espacios y comillas del inicio de cada celda. */
function celdasConSeparadorPuntoYComa(linea: string): string[] {
  return linea.split(/[;|\t]/).map((celda) => celda.replace(/^[ "]+/, ""));
}
const EMPIEZA_COMO_FORMULA = (celda: string) => /^[=+\-@]/.test(celda);

const ATAQUES_INTERNOS = [
  { nombre: "fórmula entre dos puntos y coma", valor: "Club;=1+1;Z" },
  { nombre: "con espacio antes del separador", valor: "Prueba ;=2*3;x" },
  { nombre: "suma tras el separador", valor: "Ines Prueba;+1+1;x" },
  { nombre: "resta tras el separador", valor: "Juan Prueba;-1+1;x" },
  { nombre: "arroba tras el separador", valor: "Ana;@1+1;x" },
  { nombre: "fórmula al final del valor", valor: "Ana Prueba;=1+1" },
  { nombre: "varios separadores seguidos", valor: "A;;=1+1;;+2" },
  { nombre: "barra vertical como separador", valor: "A|=1+1|B" },
  { nombre: "tabulador interno", valor: "A\t=1+1" },
  { nombre: "espacios tras el separador", valor: "A;   =1+1" },
  { nombre: "comilla tras el separador", valor: 'A;"=1+1;B' },
  { nombre: "salto de línea interno", valor: "A\n=1+1" },
  { nombre: "retorno y salto de línea internos", valor: "A\r\n+1+1" },
  { nombre: "comilla al principio del valor", valor: '"=1+1' },
];

describe("neutralizeCsvCellBoundaries (AUD-V)", () => {
  it("antepone la comilla simple al disparador que sigue a cada límite de celda", () => {
    expect(neutralizeCsvCellBoundaries("Club;=1+1;Z")).toBe("Club;'=1+1;Z");
    expect(neutralizeCsvCellBoundaries("Prueba ;=2*3;x")).toBe("Prueba ;'=2*3;x");
    expect(neutralizeCsvCellBoundaries("A;;=1+1;;+2")).toBe("A;;'=1+1;;'+2");
    expect(neutralizeCsvCellBoundaries("A;   =1+1")).toBe("A;   '=1+1");
    expect(neutralizeCsvCellBoundaries('A;"=1+1;B')).toBe(`A;"'=1+1;B`);
    expect(neutralizeCsvCellBoundaries("A\n=1+1")).toBe("A\n'=1+1");
    expect(neutralizeCsvCellBoundaries('"=1+1')).toBe(`"'=1+1`);
  });

  it("es idempotente y no toca lo que ya está neutralizado", () => {
    for (const { valor } of ATAQUES_INTERNOS) {
      const una = neutralizeCsvCellBoundaries(valor);
      expect(neutralizeCsvCellBoundaries(una)).toBe(una);
    }
    expect(neutralizeCsvCellBoundaries("'=1+1;'=2")).toBe("'=1+1;'=2");
  });

  it("no altera valores legítimos, ni siquiera con los mismos caracteres en otra posición", () => {
    for (const valor of ["Ana-María", "Pérez; Gómez", "A;B", "Juan; Pedro", "x=1", "1;2", "a;b-c", "Club A+B", "Club@Norte", "50m Libre", "O'Higgins;Norte", ""]) {
      expect(neutralizeCsvCellBoundaries(valor), valor).toBe(valor);
    }
  });

  it("la neutralización compartida con XLSX NO cambia: solo mira el principio del valor", () => {
    expect(neutralizeSpreadsheetFormula("Club;=1+1;Z")).toBe("Club;=1+1;Z");
    expect(neutralizeSpreadsheetFormula("=1+1")).toBe("'=1+1");
  });
});

describe("rowsToCsv / escapeCsvValue con separador de lista distinto de la coma (AUD-V)", () => {
  for (const ataque of ATAQUES_INTERNOS) {
    it(`ninguna celda posible empieza como fórmula: ${ataque.nombre}`, () => {
      const csv = rowsToCsv(["Club", "Nombre"], [[ataque.valor, ataque.valor]]);
      for (const linea of csv.split(/\r\n|\n|\r/)) {
        for (const celda of celdasConSeparadorPuntoYComa(linea)) {
          expect(EMPIEZA_COMO_FORMULA(celda), `celda «${celda}» de la línea «${linea}»`).toBe(false);
        }
      }
    });
  }

  it("no cambia la estructura: mismas columnas y mismas comillas que antes para el mismo valor", () => {
    // Un valor con `;` y sin coma, comilla ni salto de línea sigue sin entrecomillarse, y su única diferencia es la comilla simple.
    expect(escapeCsvValue("Club;=1+1;Z")).toBe("Club;'=1+1;Z");
    // Con coma sigue entrecomillado, y el trozo tras `;` también queda neutralizado.
    expect(escapeCsvValue("Club,x;=1+1")).toBe(`"Club,x;'=1+1"`);
    expect(escapeCsvValue('Ana;"=1+1')).toBe(`"Ana;""'=1+1"`);
  });

  it("buildCsv conserva secciones, encabezados y número de columnas con valores hostiles", () => {
    const individual = {
      competencia: "Copa", club: "Club;=1+1;Z", nombreCompleto: "Ana Prueba;=1+1;x", fechaNacimiento: "05-05-1995", categoria: "Todo", prueba: "50m Libre",
      distancia: "50m", estilo: "Libre", genero: "Mixto", fecha: "09-11-2026", jornada: "Mañana", tipoDePrueba: "Individual",
    };
    const relevo = {
      competencia: "Copa", equipoClub: "Club;+1+1;Z", prueba: "50m Libre", categoria: "Relevo", genero: "Mixto", fecha: "09-11-2026", jornada: "Mañana",
      integrante1: "A;=1+1;x", integrante2: "B", integrante3: "C", integrante4: "D",
    };
    const lineas = buildCsv([individual as never], [relevo as never]).split("\r\n");
    expect(lineas[0]).toBe("INDIVIDUALES");
    expect(lineas[3]).toBe("");
    expect(lineas[4]).toBe("RELEVOS");
    expect(lineas[2]!.split(",")).toHaveLength(12);
    expect(lineas[5]!.split(",")).toHaveLength(11);
    expect(lineas[2]).toContain("Club;'=1+1;Z");
    expect(lineas[2]).toContain("Ana Prueba;'=1+1;x");
    expect(lineas[6]).toContain("Club;'+1+1;Z");
    for (const linea of lineas) {
      for (const celda of celdasConSeparadorPuntoYComa(linea)) expect(EMPIEZA_COMO_FORMULA(celda), celda).toBe(false);
    }
  });
});
