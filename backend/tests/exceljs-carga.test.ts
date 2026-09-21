/**
 * Carga de ExcelJS tras fijar `unzipper@0.12.5`.
 *
 * `exceljs/lib/exceljs.nodejs.js` construye su objeto exportado con
 * `require('./stream/xlsx/workbook-reader')` en el propio literal, y ese
 * archivo hace `require('unzipper')` en su cabecera. La carga es EAGER: basta
 * `import ExcelJS from "exceljs"` para que unzipper y toda su cadena queden
 * evaluadas en memoria. Por eso un `override` incompatible no se manifestaría
 * al usar la biblioteca, sino al importarla — y esta es la prueba que lo
 * atraparía.
 *
 * La comprobación de `require.cache` se hace en un PROCESO NODE APARTE, no
 * dentro de Vitest: el ejecutor de Vitest tiene su propio grafo de módulos y
 * su caché no representa lo que ocurre cuando `dist/server.js` arranca en la
 * imagen. Un subproceso limpio es exactamente la condición de producción.
 */
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const BACKEND = join(__dirname, "..");

interface Sonda {
  error: string | null;
  cargados: string[];
  versionUnzipper: string | null;
  totalModulos: number;
}

/**
 * Sonda ejecutada en un Node limpio: importa ExcelJS y devuelve qué paquetes
 * quedaron evaluados. No imprime nada más que el JSON del resultado.
 */
function sondar(): Sonda {
  const guion = `
    const path = require("path");
    const fs = require("fs");
    const salida = { error: null, cargados: [], versionUnzipper: null, totalModulos: 0 };
    try {
      require("exceljs");
    } catch (e) {
      salida.error = e && e.message ? e.message : String(e);
    }
    const nombres = new Set();
    for (const ruta of Object.keys(require.cache)) {
      const partes = ruta.split(/[\\\\/]/);
      for (let i = partes.length - 2; i >= 0; i--) {
        if (partes[i] === "node_modules") { nombres.add(partes[i + 1]); break; }
      }
    }
    salida.cargados = [...nombres].sort();
    salida.totalModulos = Object.keys(require.cache).length;
    const deUnzipper = Object.keys(require.cache).filter((r) => /[\\\\/]unzipper[\\\\/]/.test(r))[0];
    if (deUnzipper) {
      const corte = deUnzipper.toLowerCase().indexOf("unzipper") + "unzipper".length;
      try {
        salida.versionUnzipper = JSON.parse(fs.readFileSync(path.join(deUnzipper.slice(0, corte), "package.json"), "utf8")).version;
      } catch { /* queda en null */ }
    }
    process.stdout.write(JSON.stringify(salida));
  `;
  const bruto = execFileSync(process.execPath, ["-e", guion], { cwd: BACKEND, encoding: "utf8" });
  return JSON.parse(bruto) as Sonda;
}

describe("ExcelJS carga correctamente con unzipper 0.12.5", () => {
  it("el módulo se importa y expone lo que el proyecto usa", () => {
    expect(ExcelJS).toBeDefined();
    expect(ExcelJS.Workbook).toBeTypeOf("function");
    // El lector de streaming es lo único de exceljs que toca unzipper.
    expect(ExcelJS.stream?.xlsx?.WorkbookReader, "WorkbookReader no está disponible").toBeTypeOf("function");
    expect(ExcelJS.stream?.xlsx?.WorkbookWriter).toBeTypeOf("function");
  });

  it("se puede construir un libro y un lector de streaming sin lanzar", () => {
    expect(() => new ExcelJS.Workbook()).not.toThrow();
    // El constructor exige `options`; se pasa vacío a propósito.
    expect(() => new ExcelJS.stream.xlsx.WorkbookReader("", {})).not.toThrow();
  });

  it("en un Node limpio, `require(\"exceljs\")` no lanza", () => {
    const sonda = sondar();
    expect(sonda.error, "importar exceljs lanzó una excepción").toBeNull();
    expect(sonda.totalModulos).toBeGreaterThan(100);
  });

  it("en un Node limpio, unzipper queda cargado y resuelto a 0.12.5", () => {
    const sonda = sondar();
    expect(sonda.cargados).toContain("unzipper");
    expect(sonda.versionUnzipper).toBe("0.12.5");
  });

  it("en un Node limpio, `binary`, `buffers` y `chainsaw` NO se evalúan", () => {
    const sonda = sondar();
    // Antes del cambio los tres quedaban en memoria con un simple import.
    expect(sonda.cargados).not.toContain("binary");
    expect(sonda.cargados).not.toContain("buffers");
    expect(sonda.cargados).not.toContain("chainsaw");
  });
});
