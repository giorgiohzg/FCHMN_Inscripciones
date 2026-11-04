/**
 * Etapa 6 — carga web de personas con CLUB (sigla) y FECHA EFECTIVA de membresía por fila,
 * contra PostgreSQL real.
 *
 * Lo que solo se puede comprobar con la base: que cada fila se escribe en UNA transacción
 * (persona + membresía + rol derivado + auditorías: un fallo a mitad de camino no deja
 * nada), que la fecha se guarda como el día de calendario exacto, que el procesamiento es
 * parcial entre filas y que los permisos se aplican por HTTP.
 *
 * Solo datos sintéticos. Los RUN se generan con dígito verificador válido.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { buildServer } from "../src/server";
import { seedRolesAndPermissions, createUser, createClub, createPerson as crearPersonaDePrueba, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";
import {
  buildPersonsImportTemplate,
  importPersonsFromExcel,
  PERSONS_IMPORT_SHEET,
  PERSONS_INSTRUCTIONS_SHEET,
} from "../src/modules/persons/persons-bulk-import.service";
import { PERSONS_IMPORT_HEADERS } from "../src/modules/persons/persons-bulk-import.rules";
import { utcAFechaCalendario } from "../src/shared/fecha.util";
import { ForbiddenError, ValidationError } from "../src/shared/errors";

type EntradaDeCarga = Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0];

let ACTOR: { userId: string; ipAddress?: string };
let app: FastifyInstance | undefined;

/**
 * Enganches sobre las consultas de la carga, mediante un middleware de Prisma (no se puede
 * usar `vi.spyOn` sobre los delegados: son Proxies). Permiten actuar justo ANTES de que una
 * fila resuelva su sigla, o simular filas que la base ya no puede producir.
 */
const ganchos: {
  /** Antes de la lectura de la sigla de cada fila (la consulta cruda con `FOR SHARE`). */
  antesDeResolverSigla: ((numeroDeLectura: number) => Promise<void>) | null;
  /** Reemplaza el resultado de esa lectura. */
  resultadoDeSigla: unknown[] | null;
  /** Al crear la persona de la fila, ya con el club bloqueado. */
  alCrearPersona: (() => Promise<void>) | null;
  lecturasDeSigla: number;
} = { antesDeResolverSigla: null, resultadoDeSigla: null, alCrearPersona: null, lecturasDeSigla: 0 };

prisma.$use(async (params, next) => {
  const esLecturaDeSigla = params.action === "queryRaw" && JSON.stringify(params.args).includes("FOR SHARE");
  if (esLecturaDeSigla) {
    ganchos.lecturasDeSigla++;
    if (ganchos.antesDeResolverSigla) await ganchos.antesDeResolverSigla(ganchos.lecturasDeSigla);
    if (ganchos.resultadoDeSigla) return ganchos.resultadoDeSigla;
  }
  if (params.model === "Person" && params.action === "create" && ganchos.alCrearPersona) await ganchos.alCrearPersona();
  return next(params);
});

