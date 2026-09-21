/**
 * Carga masiva de personas por Excel — invocación REAL contra PostgreSQL.
 *
 * Este camino no tenía ninguna cobertura. `persons-bulk-import.rules.test.ts`
 * prueba `mapRowToPersonInput`, que es una función pura y no toca ExcelJS; el
 * inventario de endpoints solo comprueba que la ruta esté documentada. Nadie
 * verificaba la LECTURA de un `.xlsx`, que es justo la mitad del módulo que
 * depende de la biblioteca y, por tanto, la que un cambio de dependencia
 * podría romper en silencio.
 *
 * La plantilla se genera con el servicio real —no con un libro fabricado a
 * mano—, de modo que si el encabezado del contrato y el que el servicio emite
 * se separan, se nota aquí.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser } from "./helpers/seedRbac";
import {
  buildPersonsImportTemplate,
  importPersonsFromExcel,
  PERSONS_IMPORT_SHEET,
  PERSONS_INSTRUCTIONS_SHEET,
} from "../src/modules/persons/persons-bulk-import.service";
import { PERSONS_IMPORT_HEADERS } from "../src/modules/persons/persons-bulk-import.rules";
import { validateRun } from "../src/shared/run.util";
import { ValidationError } from "../src/shared/errors";

/**
 * `xlsx.load` declara su parámetro con una definición de `Buffer` anterior a la
 * de `@types/node` 24, que ahora es genérica (`Buffer<ArrayBufferLike>`). Es el
 * mismo objeto en ejecución; solo las declaraciones difieren. El servicio real
 * resuelve lo mismo con `as any` en `persons-bulk-import.service.ts:62`; aquí se
 * acota al tipo exacto que la firma pide, sin `any`.
 */
type EntradaDeCarga = Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0];
const comoEntradaDeCarga = (b: Buffer): EntradaDeCarga => b as unknown as EntradaDeCarga;

/**
 * El actor apunta a un usuario REAL: cada `createPerson` audita, y con un id
 * inventado la auditoría falla contra la clave foránea de `audit_logs.user_id`
 * sin que se note, porque suprime sus errores.
 */
let ACTOR: { userId: string; ipAddress?: string };

/** RUN válidos de verdad — la prueba lo comprueba antes de usarlos. */
const RUN_UNO = "12.345.678-5";
const RUN_DOS = "11.111.111-1";
const RUN_MAL = "12.345.678-9"; // dígito verificador incorrecto

/** Abre la plantilla real y devuelve el libro cargado. */
async function abrirPlantilla(): Promise<ExcelJS.Workbook> {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(comoEntradaDeCarga(await buildPersonsImportTemplate()));
  return libro;
}

/** Las celdas de una fila, ya sin el hueco 1-indexado que deja exceljs. */
const celdas = (hoja: ExcelJS.Worksheet, fila: number): unknown[] =>
  (hoja.getRow(fila).values as unknown[]).slice(1);

/**
 * Construye el libro que se va a importar PARTIENDO de la plantilla real:
 * toma el encabezado de la hoja `Personas` y escribe sus filas debajo, igual
 * que haría quien descarga la plantilla y escribe sus datos a partir de la
 * fila 2. Ya no hay ejemplo ni notas que borrar: la hoja de datos viene vacía.
 */
async function libroDesdePlantilla(filas: (string | number)[][]): Promise<Buffer> {
  const plantilla = await abrirPlantilla();
  const hojaDatos = plantilla.getWorksheet(PERSONS_IMPORT_SHEET);
  if (!hojaDatos) throw new Error(`la plantilla no trae la hoja «${PERSONS_IMPORT_SHEET}»`);
  const encabezado = celdas(hojaDatos, 1);

  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet(PERSONS_IMPORT_SHEET);
  hoja.addRow(encabezado);
  for (const fila of filas) hoja.addRow(fila);
  return Buffer.from(await libro.xlsx.writeBuffer());
}

