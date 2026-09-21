import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { parseEv3File } from "../src/modules/meet-import/ev3-parser";

const FIXTURE_PATH = path.join(__dirname, "fixtures", "sample.ev3");

describe("ev3-parser — parseEv3File contra el fixture sintético", () => {
  const content = fs.readFileSync(FIXTURE_PATH, "latin1");
  const result = parseEv3File(content);

  it("lee el nombre de la competencia desde el encabezado", () => {
    expect(result.name).toBe("Competencia Sintética de Pruebas");
  });

  it("lee las fechas de inicio, fin y corte de edad", () => {
    // Inicio y fin coinciden: la competencia sintética es de un solo día,
    // porque la importación rechaza los .ev3 que abarcan más de uno.
    expect(result.startDate.toISOString().slice(0, 10)).toBe("2030-01-01");
    expect(result.endDate.toISOString().slice(0, 10)).toBe("2030-01-01");
    expect(result.ageCutoffDate.toISOString().slice(0, 10)).toBe("2030-12-31");
  });

  it("interpreta las 14 pruebas del fixture sin advertencias", () => {
    expect(result.events).toHaveLength(14);
    expect(result.warnings).toHaveLength(0);
  });

  it("interpreta correctamente una prueba individual (200 Libre Damas)", () => {
    const ev = result.events.find((e) => e.eventNumber === 1)!;
    expect(ev.isRelay).toBe(false);
    expect(ev.gender).toBe("female");
    expect(ev.distanceMeters).toBe(200);
    expect(ev.strokeName).toBe("Libre");
    expect(ev.sessionTime).toBe("09:00AM");
  });

  it("interpreta correctamente una prueba individual de mariposa (100 Mariposa Varones)", () => {
    const ev = result.events.find((e) => e.eventNumber === 4)!;
    expect(ev.isRelay).toBe(false);
    expect(ev.gender).toBe("male");
    expect(ev.distanceMeters).toBe(100);
    expect(ev.strokeName).toBe("Mariposa");
  });

  it("interpreta correctamente un relevo combinado (200 Combinado Relevo Damas)", () => {
    const ev = result.events.find((e) => e.eventNumber === 11)!;
    expect(ev.isRelay).toBe(true);
    expect(ev.gender).toBe("female");
    expect(ev.distanceMeters).toBe(200);
    expect(ev.strokeName).toBe("Combinado");
  });

  it("interpreta correctamente un relevo libre (200 Libre Relevo Varones)", () => {
    const ev = result.events.find((e) => e.eventNumber === 14)!;
    expect(ev.isRelay).toBe(true);
    expect(ev.gender).toBe("male");
    expect(ev.distanceMeters).toBe(200);
    expect(ev.strokeName).toBe("Libre");
  });

  it("mantiene el orden original de las pruebas (número de prueba = orden en el programa)", () => {
    const numbers = result.events.map((e) => e.eventNumber);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });
});

describe("ev3-parser — casos sintéticos (formato inválido / campos raros)", () => {
  function buildContent(headerFields: string[], eventLines: string[]): string {
    return [headerFields.join(";") + "*>", ...eventLines].join("\r\n");
  }

  const validHeader = ["Mi Competencia", "Sede", "03/28/2026", "03/28/2026", "12/31/2026"];

  it("lanza un error claro si la fecha de inicio es ilegible", () => {
    const bad = ["Mi Competencia", "Sede", "no-es-fecha", "03/28/2026", "12/31/2026"];
    expect(() => parseEv3File(buildContent(bad, []))).toThrow(/fecha de inicio/i);
  });

  it("lanza un error claro si la fecha de corte de edad es ilegible", () => {
    const bad = ["Mi Competencia", "Sede", "03/28/2026", "03/28/2026", "no-es-fecha"];
    expect(() => parseEv3File(buildContent(bad, []))).toThrow(/fecha de corte/i);
  });

  it("omite (con advertencia) una prueba con código de estilo no reconocido, sin abortar el archivo completo", () => {
    // Campo [9] = "Z" (estilo inválido), resto de campos de relleno hasta el índice 23.
    const line = "1;1;F;1;I;W;0;109;200;Z;0;;;N;0;;;;;;;1;1;1;09:45AM*>";
    const result = parseEv3File(buildContent(validHeader, [line]));
    expect(result.events).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("estilo"))).toBe(true);
  });

  it("omite (con advertencia) una prueba con género no reconocido", () => {
    const line = "1;1;F;1;I;Z;0;109;200;A;0;;;N;0;;;;;;;1;1;1;09:45AM*>";
    const result = parseEv3File(buildContent(validHeader, [line]));
    expect(result.events).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("género"))).toBe(true);
  });

  it("interpreta el género 'X' como mixto si llegara a aparecer", () => {
    const line = "1;1;F;1;I;X;0;109;200;A;0;;;N;0;;;;;;;1;1;1;09:45AM*>";
    const result = parseEv3File(buildContent(validHeader, [line]));
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.gender).toBe("mixed");
  });
});
