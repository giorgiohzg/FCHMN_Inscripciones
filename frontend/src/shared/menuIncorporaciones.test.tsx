/** C-05, fase 4: el enlace «Incorporaciones» del menú sigue la misma regla que su ruta. */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "./AppShell";

let sesion = { roles: ["club"], permisos: ["swimmer-assignment:write"], clubId: "c-1" as string | null };
vi.mock("../modules/auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u", username: "usuario.sintetico", clubId: sesion.clubId, roles: sesion.roles },
    logout: vi.fn(),
    hasRole: (r: string) => sesion.roles.includes(r),
    hasPermission: (p: string) => sesion.permisos.includes(p),
  }),
}));
vi.mock("./AvisosTerceros", () => ({ AvisosTerceros: () => null }));

function menu() {
  render(
    <MemoryRouter>
      <AppShell>
        <p>contenido</p>
      </AppShell>
    </MemoryRouter>
  );
  return screen.queryByRole("link", { name: /Incorporaciones/ });
}

describe("menú: Incorporaciones", () => {
  it.each([
    ["la cuenta del club", ["club"], ["swimmer-assignment:write"], "c-1", true],
    ["el delegado con club", ["delegate"], ["swimmer-assignment:write"], "c-1", true],
    ["un nadador", ["swimmer"], ["swimmer-assignment:read"], null, false],
    ["administración", ["admin"], ["swimmer-assignment:write"], null, false],
    ["administración con rol de club", ["admin", "delegate"], ["swimmer-assignment:write"], "c-1", false],
  ])("%s → visible: %s", (_n, roles, permisos, clubId, visible) => {
    sesion = { roles, permisos, clubId };
    const enlace = menu();
    if (visible) expect(enlace).toHaveAttribute("href", "/incorporaciones");
    else expect(enlace).not.toBeInTheDocument();
  });
});
