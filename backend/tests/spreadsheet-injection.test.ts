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