/** RUN chileno válido a partir de un cuerpo numérico. */
function run(cuerpo: number): string {
  let suma = 0;
  let factor = 2;
  for (const d of String(cuerpo).split("").reverse()) {
    suma += Number(d) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  const dv = resto === 11 ? "0" : resto === 10 ? "K" : String(resto);
  return `${cuerpo}-${dv}`;
}

const fila = (cuerpo: number, usuario: string, nombre: string, sigla = "", fecha = ""): (string | number)[] => [
  run(cuerpo),
  usuario,
  nombre,
  "Sintética",
  "Prueba",
  "15-03-1990",
  "Femenino",
  "",
  "",
  sigla,
  fecha,
];

async function libro(filas: (string | number)[][], encabezado: string[] = PERSONS_IMPORT_HEADERS): Promise<Buffer> {
  const l = new ExcelJS.Workbook();
  const hoja = l.addWorksheet(PERSONS_IMPORT_SHEET);
  hoja.addRow(encabezado);
  for (const f of filas) hoja.addRow(f);
  return Buffer.from(await l.xlsx.writeBuffer());
}

const importar = (buffer: Buffer, puedeAsignarClub = true) => importPersonsFromExcel(buffer, ACTOR, { puedeAsignarClub });

async function membresiaDe(runTexto: string) {
  const persona = await prisma.person.findFirstOrThrow({ where: { run: runTexto.replace("-", "").toUpperCase() } });
  const membresias = await prisma.clubSwimmer.findMany({ where: { personId: persona.id }, include: { club: true } });
  const rol = await prisma.personRole.findUnique({ where: { personId_roleType: { personId: persona.id, roleType: "swimmer" } } });
  return { persona, membresias, rolNadador: rol?.active ?? false };
}

beforeEach(async () => {
  Object.assign(ganchos, { antesDeResolverSigla: null, resultadoDeSigla: null, alCrearPersona: null, lecturasDeSigla: 0 });
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_carga_club", roleNames: ["admin"] });
  ACTOR = { userId: admin.id };
  await createClub("Club Natación Valle", "CNV", "club_cnv");
  await createClub("Club Delfines Sur", "CDS", "club_cds");
});

afterAll(async () => {
  await app?.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("plantilla e instrucciones coinciden con el importador", () => {
  async function abrir() {
    const l = new ExcelJS.Workbook();
    await l.xlsx.load((await buildPersonsImportTemplate()) as unknown as EntradaDeCarga);
    return l;
  }

  it("la hoja «Personas» trae exactamente el encabezado que el importador espera (A-K)", async () => {
    const l = await abrir();
    const hoja = l.getWorksheet(PERSONS_IMPORT_SHEET)!;
    expect((hoja.getRow(1).values as unknown[]).slice(1)).toEqual(PERSONS_IMPORT_HEADERS);
    expect(hoja.rowCount).toBe(1);
  });

  it("«Instrucciones» explica J y K y lista los clubes vigentes y activos (no los inactivos ni los eliminados)", async () => {
    const inactivo = await createClub("Club Inactivo", "CIN", "club_cin");
    await prisma.club.update({ where: { id: inactivo.id }, data: { status: "disabled" } });
    const eliminado = await createClub("Club Eliminado", "CEL", "club_cel");
    await prisma.club.update({ where: { id: eliminado.id }, data: { deletedAt: new Date() } });

    const guia = (await abrir()).getWorksheet(PERSONS_INSTRUCTIONS_SHEET)!;
    const lineas: string[] = [];
    guia.eachRow((f) => lineas.push((f.values as unknown[]).slice(1).join(" | ")));
    const todo = lineas.join("\n");

    expect(todo).toMatch(/Club \(columna J\): escriba la SIGLA del club/);
    expect(todo).toMatch(/Fecha efectiva de membresía \(columna K\): obligatoria si hay club/);
    expect(todo).toMatch(/NO usa la fecha de hoy/);
    expect(lineas).toContain("CNV | Club Natación Valle");
    expect(lineas).toContain("CDS | Club Delfines Sur");
    expect(todo).not.toContain("Club Inactivo");
    expect(todo).not.toContain("Club Eliminado");
  });

  it("la lista usa el criterio de la resolución: la sigla normalizada de cada club", async () => {
    const c = await prisma.club.findFirstOrThrow({ where: { code: "CNV" } });
    await prisma.club.update({ where: { id: c.id }, data: { code: " cnv " } });
    const guia = (await abrir()).getWorksheet(PERSONS_INSTRUCTIONS_SHEET)!;
    const lineas: string[] = [];
    guia.eachRow((f) => lineas.push((f.values as unknown[]).slice(1).join(" | ")));
    expect(lineas).toContain("CNV | Club Natación Valle");
  });

  it("los datos de la base que van a la plantilla se NEUTRALIZAN como fórmula", async () => {
    await createClub("=HYPERLINK(\"http://x\",\"clic\")", "+ZZ", "club_formula");
    const guia = (await abrir()).getWorksheet(PERSONS_INSTRUCTIONS_SHEET)!;
    const valores: unknown[] = [];
    guia.eachRow((f) => valores.push(...(f.values as unknown[]).slice(1)));
    expect(valores).toContain("'+ZZ");
    expect(valores).toContain("'=HYPERLINK(\"http://x\",\"clic\")");
    // Ninguna celda es una fórmula.
    expect(valores.some((v) => typeof v === "object" && v !== null && "formula" in (v as object))).toBe(false);
  });

  it("subir la plantilla SIN editar no hace nada", async () => {
    const r = await importar(await buildPersonsImportTemplate());
    expect(r).toMatchObject({ totalRows: 0, createdCount: 0, withClubCount: 0, errorCount: 0 });
  });
});

describe("persona sin club y persona con club", () => {
  it("SIN club: solo la persona; sin membresía y sin rol de nadador", async () => {
    const r = await importar(await libro([fila(20000001, "", "SinClub")]));
    expect(r.results[0]).toMatchObject({ status: "created" });
    expect(r.results[0]!.clubName).toBeUndefined();
    const m = await membresiaDe(run(20000001));
    expect(m.membresias).toHaveLength(0);
    expect(m.rolNadador).toBe(false);
    expect(m.persona.username, "el usuario vacío queda NULL, no se genera uno").toBeNull();
    expect(await prisma.user.count({ where: { personId: m.persona.id } }), "no se crean credenciales").toBe(0);
  });

  it("CON club: membresía ACTIVA en ese club, con la fecha EXACTA, rol de nadador derivado y auditoría", async () => {
    const r = await importar(await libro([fila(20000002, "conclub", "ConClub", "cnv", "2026-03-01")]));
    expect(r.results[0]).toMatchObject({ status: "created", clubName: "Club Natación Valle", fechaEfectiva: "2026-03-01" });
    const m = await membresiaDe(run(20000002));
    expect(m.membresias).toHaveLength(1);
    expect(m.membresias[0]!.status).toBe("active");
    expect(m.membresias[0]!.club.code).toBe("CNV");
    expect(utcAFechaCalendario(m.membresias[0]!.startDate)).toBe("2026-03-01");
    expect(m.rolNadador).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "PERSON_CREATED", entityId: m.persona.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "SWIMMER_ASSIGNMENT_DIRECT", entityId: m.membresias[0]!.id } })).toBe(1);
  });

  it("dos filas con fechas DISTINTAS conservan cada una su día exacto (también junto a cambios de mes y año)", async () => {
    const r = await importar(
      await libro([
        fila(20000003, "", "Uno", "CNV", "2025-12-31"),
        fila(20000004, "", "Dos", "CDS", "01-01-2026"),
        fila(20000005, "", "Tres", "CNV", "2024-02-29"),
      ])
    );
    expect(r.createdCount).toBe(3);
    expect(r.withClubCount).toBe(3);
    expect(utcAFechaCalendario((await membresiaDe(run(20000003))).membresias[0]!.startDate)).toBe("2025-12-31");
    expect(utcAFechaCalendario((await membresiaDe(run(20000004))).membresias[0]!.startDate)).toBe("2026-01-01");
    expect(utcAFechaCalendario((await membresiaDe(run(20000005))).membresias[0]!.startDate)).toBe("2024-02-29");
  });

  it("una celda de FECHA nativa de Excel se guarda como el mismo día", async () => {
    const l = new ExcelJS.Workbook();
    const hoja = l.addWorksheet(PERSONS_IMPORT_SHEET);
    hoja.addRow(PERSONS_IMPORT_HEADERS);
    const f = fila(20000006, "", "Nativa", "CNV", "");
    f[10] = new Date(Date.UTC(2026, 9, 31)) as unknown as string;
    hoja.addRow(f);
    await importar(Buffer.from(await l.xlsx.writeBuffer()));
    expect(utcAFechaCalendario((await membresiaDe(run(20000006))).membresias[0]!.startDate)).toBe("2026-10-31");
  });
});

