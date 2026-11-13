/**
 * Fase 2 — filtrado de excepciones internas en los tres lugares donde un fallo se anotaba por
 * fila o por etapa y se devolvía al navegador:
 *
 *   - carga masiva de personas (`persons-bulk-import.service`),
 *   - asignación masiva de nadadores (`assignment.service`),
 *   - importación de competencias (`meet-import.service` y sus analizadores).
 *
 * Contra los servicios reales y la base desechable. Los fallos inesperados se INYECTAN en
 * `$transaction` o en el analizador, con textos sintéticos que parecen lo que no debe salir:
 * una consulta SQL, un parámetro, una ruta del servidor y una credencial inventada.
 *
 * Se conserva todo lo previsto: mensajes de validación, conflictos de dominio, el
 * procesamiento parcial por fila y la atomicidad de cada fila.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, createClub, createPerson, addActiveMembership } from "./helpers/seedRbac";
import { buildPersonsImportTemplate, importPersonsFromExcel, PERSONS_IMPORT_SHEET } from "../src/modules/persons/persons-bulk-import.service";
import { bulkAssignSwimmers } from "../src/modules/swimmer-assignment/assignment.service";
import { analizarArchivoDeImportacion, importCompetitionFromMeetEventsZip } from "../src/modules/meet-import/meet-import.service";
import { MENSAJE_FILA_INTERNA } from "../src/shared/errorPublicable";
import { ValidationError } from "../src/shared/errors";

/** Interruptor del analizador falso: se enciende por prueba. */
const analizador = vi.hoisted(() => ({ fallar: null as null | (() => never) }));

vi.mock("../src/modules/meet-import/ev3-parser", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/modules/meet-import/ev3-parser")>();
  return {
    ...original,
    parseEv3File: (contenido: string) => {
      if (analizador.fallar) analizador.fallar();
      return original.parseEv3File(contenido);
    },
  };
});

/** Lo que NO debe aparecer jamás en una respuesta ni en un registro. */
const SECRETOS = ["INSERT INTO", "hunter2", "/srv/app/dist", "prisma.person.create", "ZZZ_SECRETO", "Cannot read properties"];
const sinSecretos = (texto: string) => {
  for (const s of SECRETOS) expect(texto, `no debe contener «${s}»`).not.toContain(s);
};

const ERROR_DE_PRISMA_CRUDO = () =>
  new Error(
    'Invalid `prisma.person.create()` invocation in /srv/app/dist/persons.js:88:12\n\n' +
      'INSERT INTO "public"."persons" (run, password) VALUES (\'11111111-1\', \'hunter2\')'
  );

const RUN_UNO = "12.345.678-5";
const RUN_DOS = "11.111.111-1";

let ADMIN: { id: string };
let lineasDeRegistro: string[];

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  ADMIN = await createUser({ username: "admin_filtrado", roleNames: ["admin"] });
  analizador.fallar = null;
  lineasDeRegistro = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lineasDeRegistro.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

/** Falla la N-ésima llamada a `prisma.$transaction` con el error dado y deja pasar las demás. */
function fallarTransaccion(numero: number, error: () => unknown) {
  const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>;
  let llamadas = 0;
  vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) => {
    llamadas++;
    if (llamadas === numero) return Promise.reject(error());
    return original(...args);
  }) as never);
}

/** Eventos estructurados que el filtrado dejó en el registro interno. */
const eventosDeFallo = () =>
  lineasDeRegistro
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null && e.event === "fila_fallo_inesperado");

// ---------------------------------------------------------------------------
// Carga masiva de personas
// ---------------------------------------------------------------------------

async function libroDeFilas(filas: (string | number)[][]): Promise<Buffer> {
  const plantilla = new ExcelJS.Workbook();
  await plantilla.xlsx.load((await buildPersonsImportTemplate()) as unknown as ArrayBuffer);
  const encabezado = (plantilla.getWorksheet(PERSONS_IMPORT_SHEET)!.getRow(1).values as unknown[]).slice(1);

  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet(PERSONS_IMPORT_SHEET);
  hoja.addRow(encabezado);
  for (const f of filas) hoja.addRow(f);
  return Buffer.from(await libro.xlsx.writeBuffer());
}

const fila = (run: string, usuario: string): (string | number)[] => [run, usuario, "Ana", "Pérez", "González", "15-03-1990", "Femenino", `${usuario}@correo.cl`, "912345678"];

