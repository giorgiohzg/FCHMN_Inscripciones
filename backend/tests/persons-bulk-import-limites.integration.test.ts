/**
 * Fase 4: límites de la carga masiva, por HTTP real y contra la base desechable.
 *
 * Las subidas retenidas van por un socket de verdad: `app.inject` entrega el cuerpo de
 * una vez y no puede simular un envío a medias. Los archivos son sintéticos y los límites
 * se reducen aquí, en una copia: el análisis recibe por parámetro los que usa la ruta.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import ExcelJS from "exceljs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/shared/prisma.client";
import { buildServer } from "../src/server";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, TEST_PASSWORD } from "./helpers/seedRbac";
import { importPersonsFromExcel, buildPersonsImportTemplate, PERSONS_IMPORT_SHEET } from "../src/modules/persons/persons-bulk-import.service";
import { LIMITES_XLSX, type LimitesXlsx } from "../src/modules/persons/xlsx/limites";
import { tomarTurnoDeCarga } from "../src/modules/persons/xlsx/turno-de-carga";
import { ValidationError } from "../src/shared/errors";
import { construirZip, libroCrudo, partesDeLibro, hojaXml } from "./helpers/zipSintetico";

/** Hace que el proceso de análisis no se pueda crear, como lo haría Node: `error` y `close`, sin `exit`. */
const creacion = vi.hoisted(() => ({ falla: false }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const fork = (...argumentos: Parameters<typeof original.fork>) => {
    if (!creacion.falla) return original.fork(...argumentos);
    const falso = Object.assign(new EventEmitter(), { pid: undefined, send: () => true });
    process.nextTick(() => {
      falso.emit("error", new Error("spawn ENOENT C:/ruta/interna"));
      falso.emit("close", -4058, null);
    });
    return falso as unknown as ReturnType<typeof original.fork>;
  };
  return { ...original, fork, default: { ...original, fork } };
});

vi.mock("../src/modules/persons/xlsx/limites", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/modules/persons/xlsx/limites")>();
  return { ...original, LIMITES_XLSX: { ...original.LIMITES_XLSX, plazoSubidaMs: 2000, comprimidoMaxBytes: 256 * 1024 } };
});

type App = Awaited<ReturnType<typeof buildServer>>;

const LIMITE_MULTIPART = "----limitePruebaFase4";
const inicioDeParte = Buffer.from(
  `--${LIMITE_MULTIPART}\r\nContent-Disposition: form-data; name="file"; filename="carga.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`
);
const finDeParte = Buffer.from(`\r\n--${LIMITE_MULTIPART}--\r\n`);
const multipart = (archivo: Buffer) => Buffer.concat([inicioDeParte, archivo, finDeParte]);

const RUN_UNO = "12.345.678-5";
const RUN_DOS = "11.111.111-1";
const fila = (run: string, usuario: string) => [run, usuario, "Ana", "Pérez", "González", "15-03-1990", "Femenino", `${usuario}@correo.cl`, "912345678"];

let app: App;
let puerto: number;
let token: string;
let ADMIN: { id: string };
let plantilla: unknown[];

async function libroDeFilas(filas: (string | number)[][]): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet(PERSONS_IMPORT_SHEET);
  hoja.addRow(plantilla);
  for (const f of filas) hoja.addRow(f);
  return Buffer.from(await libro.xlsx.writeBuffer());
}

const subir = (archivo: Buffer) =>
  app.inject({
    method: "POST",
    url: "/persons/bulk-import",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${LIMITE_MULTIPART}` },
    payload: multipart(archivo),
  });

interface SubidaRetenida {
  solicitud: http.ClientRequest;
  respuesta: Promise<{ estado: number; cuerpo: string }>;
  cerrada: Promise<void>;
}

/** Una subida por un socket real que queda a medias: manda `parte` y no termina. */
function subidaRetenida(parte: Buffer): SubidaRetenida {
  const solicitud = http.request({
    port: puerto,
    method: "POST",
    path: "/persons/bulk-import",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${LIMITE_MULTIPART}`, "transfer-encoding": "chunked" },
  });
  const cerrada = new Promise<void>((resolve) => solicitud.once("close", () => resolve()));
  const respuesta = new Promise<{ estado: number; cuerpo: string }>((resolve, reject) => {
    solicitud.once("error", reject);
    solicitud.once("response", (r) => {
      let cuerpo = "";
      r.on("data", (d) => (cuerpo += d));
      r.on("end", () => resolve({ estado: r.statusCode!, cuerpo }));
    });
  });
  respuesta.catch(() => undefined); // las pruebas que cortan la subida no esperan respuesta
  solicitud.write(parte);
  return { solicitud, respuesta, cerrada };
}