describe("fechas ausentes, inválidas o sin club: la fila se rechaza y no escribe nada", () => {
  it("cada caso da su mensaje, y ninguna de esas filas deja persona", async () => {
    const r = await importar(
      await libro([
        fila(20000011, "", "SinFecha", "CNV", ""),
        fila(20000012, "", "Invalida", "CNV", "2026-02-30"),
        fila(20000013, "", "SoloFecha", "", "2026-03-01"),
      ])
    );
    expect(r).toMatchObject({ createdCount: 0, errorCount: 3 });
    expect(r.results[0]!.errors!.join(" ")).toMatch(/Falta la fecha efectiva/);
    expect(r.results[1]!.errors!.join(" ")).toMatch(/Fecha efectiva de membresía inválida/);
    expect(r.results[2]!.errors!.join(" ")).toMatch(/pero no trae sigla de club/);
    expect(await prisma.person.count()).toBe(0);
  });
});

describe("resolución de la sigla", () => {
  it("inexistente, inactivo y eliminado: error claro por fila, nada escrito", async () => {
    const inactivo = await createClub("Club Dormido", "CDO", "club_cdo");
    await prisma.club.update({ where: { id: inactivo.id }, data: { status: "disabled" } });
    const eliminado = await createClub("Club Borrado", "CBO", "club_cbo");
    await prisma.club.update({ where: { id: eliminado.id }, data: { deletedAt: new Date() } });

    const r = await importar(
      await libro([
        fila(20000021, "", "Inexistente", "XYZ", "2026-03-01"),
        fila(20000022, "", "Inactivo", "CDO", "2026-03-01"),
        fila(20000023, "", "Eliminado", "CBO", "2026-03-01"),
      ])
    );
    expect(r).toMatchObject({ createdCount: 0, errorCount: 3 });
    expect(r.results[0]!.errors!.join(" ")).toMatch(/No existe ningún club con la sigla «XYZ»/);
    expect(r.results[1]!.errors!.join(" ")).toMatch(/«Club Dormido».*no está activo/);
    expect(r.results[2]!.errors!.join(" ")).toMatch(/club eliminado/);
    expect(await prisma.person.count()).toBe(0);
    expect(await prisma.clubSwimmer.count()).toBe(0);
  });

  it("DEFENSA ante una coincidencia AMBIGUA: si la lectura devolviera dos clubes, la fila se rechaza sin elegir", async () => {
    // La base ya no puede producirlo (`clubs_code_unique_active`), así que se simula el resultado de
    // la lectura: la defensa del importador no debe depender de esa garantía.
    const uno = await prisma.club.findFirstOrThrow({ where: { code: "CNV" } });
    const dos = await prisma.club.findFirstOrThrow({ where: { code: "CDS" } });
    const comoFila = (c: typeof uno) => ({ id: c.id, name: c.name, code: "GEM", status: "active", deletedAt: null });
    ganchos.resultadoDeSigla = [comoFila(uno), comoFila(dos)];

    const r = await importar(await libro([fila(20000024, "", "Ambigua", "GEM", "2026-03-01")]));

    expect(r.results[0]!.errors!.join(" ")).toMatch(/ambigua.*«Club Natación Valle».*«Club Delfines Sur»/s);
    expect(await prisma.person.count()).toBe(0);
  });

  it("una sigla guardada con espacios o minúsculas (dato anterior) se resuelve igual que en la plantilla", async () => {
    const c = await prisma.club.findFirstOrThrow({ where: { code: "CNV" } });
    await prisma.club.update({ where: { id: c.id }, data: { code: " cnv\t" } });
    const r = await importar(await libro([fila(20000025, "", "Anterior", "CNV", "2026-03-01")]));
    expect(r.results[0]).toMatchObject({ status: "created", clubName: "Club Natación Valle" });
  });

  it("la sigla se compara sin distinguir mayúsculas ni espacios, y NO por el nombre ni el usuario del club", async () => {
    const r = await importar(
      await libro([
        fila(20000031, "", "Minusculas", "  cds ", "2026-03-01"),
        fila(20000032, "", "PorNombre", "Club Delfines Sur", "2026-03-01"),
        fila(20000033, "", "PorUsuario", "club_cds", "2026-03-01"),
      ])
    );
    expect(r.results.map((x) => x.status)).toEqual(["created", "error", "error"]);
  });
});

