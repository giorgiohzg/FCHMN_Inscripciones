/**
 * Fase 4: inspección del ZIP y escaneo del libro, ANTES de ExcelJS. Unitarias y sin base:
 * archivos sintéticos pequeños contra límites reducidos.
 */
import { describe, it, expect, vi } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { inspeccionarArchivo, leerDirectorio } from "../src/modules/persons/xlsx/inspeccion-zip";
import { LIMITES_XLSX, MENSAJE_XLSX_INVALIDO, RechazoXlsx, type LimitesXlsx } from "../src/modules/persons/xlsx/limites";
import { construirZip, libroCrudo, partesDeLibro, hojaXml, type EntradaSintetica } from "./helpers/zipSintetico";


// Una prueba construye una bomba de 512 MiB: solo comprimirla tarda unos 3,7 s en esta máquina (la aserción de 1 s mide la inspección, no esa construcción).
// El límite por omisión (5 s) depende de la velocidad de la máquina; se sigue el criterio de `xlsx-analisis.test.ts` y de las configuraciones de integración (30 s).
// No cambia ninguna expectativa: solo cuánto se espera antes de declarar el fallo.
vi.setConfig({ testTimeout: 30_000 });

const KIB = 1024;
const limites = (cambios: Partial<LimitesXlsx> = {}): LimitesXlsx => ({ ...LIMITES_XLSX, ...cambios });
const inspeccionar = (archivo: Buffer, cambios: Partial<LimitesXlsx> = {}) => inspeccionarArchivo(archivo, limites(cambios));
const rechazo = (archivo: Buffer, cambios: Partial<LimitesXlsx> = {}): string => {
  try {
    inspeccionar(archivo, cambios);
  } catch (err) {
    expect(err).toBeInstanceOf(RechazoXlsx);
    return (err as Error).message;
  }
  throw new Error("el archivo no se rechazó");
};
const parte = (nombre: string, contenido: string | Buffer = "x"): EntradaSintetica => ({ nombre, contenido });

describe("archivo legítimo", () => {
  it("un libro real de ExcelJS, con estilos y dos hojas, pasa con los límites vigentes", async () => {
    const libro = new ExcelJS.Workbook();
    libro.addWorksheet("Personas").addRow(["RUN", "Nombre"]).font = { bold: true };
    libro.addWorksheet("Instrucciones").addRow(["texto"]);
    const archivo = Buffer.from(await libro.xlsx.writeBuffer());
    expect(() => inspeccionar(archivo)).not.toThrow();
  });

  it("los límites vigentes son coherentes entre sí", () => {
    expect(LIMITES_XLSX.entradaMaxBytes).toBeLessThanOrEqual(LIMITES_XLSX.totalMaxBytes);
    expect(LIMITES_XLSX.filasConDatosMax).toBeLessThanOrEqual(LIMITES_XLSX.filasMax);
    expect(LIMITES_XLSX.indiceFilaMax).toBeLessThanOrEqual(1_048_576);
    expect(Object.isFrozen(LIMITES_XLSX)).toBe(true);
  });
});

