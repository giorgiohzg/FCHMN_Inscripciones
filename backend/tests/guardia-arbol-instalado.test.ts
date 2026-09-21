/**
 * Pruebas de la GUARDIA B (`scripts/verificar-arbol-instalado.mjs`).
 *
 * La guardia corre dentro de la construcción, donde no hay nada instalado que
 * la vigile. Por eso se prueba aquí, contra árboles SINTÉTICOS creados en un
 * directorio temporal: nunca toca el `node_modules` real del proyecto.
 *
 * Se comprueban los dos sentidos. Una guardia que solo se ha visto aprobar no
 * está probada: hay que verla rechazar cada caso que debe rechazar, y hay que
 * verla fallar CERRADA cuando no puede leer lo que necesita.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARDIA = join(__dirname, "..", "scripts", "verificar-arbol-instalado.mjs");

let RAIZ_TEMPORAL: string;

beforeAll(() => {
  RAIZ_TEMPORAL = mkdtempSync(join(tmpdir(), "guardia-b-"));
});

afterAll(() => {
  rmSync(RAIZ_TEMPORAL, { recursive: true, force: true });
});

interface EntradaFixture {
  version: string;
  dev?: boolean;
  devOptional?: boolean;
  optional?: boolean;
  peer?: boolean;
}

/** Crea un caso: un lockfile y un árbol instalado, ambos sintéticos. */
function crearCaso(
  nombre: string,
  paquetesLockfile: Record<string, EntradaFixture>,
  instalados: Record<string, { name: string; version: string }>,
  extras?: (raiz: string) => void
): string {
  const raiz = join(RAIZ_TEMPORAL, nombre);
  mkdirSync(raiz, { recursive: true });
  writeFileSync(
    join(raiz, "package-lock.json"),
    JSON.stringify({ name: "caso", lockfileVersion: 3, packages: { "": { name: "caso" }, ...paquetesLockfile } }, null, 1)
  );
  mkdirSync(join(raiz, "node_modules"), { recursive: true });
  for (const [ruta, manifiesto] of Object.entries(instalados)) {
    const dir = join(raiz, ...ruta.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifiesto));
  }
  if (extras) extras(raiz);
  return raiz;
}

