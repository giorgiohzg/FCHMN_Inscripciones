/**
 * AUD-10 y AUD-14 (unitarias, sin base de datos).
 *
 * AUD-10: la fila individual del reporte lleva la fecha de nacimiento completa solo en la vista de
 * administración; en la vista general lleva la edad a la fecha de corte, en la misma posición. CSV y
 * XLSX cambian solo el encabezado «Fecha de nacimiento» por «Edad».
 *
 * AUD-14: un nadador recibe su propio RUN entre los integrantes del relevo, y la propiedad `run` de
 * sus compañeros no viene; administración y alcance de club reciben el relevo tal cual. El objeto
 * original no se modifica.
 *
 * Datos sintéticos. Lo que depende del alcance real (login, `buildActorContext`, filtros) se prueba
 * en `privacidad-reportes-relevos.integration.test.ts`.
 */
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { mapIndividualRegistrationToRow, type IndividualReportRow } from "../src/modules/reports/reports.rules";
import { buildCsv, buildXlsx, vistaDeReporteParaActor } from "../src/modules/reports/reports.service";
import { presentarRelevoParaActor } from "../src/modules/relay-registrations/relay-registrations.service";
import type { ActorContext } from "../src/shared/actorContext";

const ENTRADA = {
  competitionName: "Copa Sintética",
  clubName: "Club Sintético",
  personFullName: "Ana Prueba",
  personBirthDate: new Date("1990-12-31"),
  categoryName: "35-39",
  distanceMeters: 50,
  strokeName: "Libre",
  gender: "female" as const,
  sessionDate: new Date("2026-08-15"),
  sessionTypeName: "Mañana",
  testTypeName: "Individual",
};

const CLAVES_ADMIN = ["competencia", "club", "nombreCompleto", "fechaNacimiento", "categoria", "prueba", "distancia", "estilo", "genero", "fecha", "jornada", "tipoDePrueba"];
const CLAVES_GENERAL = CLAVES_ADMIN.map((k) => (k === "fechaNacimiento" ? "edad" : k));
const ENCABEZADOS_ADMIN = ["Competencia", "Club", "Nombre completo", "Fecha de nacimiento", "Categoría", "Prueba", "Distancia", "Estilo", "Género", "Fecha", "Jornada", "Tipo de prueba"];
const ENCABEZADOS_GENERAL = ENCABEZADOS_ADMIN.map((h) => (h === "Fecha de nacimiento" ? "Edad" : h));

const actor = (scope: ActorContext["scope"]): ActorContext => ({ userId: "u-sintetico", isAdmin: scope.kind === "admin", scope, canRegisterPostClose: false });

describe("AUD-10: fila individual según la vista", () => {
  it("administración: la fecha completa, con la estructura de siempre", () => {
    const fila = mapIndividualRegistrationToRow(ENTRADA, { vista: "administracion" });
    expect(Object.keys(fila)).toEqual(CLAVES_ADMIN);
    expect(fila.fechaNacimiento).toBe("31-12-1990");
  });

  it("general: la edad a la fecha de corte dada (no a la fecha actual), en la misma posición y sin la fecha", () => {
    const antesDelCumpleanos = mapIndividualRegistrationToRow(ENTRADA, { vista: "general", fechaDeCorte: new Date("2030-06-30") });
    const elDia = mapIndividualRegistrationToRow(ENTRADA, { vista: "general", fechaDeCorte: new Date("2030-12-31") });
    expect(Object.keys(antesDelCumpleanos)).toEqual(CLAVES_GENERAL);
    expect(antesDelCumpleanos.edad).toBe(39);
    expect(elDia.edad).toBe(40);
    expect(JSON.stringify(antesDelCumpleanos)).not.toMatch(/1990|31-12|12-31/);
    // El resto de la fila no cambia.
    const { fechaNacimiento: _f, ...restoAdmin } = mapIndividualRegistrationToRow(ENTRADA, { vista: "administracion" });
    const { edad: _e, ...restoGeneral } = antesDelCumpleanos;
    expect(restoGeneral).toEqual(restoAdmin);
  });

  it("la vista sale del alcance efectivo: solo `admin` es administración", () => {
    expect(vistaDeReporteParaActor(actor({ kind: "admin" }))).toBe("administracion");
    expect(vistaDeReporteParaActor(actor({ kind: "club", clubId: "c" }))).toBe("general");
    expect(vistaDeReporteParaActor(actor({ kind: "swimmer", personId: "p" }))).toBe("general");
  });
});

