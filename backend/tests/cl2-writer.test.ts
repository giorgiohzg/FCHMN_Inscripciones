/**
 * El CL2 y el paquete de Team Manager, con un conjunto de datos INVENTADO.
 *
 * El formato se decodificó contra una exportación real, y los generadores
 * reconstruyeron ese archivo byte a byte en una comprobación fuera del
 * repositorio: el archivo real tiene datos de personas y no entra aquí. Estas
 * pruebas fijan las posiciones descubiertas entonces y comprueban que HY3 y CL2
 * dicen exactamente lo mismo.
 */
import { describe, it, expect } from "vitest";
import {
  CL2_LINE_LENGTH,
  buildCl2File,
  buildCl2Line,
  computeCl2Checksum,
  formatCl2Time,
  isValidCl2Line,
} from "../src/modules/team-manager-export/cl2-writer";
import { buildHy3File } from "../src/modules/team-manager-export/hy3-writer";
import { computeHy3Checksum } from "../src/modules/team-manager-export/hy3-checksum";
import { textoExportable, type ExportSwimmer, type TeamManagerExportModel } from "../src/modules/team-manager-export/export-model";

const utc = (y: number, m: number, d: number, h = 0, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min));

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

const MODELO: TeamManagerExportModel = {
  generatedAt: utc(2030, 1, 3, 15, 54),
  meet: {
    name: "Copa Sintetica 2030",
    facility: "sede",
    startDate: utc(2030, 11, 8),
    endDate: utc(2030, 11, 9),
    ageUpDate: utc(2030, 12, 31),
    courseCode: "S",
  },
  club: { code: "SINT", name: "Club Sintetico" },
  swimmers: [
    // Solo relevos: D1 en HY3, y en CL2 únicamente sus F0.
    nadador(1, { lastName: "Solorrelevo", firstName: "Berta", run: "9999999-9", gender: "F", age: 41, ageAtMeet: 40 }),
    nadador(2, { lastName: "De la Fuente", firstName: "Carla", run: "12345678-K", gender: "F", entries: [
      { distanceMeters: 50, strokeCode: "A", meetEventNumber: 3, seedTimeSeconds: 35 },
      { distanceMeters: 400, strokeCode: "E", meetEventNumber: 12, seedTimeSeconds: 754.2 },
      { distanceMeters: 100, strokeCode: "C", meetEventNumber: 7, seedTimeSeconds: 0 },
    ] }),
    nadador(3, { lastName: "Nuñez", firstName: "Dora", run: "7654321-0", entries: [
      { distanceMeters: 200, strokeCode: "B", meetEventNumber: 9, seedTimeSeconds: 83.45 },
    ] }),
    nadador(4, { lastName: "Ruiz", firstName: "Eva", run: "20000000-2", gender: "F", entries: [
      { distanceMeters: 100, strokeCode: "D", meetEventNumber: 21, seedTimeSeconds: 61.5 },
    ] }),
  ],
  relays: [
    {
      relayLetter: "A",
      relayId: 100,
      genderCode: "FFF",
      distanceMeters: 200,
      strokeCode: "A",
      meetEventNumber: 1,
      seedTimeSeconds: 175.38,
      legs: [
        { gender: "F", swimmerId: 2, lastNameAbbrev: "De la", legNumber: 1 },
        { gender: "F", swimmerId: 1, lastNameAbbrev: "Solor", legNumber: 2 },
        { gender: "F", swimmerId: 3, lastNameAbbrev: "Nuñez", legNumber: 3 },
        { gender: "F", swimmerId: 4, lastNameAbbrev: "Ruiz", legNumber: 4 },
      ],
    },
    {
      relayLetter: "A",
      relayId: 101,
      genderCode: "MIX",
      distanceMeters: 400,
      strokeCode: "E",
      meetEventNumber: 14,
      seedTimeSeconds: 0,
      legs: [
        { gender: "F", swimmerId: 3, lastNameAbbrev: "Nuñez", legNumber: 1 },
        { gender: "F", swimmerId: 4, lastNameAbbrev: "Ruiz", legNumber: 2 },
        { gender: "F", swimmerId: 2, lastNameAbbrev: "De la", legNumber: 3 },
        { gender: "F", swimmerId: 1, lastNameAbbrev: "Solor", legNumber: 4 },
      ],
    },
  ],
};

