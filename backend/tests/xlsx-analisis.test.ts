/**
 * Fase 4: análisis del libro, con ExcelJS real, dentro y fuera de su proceso.
 * Sin base de datos. Las pruebas de `analizarXlsxAislado` lanzan un proceso de verdad.
 */
import { describe, it, expect, vi } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { analizarLibro } from "../src/modules/persons/xlsx/analizador";
import { analizarXlsxAislado } from "../src/modules/persons/xlsx/analisis-aislado";
import { LIMITES_XLSX, MENSAJE_XLSX_INVALIDO, type LimitesXlsx } from "../src/modules/persons/xlsx/limites";
import { tomarTurnoDeCarga } from "../src/modules/persons/xlsx/turno-de-carga";
import { ValidationError } from "../src/shared/errors";
import { libroCrudo } from "./helpers/zipSintetico";

/** Los procesos reales que se lanzan, para comprobar que murieron, y los dos interruptores. */
const lanzados = vi.hoisted(() => [] as unknown[]);
const interruptores = vi.hoisted(() => ({ omitirInspeccion: false, falloDeCreacion: null as null | { conClose: boolean } }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const fork = (...argumentos: Parameters<typeof original.fork>) => {
    const fallo = interruptores.falloDeCreacion;
    if (fallo) {
      // Lo que hace Node si el ejecutable no se puede lanzar (observado de verdad): sin PID,
      // `error` y `close`, nunca `exit`; y `kill` lanza EINVAL en Windows.
      const falso = Object.assign(new EventEmitter(), {
        pid: undefined,
        kill: vi.fn(() => {
          throw new Error("kill EINVAL");
        }),
        send: (_mensaje: unknown, alTerminar: (err: Error) => void) => process.nextTick(alTerminar, new Error("EPIPE")),
      });
      process.nextTick(() => {
        falso.emit("error", new Error("spawn ENOENT C:/ruta/interna"));
        if (fallo.conClose) falso.emit("close", -4058, null);
      });
      lanzados.push(falso);
      return falso as unknown as ReturnType<typeof original.fork>;
    }
    const hijo = original.fork(...argumentos);
    lanzados.push(hijo);
    return hijo;
  };
  return { ...original, fork, default: { ...original, fork } };
});

vi.mock("../src/modules/persons/xlsx/inspeccion-zip", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/modules/persons/xlsx/inspeccion-zip")>();
  return { ...original, inspeccionarArchivo: (...a: Parameters<typeof original.inspeccionarArchivo>) => (interruptores.omitirInspeccion ? undefined : original.inspeccionarArchivo(...a)) };
});

// Cada análisis arranca un proceso con `tsx`: con todas las suites en paralelo tarda segundos.
vi.setConfig({ testTimeout: 30_000 });

const limites = (cambios: Partial<LimitesXlsx> = {}): LimitesXlsx => ({ ...LIMITES_XLSX, ...cambios });
const escribir = async (libro: ExcelJS.Workbook) => Buffer.from(await libro.xlsx.writeBuffer());
const hojaConFilas = async (filas: unknown[][], nombre = "Personas") => {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet(nombre);
  hoja.addRow(["RUN"]);
  for (const f of filas) hoja.addRow(f);
  return escribir(libro);
};

/** Una validación que ExcelJS recorre celda por celda: horas de trabajo síncrono. */
const BUCLE_DE_EXCELJS = '<dataValidations count="1"><dataValidation type="list" sqref="A1:XFD1048576"/></dataValidations>';
const sinLimiteDeArea = { areaDeclaradaMax: Number.MAX_SAFE_INTEGER, indiceFilaMax: 1_048_576, columnaMax: 16_384, columnasDeFormatoMax: 16_384 };

