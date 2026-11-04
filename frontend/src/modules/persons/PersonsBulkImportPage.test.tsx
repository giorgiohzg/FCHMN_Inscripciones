/**
 * Etapa 6 — la pantalla de carga masiva describe la plantilla REAL (A-K, con sigla del club y
 * fecha efectiva) y muestra el informe por fila con el club y el día guardados.
 *
 * Antes publicaba una columna J «Roles» obligatoria que el backend rechazaba (D5). Que el
 * importador haga lo que aquí se dice lo prueban las pruebas de integración del backend.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PersonsBulkImportPage } from "./PersonsBulkImportPage";

const bulkImport = vi.fn();
vi.mock("./personsApi", () => ({
  usePersonsApi: () => ({ bulkImport, downloadBulkImportTemplate: vi.fn() }),
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { username: "admin" }, logout: vi.fn(), hasRole: () => true }),
}));
vi.mock("../../shared/AvisosTerceros", () => ({ AvisosTerceros: () => null }));

const montar = () =>
  render(
    <MemoryRouter>
      <PersonsBulkImportPage />
    </MemoryRouter>
  );

beforeEach(() => {
  bulkImport.mockReset();
});

describe("instrucciones", () => {
  it("las columnas J y K son la sigla del club y la fecha efectiva; ya no hay «Roles»", () => {
    montar();
    const tabla = screen.getAllByRole("table")[0]!;
    const filas = within(tabla).getAllByRole("row").map((r) => r.textContent ?? "");
    expect(filas.find((t) => t.startsWith("J"))).toMatch(/Sigla del club.*No/);
    expect(filas.find((t) => t.startsWith("K"))).toMatch(/Fecha efectiva de membresía.*Sí, si hay club.*AAAA-MM-DD o DD-MM-AAAA/);
    expect(filas).toHaveLength(12); // encabezado + A-K
    expect(screen.queryByText(/Importante sobre Roles/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Nadador, Delegado y\/o Entrenador/);
  });

  it("explica la fecha obligatoria con club, el rechazo de siglas dudosas, la atomicidad y el permiso", () => {
    montar();
    const texto = document.body.textContent ?? "";
    expect(texto).toMatch(/no usa la de hoy por su\s+cuenta/);
    expect(texto).toMatch(/compartida por más de un club, rechaza esa fila/);
    expect(texto).toMatch(/Cada fila se guarda completa o no se guarda/);
    expect(texto).toMatch(/requiere además el permiso de aprobar asignaciones/);
    expect(texto).toMatch(/plantilla antigua con la columna «Roles» se rechaza/);
  });
});

describe("informe por fila", () => {
  it("muestra totales, el club y el DÍA guardado (sin correrlo por zona horaria), y los errores", async () => {
    bulkImport.mockResolvedValue({
      totalRows: 3,
      createdCount: 2,
      withClubCount: 1,
      errorCount: 1,
      results: [
        { row: 2, status: "created", fullName: "Ana Prueba", clubName: "Club Natación Valle", fechaEfectiva: "2026-03-01" },
        { row: 3, status: "created", fullName: "Beto Prueba" },
        { row: 4, status: "error", errors: ["No existe ningún club con la sigla «XYZ»."] },
      ],
    });
    montar();
    const archivo = new File(["x"], "carga.xlsx");
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [archivo] } });
    fireEvent.click(screen.getByRole("button", { name: "Cargar personas" }));

    await waitFor(() => expect(screen.getByText(/3 fila\(s\) procesada\(s\)/)).toBeInTheDocument());
    expect(document.body.textContent).toMatch(/2 creada\(s\)\s*\(1 con club\)/);
    expect(screen.getByText(/Ana Prueba — Club Natación Valle, desde el 01-03-2026/)).toBeInTheDocument();
    expect(screen.getByText(/Beto Prueba — sin club/)).toBeInTheDocument();
    expect(screen.getByText(/No existe ningún club con la sigla «XYZ»/)).toBeInTheDocument();
  });

  it("un rechazo del archivo entero (p. ej. permiso o plantilla antigua) se muestra como error", async () => {
    bulkImport.mockRejectedValue(new Error('El archivo incorpora personas a clubes, y eso requiere el permiso "swimmer-assignment:approve".'));
    montar();
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["x"], "c.xlsx")] } });
    fireEvent.click(screen.getByRole("button", { name: "Cargar personas" }));
    expect(await screen.findByText(/requiere el permiso "swimmer-assignment:approve"/)).toBeInTheDocument();
  });
});