describe("AUD-10: CSV y XLSX según la vista", () => {
  const admin = mapIndividualRegistrationToRow(ENTRADA, { vista: "administracion" });
  const general = mapIndividualRegistrationToRow(ENTRADA, { vista: "general", fechaDeCorte: new Date("2030-06-30") });

  it("CSV: «Edad» en lugar de «Fecha de nacimiento», mismo orden y valores bajo su encabezado", () => {
    const lineasAdmin = buildCsv([admin], [], "administracion").split("\r\n");
    const lineasGeneral = buildCsv([general], [], "general").split("\r\n");
    expect(lineasAdmin[1]).toBe(ENCABEZADOS_ADMIN.join(","));
    expect(lineasGeneral[1]).toBe(ENCABEZADOS_GENERAL.join(","));
    expect(lineasAdmin[2]!.split(",")[3]).toBe("31-12-1990");
    expect(lineasGeneral[2]!.split(",")[3]).toBe("39");
    // Las otras once celdas son idénticas.
    const sinNacimiento = (l: string) => l.split(",").filter((_, i) => i !== 3);
    expect(sinNacimiento(lineasGeneral[2]!)).toEqual(sinNacimiento(lineasAdmin[2]!));
    expect(lineasGeneral.join("\n")).not.toContain("1990");
  });

  it("CSV sin filas: el encabezado también depende de la vista", () => {
    expect(buildCsv([], [], "general").split("\r\n")[1]).toBe(ENCABEZADOS_GENERAL.join(","));
    expect(buildCsv([], [], "administracion").split("\r\n")[1]).toBe(ENCABEZADOS_ADMIN.join(","));
  });

  it("XLSX: mismos encabezados y celdas alineadas", async () => {
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load((await buildXlsx([general], [], "general")) as never);
    const hoja = libro.getWorksheet("Individuales")!;
    expect((hoja.getRow(1).values as unknown[]).slice(1)).toEqual(ENCABEZADOS_GENERAL);
    expect(String(hoja.getRow(2).getCell(4).value)).toBe("39");
    expect(String(hoja.getRow(2).getCell(5).value)).toBe("35-39");
    expect(hoja.columnCount).toBe(12);
  });

  it("una fila que no corresponde a la vista se rechaza en vez de dejar la fecha bajo «Edad»", async () => {
    expect(() => buildCsv([admin], [], "general")).toThrow(/vista/);
    expect(() => buildCsv([general], [], "administracion")).toThrow(/vista/);
    await expect(buildXlsx([admin as IndividualReportRow], [], "general")).rejects.toThrow(/vista/);
  });
});

describe("AUD-14: RUN de los integrantes según el alcance", () => {
  const relevo = () => ({
    id: "r1",
    clubId: "c1",
    members: [
      { id: "m1", personId: "p1", orderPosition: 1, person: { id: "p1", fullName: "Uno Prueba", run: "RUNSINT1" } },
      { id: "m2", personId: "p2", orderPosition: 2, person: { id: "p2", fullName: "Dos Prueba", run: "RUNSINT2" } },
      { id: "m3", personId: "p3", orderPosition: 3, person: { id: "p3", fullName: "Tres Prueba", run: "RUNSINT3" } },
      { id: "m4", personId: "p4", orderPosition: 4, person: { id: "p4", fullName: "Cuatro Prueba", run: "RUNSINT4" } },
    ],
  });

  it("nadador: su RUN se conserva y la propiedad `run` de los compañeros no viene; lo demás, igual", () => {
    const original = relevo();
    const copia = structuredClone(original);
    const visto = presentarRelevoParaActor(original, actor({ kind: "swimmer", personId: "p2" }));

    expect(visto.members.map((m) => m.person)).toEqual([
      { id: "p1", fullName: "Uno Prueba" },
      { id: "p2", fullName: "Dos Prueba", run: "RUNSINT2" },
      { id: "p3", fullName: "Tres Prueba" },
      { id: "p4", fullName: "Cuatro Prueba" },
    ]);
    for (const m of visto.members.filter((x) => x.personId !== "p2")) expect("run" in m.person).toBe(false);
    expect(visto.members.map(({ id, personId, orderPosition }) => ({ id, personId, orderPosition }))).toEqual(
      original.members.map(({ id, personId, orderPosition }) => ({ id, personId, orderPosition }))
    );
    expect({ ...visto, members: undefined }).toEqual({ ...original, members: undefined });
    expect(JSON.stringify(visto)).not.toMatch(/RUNSINT[134]/);
    // El original (el que se audita o comparten otras respuestas) no cambió.
    expect(original).toEqual(copia);
  });

  it("nadador que no integra el equipo (no debería ocurrir: el filtro lo impide): ningún RUN", () => {
    const visto = presentarRelevoParaActor(relevo(), actor({ kind: "swimmer", personId: "otra" }));
    expect(JSON.stringify(visto)).not.toContain("RUNSINT");
  });

  it("administración y alcance de club: el mismo relevo, con todos los RUN", () => {
    for (const a of [actor({ kind: "admin" }), actor({ kind: "club", clubId: "c1" })]) {
      const original = relevo();
      const visto = presentarRelevoParaActor(original, a);
      expect(visto).toEqual(relevo());
      expect(visto.members.map((m) => (m.person as { run?: string }).run)).toEqual(["RUNSINT1", "RUNSINT2", "RUNSINT3", "RUNSINT4"]);
    }
  });
});
