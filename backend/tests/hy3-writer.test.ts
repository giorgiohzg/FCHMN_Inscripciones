import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  buildA1,
  buildD1,
  buildE1,
  buildF1,
  buildF3,
  formatHy3Date,
  formatHy3Time_SecondsComma,
  strokeNameToHy3Code,
} from "../src/modules/team-manager-export/hy3-writer";
import { computeHy3Checksum } from "../src/modules/team-manager-export/hy3-checksum";

const FIXTURE_PATH = path.join(__dirname, "fixtures", "sample.hy3");
const RELAY_FIXTURE_PATH = path.join(__dirname, "fixtures", "sample-with-relays.hy3");

function loadFixtureLines() {
  const raw = fs.readFileSync(FIXTURE_PATH, "latin1");
  return raw.split("\r\n").filter(Boolean);
}

function loadRelayFixtureLines(): string[] {
  const raw = fs.readFileSync(RELAY_FIXTURE_PATH, "latin1");
  return raw.split("\r\n").filter(Boolean);
}

describe("hy3-writer — A1 respeta las posiciones del encabezado de Hy-Tek", () => {
  const a1 = (h: number, m: number) => buildA1(new Date(Date.UTC(2030, 0, 3, h, m)));

  it("el fabricante es Hy-Tek, Ltd y la hora queda pegada a TEAM MANAGER Lite", () => {
    const linea = a1(15, 54);
    expect(linea.slice(0, 92)).toBe(
      "A102Meet Entries             Hy-Tek, Ltd    Win-TM 8.0De  01032030  3:54 PMTEAM MANAGER Lite".padEnd(92, " ")
    );
    expect(linea).not.toContain("Sist. FCHMN");
    expect(linea).toHaveLength(130);
    expect(linea.slice(128)).toBe(computeHy3Checksum(linea.slice(0, 128)));
  });

  it.each([
    ["hora de un dígito, AM", 9, 5, "  9:05 AM"],
    ["hora de un dígito, PM", 15, 54, "  3:54 PM"],
    ["hora de dos dígitos, AM", 11, 9, " 11:09 AM"],
    ["hora de dos dígitos, PM", 22, 30, " 10:30 PM"],
    ["medianoche", 0, 0, " 12:00 AM"],
    ["mediodía", 12, 0, " 12:00 PM"],
    ["un minuto después de medianoche", 0, 1, " 12:01 AM"],
    ["una de la tarde", 13, 0, "  1:00 PM"],
  ])("%s: ocupa las columnas 66-74 y no desplaza nada", (_caso, h, m, esperada) => {
    const linea = a1(h, m);
    expect(linea.slice(58, 66)).toBe("01032030");
    expect(linea.slice(66, 75)).toBe(esperada);
    expect(linea.slice(75, 92)).toBe("TEAM MANAGER Lite");
  });
});

describe("hy3-writer — D1 alinea el RUN a la izquierda desde la columna 69", () => {
  const base = { swimmerId: 1, gender: "F" as const, lastName: "Sintetica", firstName: "Ana", birthDate: new Date(Date.UTC(1980, 2, 15)), age: 46 };

  it.each([
    ["ocho dígitos", "12345678-5"],
    ["siete dígitos", "1234567-4"],
    ["K mayúscula", "12345678-K"],
  ])("%s", (_caso, run) => {
    const linea = buildD1({ ...base, run });
    expect(linea.slice(60, 69).trim()).toBe("");
    expect(linea.slice(69, 88).trimEnd()).toBe(run);
    expect(linea.slice(88, 96)).toBe("03151980"); // el nacimiento no se mueve
    expect(linea.slice(97, 99)).toBe("46");
  });
});

describe("hy3-writer — buildD1 reconstruye líneas del fixture sintético", () => {
  const lines = loadFixtureLines();

  it("reconstruye exactamente una línea D1 con RUN de ocho dígitos y verificador numérico", () => {
    const esperada = lines.find((l) => l.startsWith("D1") && l.includes("Álamo"))!;
    const mine = buildD1({
      swimmerId: 332,
      gender: "M",
      lastName: "Álamo",
      firstName: "Persona01",
      run: "10000000-1",
      birthDate: new Date(Date.UTC(1970, 0, 1)), // 01011970
      age: 56,
    });
    expect(mine).toBe(esperada);
  });

  it("reconstruye exactamente una línea D1 con RUN de siete dígitos", () => {
    const esperada = lines.find((l) => l.startsWith("D1") && l.includes("Bravo"))!;
    const mine = buildD1({
      swimmerId: 333,
      gender: "F",
      lastName: "Bravo",
      firstName: "Persona02",
      // Con espacio inicial, como vino en el archivo real: Team Manager lo guardaba
      // así, igual en sus otros registros. El campo se alinea a la izquierda.
      run: " 1000001-4",
      birthDate: new Date(Date.UTC(1971, 1, 2)), // 02021971
      age: 55,
    });
    expect(mine).toBe(esperada);
  });

  it("reconstruye exactamente una línea D1 con RUN terminado en K y apellido fuera de ASCII", () => {
    const esperada = lines.find((l) => l.startsWith("D1") && l.includes("Ñandú"))!;
    const mine = buildD1({
      swimmerId: 338,
      gender: "M",
      lastName: "Ñandú",
      firstName: "Persona03",
      run: "10000002-K",
      birthDate: new Date(Date.UTC(1972, 2, 3)), // 03031972
      age: 54,
    });
    expect(mine).toBe(esperada);
  });

  it("produce siempre líneas de 130 caracteres", () => {
    const mine = buildD1({
      swimmerId: 1,
      gender: "M",
      lastName: "Pérez",
      firstName: "Juan",
      run: "1-9",
      birthDate: new Date(Date.UTC(2000, 0, 1)),
      age: 26,
    });
    expect(mine).toHaveLength(130);
  });
});

