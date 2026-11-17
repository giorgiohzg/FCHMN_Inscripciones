/**
 * «Clubes y nadadores» es EXCLUSIVO de administración, también por URL directa, y su pestaña solo
 * la ve administración. `AuthProvider`, enrutador y guards REALES; lo simulado es `authApi` y la
 * pantalla de destino (marcador). Datos sintéticos, jsdom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../../App";
import { reiniciarCoordinador } from "../auth/refreshCoordinator";
import { reiniciarCsrf } from "../auth/csrf";
import * as authApi from "../auth/authApi";
import { perfilDePrueba, sesionDePrueba } from "../../test/sesionDePrueba";

vi.mock("../auth/authApi");
vi.mock("./ClubesYNadadoresReportPage", () => ({ ClubesYNadadoresReportPage: () => <p>PANTALLA clubes y nadadores</p> }));
vi.mock("../dashboard/AdminDashboardPage", () => ({ AdminDashboardPage: () => <p>PANTALLA panel admin</p> }));

function abrirCon(roles: string[], extra: Partial<Parameters<typeof perfilDePrueba>[0]> = {}) {
  const perfil = perfilDePrueba({ id: "u-cn", username: "usuario.cn", roles, ...extra });
  vi.mocked(authApi.apiRefresh).mockResolvedValue(sesionDePrueba(perfil, "csrf-prueba", ["reports:read"]));
  window.history.pushState({}, "", "/reportes/clubes-y-nadadores");
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

describe("/reportes/clubes-y-nadadores", () => {
  it("administración entra", async () => {
    abrirCon(["admin"]);
    expect(await screen.findByText("PANTALLA clubes y nadadores")).toBeInTheDocument();
  });

  it.each([
    ["club", { ownerType: "club" as const, clubId: "c-1" }],
    ["delegate", { ownerType: "person" as const, personId: "p-2" }],
    ["coach", { ownerType: "person" as const, personId: "p-3" }],
    ["swimmer", { ownerType: "person" as const, personId: "p-4" }],
  ])("el rol %s no entra por URL directa", async (rol, extra) => {
    abrirCon([rol], extra);
    expect(await screen.findByText("No autorizado")).toBeInTheDocument();
    expect(screen.queryByText("PANTALLA clubes y nadadores")).not.toBeInTheDocument();
  });
});

describe("pestaña de Reportes", () => {
  it("solo administración ve «Clubes y nadadores»", async () => {
    const { ReportesNav } = await import("./ReportesNav");
    const { AuthProvider } = await import("../auth/AuthContext");
    vi.mocked(authApi.apiRefresh).mockResolvedValue(
      sesionDePrueba(perfilDePrueba({ id: "u-1", username: "adm", roles: ["admin"] }), "csrf", ["reports:read"])
    );
    render(
      <AuthProvider>
        <MemoryRouter>
          <ReportesNav />
        </MemoryRouter>
      </AuthProvider>
    );
    expect(await screen.findByRole("link", { name: "Clubes y nadadores" })).toHaveAttribute("href", "/reportes/clubes-y-nadadores");
  });
});
