/**
 * Relevos en la exportación a Team Manager: categoría y exhibición.
 *
 * Dos defectos observados al importar en Meet Manager un paquete de FCHMN:
 *
 * 1. Los relevos con marca quedaban como EXHIBICIÓN. El F1 del HY3 llevaba una "X" en la
 *    posición 83 (contando desde 0) y el E0 del CL2 otra en la 154, ambas escritas solo
 *    porque había marca. Meet Manager marca «Exh» y antepone la X a la marca en su
 *    programa. El sistema no tiene relevos de exhibición: esas posiciones van en blanco,
 *    con marca o sin ella, y la marca se conserva donde corresponde.
 *
 * 2. La categoría salía de un contador correlativo (100, 101...). Las posiciones 9-11 del
 *    F1 (desde 0) son la CATEGORÍA del relevo, el límite inferior de su tramo de suma de
 *    edades: en exportaciones de Team Manager valen 200 en dos relevos de pruebas distintas,
 *    y 160, 200 y 240 en otra, dos de ellos en la misma prueba. No es un identificador.
 *
 * Todo lo de aquí es SINTÉTICO.
 */
import { describe, it, expect } from "vitest";
import { buildF1, buildHy3File } from "../src/modules/team-manager-export/hy3-writer";
import { buildCl2File, buildE0, isValidCl2Line } from "../src/modules/team-manager-export/cl2-writer";
import { computeHy3Checksum } from "../src/modules/team-manager-export/hy3-checksum";
import type { ExportRelay, TeamManagerExportModel } from "../src/modules/team-manager-export/export-model";

/** Posiciones desde 0, como `String.prototype.slice`. */
const F1_CATEGORIA = [9, 12] as const;
const F1_EXHIBICION = 83;
const E0_EXHIBICION = 154;

/** Sexo de cada nadador sintético, por su número en el archivo. */
const SEXO_DEL_NADADOR: Record<number, "M" | "F"> = { 1: "F", 2: "M", 3: "M", 4: "F", 5: "F", 6: "F", 7: "M", 8: "M" };

const piernas = (ids: number[]): ExportRelay["legs"] =>
  ids.map((id, i) => ({ gender: SEXO_DEL_NADADOR[id]!, swimmerId: id, lastNameAbbrev: `Sint${id}`, legNumber: (i + 1) as 1 | 2 | 3 | 4 }));

const relevo = (cambios: Partial<ExportRelay>): ExportRelay => ({
  relayLetter: "A",
  categoriaRelevo: 200,
  genderCode: "XXX",
  distanceMeters: 200,
  strokeCode: "E",
  meetEventNumber: 3,
  seedTimeSeconds: 240,
  legs: piernas([1, 2, 3, 4]),
  ...cambios,
});

/** Mixto y femenino en 200, como el caso observado; uno masculino en otra categoría; uno sin marca. */
const RELEVOS: ExportRelay[] = [
  relevo({
    genderCode: "XXX",
    strokeCode: "E",
    meetEventNumber: 3,
    seedTimeSeconds: 240,
    categoriaRelevo: 200,
    legs: piernas([1, 2, 3, 4]),
  }),
  relevo({
    genderCode: "FFF",
    strokeCode: "A",
    meetEventNumber: 9,
    seedTimeSeconds: 300,
    categoriaRelevo: 200,
    legs: piernas([1, 4, 5, 6]),
  }),
  relevo({
    genderCode: "MMM",
    strokeCode: "A",
    meetEventNumber: 10,
    seedTimeSeconds: 175.38,
    categoriaRelevo: 240,
    legs: piernas([2, 3, 7, 8]),
  }),
  relevo({
    genderCode: "XXX",
    strokeCode: "A",
    meetEventNumber: 23,
    seedTimeSeconds: 0,
    categoriaRelevo: 160,
    legs: piernas([7, 5, 8, 6]),
  }),
];

const nadador = (id: number, gender: "M" | "F") => ({
  swimmerId: id,
  gender,
  lastName: `Sintetico${id}`,
  firstName: "Prueba",
  run: `1000000${id}-${id}`,
  birthDate: new Date(Date.UTC(1970, 4, 5)),
  age: 57,
  ageAtMeet: 56,
  entries: [{ distanceMeters: 50, strokeCode: "A" as const, meetEventNumber: 15, seedTimeSeconds: 31.5, eventGender: "X" as const }],
});

const MODELO: TeamManagerExportModel = {
  generatedAt: new Date(Date.UTC(2026, 10, 18, 15, 0)),
  meet: {
    name: "Copa Sintetica Relevos",
    facility: "Piscina Sintetica",
    startDate: new Date(Date.UTC(2031, 0, 6)),
    endDate: new Date(Date.UTC(2031, 0, 9)),
    ageUpDate: new Date(Date.UTC(2031, 11, 31)),
    courseCode: "S",
  },
  club: { code: "SINTE", name: "Club Sintetico" },
  swimmers: Object.entries(SEXO_DEL_NADADOR).map(([id, sexo]) => nadador(Number(id), sexo)),
  relays: RELEVOS,
};

const HY3 = buildHy3File(MODELO).split("\r\n").filter(Boolean);
const CL2 = buildCl2File(MODELO).split("\r\n").filter(Boolean);
const de = (lineas: string[], tipo: string) => lineas.filter((l) => l.startsWith(tipo));

