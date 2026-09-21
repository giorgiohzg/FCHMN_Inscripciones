/**
 * Hallazgo 14 — ida y vuelta EV3 → modelo → HY3 de la distancia.
 *
 * El defecto: el parser .ev3 guardaba la distancia TOTAL del relevo (un 4×50
 * llega como 200, verificado contra la exportación real de Hy-Tek) y el
 * exportador la multiplicaba por 4 asumiendo que era por posta. Resultado:
 * un 4×50 importado se exportaba como un relevo de 800 metros, y el ciclo
 * importar → exportar no devolvía el mismo archivo.
 *
 * Estas pruebas fijan el contrato en las tres formas: relevo 4×50, relevo
 * 4×100 e individual.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEv3File } from "../src/modules/meet-import/ev3-parser";
import { buildE1, buildF1 } from "../src/modules/team-manager-export/hy3-writer";
import { relayTotalMetersForExport, metersPerLeg, formatDistanceLabel } from "../src/shared/relayDistance.util";

const SAMPLE_EV3 = readFileSync(join(__dirname, "fixtures", "sample.ev3"), "latin1");

/** Encabezado real + las líneas de prueba que se quieran ejercitar. */
function ev3ConLineas(...lineas: string[]): string {
  const encabezado = SAMPLE_EV3.split(/\r?\n/)[0]!;
  return [encabezado, ...lineas].join("\r\n");
}

/**
 * Distancia tal como la escribe el registro F1, en su posición de columna
 * fija: "F1"(2) + clubCode(5) + letra(1) + espacio(1) + relayId(3) +
 * genderCode(3) + relleno(3) = 18, y la distancia ocupa 3 caracteres.
 */
function distanciaEnF1(linea: string): number {
  return Number(linea.slice(18, 21).trim());
}

/**
 * Distancia del registro E1: "E1"(2) + gender(1) + relleno(2) +
 * swimmerId(3) + apellido(5) + gender duplicado(2) = 15, y la distancia
 * ocupa 6 caracteres.
 */
function distanciaEnE1(linea: string): number {
  return Number(linea.slice(15, 21).trim());
}

function f1(distanceMeters: number): string {
  return buildF1({
    clubCode: "CLBA",
    relayLetter: "A",
    relayId: 1,
    genderCode: "MIX",
    distanceMeters,
    strokeCode: "A",
    meetEventNumber: 1,
    seedTimeSeconds: 0,
  });
}

describe("EV3 → modelo: la distancia que llega es la TOTAL", () => {
  it("un relevo del fixture llega como 200 (4×50), no como 50", () => {
    const parsed = parseEv3File(SAMPLE_EV3);
    const relevos = parsed.events.filter((e) => e.isRelay);

    expect(relevos.length, "el fixture debe traer relevos").toBeGreaterThan(0);
    for (const relevo of relevos) {
      expect(relevo.distanceMeters, "el .ev3 declara la distancia total del relevo").toBe(200);
    }
  });

  it("un relevo 4×100 llega como 400", () => {
    const parsed = parseEv3File(ev3ConLineas("20;20;F;1;R;M;0;109;400;A;0;;;N;0;;;;;;;1;20;1;09:45AM;S;4;3;1;4*>"));
    expect(parsed.events[0]!.isRelay).toBe(true);
    expect(parsed.events[0]!.distanceMeters).toBe(400);
  });

  it("una prueba individual llega con su distancia sin alterar", () => {
    const parsed = parseEv3File(ev3ConLineas("21;21;F;1;I;W;0;109;50;B;0;;;N;0;;;;;;;1;21;1;09:45AM;S;4;3;1;0*>"));
    expect(parsed.events[0]!.isRelay).toBe(false);
    expect(parsed.events[0]!.distanceMeters).toBe(50);
  });
});

describe("modelo → HY3: la distancia se exporta sin volver a multiplicar", () => {
  it("4×50 (200 en el modelo) se exporta como 200 en el registro F1", () => {
    const linea = f1(relayTotalMetersForExport(200));
    expect(distanciaEnF1(linea)).toBe(200);
  });

  it("4×100 (400 en el modelo) se exporta como 400, no como 1600", () => {
    const linea = f1(relayTotalMetersForExport(400));
    expect(distanciaEnF1(linea)).toBe(400);
    expect(distanciaEnF1(linea)).not.toBe(1600);
  });

  it("una prueba individual de 50 se exporta como 50 en el registro E1", () => {
    const linea = buildE1({
      gender: "F",
      swimmerId: 1,
      lastNameAbbrev: "PEREZ",
      distanceMeters: 50,
      strokeCode: "A",
      meetEventNumber: 1,
      seedTimeSeconds: 0,
    });
    expect(distanciaEnE1(linea)).toBe(50);
  });
});

describe("ida y vuelta completa EV3 → modelo → HY3", () => {
  const casos = [
    { titulo: "4×50 combinado", linea: "30;30;F;1;R;W;0;109;200;E;0;;;N;0;;;;;;;1;30;1;09:45AM;S;4;3;1;4*>", esperado: 200 },
    { titulo: "4×100 libre", linea: "31;31;F;1;R;M;0;109;400;A;0;;;N;0;;;;;;;1;31;1;09:45AM;S;4;3;1;4*>", esperado: 400 },
    { titulo: "4×200 libre", linea: "32;32;F;1;R;M;0;109;800;A;0;;;N;0;;;;;;;1;32;1;09:45AM;S;4;3;1;4*>", esperado: 800 },
  ];

  for (const caso of casos) {
    it(`${caso.titulo}: lo que entra es lo que sale (${caso.esperado} m)`, () => {
      const parsed = parseEv3File(ev3ConLineas(caso.linea));
      const distanciaEnElModelo = parsed.events[0]!.distanceMeters;
      expect(distanciaEnElModelo).toBe(caso.esperado);

      const linea = f1(relayTotalMetersForExport(distanciaEnElModelo));
      expect(distanciaEnF1(linea), "exportar no debe alterar la distancia importada").toBe(caso.esperado);
    });
  }

  it("una prueba individual también sobrevive la ida y vuelta", () => {
    const parsed = parseEv3File(ev3ConLineas("33;33;F;1;I;W;0;109;100;D;0;;;N;0;;;;;;;1;33;1;09:45AM;S;4;3;1;0*>"));
    const linea = buildE1({
      gender: "F",
      swimmerId: 1,
      lastNameAbbrev: "PEREZ",
      distanceMeters: parsed.events[0]!.distanceMeters,
      strokeCode: "D",
      meetEventNumber: 1,
      seedTimeSeconds: 0,
    });
    expect(distanciaEnE1(linea)).toBe(100);
  });
});

describe("presentación de la distancia de un relevo", () => {
  it("muestra 4×50 a partir de un total de 200", () => {
    expect(formatDistanceLabel(200, 4)).toBe("4×50");
    expect(metersPerLeg(200, 4)).toBe(50);
  });

  it("muestra la distancia tal cual en pruebas individuales", () => {
    expect(formatDistanceLabel(50, 1)).toBe("50");
    expect(metersPerLeg(50, 1)).toBeNull();
  });

  it("si el total no es divisible entre los integrantes, muestra el total sin inventar postas", () => {
    expect(formatDistanceLabel(150, 4)).toBe("150");
    expect(metersPerLeg(150, 4)).toBeNull();
  });
});
