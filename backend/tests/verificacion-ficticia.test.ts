/**
 * Fase 2 — verificación ficticia de Argon2 (sin base de datos ni `.env`).
 *
 * Lo que se afirma: qué trabajo se hace y que su resultado nunca autentica. NO se comparan
 * tiempos de respuesta: no se afirma que sean iguales.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import argon2 from "argon2";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Un proceso nuevo: sin hash ficticio guardado. */
const modulo = () => import("../src/modules/auth/password.util");

describe("verificacionFicticia", () => {
  it("siempre devuelve falso, con cualquier entrada", async () => {
    const { verificacionFicticia } = await modulo();
    for (const entrada of ["ClaveValida123", "", "a".repeat(10_000), "\u0000", "ñandú", "admin", "password"]) {
      expect(await verificacionFicticia(entrada)).toBe(false);
    }
  });

  it("hace el trabajo de una verificación real: llama a argon2.verify contra un hash Argon2id", async () => {
    const { verificacionFicticia } = await modulo();
    const verificar = vi.spyOn(argon2, "verify");

    await verificacionFicticia("cualquiera");

    expect(verificar).toHaveBeenCalledTimes(1);
    expect(verificar.mock.calls[0]![0]).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verificar.mock.results[0]!.value).toBe(false);
  });

  it("calcula el hash UNA vez por proceso y lo reutiliza", async () => {
    const { verificacionFicticia } = await modulo();
    const hash = vi.spyOn(argon2, "hash");

    await verificacionFicticia("uno");
    await verificacionFicticia("dos");
    await Promise.all([verificacionFicticia("tres"), verificacionFicticia("cuatro")]);

    expect(hash).toHaveBeenCalledTimes(1);
  });

  it("peticiones simultáneas con el hash aún sin calcular comparten UN solo cálculo", async () => {
    const { verificacionFicticia } = await modulo();
    const hash = vi.spyOn(argon2, "hash");

    await Promise.all([1, 2, 3, 4, 5].map((n) => verificacionFicticia(`entrada-${n}`)));

    expect(hash).toHaveBeenCalledTimes(1);
  });

  it("usa los mismos parámetros que el hash real de contraseñas", async () => {
    const { verificacionFicticia, hashPassword } = await modulo();
    const verificar = vi.spyOn(argon2, "verify");

    await verificacionFicticia("x");
    const real = await hashPassword("ClaveValida123");

    const parametros = (h: string) => /\$argon2id\$v=\d+\$(m=\d+,t=\d+,p=\d+)\$/.exec(h)![1];
    expect(parametros(verificar.mock.calls[0]![0] as string)).toBe(parametros(real));
  });

  it("el secreto del hash ficticio es distinto en cada proceso", async () => {
    const primero = await modulo();
    const verificar = vi.spyOn(argon2, "verify");
    await primero.verificacionFicticia("x");
    const hashUno = verificar.mock.calls[0]![0];

    vi.resetModules();
    const segundo = await modulo();
    await segundo.verificacionFicticia("x");
    const hashDos = verificar.mock.calls[1]![0];

    expect(hashUno).not.toBe(hashDos);
  });

  it("un fallo del cálculo se propaga y NO queda guardado", async () => {
    const { verificacionFicticia } = await modulo();
    const hash = vi.spyOn(argon2, "hash").mockRejectedValueOnce(new Error("fallo sintético"));

    await expect(verificacionFicticia("x")).rejects.toThrow("fallo sintético");
    await expect(verificacionFicticia("x")).resolves.toBe(false);
    expect(hash).toHaveBeenCalledTimes(2);
  });
});
