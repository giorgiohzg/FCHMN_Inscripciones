/**
 * Sexo del nadador frente a género de la PRUEBA, y nombres del paquete.
 *
 * Una exportación que Meet Manager importa correctamente mostró que son dos datos
 * distintos: la persona conserva M o F, y la prueba lleva su propio género (X si
 * es mixta). Antes el generador copiaba el sexo del nadador en el campo de la
 * prueba (HY3 E1 y CL2 D0) y escribía "MIX" en el F1 de un relevo mixto, donde
 * la referencia escribe "XXX". Todo lo de aquí es SINTÉTICO.
 */
import { describe, it, expect } from "vitest";
import { buildCl2File, buildD0, buildE0, isValidCl2Line } from "../src/modules/team-manager-export/cl2-writer";
import { buildE1, buildF1, buildHy3File } from "../src/modules/team-manager-export/hy3-writer";
import { computeHy3Checksum } from "../src/modules/team-manager-export/hy3-checksum";
import {
  codigoGeneroRelevo,
  fechaParaNombreDeArchivo,
  generoDePrueba,
  nombresDelPaquete,
  type ExportSwimmer,
  type TeamManagerExportModel,
} from "../src/modules/team-manager-export/export-model";

const utc = (y: number, m: number, d: number, h = 0, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min));
const lineas = (archivo: string) => archivo.split("\r\n").filter(Boolean);
const de = (archivo: string[], tipo: string) => archivo.filter((l) => l.startsWith(tipo));
const hy3Valida = (l: string) => l.length === 130 && l.slice(128) === computeHy3Checksum(l.slice(0, 128));

function nadador(id: number, parcial: Partial<ExportSwimmer>): ExportSwimmer {
  return {
    swimmerId: id,
    gender: "F",
    lastName: "Sintetica",
    firstName: "Ana",
    run: "10000000-1",
    birthDate: utc(1980, 3, 15),
    age: 46,
    ageAtMeet: 46,
    entries: [],
    ...parcial,
  };
}

/**
 * Un hombre y una mujer en las mismas pruebas mixtas, más una prueba masculina,
 * una femenina y los tres tipos de relevo. Las marcas NO son cero: una diferencia
 * legítima con la referencia, que no debe tocarse.
 */