describe("analizarLibro: compatibilidad", () => {
  it("elige `Personas` por nombre, aunque no sea la primera hoja", async () => {
    const libro = new ExcelJS.Workbook();
    libro.addWorksheet("Instrucciones").addRow(["no leer"]);
    libro.addWorksheet("Personas").addRow(["RUN"]);
    const { encabezado } = await analizarLibro(await escribir(libro), limites());
    expect(encabezado[0]).toBe("RUN");
  });

  it("sin hoja `Personas` usa la primera, como los archivos anteriores", async () => {
    const { encabezado } = await analizarLibro(await hojaConFilas([], "Hoja1"), limites());
    expect(encabezado[0]).toBe("RUN");
  });

  it("conserva el número real de fila y omite las vacías", async () => {
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet("Personas");
    hoja.getCell("A1").value = "RUN";
    hoja.getCell("A5").value = "dato";
    hoja.getCell("B7").value = "   ";
    const { filas } = await analizarLibro(await escribir(libro), limites());
    expect(filas.map((f) => f.row)).toEqual([5]);
  });

  it("lee doce celdas por fila: A-K y la de control", async () => {
    const { filas } = await analizarLibro(await hojaConFilas([Array.from({ length: 14 }, (_, i) => `v${i}`)]), limites());
    expect(filas[0]!.valores).toHaveLength(12);
    expect(filas[0]!.valores[11]).toBe("v11");
  });

  it("una celda combinada entrega el valor de la principal", async () => {
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet("Personas");
    hoja.addRow(["RUN"]);
    hoja.addRow(["uno", "dos"]);
    hoja.addRow(["tres", "cuatro"]);
    hoja.mergeCells("A2:A3");
    const { filas } = await analizarLibro(await escribir(libro), limites());
    expect(filas[1]!.valores[0]).toBe("uno");
  });

  it("rechaza un archivo que ExcelJS no puede leer, sin filtrar su error", async () => {
    await expect(analizarLibro(libroCrudo('<row r="1"><c r="A1"><v>1</c></row>'), limites())).rejects.toThrow(MENSAJE_XLSX_INVALIDO);
  });
});

describe("analizarLibro: formato de la hoja entera", () => {
  it("un libro con `<col min=1 max=16384>` pasa y conserva valores y fechas", async () => {
    const fecha = new Date(Date.UTC(2026, 4, 10));
    const archivo = await hojaConFilas([["10000004-0", "Edicion", fecha, 42]]);
    // Se le añade el formato de hoja entera que escribe Excel, sobre un libro real.
    const zip = await JSZip.loadAsync(archivo);
    const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    const con = xml.includes("<cols>") ? xml.replace(/<cols>.*?<\/cols>/s, '<cols><col min="1" max="16384" width="18.7109375" style="0"/></cols>') : xml.replace("<sheetData>", '<cols><col min="1" max="16384" width="18.7109375" style="0"/></cols><sheetData>');
    expect(con).toContain('max="16384"');
    zip.file("xl/worksheets/sheet1.xml", con);
    const { filas } = await analizarLibro(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })), limites());
    expect(filas[0]!.valores.slice(0, 4)).toEqual(["10000004-0", "Edicion", fecha, 42]);
  });
});

describe("analizarLibro: límites sobre lo leído", () => {
  it("limita las filas con datos", async () => {
    await expect(analizarLibro(await hojaConFilas([["a"], ["b"], ["c"]]), limites({ filasConDatosMax: 2 }))).rejects.toThrow(/más de 2 personas/);
  });

  it("limita los caracteres de una celda", async () => {
    await expect(analizarLibro(await hojaConFilas([["x".repeat(600)]]), limites({ caracteresPorCeldaMax: 500 }))).rejects.toThrow(/fila 2 .*más de 500 caracteres/);
  });

  it("limita el total: una cadena compartida se repite gratis en el archivo", async () => {
    const texto = "x".repeat(400);
    await expect(analizarLibro(await hojaConFilas(Array.from({ length: 40 }, () => [texto, texto])), limites({ caracteresTotalesMax: 8000 }))).rejects.toThrow(/demasiado texto/);
  });
});