describe("duplicados internos y conflictos con registros existentes", () => {
  it("RUN y usuario repetidos en el archivo: se procesa la primera aparición y se señala la fila", async () => {
    const r = await importar(
      await libro([
        fila(20000041, "anita", "Primera"),
        fila(20000041, "otra", "MismoRun"),
        fila(20000042, "anita", "MismoUsuario"),
        fila(20000043, "", "SinUsuario1"),
        fila(20000044, "", "SinUsuario2"),
      ])
    );
    expect(r.results.map((x) => `${x.row}:${x.status}`)).toEqual(["2:created", "3:error", "4:error", "5:created", "6:created"]);
    expect(r.results[1]!.errors!.join(" ")).toMatch(/RUN repetido dentro del archivo: ya aparece en la fila 2/);
    expect(r.results[2]!.errors!.join(" ")).toMatch(/Nombre de usuario "anita" repetido.*fila 2/);
    expect(await prisma.person.count()).toBe(3);
  });

  it("una persona que YA existe no se sobrescribe ni se cambia de club; un usuario tomado se rechaza", async () => {
    const userClub = await prisma.user.findFirstOrThrow({ where: { username: "admin_carga_club" } });
    const club = await prisma.club.findFirstOrThrow({ where: { code: "CNV" } });
    const existente = await crearPersonaDePrueba({ run: run(20000051).replace("-", ""), username: "yaexiste", firstName: "Existente", gender: "female" });
    await addActiveMembership(club.id, existente.id, userClub.id);

    const r = await importar(
      await libro([
        // Mismo RUN (con puntos y guion) que la existente, y otro club: no se reasigna.
        [run(20000051).replace(/^(\d{2})(\d{3})(\d{3})/, "$1.$2.$3"), "", "Otra", "Persona", "", "01-01-1980", "Masculino", "", "", "CDS", "2026-03-01"],
        // Usuario ya tomado por una persona; y por un club.
        fila(20000052, "yaexiste", "UsuarioTomado"),
        fila(20000053, "club_cds", "UsuarioDeClub"),
      ])
    );
    expect(r).toMatchObject({ createdCount: 0, errorCount: 3 });
    expect(r.results[0]!.errors!.join(" ")).toMatch(/Ya existe una persona registrada con este RUN/);
    expect(r.results[1]!.errors!.join(" ")).toMatch(/ya está en uso/);
    expect(r.results[2]!.errors!.join(" ")).toMatch(/ya está en uso/);

    const despues = await prisma.person.findUniqueOrThrow({ where: { id: existente.id } });
    expect(despues.firstName, "no se sobrescribió").toBe("Existente");
    const membresias = await prisma.clubSwimmer.findMany({ where: { personId: existente.id } });
    expect(membresias.map((m) => `${m.clubId}:${m.status}`), "sigue en su club, sin otra membresía").toEqual([`${club.id}:active`]);
  });
});