const MODELO: TeamManagerExportModel = {
  generatedAt: utc(2030, 1, 3, 15, 54),
  meet: {
    name: "Copa Sintetica Mixta",
    facility: "sede",
    startDate: utc(2030, 1, 6),
    endDate: utc(2030, 1, 7),
    ageUpDate: utc(2030, 12, 31),
    courseCode: "L",
  },
  club: { code: "SINT", name: "Club Sintetico" },
  swimmers: [
    nadador(1, {
      gender: "M",
      lastName: "Varon",
      firstName: "Pedro",
      run: "11111111-1",
      entries: [
        { distanceMeters: 50, strokeCode: "C", meetEventNumber: 13, seedTimeSeconds: 38.5, eventGender: "X" },
        { distanceMeters: 200, strokeCode: "E", meetEventNumber: 8, seedTimeSeconds: 185.07, eventGender: "X" },
        { distanceMeters: 100, strokeCode: "A", meetEventNumber: 30, seedTimeSeconds: 61.25, eventGender: "M" },
      ],
    }),
    nadador(2, {
      gender: "F",
      lastName: "Dama",
      firstName: "Rosa",
      run: "22222222-2",
      entries: [
        { distanceMeters: 50, strokeCode: "C", meetEventNumber: 13, seedTimeSeconds: 46.24, eventGender: "X" },
        { distanceMeters: 800, strokeCode: "A", meetEventNumber: 1, seedTimeSeconds: 783.08, eventGender: "X" },
        { distanceMeters: 100, strokeCode: "B", meetEventNumber: 31, seedTimeSeconds: 0, eventGender: "F" },
      ],
    }),
    nadador(3, { gender: "M", lastName: "Tercero", firstName: "Luis", run: "33333333-3" }),
    nadador(4, { gender: "F", lastName: "Cuarta", firstName: "Ines", run: "44444444-4" }),
    nadador(5, { gender: "M", lastName: "Quinto", firstName: "Juan", run: "55555555-5" }),
    nadador(6, { gender: "F", lastName: "Sexta", firstName: "Eva", run: "66666666-6" }),
  ],
  relays: [
    {
      relayLetter: "A",
      categoriaRelevo: 200,
      genderCode: "XXX",
      distanceMeters: 200,
      strokeCode: "E",
      meetEventNumber: 3,
      seedTimeSeconds: 150.5,
      legs: [
        { gender: "F", swimmerId: 2, lastNameAbbrev: "Dama", legNumber: 1 },
        { gender: "F", swimmerId: 4, lastNameAbbrev: "Cuart", legNumber: 2 },
        { gender: "M", swimmerId: 1, lastNameAbbrev: "Varon", legNumber: 3 },
        { gender: "M", swimmerId: 3, lastNameAbbrev: "Terce", legNumber: 4 },
      ],
    },
    {
      relayLetter: "A",
      categoriaRelevo: 160,
      genderCode: "MMM",
      distanceMeters: 200,
      strokeCode: "A",
      meetEventNumber: 10,
      seedTimeSeconds: 0,
      legs: [
        { gender: "M", swimmerId: 1, lastNameAbbrev: "Varon", legNumber: 1 },
        { gender: "M", swimmerId: 3, lastNameAbbrev: "Terce", legNumber: 2 },
        { gender: "M", swimmerId: 5, lastNameAbbrev: "Quint", legNumber: 3 },
        { gender: "M", swimmerId: 3, lastNameAbbrev: "Terce", legNumber: 4 },
      ],
    },
    {
      relayLetter: "A",
      categoriaRelevo: 240,
      genderCode: "FFF",
      distanceMeters: 200,
      strokeCode: "A",
      meetEventNumber: 9,
      seedTimeSeconds: 170.4,
      legs: [
        { gender: "F", swimmerId: 2, lastNameAbbrev: "Dama", legNumber: 1 },
        { gender: "F", swimmerId: 4, lastNameAbbrev: "Cuart", legNumber: 2 },
        { gender: "F", swimmerId: 6, lastNameAbbrev: "Sexta", legNumber: 3 },
        { gender: "F", swimmerId: 4, lastNameAbbrev: "Cuart", legNumber: 4 },
      ],
    },
  ],
};

const HY3 = lineas(buildHy3File(MODELO));
const CL2 = lineas(buildCl2File(MODELO));

describe("género de la prueba a partir del género del evento", () => {
  it("individual: male → M, female → F, mixed → X", () => {
    expect(generoDePrueba("male")).toBe("M");
    expect(generoDePrueba("female")).toBe("F");
    expect(generoDePrueba("mixed")).toBe("X");
  });

  it("relevo: male → MMM, female → FFF, mixed → XXX (no MIX)", () => {
    expect(codigoGeneroRelevo("male")).toBe("MMM");
    expect(codigoGeneroRelevo("female")).toBe("FFF");
    expect(codigoGeneroRelevo("mixed")).toBe("XXX");
  });
});

describe("HY3 E1: sexo del nadador en la columna 2, género de la prueba en las 13-14", () => {
  const base = {
    swimmerId: 7,
    lastNameAbbrev: "Sinte",
    distanceMeters: 50,
    strokeCode: "C" as const,
    meetEventNumber: 13,
    seedTimeSeconds: 38.5,
  };

  it.each([
    ["hombre en prueba mixta", "M", "X", "XX"],
    ["mujer en prueba mixta", "F", "X", "XX"],
    ["hombre en prueba masculina", "M", "M", "MM"],
    ["mujer en prueba femenina", "F", "F", "FF"],
  ] as const)("%s", (_caso, sexo, prueba, campo) => {
    const e1 = buildE1({ ...base, gender: sexo, eventGender: prueba });
    expect(e1[2]).toBe(sexo);
    expect(e1.slice(13, 15)).toBe(campo);
    // Nada más se mueve: distancia, estilo, número, marca y curso en sus columnas.
    expect(e1.slice(15, 21)).toBe("    50");
    expect(e1[21]).toBe("C");
    expect(e1.slice(39, 41)).toBe("13");
    expect(e1.slice(51, 59)).toBe("   38,50");
    expect(e1[50]).toBe("L");
    expect(e1[59]).toBe("L");
    expect(e1[91]).toBe("C");
    expect(hy3Valida(e1)).toBe(true);
  });
});