describe("carga masiva de personas", () => {
  it("un fallo inesperado de una fila no publica la consulta, los valores ni las rutas; las demás filas siguen", async () => {
    fallarTransaccion(1, ERROR_DE_PRISMA_CRUDO);
    const resumen = await importPersonsFromExcel(await libroDeFilas([fila(RUN_DOS, "ana_dos"), fila(RUN_UNO, "ana_uno")]), { userId: ADMIN.id });

    expect(resumen.results[0]).toEqual({ row: 2, status: "error", errors: [MENSAJE_FILA_INTERNA] });
    expect(resumen.results[1]).toMatchObject({ row: 3, status: "created" });
    expect(resumen).toMatchObject({ totalRows: 2, createdCount: 1, errorCount: 1 });
    sinSecretos(JSON.stringify(resumen));

    // Atomicidad: la fila que falló no dejó nada; la siguiente sí se creó.
    expect(await prisma.person.count({ where: { username: "ana_dos" } })).toBe(0);
    expect(await prisma.person.count({ where: { username: "ana_uno" } })).toBe(1);
  });

  it("un TypeError también queda filtrado", async () => {
    fallarTransaccion(1, () => new TypeError("Cannot read properties of undefined (reading 'ZZZ_SECRETO')"));
    const resumen = await importPersonsFromExcel(await libroDeFilas([fila(RUN_UNO, "ana_uno")]), { userId: ADMIN.id });

    expect(resumen.results[0]!.errors).toEqual([MENSAJE_FILA_INTERNA]);
    sinSecretos(JSON.stringify(resumen));
  });

  it("el detalle técnico queda en el registro interno SIN el texto del error", async () => {
    fallarTransaccion(1, ERROR_DE_PRISMA_CRUDO);
    await importPersonsFromExcel(await libroDeFilas([fila(RUN_UNO, "ana_uno")]), { userId: ADMIN.id });

    const eventos = eventosDeFallo();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ event: "fila_fallo_inesperado", level: "error", contexto: "carga-masiva-personas", referencia: 2, errorName: "Error" });
    sinSecretos(lineasDeRegistro.join("\n"));
  });

  it("un conflicto de dominio se conserva con su mensaje", async () => {
    await importPersonsFromExcel(await libroDeFilas([fila(RUN_UNO, "ana_uno")]), { userId: ADMIN.id });

    const resumen = await importPersonsFromExcel(await libroDeFilas([fila(RUN_UNO, "ana_otra")]), { userId: ADMIN.id });

    expect(resumen.results[0]!.status).toBe("error");
    const mensaje = resumen.results[0]!.errors![0]!;
    expect(mensaje).not.toBe(MENSAJE_FILA_INTERNA);
    expect(mensaje).toMatch(/RUN/i);
    expect(eventosDeFallo(), "un error previsto no se registra como fallo inesperado").toHaveLength(0);
  });

  it("un error de Prisma que el sistema sabe traducir (P2002) conserva SU mensaje, nunca el del motor", async () => {
    fallarTransaccion(1, () =>
      Object.assign(new Error('Unique constraint failed on the fields: (`run`) INSERT INTO "persons" hunter2'), {
        code: "P2002",
        meta: { modelName: "Person", target: ["run"] },
      })
    );
    const resumen = await importPersonsFromExcel(await libroDeFilas([fila(RUN_UNO, "ana_uno")]), { userId: ADMIN.id });

    expect(resumen.results[0]!.errors).toEqual(["Ya existe una persona registrada con ese RUN."]);
    sinSecretos(JSON.stringify(resumen));
  });

  it("los errores de validación de la fila (RUN inválido) se conservan", async () => {
    const resumen = await importPersonsFromExcel(await libroDeFilas([fila("12.345.678-9", "ana_mala")]), { userId: ADMIN.id });

    expect(resumen.results[0]!.status).toBe("error");
    expect(resumen.results[0]!.errors!.join(" ")).toMatch(/RUN/i);
    expect(resumen.results[0]!.errors).not.toContain(MENSAJE_FILA_INTERNA);
  });
});

// ---------------------------------------------------------------------------
// Asignación masiva de nadadores
// ---------------------------------------------------------------------------

describe("asignación masiva de nadadores", () => {
  async function montar() {
    const destino = await createClub("Club Destino", "DEST");
    const otro = await createClub("Club Otro", "OTRO");
    const a = await createPerson({ run: "81000001", username: "nad_a", firstName: "Ana", gender: "female" });
    const b = await createPerson({ run: "81000002", username: "nad_b", firstName: "Bea", gender: "female" });
    const c = await createPerson({ run: "81000003", username: "nad_c", firstName: "Cata", gender: "female" });
    const d = await createPerson({ run: "81000004", username: "nad_d", firstName: "Dora", gender: "female" });
    await addActiveMembership(otro.id, c.id, ADMIN.id);
    return { destino, otro, a, b, c, d };
  }

  it("un fallo inesperado se filtra, el conflicto de dominio se conserva y las demás filas se asignan", async () => {
    const { destino, a, b, c, d } = await montar();
    fallarTransaccion(2, ERROR_DE_PRISMA_CRUDO); // la asignación de `b`

    const resumen = await bulkAssignSwimmers({ targetClubId: destino.id, personIds: [a.id, b.id, c.id, d.id] }, { userId: ADMIN.id });

    expect(resumen).toMatchObject({ totalCount: 4, assignedCount: 2, errorCount: 2 });
    const porId = Object.fromEntries(resumen.results.map((r) => [r.personId, r]));
    expect(porId[a.id]!.status).toBe("assigned");
    expect(porId[b.id]).toMatchObject({ status: "error", error: MENSAJE_FILA_INTERNA });
    // C-05 fase 3: el fallo inesperado no expone un código; el de dominio conserva el suyo.
    expect(porId[b.id]!.codigo).toBeUndefined();
    expect(porId[c.id]!.codigo).toBe("VALIDATION_ERROR");
    expect(porId[c.id]!.status).toBe("error");
    expect(porId[c.id]!.error, "el mensaje de validación del dominio se conserva").toMatch(/membresía activa en "Club Otro"/);
    expect(porId[d.id]!.status, "una fila con problemas no detiene las demás").toBe("assigned");
    sinSecretos(JSON.stringify(resumen));

    // Atomicidad: la fila que falló no dejó membresía.
    expect(await prisma.clubSwimmer.count({ where: { personId: b.id } })).toBe(0);
    expect(await prisma.clubSwimmer.count({ where: { personId: { in: [a.id, d.id] }, status: "active" } })).toBe(2);
  });

  it("el detalle técnico queda en el registro interno sin el texto del error", async () => {
    const { destino, a } = await montar();
    fallarTransaccion(1, ERROR_DE_PRISMA_CRUDO);

    await bulkAssignSwimmers({ targetClubId: destino.id, personIds: [a.id] }, { userId: ADMIN.id });

    const eventos = eventosDeFallo();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ contexto: "asignacion-masiva", referencia: a.id, errorName: "Error" });
    sinSecretos(lineasDeRegistro.join("\n"));
  });
});