describe("atomicidad por fila: un fallo no deja persona ni relaciones parciales", () => {
  async function sabotear(sql: string, accion: () => Promise<void>) {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION _sabotaje_carga() RETURNS trigger AS $BODY$ BEGIN ${sql} RETURN NEW; END; $BODY$ LANGUAGE plpgsql;`);
    try {
      await accion();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS _sabotaje_carga ON club_swimmers;`);
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS _sabotaje_carga ON audit_logs;`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS _sabotaje_carga();`);
    }
  }

  it("si falla la MEMBRESÍA, la persona de esa fila tampoco queda; las demás filas siguen", async () => {
    await sabotear(`RAISE EXCEPTION 'sabotaje: falla la membresía';`, async () => {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER _sabotaje_carga BEFORE INSERT ON club_swimmers FOR EACH ROW EXECUTE FUNCTION _sabotaje_carga();`);
      const r = await importar(await libro([fila(20000061, "fallamemb", "Falla", "CNV", "2026-03-01"), fila(20000062, "sinclub", "SinClub")]));
      expect(r.results.map((x) => x.status)).toEqual(["error", "created"]);
      expect(r).toMatchObject({ createdCount: 1, withClubCount: 0, errorCount: 1 });
    });
    expect(await prisma.person.count({ where: { username: "fallamemb" } }), "la persona se revirtió con su fila").toBe(0);
    expect(await prisma.personRole.count({ where: { roleType: "swimmer" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "PERSON_CREATED" } }), "solo la auditoría de la fila buena").toBe(1);
  });

  it("si falla la AUDITORÍA de la membresía, se revierte la fila entera", async () => {
    await sabotear(`IF NEW.action = 'SWIMMER_ASSIGNMENT_DIRECT' THEN RAISE EXCEPTION 'sabotaje: falla la auditoría'; END IF;`, async () => {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER _sabotaje_carga BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION _sabotaje_carga();`);
      const r = await importar(await libro([fila(20000071, "fallaaud", "Falla", "CNV", "2026-03-01")]));
      expect(r.results[0]!.status).toBe("error");
    });
    expect(await prisma.person.count()).toBe(0);
    expect(await prisma.clubSwimmer.count()).toBe(0);
    expect(await prisma.personRole.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: { in: ["PERSON_CREATED", "SWIMMER_ASSIGNMENT_DIRECT"] } } })).toBe(0);
  });
});