describe("estructura del ZIP", () => {
  it("cuenta las entradas sin descomprimir", () => {
    const zip = construirZip(Array.from({ length: 5 }, (_, i) => parte(`p${i}`)));
    expect(rechazo(zip, { entradasMax: 4 })).toMatch(/más de 4 partes/);
    expect(leerDirectorio(zip, limites({ entradasMax: 5 }))).toHaveLength(5);
  });

  it("rechaza un archivo mayor que el tope comprimido", () => {
    expect(rechazo(construirZip([parte("a", Buffer.alloc(2 * KIB, 7))]), { comprimidoMaxBytes: 16 })).toMatch(/pesa más de/);
  });

  it.each<[string, () => Buffer]>([
    ["no es un ZIP", () => Buffer.from("esto no es un archivo xlsx, solo texto cualquiera")],
    ["vacío", () => Buffer.alloc(0)],
    ["datos después del fin", () => construirZip([parte("a")], { despues: Buffer.from("resto") })],
    ["datos antes del inicio", () => construirZip([parte("a")], { antes: Buffer.from("resto") })],
    ["otro fin de directorio dentro del comentario", () => construirZip([parte("a")], { comentario: Buffer.from("PK\x05\x06") })],
    ["cuenta de entradas falsa", () => construirZip([parte("a")], { totalEntradas: 2 })],
    ["marca de ZIP64", () => construirZip([parte("a")], { totalEntradas: 0xffff })],
    ["tamaño ZIP64 en la entrada", () => construirZip([{ nombre: "a", contenido: "x", tamDeclarado: 0xffffffff }])],
    ["entrada cifrada", () => construirZip([{ nombre: "a", contenido: "x", bandera: 1 }])],
    ["método de compresión desconocido", () => construirZip([{ nombre: "a", contenido: "x", metodo: 12 }])],
    ["nombres repetidos", () => construirZip([parte("xl/worksheets/sheet1.xml", "<a/>"), parte("xl/worksheets/sheet1.xml", "<b/>")])],
    ["el mismo nombre con barra inicial", () => construirZip([parte("xl/workbook.xml", "<a/>"), parte("/xl/workbook.xml", "<b/>")])],
    ["campo extra de ruta Unicode", () => construirZip([{ nombre: "inocente.bin", contenido: "x", extra: Buffer.from([0x75, 0x70, 0, 0]) }])],
    ["flujo deflate truncado", () => construirZip([{ nombre: "a", contenido: Buffer.alloc(4 * KIB, 7), truncar: 3 }])],
    ["tamaño declarado menor que el real", () => construirZip([{ nombre: "a", contenido: "contenido", tamDeclarado: 1 }])],
    ["tamaño declarado mayor que el real", () => construirZip([{ nombre: "a", contenido: "contenido", tamDeclarado: 900 }])],
  ])("rechaza: %s", (_caso, armar) => {
    expect(rechazo(armar())).toBe(MENSAJE_XLSX_INVALIDO);
  });
});

describe("expansión real, no la declarada", () => {
  const bomba = (bytes: number, tamDeclarado = 1): EntradaSintetica => ({ nombre: "xl/media/a.bin", contenido: Buffer.alloc(bytes), tamDeclarado });

  it("corta una entrada que se expande más de lo permitido aunque declare 1 byte", () => {
    const zip = construirZip([bomba(5 * KIB * KIB)]);
    expect(zip.length).toBeLessThan(16 * KIB); // la gracia de la bomba
    expect(rechazo(zip, { entradaMaxBytes: 64 * KIB })).toMatch(/parte interna.*supera/);
  });

  it("una bomba mucho mayor que el tope no llega a acumularse", () => {
    const zip = construirZip([bomba(512 * KIB * KIB)]);
    const inicio = Date.now();
    expect(rechazo(zip, { entradaMaxBytes: KIB * KIB })).toMatch(/parte interna.*supera/);
    expect(Date.now() - inicio).toBeLessThan(1000); // descomprimir 512 MB enteros no cabe aquí
  });

  it("el total cuenta los bytes reales de todas las entradas", () => {
    const entradas = Array.from({ length: 4 }, (_, i): EntradaSintetica => ({ nombre: `xl/media/${i}.bin`, contenido: Buffer.alloc(40 * KIB) }));
    expect(rechazo(construirZip(entradas), { entradaMaxBytes: 64 * KIB, totalMaxBytes: 100 * KIB })).toMatch(/descomprimido supera/);
    expect(() => inspeccionar(construirZip(entradas), { entradaMaxBytes: 64 * KIB, totalMaxBytes: 160 * KIB })).not.toThrow();
  });

  it("una entrada sin comprimir cuenta igual", () => {
    expect(rechazo(construirZip([{ nombre: "a", contenido: Buffer.alloc(32 * KIB), almacenada: true }]), { entradaMaxBytes: 16 * KIB })).toMatch(/parte interna.*supera/);
  });

  it("dos entradas no pueden apuntar a los mismos datos", () => {
    // La bomba de entradas solapadas: un solo flujo, referido por muchos encabezados.
    const zip = construirZip([{ nombre: "a", contenido: Buffer.alloc(40 * KIB) }, parte("b")]);
    const firma = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const primero = zip.indexOf(firma);
    const segundo = zip.indexOf(firma, primero + 4);
    zip.writeUInt32LE(zip.readUInt32LE(primero + 20), segundo + 20);
    zip.writeUInt32LE(zip.readUInt32LE(primero + 24), segundo + 24);
    zip.writeUInt32LE(0, segundo + 42);
    expect(rechazo(zip)).toBe(MENSAJE_XLSX_INVALIDO); // el nombre local de la segunda ya no es el suyo
  });
});