function ejecutar(raiz: string): { codigo: number; salida: string } {
  const r = spawnSync(process.execPath, [GUARDIA, "--raiz", raiz], { encoding: "utf8" });
  return { codigo: r.status ?? -1, salida: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Un árbol conforme mínimo, reutilizado como punto de partida. */
const LOCK_BASE: Record<string, EntradaFixture> = {
  "node_modules/alfa": { version: "1.0.0" },
  "node_modules/@ambito/beta": { version: "2.0.0" },
  "node_modules/alfa/node_modules/gamma": { version: "3.0.0" },
  "node_modules/solo-dev": { version: "9.0.0", dev: true },
  "node_modules/solo-devoptional": { version: "9.1.0", devOptional: true },
  "node_modules/solo-optional": { version: "9.2.0", optional: true },
  "node_modules/solo-peer": { version: "9.3.0", peer: true },
};
const ARBOL_BASE: Record<string, { name: string; version: string }> = {
  "node_modules/alfa": { name: "alfa", version: "1.0.0" },
  "node_modules/@ambito/beta": { name: "@ambito/beta", version: "2.0.0" },
  "node_modules/alfa/node_modules/gamma": { name: "gamma", version: "3.0.0" },
};

describe("guardia B — casos POSITIVOS: debe aprobar", () => {
  it("aprueba un árbol que coincide exactamente con el lockfile", () => {
    const raiz = crearCaso("positivo-exacto", LOCK_BASE, ARBOL_BASE);
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("GUARDIA B: conforme");
    expect(codigo).toBe(0);
  });

  it("cuenta las tres entradas sin marcas y las cuatro marcadas", () => {
    const raiz = crearCaso("positivo-recuento", LOCK_BASE, ARBOL_BASE);
    const { salida } = ejecutar(raiz);
    expect(salida).toContain("entradas sin marcas (exigidas): 3");
    expect(salida).toContain("entradas marcadas (prohibidas): 4");
    expect(salida).toContain("paquetes instalados           : 3");
  });

  it("resuelve los paquetes anidados por su ruta completa, no por su nombre", () => {
    // `gamma` solo existe dentro de `alfa`. Si la guardia comparase por nombre
    // suelto, un `gamma` en la raíz pasaría por bueno.
    const raiz = crearCaso("positivo-anidado", LOCK_BASE, ARBOL_BASE);
    expect(ejecutar(raiz).codigo).toBe(0);
  });

  it("NO confunde `.bin`, `.prisma` ni `.cache` con paquetes npm", () => {
    const raiz = crearCaso("positivo-artefactos", LOCK_BASE, ARBOL_BASE, (r) => {
      mkdirSync(join(r, "node_modules", ".bin"), { recursive: true });
      mkdirSync(join(r, "node_modules", ".prisma", "client"), { recursive: true });
      mkdirSync(join(r, "node_modules", ".cache"), { recursive: true });
      writeFileSync(join(r, "node_modules", ".package-lock.json"), "{}");
      // El cliente generado lleva su propio package.json y NO figura en el
      // lockfile: si se contara como paquete, la guardia fallaría en falso.
      writeFileSync(
        join(r, "node_modules", ".prisma", "client", "package.json"),
        JSON.stringify({ name: ".prisma/client", version: "0.0.0" })
      );
    });
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("artefactos generados, no son paquetes: 3");
    expect(salida).toContain("node_modules/.bin");
    expect(salida).toContain("node_modules/.prisma");
    expect(salida).toContain("node_modules/.cache");
    expect(codigo).toBe(0);
  });

  it("ignora los archivos sueltos dentro de node_modules", () => {
    const raiz = crearCaso("positivo-archivos", LOCK_BASE, ARBOL_BASE, (r) => {
      writeFileSync(join(r, "node_modules", "LEEME.txt"), "no soy un paquete");
    });
    expect(ejecutar(raiz).codigo).toBe(0);
  });
});

describe("guardia B — casos NEGATIVOS: debe rechazar", () => {
  it("rechaza si falta una entrada sin marcas", () => {
    const arbol = { ...ARBOL_BASE };
    delete arbol["node_modules/@ambito/beta"];
    const raiz = crearCaso("negativo-falta", LOCK_BASE, arbol);
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("FALLA todas las entradas sin marcas estan instaladas");
    expect(salida).toContain("node_modules/@ambito/beta@2.0.0");
    expect(codigo).toBe(1);
  });

  it("rechaza si una entrada `devOptional` está instalada", () => {
    // Este es EXACTAMENTE el defecto que originó la guardia.
    const raiz = crearCaso("negativo-devoptional", LOCK_BASE, {
      ...ARBOL_BASE,
      "node_modules/solo-devoptional": { name: "solo-devoptional", version: "9.1.0" },
    });
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("FALLA ninguna entrada marcada esta instalada");
    expect(salida).toContain("[devOptional]");
    expect(codigo).toBe(1);
  });

  it.each([
    ["solo-dev", "9.0.0", "dev"],
    ["solo-optional", "9.2.0", "optional"],
    ["solo-peer", "9.3.0", "peer"],
  ])("rechaza si una entrada `%s` está instalada", (paquete, version, marca) => {
    const raiz = crearCaso("negativo-marca-" + marca, LOCK_BASE, {
      ...ARBOL_BASE,
      ["node_modules/" + paquete]: { name: paquete, version },
    });
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("[" + marca + "]");
    expect(codigo).toBe(1);
  });

  it("rechaza si una versión instalada no coincide con el lockfile", () => {
    const raiz = crearCaso("negativo-version", LOCK_BASE, {
      ...ARBOL_BASE,
      "node_modules/alfa": { name: "alfa", version: "1.0.1" },
    });
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("FALLA ninguna version difiere del lockfile");
    expect(salida).toContain("lockfile=1.0.0 instalado=1.0.1");
    expect(codigo).toBe(1);
  });

  it("rechaza si un nombre instalado no coincide con su ruta en el lockfile", () => {
    const raiz = crearCaso("negativo-nombre", LOCK_BASE, {
      ...ARBOL_BASE,
      "node_modules/alfa": { name: "otro-nombre", version: "1.0.0" },
    });
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("FALLA ningun nombre difiere del lockfile");
    expect(codigo).toBe(1);
  });

  it("rechaza un paquete instalado que el lockfile no declara", () => {
    const raiz = crearCaso("negativo-intruso", LOCK_BASE, {
      ...ARBOL_BASE,
      "node_modules/intruso": { name: "intruso", version: "0.0.1" },
    });
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("FALLA ningun paquete instalado falta en el lockfile");
    expect(salida).toContain("node_modules/intruso");
    expect(codigo).toBe(1);
  });

  it("rechaza un directorio de paquete sin `package.json` legible", () => {
    const raiz = crearCaso("negativo-sin-manifiesto", LOCK_BASE, ARBOL_BASE, (r) => {
      mkdirSync(join(r, "node_modules", "roto"), { recursive: true });
    });
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("FALLA todo paquete instalado tiene manifiesto legible");
    expect(codigo).toBe(1);
  });

  it("rechaza un `package.json` presente pero sin versión", () => {
    const raiz = crearCaso("negativo-sin-version", LOCK_BASE, ARBOL_BASE, (r) => {
      const d = join(r, "node_modules", "sin-version");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "package.json"), JSON.stringify({ name: "sin-version" }));
    });
    expect(ejecutar(raiz).codigo).toBe(1);
  });
});

