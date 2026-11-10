/**
 * Cambio de contraseña VOLUNTARIO: «Cambiar contraseña» en la cabecera, para toda cuenta con sesión.
 *
 * Qué es simulado y qué no: se usan los componentes REALES (`AppShell`, `ForceChangePasswordPage`,
 * `AuthProvider`, guards y rutas de `App`), pero el cliente HTTP de autenticación (`authApi`) está
 * simulado: aquí no se hace ninguna petición de red. Que el backend rechace una contraseña actual
 * incorrecta o aplique la política se prueba en las pruebas del backend; aquí solo se comprueba qué
 * hace la interfaz con cada respuesta. No se ejercitó un navegador real.
 *
 * No se reutilizan pruebas de otra implementación: este archivo es propio de esta entrega.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { AuthProvider } from "./AuthContext";
import { ProtectedRoute, RequireSession } from "./ProtectedRoute";
import { LoginPage } from "./LoginPage";
import { ForceChangePasswordPage } from "./ForceChangePasswordPage";
import { AppShell } from "../../shared/AppShell";
import * as authApi from "./authApi";
import { perfilDePrueba, sesionDePrueba } from "../../test/sesionDePrueba";
import { reiniciarCoordinador } from "./refreshCoordinator";
import { reiniciarCsrf } from "./csrf";
import { ApiError } from "../../shared/apiClient";

vi.mock("./authApi");
vi.mock("../../assets/logo-fchmn.png", () => ({ default: "logo.png" }));

type Rol = "admin" | "club" | "delegate" | "coach" | "legal_representative" | "swimmer";

const CUENTAS: Record<string, { roles: Rol[]; ownerType: "system" | "club" | "person" }> = {
  administracion: { roles: ["admin"], ownerType: "system" },
  club: { roles: ["club"], ownerType: "club" },
  delegado: { roles: ["delegate"], ownerType: "person" },
  entrenador: { roles: ["coach"], ownerType: "person" },
  "representante legal": { roles: ["legal_representative"], ownerType: "person" },
  nadador: { roles: ["swimmer"], ownerType: "person" },
  "administracion y nadador": { roles: ["admin", "swimmer"], ownerType: "person" },
  "delegado y nadador": { roles: ["delegate", "swimmer"], ownerType: "person" },
};

function perfilDe(roles: Rol[], ownerType: "system" | "club" | "person") {
  return perfilDePrueba({
    id: "u-sintetico",
    username: "cuenta.sintetica",
    ownerType,
    personId: ownerType === "person" ? "p-sintetica" : null,
    clubId: ownerType === "club" ? "c-sintetico" : null,
    roles,
  });
}

/** Muestra la ruta actual para comprobar a dónde navega la interfaz. */
function Ruta() {
  return <span data-testid="ruta">{useLocation().pathname}</span>;
}

function Panel() {
  return (
    <AppShell>
      <h1>Panel principal</h1>
      <Ruta />
    </AppShell>
  );
}

function renderApp(ruta = "/login") {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[ruta]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireSession />}>
            <Route
              path="/cambiar-password"
              element={
                <>
                  <ForceChangePasswordPage />
                  <Ruta />
                </>
              }
            />
          </Route>
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<Panel />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

async function iniciarSesion() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/usuario/i), "cuenta.sintetica");
  await user.type(screen.getByLabelText(/contraseña/i), "ClaveSintetica123");
  await user.click(screen.getByRole("button", { name: /ingresar|iniciar/i }));
  return user;
}

function conSesion(roles: Rol[], ownerType: "system" | "club" | "person", mustChangePassword = false) {
  const perfil = perfilDe(roles, ownerType);
  vi.mocked(authApi.apiLogin).mockResolvedValue({ ...sesionDePrueba(perfil, "csrf-sintetico", [], "inicial"), mustChangePassword });
  return perfil;
}

async function abrirFormularioVoluntario() {
  const user = await iniciarSesion();
  await screen.findByRole("heading", { name: /panel principal/i });
  await user.click(screen.getByRole("link", { name: /^cambiar contraseña$/i }));
  await screen.findByRole("heading", { name: /^cambiar contraseña$/i });
  return user;
}

async function rellenar(user: ReturnType<typeof userEvent.setup>, actual: string, nueva: string, confirmacion: string) {
  await user.type(screen.getByLabelText(/^contraseña actual$/i), actual);
  await user.type(screen.getByLabelText(/^nueva contraseña$/i), nueva);
  await user.type(screen.getByLabelText(/confirmar nueva contraseña/i), confirmacion);
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  reiniciarCoordinador();
  reiniciarCsrf();
  vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-sintetico" });
  // Sin cookie de sesión al montar: el servidor responde 401 y se muestra el login.
  vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("Sesión inválida", 401));
  vi.mocked(authApi.apiLogout).mockResolvedValue(undefined);
});