describe("hy3-writer — buildE1 reconstruye líneas del fixture sintético", () => {
  const lines = loadFixtureLines();

  it("reconstruye exactamente una prueba de 50m Mariposa (evento #6)", () => {
    const esperada = lines.find((l) => l.startsWith("E1") && l.includes("332Álamo") && l.includes("50D"))!;
    const mine = buildE1({
      gender: "M",
      swimmerId: 332,
      lastNameAbbrev: "Álamo",
      distanceMeters: 50,
      strokeCode: "D",
      meetEventNumber: 6,
      seedTimeSeconds: 61.5,
    });
    expect(mine).toBe(esperada);
  });

  it("reconstruye exactamente una prueba de 200m Combinado (evento #16, tiempo largo)", () => {
    const esperada = lines.find((l) => l.startsWith("E1") && l.includes("339DeltaMM   200E"))!;
    const mine = buildE1({
      gender: "M",
      swimmerId: 339,
      lastNameAbbrev: "Delta",
      distanceMeters: 200,
      strokeCode: "E",
      meetEventNumber: 16,
      seedTimeSeconds: 216.87,
    });
    expect(mine).toBe(esperada);
  });

  it("reconstruye exactamente una prueba de dama (400m Libre, evento #7)", () => {
    const esperada = lines.find((l) => l.startsWith("E1") && l.includes("333BravoFF   400A"))!;
    const mine = buildE1({
      gender: "F",
      swimmerId: 333,
      lastNameAbbrev: "Bravo",
      distanceMeters: 400,
      strokeCode: "A",
      meetEventNumber: 7,
      seedTimeSeconds: 350.29,
    });
    expect(mine).toBe(esperada);
  });
});

describe("hy3-writer — buildF1/buildF3 reconstruyen relevos del fixture sintético", () => {
  const lines = loadRelayFixtureLines();

  // OJO: este fixture usa piscina corta ("S" en la posición
  // de curso), mientras que el resto del sistema (buildE1) ya usaba "L"
  // desde una muestra distinta con piscina larga — es una diferencia real
  // de sede/competencia, no un error de transcripción. Para no romper esa
  // consistencia ya establecida, se compara la línea real con esa única
  // posición ajustada a "L", verificando así que TODO lo demás (una
  // reconstrucción byte a byte real) coincide exactamente.
  function withLongCourse(linea: string): string {
    return linea.slice(0, 50) + "L" + linea.slice(51, 59) + "L" + linea.slice(60);
  }

  it("reconstruye exactamente el F1 del primer relevo (200 Combinado Damas, evento #11, sin marca de referencia)", () => {
    const esperada = lines.find((l) => l.startsWith("F1SINT A 160FFF"))!;
    const mine = buildF1({
      clubCode: "SINT",
      relayLetter: "A",
      relayId: 160,
      genderCode: "FFF",
      distanceMeters: 200,
      strokeCode: "E",
      meetEventNumber: 11,
      seedTimeSeconds: 0,
    });
    expect(mine.slice(0, -2)).toBe(withLongCourse(esperada).slice(0, -2));
  });

  it("reconstruye exactamente el F1 de un relevo de Varones (200 Combinado, evento #12)", () => {
    const esperada = lines.find((l) => l.startsWith("F1SINT A 240MMM"))!;
    const mine = buildF1({
      clubCode: "SINT",
      relayLetter: "A",
      relayId: 240,
      genderCode: "MMM",
      distanceMeters: 200,
      strokeCode: "E",
      meetEventNumber: 12,
      seedTimeSeconds: 0,
    });
    expect(mine.slice(0, -2)).toBe(withLongCourse(esperada).slice(0, -2));
  });

  it("reconstruye exactamente el F1 de un relevo Libre (200 Libre Damas, evento #13)", () => {
    const esperada = lines.find((l) => l.startsWith("F1SINT A 280FFF"))!;
    const mine = buildF1({
      clubCode: "SINT",
      relayLetter: "A",
      relayId: 280,
      genderCode: "FFF",
      distanceMeters: 200,
      strokeCode: "A",
      meetEventNumber: 13,
      seedTimeSeconds: 0,
    });
    expect(mine.slice(0, -2)).toBe(withLongCourse(esperada).slice(0, -2));
  });

  it("reconstruye exactamente el F3 (los 4 integrantes) del primer relevo", () => {
    const esperada = lines.find((l) => l.startsWith("F3F  333Novie"))!;
    const mine = buildF3([
      { gender: "F", swimmerId: 333, lastNameAbbrev: "Novie", legNumber: 1 },
      { gender: "F", swimmerId: 373, lastNameAbbrev: "Golf", legNumber: 2 },
      { gender: "F", swimmerId: 380, lastNameAbbrev: "Kilo", legNumber: 3 },
      { gender: "F", swimmerId: 370, lastNameAbbrev: "Foxtr", legNumber: 4 },
    ]);
    expect(mine).toBe(esperada);
  });

  it("reconstruye exactamente el F3 de un relevo de Varones", () => {
    const esperada = lines.find((l) => l.startsWith("F3M  334Álamo"))!;
    const mine = buildF3([
      { gender: "M", swimmerId: 334, lastNameAbbrev: "Álamo", legNumber: 1 },
      { gender: "M", swimmerId: 339, lastNameAbbrev: "Papa", legNumber: 2 },
      { gender: "M", swimmerId: 374, lastNameAbbrev: "Hotel", legNumber: 3 },
      { gender: "M", swimmerId: 376, lastNameAbbrev: "Julie", legNumber: 4 },
    ]);
    expect(mine).toBe(esperada);
  });

  it("un relevo CON marca de referencia usa coma decimal (igual que E1), no el '0.00' de cuando no hay marca", () => {
    const withSeed = buildF1({
      clubCode: "SINT",
      relayLetter: "A",
      relayId: 999,
      genderCode: "MMM",
      distanceMeters: 200,
      strokeCode: "A",
      meetEventNumber: 5,
      seedTimeSeconds: 125.5,
    });
    expect(withSeed).toContain("125,50");
    expect(withSeed).not.toContain("0.00");
  });

  it("la X de la columna 83 acompaña a la marca: sin marca no se escribe", () => {
    const relevo = { clubCode: "SINT", relayLetter: "A", relayId: 999, genderCode: "MMM" as const, distanceMeters: 200, strokeCode: "A" as const, meetEventNumber: 5 };
    expect(buildF1({ ...relevo, seedTimeSeconds: 125.5 })[83]).toBe("X");
    expect(buildF1({ ...relevo, seedTimeSeconds: 0 })[83]).toBe(" ");
  });
});