describe("guardia B — FALLA CERRADA: nunca aprueba por omisión", () => {
  it("falla con código 2 si no existe el lockfile", () => {
    const raiz = join(RAIZ_TEMPORAL, "cerrada-sin-lockfile");
    mkdirSync(join(raiz, "node_modules"), { recursive: true });
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("no se pudo leer el lockfile");
    expect(codigo).toBe(2);
  });

  it("falla con código 2 si el lockfile no trae el objeto `packages`", () => {
    const raiz = join(RAIZ_TEMPORAL, "cerrada-lockfile-viejo");
    mkdirSync(join(raiz, "node_modules"), { recursive: true });
    writeFileSync(join(raiz, "package-lock.json"), JSON.stringify({ lockfileVersion: 1, dependencies: {} }));
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("lockfileVersion 2 o 3");
    expect(codigo).toBe(2);
  });

  it("falla con código 2 si el lockfile no es JSON válido", () => {
    const raiz = join(RAIZ_TEMPORAL, "cerrada-json-roto");
    mkdirSync(join(raiz, "node_modules"), { recursive: true });
    writeFileSync(join(raiz, "package-lock.json"), "{ esto no es json");
    expect(ejecutar(raiz).codigo).toBe(2);
  });

  it("falla con código 2 si no existe el árbol instalado", () => {
    const raiz = join(RAIZ_TEMPORAL, "cerrada-sin-arbol");
    mkdirSync(raiz, { recursive: true });
    writeFileSync(join(raiz, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("no existe el árbol instalado");
    expect(codigo).toBe(2);
  });

  it("falla con código 2 ante una entrada de lockfile fuera de node_modules", () => {
    const raiz = join(RAIZ_TEMPORAL, "cerrada-workspace");
    mkdirSync(join(raiz, "node_modules"), { recursive: true });
    writeFileSync(
      join(raiz, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "paquetes/interno": { version: "1.0.0" } } })
    );
    const { codigo, salida } = ejecutar(raiz);
    expect(salida).toContain("fuera de node_modules");
    expect(codigo).toBe(2);
  });

  it("falla con código 2 sin argumentos", () => {
    const r = spawnSync(process.execPath, [GUARDIA], { encoding: "utf8" });
    expect(r.stderr).toContain("se requiere --raiz");
    expect(r.status).toBe(2);
  });

  it("falla con código 2 ante un argumento desconocido", () => {
    const r = spawnSync(process.execPath, [GUARDIA, "--raiz", RAIZ_TEMPORAL, "suelto"], { encoding: "utf8" });
    expect(r.stderr).toContain("argumento inesperado");
    expect(r.status).toBe(2);
  });

  it("falla con código 2 si una opción se queda sin valor", () => {
    const r = spawnSync(process.execPath, [GUARDIA, "--raiz"], { encoding: "utf8" });
    expect(r.stderr).toContain("falta el valor de");
    expect(r.status).toBe(2);
  });
});

describe("guardia B — el caso real que la originó", () => {
  it("rechaza el árbol de `--omit=dev`, que dejaba los seis paquetes de Prisma", () => {
    // Reproducción reducida del defecto medido: el lockfile los marca
    // `devOptional` y `npm ci --omit=dev` los instalaba igualmente.
    const lock: Record<string, EntradaFixture> = {
      "node_modules/@prisma/client": { version: "5.22.0" },
      "node_modules/prisma": { version: "5.22.0", devOptional: true },
      "node_modules/@prisma/engines": { version: "5.22.0", devOptional: true },
    };
    const conCli = {
      "node_modules/@prisma/client": { name: "@prisma/client", version: "5.22.0" },
      "node_modules/prisma": { name: "prisma", version: "5.22.0" },
      "node_modules/@prisma/engines": { name: "@prisma/engines", version: "5.22.0" },
    };
    const raizMala = crearCaso("real-omit-dev", lock, conCli, (r) => {
      // En el árbol real `.bin/prisma` es un enlace simbólico, pero crear
      // enlaces en Windows exige privilegios y esta prueba no debe depender de
      // ellos. Lo que se comprueba es que `.bin` NO se cuenta como paquete,
      // y para eso basta un archivo corriente.
      mkdirSync(join(r, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(r, "node_modules", ".bin", "prisma"), "#!/bin/sh\n");
    });
    const malo = ejecutar(raizMala);
    expect(malo.salida).toContain("node_modules/prisma@5.22.0 [devOptional]");
    expect(malo.codigo).toBe(1);

    // Y aprueba el árbol de `--omit=dev --omit=optional`, sin ellos.
    const raizBuena = crearCaso("real-omit-optional", lock, {
      "node_modules/@prisma/client": { name: "@prisma/client", version: "5.22.0" },
    });
    expect(ejecutar(raizBuena).codigo).toBe(0);
  });
});
