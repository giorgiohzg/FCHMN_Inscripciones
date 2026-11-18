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
    maleSwimmerCount: 200,
    femaleSwimmerCount: 145,
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

  it("lo mismo en todas las tarjetas, con varones y damas junto a «Nadadores registrados»", async () => {
    render(
      <MemoryRouter>
        <AdminDashboardPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Clubes activos")).toBeTruthy());

    const esperado: [string, string][] = [
      ["Clubes activos", "12"],
      ["Nadadores registrados", "345"],
      ["Varones registrados", "200"],
      ["Damas registradas", "145"],
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

describe("nadadores inscritos por competencia", () => {
  it("muestra varones, damas y total de PERSONAS, separados de inscripciones y equipos", async () => {
    getStats.mockResolvedValue({
      clubCount: 1,
      swimmerCount: 3,
      maleSwimmerCount: 2,
      femaleSwimmerCount: 1,
      activeCompetitionsCount: 1,
      openRegistrationsCount: 1,
      registrationsByCompetition: [
        {
          competitionId: "c-1",
          competitionName: "Competencia Sintética",
          status: "open",
          individualCount: 7,
          relayTeamsCount: 2,
          swimmersCount: 9,
          maleSwimmersCount: 5,
          femaleSwimmersCount: 4,
        },
      ],
    });
    render(
      <MemoryRouter>
        <AdminDashboardPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Competencia Sintética")).toBeTruthy());

    const encabezados = screen.getAllByRole("columnheader").map((th) => th.textContent?.replace(/[▲▼↕⇅]/g, "").trim());
    expect(encabezados).toEqual([
      "Competencia",
      "Estado",
      "Varones",
      "Damas",
      "Total nadadores",
      "Inscripciones individuales",
      "Equipos de relevo",
    ]);
    const celdas = screen.getByText("Competencia Sintética").closest("tr")!.querySelectorAll("td");
    expect(Array.from(celdas).map((c) => c.textContent)).toEqual(["Competencia Sintética", "Abierta", "5", "4", "9", "7", "2"]);
  });

  it("sin competencias, la fila vacía ocupa las siete columnas", async () => {
    render(
      <MemoryRouter>
        <AdminDashboardPage />
      </MemoryRouter>
    );
    const vacia = await screen.findByText("No hay competencias activas en este momento.");
    expect(vacia.getAttribute("colspan")).toBe("7");
  });
});