describe("nombres de las entradas: lo que se inspecciona es lo que ExcelJS lee", () => {
  const dispersa = hojaXml('<row r="1048576"/>');
  const hoja = "xl/worksheets/sheet1.xml";
  const conHoja = (nombre: EntradaSintetica["nombre"], extra: Partial<EntradaSintetica> = {}) => [...partesDeLibro([]), { nombre, contenido: dispersa, ...extra }];

  /** Lo que ve JSZip, el lector real de ExcelJS, antes de que ExcelJS retire la barra inicial. */
  const nombresDeJszip = async (zip: Buffer) => Object.keys((await JSZip.loadAsync(zip)).files);

  it("el nombre local manda en JSZip: una hoja disfrazada en el directorio central se rechaza", async () => {
    const zip = construirZip(conHoja("inocente.bin", { nombreLocal: hoja }));
    expect(await nombresDeJszip(zip)).toContain(hoja); // sin esta comprobación, se escaparía
    expect(rechazo(zip)).toBe(MENSAJE_XLSX_INVALIDO);
  });

  it("también al revés: un nombre central de hoja con otro nombre local", () => {
    expect(rechazo(construirZip(conHoja(hoja, { nombreLocal: "inocente.bin" })))).toBe(MENSAJE_XLSX_INVALIDO);
  });

  it("también si solo difiere un byte o el largo", () => {
    expect(rechazo(construirZip([{ nombre: "abc", contenido: "x", nombreLocal: "abd" }]))).toBe(MENSAJE_XLSX_INVALIDO);
    expect(rechazo(construirZip([{ nombre: "abc", contenido: "x", nombreLocal: "abcd" }]))).toBe(MENSAJE_XLSX_INVALIDO);
  });

  it.each([
    ["a/../" + hoja],
    ["./" + hoja],
    ["xl//worksheets/sheet1.xml"],
    ["xl/./worksheets/sheet1.xml"],
    ["../" + hoja],
    ["//" + hoja],
  ])("JSZip normalizaría %j a la hoja: se rechaza", async (nombre) => {
    const zip = construirZip(conHoja(nombre));
    expect((await nombresDeJszip(zip)).some((n) => n.endsWith(hoja))).toBe(true);
    expect(rechazo(zip)).toBe(MENSAJE_XLSX_INVALIDO);
  });

  it("un nombre que no es UTF-8 válido se rechaza", () => {
    const nombre = Buffer.concat([Buffer.from("xl/worksheets/sheet1."), Buffer.from([0xc1, 0xb8]), Buffer.from("ml")]);
    expect(rechazo(construirZip(conHoja(nombre)))).toBe(MENSAJE_XLSX_INVALIDO);
  });

  it.each([["xl\\workbook.xml"], ["xl/work\u0000book.xml"], ["xl/work\nbook.xml"], ["/"]])("rechaza el nombre %j", (nombre) => {
    expect(rechazo(construirZip([parte(nombre)]))).toBe(MENSAJE_XLSX_INVALIDO);
  });

  it.each([
    ["con y sin barra inicial", "xl/workbook.xml", "/xl/workbook.xml"],
    ["fichero y carpeta del mismo nombre", "a", "a/"],
  ])("rechaza colisiones tras normalizar: %s", (_caso, uno, otro) => {
    expect(rechazo(construirZip([parte(uno, "<a/>"), parte(otro, "")]))).toBe(MENSAJE_XLSX_INVALIDO);
  });

  it("una barra inicial, que ExcelJS retira, sí se inspecciona con su nombre real", async () => {
    const zip = construirZip(conHoja("/" + hoja));
    expect(await nombresDeJszip(zip)).toContain("/" + hoja);
    expect(rechazo(zip)).toMatch(/usa la fila/);
  });

  it("el libro y las cadenas compartidas con barra inicial también se inspeccionan", () => {
    const hojas = Array.from({ length: 3 }, (_, i) => ({ nombre: `H${i}`, xml: hojaXml("") }));
    const libro = partesDeLibro(hojas).map((e) => (e.nombre === "xl/workbook.xml" ? { ...e, nombre: "/xl/workbook.xml" } : e));
    const sinPartes = libro.filter((e) => !String(e.nombre).includes("worksheets/"));
    expect(rechazo(construirZip(sinPartes), { hojasMax: 2 })).toMatch(/más de 2 hojas/);

    const cadenas: EntradaSintetica = { nombre: "/xl/sharedStrings.xml", contenido: `<sst>${"<si><t>a</t></si>".repeat(5)}</sst>` };
    expect(rechazo(construirZip([...partesDeLibro([]), cadenas]), { cadenasCompartidasMax: 4 })).toMatch(/más de 4 textos/);
  });

  it("en un archivo real, cada entrada se llama igual para el inspector y para JSZip", async () => {
    const libro = new ExcelJS.Workbook();
    libro.addWorksheet("Personas").addRow(["RUN"]);
    const zip = Buffer.from(await libro.xlsx.writeBuffer());
    const propios = leerDirectorio(zip, limites()).map((e) => e.nombre);
    expect(propios.sort()).toEqual((await nombresDeJszip(zip)).sort());
  });
});