describe("analizarLibro: dimensiones efectivas tras cargar", () => {
  // Con la inspección apagada: es la defensa para cuando el escaneo y ExcelJS divergieran.
  const sinInspeccion = async <T>(accion: () => Promise<T>) => {
    interruptores.omitirInspeccion = true;
    try {
      return await accion();
    } finally {
      interruptores.omitirInspeccion = false;
    }
  };

  it("rechaza una fila efectiva fuera del índice antes de recorrer", async () => {
    const archivo = libroCrudo('<row r="1"/><row r="30"><c r="A30"><v>1</v></c></row>');
    await expect(sinInspeccion(() => analizarLibro(archivo, limites({ indiceFilaMax: 10 })))).rejects.toThrow(/supera las dimensiones/);
  });

  it("rechaza una columna efectiva fuera del límite", async () => {
    const archivo = libroCrudo('<row r="1"><c r="Z1"><v>1</v></c></row>');
    await expect(sinInspeccion(() => analizarLibro(archivo, limites({ columnaMax: 5 })))).rejects.toThrow(/supera las dimensiones/);
  });

  it("rechaza más hojas efectivas de las permitidas", async () => {
    const libro = new ExcelJS.Workbook();
    libro.addWorksheet("Personas");
    libro.addWorksheet("Otra");
    const archivo = await escribir(libro);
    await expect(sinInspeccion(() => analizarLibro(archivo, limites({ hojasMax: 1 })))).rejects.toThrow(/más de 1 hojas/);
  });

  it("mira todas las hojas, no solo la que se importa", async () => {
    const libro = new ExcelJS.Workbook();
    libro.addWorksheet("Personas").addRow(["RUN"]);
    libro.addWorksheet("Otra").getCell("A30").value = "x";
    const archivo = await escribir(libro);
    await expect(sinInspeccion(() => analizarLibro(archivo, limites({ indiceFilaMax: 10 })))).rejects.toThrow(/«Otra» supera/);
  });

  it("admite lo que está justo en el límite", async () => {
    const archivo = await hojaConFilas([["a"], ["b"]]);
    await expect(sinInspeccion(() => analizarLibro(archivo, limites({ indiceFilaMax: 3, columnaMax: 1 })))).resolves.toMatchObject({ filas: [{ row: 2 }, { row: 3 }] });
  });
});

describe("analizarXlsxAislado: el proceso no pudo crearse", () => {
  const conFallo = async <T>(conClose: boolean, accion: () => Promise<T>) => {
    interruptores.falloDeCreacion = { conClose };
    try {
      return await accion();
    } finally {
      interruptores.falloDeCreacion = null;
    }
  };

  it.each([
    ["`error` y `close`, sin `exit`", true],
    ["solo `error`", false],
  ])("con %s termina, sin esperar a un proceso que no existe", async (_caso, conClose) => {
    const error = await conFallo(conClose, () => analizarXlsxAislado(Buffer.from("x")).catch((e: unknown) => e));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ValidationError); // es un fallo del sistema, no del archivo
    expect((error as Error).message).not.toContain("C:/ruta/interna");

    const falso = lanzados.at(-1) as { kill: ReturnType<typeof vi.fn> };
    expect(falso.kill).not.toHaveBeenCalled();

    // Y lo siguiente funciona: no quedó nada retenido.
    await expect(analizarXlsxAislado(await hojaConFilas([["a"]]))).resolves.toMatchObject({ filas: [{ row: 2 }] });
  });
});

