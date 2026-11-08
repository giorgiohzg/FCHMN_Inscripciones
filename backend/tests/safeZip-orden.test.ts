/**
 * AUD-02 — el conteo de entradas se comprueba ANTES de materializarlas.
 *
 * `adm-zip` define sus métodos en cada instancia, no en el prototipo, así que no se
 * puede espiar desde fuera: este archivo reemplaza el módulo por un envoltorio que
 * cuenta las llamadas a `getEntries()` y deja pasar todo lo demás. Va aparte de
 * `safeZip.test.ts` porque `vi.mock` afecta a todo el archivo que lo declara.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readSingleEntryFromZip } from "../src/shared/safeZip";
import { construirZip } from "./helpers/zipSintetico";
import { ValidationError } from "../src/shared/errors";
import type AdmZip from "adm-zip";

const llamadas = vi.hoisted(() => ({ getEntries: 0 }));

vi.mock("adm-zip", async (importOriginal) => {
  const Real = (await importOriginal<{ default: typeof AdmZip }>()).default;
  const Envoltorio = function (this: unknown, ...args: ConstructorParameters<typeof AdmZip>) {
    const instancia = new Real(...args);
    const original = instancia.getEntries.bind(instancia);
    instancia.getEntries = () => {
      llamadas.getEntries++;
      return original();
    };
    return instancia;
  };
  return { default: Envoltorio };
});

const OPCIONES = { allowedExtensions: [".ev3"], encoding: "latin1" as const, notFoundMessage: "no hay .ev3" };

beforeEach(() => {
  llamadas.getEntries = 0;
});

describe("readSingleEntryFromZip: orden de las comprobaciones", () => {
  it("un ZIP pequeño de 513 entradas se rechaza sin construir ninguna entrada", () => {
    const entradas = Array.from({ length: 513 }, (_, i) => ({ nombre: `f${i}.txt`, contenido: "x" }));
    const buffer = construirZip(entradas);
    expect(buffer.length, "sigue siendo un archivo pequeño").toBeLessThan(100_000);

    expect(() => readSingleEntryFromZip(buffer, OPCIONES)).toThrow(/declara 513 entradas/);
    expect(llamadas.getEntries).toBe(0);
  });

  it("un índice que declara 60.000 entradas se rechaza por lo declarado, sin leerlo", () => {
    const buffer = construirZip([{ nombre: "p.ev3", contenido: "x" }], { totalEntradas: 60_000 });

    expect(() => readSingleEntryFromZip(buffer, OPCIONES)).toThrow(/declara 60000 entradas/);
    expect(llamadas.getEntries).toBe(0);
  });

  it("el control de que el envoltorio cuenta: un ZIP válido sí llama a getEntries() una vez", async () => {
    const { default: Real } = await vi.importActual<{ default: typeof AdmZip }>("adm-zip");
    const zip = new Real();
    zip.addFile("p.ev3", Buffer.from("ok", "latin1"));
    const buffer = zip.toBuffer();

    expect(readSingleEntryFromZip(buffer, OPCIONES).content).toBe("ok");
    expect(llamadas.getEntries).toBe(1);
  });

  it("una entrada dañada (CRC que no coincide) es un error CONTROLADO, no una excepción de la librería", () => {
    // `construirZip` deja el CRC en cero: la librería lo rechaza al descomprimir.
    const buffer = construirZip([{ nombre: "p.ev3", contenido: "ok" }]);
    let error: unknown;
    try {
      readSingleEntryFromZip(buffer, OPCIONES);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toMatch(/dañado/);
  });
});
