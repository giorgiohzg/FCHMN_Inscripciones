/**
 * Hallazgo 16 — lectura defensiva de archivos .zip subidos por usuarios.
 *
 * El único ZIP que procesa el sistema es el "Meet Events" de Hy-Tek, pero se
 * recibe por HTTP desde el navegador de un administrador: hay que tratarlo
 * como entrada no confiable.
 */
import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { crc32 } from "node:zlib";
import { readSingleEntryFromZip, isSafeEntryName, DEFAULT_ZIP_LIMITS } from "../src/shared/safeZip";
import { ValidationError } from "../src/shared/errors";

function zipCon(entradas: { nombre: string; contenido: Buffer | string }[]): Buffer {
  const zip = new AdmZip();
  for (const e of entradas) {
    zip.addFile(e.nombre, Buffer.isBuffer(e.contenido) ? e.contenido : Buffer.from(e.contenido, "latin1"));
  }
  return zip.toBuffer();
}

/**
 * Construye un .zip mínimo (una entrada, sin comprimir) con el nombre EXACTO
 * que se le indique, sin pasar por la normalización de AdmZip.
 */
function zipHostilConNombre(nombre: string, contenido: string): Buffer {
  const nameBuf = Buffer.from(nombre, "utf8");
  const data = Buffer.from(contenido, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // firma de cabecera local
  local.writeUInt16LE(20, 4); // versión necesaria
  local.writeUInt16LE(0, 6); // banderas
  local.writeUInt16LE(0, 8); // método: 0 = almacenado
  local.writeUInt16LE(0, 10); // hora
  local.writeUInt16LE(0, 12); // fecha
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); // tamaño comprimido
  local.writeUInt32LE(data.length, 22); // tamaño sin comprimir
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra

  const localCompleto = Buffer.concat([local, nameBuf, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // firma de directorio central
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42); // desplazamiento de la cabecera local

  const centralCompleto = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // fin del directorio central
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); // entradas en este disco
  eocd.writeUInt16LE(1, 10); // entradas totales
  eocd.writeUInt32LE(centralCompleto.length, 12);
  eocd.writeUInt32LE(localCompleto.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localCompleto, centralCompleto, eocd]);
}

const OPCIONES = {
  allowedExtensions: [".ev3"],
  encoding: "latin1" as const,
  notFoundMessage: "No hay .ev3 en el archivo",
};

describe("isSafeEntryName", () => {
  it("acepta rutas relativas normales", () => {
    expect(isSafeEntryName("archivo.ev3")).toBe(true);
    expect(isSafeEntryName("carpeta/archivo.ev3")).toBe(true);
  });

  it("RECHAZA path traversal", () => {
    expect(isSafeEntryName("../fuera.ev3")).toBe(false);
    expect(isSafeEntryName("a/../../b.ev3")).toBe(false);
    expect(isSafeEntryName("..\\fuera.ev3")).toBe(false);
  });

  it("RECHAZA rutas absolutas y unidades de Windows", () => {
    expect(isSafeEntryName("/etc/passwd")).toBe(false);
    expect(isSafeEntryName("C:\\Windows\\system32\\x.ev3")).toBe(false);
  });

  it("RECHAZA nombres vacíos, larguísimos o con caracteres de control", () => {
    expect(isSafeEntryName("")).toBe(false);
    expect(isSafeEntryName("a".repeat(300))).toBe(false);
    expect(isSafeEntryName("archivo\u0000.ev3")).toBe(false);
  });
});

