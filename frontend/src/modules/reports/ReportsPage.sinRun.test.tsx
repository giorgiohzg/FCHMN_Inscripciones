/**
 * SEC-02: la pantalla de Reportes no muestra el RUN, para ningún rol.
 *
 * Y es compatible con los DOS contratos de la API durante la transición:
 *   - el nuevo, que entrega `personId` y no entrega `run`;
 *   - el anterior, que entrega `run` y no entrega `personId`: la pantalla lo ignora,
 *     no lo muestra y no lo usa de clave.
 *
 * Interacción simulada con jsdom, no con un navegador real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ReportsPage } from "./ReportsPage";

// Centinelas sintéticos, inconfundibles: no pueden coincidir con otro dato de la pantalla.
const RUN_CENTINELA_A = "RUN-CENTINELA-AAA";
const RUN_CENTINELA_B = "RUN-CENTINELA-BBB";

const admin = { id: "u-admin", username: "admin", ownerType: "system", personId: null, clubId: null, roles: ["admin"] };
let actual = { user: admin as Record<string, unknown>, roles: ["admin"] };

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: actual.user,
      accessToken: "t",
      permissions: ["reports:read"],
      mustChangePassword: false,
      hasRole: (r: string) => actual.roles.includes(r),
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
  useCompetitionsApi: () => ({ list: async () => ({ items: [{ id: "comp-1", name: "Competencia Uno", status: "open", dates: [] }], total: 1, page: 1, pageSize: 20 }) }),
}));
vi.mock("../clubs/clubsApi", () => ({
  useClubsApi: () => ({ list: async () => ({ items: [{ id: "club-1", name: "Club Uno" }], total: 1, page: 1, pageSize: 20 }), get: async () => ({ id: "club-1", name: "Club Uno" }) }),
}));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => ({ getCurrentClub: async () => null }) }));

const informe = vi.fn();
vi.mock("./reportsApi", () => ({
  useReportsApi: () => ({ getRegistrationsReport: informe, downloadExport: vi.fn(), downloadTeamManagerExport: vi.fn() }),
}));

const linea = (texto: string) => ({ number: 1, text: texto });
const nadador = (extra: Record<string, unknown>) => ({
  nombreCompleto: "Ana Homónima",
  edad: 35,
  categoria: "Master Uno",
  genero: "Damas",
  pruebas: [linea("50m Libre")],
  relevos: [],
  ...extra,
});
const informeCon = (swimmers: Record<string, unknown>[]) => ({
  competitionName: "Competencia Uno",
  individualRows: [],
  relayRows: [],
  groupedByClub: [{ clubName: "Club Uno", totalNadadores: swimmers.length, totalPruebasIndividuales: swimmers.length, totalRelevos: 0, swimmers }],
});

async function generar() {
  const { container } = render(
    <MemoryRouter>
      <ReportsPage />
    </MemoryRouter>
  );
  await screen.findByRole("option", { name: "Competencia Uno" });
  fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "comp-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Generar reporte" }));
  await waitFor(() => expect(informe).toHaveBeenCalled());
  await screen.findAllByText(/Ana Homónima/);
  return container;
}

let avisos: string[];
beforeEach(() => {
  vi.clearAllMocks();
  actual = { user: admin, roles: ["admin"] };
  avisos = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void avisos.push(a.map(String).join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Reportes: sin RUN, con los dos contratos de la API", () => {
  it("contrato NUEVO (personId, sin run): muestra los dos homónimos, sin RUN y sin claves repetidas", async () => {
    informe.mockResolvedValue(informeCon([nadador({ personId: "persona-1" }), nadador({ personId: "persona-2" })]));
    const contenedor = await generar();

    expect(screen.getAllByText(/Ana Homónima/)).toHaveLength(2);
    expect(contenedor.textContent).toContain("1. Ana Homónima — 35 años — Master Uno — Damas");
    expect(contenedor.textContent).toContain("2. Ana Homónima — 35 años — Master Uno — Damas");
    expect(contenedor.textContent).not.toMatch(/\(\s*\)/); // sin paréntesis vacíos donde estaba el RUN
    expect(avisos.filter((a) => /key/i.test(a)), "claves de React repetidas o ausentes").toEqual([]);
  });

  it("contrato ANTERIOR (run, sin personId): NO muestra el RUN, ni siquiera en el HTML", async () => {
    informe.mockResolvedValue(
      informeCon([nadador({ run: RUN_CENTINELA_A }), nadador({ run: RUN_CENTINELA_B, nombreCompleto: "Bea Otra" })])
    );
    const contenedor = await generar();

    expect(contenedor.innerHTML).not.toContain(RUN_CENTINELA_A);
    expect(contenedor.innerHTML).not.toContain(RUN_CENTINELA_B);
    expect(document.body.innerHTML).not.toContain("CENTINELA");
    expect(contenedor.textContent).toContain("1. Ana Homónima — 35 años — Master Uno — Damas");
    expect(contenedor.textContent).toContain("2. Bea Otra — 35 años — Master Uno — Damas");
    expect(avisos.filter((a) => /key/i.test(a))).toEqual([]);
  });

  it("contrato ANTERIOR con homónimos y RUN distintos: las dos filas se muestran, sin usar el RUN de clave", async () => {
    informe.mockResolvedValue(informeCon([nadador({ run: RUN_CENTINELA_A }), nadador({ run: RUN_CENTINELA_B })]));
    await generar();

    expect(screen.getAllByText(/Ana Homónima/)).toHaveLength(2);
    expect(avisos.filter((a) => /key/i.test(a))).toEqual([]);
  });

  it("contrato intermedio (ambos campos): muestra ambos nadadores sin RUN", async () => {
    informe.mockResolvedValue(informeCon([nadador({ personId: "p1", run: RUN_CENTINELA_A }), nadador({ personId: "p2", run: RUN_CENTINELA_B })]));
    const contenedor = await generar();

    expect(contenedor.innerHTML).not.toContain("CENTINELA");
    expect(screen.getAllByText(/Ana Homónima/)).toHaveLength(2);
  });

  it("el nadador sin pruebas ni relevos y los totales se conservan", async () => {
    informe.mockResolvedValue(informeCon([nadador({ personId: "p1", pruebas: [], relevos: [] })]));
    await generar();

    expect(screen.getByText("Sin pruebas ni relevos.")).toBeInTheDocument();
    expect(screen.getByText(/1 nadadores, 1 pruebas individuales, 0 relevos/)).toBeInTheDocument();
  });

  it("no cambia con el rol: un delegado de club tampoco ve RUN", async () => {
    actual = { user: { id: "u-del", username: "d", ownerType: "person", personId: "p9", clubId: "club-1", roles: ["delegate"] }, roles: ["delegate"] };
    informe.mockResolvedValue(informeCon([nadador({ personId: "p1", run: RUN_CENTINELA_A })]));
    const contenedor = await generar();

    expect(contenedor.innerHTML).not.toContain("CENTINELA");
  });

  it("los filtros que se envían no cambian: solo competencia y club", async () => {
    informe.mockResolvedValue(informeCon([nadador({ personId: "p1" })]));
    await generar();

    expect(informe).toHaveBeenCalledWith({ competitionId: "comp-1", clubId: undefined });
  });
});