describe("acceso desde la cabecera: toda cuenta con sesión lo ve", () => {
  for (const [nombre, { roles, ownerType }] of Object.entries(CUENTAS)) {
    it(`${nombre}: «Cambiar contraseña» está junto a «Cerrar sesión» y lleva a /cambiar-password`, async () => {
      conSesion(roles, ownerType);
      renderApp();
      const user = await iniciarSesion();
      await screen.findByRole("heading", { name: /panel principal/i });

      const cabecera = screen.getByRole("banner");
      const enlace = within(cabecera).getByRole("link", { name: /^cambiar contraseña$/i });
      const cerrar = within(cabecera).getByRole("button", { name: /cerrar sesión/i });
      expect(enlace).toHaveAttribute("href", "/cambiar-password");
      // Mismo contenedor que «Cerrar sesión».
      expect(enlace.parentElement).toBe(cerrar.parentElement);

      await user.click(enlace);
      expect(await screen.findByRole("heading", { name: /^cambiar contraseña$/i })).toBeInTheDocument();
      expect(screen.getByTestId("ruta")).toHaveTextContent("/cambiar-password");
    });
  }
});

describe("cambio voluntario: formulario", () => {
  it("muestra título, contraseña actual, nueva y confirmación, con etiquetas y autocomplete adecuados, y «Cancelar»", async () => {
    conSesion(["admin"], "system");
    renderApp();
    await abrirFormularioVoluntario();

    expect(screen.getByRole("form", { name: /^cambiar contraseña$/i })).toBeInTheDocument();
    expect(screen.queryByText(/debe cambiar su contraseña/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^contraseña actual$/i)).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText(/^nueva contraseña$/i)).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText(/confirmar nueva contraseña/i)).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByRole("button", { name: /guardar contraseña/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cancelar$/i })).toHaveAttribute("type", "button");
  });

  it("cambio correcto: envía una sola petición con los tres valores, adopta la sesión y vuelve al panel", async () => {
    const perfil = conSesion(["admin", "swimmer"], "person");
    vi.mocked(authApi.apiChangePassword).mockResolvedValue({ ...sesionDePrueba(perfil, "csrf-nuevo", [], "nuevo"), mustChangePassword: false });
    renderApp();
    const user = await abrirFormularioVoluntario();

    await rellenar(user, "ClaveSintetica123", "NuevaClave456", "NuevaClave456");
    await user.click(screen.getByRole("button", { name: /guardar contraseña/i }));

    await screen.findByRole("heading", { name: /panel principal/i });
    expect(authApi.apiChangePassword).toHaveBeenCalledTimes(1);
    expect(authApi.apiChangePassword).toHaveBeenCalledWith({
      currentPassword: "ClaveSintetica123",
      newPassword: "NuevaClave456",
      confirmPassword: "NuevaClave456",
    });
    expect(screen.getByTestId("ruta")).toHaveTextContent("/dashboard");
    // Ninguna contraseña queda en el almacenamiento del navegador.
    expect(JSON.stringify(sessionStorage)).not.toMatch(/ClaveSintetica123|NuevaClave456/);
  });

  it("«Cancelar» vuelve al panel sin ninguna petición y sin cambiar la sesión", async () => {
    conSesion(["club"], "club");
    renderApp();
    const user = await abrirFormularioVoluntario();
    await user.type(screen.getByLabelText(/^contraseña actual$/i), "algo");

    await user.click(screen.getByRole("button", { name: /^cancelar$/i }));

    await screen.findByRole("heading", { name: /panel principal/i });
    expect(screen.getByTestId("ruta")).toHaveTextContent("/dashboard");
    expect(authApi.apiChangePassword).not.toHaveBeenCalled();
    expect(authApi.apiLogout).not.toHaveBeenCalled();
    // La sesión sigue: la cabecera conserva su acceso.
    expect(screen.getByRole("link", { name: /^cambiar contraseña$/i })).toBeInTheDocument();
  });

  it("confirmación distinta: se rechaza en el cliente, sin petición, y se queda en el formulario", async () => {
    conSesion(["delegate"], "person");
    renderApp();
    const user = await abrirFormularioVoluntario();

    await rellenar(user, "ClaveSintetica123", "NuevaClave456", "OtraClave789");
    await user.click(screen.getByRole("button", { name: /guardar contraseña/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no coinciden/i);
    expect(authApi.apiChangePassword).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /^cambiar contraseña$/i })).toBeInTheDocument();
  });

  it("contraseña actual rechazada por el servidor: muestra el error, no navega y conserva la sesión", async () => {
    conSesion(["swimmer"], "person");
    vi.mocked(authApi.apiChangePassword).mockRejectedValue(new ApiError("La contraseña actual es incorrecta", 400));
    renderApp();
    const user = await abrirFormularioVoluntario();

    await rellenar(user, "ClaveEquivocada1", "NuevaClave456", "NuevaClave456");
    await user.click(screen.getByRole("button", { name: /guardar contraseña/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/contraseña actual es incorrecta/i);
    expect(authApi.apiChangePassword).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: /^cambiar contraseña$/i })).toBeInTheDocument();
    expect(screen.getByTestId("ruta")).toHaveTextContent("/cambiar-password");
    expect(authApi.apiLogout).not.toHaveBeenCalled();
    // Se puede reintentar o cancelar.
    expect(screen.getByRole("button", { name: /^cancelar$/i })).toBeEnabled();
  });

  it("contraseña nueva rechazada por la política del servidor: muestra el motivo y no navega", async () => {
    conSesion(["coach"], "person");
    vi.mocked(authApi.apiChangePassword).mockRejectedValue(new ApiError("La nueva contraseña no cumple la política", 400));
    renderApp();
    const user = await abrirFormularioVoluntario();

    await rellenar(user, "ClaveSintetica123", "Abcdefghij1", "Abcdefghij1");
    await user.click(screen.getByRole("button", { name: /guardar contraseña/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no cumple la política/i);
    expect(screen.getByTestId("ruta")).toHaveTextContent("/cambiar-password");
  });
});

