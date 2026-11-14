/**
 * «Generar reporte»: orden y formato de la línea de cada nadador en pantalla.
 *
 *  - Formato `PATERNO MATERNO, NOMBRE (EDAD) - Categoría - Género`, con la numeración por club.
 *  - El ORDEN es el del servidor (su `compararNadadores`): la pantalla no reordena, ni siquiera
 *    por el nombre presentado.
 *  - Homónimos, apellidos compuestos, registros incompletos y quien está solo en relevos.
 *  - Se conservan la agrupación por club, los totales y las listas de pruebas y relevos.
 * Interacción simulada con jsdom y servicios simulados, datos sintéticos; no es un navegador real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ReportsPage } from "./ReportsPage";
import type { ClubGroupSwimmerRow, RegistrationsReportResult } from "./reportsApi";

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u-admin", username: "admin", ownerType: "system", personId: null, clubId: null, roles: ["admin"] },
      accessToken: "t",
      permissions: ["reports:read"],
      mustChangePassword: false,
      hasRole: (r: string) => r === "admin",
      hasPermission: () => false,
      restaurando: false,
      restauracionFallida: false,
      login: vi.fn(),
      logout: vi.fn(),
      changePassword: vi.fn(),
      reintentarRestauracion: vi.fn(),
    }),
  };
});
vi.mock("../competitions/competitionsApi", () => ({
  useCompetitionsApi: () => ({ list: async () => ({ items: [{ id: "comp-1", name: "Competencia Uno", status: "open" }], total: 1, page: 1, pageSize: 100 }) }),
}));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => ({ list: vi.fn(), get: vi.fn() }) }));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => ({ getCurrentClub: vi.fn(async () => null) }) }));

const getRegistrationsReport = vi.fn();
vi.mock("./reportsApi", () => ({
  useReportsApi: () => ({
    getRegistrationsReport,
    downloadExport: vi.fn(),
    downloadTeamManagerExport: vi.fn(),
    getClubesConInscripciones: async () => ({ clubs: [] }),
  }),
}));

const nadador = (o: Partial<ClubGroupSwimmerRow> & { personId: string }): ClubGroupSwimmerRow => ({
  nombreCompleto: "Sin Nombre",
  apellidoPaterno: null,
  apellidoMaterno: null,
  nombres: null,
  edad: 54,
  categoria: "Master G",
  genero: "Varones",
  pruebas: [{ number: 3, text: "50m Libre 0:35,10" }],
  relevos: [],
  ...o,
});

/** Lo que el servidor entrega, YA ordenado por su `compararNadadores`. */
const INFORME: RegistrationsReportResult = {
  competitionName: "Competencia Uno",
  individualRows: [],
  relayRows: [],
  groupedByClub: [
    {
      clubName: "Club Alfa",
      totalNadadores: 5,
      totalPruebasIndividuales: 4,
      totalRelevos: 1,
      swimmers: [
        nadador({ personId: "p-a", nombreCompleto: "Carla de la Fuente Rojo", apellidoPaterno: "de la Fuente", apellidoMaterno: "Rojo", nombres: "Carla", genero: "Damas" }),
        nadador({ personId: "p-h1", nombreCompleto: "Dana Igual Igual", apellidoPaterno: "Igual", apellidoMaterno: "Igual", nombres: "Dana", genero: "Damas" }),
        nadador({ personId: "p-h2", nombreCompleto: "Dana Igual Igual", apellidoPaterno: "Igual", apellidoMaterno: "Igual", nombres: "Dana", genero: "Damas" }),
        nadador({
          personId: "p-r",
          nombreCompleto: "Beto Relevo",
          apellidoPaterno: "Relevo",
          nombres: "Beto",
          edad: 61,
          categoria: "Master I",
          pruebas: [],
          relevos: [{ number: 9, text: "Relevo 4x50m Libre (Varones)" }],
        }),
        nadador({ personId: "p-x", nombreCompleto: "Persona Histórica Sintética", edad: 70, categoria: "Master K" }),
      ],
    },
    {
      clubName: "Club Beta",
      totalNadadores: 1,
      totalPruebasIndividuales: 1,
      totalRelevos: 0,
      swimmers: [nadador({ personId: "p-b", nombreCompleto: "Ana María Ejemplo Prueba", apellidoPaterno: "Ejemplo", apellidoMaterno: "Prueba", nombres: "Ana María", genero: "Damas" })],
    },
  ],
};

async function generar() {
  const vista = render(
    <MemoryRouter>
      <ReportsPage />
    </MemoryRouter>
  );
  await screen.findByRole("option", { name: "Competencia Uno" });
  fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "comp-1" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Generar reporte" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Generar reporte" }));
  await screen.findByRole("heading", { name: "Competencia Uno" });
  return vista.container;
}

/** Las líneas de nadador, en el orden en que se ven. */
const lineas = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("h2 ~ div > div:first-child")).map((d) => d.textContent ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  getRegistrationsReport.mockResolvedValue(INFORME);
});

describe("línea de cada nadador", () => {
  it("formato y orden exactos, con la numeración reiniciada en cada club", async () => {
    const c = await generar();
    expect(lineas(c)).toEqual([
      "1. DE LA FUENTE ROJO, CARLA (54) - Master G - Damas",
      "2. IGUAL IGUAL, DANA (54) - Master G - Damas",
      "3. IGUAL IGUAL, DANA (54) - Master G - Damas",
      "4. RELEVO, BETO (61) - Master I - Varones",
      "5. PERSONA HISTÓRICA SINTÉTICA (70) - Master K - Varones",
      "1. EJEMPLO PRUEBA, ANA MARÍA (54) - Master G - Damas",
    ]);
  });

  it("el nombre va en negrita y la edad, sin «años»", async () => {
    const c = await generar();
    expect(Array.from(c.querySelectorAll("strong")).map((s) => s.textContent)).toContain("EJEMPLO PRUEBA, ANA MARÍA");
    expect(c.textContent).not.toMatch(/\d+ años —/);
  });

  it("la pantalla no reordena: respeta el orden del servidor aunque no sea alfabético por el nombre presentado", async () => {
    getRegistrationsReport.mockResolvedValue({
      ...INFORME,
      groupedByClub: [{ ...INFORME.groupedByClub[1]!, swimmers: [nadador({ personId: "z", nombreCompleto: "Zeta Zeta", apellidoPaterno: "Zeta", nombres: "Zeta" }), nadador({ personId: "a", nombreCompleto: "Alfa Alfa", apellidoPaterno: "Alfa", nombres: "Alfa" })] }],
    });
    const c = await generar();
    expect(lineas(c)).toEqual(["1. ZETA, ZETA (54) - Master G - Varones", "2. ALFA, ALFA (54) - Master G - Varones"]);
  });

  it("se conservan agrupación por club, totales y las listas de pruebas y relevos", async () => {
    const c = await generar();
    expect(screen.getByRole("heading", { name: /Club Alfa/ })).toHaveTextContent("(5 nadadores, 4 pruebas individuales, 1 relevos)");
    expect(screen.getByRole("heading", { name: /Club Beta/ })).toHaveTextContent("(1 nadadores, 1 pruebas individuales, 0 relevos)");
    expect(c.textContent).toContain("Relevo 4x50m Libre (Varones)");
    expect(screen.getAllByText("50m Libre 0:35,10")).toHaveLength(5);
  });
});
