/** C-05, fase 3: formulario de baja con fecha de término ELEGIDA. Datos sintéticos, jsdom. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BajaDeMembresiaDialog } from "./BajaDeMembresiaDialog";

const HOY = "2026-11-12";
const MEMBRESIA = { id: "m-1", startDate: "2026-03-10T00:00:00.000Z", person: { id: "p-1", fullName: "Nadadora Sintética", run: "11111111-1" }, club: { id: "c-1", name: "Club Uno" } };

function montar(parcial: Partial<typeof MEMBRESIA> = {}, props: Partial<Parameters<typeof BajaDeMembresiaDialog>[0]> = {}) {
  const onConfirmar = vi.fn();
  const onCancelar = vi.fn();
  render(<BajaDeMembresiaDialog membresia={{ ...MEMBRESIA, ...parcial }} hoy={HOY} enviando={false} error={null} onConfirmar={onConfirmar} onCancelar={onCancelar} {...props} />);
  const fecha = screen.getByLabelText(/Fecha de término/) as HTMLInputElement;
  const confirmar = screen.getByRole("button", { name: /Confirmar baja|Registrando/ });
  const elegir = (v: string) => fireEvent.change(fecha, { target: { value: v } });
  return { onConfirmar, onCancelar, fecha, confirmar, elegir };
}

describe("BajaDeMembresiaDialog", () => {
  it("la fecha empieza VACÍA y es obligatoria: sin ella no se puede confirmar", () => {
    const { fecha, confirmar } = montar();
    expect(fecha.value, "sin valor por omisión oculto").toBe("");
    expect(fecha).toBeRequired();
    expect(confirmar).toBeDisabled();
  });

  it("el calendario va de máximo hoy (Santiago) a mínimo el inicio conocido", () => {
    const { fecha } = montar();
    expect(fecha.max).toBe(HOY);
    expect(fecha.min).toBe("2026-03-10");
  });

  it("explica que es el último día de pertenencia y que no modifica inscripciones anteriores", () => {
    montar();
    expect(screen.getByText(/último día en que el nadador perteneció al club/)).toBeInTheDocument();
    expect(screen.getByText(/no modifica inscripciones ni operaciones anteriores/)).toBeInTheDocument();
  });

  it("acepta una fecha RETROACTIVA y la envía expresamente", () => {
    const { elegir, confirmar, onConfirmar } = montar();
    elegir("2026-06-30");
    expect(confirmar).toBeEnabled();
    fireEvent.click(confirmar);
    expect(onConfirmar).toHaveBeenCalledWith({ fechaTermino: "2026-06-30" });
  });

  it("acepta HOY y la fecha IGUAL al inicio", () => {
    const a = montar();
    a.elegir(HOY);
    fireEvent.click(a.confirmar);
    expect(a.onConfirmar).toHaveBeenLastCalledWith({ fechaTermino: HOY });
    a.elegir("2026-03-10");
    fireEvent.click(a.confirmar);
    expect(a.onConfirmar).toHaveBeenLastCalledWith({ fechaTermino: "2026-03-10" });
  });

  it("rechaza una fecha FUTURA o ANTERIOR al inicio, sin enviar", () => {
    const { elegir, confirmar, onConfirmar } = montar();
    elegir("2026-11-13");
    expect(confirmar).toBeDisabled();
    expect(screen.getByText(/No puede ser posterior a hoy/)).toBeInTheDocument();
    fireEvent.click(confirmar);
    elegir("2026-03-09");
    expect(confirmar).toBeDisabled();
    expect(screen.getByText(/No puede ser anterior al inicio/)).toBeInTheDocument();
    fireEvent.click(confirmar);
    expect(onConfirmar).not.toHaveBeenCalled();
  });

  it("CANCELAR no envía nada", () => {
    const { elegir, onConfirmar, onCancelar } = montar();
    elegir("2026-06-30");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancelar).toHaveBeenCalledTimes(1);
    expect(onConfirmar).not.toHaveBeenCalled();
  });

  it("inicio DESCONOCIDO: advierte y exige aceptación explícita, que NO viene marcada", () => {
    const { elegir, confirmar, onConfirmar } = montar({ startDate: null as unknown as string });
    expect(screen.getByText(/no tiene fecha de inicio registrada/)).toBeInTheDocument();
    const casilla = screen.getByRole("checkbox", { name: /inicio desconocido/ });
    expect(casilla).not.toBeChecked();
    elegir("2026-06-30");
    expect(confirmar, "sin aceptación no se confirma").toBeDisabled();
    fireEvent.click(casilla);
    fireEvent.click(confirmar);
    expect(onConfirmar).toHaveBeenCalledWith({ fechaTermino: "2026-06-30", aceptarHistorialIncompleto: true });
  });

  it("mientras se envía, no se puede confirmar ni cancelar", () => {
    const { confirmar } = montar({}, { enviando: true });
    expect(confirmar).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
  });
});
