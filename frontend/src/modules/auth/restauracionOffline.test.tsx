/**
 * Fase 6, hallazgo 27 — un fallo transitorio al restaurar NO manda al login.
 *
 * El defecto se veía solo montando el enrutador. Durante la restauración
 * inicial, un error de red o un 5xx dejaban `accessToken` vacío y terminaban
 * `restaurando`; `ProtectedRoute` leía eso, no podía distinguirlo de "no hay
 * sesión" y navegaba a `/login`. Resultado: un servidor reiniciándose o un wifi
 * que parpadea expulsaban a un usuario cuya sesión seguía viva en el servidor,
 * perdiendo lo que estuviera haciendo.
 *
 * Estas pruebas montan `AuthProvider` + `MemoryRouter` + `ProtectedRoute`
 * juntos, que es donde vivía el problema.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./AuthContext";
import { ProtectedRoute, RequireSession } from "./ProtectedRoute";
import { reiniciarCoordinador } from "./refreshCoordinator";
import { reiniciarCsrf } from "./csrf";
import { ApiError } from "../../shared/apiClient";
import * as authApi from "./authApi";
import { perfilDePrueba, sesionDePrueba } from "../../test/sesionDePrueba";

vi.mock("./authApi");

const PERFIL = perfilDePrueba({ id: "u1", username: "admin.fchmn" });
const SESION = sesionDePrueba(PERFIL, "csrf-sesion", ["clubs:read"]);

/** La aplicación real: rutas protegidas, login y una pantalla interna. */
function montar(rutaInicial = "/clubes") {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[rutaInicial]}>
        <Routes>
          <Route path="/login" element={<h1>Ingresar al sistema</h1>} />
          <Route element={<RequireSession />}>
            <Route path="/cambiar-password" element={<h1>Cambio de contraseña</h1>} />
          </Route>
          <Route element={<ProtectedRoute />}>
            <Route path="/clubes" element={<h1>Listado de clubes</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  reiniciarCoordinador();
  reiniciarCsrf();
  vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-sesion" });
});

describe("un fallo transitorio de restauración no navega a /login", () => {
  it.each([
    ["error del servidor (500)", new ApiError("Error interno", 500)],
    ["servicio no disponible (503)", new ApiError("No disponible", 503)],
    ["timeout de la pasarela (504)", new ApiError("Gateway timeout", 504)],
    ["red caída", new TypeError("Failed to fetch")],
  ])("%s: se queda en la ruta protegida y ofrece reintentar", async (_caso, error) => {
    sessionStorage.setItem("natacion.perfil", JSON.stringify(SESION.user));
    vi.mocked(authApi.apiRefresh).mockRejectedValue(error);

    montar("/clubes");

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    // Lo esencial: NO se navegó al login.
    expect(screen.queryByRole("heading", { name: /ingresar al sistema/i }), "un 5xx no es una sesión inválida").not.toBeInTheDocument();
    expect(screen.getByText(/no se pudo contactar al servidor/i)).toBeInTheDocument();
    expect(screen.getByText(/su sesión no se ha cerrado/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reintentar/i })).toBeInTheDocument();
  });

  it("el reintento recupera la sesión y muestra la pantalla pedida", async () => {
    vi.mocked(authApi.apiRefresh)
      .mockRejectedValueOnce(new ApiError("No disponible", 503))
      .mockResolvedValueOnce(SESION);

    montar("/clubes");
    await waitFor(() => expect(screen.getByRole("button", { name: /reintentar/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /reintentar/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: /listado de clubes/i })).toBeInTheDocument());
    expect(authApi.apiRefresh).toHaveBeenCalledTimes(2);
  });

  it("el mismo criterio en la ruta de cambio de contraseña", async () => {
    vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("No disponible", 503));

    montar("/cambiar-password");

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: /ingresar al sistema/i })).not.toBeInTheDocument();
  });
});

describe("un 401 confirmado SÍ manda al login", () => {
  it("la sesión es inválida: se limpia y se navega", async () => {
    sessionStorage.setItem("natacion.perfil", JSON.stringify(SESION.user));
    vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("Sesión inválida", 401));

    montar("/clubes");

    // Aquí el servidor SÍ opinó sobre la credencial.
    await waitFor(() => expect(screen.getByRole("heading", { name: /ingresar al sistema/i })).toBeInTheDocument());
    expect(screen.queryByRole("alert"), "no es un problema de conexión").not.toBeInTheDocument();
    expect(sessionStorage.getItem("natacion.perfil"), "el perfil se borra").toBeNull();
  });
});

describe("con sesión válida la ruta protegida se muestra", () => {
  it("no aparece ni el login ni la pantalla de reintento", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION);

    montar("/clubes");

    await waitFor(() => expect(screen.getByRole("heading", { name: /listado de clubes/i })).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