describe("la sigla se resuelve DENTRO de la transacción de cada fila", () => {
  const clubPorSigla = (code: string) => prisma.club.findFirstOrThrow({ where: { code } });
  const clubDeLaPersona = async (cuerpo: number) => (await membresiaDe(run(cuerpo))).membresias[0]?.club.name;

  it("se lee una vez POR FILA, no una vez por archivo", async () => {
    await importar(await libro([fila(20000111, "", "Uno", "CNV", "2026-03-01"), fila(20000112, "", "Dos", "CNV", "2026-03-01"), fila(20000113, "", "SinClub")]));
    expect(ganchos.lecturasDeSigla).toBe(2);
  });

  it("CAMBIO DE SIGLA ENTRE FILAS: cada fila usa la correspondencia vigente, nunca la del inicio de la carga", async () => {
    const valle = await clubPorSigla("CNV");
    const delfines = await clubPorSigla("CDS");
    // Antes de la SEGUNDA fila, los dos clubes intercambian sus siglas.
    ganchos.antesDeResolverSigla = async (n) => {
      if (n !== 2) return;
      await prisma.club.update({ where: { id: valle.id }, data: { code: "TMP" } });
      await prisma.club.update({ where: { id: delfines.id }, data: { code: "CNV" } });
      await prisma.club.update({ where: { id: valle.id }, data: { code: "CDS" } });
    };

    const r = await importar(await libro([fila(20000121, "", "Antes", "CNV", "2026-03-01"), fila(20000122, "", "Despues", "CNV", "2026-03-01")]));

    expect(r.createdCount).toBe(2);
    expect(await clubDeLaPersona(20000121)).toBe("Club Natación Valle");
    expect(await clubDeLaPersona(20000122), "la sigla ya es del otro club").toBe("Club Delfines Sur");
    expect(r.results[1]!.clubName).toBe("Club Delfines Sur");
  });

  it("una sigla RETIRADA durante la carga rechaza esa fila, y las demás continúan", async () => {
    const valle = await clubPorSigla("CNV");
    ganchos.antesDeResolverSigla = async (n) => {
      if (n === 2) await prisma.club.update({ where: { id: valle.id }, data: { code: "OTRA" } });
    };

    const r = await importar(
      await libro([fila(20000131, "", "Antes", "CNV", "2026-03-01"), fila(20000132, "", "Despues", "CNV", "2026-03-01"), fila(20000133, "", "OtroClub", "CDS", "2026-03-01")])
    );

    expect(r.results.map((x) => x.status)).toEqual(["created", "error", "created"]);
    expect(r.results[1]!.errors!.join(" ")).toMatch(/No existe ningún club con la sigla «CNV»/);
    expect(await prisma.person.count({ where: { firstName: "Despues" } }), "la fila no dejó nada").toBe(0);
    expect(r).toMatchObject({ createdCount: 2, errorCount: 1, withClubCount: 2 });
  });

  it("un club INACTIVADO o ELIMINADO durante la carga rechaza las filas siguientes", async () => {
    const valle = await clubPorSigla("CNV");
    const delfines = await clubPorSigla("CDS");
    ganchos.antesDeResolverSigla = async (n) => {
      if (n === 1) await prisma.club.update({ where: { id: valle.id }, data: { status: "disabled" } });
      if (n === 2) await prisma.club.update({ where: { id: delfines.id }, data: { deletedAt: new Date() } });
    };
    const r = await importar(await libro([fila(20000141, "", "Uno", "CNV", "2026-03-01"), fila(20000142, "", "Dos", "CDS", "2026-03-01")]));
    expect(r.results[0]!.errors!.join(" ")).toMatch(/no está activo/);
    expect(r.results[1]!.errors!.join(" ")).toMatch(/club eliminado/);
    expect(await prisma.person.count()).toBe(0);
  });

  it("CONCURRENCIA: si otra transacción está cambiando la sigla, la fila ESPERA y no usa la correspondencia vieja", async () => {
    const valle = await clubPorSigla("CNV");
    let liberar!: () => void;
    const puerta = new Promise<void>((res) => (liberar = res));
    let cambioEnCurso!: () => void;
    const enCurso = new Promise<void>((res) => (cambioEnCurso = res));

    // Una edición del club que aún NO confirma.
    const edicion = prisma.$transaction(async (tx) => {
      await tx.club.update({ where: { id: valle.id }, data: { code: "NVA" } });
      cambioEnCurso();
      await puerta;
    });
    await enCurso;

    const carga = importar(await libro([fila(20000151, "", "Bloqueada", "CNV", "2026-03-01"), fila(20000152, "", "Libre", "CDS", "2026-03-01")]));
    await new Promise((r) => setTimeout(r, 400));
    expect(await prisma.person.count(), "mientras dura la edición, la fila no puede avanzar").toBe(0);

    liberar();
    await edicion;
    const r = await carga;

    expect(r.results.map((x) => x.status), "tras la confirmación, CNV ya no existe").toEqual(["error", "created"]);
    expect(r.results[0]!.errors!.join(" ")).toMatch(/No existe ningún club con la sigla «CNV»/);
    expect(await prisma.clubSwimmer.count({ where: { clubId: valle.id } }), "no quedó nadie en el club por la sigla vieja").toBe(0);
  });

  it("CONCURRENCIA inversa: con la fila en curso, el club queda bloqueado y su sigla no cambia hasta que la fila confirma", async () => {
    const valle = await clubPorSigla("CNV");
    let edicionTerminada = false;
    let edicion: Promise<unknown> | undefined;
    ganchos.alCrearPersona = async () => {
      ganchos.alCrearPersona = null;
      edicion = prisma.club.update({ where: { id: valle.id }, data: { code: "NVA" } }).then(() => (edicionTerminada = true));
      await new Promise((r) => setTimeout(r, 400));
      expect(edicionTerminada, "el cambio de sigla debe esperar a la fila").toBe(false);
    };

    const r = await importar(await libro([fila(20000161, "", "EnCurso", "CNV", "2026-03-01")]));
    await edicion;

    expect(r.results[0]).toMatchObject({ status: "created", clubName: "Club Natación Valle" });
    expect((await membresiaDe(run(20000161))).membresias[0]!.clubId).toBe(valle.id);
    expect((await prisma.club.findUniqueOrThrow({ where: { id: valle.id } })).code, "y luego el cambio sí se aplica").toBe("NVA");
  });
});