describe("readSingleEntryFromZip", () => {
  it("lee la entrada buscada en un ZIP normal", () => {
    const buffer = zipCon([
      { nombre: "otro.txt", contenido: "irrelevante" },
      { nombre: "programa.ev3", contenido: "contenido del programa" },
    ]);

    const { entryName, content } = readSingleEntryFromZip(buffer, OPCIONES);
    expect(entryName).toBe("programa.ev3");
    expect(content).toBe("contenido del programa");
  });

  it("conserva la codificación Latin-1 de los archivos Hy-Tek", () => {
    const buffer = zipCon([{ nombre: "p.ev3", contenido: Buffer.from([0x4d, 0x75, 0xf1, 0x6f, 0x7a]) }]); // "Muñoz"
    expect(readSingleEntryFromZip(buffer, OPCIONES).content).toBe("Muñoz");
  });

  it("da un mensaje claro si no está la entrada buscada", () => {
    const buffer = zipCon([{ nombre: "otro.txt", contenido: "x" }]);
    expect(() => readSingleEntryFromZip(buffer, OPCIONES)).toThrow(/No hay .ev3/);
  });

  it("RECHAZA un archivo que no es un ZIP", () => {
    expect(() => readSingleEntryFromZip(Buffer.from("esto no es un zip"), OPCIONES)).toThrow(ValidationError);
  });

  /**
   * El ZIP se construye byte a byte, no con AdmZip: su API normaliza los
   * nombres al escribir (`../../escape.ev3` se guarda como `escape.ev3`), así
   * que con ella es imposible producir el archivo hostil que este guard
   * existe para rechazar. Un atacante no usa la API: arma los bytes.
   */
  it("RECHAZA un ZIP con una ruta de path traversal construido a mano", () => {
    const buffer = zipHostilConNombre("../../escape.ev3", "x");
    expect(() => readSingleEntryFromZip(buffer, OPCIONES)).toThrow(/ruta interna no permitida/i);
  });

  it("RECHAZA un ZIP con una ruta absoluta construido a mano", () => {
    const buffer = zipHostilConNombre("/etc/cron.d/backdoor.ev3", "x");
    expect(() => readSingleEntryFromZip(buffer, OPCIONES)).toThrow(/ruta interna no permitida/i);
  });

  it("RECHAZA un ZIP con demasiadas entradas", () => {
    const entradas = Array.from({ length: 20 }, (_, i) => ({ nombre: `f${i}.txt`, contenido: "x" }));
    expect(() => readSingleEntryFromZip(zipCon(entradas), { ...OPCIONES, limits: { maxEntries: 5 } })).toThrow(/entradas/i);
  });

  it("RECHAZA un .zip más grande que el máximo admitido", () => {
    const buffer = zipCon([{ nombre: "p.ev3", contenido: "x".repeat(5000) }]);
    expect(() => readSingleEntryFromZip(buffer, { ...OPCIONES, limits: { maxCompressedBytes: 100 } })).toThrow(/pesa/i);
  });

  /**
   * Zip bomb: un archivo de texto muy repetitivo comprime muchísimo. Con los
   * límites por defecto pasa sin problema; con un tope de tasa bajo, el
   * detector lo ataja antes de descomprimir.
   */
  it("RECHAZA una tasa de compresión anómala (zip bomb)", () => {
    const buffer = zipCon([{ nombre: "p.ev3", contenido: "A".repeat(2_000_000) }]);
    expect(() => readSingleEntryFromZip(buffer, { ...OPCIONES, limits: { maxCompressionRatio: 5 } })).toThrow(/tasa de compresión anómala/i);
  });

  it("RECHAZA una entrada que descomprimida supera el máximo", () => {
    const buffer = zipCon([{ nombre: "p.ev3", contenido: "A".repeat(500_000) }]);
    expect(() =>
      readSingleEntryFromZip(buffer, { ...OPCIONES, limits: { maxEntryUncompressedBytes: 1000, maxCompressionRatio: 100_000 } })
    ).toThrow(/al descomprimirse|supera el máximo/i);
  });

  it("RECHAZA cuando el total descomprimido supera el máximo", () => {
    const entradas = Array.from({ length: 5 }, (_, i) => ({ nombre: `f${i}.txt`, contenido: "A".repeat(100_000) }));
    expect(() =>
      readSingleEntryFromZip(zipCon(entradas), {
        ...OPCIONES,
        limits: { maxTotalUncompressedBytes: 150_000, maxCompressionRatio: 100_000, maxEntryUncompressedBytes: 1_000_000 },
      })
    ).toThrow(/total descomprimido/i);
  });

  it("los límites por defecto admiten un archivo Hy-Tek real sin problema", () => {
    const contenidoRealista = "1;1;F;1;I;W;0;109;200;A;0;;;N;0;;;;;;;1;1;1;09:45AM;S;4;3;1;0*>\r\n".repeat(500);
    const buffer = zipCon([{ nombre: "Meet Events-Copa.ev3", contenido: contenidoRealista }]);

    expect(buffer.length).toBeLessThan(DEFAULT_ZIP_LIMITS.maxCompressedBytes);
    expect(readSingleEntryFromZip(buffer, OPCIONES).content).toContain("09:45AM");
  });
});