describe("hojas, filas y dimensiones", () => {
  const filas = (n: number) => Array.from({ length: n }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="n"><v>1</v></c></row>`).join("");

  it("limita las hojas por las partes del ZIP", () => {
    const hojas = Array.from({ length: 3 }, (_, i) => ({ nombre: `H${i}`, xml: hojaXml("") }));
    expect(rechazo(construirZip(partesDeLibro(hojas)), { hojasMax: 2 })).toMatch(/más de 2 hojas/);
  });

  it("limita las hojas por lo que declara el libro, aunque no existan sus partes", () => {
    const declaradas = Array.from({ length: 3 }, (_, i) => ({ nombre: `H${i}`, xml: "" }));
    const zip = construirZip(partesDeLibro(declaradas).filter((e) => !e.nombre.includes("worksheets/")));
    expect(rechazo(zip, { hojasMax: 2 })).toMatch(/más de 2 hojas/);
  });

  it("reconoce una hoja bajo el mismo patrón sin anclar que usa ExcelJS", () => {
    const entradas = partesDeLibro([{ nombre: "Personas", xml: hojaXml(filas(5)) }]).map((e) => (e.nombre.includes("worksheets/") ? { ...e, nombre: `otra/${e.nombre}` } : e));
    expect(rechazo(construirZip(entradas), { filasMax: 4 })).toMatch(/más de 4 filas/);
  });

  it("limita el número de filas, sumando todas las hojas", () => {
    expect(rechazo(libroCrudo(filas(4)), { filasMax: 3 })).toMatch(/más de 3 filas/);
    const dosHojas = construirZip(
      partesDeLibro([
        { nombre: "A", xml: hojaXml(filas(2)) },
        { nombre: "B", xml: hojaXml(filas(2)) },
      ])
    );
    expect(rechazo(dosHojas, { filasMax: 3 })).toMatch(/más de 3 filas/);
  });

  it("una hoja DISPERSA se rechaza por el índice, con una sola fila real", () => {
    expect(rechazo(libroCrudo('<row r="1"/><row r="1048576"><c r="A1048576"><v>1</v></c></row>'))).toMatch(/usa la fila 1\.048\.576/);
  });

  it("una celda fuera de la fila declarada también cuenta para el índice", () => {
    expect(rechazo(libroCrudo('<row><c r="A900000"><v>1</v></c></row>'))).toMatch(/usa la fila 900\.000/);
  });

  it("limita las celdas y su columna", () => {
    const celdas = '<row r="1"><c r="A1"/><c r="B1"/><c r="C1"/></row>';
    expect(rechazo(libroCrudo(celdas), { celdasMax: 2 })).toMatch(/más de 2 celdas/);
    expect(rechazo(libroCrudo('<row r="1"><c r="XFD1"><v>1</v></c></row>'))).toMatch(/columna número 16\.384/);
  });

  it("limita `<col max>`: ExcelJS crea una columna por cada número", () => {
    expect(rechazo(libroCrudo("", "", '<cols><col min="1" max="2147483647" width="9"/></cols>'))).toMatch(/formato de columnas hasta la número 2\.147\.483\.647/);
  });

  it.each([
    ["combinación", '<mergeCells><mergeCell ref="A1:K24000"/></mergeCells>', ""],
    ["validación", '<dataValidations><dataValidation type="list" sqref="A1:K24000"/></dataValidations>', ""],
    ["validación con varios rangos", '<dataValidations><dataValidation sqref="A1:A9 B1:B9000"/></dataValidations>', ""],
    ["nombre definido", "", '<definedNames><definedName name="x">Personas!$A$1:$K$24000</definedName></definedNames>'],
  ])("limita el rango declarado: %s", (_caso, despues, extraLibro) => {
    expect(rechazo(libroCrudo("", despues, "", extraLibro), { areaDeclaradaMax: 1000 })).toMatch(/demasiadas celdas/);
  });

  it("el área se suma entre todas las estructuras", () => {
    const zip = libroCrudo("", '<mergeCells><mergeCell ref="A1:A60"/></mergeCells>', "", '<definedNames><definedName name="x">Personas!$A$1:$A$60</definedName></definedNames>');
    expect(rechazo(zip, { areaDeclaradaMax: 100 })).toMatch(/demasiadas celdas/);
    expect(() => inspeccionar(zip, { areaDeclaradaMax: 120 })).not.toThrow();
  });

  it("limita las cadenas compartidas", () => {
    const entradas = partesDeLibro([{ nombre: "Personas", xml: hojaXml("") }]);
    entradas.push({ nombre: "xl/sharedStrings.xml", contenido: `<sst>${"<si><t>a</t></si>".repeat(5)}</sst>` });
    expect(rechazo(construirZip(entradas), { cadenasCompartidasMax: 4 })).toMatch(/más de 4 textos/);
  });

  it("`<dimension>` exagerada no basta para rechazar: es una declaración, no un recorrido", () => {
    expect(() => inspeccionar(libroCrudo(filas(2), "", '<dimension ref="A1:XFD1048576"/>'))).not.toThrow();
  });
});

describe("coordenadas de los rangos: el área pequeña no basta", () => {
  const estrechos = { indiceFilaMax: 10, columnaMax: 11 };
  const combinar = (ref: string) => libroCrudo("", `<mergeCells><mergeCell ref="${ref}"/></mergeCells>`);
  const validar = (sqref: string) => libroCrudo("", `<dataValidations><dataValidation sqref="${sqref}"/></dataValidations>`);
  const nombrar = (texto: string) => libroCrudo("", "", "", `<definedNames><definedName name="x">${texto}</definedName></definedNames>`);

  it.each([
    ["combinación de una celda, por fila", () => combinar("A11:A11"), /usa la fila 11/],
    ["combinación de una celda, por columna", () => combinar("L1:L1"), /columna número 12/],
    ["combinación con solo el extremo final fuera", () => combinar("A10:A11"), /usa la fila 11/],
    ["combinación con solo el extremo inicial fuera", () => combinar("L1:K1"), /columna número 12/],
    ["validación de una celda suelta", () => validar("A11"), /usa la fila 11/],
    ["validación con el segundo rango fuera", () => validar("A1:A2 L1"), /columna número 12/],
    ["nombre de una celda", () => nombrar("Personas!$A$11"), /usa la fila 11/],
    ["nombre con el extremo final fuera", () => nombrar("Personas!$A$1:$L$1"), /columna número 12/],
    ["nombre con hoja entre comillas", () => nombrar("'Mi Hoja'!$A$11"), /usa la fila 11/],
    ["nombre con la comilla como entidad", () => nombrar("&apos;Mi Hoja&apos;!$A$11"), /usa la fila 11/],
    ["nombre con varios rangos", () => nombrar("Personas!$A$1,Personas!$A$11"), /usa la fila 11/],
  ])("rechaza: %s", (_caso, armar, mensaje) => {
    expect(rechazo(armar(), estrechos)).toMatch(mensaje);
  });

  it.each([
    ["combinación en el borde", () => combinar("A1:K10")],
    ["validación en el borde", () => validar("K10 A1:B2")],
    ["nombre en el borde", () => nombrar("Personas!$A$1:$K$10")],
    ["nombre de una celda", () => nombrar("Personas!$K$10")],
    ["hoja que parece una referencia", () => nombrar("ZZ99!$A$1")],
    ["hoja entre comillas con coma", () => nombrar("'A,ZZ99'!$A$1")],
    ["títulos de impresión, que ExcelJS no registra", () => nombrar("Personas!$1:$3")],
    ["sin dólares, que ExcelJS no registra", () => nombrar("Personas!A1:ZZ99999")],
    ["referencia rota", () => nombrar("#REF!")],
  ])("admite: %s", (_caso, armar) => {
    expect(() => inspeccionar(armar(), estrechos)).not.toThrow();
  });

  it("una comilla sin cerrar en un nombre definido no se puede medir", () => {
    expect(rechazo(nombrar("'Personas!$A$1"))).toBe(MENSAJE_XLSX_INVALIDO);
  });

  it("no acepta la fila cero, ni en una celda ni en un rango", () => {
    expect(rechazo(combinar("A0:A1"))).toBe(MENSAJE_XLSX_INVALIDO);
    expect(rechazo(nombrar("Personas!$A$0"))).toBe(MENSAJE_XLSX_INVALIDO);
    expect(rechazo(libroCrudo('<row r="0"/>'))).toBe(MENSAJE_XLSX_INVALIDO);
  });

  it("`<col min>` también cuenta: ExcelJS rellena hasta él aunque `max` sea menor", () => {
    expect(rechazo(libroCrudo("", "", '<cols><col min="2147483647" max="1" width="9"/></cols>'))).toMatch(/formato de columnas/);
  });

  it("un comentario o un CDATA no parten un nombre definido", () => {
    expect(rechazo(nombrar("Personas!$A$1<![CDATA[:$XFD$1048576]]>"))).toBe(MENSAJE_XLSX_INVALIDO);
    expect(rechazo(nombrar("Personas!$A$1<!-- x -->:$XFD$1048576"))).toBe(MENSAJE_XLSX_INVALIDO);
  });
});

describe("formato de columnas `<col>`: tope propio, aparte del de celdas y referencias", () => {
  const cols = (min: number, max: number) => libroCrudo("", "", `<cols><col min="${min}" max="${max}" width="18" style="4"/></cols>`);
  const estrechos = { columnaMax: 11, columnasDeFormatoMax: 30 };

  it("acepta el formato de la hoja entera con los límites de producción", () => {
    expect(() => inspeccionar(cols(1, 16_384))).not.toThrow();
    expect(LIMITES_XLSX.columnaMax).toBe(1_024); // el de celdas no subió
    expect(LIMITES_XLSX.columnasDeFormatoMax).toBe(16_384);
  });

  it("admite declarar más columnas que el tope de celdas, pero no más que el de formato", () => {
    expect(() => inspeccionar(cols(1, 30), estrechos)).not.toThrow();
    expect(rechazo(cols(1, 31), estrechos)).toMatch(/formato de columnas hasta la número 31, y el máximo es la 30/);
  });

  it("rechaza por `max` y por `min` por encima de 16.384", () => {
    expect(rechazo(cols(1, 16_385))).toMatch(/hasta la número 16\.385/);
    expect(rechazo(cols(16_385, 16_385))).toMatch(/hasta la número 16\.385/);
    expect(rechazo(cols(16_385, 1))).toMatch(/hasta la número 16\.385/);
  });

  it("sigue rechazando celdas y referencias por encima de 1.024", () => {
    const celda = '<row r="1"><c r="AMK1"><v>1</v></c></row>'; // AMK = 1.025
    expect(rechazo(libroCrudo(celda))).toMatch(/usa la columna número 1\.025, y el máximo es la 1\.024/);
    expect(rechazo(libroCrudo("", '<mergeCells><mergeCell ref="A1:AMK1"/></mergeCells>'))).toMatch(/columna número 1\.025/);
    expect(rechazo(libroCrudo("", '<dataValidations><dataValidation sqref="AMK1"/></dataValidations>'))).toMatch(/columna número 1\.025/);
    expect(rechazo(libroCrudo("", "", "", '<definedNames><definedName name="x">Personas!$AMK$1</definedName></definedNames>'))).toMatch(/columna número 1\.025/);
  });

  it("la hoja entera con formato no abre la puerta a celdas más allá de 1.024", () => {
    const zip = libroCrudo('<row r="1"><c r="AMK1"><v>1</v></c></row>', "", '<cols><col min="1" max="16384" width="18"/></cols>');
    expect(rechazo(zip)).toMatch(/usa la columna número 1\.025/);
  });
});

describe("el recorrido de etiquetas ve lo mismo que un analizador XML", () => {
  it("no cuenta lo que está en comentarios o CDATA", () => {
    const relleno = `<!-- <row r="999999"/> --><row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[<row r="999999"/>]]></t></is></c></row>`;
    expect(() => inspeccionar(libroCrudo(relleno))).not.toThrow();
  });

  it("no se deja engañar por `>` dentro de un atributo ni por comillas simples", () => {
    expect(rechazo(libroCrudo(`<row spans="1>2" r='1048576'/>`))).toMatch(/usa la fila/);
  });

  it("con espacios alrededor del igual también lo ve", () => {
    expect(rechazo(libroCrudo(`<row r = "1048576"/>`))).toMatch(/usa la fila/);
  });

  it("rechaza lo que no puede medir", () => {
    expect(rechazo(libroCrudo('<row r="&#49;048576"/>'))).toBe(MENSAJE_XLSX_INVALIDO);
    expect(rechazo(libroCrudo("", '<mergeCells><mergeCell ref="A1&#58;XFD1048576"/></mergeCells>'))).toBe(MENSAJE_XLSX_INVALIDO);
    expect(rechazo(libroCrudo("", '<mergeCells><mergeCell ref="A:A"/></mergeCells>'))).toBe(MENSAJE_XLSX_INVALIDO);
    expect(rechazo(libroCrudo("", "", "", '<definedNames><definedName name="x">Personas!$A$1&#58;$XFD$1048576</definedName></definedNames>'))).toBe(MENSAJE_XLSX_INVALIDO);
  });

  it("rechaza DOCTYPE y UTF-16", () => {
    const conDtd = construirZip(partesDeLibro([{ nombre: "P", xml: '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY b "c">]><worksheet/>' }]));
    expect(rechazo(conDtd)).toBe(MENSAJE_XLSX_INVALIDO);
    const utf16 = construirZip(partesDeLibro([{ nombre: "P", xml: "x" }]).map((e) => (e.nombre.includes("worksheets/") ? { ...e, contenido: Buffer.from("﻿<worksheet/>", "utf16le") } : e)));
    expect(rechazo(utf16)).toBe(MENSAJE_XLSX_INVALIDO);
  });

  it("rechaza etiquetas sin cerrar", () => {
    expect(rechazo(libroCrudo('<row r="1'))).toBe(MENSAJE_XLSX_INVALIDO);
    expect(rechazo(libroCrudo("<!-- sin fin"))).toBe(MENSAJE_XLSX_INVALIDO);
  });
});