describe("permisos", () => {
  it("sin el permiso de asignar, un archivo CON clubes se rechaza entero (403) sin escribir nada", async () => {
    const buffer = await libro([fila(20000081, "", "SinClub"), fila(20000082, "", "ConClub", "CNV", "2026-03-01")]);
    await expect(importar(buffer, false)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.person.count()).toBe(0);
  });

  it("sin el permiso de asignar, un archivo SIN clubes se importa igual", async () => {
    const r = await importar(await libro([fila(20000083, "", "SoloPersona")]), false);
    expect(r.createdCount).toBe(1);
  });

  it("por HTTP: un rol con persons:write pero SIN swimmer-assignment:approve no puede asignar; uno sin persons:write no entra", async () => {
    // Rol sintético solo con persons:write, para probar que la ruta no abre una vía de asignación.
    const rol = await prisma.role.create({ data: { name: "solo_personas_prueba" } });
    const permiso = await prisma.permission.findUniqueOrThrow({ where: { code: "persons:write" } });
    await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
    await createUser({ username: "solo_personas", roleNames: ["solo_personas_prueba"] });
    const club = await prisma.club.findFirstOrThrow({ where: { code: "CNV" } });
    await createUser({ username: "club_cnv", roleNames: ["club"], clubId: club.id });

    app = await buildServer();
    await app.ready();
    const token = async (username: string) =>
      (await app!.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } })).json().accessToken as string;
    const subir = async (tk: string, buffer: Buffer) => {
      const limite = "----limitePruebaCarga";
      const cuerpo = Buffer.concat([
        Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="file"; filename="carga.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
        buffer,
        Buffer.from(`\r\n--${limite}--\r\n`),
      ]);
      return app!.inject({ method: "POST", url: "/persons/bulk-import", headers: { authorization: `Bearer ${tk}`, "content-type": `multipart/form-data; boundary=${limite}` }, payload: cuerpo });
    };

    const conClub = await libro([fila(20000091, "", "ConClub", "CNV", "2026-03-01")]);
    const sinClub = await libro([fila(20000092, "", "SinClub")]);

    const soloPersonas = await token("solo_personas");
    const rechazo = await subir(soloPersonas, conClub);
    expect(rechazo.statusCode).toBe(403);
    expect(rechazo.json().message).toMatch(/swimmer-assignment:approve/);
    expect(await prisma.person.count({ where: { firstName: "ConClub" } })).toBe(0);
    const permitido = await subir(soloPersonas, sinClub);
    expect(permitido.statusCode).toBe(200);
    expect(permitido.json().createdCount).toBe(1);

    expect((await subir(await token("club_cnv"), sinClub)).statusCode, "el rol club no tiene persons:write").toBe(403);

    const admin = await subir(await token("admin_carga_club"), conClub);
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toMatchObject({ createdCount: 1, withClubCount: 1 });
  });
});

