/**
 * Fase 6, hallazgo 28 — la tabla de competencias TIENE que poder pasar de página.
 *
 * No tenía ningún control de paginación y la llamada no enviaba `page`: mostraba
 * las primeras 20 competencias del backend y ahí se acababa el mundo. No era un
 * truncamiento disimulado como el de los selectores, era uno del que además no se
 * podía salir.
 *
 * Aquí se ejercita la navegación de verdad —segunda página, vuelta a la primera
 * al filtrar— y el manejo de un error de carga, que es donde suele quedarse
 * pegado un mensaje viejo.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CompetitionsListPage } from "./CompetitionsListPage";

const POR_PAGINA = 20;
const TOTAL = 35;

const competencia = (n: number, status = "open") => ({
  id: `c-${n}`,
  name: `Competencia ${n}`,
  description: "",
  status,
  registrationStartAt: "2026-01-01T00:00:00.000Z",
  registrationEndAt: "2026-02-01T00:00:00.000Z",
  ageCutoffDate: "2026-12-31",
  maxIndividualEventsPerSwimmer: null,
  maxRelayEventsPerSwimmerPerSession: 1,
  pool: null,
  dates: [],
});

const list = vi.fn(async ({ page = 1, status }: { page?: number; status?: string } = {}) => {
  // Con filtro solo hay 5 resultados: la página 2 dejaría de existir.
  const total = status ? 5 : TOTAL;
  const desde = (page - 1) * POR_PAGINA;
  return {
    items: Array.from({ length: Math.max(0, Math.min(POR_PAGINA, total - desde)) }, (_, i) =>
      competencia(desde + i + 1, status ?? "open")
    ),
    total,
    page,
    pageSize: POR_PAGINA,
  };
});

vi.mock("./competitionsApi", () => ({
  useCompetitionsApi: () => ({ list, create: vi.fn(), remove: vi.fn() }),
}));
vi.mock("../pools/poolsApi", () => ({ usePoolsApi: () => ({ list: vi.fn(async () => []) }) }));
vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u1", username: "admin", ownerType: "system", personId: null, clubId: null, roles: ["admin"] },
      accessToken: "t",
      permissions: [],
      mustChangePassword: false,
      hasRole: () => true,
      hasPermission: () => true,
      restaurando: false,
      restauracionFallida: false,
      login: vi.fn(),
      logout: vi.fn(),
      changePassword: vi.fn(),
      reintentarRestauracion: vi.fn(),
    }),
  };
});

const montar = () =>
  render(
    <MemoryRouter>
      <CompetitionsListPage />
    </MemoryRouter>
  );

const paginasPedidas = () => list.mock.calls.map((c) => c[0]?.page ?? 1);

beforeEach(() => {
  list.mockReset();
  list.mockImplementation(async ({ page = 1, status }: { page?: number; status?: string } = {}) => {
    const total = status ? 5 : TOTAL;
    const desde = (page - 1) * POR_PAGINA;
    return {
      items: Array.from({ length: Math.max(0, Math.min(POR_PAGINA, total - desde)) }, (_, i) =>
        competencia(desde + i + 1, status ?? "open")
      ),
      total,
      page,
      pageSize: POR_PAGINA,
    };
  });
});

describe("CompetitionsListPage: paginación real", () => {
  it("navega a la SEGUNDA página y muestra sus elementos", async () => {
    montar();

    await screen.findByText("Competencia 1");
    expect(screen.queryByText("Competencia 21"), "la 21 está en la página 2").not.toBeInTheDocument();
    expect(screen.getByText(/35 competencia\(s\) — página 1/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    // Elementos de la SEGUNDA página, que antes eran inalcanzables.
    expect(await screen.findByText("Competencia 21")).toBeInTheDocument();
    expect(screen.getByText("Competencia 35")).toBeInTheDocument();
    expect(screen.queryByText("Competencia 1")).not.toBeInTheDocument();
    expect(paginasPedidas()).toContain(2);

    // En la última página no hay "Siguiente" utilizable.
    expect(screen.getByRole("button", { name: "Siguiente" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Anterior" })).toBeEnabled();
  });

  it("al CAMBIAR EL FILTRO vuelve a la página 1", async () => {
    montar();
    await screen.findByText("Competencia 1");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("Competencia 21");

    /**
     * Sin reiniciar, quedaría pidiendo la página 2 de un filtro que quizá solo
     * tiene una: tabla vacía y ninguna pista de por qué.
     */
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "closed" } });

    await waitFor(() => expect(screen.getByText(/5 competencia\(s\) — página 1/)).toBeInTheDocument());
    expect(screen.getByText("Competencia 1")).toBeInTheDocument();
    const ultima = list.mock.calls[list.mock.calls.length - 1]![0];
    expect(ultima).toMatchObject({ page: 1, status: "closed" });
  });

  it("un ERROR de carga se muestra, y un reintento correcto lo BORRA", async () => {
    list.mockImplementationOnce(async () => {
      throw new Error("500 al cargar competencias");
    });

    montar();
    expect(await screen.findByText(/500 al cargar competencias/)).toBeInTheDocument();

    // Reintento por la vía normal: cambiar de filtro dispara otra carga.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "closed" } });

    await screen.findByText("Competencia 1");
    expect(
      screen.queryByText(/500 al cargar competencias/),
      "un error viejo no puede sobrevivir a una carga correcta"
    ).not.toBeInTheDocument();
  });
});
