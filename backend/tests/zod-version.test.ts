/**
 * Guardia de la versión de Zod (SEC-03 C, GHSA-mrhx-c7xc-m3w5).
 *
 * El aviso afectaba a Zod anterior a 4.6.6 (agotamiento de memoria al validar arreglos enormes). Esta guardia impide que un cambio
 * futuro vuelva a una versión afectada o derive la validación hacia la capa de compatibilidad `zod/v3`, que no lleva la corrección.
 * Comprueba el bloqueo, lo INSTALADO y las importaciones; no ejecuta nada pesado.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BACKEND = join(__dirname, "..");
const MINIMA = [4, 6, 6];

const numeros = (v: string): number[] => v.split(/[.-]/).slice(0, 3).map(Number);
const esAlMenos = (v: string, minima: number[]): boolean => {
  const n = numeros(v);
  for (let i = 0; i < 3; i++) {
    if ((n[i] ?? 0) !== minima[i]!) return (n[i] ?? 0) > minima[i]!;
  }
  return true;
};

function archivosTs(dir: string, salida: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) archivosTs(ruta, salida);
    else if (e.isFile() && ruta.endsWith(".ts")) salida.push(ruta);
  }
  return salida;
}

describe("Zod: versión corregida y sin desvío a zod/v3", () => {
  const lock = JSON.parse(readFileSync(join(BACKEND, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
  const manifiesto = JSON.parse(readFileSync(join(BACKEND, "package.json"), "utf8")) as { dependencies: Record<string, string> };

  it("el bloqueo resuelve una sola Zod, de la serie 4 y no anterior a 4.6.6", () => {
    const entradas = Object.entries(lock.packages).filter(([ruta]) => ruta === "node_modules/zod" || ruta.endsWith("/node_modules/zod"));
    expect(entradas.map(([ruta]) => ruta), "debe haber una sola instancia de zod").toEqual(["node_modules/zod"]);
    const version = entradas[0]?.[1].version ?? "";
    expect(version.startsWith("4."), `zod ${version} no es de la serie 4`).toBe(true);
    expect(esAlMenos(version, MINIMA), `zod ${version} es anterior a 4.6.6 (GHSA-mrhx-c7xc-m3w5)`).toBe(true);
  });

  it("el manifiesto declara la serie 4 desde la corrección", () => {
    expect(manifiesto.dependencies["zod"]).toMatch(/^\^4\.6\.[6-9]|^\^4\.([7-9]|\d\d)\./);
  });

  it("lo instalado en disco coincide con el bloqueo", () => {
    const instalada = JSON.parse(readFileSync(join(BACKEND, "node_modules", "zod", "package.json"), "utf8")) as { version: string };
    expect(instalada.version).toBe(lock.packages["node_modules/zod"]?.version);
  });

  it("ninguna fuente, prueba ni script importa un subpath de zod (zod/v3, zod/v4, zod/mini…)", () => {
    const raices = ["src", "tests", "scripts", "prisma"].map((d) => join(BACKEND, d)).filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
    const infractores: string[] = [];
    for (const archivo of raices.flatMap((r) => archivosTs(r))) {
      if (archivo.endsWith("zod-version.test.ts")) continue;
      if (/(?:from\s+|require\(\s*|import\(\s*)["']zod\//.test(readFileSync(archivo, "utf8"))) infractores.push(archivo);
    }
    expect(infractores, "importan un subpath de zod").toEqual([]);
  });
});