describe("analizarXlsxAislado: proceso real", () => {
  it("devuelve las celdas con sus tipos: fecha, texto enriquecido, hipervínculo y fórmula", async () => {
    const fecha = new Date(Date.UTC(2026, 2, 1));
    const buffer = await hojaConFilas([["1-9", { text: "enlace", hyperlink: "https://ejemplo.cl" }, fecha, { richText: [{ text: "ri" }, { text: "co" }] }, { formula: "1+1", result: 2 }, 42]]);
    const { filas } = await analizarXlsxAislado(buffer);
    const [run, enlace, dia, rico, formula, numero] = filas[0]!.valores;
    expect(run).toBe("1-9");
    expect(enlace).toMatchObject({ text: "enlace" });
    expect(dia).toBeInstanceOf(Date); // la regla de la fecha depende de `instanceof Date`
    expect((dia as Date).toISOString()).toBe(fecha.toISOString());
    expect(rico).toMatchObject({ richText: [{ text: "ri" }, { text: "co" }] });
    expect(formula).toMatchObject({ result: 2 });
    expect(numero).toBe(42);
  });

  it("no modifica el buffer de quien llama", async () => {
    const buffer = await hojaConFilas([["a"]]);
    const antes = Buffer.from(buffer);
    await analizarXlsxAislado(buffer);
    expect(buffer.equals(antes)).toBe(true);
  });

  it("un rechazo llega como ValidationError con su mensaje", async () => {
    const error = await analizarXlsxAislado(Buffer.from("no es un zip, ni de lejos, aunque sea largo")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe(MENSAJE_XLSX_INVALIDO);
  });

  it("MATA un bucle síncrono al vencer el plazo, y el proceso principal sigue respondiendo", async () => {
    const hostil = libroCrudo("", BUCLE_DE_EXCELJS);
    let vueltas = 0;
    const latido = setInterval(() => vueltas++, 20);
    const inicio = Date.now();
    const error = await analizarXlsxAislado(hostil, limites({ ...sinLimiteDeArea, plazoAnalisisMs: 6000, monticuloAnalisisMb: 2048 })).catch((e: unknown) => e);
    const duracion = Date.now() - inicio;
    clearInterval(latido);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toMatch(/tiempo máximo/);
    expect(duracion).toBeGreaterThanOrEqual(5900);
    expect(duracion).toBeLessThan(10_000); // la promesa espera a que el hijo termine de verdad
    expect(vueltas).toBeGreaterThan(100);

    // Matado, no abandonado: cuando la promesa se rechaza, el proceso ya no existe.
    const hijo = lanzados.at(-1) as ChildProcess;
    expect(hijo.signalCode ?? hijo.exitCode).not.toBeNull();
    expect(hijo.killed).toBe(true);

    // Y el recurso quedó libre: el siguiente análisis funciona.
    await expect(analizarXlsxAislado(await hojaConFilas([["a"]]))).resolves.toMatchObject({ filas: [{ row: 2 }] });
  }, 30_000);

  it("un análisis sin montón se rechaza sin arrastrar al proceso principal", async () => {
    const hostil = libroCrudo("", BUCLE_DE_EXCELJS);
    const error = await analizarXlsxAislado(hostil, limites({ ...sinLimiteDeArea, monticuloAnalisisMb: 32, plazoAnalisisMs: 25_000 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toMatch(/demasiada memoria/);
  }, 40_000);

  it("el escaneo rechaza ese mismo archivo al instante con los límites vigentes", async () => {
    await expect(analizarXlsxAislado(libroCrudo("", BUCLE_DE_EXCELJS))).rejects.toThrow(/usa la columna número 16\.384/);
  });
});

describe("aislamiento del analizador", () => {
  const CARPETA = resolve(__dirname, "../src/modules/persons/xlsx");

  /** Todo lo que el proceso de análisis alcanza por imports relativos, y qué paquetes pide. */
  function grafo(archivo: string, vistos = new Map<string, string[]>()): Map<string, string[]> {
    if (vistos.has(archivo)) return vistos;
    const texto = readFileSync(archivo, "utf8");
    // `import type` desaparece al compilar: no carga nada.
    const imports = [...texto.matchAll(/^import (?!type )[\s\S]*?from "([^"]+)";$/gm)].map((m) => m[1]!);
    vistos.set(
      archivo,
      imports.filter((i) => !i.startsWith("."))
    );
    for (const i of imports.filter((x) => x.startsWith("."))) grafo(`${join(dirname(archivo), i)}.ts`, vistos);
    return vistos;
  }

  it("el analizador no alcanza Prisma, el entorno ni nada de `shared`", () => {
    const alcanzados = grafo(join(CARPETA, "analizador.proceso.ts"));
    const archivos = [...alcanzados.keys()].map((a) => a.replace(/\\/g, "/"));
    expect(archivos.length).toBeGreaterThanOrEqual(5);
    expect(archivos.every((a) => a.includes("/modules/persons/xlsx/"))).toBe(true);
    expect(archivos.some((a) => a.endsWith("analisis-aislado.ts"))).toBe(false);
    const paquetes = new Set([...alcanzados.values()].flat());
    expect([...paquetes].sort()).toEqual(["exceljs", "node:zlib"]);
  });

  it("el proceso se crea con el entorno vacío, sin salida estándar y con el montón acotado", () => {
    const texto = readFileSync(join(CARPETA, "analisis-aislado.ts"), "utf8");
    expect(texto).toContain("execArgv: [], env: {}"); // el camino de producción
    expect(texto).toContain("--max-old-space-size=${limites.monticuloAnalisisMb}");
    expect(texto).toContain('stdio: ["ignore", "ignore", "ignore", "ipc"]');
    expect(texto).toContain('hijo.kill("SIGKILL")');
  });
});

describe("turno de carga", () => {
  it("solo hay uno, y liberarlo dos veces no suelta el siguiente", () => {
    const primero = tomarTurnoDeCarga();
    expect(primero).toBeTypeOf("function");
    expect(tomarTurnoDeCarga()).toBeNull();
    primero!();
    const segundo = tomarTurnoDeCarga();
    expect(segundo).toBeTypeOf("function");
    primero!();
    expect(tomarTurnoDeCarga()).toBeNull();
    segundo!();
  });
});