describe("relevos: la marca no los convierte en exhibición", () => {
  it.each([
    ["mixto con marca", "XXX", 240],
    ["femenino con marca", "FFF", 300],
    ["masculino con marca", "MMM", 175.38],
    ["mixto sin marca", "XXX", 0],
  ] as const)("F1 %s: la posición 83 queda en blanco", (_caso, genderCode, seedTimeSeconds) => {
    const f1 = buildF1({ ...relevo({ genderCode, seedTimeSeconds }), clubCode: "SINTE", courseCode: "S" });
    expect(f1[F1_EXHIBICION]).toBe(" ");
    expect(f1.slice(12, 15)).toBe(genderCode); // el género del relevo, intacto (XXX en el mixto)
  });

  it.each([
    ["mixto con marca", "XXX", "X", 240],
    ["femenino con marca", "FFF", "F", 300],
    ["masculino con marca", "MMM", "M", 175.38],
    ["mixto sin marca", "XXX", "X", 0],
  ] as const)("E0 %s: la posición 154 queda en blanco", (_caso, genderCode, sexo, seedTimeSeconds) => {
    const e0 = buildE0(relevo({ genderCode, seedTimeSeconds }), "SINTE", MODELO.meet);
    expect(e0[E0_EXHIBICION]).toBe(" ");
    expect(e0[20]).toBe(sexo);
  });

  it("las marcas se conservan en los dos formatos, con su piscina", () => {
    expect(de(HY3, "F1").map((l) => l.slice(51, 60))).toEqual(["  240,00S", "  300,00S", "  175,38S", "    0.00S"]);
    expect(de(CL2, "E0").map((l) => l.slice(45, 54))).toEqual([" 4:00,00S", " 5:00,00S", " 2:55,38S", "      NTS"]);
  });

  it("ningún F1 ni E0 del archivo lleva la marca de exhibición", () => {
    expect(de(HY3, "F1").map((l) => l[F1_EXHIBICION])).toEqual([" ", " ", " ", " "]);
    expect(de(CL2, "E0").map((l) => l[E0_EXHIBICION])).toEqual([" ", " ", " ", " "]);
  });
});

describe("relevos: la categoría es la de cada inscripción, no un correlativo", () => {
  it("F1: posiciones 9-11, ajustada a la derecha", () => {
    const f1 = (categoriaRelevo: number) => buildF1({ ...relevo({ categoriaRelevo }), clubCode: "SINTE" }).slice(...F1_CATEGORIA);
    expect(f1(200)).toBe("200");
    expect(f1(160)).toBe("160");
    expect(f1(80)).toBe(" 80");
  });

  it("dos relevos de pruebas distintas comparten la categoría 200; los demás llevan la suya", () => {
    expect(de(HY3, "F1").map((l) => l.slice(...F1_CATEGORIA))).toEqual(["200", "200", "240", "160"]);
  });

  it("el resto del F1 no se mueve: club, letra, género, distancia, estilo y número de prueba", () => {
    const f1 = de(HY3, "F1");
    expect(f1.map((l) => l.slice(2, 9))).toEqual(Array(4).fill("SINTEA "));
    expect(f1.map((l) => l.slice(12, 15))).toEqual(["XXX", "FFF", "MMM", "XXX"]);
    expect(f1.map((l) => l.slice(18, 22))).toEqual(["200E", "200A", "200A", "200A"]);
    expect(f1.map((l) => l.slice(39, 41))).toEqual([" 3", " 9", "10", "23"]);
  });

  it("el CL2 no lleva la categoría: E0 con UNOV y la suma de edades en blanco, como la referencia", () => {
    for (const e0 of de(CL2, "E0")) {
      expect(e0.slice(30, 34)).toBe("UNOV");
      expect(e0.slice(34, 37)).toBe("   ");
    }
  });

  it("una categoría que no cabe en el campo se rechaza, no se recorta", () => {
    for (const categoriaRelevo of [1000, -1, 12.5, Number.NaN]) {
      expect(() => buildF1({ ...relevo({ categoriaRelevo }), clubCode: "SINTE" })).toThrow(/categor/i);
    }
  });
});

describe("relevos: integrantes, longitudes y checksums", () => {
  it("F3 y F0 conservan los integrantes y su sexo en el orden de las postas", () => {
    expect(de(HY3, "F3").map((l) => [0, 1, 2, 3].map((k) => l[2 + k * 13]).join(""))).toEqual(["FMMF", "FFFF", "MMMM", "MFMF"]);
    expect(de(HY3, "F3").map((l) => [0, 1, 2, 3].map((k) => l.slice(13 + k * 13, 15 + k * 13)).join(""))).toEqual(
      Array(4).fill("F1F2F3F4")
    );
    expect(
      de(CL2, "F0")
        .map((l) => l[75])
        .join("")
    ).toBe("FMMFFFFFMMMMMFMF");
  });

  it("HY3 de 130 columnas y CL2 de 160, con checksum válido, Latin-1 y CRLF", () => {
    expect(HY3.filter((l) => l.length !== 130 || l.slice(128) !== computeHy3Checksum(l.slice(0, 128)))).toEqual([]);
    expect(CL2.filter((l) => !isValidCl2Line(l))).toEqual([]);
    for (const archivo of [buildHy3File(MODELO), buildCl2File(MODELO)]) {
      expect(archivo.endsWith("\r\n")).toBe(true);
      expect(archivo.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
      expect([...archivo].every((c) => c.charCodeAt(0) <= 0xff)).toBe(true);
    }
  });
});
