/**
 * Semáforo de Argon2 (C-02 / C-04) y verificación de tres estados, sin base de datos.
 *
 * Argon2 se sustituye por dobles controlados (`vi.spyOn`) para fijar cuándo termina cada
 * derivación: lo que se prueba es el semáforo, no el tiempo real de Argon2.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import argon2 from "argon2";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

/** Un proceso nuevo: semáforo vacío y sin hash ficticio. */
const modulo = () => import("../src/modules/auth/password.util");

function diferido<T>() {
  let resolver!: (v: T) => void;
  let rechazar!: (e: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

describe("semáforo de Argon2", () => {
  it("no deja más de `max` derivaciones en curso; las demás esperan su turno", async () => {
    const m = await modulo();
    m.configurarSemaforoArgon2({ max: 2, cola: 10, esperaMs: 5_000 });
    const pendientes = [diferido<boolean>(), diferido<boolean>(), diferido<boolean>()];
    let llamada = 0;
    vi.spyOn(argon2, "verify").mockImplementation(() => pendientes[llamada++]!.promesa);

    const resultados = [m.verifyPassword("h", "a"), m.verifyPassword("h", "b"), m.verifyPassword("h", "c")];
    await new Promise((r) => setImmediate(r));
    expect(m.estadoSemaforoArgon2()).toMatchObject({ enCurso: 2, enEspera: 1 });
    expect(llamada, "la tercera aún no llamó a Argon2").toBe(2);

    pendientes[0]!.resolver(true);
    await resultados[0];
    await new Promise((r) => setImmediate(r));
    expect(llamada, "al liberarse un cupo pasa la siguiente").toBe(3);
    pendientes[1]!.resolver(false);
    pendientes[2]!.resolver(true);
    expect(await Promise.all(resultados)).toEqual([true, false, true]);
    expect(m.estadoSemaforoArgon2()).toMatchObject({ enCurso: 0, enEspera: 0 });
  });

  it("con la cola llena lanza SaturacionArgon2 sin llamar a Argon2", async () => {
    const m = await modulo();
    m.configurarSemaforoArgon2({ max: 1, cola: 1, esperaMs: 5_000 });
    const bloqueo = diferido<boolean>();
    const verificar = vi.spyOn(argon2, "verify").mockImplementation(() => bloqueo.promesa);

    const primera = m.verifyPassword("h", "a");
    const segunda = m.verifyPassword("h", "b"); // en cola
    await expect(m.verifyPassword("h", "c")).rejects.toBeInstanceOf(m.SaturacionArgon2);
    expect(verificar).toHaveBeenCalledTimes(1);

    bloqueo.resolver(false);
    await primera;
    await segunda;
  });

  it("si la espera supera `esperaMs` lanza SaturacionArgon2 y sale de la cola", async () => {
    const m = await modulo();
    m.configurarSemaforoArgon2({ max: 1, cola: 5, esperaMs: 100 });
    const bloqueo = diferido<boolean>();
    vi.spyOn(argon2, "verify").mockImplementation(() => bloqueo.promesa);

    const primera = m.verifyPassword("h", "a");
    await expect(m.verifyPassword("h", "b")).rejects.toBeInstanceOf(m.SaturacionArgon2);
    expect(m.estadoSemaforoArgon2().enEspera).toBe(0);
    bloqueo.resolver(true);
    expect(await primera).toBe(true);
  });

  it("una saturación es un 503, no un 401", async () => {
    const m = await modulo();
    const e = new m.SaturacionArgon2();
    expect(e.statusCode).toBe(503);
    expect(m.esErrorNeutroDeArgon2(e)).toBe(true);
  });

  it("libera el cupo aunque la derivación falle", async () => {
    const m = await modulo();
    m.configurarSemaforoArgon2({ max: 1, cola: 0, esperaMs: 1_000 });
    vi.spyOn(argon2, "verify").mockRejectedValueOnce(new Error("fallo nativo")).mockResolvedValueOnce(true);
    await expect(m.verifyPassword("h", "a")).rejects.toBeInstanceOf(m.ErrorTecnicoArgon2);
    expect(await m.verifyPassword("h", "a"), "el cupo quedó libre").toBe(true);
  });

  it("rechaza una adquisición anidada", async () => {
    const m = await modulo();
    await expect(m.conArgon2(() => m.hashPassword("x"))).rejects.toThrow(/anidada/);
    expect(m.estadoSemaforoArgon2().enCurso).toBe(0);
  });

  it("la verificación ficticia genera su hash DENTRO del mismo cupo (con un solo cupo no se bloquea)", async () => {
    const m = await modulo();
    m.configurarSemaforoArgon2({ max: 1, cola: 0, esperaMs: 1_000 });
    const hash = vi.spyOn(argon2, "hash");
    const verificar = vi.spyOn(argon2, "verify");
    expect(await m.verificacionFicticia("cualquiera")).toBe(false);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(verificar).toHaveBeenCalledTimes(1);
    expect(m.estadoSemaforoArgon2().enCurso).toBe(0);
  });
});

describe("verificación de tres estados", () => {
  it("una excepción de argon2.verify se lanza como ErrorTecnicoArgon2, NUNCA como `false`", async () => {
    const m = await modulo();
    vi.spyOn(argon2, "verify").mockRejectedValue(new Error("hash con formato inválido"));
    await expect(m.verifyPassword("no-es-un-hash", "x")).rejects.toBeInstanceOf(m.ErrorTecnicoArgon2);
  });

  it("un hash mal formado real también es un error técnico", async () => {
    const m = await modulo();
    await expect(m.verifyPassword("no-es-un-hash", "x")).rejects.toBeInstanceOf(m.ErrorTecnicoArgon2);
  });

  it("una contraseña que no coincide sigue siendo `false`", async () => {
    const m = await modulo();
    const hash = await m.hashPassword("MiClave123");
    expect(await m.verifyPassword(hash, "OtraClave456")).toBe(false);
  });
});