describe("CL2 D0: sexo de la persona en la columna 65, de la prueba en la 66", () => {
  const prueba = { distanceMeters: 50, strokeCode: "C" as const, meetEventNumber: 13, seedTimeSeconds: 38.5 };

  it.each([
    ["hombre en prueba mixta", "M", "X"],
    ["mujer en prueba mixta", "F", "X"],
    ["hombre en prueba masculina", "M", "M"],
    ["mujer en prueba femenina", "F", "F"],
  ] as const)("%s", (_caso, sexo, genero) => {
    const d0 = buildD0(nadador(1, { gender: sexo }), { ...prueba, eventGender: genero }, "L");
    expect(d0[65]).toBe(sexo);
    expect(d0[66]).toBe(genero);
    expect(d0.slice(67, 71)).toBe("  50");
    expect(d0[71]).toBe("3");
    expect(d0.slice(72, 76)).toBe(" 13 ");
    expect(d0.slice(88, 96)).toBe("   38,50");
    expect(isValidCl2Line(d0)).toBe(true);
  });
});

describe("relevos: XXX en el HY3, X en el CL2, y cada integrante con su sexo", () => {
  const relevo = {
    clubCode: "SINT",
    relayLetter: "A",
    categoriaRelevo: 200,
    distanceMeters: 200,
    strokeCode: "E" as const,
    meetEventNumber: 3,
    seedTimeSeconds: 0,
  };

  it.each([
    ["mixto", "XXX", "X"],
    ["masculino", "MMM", "M"],
    ["femenino", "FFF", "F"],
  ] as const)("%s: F1 %s, E0 %s", (_caso, codigo, sexo) => {
    const f1 = buildF1({ ...relevo, genderCode: codigo });
    expect(f1.slice(12, 15)).toBe(codigo);
    expect(f1.slice(18, 21)).toBe("200");
    expect(f1[21]).toBe("E");
    expect(hy3Valida(f1)).toBe(true);

    const { clubCode, ...resto } = relevo;
    const e0 = buildE0({ ...resto, genderCode: codigo, legs: [] }, clubCode, MODELO.meet);
    expect(e0[20]).toBe(sexo);
    expect(e0.slice(21, 25)).toBe(" 200");
    expect(e0[25]).toBe("7");
    expect(isValidCl2Line(e0)).toBe(true);
  });

  it("el F1 de un relevo mixto ya no lleva MIX", () => {
    expect(HY3.join("\n")).not.toContain("MIX");
    expect(de(HY3, "F1").map((l) => l.slice(12, 15))).toEqual(["XXX", "MMM", "FFF"]);
    expect(de(CL2, "E0").map((l) => l[20])).toEqual(["X", "M", "F"]);
  });

  it("los integrantes conservan M o F en el F3 y el F0, también en el mixto", () => {
    const sexosF3 = de(HY3, "F3").map((l) => [0, 1, 2, 3].map((i) => l[2 + i * 13]).join(""));
    expect(sexosF3).toEqual(["FFMM", "MMMM", "FFFF"]);
    const sexosF0 = de(CL2, "F0")
      .map((l) => l[75])
      .join("");
    expect(sexosF0).toBe("FFMM" + "MMMM" + "FFFF");
  });
});

