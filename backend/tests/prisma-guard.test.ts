/**
 * La protección de las pruebas unitarias contra el cliente real de Prisma (`helpers/prisma-guard.ts`).
 *
 * Todo es DETERMINISTA y no carga el motor nativo: `@prisma/client` se simula aquí con un
 * constructor espía, de modo que lo que se mide es si el singleton LLAMA al constructor, no si
 * el motor se carga. No se repite nada para buscar estadísticamente un fallo intermitente.
 *
 * Lo que esto demuestra es el AISLAMIENTO: con la protección, importar el singleton no construye
 * un cliente. No demuestra la causa del pánico intermitente de la CI, que sigue sin probarse.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const construcciones = vi.hoisted(() => vi.fn());

vi.mock("@prisma/client", () => ({
  // Un constructor de verdad (con `new`), que solo cuenta las llamadas.
  PrismaClient: function PrismaClientEspia(this: object) {
    construcciones();
    Object.assign(this, { esElEspia: true });
  },
}));

// La misma marca que usa la protección (registro global de símbolos). NO se importa el helper: importarlo
// ejecutaría la instalación y enmascararía que `setupFiles` no la hizo.
const MARCA_DEL_DOBLE = Symbol.for("fchmn.prismaGuard");

const global = globalThis as { __prisma?: unknown };
/** Lo que dejó `setupFiles` antes de que corriera ninguna prueba de este archivo. */
const instaladoPorLaConfiguracion = global.__prisma;
const BACKEND = join(__dirname, "..");
const leer = (...partes: string[]) => readFileSync(join(BACKEND, ...partes), "utf8");

beforeEach(() => {
  vi.resetModules();
  construcciones.mockClear();
});

afterEach(() => {
  // El control de sensibilidad borra el doble y el singleton deja el espía: se repone EXACTAMENTE lo que había,
  // sin instalar nada por su cuenta (si setupFiles no lo instaló, esto lo deja sin instalar).
  if (instaladoPorLaConfiguracion === undefined) delete global.__prisma;
  else global.__prisma = instaladoPorLaConfiguracion;
});

describe("el doble está instalado antes de cada archivo", () => {
  it("globalThis.__prisma es el doble de la protección, no un cliente", () => {
    const doble = global.__prisma as Record<symbol, unknown>;
    expect(doble).toBeDefined();
    expect(doble[MARCA_DEL_DOBLE]).toBe(true);
  });
});

describe("importar el singleton protegido NO construye un cliente real", () => {
  it("no llama al constructor y entrega el doble", async () => {
    const { prisma } = await import("../src/shared/prisma.client");

    expect(construcciones).not.toHaveBeenCalled();
    expect((prisma as unknown as Record<symbol, unknown>)[MARCA_DEL_DOBLE]).toBe(true);
    expect(prisma).toBe(global.__prisma);
  });

  it("importarlo varias veces seguidas tampoco lo construye", async () => {
    for (let i = 0; i < 3; i++) {
      vi.resetModules();
      await import("../src/shared/prisma.client");
    }
    expect(construcciones).not.toHaveBeenCalled();
  });

  it("CONTROL DE SENSIBILIDAD: sin el doble, el mismo import SÍ llama al constructor (la prueba detecta el problema)", async () => {
    delete global.__prisma;

    await import("../src/shared/prisma.client");

    expect(construcciones).toHaveBeenCalledTimes(1);
  });
});

describe("un uso inesperado falla con un mensaje claro", () => {
  async function doble() {
    return (await import("../src/shared/prisma.client")).prisma as unknown as Record<string, unknown>;
  }

  it.each(["person", "club", "pool", "$transaction", "$connect", "$disconnect", "$queryRaw", "$use"])("leer prisma.%s lanza, y dice qué hacer", async (uso) => {
    const prisma = await doble();

    expect(() => prisma[uso]).toThrow(/cliente real de Prisma/);
    expect(() => prisma[uso]).toThrow(new RegExp(`prisma\\.${uso.replace("$", "\\$")}`));
    expect(() => prisma[uso]).toThrow(/vi\.mock/);
    expect(() => prisma[uso]).toThrow(/integraci/);
  });

  it("no devuelve nada que pueda pasar por un resultado: ni lista vacía, ni éxito, ni función", async () => {
    const prisma = await doble();

    const leer = (): unknown => {
      try {
        return prisma.person;
      } catch {
        return "lanzó";
      }
    };
    expect(leer()).toBe("lanzó");
  });

  it("asignarle algo también lanza", async () => {
    const prisma = await doble();

    expect(() => {
      prisma.person = {};
    }).toThrow(/cliente real de Prisma/);
  });

  it("las sondas que no son uso no lo rompen: await, símbolos y JSON", async () => {
    const prisma = await doble();

    await expect(Promise.resolve(prisma)).resolves.toBe(prisma); // `then` no se confunde con un modelo
    expect(await (async () => prisma)()).toBe(prisma);
    expect(prisma[Symbol.toStringTag as unknown as string]).toBeUndefined();
    expect(JSON.stringify(prisma)).toBe("{}");
    expect(() => String(Object.keys(prisma))).not.toThrow();
  });
});

describe("la protección vive solo en la configuración unitaria", () => {
  it("vitest.config.ts la registra en setupFiles", () => {
    expect(leer("vitest.config.ts")).toMatch(/setupFiles:\s*\[\s*"tests\/helpers\/prisma-guard\.ts"\s*\]/);
  });

  it.each(["vitest.integration.config.ts", "vitest.coverage.config.ts"])("%s NO la usa y conserva sus protecciones de base de datos", (config) => {
    const texto = leer(config);
    expect(texto).not.toContain("prisma-guard");
    expect(texto).toContain("integration.setup.ts");
    expect(texto).toContain("integration.env.ts");
  });

  it("el archivo de la protección no importa servicios ni el cliente real", () => {
    // Solo el CÓDIGO: la documentación del archivo sí menciona el constructor.
    const codigo = leer("tests", "helpers", "prisma-guard.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const imports = codigo.split("\n").filter((l) => /^\s*(import\b|export\s+.*\s+from\b|.*\brequire\()/.test(l));
    expect(imports, "sin imports").toEqual([]);
    expect(codigo).not.toMatch(/PrismaClient|@prisma\/client/);
  });

  it("no se modificó el singleton de producción: sigue consultando globalThis.__prisma", () => {
    expect(leer("src", "shared", "prisma.client.ts")).toContain("globalThis.__prisma ?? new PrismaClient()");
  });
});