describe("mezcla de filas válidas e inválidas: informe y totales coherentes", () => {
  it("cuenta exacta por estado, y cada fila con su número de fila del Excel", async () => {
    const r = await importar(
      await libro([
        fila(20000101, "", "ValidaSinClub"),
        fila(20000102, "", "ValidaConClub", "CNV", "2026-03-01"),
        fila(20000103, "", "MalaSigla", "NOPE", "2026-03-01"),
        [],
        fila(20000104, "", "ValidaConClub2", "CDS", "15-08-2026"),
        fila(20000102, "", "RunRepetido"),
        ["1-9", "", "Mal", "", "", "fecha", "Otro", "", "", "", ""],
      ])
    );
    expect(r.results.map((x) => `${x.row}:${x.status}`)).toEqual(["2:created", "3:created", "4:error", "6:created", "7:error", "8:error"]);
    expect(r.totalRows).toBe(6);
    expect(r.createdCount).toBe(3);
    expect(r.withClubCount).toBe(2);
    expect(r.errorCount).toBe(3);
    expect(r.totalRows).toBe(r.createdCount + r.errorCount);
    expect(await prisma.person.count()).toBe(3);
    expect(await prisma.clubSwimmer.count({ where: { status: "active" } })).toBe(2);
    // La fila inválida acumula todos sus problemas.
    expect(r.results[5]!.errors!.length).toBeGreaterThanOrEqual(2);
  });

  it("un archivo no .xlsx sigue rechazándose con ValidationError", async () => {
    await expect(importar(Buffer.from("no es excel"))).rejects.toBeInstanceOf(ValidationError);
  });
});