describe("archivo completo: los dos formatos coinciden y siguen bien formados", () => {
  it("todas las líneas con su largo y checksum", () => {
    expect(HY3.filter((l) => !hy3Valida(l))).toEqual([]);
    expect(CL2.filter((l) => !isValidCl2Line(l))).toEqual([]);
  });

  it("el D1 y el E1 llevan el sexo de la persona; el campo de la prueba, el de la prueba", () => {
    expect(
      de(HY3, "D1")
        .map((l) => l[2])
        .join("")
    ).toBe("MFMFMF");
    expect(de(HY3, "E1").map((l) => `${l[2]}${l.slice(13, 15)}`)).toEqual(["MXX", "MXX", "MMM", "FXX", "FXX", "FFF"]);
    expect(de(CL2, "D0").map((l) => `${l[65]}${l[66]}`)).toEqual(["MX", "MX", "MM", "FX", "FX", "FF"]);
  });

  it("número, distancia, estilo, marca y géneros dicen lo mismo en HY3 y CL2", () => {
    const ESTILOS: Record<string, string> = { A: "1", B: "2", C: "3", D: "4", E: "5" };
    const cent = (t: string) => {
      const limpio = t.trim().replace(",", ".");
      if (limpio === "NT") return 0;
      const [m, s] = limpio.includes(":") ? limpio.split(":") : ["0", limpio];
      return Math.round((Number(m) * 60 + Number(s)) * 100);
    };
    const hy3 = de(HY3, "E1").map((l) =>
      [l.slice(5, 8).trim(), l[2], l[13], l.slice(39, 41).trim(), l.slice(15, 21).trim(), ESTILOS[l[21]!], cent(l.slice(51, 59))].join("|")
    );
    const idPorRun = new Map(de(HY3, "D1").map((l) => [l.slice(69, 88).trim(), l.slice(5, 8).trim()]));
    const cl2 = de(CL2, "D0").map((l) =>
      [
        idPorRun.get(l.slice(39, 51).trim()),
        l[65],
        l[66],
        l.slice(72, 75).trim(),
        l.slice(67, 71).trim(),
        l[71],
        cent(l.slice(88, 96)),
      ].join("|")
    );
    expect(cl2).toEqual(hy3);
    expect(hy3).toEqual([
      "1|M|X|13|50|3|3850",
      "1|M|X|8|200|5|18507",
      "1|M|M|30|100|1|6125",
      "2|F|X|13|50|3|4624",
      "2|F|X|1|800|1|78308",
      "2|F|F|31|100|2|0",
    ]);
  });
});

describe("nombres del paquete: meses en español y fecha UTC", () => {
  it.each([
    [1, "ene"],
    [2, "feb"],
    [3, "mar"],
    [4, "abr"],
    [5, "may"],
    [6, "jun"],
    [7, "jul"],
    [8, "ago"],
    [9, "sep"],
    [10, "oct"],
    [11, "nov"],
    [12, "dic"],
  ])("mes %i → %s", (mes, abreviatura) => {
    expect(fechaParaNombreDeArchivo(utc(2027, mes, 6))).toBe(`06${abreviatura}2027`);
  });

  it("lee el día UTC: una medianoche UTC no retrocede al día anterior en Chile", () => {
    expect(fechaParaNombreDeArchivo(utc(2027, 1, 1))).toBe("01ene2027");
    expect(fechaParaNombreDeArchivo(utc(2027, 12, 31, 23, 59))).toBe("31dic2027");
  });

  it("el ZIP, el HY3 y el CL2 comparten la misma base", () => {
    const nombres = nombresDelPaquete("SINT", "XXI Copa Sintetica Master", utc(2027, 1, 6));
    expect(nombres.zip).toBe("SINT-Entries-XXI_Copa_Sintetica_Master-06ene2027-001.zip");
    expect(nombres.hy3).toBe("SINT-Entries-XXI_Copa_Sintetica_Master-06ene2027-001.HY3");
    expect(nombres.cl2).toBe("SINT-Entries-XXI_Copa_Sintetica_Master-06ene2027-001.CL2");
    for (const n of [nombres.zip, nombres.hy3, nombres.cl2]) expect(n).not.toMatch(/jan|apr|aug|dec/);
  });
});
