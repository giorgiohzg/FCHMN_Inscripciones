import { describe, it, expect } from "vitest";
import { computeHy3Checksum, buildHy3Line, HY3_CONTENT_LENGTH } from "../src/modules/team-manager-export/hy3-checksum";

/**
 * Muestras del formato HY3 tomadas de `fixtures/sample.hy3`.
 *
 * El fixture fue ANONIMIZADO: los nombres, identificadores, fechas de
 * nacimiento, el club y la competencia son sinteticos. Eso obliga a
 * distinguir dos cosas que antes iban juntas:
 *
 * - CHECKSUMS_DE_HY_TEK: lineas de encabezado sin dato alguno de persona,
 *   club, competencia o fecha del evento, que por eso la anonimizacion no
 *   toco. Su checksum es, byte a byte, el que escribio Hy-Tek en el archivo
 *   original: son la evidencia externa de que este algoritmo es correcto.
 *
 *   El registro A1 estaba aqui y tuvo que salir: lleva la fecha y la hora en
 *   que el Team Manager real genero el archivo, que son metadatos del evento
 *   y podian correlacionarse con resultados publicados.
 *
 * - CHECKSUMS_RECALCULADOS: lineas cuyo contenido cambio al anonimizar. Su
 *   checksum lo produjo este mismo modulo, asi que NO demuestran
 *   equivalencia con Hy-Tek; demuestran que el calculo se aplica de forma
 *   consistente a todas las formas de registro (A1, B1, C1, D1 y E1 con
 *   varios estilos y distancias), que es lo que cubrian antes.
 */
const CHECKSUMS_DE_HY_TEK: { content: string; checksum: string }[] = [
  { content: "B2                                                                                            06  L   0,00LO                    ", checksum: "61" },
  { content: "C2                                                                                                      CHI OTH                 ", checksum: "71" },
  { content: "C3                                                                                                                              ", checksum: "10" },
];

const CHECKSUMS_RECALCULADOS: { content: string; checksum: string }[] = [
  { content: "A102Meet Entries             Hy-Tek, Ltd    Win-TM 8.0De  01032030  9:00 AM EAM MANAGER Lite                                    ", checksum: "89" },
  { content: "B1Competencia Sintética de Pruebas             sint                                         010120300102203012312030            ", checksum: "70" },
  { content: "C1SINT Club Sintético de Pruebas                                                                                       MAS      ", checksum: "24" },
  { content: "D1M  332Álamo               Persona01                                10000000-1         01011970 56                             ", checksum: "89" },
  { content: "D1F  342Foxtrot             Persona06                                10000005-K         06061975 51                             ", checksum: "90" },
  { content: "E1M  339DeltaMM   100C  0109      0,00  4        0L  106,87L                               C                                    ", checksum: "47" },
  { content: "E1M  332ÁlamoMM   100A  0109      0,00 10        0L  100,00L                               C                                    ", checksum: "97" },
  { content: "E1F  333BravoFF   100B  0109      0,00 11        0L  111,29L                               C                                    ", checksum: "47" },
  { content: "E1M  339DeltaMM    50A  0109      0,00 14        0L   45,37L                               C                                    ", checksum: "37" },
  { content: "E1M  332ÁlamoMM   200E  0109      0,00 16        0L  213,00L                               C                                    ", checksum: "08" },
  { content: "E1M  332ÁlamoMM   400A  0109      0,00  8        0L  349,00L                               C                                    ", checksum: "97" },
];

describe("hy3-checksum — computeHy3Checksum contra los checksums originales de Hy-Tek", () => {
  it.each(CHECKSUMS_DE_HY_TEK)("reproduce el checksum '$checksum' que escribio Hy-Tek", ({ content, checksum }) => {
    expect(content.length).toBe(HY3_CONTENT_LENGTH);
    expect(computeHy3Checksum(content)).toBe(checksum);
  });
});

describe("hy3-checksum — computeHy3Checksum sobre todas las formas de registro", () => {
  it.each(CHECKSUMS_RECALCULADOS)("calcula el checksum '$checksum' de una linea del fixture sintetico", ({ content, checksum }) => {
    expect(content.length).toBe(HY3_CONTENT_LENGTH);
    expect(computeHy3Checksum(content)).toBe(checksum);
  });

  it("cubre los seis tipos de registro del encabezado y los de nadador y prueba", () => {
    const tipos = new Set([...CHECKSUMS_DE_HY_TEK, ...CHECKSUMS_RECALCULADOS].map((m) => m.content.slice(0, 2)));
    expect([...tipos].sort()).toEqual(["A1", "B1", "B2", "C1", "C2", "C3", "D1", "E1"]);
  });

  it("cubre los cinco estilos y varias distancias en los registros E1", () => {
    const e1 = CHECKSUMS_RECALCULADOS.filter((m) => m.content.startsWith("E1"));
    const estilos = new Set(e1.map((m) => m.content[21]));
    const distancias = new Set(e1.map((m) => m.content.slice(15, 21).trim()));
    expect(estilos.size).toBeGreaterThanOrEqual(4);
    expect(distancias.size).toBeGreaterThanOrEqual(3);
  });
});

describe("hy3-checksum — buildHy3Line", () => {
  it("agrega el checksum correcto y produce una línea de 130 caracteres", () => {
    const { content, checksum } = CHECKSUMS_DE_HY_TEK[0]!;
    const line = buildHy3Line(content);
    expect(line).toHaveLength(130);
    expect(line.slice(0, 128)).toBe(content);
    expect(line.slice(128, 130)).toBe(checksum);
  });

  it("rellena con espacios y trunca contenido más corto o más largo que 128 chars", () => {
    const short = buildHy3Line("A1TEST");
    expect(short).toHaveLength(130);

    const long = buildHy3Line("X".repeat(200));
    expect(long).toHaveLength(130);
    expect(long.slice(0, 128)).toBe("X".repeat(128));
  });

  it("el checksum calculado es determinístico (mismo contenido -> mismo checksum siempre)", () => {
    const { content } = CHECKSUMS_DE_HY_TEK[0]!;
    const a = computeHy3Checksum(content);
    const b = computeHy3Checksum(content);
    expect(a).toBe(b);
  });
});