/** ¿Hay una carga activa? Tomar y soltar el turno es síncrono: no interfiere con nadie. */
function turnoOcupado(): boolean {
  const liberar = tomarTurnoDeCarga();
  liberar?.();
  return liberar === null;
}

const esperarTurno = (ocupado: boolean) => vi.waitFor(() => expect(turnoOcupado()).toBe(ocupado), { timeout: 8000, interval: 10 });

const conteos = async () => ({ personas: await prisma.person.count(), membresias: await prisma.clubSwimmer.count(), auditoria: await prisma.auditLog.count() });

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const usuario = await createUser({ username: "admin_fase4", roleNames: ["admin"] });
  ADMIN = { id: usuario.id };

  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load((await buildPersonsImportTemplate()) as unknown as ArrayBuffer);
  plantilla = (libro.getWorksheet(PERSONS_IMPORT_SHEET)!.getRow(1).values as unknown[]).slice(1);

  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  puerto = (app.server.address() as AddressInfo).port;
  token = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin_fase4", password: TEST_PASSWORD } })).json().accessToken;
});

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.person.deleteMany();
});

afterAll(async () => {
  await app?.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("archivo legítimo por HTTP", () => {
  it("crea las personas y conserva el resultado por fila, con el analizador en su proceso", async () => {
    const res = await subir(await libroDeFilas([fila(RUN_UNO, "ana_uno"), ["no-es-run", "ana_mala"], fila(RUN_DOS, "ana_dos"), fila(RUN_UNO, "ana_rep")]));
    expect(res.statusCode).toBe(200);
    const resumen = res.json();
    expect(resumen).toMatchObject({ totalRows: 4, createdCount: 2, errorCount: 2 });
    expect(resumen.results.map((r: { row: number; status: string }) => [r.row, r.status])).toEqual([
      [2, "created"],
      [3, "error"],
      [4, "created"],
      [5, "error"],
    ]);
    expect(resumen.results[3].errors.join(" ")).toMatch(/RUN repetido dentro del archivo: ya aparece en la fila 2/);
    expect(await prisma.person.count()).toBe(2);
  });

  it("la plantilla sin editar no crea a nadie", async () => {
    const res = await subir(await buildPersonsImportTemplate());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totalRows: 0, createdCount: 0 });
  });
});

describe("un rechazo del análisis no escribe nada", () => {
  const FILA_VALIDA = `<row r="2"><c r="A2" t="inlineStr"><is><t>${RUN_UNO}</t></is></c></row>`;
  const casos: [string, () => Buffer, RegExp][] = [
    ["archivo dañado", () => Buffer.from("no es un xlsx"), /no es un Excel/],
    ["bomba de expansión", () => construirZip([...partesDeLibro([{ nombre: "Personas", xml: hojaXml(FILA_VALIDA) }]), { nombre: "xl/media/b.bin", contenido: Buffer.alloc(40 * 1024 * 1024), tamDeclarado: 10 }]), /descomprim/],
    ["demasiadas entradas", () => construirZip(Array.from({ length: 200 }, (_, i) => ({ nombre: `p${i}`, contenido: "x" }))), /partes internas/],
    ["hoja dispersa", () => libroCrudo(`${FILA_VALIDA}<row r="1048576"/>`), /usa la fila/],
    ["combinación desmedida", () => libroCrudo(FILA_VALIDA, '<mergeCells><mergeCell ref="A1:Z24000"/></mergeCells>'), /demasiadas celdas/],
    ["combinación pequeña fuera de los índices", () => libroCrudo(FILA_VALIDA, '<mergeCells><mergeCell ref="A900000:A900001"/></mergeCells>'), /usa la fila/],
    ["nombre de hoja disfrazado en el directorio central", () => construirZip(partesDeLibro([{ nombre: "Personas", xml: hojaXml(FILA_VALIDA) }]).map((e) => (e.nombre === "xl/worksheets/sheet1.xml" ? { ...e, nombre: "inocente.bin", nombreLocal: e.nombre } : e))), /no es un Excel/],
    ["estructura incompatible", () => libroCrudo('<row r="2"><c r="A2"><v>1</c></row>'), /no es un Excel/],
  ];

  it.each(casos)("%s", async (_caso, armar, mensaje) => {
    const antes = await conteos();
    const res = await subir(armar());
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION_ERROR");
    expect(res.json().message).toMatch(mensaje);
    expect(await conteos()).toEqual(antes);
  });

  it("filas fuera de límite: ninguna se escribe, tampoco las primeras", async () => {
    const limites: LimitesXlsx = { ...LIMITES_XLSX, filasConDatosMax: 1 };
    const archivo = await libroDeFilas([fila(RUN_UNO, "ana_uno"), fila(RUN_DOS, "ana_dos")]);
    const antes = await conteos();
    await expect(importPersonsFromExcel(archivo, { userId: ADMIN.id }, { limites })).rejects.toBeInstanceOf(ValidationError);
    expect(await conteos()).toEqual(antes);
  });

  it("un archivo que supera el tope de subida se corta y libera el turno", async () => {
    const res = await subir(Buffer.alloc(300 * 1024, 1));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/pesa más de 0.25 MB/);
    expect((await subir(await libroDeFilas([fila(RUN_UNO, "ana_uno")]))).statusCode).toBe(200);
  });
});