const lineas = (archivo: string) => archivo.split("\r\n").filter(Boolean);
const CL2 = lineas(buildCl2File(MODELO));
const HY3 = lineas(buildHy3File(MODELO));
const de = (archivo: string[], tipo: string) => archivo.filter((l) => l.startsWith(tipo));

describe("checksum CL2", () => {
  it("un cálculo hecho a mano: suma simple de 156 columnas, entre 19, más 11, con los dígitos invertidos", () => {
    // 156 espacios: 156 × 32 = 4992; 4992 / 19 = 262; 262 + 11 = 273 → unidades 3, decenas 7.
    expect(computeCl2Checksum(" ".repeat(156))).toBe("37");
    // Una "A" más (65 en vez de 32): 5025 / 19 = 264; 275 → "57".
    expect(computeCl2Checksum("A" + " ".repeat(155))).toBe("57");
  });

  it("NO pondera por posición: mover un carácter no lo cambia, a diferencia del HY3", () => {
    expect(computeCl2Checksum("z " + " ".repeat(154))).toBe(computeCl2Checksum(" z" + " ".repeat(154)));
    expect(computeHy3Checksum("z " + " ".repeat(126))).not.toBe(computeHy3Checksum(" z" + " ".repeat(126)));
  });

  it("no incluye las columnas 156-157: el espacio y la N son fijos", () => {
    const linea = buildCl2Line("X");
    expect(linea).toHaveLength(CL2_LINE_LENGTH);
    expect(linea.slice(156, 158)).toBe(" N");
    expect(linea.slice(158)).toBe(computeCl2Checksum(linea.slice(0, 156)));
  });

  it("los bytes altos cuentan con su valor Latin-1", () => {
    // ñ = 241: 155 × 32 + 241 = 5201; 5201 / 19 = 273; 284 → "48".
    expect(computeCl2Checksum("ñ" + " ".repeat(155))).toBe("48");
  });

  it("detecta un cambio de un carácter", () => {
    const linea = CL2[3]!;
    expect(isValidCl2Line(linea)).toBe(true);
    expect(isValidCl2Line(linea.slice(0, 20) + "Z" + linea.slice(21))).toBe(false);
    expect(isValidCl2Line(linea.slice(0, 159))).toBe(false);
  });
});

describe("tiempos CL2", () => {
  it.each([
    [35, "35,00"],
    [9.5, "9,50"],
    [59.99, "59,99"],
    [60, "1:00,00"],
    [83.45, "1:23,45"],
    [754.2, "12:34,20"],
    [0, "NT"],
  ])("%s s → %s", (segundos, esperado) => {
    expect(formatCl2Time(segundos)).toBe(esperado);
  });
});

