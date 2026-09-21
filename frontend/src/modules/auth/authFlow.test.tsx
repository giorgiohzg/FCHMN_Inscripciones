/**
 * Flujo de sesión en el frontend: los tres defectos del hallazgo 1 que se
 * manifestaban en la interfaz.
 *
 * Se prueba a través de los componentes reales (no llamando a funciones
 * sueltas) porque los defectos estaban justo en la coordinación entre el
 * estado de React, la navegación y la respuesta del backend.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./AuthContext";
import { ProtectedRoute, RequireSession } from "./ProtectedRoute";
import { LoginPage } from "./LoginPage";
import { ForceChangePasswordPage } from "./ForceChangePasswordPage";
import * as authApi from "./authApi";
import { perfilDePrueba, sesionDePrueba, tokenDePerfil } from "../../test/sesionDePrueba";
import { reiniciarCoordinador } from "./refreshCoordinator";
import { reiniciarCsrf } from "./csrf";
import { ApiError } from "../../shared/apiClient";

vi.mock("./authApi");
vi.mock("../../assets/logo-fchmn.png", () => ({ default: "logo.png" }));

/**
 * Sin `refreshToken`: desde el hallazgo 27 viaja en una cookie HttpOnly y este
 * código no puede verlo. El backend tampoco lo devuelve ya en el cuerpo.
 */
/**
 * El access token tiene que ser un JWT decodificable cuyo `sub` sea el id del
 * usuario: desde la validación en tiempo de ejecución, una cadena cualquiera ya
 * no se adopta como sesión.
 */
const PERFIL = perfilDePrueba({
  id: "u1",
  username: "usuario",
  ownerType: "person",
  personId: "p1",
  roles: ["swimmer"],
});

const tokenDe = (_sub: string, marca: string) => tokenDePerfil(PERFIL, [], marca);

// La comprobación CSRF se exige siempre: una sesión real trae token.
const SESION_INICIAL = { ...sesionDePrueba(PERFIL, "csrf-sesion", [], "inicial") };

function renderApp(initialPath = "/login") {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireSession />}>
            <Route path="/cambiar-password" element={<ForceChangePasswordPage />} />
          </Route>
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<h1>Panel principal</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

async function iniciarSesion() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/usuario/i), "usuario");
  await user.type(screen.getByLabelText(/contraseña/i), "ClaveValida123");
  await user.click(screen.getByRole("button", { name: /ingresar|iniciar/i }));
  return user;
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  reiniciarCoordinador();
  reiniciarCsrf();
  vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-sesion" });
  /**
   * Al montar, `AuthProvider` intenta restaurar la sesión con la cookie. En
   * estas pruebas no hay cookie, y eso el servidor lo responde con un 401.
   *
   * El código de estado importa: un error genérico se clasifica como fallo
   * TRANSITORIO —red caída, 5xx— y entonces no se navega al login, sino que se
   * muestra la pantalla de reintento. Solo el 401 significa "no hay sesión".
   */
  vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("Sesión inválida", 401));
  vi.mocked(authApi.apiLogout).mockResolvedValue(undefined);
});

describe("navegación tras el login", () => {
  it("lleva a la pantalla de cambio cuando la contraseña está pendiente", async () => {
    vi.mocked(authApi.apiLogin).mockResolvedValue({ ...SESION_INICIAL, mustChangePassword: true });

    renderApp();
    await iniciarSesion();

    // El defecto: se leía `mustChangePassword` del contexto justo después del
    // `await login(...)`, cuando todavía tenía el valor anterior (false), y
    // el usuario terminaba en el panel.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /debe cambiar su contraseña/i })).toBeInTheDocument();
    });
  });

  it("lleva al panel cuando no hay cambio pendiente", async () => {
    vi.mocked(authApi.apiLogin).mockResolvedValue({ ...SESION_INICIAL, mustChangePassword: false });

    renderApp();
    await iniciarSesion();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /panel principal/i })).toBeInTheDocument();
    });
  });
});

describe("recuperación de contraseña", () => {
  it("no ofrece un enlace de auto-recuperación (la ruta no existe)", () => {
    renderApp();

    const enlaces = screen.queryAllByRole("link");
    expect(enlaces.filter((a) => a.getAttribute("href")?.includes("password"))).toHaveLength(0);
  });

  it("explica cómo recuperar el acceso por la vía administrativa", () => {
    renderApp();

    expect(screen.getByText(/olvidó su contraseña/i)).toBeInTheDocument();
    expect(screen.getByText(/administrador/i)).toBeInTheDocument();
    expect(screen.getByText(/contraseña temporal/i)).toBeInTheDocument();
  });
});

describe("protección de /cambiar-password", () => {
  it("redirige al login si no hay sesión", async () => {
    renderApp("/cambiar-password");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /ingresar|iniciar/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: /debe cambiar su contraseña/i })).not.toBeInTheDocument();
  });
});

describe("cambio de contraseña", () => {
  it("adopta la sesión nueva que devuelve el backend", async () => {
    vi.mocked(authApi.apiLogin).mockResolvedValue({ ...SESION_INICIAL, mustChangePassword: true });
    vi.mocked(authApi.apiChangePassword).mockResolvedValue({
      ...SESION_INICIAL,
      accessToken: tokenDe("u1", "nuevo"),
      mustChangePassword: false,
      csrfToken: "csrf-nuevo",
    });

    renderApp();
    const user = await iniciarSesion();

    await waitFor(() => expect(screen.getByRole("heading", { name: /debe cambiar su contraseña/i })).toBeInTheDocument());

    await user.type(screen.getByLabelText(/contraseña actual/i), "ClaveValida123");
    await user.type(screen.getByLabelText(/^nueva contraseña$/i), "NuevaClave123");
    await user.type(screen.getByLabelText(/confirmar nueva contraseña/i), "NuevaClave123");
    await user.click(screen.getByRole("button", { name: /guardar y continuar/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /panel principal/i })).toBeInTheDocument();
    });

    /**
     * Ninguna credencial queda en el almacenamiento del navegador.
     *
     * Antes se guardaban ahí los DOS tokens (`natacion.auth`), legibles por
     * cualquier script de la página. Ahora el refresh vive en una cookie
     * HttpOnly y el access token en memoria; lo único que se persiste es el
     * perfil visible, para no pintar la aplicación vacía tras una recarga.
     */
    expect(sessionStorage.getItem("natacion.auth"), "la clave antigua ya no existe").toBeNull();

    const volcado = JSON.stringify(sessionStorage);
    expect(volcado, "el access token no se persiste").not.toContain(tokenDe("u1", "nuevo"));
    expect(volcado).not.toContain(tokenDe("u1", "inicial"));

    const perfil = JSON.parse(sessionStorage.getItem("natacion.perfil") ?? "{}");
    expect(perfil.username, "el perfil visible sí, y no es una credencial").toBe("usuario");
  });
});