describe("cambio obligatorio: se conserva", () => {
  it("aviso y título de siempre, contraseña temporal, sin «Cancelar»", async () => {
    conSesion(["swimmer"], "person", true);
    renderApp();
    await iniciarSesion();

    expect(await screen.findByRole("heading", { name: /debe cambiar su contraseña/i })).toBeInTheDocument();
    expect(screen.getByText(/antes de continuar/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/contraseña actual \(temporal\)/i)).toBeInTheDocument();
    expect(screen.getByRole("form", { name: /cambio de contraseña obligatorio/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /guardar y continuar/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancelar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^cambiar contraseña$/i })).not.toBeInTheDocument();
  });

  it("el login con cambio obligatorio redirige al formulario y no muestra el panel ni el acceso voluntario", async () => {
    conSesion(["admin"], "system", true);
    renderApp();
    await iniciarSesion();
    await screen.findByRole("heading", { name: /debe cambiar su contraseña/i });

    expect(screen.queryByRole("heading", { name: /panel principal/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^cambiar contraseña$/i })).not.toBeInTheDocument();
  });

  it("al cambiar la temporal, adopta la sesión y entra al panel", async () => {
    const perfil = conSesion(["club"], "club", true);
    vi.mocked(authApi.apiChangePassword).mockResolvedValue({ ...sesionDePrueba(perfil, "csrf-nuevo", [], "nuevo"), mustChangePassword: false });
    renderApp();
    const user = await iniciarSesion();
    await screen.findByRole("heading", { name: /debe cambiar su contraseña/i });

    await user.type(screen.getByLabelText(/contraseña actual \(temporal\)/i), "TemporalSintetica1");
    await user.type(screen.getByLabelText(/^nueva contraseña$/i), "NuevaClave456");
    await user.type(screen.getByLabelText(/confirmar nueva contraseña/i), "NuevaClave456");
    await user.click(screen.getByRole("button", { name: /guardar y continuar/i }));

    await screen.findByRole("heading", { name: /panel principal/i });
    expect(authApi.apiChangePassword).toHaveBeenCalledTimes(1);
  });
});

describe("sin sesión", () => {
  it("/cambiar-password lleva al login y no muestra el formulario", async () => {
    renderApp("/cambiar-password");

    expect(await screen.findByRole("button", { name: /ingresar|iniciar/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/contraseña actual/i)).not.toBeInTheDocument();
    expect(authApi.apiChangePassword).not.toHaveBeenCalled();
  });

  it("el login no ofrece «Cambiar contraseña»", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByRole("button", { name: /ingresar|iniciar/i })).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /cambiar contraseña/i })).not.toBeInTheDocument();
  });
});