describe("plazo del análisis", () => {
  it("cancela un análisis colgado mientras la API responde, y no escribe nada", async () => {
    const hostil = libroCrudo("", '<dataValidations count="1"><dataValidation type="list" sqref="A1:XFD1048576"/></dataValidations>');
    const limites: LimitesXlsx = { ...LIMITES_XLSX, areaDeclaradaMax: Number.MAX_SAFE_INTEGER, indiceFilaMax: 1_048_576, columnaMax: 16_384, plazoAnalisisMs: 4000, monticuloAnalisisMb: 2048 };
    const antes = await conteos();

    const analisis = importPersonsFromExcel(hostil, { userId: ADMIN.id }, { limites }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 1500));

    // A media cancelación, la API responde por el socket real.
    const inicio = Date.now();
    const salud = await fetch(`http://127.0.0.1:${puerto}/health`);
    expect(salud.status).toBe(200);
    expect(Date.now() - inicio).toBeLessThan(1000);

    const error = await analisis;
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toMatch(/tiempo máximo/);
    expect(await conteos()).toEqual(antes);
  });
});

describe("una sola carga activa", () => {
  it("rechaza una segunda carga con 409 y la libera cuando termina la primera", async () => {
    const [primero, segundo] = await Promise.all([libroDeFilas([fila(RUN_UNO, "ana_uno")]), libroDeFilas([fila(RUN_DOS, "ana_dos")])]);
    const primera = subir(primero!).then((r) => r);
    await esperarTurno(true);

    const rechazada = await subir(segundo!);
    expect(rechazada.statusCode).toBe(409);
    expect(rechazada.json()).toMatchObject({ error: "CONFLICT" });
    expect(rechazada.json().message).toMatch(/carga masiva en curso/);

    expect((await primera).statusCode).toBe(200);
    expect(await prisma.person.count()).toBe(1);
    expect(turnoOcupado()).toBe(false);
    expect((await subir(segundo!)).statusCode).toBe(200);
  });

  it("mientras la primera aún se recibe, la segunda se rechaza sin esperarla, aunque llegue por socket", async () => {
    const primera = subidaRetenida(inicioDeParte);
    await esperarTurno(true);

    const inicio = Date.now();
    const segunda = subidaRetenida(multipart(Buffer.alloc(64 * 1024, 2)));
    segunda.solicitud.end();
    const { estado } = await segunda.respuesta;
    expect(estado).toBe(409);
    expect(Date.now() - inicio).toBeLessThan(1000);

    primera.solicitud.destroy();
    await primera.cerrada;
    await esperarTurno(false);
  });

  it("si el proceso de análisis no se puede crear, la solicitud termina y la carga siguiente funciona", async () => {
    const archivo = await libroDeFilas([fila(RUN_UNO, "ana_uno")]);
    const antes = await conteos();

    creacion.falla = true;
    const fallida = await subir(archivo).finally(() => {
      creacion.falla = false;
    });
    expect(fallida.statusCode).toBe(500);
    expect(fallida.json()).toEqual({ error: "INTERNAL_ERROR", message: "Error interno del servidor" });
    expect(await conteos()).toEqual(antes);

    expect(turnoOcupado()).toBe(false);
    expect((await subir(archivo)).statusCode).toBe(200);
  });

  it("libera el turno tras un rechazo del archivo", async () => {
    expect((await subir(Buffer.from("no es un xlsx"))).statusCode).toBe(400);
    expect((await subir(await libroDeFilas([fila(RUN_UNO, "ana_uno")]))).statusCode).toBe(200);
  });

  it("libera el turno si quien sube corta la conexión", async () => {
    const corte = subidaRetenida(inicioDeParte);
    await esperarTurno(true);
    corte.solicitud.destroy();
    await corte.cerrada;
    await esperarTurno(false);
  });

  it("una subida detenida pierde el turno al vencer su plazo", async () => {
    const detenida = subidaRetenida(inicioDeParte);
    await esperarTurno(true);
    await detenida.cerrada; // la cierra el servidor: `plazoSubidaMs` son 2 s en esta suite
    await esperarTurno(false);
  });
});
