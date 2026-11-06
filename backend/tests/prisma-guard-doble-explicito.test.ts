/**
 * Los dobles EXPLÍCITOS de las pruebas siguen siendo los que se usan, con la protección activa.
 *
 * La protección pone un doble en `globalThis.__prisma`, pero una prueba que simula el singleton con
 * `vi.mock(".../prisma.client")` reemplaza el módulo entero: el servicio recibe SU doble, y el de la
 * protección no llega a consultarse. Aquí se comprueba con un servicio real (`pools.service`).
 */
import { describe, it, expect, vi } from "vitest";

// La marca de la protección (registro global de símbolos); no se importa el helper para no ejecutar su instalación.
const MARCA_DEL_DOBLE = Symbol.for("fchmn.prismaGuard");

const explicito = vi.hoisted(() => ({
  pool: { findMany: vi.fn(), findFirst: vi.fn() },
}));

vi.mock("../src/shared/prisma.client", () => ({ prisma: explicito }));

describe("doble explícito con la protección activa", () => {
  it("la protección está instalada, pero el singleton que ven los servicios es el explícito", async () => {
    expect((globalThis as { __prisma?: Record<symbol, unknown> }).__prisma?.[MARCA_DEL_DOBLE]).toBe(true);

    const { prisma } = await import("../src/shared/prisma.client");

    expect(prisma).toBe(explicito);
    expect((prisma as unknown as Record<symbol, unknown>)[MARCA_DEL_DOBLE]).toBeUndefined();
  });

  it("un servicio real usa el doble explícito y recibe lo que éste devuelve", async () => {
    explicito.pool.findMany.mockResolvedValueOnce([{ id: "p1", name: "Piscina Sintética" }]);
    const { listPools } = await import("../src/modules/pools/pools.service");

    const piscinas = await listPools({ search: "  Sintética ", page: 1, pageSize: 20 } as never);

    expect(piscinas).toEqual([{ id: "p1", name: "Piscina Sintética" }]);
    expect(explicito.pool.findMany).toHaveBeenCalledTimes(1);
    expect(explicito.pool.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, name: { contains: "Sintética", mode: "insensitive" } },
      orderBy: { name: "asc" },
    });
  });

  it("un modelo que el doble explícito no define falla por sí mismo, sin pasar por la protección", async () => {
    const { getPoolById } = await import("../src/modules/pools/pools.service");
    explicito.pool.findFirst.mockResolvedValueOnce(null);

    await expect(getPoolById("no-existe")).rejects.toThrow(/no encontrado/i);
  });
});