describe("estructura del archivo CL2", () => {
  it("todas las líneas: 160 columnas, checksum válido y CRLF, también al final", () => {
    const archivo = buildCl2File(MODELO);
    expect(archivo.endsWith("\r\n")).toBe(true);
    expect(archivo.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(CL2.filter((l) => !isValidCl2Line(l))).toEqual([]);
  });

  it("el orden real: A0 B1 C1; por nadador D0, D3 y sus demás D0; E0 con sus cuatro F0; Z0", () => {
    expect(CL2.map((l) => l.slice(0, 2))).toEqual([
      "A0", "B1", "C1",
      "D0", "D3", "D0", "D0",
      "D0", "D3",
      "D0", "D3",
      "E0", "F0", "F0", "F0", "F0",
      "E0", "F0", "F0", "F0", "F0",
      "Z0",
    ]);
  });

  it("A0: fabricante, versión y fecha en sus columnas", () => {
    const a0 = CL2[0]!;
    expect(a0.slice(0, 13)).toBe("A01V3      20");
    expect(a0.slice(13, 25)).toBe("Meet Entries");
    expect(a0.slice(43, 54)).toBe("Hy-Tek, Ltd");
    expect(a0.slice(69, 73)).toBe("8.0D");
    expect(a0.slice(105, 113)).toBe("01032030");
    expect(a0.slice(149, 153)).toBe("TM41");
  });

  it("B1: fechas REALES de la competencia y curso, sin la fecha de corte", () => {
    const b1 = CL2[1]!;
    expect(b1.slice(11, 30)).toBe("Copa Sintetica 2030");
    expect(b1.slice(85, 89)).toBe("sede");
    expect(b1.slice(121, 137)).toBe("1108203011092030");
    expect(b1[149]).toBe("S");
    expect(b1).not.toContain("12312030");
  });

  it("C1: código ajustado a la derecha en seis columnas, nombre y país", () => {
    const c1 = CL2[2]!;
    expect(c1.slice(11, 17)).toBe("  SINT");
    expect(c1.slice(17, 31)).toBe("Club Sintetico");
    expect(c1.slice(139, 142)).toBe("CHI");
  });

  it("D0: cada campo en su columna", () => {
    const d0 = CL2[3]!;
    expect(d0.slice(11, 39).trimEnd()).toBe("De la Fuente, Carla");
    expect(d0.slice(39, 51)).toBe("12345678-K  ");
    expect(d0.slice(55, 63)).toBe("03151980");
    expect(d0.slice(63, 65)).toBe("46");
    expect(d0.slice(65, 67)).toBe("FF");
    expect(d0.slice(67, 71)).toBe("  50");
    expect(d0[71]).toBe("1");
    expect(d0.slice(72, 76)).toBe("  3 ");
    expect(d0.slice(76, 80)).toBe("UNOV");
    expect(d0.slice(88, 96)).toBe("   35,00");
    expect(d0[96]).toBe("S");
  });

  it("D3: el RUN y las constantes", () => {
    const d3 = CL2[4]!;
    expect(d3.slice(2, 16)).toBe("12345678-K    ");
    expect(d3[31]).toBe("X");
    expect(d3.slice(33, 46)).toBe("F".repeat(13));
  });

  it("E0 con marca: relevo libre (6), fecha de inicio, marca y la X de la columna 154", () => {
    const e0 = de(CL2, "E0")[0]!;
    expect(e0[11]).toBe("A");
    expect(e0.slice(12, 18)).toBe("  SINT");
    expect(e0[20]).toBe("F");
    expect(e0.slice(21, 25)).toBe(" 200");
    expect(e0[25]).toBe("6");
    expect(e0.slice(26, 30)).toBe("  1 ");
    expect(e0.slice(30, 34)).toBe("UNOV");
    expect(e0.slice(37, 45)).toBe("11082030");
    expect(e0.slice(45, 53)).toBe(" 2:55,38");
    expect(e0[53]).toBe("S");
    expect(e0[154]).toBe("X");
  });

  it("E0 sin marca: NT y sin X; combinado (7) y mixto (X)", () => {
    const e0 = de(CL2, "E0")[1]!;
    expect(e0[20]).toBe("X");
    expect(e0[25]).toBe("7");
    expect(e0.slice(45, 53)).toBe("      NT");
    expect(e0[154]).toBe(" ");
  });

  it("F0: la edad es a la fecha de la competencia; la de D0, a la de corte", () => {
    const f0 = de(CL2, "F0")[1]!; // Berta: 41 a la fecha de corte, 40 a la de competencia
    expect(f0.slice(11, 14)).toBe("  1");
    expect(f0.slice(15, 21)).toBe("  SINT");
    expect(f0[21]).toBe("A");
    expect(f0.slice(22, 50).trimEnd()).toBe("Solorrelevo, Berta");
    expect(f0.slice(50, 62)).toBe("9999999-9   ");
    expect(f0.slice(65, 73)).toBe("03151980");
    expect(f0.slice(73, 75)).toBe("40");
    expect(f0[75]).toBe("F");
    expect(f0.slice(76, 79)).toBe("000");
    expect(f0.slice(92, 106)).toBe("9999999-9     ");
  });

  it("Z0: los conteos del archivo; un nadador solo de relevos no cuenta como individual", () => {
    const z0 = CL2[CL2.length - 1]!;
    expect(z0.slice(11, 13)).toBe("02");
    expect(z0.slice(13, 43).trimEnd()).toBe("Successful Build on 01-03-2030");
    expect(z0.slice(43, 86)).toBe("  1  1   1   1     5     3    2     8     0");
  });

  it("un nombre largo se recorta a su campo sin desplazar nada", () => {
    const largo = buildCl2File({
      ...MODELO,
      swimmers: [nadador(1, { lastName: "A".repeat(20), firstName: "B".repeat(20), entries: MODELO.swimmers[1]!.entries })],
      relays: [],
    });
    const d0 = lineas(largo).find((l) => l.startsWith("D0"))!;
    expect(isValidCl2Line(d0)).toBe(true);
    expect(d0.slice(39, 49)).toBe("10000000-1");
  });
});

/**
 * HY3 Y CL2 DICEN LO MISMO. Se leen de vuelta de las líneas ya escritas, no del
 * modelo: una columna corrida en cualquiera de los dos formatos aparece aquí.
 */
describe("el HY3 y el CL2 representan las mismas inscripciones", () => {
  const nombrePorIdHy3 = new Map(
    de(HY3, "D1").map((l) => [
      Number(l.slice(5, 8)),
      { nombre: `${l.slice(8, 28).trim()}, ${l.slice(28, 48).trim()}`, run: l.slice(69, 88).trim(), nacimiento: l.slice(88, 96), sexo: l[2]! },
    ])
  );

  const segundos = (t: string) => {
    const limpio = t.trim().replace(",", ".");
    if (limpio === "NT" || limpio === "0.00") return 0;
    const [m, s] = limpio.includes(":") ? limpio.split(":") : ["0", limpio];
    return Math.round((Number(m) * 60 + Number(s)) * 100);
  };

  it("las mismas personas, con todos sus datos", () => {
    const hy3 = [...nombrePorIdHy3.values()].map((p) => `${p.nombre}|${p.run}|${p.nacimiento}|${p.sexo}`).sort();
    const cl2 = new Set([
      ...de(CL2, "D0").map((l) => `${l.slice(11, 39).trim()}|${l.slice(39, 51).trim()}|${l.slice(55, 63)}|${l[65]}`),
      ...de(CL2, "F0").map((l) => `${l.slice(22, 50).trim()}|${l.slice(50, 62).trim()}|${l.slice(65, 73)}|${l[75]}`),
    ]);
    expect([...cl2].sort()).toEqual(hy3);
    expect(hy3).toHaveLength(4);
  });

  it("las mismas pruebas individuales: persona, distancia, estilo, número y marca", () => {
    const ESTILOS: Record<string, string> = { A: "1", B: "2", C: "3", D: "4", E: "5" };
    const hy3 = de(HY3, "E1")
      .map((l) => {
        const p = nombrePorIdHy3.get(Number(l.slice(5, 8)))!;
        return [p.nombre, l.slice(15, 21).trim(), ESTILOS[l[21]!], l.slice(39, 41).trim(), segundos(l.slice(51, 59))].join("|");
      })
      .sort();
    const cl2 = de(CL2, "D0")
      .map((l) => [l.slice(11, 39).trim(), l.slice(67, 71).trim(), l[71], l.slice(72, 75).trim(), segundos(l.slice(88, 96))].join("|"))
      .sort();
    expect(cl2).toEqual(hy3);
    expect(cl2).toHaveLength(5);
  });

  it("los mismos relevos, con sus integrantes en el mismo orden", () => {
    const hy3 = de(HY3, "F3").map((l) =>
      [0, 1, 2, 3].map((i) => nombrePorIdHy3.get(Number(l.slice(5 + i * 13, 8 + i * 13)))!.nombre)
    );
    const f0 = de(CL2, "F0").map((l) => l.slice(22, 50).trim());
    expect([f0.slice(0, 4), f0.slice(4, 8)]).toEqual(hy3);

    const marcasHy3 = de(HY3, "F1").map((l) => [l.slice(39, 41).trim(), l.slice(18, 21).trim(), segundos(l.slice(51, 59))].join("|"));
    const marcasCl2 = de(CL2, "E0").map((l) => [l.slice(26, 29).trim(), l.slice(21, 25).trim(), segundos(l.slice(45, 53))].join("|"));
    expect(marcasCl2).toEqual(marcasHy3);
  });

  it("la X del relevo con marca coincide en los dos formatos", () => {
    expect(de(HY3, "F1").map((l) => l[83])).toEqual(["X", " "]);
    expect(de(CL2, "E0").map((l) => l[154])).toEqual(["X", " "]);
  });
});

describe("textos para archivos de columnas fijas", () => {
  it("conserva Latin-1, cambia lo que no cabe y quita los saltos de línea", () => {
    expect(textoExportable("Muñoz Ávila")).toBe("Muñoz Ávila");
    expect(textoExportable("Pérez")).toBe("Pérez"); // forma descompuesta
    expect(textoExportable("Nguyễn")).toBe("Nguy?n");
    expect(textoExportable("a\r\nb")).toBe("a  b");
  });
});
