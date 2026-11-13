/**
 * C-05, fase 3: las pantallas de asignación son EXCLUSIVAS de administración, también por acceso
 * directo a la URL. Se usan el `AuthProvider`, el enrutador y los guards REALES; lo simulado es la
 * capa HTTP de sesión (`authApi`) y las pantallas de destino (marcadores). Datos sintéticos, jsdom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../../App";
import { reiniciarCoordinador } from "../auth/refreshCoordinator";
import { reiniciarCsrf } from "../auth/csrf";
import * as authApi from "../auth/authApi";
import { perfilDePrueba, sesionDePrueba } from "../../test/sesionDePrueba";

vi.mock("../auth/authApi");
vi.mock("./SwimmerAssignmentsPage", () => ({ SwimmerAssignmentsPage: () => <p>PANTALLA asignaciones</p> }));
vi.mock("./BulkSwimmerAssignmentPage", () => ({ BulkSwimmerAssignmentPage: () => <p>PANTALLA masiva</p> }));
vi.mock("./PeriodosDeCambioPage", () => ({ PeriodosDeCambioPage: () => <p>PANTALLA periodos</p> }));
vi.mock("./SolicitudesDeAltaPage", () => ({ SolicitudesDeAltaPage: () => <p>PANTALLA altas</p> }));
vi.mock("./IncorporacionesClubPage", () => ({ IncorporacionesClubPage: () => <p>PANTALLA incorporaciones del club</p> }));
vi.mock("../dashboard/AdminDashboardPage", () => ({ AdminDashboardPage: () => <p>PANTALLA panel admin</p> }));

const RUTAS = [
  ["/asignaciones", "PANTALLA asignaciones"],
  ["/asignaciones/masiva", "PANTALLA masiva"],
  ["/asignaciones/periodos", "PANTALLA periodos"],
  ["/asignaciones/altas", "PANTALLA altas"],
] as const;

function abrirCon(roles: string[], ruta: string, extra: Partial<Parameters<typeof perfilDePrueba>[0]> = {}, permisos = ["swimmer-assignment:write"]) {
  const perfil = perfilDePrueba({ id: "u-c05", username: "usuario.c05", roles, ...extra });
  vi.mocked(authApi.apiRefresh).mockResolvedValue(sesionDePrueba(perfil, "csrf-prueba", permisos));
  window.history.pushState({}, "", ruta);
  return render(<App />);
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  reiniciarCoordinador();
  reiniciarCsrf();
  vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-prueba" });
  vi.mocked(authApi.apiLogout).mockResolvedValue(undefined);
});

describe.each(RUTAS)("%s", (ruta, pantalla) => {
  it("administración sola entra", async () => {
    abrirCon(["admin"], ruta);
    expect(await screen.findByText(pantalla)).toBeInTheDocument();
  });

  it("administración combinada con otro rol también entra", async () => {
    abrirCon(["admin", "coach"], ruta, { ownerType: "person", personId: "p-1" });
    expect(await screen.findByText(pantalla)).toBeInTheDocument();
  });

  it.each([
    ["club", { ownerType: "club" as const, clubId: "c-1" }],
    ["delegate", { ownerType: "person" as const, personId: "p-2" }],
    ["coach", { ownerType: "person" as const, personId: "p-3" }],
    ["swimmer", { ownerType: "person" as const, personId: "p-4" }],
  ])("el rol %s no entra por URL directa", async (rol, extra) => {
    abrirCon([rol], ruta, extra);
    expect(await screen.findByText("No autorizado")).toBeInTheDocument();
    expect(screen.queryByText(pantalla)).not.toBeInTheDocument();
  });
});

describe("/incorporaciones (C-05, fase 4): club y su personal vigente, en su club", () => {
  const PANTALLA = "PANTALLA incorporaciones del club";
  const ESCRITURA = ["swimmer-assignment:read", "swimmer-assignment:write"];

  it("la cuenta del club entra", async () => {
    abrirCon(["club"], "/incorporaciones", { ownerType: "club", clubId: "c-1" }, ESCRITURA);
    expect(await screen.findByText(PANTALLA)).toBeInTheDocument();
  });

  it.each(["delegate", "coach", "legal_representative"])("el %s con club vigente entra", async (rol) => {
    abrirCon([rol], "/incorporaciones", { ownerType: "person", personId: "p-1", clubId: "c-1" }, ESCRITURA);
    expect(await screen.findByText(PANTALLA)).toBeInTheDocument();
  });

  it("un nadador sin esas funciones NO entra por URL directa", async () => {
    abrirCon(["swimmer"], "/incorporaciones", { ownerType: "person", personId: "p-2" }, ["swimmer-assignment:read"]);
    expect(await screen.findByText("No autorizado")).toBeInTheDocument();
    expect(screen.queryByText(PANTALLA)).not.toBeInTheDocument();
  });

  it("personal sin club vigente en la sesión NO entra", async () => {
    abrirCon(["coach"], "/incorporaciones", { ownerType: "person", personId: "p-3", clubId: null }, ESCRITURA);
    expect(await screen.findByText("No autorizado")).toBeInTheDocument();
  });

  it.each([
    ["administración", ["admin"], {}],
    ["administración con un rol de club (precedencia de administración)", ["admin", "delegate"], { ownerType: "person" as const, personId: "p-4", clubId: "c-1" }],
  ])("%s usa sus pantallas: no entra a la del club", async (_n, roles, extra) => {
    abrirCon(roles, "/incorporaciones", extra, ESCRITURA);
    expect(await screen.findByText("No autorizado")).toBeInTheDocument();
  });
});