const filaValida = (run: string, usuario: string, nombre: string): (string | number)[] => [
  run,
  usuario,
  nombre,
  "Pérez",
  "González",
  "15-03-1990",
  "Masculino",
  `${usuario}@correo.cl`,
  "912345678",
];

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_bulkimport", roleNames: ["admin"] });
  ACTOR = { userId: admin.id };
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("plantilla generada por el servicio real", () => {
  it("los RUN de prueba son válidos de verdad", () => {
    expect(validateRun(RUN_UNO).valid, `${RUN_UNO} debería ser válido`).toBe(true);
    expect(validateRun(RUN_DOS).valid, `${RUN_DOS} debería ser válido`).toBe(true);
    expect(validateRun(RUN_MAL).valid, `${RUN_MAL} debería ser inválido`).toBe(false);
  });

  it("es un .xlsx legible y trae exactamente las hojas `Personas` e `Instrucciones`", async () => {
    const buffer = await buildPersonsImportTemplate();
    expect(buffer.subarray(0, 2).toString("latin1"), "un .xlsx es un ZIP: debe empezar con PK").toBe("PK");

    const libro = await abrirPlantilla();
    expect(libro.worksheets.map((h) => h.name)).toEqual([PERSONS_IMPORT_SHEET, PERSONS_INSTRUCTIONS_SHEET]);
  });

  it("`Personas` tiene el encabezado exacto y NINGUNA fila de datos", async () => {
    const libro = await abrirPlantilla();
    const datos = libro.getWorksheet(PERSONS_IMPORT_SHEET);
    expect(datos, "falta la hoja de datos").toBeDefined();
    if (!datos) return;

    expect(celdas(datos, 1)).toEqual(PERSONS_IMPORT_HEADERS);
    // Solo el encabezado: una plantilla con datos crea personas falsas.
    expect(datos.rowCount, "la hoja de datos trae filas que no debería").toBe(1);
  });

  it("`Instrucciones` conserva el ejemplo y las indicaciones, y se declara no importable", async () => {
    const libro = await abrirPlantilla();
    const guia = libro.getWorksheet(PERSONS_INSTRUCTIONS_SHEET);
    expect(guia, "falta la hoja de instrucciones").toBeDefined();
    if (!guia) return;

    const texto: string[] = [];
    guia.eachRow((fila) => texto.push((fila.values as unknown[]).slice(1).join(" ")));
    const todo = texto.join("\n");

    expect(todo, "no dice que la hoja no se importa").toMatch(/NO la lee ni importa/i);
    expect(todo, "el ejemplo ya no se marca como informativo").toMatch(/informativo, NO se importa/i);
    // El ejemplo sigue estando, para que la plantilla siga enseñando el formato.
    expect(todo).toContain("12.345.678-5");
    expect(todo).toContain("15-03-1990");
    // Y las notas de formato se conservan.
    expect(todo).toMatch(/DD-MM-AAAA/);
    expect(todo).toMatch(/Femenino/);
    expect(todo).toMatch(/columna de roles/i);

    // La instrucción contradictoria que autorizaba dejar el ejemplo ya no existe.
    expect(todo, "sigue autorizando dejar la fila de ejemplo").not.toMatch(/o déjela/i);
  });
});

