/**
 * Tarjetas de «Resumen general»: el número arriba, el texto abajo, centrados.
 *
 * El orden no es cosmético: en una fila de tarjetas lo que se compara de un
 * vistazo son las cifras, así que van primero y alineadas entre sí. Probar
 * el ORDEN en el DOM es lo que impide que una reordenación accidental pase
 * inadvertida; el centrado se comprueba sobre los estilos aplicados.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminDashboardPage } from "./AdminDashboardPage";

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { username: "admin" }, logout: vi.fn(), hasRole: () => true }),
}));
vi.mock("../../shared/AvisosTerceros", () => ({ AvisosTerceros: () => null }));

const getStats = vi.fn();
vi.mock("./dashboardApi", () => ({
  useDashboardApi: () => ({ getStats }),
}));

beforeEach(() => {
  getStats.mockReset();
  getStats.mockResolvedValue({
    clubCount: 12,
    swimmerCount: 345,
    activeCompetitionsCount: 3,
    openRegistrationsCount: 1,
    registrationsByCompetition: [],
  });
});

function tarjetaDe(texto: string): HTMLElement {
  const etiqueta = screen.getByText(texto);
  const tarjeta = etiqueta.parentElement;
  if (!tarjeta) throw new Error(`sin tarjeta para "${texto}"`);
  return tarjeta;
}

describe("tarjetas del resumen general", () => {
  it("dentro de cada tarjeta, el número va ANTES que el texto", async () => {
    render(
      <MemoryRouter>
        <AdminDashboardPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Clubes activos")).toBeTruthy());

    const tarjeta = tarjetaDe("Clubes activos");
    const hijos = Array.from(tarjeta.children).map((n) => n.textContent);
    expect(hijos).toEqual(["12", "Clubes activos"]);
  });

  it("lo mismo en las cuatro tarjetas", async () => {
    render(
      <MemoryRouter>
        <AdminDashboardPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Clubes activos")).toBeTruthy());

    const esperado: [string, string][] = [
      ["Clubes activos", "12"],
      ["Nadadores registrados", "345"],
      ["Competencias activas", "3"],
      ["Con inscripciones abiertas", "1"],
    ];
    for (const [etiqueta, valor] of esperado) {
      const hijos = Array.from(tarjetaDe(etiqueta).children).map((n) => n.textContent);
      expect(hijos, etiqueta).toEqual([valor, etiqueta]);
    }
  });

  it("número y texto quedan centrados", async () => {
    render(
      <MemoryRouter>
        <AdminDashboardPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Clubes activos")).toBeTruthy());

    const tarjeta = tarjetaDe("Clubes activos");
    expect(tarjeta.style.textAlign).toBe("center");
    expect(tarjeta.style.alignItems).toBe("center");
    expect(tarjeta.style.flexDirection).toBe("column");
  });
});
