/**
 * Compatibilidad de `unzipper` con el uso que ExcelJS hace de él.
 *
 * POR QUÉ ESTA PRUEBA EXISTE
 *
 * `exceljs/lib/stream/xlsx/workbook-reader.js` carga `unzipper` en su cabecera
 * y usa exactamente una API: `unzipper.Parse({forceStream: true})`. Esa carga
 * es EAGER —el módulo se construye en el literal exportado de
 * `exceljs.nodejs.js`—, así que basta `import ExcelJS` para arrastrarla. Como
 * el proyecto fija `unzipper` en `0.12.5` mediante un `override` acotado a
 * `exceljs`, hace falta una prueba que ejercite esa API de verdad.
 *
 * POR QUÉ NO SE PRUEBA `WorkbookReader`
 *
 * `WorkbookReader` NO SE USA EN PRODUCCIÓN: los dos caminos reales son
 * `workbook.xlsx.writeBuffer()` (escritura) y `workbook.xlsx.load()` (lectura),
 * y este último va por JSZip, no por unzipper. Además, `WorkbookReader` está
 * roto de forma independiente a esta dependencia: falla con
 * «Cannot read properties of undefined (reading 'sheets')» porque el propio
 * escritor de ExcelJS emite `xl/workbook.xml` como ÚLTIMA entrada del ZIP y el
 * lector desreferencia `this.model` sin guarda. Se comprobó que falla igual con
 * `unzipper@0.10.14` y con `0.12.5`, de modo que no es una regresión del
 * cambio. Ver el issue oficial:
 *
 *   https://github.com/exceljs/exceljs/issues/3064
 *
 * Queda registrado como deuda lateral no bloqueante. Esta prueba cubre
 * únicamente la compatibilidad de la API de unzipper que ExcelJS carga, que es
 * lo que el `override` puede romper y lo que sí se puede comprobar.
 */
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Una entrada del ZIP tal como la entrega `unzipper.Parse`. */
interface EntradaZip extends AsyncIterable<Buffer> {
  path: string;
  type: string;
}

interface ApiUnzipper {
  Parse(opciones: { forceStream: boolean }): NodeJS.WritableStream & AsyncIterable<EntradaZip>;
}

/**
 * Se resuelve `unzipper` DESDE el módulo de ExcelJS que lo requiere, no desde
 * esta prueba: así se carga la misma instancia que usaría la aplicación, aunque
 * algún día quedara anidada bajo `exceljs/node_modules`.
 */
const requerir = createRequire(__filename);
const RUTA_LECTOR = requerir.resolve("exceljs/lib/stream/xlsx/workbook-reader.js");
const RUTA_UNZIPPER = requerir.resolve("unzipper", { paths: [dirname(RUTA_LECTOR)] });
const DIR_UNZIPPER = dirname(RUTA_UNZIPPER);
const unzipper = requerir(RUTA_UNZIPPER) as ApiUnzipper;

const ENTRADAS_EXIGIDAS = [
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels",
  "xl/sharedStrings.xml",
  "xl/worksheets/sheet1.xml",
] as const;

const TEXTO_UNICO = "Ñandú-Öhman-12345678";

/** Un .xlsx real, generado por el mismo ExcelJS que usa el producto. */
async function xlsxReal(): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet("Datos");
  hoja.addRow(["RUN", "Nombre", "Metros"]);
  hoja.addRow(["12.345.678-5", TEXTO_UNICO, 50]);
  return Buffer.from(await libro.xlsx.writeBuffer());
}

/**
 * Recorre el ZIP con la API de unzipper y CONSUME CADA ENTRADA POR COMPLETO,
 * iterándola. No se usan eventos ni `autodrain()`: con `forceStream: true` la
 * vía correcta es la iteración, y drenar una entrada sin leerla dejaría sin
 * comprobar justamente lo que interesa, que es su contenido.
 */
async function leerZip(entrada: Readable): Promise<{ orden: string[]; contenido: Map<string, Buffer> }> {
  const zip = unzipper.Parse({ forceStream: true });
  entrada.pipe(zip);

  const orden: string[] = [];
  const contenido = new Map<string, Buffer>();
  for await (const elemento of zip) {
    const trozos: Buffer[] = [];
    for await (const trozo of elemento) trozos.push(trozo);
    orden.push(elemento.path);
    contenido.set(elemento.path, Buffer.concat(trozos));
  }
  return { orden, contenido };
}