describe("importPersonsFromExcel — invocación real", () => {
  it("crea las personas de las filas válidas y las deja en la base", async () => {
    const buffer = await libroDesdePlantilla([
      filaValida(RUN_UNO, "jperez", "Juan"),
      filaValida(RUN_DOS, "aperez", "Ana"),
    ]);

    const resumen = await importPersonsFromExcel(buffer, ACTOR);

    expect(resumen.createdCount).toBe(2);
    expect(resumen.errorCount).toBe(0);
    expect(resumen.results.map((r) => r.status)).toEqual(["created", "created"]);

    const personas = await prisma.person.findMany({ orderBy: { username: "asc" } });
    expect(personas.map((p) => p.username)).toEqual(["aperez", "jperez"]);
  });

  it("una fila inválida se reporta y NO deja nada escrito, mientras las válidas sí entran", async () => {
    const buffer = await libroDesdePlantilla([
      filaValida(RUN_UNO, "jperez", "Juan"),
      // Dígito verificador incorrecto: no debe crear persona alguna.
      filaValida(RUN_MAL, "malrun", "Mal"),
      // Fecha imposible y género inexistente en la misma fila.
      [RUN_DOS, "maldato", "Otro", "Pérez", "", "31-02-2000", "Marciano", "", ""],
    ]);

    const resumen = await importPersonsFromExcel(buffer, ACTOR);

    expect(resumen.createdCount).toBe(1);
    expect(resumen.errorCount).toBe(2);
    expect(resumen.results.map((r) => `${r.row}:${r.status}`)).toEqual(["2:created", "3:error", "4:error"]);

    // La fila 4 acumula AMBOS problemas, no se detiene en el primero.
    const fila4 = resumen.results.find((r) => r.row === 4);
    expect(fila4?.errors?.join(" | ")).toMatch(/Fecha de nacimiento inválida/);
    expect(fila4?.errors?.join(" | ")).toMatch(/Género inválido/);

    // El resultado ES parcial entre filas, y eso es lo diseñado: la válida se
    // crea aunque las otras fallen. Lo que se comprueba aquí es que NINGUNA
    // fila rechazada dejó su propia escritura a medias.
    const personas = await prisma.person.findMany();
    expect(personas).toHaveLength(1);
    expect(personas[0]?.username).toBe("jperez");
    // Ninguna de las filas rechazadas dejó rastro por su nombre de usuario.
    expect(await prisma.person.count({ where: { username: { in: ["malrun", "maldato"] } } })).toBe(0);
  });

  it("un RUN repetido dentro del mismo archivo crea uno solo y reporta el otro", async () => {
    const buffer = await libroDesdePlantilla([
      filaValida(RUN_UNO, "primero", "Juan"),
      filaValida(RUN_UNO, "segundo", "Otro"),
    ]);

    const resumen = await importPersonsFromExcel(buffer, ACTOR);

    expect(resumen.createdCount).toBe(1);
    expect(resumen.errorCount).toBe(1);
    expect(resumen.results[1]?.status).toBe("error");

    const personas = await prisma.person.findMany();
    expect(personas, "el duplicado no debe haberse creado").toHaveLength(1);
    expect(personas[0]?.username).toBe("primero");
  });

  it("la columna J en desuso rechaza la fila entera sin escribir nada", async () => {
    const buffer = await libroDesdePlantilla([[...filaValida(RUN_UNO, "conroles", "Juan"), "swimmer"]]);

    const resumen = await importPersonsFromExcel(buffer, ACTOR);

    expect(resumen.createdCount).toBe(0);
    expect(resumen.errorCount).toBe(1);
    expect(resumen.results[0]?.errors?.join(" ")).toMatch(/Columna J en desuso/);
    expect(await prisma.person.count()).toBe(0);
  });

  it("un archivo que no es .xlsx se rechaza con ValidationError y no escribe nada", async () => {
    const basura = Buffer.from("esto no es un libro de Excel", "utf8");

    await expect(importPersonsFromExcel(basura, ACTOR)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.person.count()).toBe(0);
  });

  /**
   * La regresión que motivó el cambio: la plantilla traía la fila de ejemplo en
   * la misma hoja que se importa, y esa fila es válida, así que subirla sin
   * editar creaba a «Juan Pérez González» en la base. Ahora el resultado debe
   * ser exactamente vacío: ni creaciones ni errores.
   */
  it("importar la plantilla SIN editar no hace absolutamente nada", async () => {
    const resumen = await importPersonsFromExcel(await buildPersonsImportTemplate(), ACTOR);

    expect(resumen.totalRows).toBe(0);
    expect(resumen.createdCount).toBe(0);
    expect(resumen.errorCount).toBe(0);
    expect(resumen.results).toEqual([]);
    expect(await prisma.person.count(), "la plantilla sin editar creó personas").toBe(0);
  });

  it("si `Instrucciones` va primera, se sigue eligiendo `Personas` por nombre", async () => {
    // El orden de las hojas lo decide quien guarde el archivo; no puede
    // decidir qué se importa. Con selección por posición, esto procesaría el
    // ejemplo de la hoja de ayuda.
    const libro = new ExcelJS.Workbook();
    const guia = libro.addWorksheet(PERSONS_INSTRUCTIONS_SHEET);
    guia.addRow(PERSONS_IMPORT_HEADERS);
    guia.addRow(filaValida(RUN_DOS, "delaguia", "NoDebe"));

    const datos = libro.addWorksheet(PERSONS_IMPORT_SHEET);
    datos.addRow(PERSONS_IMPORT_HEADERS);
    datos.addRow(filaValida(RUN_UNO, "dedatos", "Sí"));

    const buffer = Buffer.from(await libro.xlsx.writeBuffer());
    const resumen = await importPersonsFromExcel(buffer, ACTOR);

    expect(resumen.createdCount).toBe(1);
    expect(resumen.errorCount).toBe(0);

    const personas = await prisma.person.findMany();
    expect(personas.map((p) => p.username), "se importó la hoja equivocada").toEqual(["dedatos"]);
  });

  it("un archivo ANTIGUO de una sola hoja con otro nombre sigue funcionando", async () => {
    // Respaldo por posición: los archivos anteriores a este cambio traían una
    // hoja única que podía llamarse de cualquier forma.
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet("Hoja1");
    hoja.addRow(PERSONS_IMPORT_HEADERS);
    hoja.addRow(filaValida(RUN_UNO, "antiguo", "Juan"));

    const buffer = Buffer.from(await libro.xlsx.writeBuffer());
    const resumen = await importPersonsFromExcel(buffer, ACTOR);

    expect(resumen.createdCount).toBe(1);
    expect(resumen.errorCount).toBe(0);

    const personas = await prisma.person.findMany();
    expect(personas.map((p) => p.username)).toEqual(["antiguo"]);
  });
});
