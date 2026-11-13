/** `useOperacionUnica`: la reserva es SÍNCRONA y un testigo antiguo no libera una operación posterior. */
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useOperacionUnica } from "./useOperacionUnica";

describe("useOperacionUnica", () => {
  it("dos iniciar() seguidos, antes del siguiente render, conceden UNA sola reserva", () => {
    const { result } = renderHook(() => useOperacionUnica());
    let primero: number | null = null;
    let segundo: number | null = null;
    act(() => {
      // La misma referencia del render anterior: la barrera no puede depender del estado pintado.
      const op = result.current;
      primero = op.iniciar();
      segundo = op.iniciar();
    });
    expect(primero).not.toBeNull();
    expect(segundo, "el segundo intento no reserva").toBeNull();
    expect(result.current.enCurso).toBe(true);
    expect(result.current.ocupada()).toBe(true);
  });

  it("un testigo ANTIGUO no libera la operación posterior; el vigente sí", () => {
    const { result } = renderHook(() => useOperacionUnica());
    let antiguo!: number;
    act(() => {
      antiguo = result.current.iniciar()!;
    });
    act(() => result.current.terminar(antiguo));
    let posterior!: number;
    act(() => {
      posterior = result.current.iniciar()!;
    });
    expect(posterior).not.toBe(antiguo);

    act(() => result.current.terminar(antiguo));
    expect(result.current.ocupada(), "el testigo antiguo no libera").toBe(true);
    expect(result.current.enCurso).toBe(true);
    let intruso: number | null = 0;
    act(() => {
      intruso = result.current.iniciar();
    });
    expect(intruso, "sigue reservada").toBeNull();

    act(() => result.current.terminar(posterior));
    expect(result.current.ocupada()).toBe(false);
    expect(result.current.enCurso).toBe(false);
  });

  it("la referencia es estable entre renders mientras no cambia el estado", () => {
    const { result, rerender } = renderHook(() => useOperacionUnica());
    const antes = result.current;
    rerender();
    expect(result.current).toBe(antes);
  });
});