function comprobarEntradas(leido: { orden: string[]; contenido: Map<string, Buffer> }): void {
  // El ZIP se recorrió entero, no a medias.
  expect(leido.orden.length, "unzipper no entregó ninguna entrada").toBeGreaterThan(10);
  expect(new Set(leido.orden).size, "hay entradas repetidas").toBe(leido.orden.length);

  for (const exigida of ENTRADAS_EXIGIDAS) {
    expect(leido.orden, `falta la entrada ${exigida}`).toContain(exigida);
    const bytes = leido.contenido.get(exigida);
    expect(bytes, `${exigida} no se leyó`).toBeDefined();
    expect(bytes?.length, `${exigida} llegó vacía`).toBeGreaterThan(0);
  }

  // Contenido real, no solo bytes: si el descomprimido fuese basura, esto cae.
  expect(leido.contenido.get("xl/workbook.xml")?.toString("utf8")).toMatch(/<sheet[ >]/);
  expect(leido.contenido.get("xl/_rels/workbook.xml.rels")?.toString("utf8")).toMatch(/<Relationship[ >]/);
  expect(leido.contenido.get("xl/sharedStrings.xml")?.toString("utf8")).toContain(TEXTO_UNICO);
  expect(leido.contenido.get("xl/worksheets/sheet1.xml")?.toString("utf8")).toMatch(/<row[ >]/);
}

describe("unzipper es el que ExcelJS resuelve, y es 0.12.5", () => {
  it("se resuelve desde el módulo de ExcelJS que lo requiere", () => {
    expect(RUTA_UNZIPPER).toMatch(/[\\/]unzipper[\\/]/);
  });

  it("la versión instalada es exactamente 0.12.5", () => {
    const manifiesto = JSON.parse(readFileSync(join(DIR_UNZIPPER, "package.json"), "utf8")) as {
      version: string;
      license: string;
    };
    expect(manifiesto.version).toBe("0.12.5");
    expect(manifiesto.license).toBe("MIT");
  });

  it("expone la única API que ExcelJS usa", () => {
    expect(unzipper.Parse).toBeTypeOf("function");
  });
});

describe("unzipper.Parse recorre un .xlsx generado por ExcelJS", () => {
  it("desde un flujo en memoria (`Readable.from`)", async () => {
    const buffer = await xlsxReal();
    comprobarEntradas(await leerZip(Readable.from([buffer])));
  });

  it("desde `createReadStream` sobre un archivo temporal", async () => {
    const buffer = await xlsxReal();
    const carpeta = mkdtempSync(join(tmpdir(), "fchmn-unzipper-"));
    const ruta = join(carpeta, "libro.xlsx");
    try {
      writeFileSync(ruta, buffer);
      comprobarEntradas(await leerZip(createReadStream(ruta)));
    } finally {
      rmSync(carpeta, { recursive: true, force: true });
    }
  });

  it("ambas entradas entregan el mismo conjunto y el mismo orden", async () => {
    const buffer = await xlsxReal();
    const carpeta = mkdtempSync(join(tmpdir(), "fchmn-unzipper-"));
    const ruta = join(carpeta, "libro.xlsx");
    try {
      writeFileSync(ruta, buffer);
      const porMemoria = await leerZip(Readable.from([buffer]));
      const porArchivo = await leerZip(createReadStream(ruta));

      expect(porArchivo.orden, "el orden de entradas difiere según la entrada").toEqual(porMemoria.orden);
      for (const exigida of ENTRADAS_EXIGIDAS) {
        expect(porArchivo.contenido.get(exigida)).toEqual(porMemoria.contenido.get(exigida));
      }
    } finally {
      rmSync(carpeta, { recursive: true, force: true });
    }
  });

  /**
   * Deja constancia del orden que rompe a `WorkbookReader`: ExcelJS escribe
   * `xl/workbook.xml` DESPUÉS de las hojas. Si algún día ExcelJS lo corrigiera,
   * esta prueba fallará y será la señal para revisar la deuda lateral.
   */
  it("ExcelJS emite `xl/workbook.xml` después de la hoja — origen del defecto conocido", async () => {
    const { orden } = await leerZip(Readable.from([await xlsxReal()]));
    const posicionHoja = orden.indexOf("xl/worksheets/sheet1.xml");
    const posicionLibro = orden.indexOf("xl/workbook.xml");
    expect(posicionHoja).toBeGreaterThanOrEqual(0);
    expect(posicionLibro).toBeGreaterThanOrEqual(0);
    expect(posicionLibro, "ExcelJS cambió el orden: revisar exceljs/exceljs#3064").toBeGreaterThan(posicionHoja);
  });
});
