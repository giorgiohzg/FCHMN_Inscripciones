/**
 * Corrección de DESDE/HASTA: el diálogo compartido. Datos sintéticos, jsdom; la API se simula.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EdicionDeFechasDialog } from "./EdicionDeFechasDialog";
import { ApiError } from "../../shared/apiClient";

const editarFechas = vi.fn();
vi.mock("./assignmentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./assignmentApi")>()),
  useSwimmerAssignmentApi: () => ({ editarFechas }),
}));

const HOY = "2026-11-17";
const base = { person: { fullName: "Ana Sintética" }, club: { name: "Club Prueba" } };
const activa = { ...base, id: "m-act", status: "active" as const, startDate: "2025-02-01T00:00:00.000Z", fechaTermino: null };
const finalizada = {
  ...base,
  id: "m-fin",
  status: "ended" as const,
  startDate: "2024-01-01T00:00:00.000Z",
  fechaTermino: "2024-12-31T00:00:00.000Z",
};
const desconocida = { ...base, id: "m-hist", status: "ended" as const, startDate: null, fechaTermino: null };

function abrir(membresia: Parameters<typeof EdicionDeFechasDialog>[0]["membresia"]) {
  const onGuardado = vi.fn();
  const onCancelar = vi.fn();
  render(<EdicionDeFechasDialog membresia={membresia} hoy={HOY} onGuardado={onGuardado} onCancelar={onCancelar} />);
  return { onGuardado, onCancelar };
}
const campo = (texto: RegExp) => screen.getByLabelText(texto) as HTMLInputElement;
const guardar = () => screen.getByRole("button", { name: "Guardar fechas" });

beforeEach(() => {
  editarFechas.mockReset();
});

describe("EdicionDeFechasDialog", () => {
  it("activa: solo DESDE, con máximo hoy; HASTA no se ofrece y el envío lleva solo DESDE", async () => {
    const { onGuardado } = abrir(activa);
    expect(campo(/DESDE/).max).toBe(HOY);
    expect(screen.queryByLabelText(/HASTA/)).not.toBeInTheDocument();
    expect(screen.getByText(/sin término, porque la membresía está activa/)).toBeInTheDocument();
    expect(guardar()).toBeDisabled();
    fireEvent.change(campo(/DESDE/), { target: { value: "2025-01-15" } });
    editarFechas.mockResolvedValue({ id: "m-act" });
    fireEvent.click(guardar());
    await waitFor(() => expect(onGuardado).toHaveBeenCalled());
    expect(editarFechas).toHaveBeenCalledWith("m-act", { startDate: "2025-01-15" });
  });

  it("rechaza fechas futuras y HASTA anterior a DESDE; el mismo día es válido", () => {
    abrir(finalizada);
    fireEvent.change(campo(/DESDE/), { target: { value: "2026-11-18" } });
    expect(screen.getByText(/DESDE no puede ser posterior a hoy/)).toBeInTheDocument();
    expect(guardar()).toBeDisabled();
    fireEvent.change(campo(/DESDE/), { target: { value: "2024-06-01" } });
    fireEvent.change(campo(/HASTA/), { target: { value: "2024-05-31" } });
    expect(screen.getByText(/HASTA no puede ser anterior a DESDE/)).toBeInTheDocument();
    expect(guardar()).toBeDisabled();
    fireEvent.change(campo(/HASTA/), { target: { value: "2024-06-01" } });
    expect(guardar()).toBeEnabled();
  });

  it("no permite borrar una fecha conocida ni completa una desconocida por su cuenta", () => {
    abrir(finalizada);
    fireEvent.change(campo(/HASTA/), { target: { value: "" } });
    expect(screen.getByText(/corregir no la borra/)).toBeInTheDocument();
    expect(guardar()).toBeDisabled();
  });

  it("historial con fechas desconocidas: solo indica lo que se escribe y pide aceptación explícita antes de reenviar", async () => {
    const { onGuardado } = abrir(desconocida);
    expect(campo(/DESDE/).value).toBe("");
    fireEvent.change(campo(/HASTA/), { target: { value: "2020-12-31" } });
    editarFechas.mockRejectedValueOnce(new ApiError("Historial incompleto", 409, "HISTORIAL_INCOMPLETO", { membresias: ["m-otra"] }));
    fireEvent.click(guardar());
    expect(await screen.findByText(/Acepto, como administración/)).toBeInTheDocument();
    expect(editarFechas).toHaveBeenLastCalledWith("m-hist", { fechaTermino: "2020-12-31" });
    expect(guardar()).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    editarFechas.mockResolvedValueOnce({ id: "m-hist" });
    fireEvent.click(guardar());
    await waitFor(() => expect(onGuardado).toHaveBeenCalled());
    expect(editarFechas).toHaveBeenLastCalledWith("m-hist", { fechaTermino: "2020-12-31", aceptarHistorialIncompleto: true });
  });

  it("una superposición informa los motivos del servidor y no cierra el diálogo", async () => {
    const { onGuardado } = abrir(finalizada);
    fireEvent.change(campo(/HASTA/), { target: { value: "2025-02-01" } });
    editarFechas.mockRejectedValueOnce(
      new ApiError("Las fechas se superponen con otra membresía del nadador.", 409, "CONFLICTO_DE_FECHAS", {
        conflictos: [{ membresiaId: "m-act", motivo: "se superpone con otra membresía (desde el 2025-02-01, sin término (vigente))" }],
      })
    );
    fireEvent.click(guardar());
    expect(await screen.findByText(/desde el 2025-02-01, sin término/)).toBeInTheDocument();
    expect(onGuardado).not.toHaveBeenCalled();
  });
});
