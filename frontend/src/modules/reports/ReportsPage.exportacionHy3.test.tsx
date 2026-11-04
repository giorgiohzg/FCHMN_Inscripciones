/**
 * Etapa 2 — el botón «Exportar a Team Manager (.zip)» sigue al PERMISO, no al rol.
 *
 * Antes lo gobernaba `hasRole("admin")`. Ahora lo gobierna
 * `hasPermission("export:team-manager")`, que tienen el administrador, la cuenta
 * del club (rol `club`) y el personal de club (delegado, entrenador, representante
 * legal). Quien no es administrador no elige club: se le fija el suyo, y es lo que viaja en la descarga. Que no pueda
 * pedir otro lo garantiza el servidor; aquí solo se comprueba qué se muestra y
 * qué se envía.
 *
 * Interacción simulada con jsdom, no con un navegador real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ReportsPage } from "./ReportsPage";

type Actor = { user: Record<string, unknown>; roles: string[]; permisos: string[] };

const ACTORES: Record<string, Actor> = {
  admin: {
    user: { id: "u-admin", username: "admin", ownerType: "system", personId: null, clubId: null, roles: ["admin"] },
    roles: ["admin"],
    permisos: ["reports:read", "export:team-manager"],
  },
  delegado: {
    user: { id: "u-del", username: "deleg", ownerType: "person", personId: "p1", clubId: "club-1", roles: ["delegate"] },
    roles: ["delegate"],
    permisos: ["reports:read", "export:team-manager"],
  },
  entrenador: {
    user: { id: "u-ent", username: "entre", ownerType: "person", personId: "p2", clubId: "club-1", roles: ["coach"] },
    roles: ["coach"],
    permisos: ["reports:read", "export:team-manager"],
  },
  representante: {
    user: { id: "u-rep", username: "repre", ownerType: "person", personId: "p3", clubId: "club-1", roles: ["legal_representative"] },
    roles: ["legal_representative"],
    permisos: ["reports:read", "export:team-manager"],
  },
  cuentaClub: {
    user: { id: "u-club", username: "club", ownerType: "club", personId: null, clubId: "club-1", roles: ["club"] },
    roles: ["club"],
    permisos: ["reports:read", "export:team-manager"],
  },
  nadadorPuro: {
    user: { id: "u-nad", username: "nada", ownerType: "person", personId: "p4", clubId: null, roles: ["swimmer"] },
    roles: ["swimmer"],
    permisos: ["reports:read"],
  },
};

let actual: Actor = ACTORES.admin!;

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: actual.user,
      accessToken: "t",
      permissions: actual.permisos,
      mustChangePassword: false,
      hasRole: (r: string) => actual.roles.includes(r),
      hasPermission: (p: string) => actual.permisos.includes(p),
      restaurando: false,
      restauracionFallida: false,
      login: vi.fn(),
      logout: vi.fn(),
      changePassword: vi.fn(),
      reintentarRestauracion: vi.fn(),
    }),
  };
});

const competitionsList = vi.fn(async () => ({
  items: [{ id: "comp-1", name: "Competencia Uno", status: "open", dates: [] }],
  total: 1,
  page: 1,
  pageSize: 20,
}));
const clubsList = vi.fn(async () => ({
  items: [{ id: "club-1", name: "Club Uno" }, { id: "club-2", name: "Club Dos" }],
  total: 2,
  page: 1,
  pageSize: 20,
}));
const clubsGet = vi.fn(async () => ({ id: "club-1", name: "Club Uno" }));
const getCurrentClub = vi.fn(async () => null);
const downloadTeamManagerExport = vi.fn(async () => undefined);

vi.mock("../competitions/competitionsApi", () => ({ useCompetitionsApi: () => ({ list: competitionsList }) }));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => ({ list: clubsList, get: clubsGet }) }));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => ({ getCurrentClub }) }));
vi.mock("./reportsApi", () => ({
  useReportsApi: () => ({ getRegistrationsReport: vi.fn(), downloadExport: vi.fn(), downloadTeamManagerExport }),
}));

const BOTON = "Exportar a Team Manager (.zip)";

async function montar(clave: keyof typeof ACTORES) {
  actual = ACTORES[clave]!;
  render(
    <MemoryRouter>
      <ReportsPage />
    </MemoryRouter>
  );
  await screen.findByRole("option", { name: "Competencia Uno" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("visibilidad del botón de Team Manager", () => {
  it.each([
    ["admin", true],
    ["delegado", true],
    ["entrenador", true],
    ["representante", true],
    ["cuentaClub", true],
    ["nadadorPuro", false],
  ] as const)("%s → botón visible: %s", async (clave, visible) => {
    await montar(clave);
    if (visible) expect(screen.getByRole("button", { name: BOTON })).toBeInTheDocument();
    else expect(screen.queryByRole("button", { name: BOTON })).not.toBeInTheDocument();
  });
});

describe("el club que viaja en la descarga", () => {
  it.each(["cuentaClub", "delegado", "entrenador", "representante"] as const)("%s: club fijo, sin selector, y se envía el suyo", async (clave) => {
    await montar(clave);

    // Texto fijo: no hay desplegable de clubes.
    expect(await screen.findByText("Club Uno")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Club Dos" })).not.toBeInTheDocument();
    expect(clubsList).not.toHaveBeenCalled();

    fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "comp-1" } });
    fireEvent.click(screen.getByRole("button", { name: BOTON }));

    await waitFor(() => expect(downloadTeamManagerExport).toHaveBeenCalledWith("comp-1", "club-1"));
  });

  it("el administrador sigue eligiendo club y la nota de «seleccione un club» es suya", async () => {
    await montar("admin");
    expect(await screen.findByRole("option", { name: "Club Dos" })).toBeInTheDocument();
    expect(screen.getByText(/seleccione también un club/i)).toBeInTheDocument();
  });

  it.each(["cuentaClub", "delegado"] as const)("%s: no ve la nota que es del administrador", async (clave) => {
    await montar(clave);
    expect(screen.queryByText(/seleccione también un club/i)).not.toBeInTheDocument();
  });
});
