/**
 * `listaAcotada` (SEC-01): el tope de longitud se comprueba ANTES de validar elementos.
 *
 * La demostración es DETERMINISTA: un esquema de elemento que cuenta cuántas veces se le pide validar.
 * Con exceso, el contador queda en CERO. No depende de tiempos ni de memoria; el control de
 * sensibilidad muestra que la misma entrada con `.max()` de Zod 3 SÍ valida todos los elementos.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { listaAcotada } from "../src/shared/listaAcotada";

const MENSAJE = "Demasiados elementos";

function elementoContado() {
  const contador = { validaciones: 0 };
  const elemento = z.string().refine(() => {
    contador.validaciones++;
    return false; // todo elemento es inválido: así cada validación produce un error
  }, "elemento inválido");
  return { contador, elemento };
}

describe("rechazo temprano: con exceso NO se valida ningún elemento", () => {
  it("límite + 1: un único error y 0 validaciones de elementos", () => {
    const { contador, elemento } = elementoContado();
    const esquema = z.object({ lista: listaAcotada(3, z.array(elemento), MENSAJE) });

    const resultado = esquema.safeParse({ lista: ["a", "b", "c", "d"] });

    expect(resultado.success).toBe(false);
    expect(contador.validaciones).toBe(0);
    if (!resultado.success) {
      expect(resultado.error.issues).toHaveLength(1);
      expect(resultado.error.flatten().fieldErrors).toEqual({ lista: [MENSAJE] });
    }
  });

  it("una lista enorme sigue siendo UN error (no uno por elemento) y 0 validaciones", () => {
    const { contador, elemento } = elementoContado();
    const esquema = z.object({ lista: listaAcotada(8, z.array(elemento), MENSAJE) });

    const resultado = esquema.safeParse({ lista: Array.from({ length: 200_000 }, () => "x") });

    expect(contador.validaciones).toBe(0);
    expect(resultado.success).toBe(false);
    if (!resultado.success) expect(resultado.error.issues).toHaveLength(1);
  });

  it("CONTROL DE SENSIBILIDAD: con `.max()` de Zod 3 la misma entrada SÍ valida todos los elementos", () => {
    const { contador, elemento } = elementoContado();
    const esquema = z.object({ lista: z.array(elemento).max(3, MENSAJE) });

    const resultado = esquema.safeParse({ lista: ["a", "b", "c", "d"] });

    expect(contador.validaciones).toBe(4);
    expect(resultado.success).toBe(false);
    if (!resultado.success) expect(resultado.error.issues.length).toBeGreaterThan(1);
  });
});

describe("dentro del límite se comporta como el esquema interno", () => {
  it("en el límite exacto valida todos los elementos y devuelve los datos", () => {
    const esquema = z.object({ lista: listaAcotada(3, z.array(z.string()), MENSAJE) });
    const resultado = esquema.safeParse({ lista: ["a", "b", "c"] });
    expect(resultado.success).toBe(true);
    if (resultado.success) expect(resultado.data.lista).toEqual(["a", "b", "c"]);
  });

  it("dentro del límite con elementos inválidos: un error por elemento, como siempre", () => {
    const { contador, elemento } = elementoContado();
    const esquema = z.object({ lista: listaAcotada(3, z.array(elemento), MENSAJE) });

    const resultado = esquema.safeParse({ lista: ["a", "b", "c"] });

    expect(contador.validaciones).toBe(3);
    expect(resultado.success).toBe(false);
    if (!resultado.success) expect(resultado.error.issues).toHaveLength(3);
  });

  it("conserva los mínimos y sus mensajes del esquema interno", () => {
    const esquema = z.object({ lista: listaAcotada(3, z.array(z.string()).min(2, "al menos dos"), MENSAJE) });
    const resultado = esquema.safeParse({ lista: ["a"] });
    expect(resultado.success).toBe(false);
    if (!resultado.success) expect(resultado.error.flatten().fieldErrors).toEqual({ lista: ["al menos dos"] });
  });

  it.each([
    ["ausente", undefined, "Required"],
    ["null", null, "Expected array, received null"],
    ["texto", "abc", "Expected array, received string"],
    ["objeto", {}, "Expected array, received object"],
  ])("un valor que no es lista (%s) lo rechaza el esquema interno con su mensaje", (_nombre, valor, mensaje) => {
    const esquema = z.object({ lista: listaAcotada(3, z.array(z.string()), MENSAJE) });
    const resultado = esquema.safeParse(valor === undefined ? {} : { lista: valor });
    expect(resultado.success).toBe(false);
    if (!resultado.success) expect(resultado.error.flatten().fieldErrors).toEqual({ lista: [mensaje] });
  });
});

describe("combinada con .optional(): «no enviado» sigue siendo «no tocar»", () => {
  const esquema = z.object({ lista: listaAcotada(3, z.array(z.string()), MENSAJE).optional() });

  it("ausente es válido y sigue ausente", () => {
    const resultado = esquema.safeParse({});
    expect(resultado.success).toBe(true);
    if (resultado.success) expect("lista" in resultado.data).toBe(false);
  });

  it("enviada pero vacía es válida y NO es lo mismo que ausente", () => {
    const resultado = esquema.safeParse({ lista: [] });
    expect(resultado.success).toBe(true);
    if (resultado.success) expect(resultado.data.lista).toEqual([]);
  });

  it("con exceso se rechaza igual", () => {
    const resultado = esquema.safeParse({ lista: ["a", "b", "c", "d"] });
    expect(resultado.success).toBe(false);
    if (!resultado.success) expect(resultado.error.flatten().fieldErrors).toEqual({ lista: [MENSAJE] });
  });
});