// ---------------------------------------------------------------------------
// Importación de competencias: analizadores
// ---------------------------------------------------------------------------

describe("importación de competencias", () => {
  const ev3 = () => readFileSync(join(__dirname, "fixtures", "sample.ev3"));
  const GENERICO = /^La importación falló y no se creó la competencia\./;

  async function capturar(p: Promise<unknown>) {
    try {
      await p;
    } catch (err) {
      return err as Error;
    }
    throw new Error("se esperaba un rechazo");
  }

  const ultimoRastro = async () => {
    const fila = await prisma.auditLog.findFirstOrThrow({ where: { action: "COMPETITION_IMPORT_FAILED" }, orderBy: { createdAt: "desc" } });
    return fila.after as Record<string, unknown>;
  };

  it("un error PREVISTO del analizador conserva su mensaje útil", async () => {
    const lineas = ev3().toString("latin1").split(/\r?\n/);
    const campos = lineas[0]!.replace(/\*>\s*$/, "").split(";");
    campos[2] = "no-es-una-fecha";
    lineas[0] = `${campos.join(";")}*>`;

    const err = await capturar(analizarArchivoDeImportacion(Buffer.from(lineas.join("\n"), "latin1"), { userId: ADMIN.id }, "x.ev3"));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/No se pudo leer la fecha de inicio de la competencia/);
    expect((await ultimoRastro()).reason).toMatch(/fecha de inicio/);
  });

  it("un archivo .ev3 vacío de contenido útil sigue diciendo por qué", async () => {
    const err = await capturar(analizarArchivoDeImportacion(Buffer.from("x".repeat(10)), { userId: ADMIN.id }, "x.ev3"));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/no tiene el contenido de una exportación/i);
  });

  it("un TypeError del analizador NO se publica: mensaje genérico y rastro sin su texto (análisis)", async () => {
    analizador.fallar = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'ZZZ_SECRETO')");
    };

    const err = await capturar(analizarArchivoDeImportacion(ev3(), { userId: ADMIN.id }, "x.ev3"));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(GENERICO);
    sinSecretos(err.message);

    const rastro = await ultimoRastro();
    expect(rastro).toMatchObject({ fase: "analisis", etapa: "interpretacion-del-archivo", reason: null, errorName: "TypeError" });
    sinSecretos(JSON.stringify(rastro));
  });

  it("un TypeError del analizador tampoco se publica al importar", async () => {
    analizador.fallar = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'ZZZ_SECRETO')");
    };

    const err = await capturar(
      importCompetitionFromMeetEventsZip(ev3(), { maxIndividualEventsPerSwimmer: 3 }, { userId: ADMIN.id }, "x.ev3")
    );

    expect(err.message).toMatch(GENERICO);
    sinSecretos(err.message);
    sinSecretos(JSON.stringify(await ultimoRastro()));
    expect(await prisma.competition.count(), "no se creó la competencia").toBe(0);
  });

  it("un Error corriente durante la interpretación ya no se publica solo por haber ocurrido ahí", async () => {
    analizador.fallar = () => {
      throw new Error("ruta interna /srv/app/dist/parser.js línea 40");
    };

    const err = await capturar(analizarArchivoDeImportacion(ev3(), { userId: ADMIN.id }, "x.ev3"));

    expect(err.message).toMatch(GENERICO);
    expect(err.message).not.toContain("/srv/app");
  });

  it("un archivo válido sigue analizándose igual", async () => {
    await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
    const resumen = await analizarArchivoDeImportacion(ev3(), { userId: ADMIN.id }, "x.ev3");

    expect(resumen.formato).toBe("ev3");
    expect(resumen.eventsTotal).toBeGreaterThan(0);
  });
});