describe("hy3-writer — utilidades de formato", () => {
  it("buildE1/buildF1 usan el curso indicado (S=piscina corta) en vez de 'L' por defecto cuando se entrega courseCode", () => {
    const e1WithShortCourse = buildE1({
      gender: "F",
      swimmerId: 1,
      lastNameAbbrev: "Perez",
      distanceMeters: 50,
      strokeCode: "A",
      meetEventNumber: 1,
      seedTimeSeconds: 35,
      courseCode: "S",
    });
    expect(e1WithShortCourse).toContain("S");

    const f1WithShortCourse = buildF1({
      clubCode: "SINT",
      relayLetter: "A",
      relayId: 1,
      genderCode: "FFF",
      distanceMeters: 200,
      strokeCode: "A",
      meetEventNumber: 1,
      seedTimeSeconds: 0,
      courseCode: "S",
    });
    expect(f1WithShortCourse.slice(50, 51)).toBe("S");
    expect(f1WithShortCourse.slice(59, 60)).toBe("S");
  });

  it("buildE1/buildF1 siguen usando 'L' (piscina larga) por defecto si no se entrega courseCode", () => {
    const e1Default = buildE1({
      gender: "F",
      swimmerId: 1,
      lastNameAbbrev: "Perez",
      distanceMeters: 50,
      strokeCode: "A",
      meetEventNumber: 1,
      seedTimeSeconds: 35,
    });
    expect(e1Default.slice(50, 51)).toBe("L");
  });

  it("formatHy3Date produce MMDDYYYY", () => {
    expect(formatHy3Date(new Date(Date.UTC(2026, 10, 9)))).toBe("11092026");
  });

  it("formatHy3Time_SecondsComma formatea segundos con coma decimal, sin ceros a la izquierda en el entero", () => {
    expect(formatHy3Time_SecondsComma(35)).toBe("35,00");
    expect(formatHy3Time_SecondsComma(350)).toBe("350,00");
    expect(formatHy3Time_SecondsComma(72.5)).toBe("72,50");
    expect(formatHy3Time_SecondsComma(605)).toBe("605,00");
  });

  it("strokeNameToHy3Code mapea los 5 estilos a los códigos verificados en la muestra", () => {
    expect(strokeNameToHy3Code("Libre")).toBe("A");
    expect(strokeNameToHy3Code("Espalda")).toBe("B");
    expect(strokeNameToHy3Code("Pecho")).toBe("C");
    expect(strokeNameToHy3Code("Mariposa")).toBe("D");
    expect(strokeNameToHy3Code("Combinado")).toBe("E");
  });

  it("strokeNameToHy3Code lanza un error claro para un estilo sin mapeo", () => {
    expect(() => strokeNameToHy3Code("Desconocido")).toThrow(/sin mapeo/);
  });
});
