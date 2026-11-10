/**
 * C-04 en la interfaz: respuestas del cambio de contraseña y recuperación.
 *
 * Simulado: componentes, contexto y rutas REALES, con el cliente de autenticación
 * (`authApi`) simulado. Las respuestas imitan las del backend: 400 por contraseña actual
 * incorrecta, 429 por un cambio en curso, 409 por un resultado obsoleto y 401 con el código
 * `PASSWORD_CHANGE_ATTEMPTS_EXCEEDED` cuando el servidor terminó la sesión en el quinto
 * fallo. No hay red ni navegador real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import { ProtectedRoute, RequireSession } from "./ProtectedRoute";
import { LoginPage } from "./LoginPage";
import { ForceChangePasswordPage } from "./ForceChangePasswordPage";
import { AppShell } from "../../shared/AppShell";
import * as authApi from "./authApi";
import { perfilDePrueba, sesionDePrueba } from "../../test/sesionDePrueba";
import { reiniciarCoordinador, comenzarCicloDeSesion } from "./refreshCoordinator";
import { reiniciarCsrf } from "./csrf";
import { descartarAvisoDeAcceso, leerAvisoDeAcceso } from "./avisoDeAcceso";
import { ApiError, SesionCambiadaError } from "../../shared/apiClient";

vi.mock("./authApi");
vi.mock("../../assets/logo-fchmn.png", () => ({ default: "logo.png" }));

const CODIGO = "PASSWORD_CHANGE_ATTEMPTS_EXCEEDED";
const AGOTADOS =
  "Demasiados intentos con una contraseña actual incorrecta. Por seguridad se cerró esta sesión: inicie sesión nuevamente.";
const agotados = () => new ApiError(AGOTADOS, 401, CODIGO);
const incorrecta = () => new ApiError("La contraseña actual es incorrecta", 400, "VALIDATION_ERROR");

const PERFIL = perfilDePrueba({ id: "u-sint", username: "cuenta.sintetica", ownerType: "person", personId: "p-sint", roles: ["swimmer"] });

function renderApp() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireSession />}>
            <Route path="/cambiar-password" element={<ForceChangePasswordPage />} />
          </Route>
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<AppShell><h1>Panel principal</h1></AppShell>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

function conSesion(mustChangePassword: boolean) {
  vi.mocked(authApi.apiLogin).mockResolvedValue({ ...sesionDePrueba(PERFIL, "csrf-sint", [], "inicial"), mustChangePassword });
}

async function entrarYAbrir(user: ReturnType<typeof userEvent.setup>, obligatorio: boolean) {
  await user.type(screen.getByLabelText(/usuario/i), "cuenta.sintetica");
  await user.type(screen.getByLabelText(/^contraseña$/i), "ClaveSintetica123");
  await user.click(screen.getByRole("button", { name: /ingresar/i }));
  if (obligatorio) {
    await screen.findByRole("heading", { name: /debe cambiar su contraseña/i });
  } else {
    await screen.findByRole("heading", { name: /panel principal/i });
    await user.click(screen.getByRole("link", { name: /^cambiar contraseña$/i }));
    await screen.findByRole("heading", { name: /^cambiar contraseña$/i });
  }
}

/**
 * Rellena con `fireEvent.change`: el tecleo carácter a carácter no es lo que se prueba aquí
 * (lo cubre `cambioVoluntarioContrasena.test.tsx`), y repetirlo cinco veces solo alarga la prueba.
 */
async function enviar(user: ReturnType<typeof userEvent.setup>, obligatorio: boolean) {
  fireEvent.change(screen.getByLabelText(/contraseña actual/i), { target: { value: "ClaveEquivocada1" } });
  fireEvent.change(screen.getByLabelText(/^nueva contraseña$/i), { target: { value: "NuevaClave456" } });
  fireEvent.change(screen.getByLabelText(/confirmar nueva contraseña/i), { target: { value: "NuevaClave456" } });
  await user.click(screen.getByRole("button", { name: obligatorio ? /guardar y continuar/i : /guardar contraseña/i }));
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  reiniciarCoordinador();
  reiniciarCsrf();
  descartarAvisoDeAcceso();
  vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-sint" });
  // Sin cookie al montar: la restauración inicial responde 401 y se muestra el login.
  vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("Sesión inválida", 401));
  vi.mocked(authApi.apiLogout).mockResolvedValue(undefined);
});

for (const obligatorio of [false, true]) {
  const modo = obligatorio ? "obligatorio" : "voluntario";

  describe(`cambio ${modo}`, () => {
    it("los cuatro primeros fallos no expulsan; el quinto lleva al login con el motivo, sin renovar ni reintentar", async () => {
      conSesion(obligatorio);
      vi.mocked(authApi.apiChangePassword)
        .mockRejectedValueOnce(incorrecta())
        .mockRejectedValueOnce(incorrecta())
        .mockRejectedValueOnce(incorrecta())
        .mockRejectedValueOnce(incorrecta())
        .mockRejectedValueOnce(agotados());
      renderApp();
      const user = userEvent.setup();
      await entrarYAbrir(user, obligatorio);
      const refrescosAntes = vi.mocked(authApi.apiRefresh).mock.calls.length;

      for (let i = 1; i <= 4; i++) {
        await enviar(user, obligatorio);
        expect(await screen.findByRole("alert")).toHaveTextContent(/contraseña actual es incorrecta/i);
        expect(screen.getByLabelText(/contraseña actual/i), `sigue en el formulario tras ${i}`).toBeInTheDocument();
      }

      await enviar(user, obligatorio);
      expect(await screen.findByRole("button", { name: /ingresar/i })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(/demasiados intentos/i);
      expect(authApi.apiChangePassword, "sin reintento del cambio").toHaveBeenCalledTimes(5);
      expect(vi.mocked(authApi.apiRefresh).mock.calls.length, "sin renovación tras el cierre terminal").toBe(refrescosAntes);
      expect(authApi.apiLogout).not.toHaveBeenCalled();
    });
  });
}

describe("el cierre terminal no depende de la renovación", () => {
  for (const [nombre, falloDeRed] of [
    ["fallo de red", () => new TypeError("Failed to fetch")],
    ["503", () => new ApiError("Servicio no disponible", 503)],
  ] as const) {
    it(`con la renovación preparada para fallar (${nombre}): no se invoca y la sesión se cierra igual`, async () => {
      conSesion(false);
      vi.mocked(authApi.apiChangePassword).mockRejectedValueOnce(agotados());
      renderApp();
      const user = userEvent.setup();
      await entrarYAbrir(user, false);

      vi.mocked(authApi.apiRefresh).mockReset();
      vi.mocked(authApi.apiRefresh).mockRejectedValue(falloDeRed());
      await enviar(user, false);

      expect(await screen.findByRole("button", { name: /ingresar/i })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(/demasiados intentos/i);
      expect(authApi.apiRefresh).not.toHaveBeenCalled();
      expect(authApi.apiChangePassword).toHaveBeenCalledTimes(1);
    });
  }
});

describe("se conserva el comportamiento anterior", () => {
  it("401 genérico (access token vencido) con renovación válida: renueva, reintenta una vez y adopta la sesión nueva", async () => {
    conSesion(false);
    renderApp();
    const user = userEvent.setup();
    await entrarYAbrir(user, false);

    vi.mocked(authApi.apiRefresh).mockReset();
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(sesionDePrueba(PERFIL, "csrf-renovado", [], "renovada"));
    vi.mocked(authApi.apiChangePassword)
      .mockRejectedValueOnce(new ApiError("Token de acceso inválido o expirado", 401, "UNAUTHORIZED"))
      .mockResolvedValueOnce(sesionDePrueba(PERFIL, "csrf-tras-cambio", [], "tras-cambio"));
    await enviar(user, false);

    expect(await screen.findByRole("heading", { name: /panel principal/i })).toBeInTheDocument();
    expect(authApi.apiRefresh).toHaveBeenCalledTimes(1);
    expect(authApi.apiChangePassword).toHaveBeenCalledTimes(2);
    expect(leerAvisoDeAcceso()).toBeNull();
  });

  it("401 genérico, renovación correcta y 401 TERMINAL en el reintento: al login con el aviso, dos envíos y una renovación", async () => {
    conSesion(false);
    renderApp();
    const user = userEvent.setup();
    await entrarYAbrir(user, false);

    vi.mocked(authApi.apiRefresh).mockReset();
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(sesionDePrueba(PERFIL, "csrf-renovado", [], "renovada"));
    vi.mocked(authApi.apiChangePassword)
      .mockRejectedValueOnce(new ApiError("Token de acceso inválido o expirado", 401, "UNAUTHORIZED"))
      .mockRejectedValueOnce(agotados());
    await enviar(user, false);

    expect(await screen.findByRole("button", { name: /ingresar/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/demasiados intentos/i);
    expect(authApi.apiChangePassword, "sin un tercer envío").toHaveBeenCalledTimes(2);
    expect(authApi.apiRefresh, "una sola renovación").toHaveBeenCalledTimes(1);
  });

  it("429 (cambio en curso) y 409 (resultado obsoleto): muestran el motivo y conservan la sesión", async () => {
    conSesion(false);
    vi.mocked(authApi.apiChangePassword)
      .mockRejectedValueOnce(new ApiError("Hay un cambio de contraseña en curso en esta sesión. Espere unos segundos y vuelva a intentarlo.", 429, "PASSWORD_CHANGE_IN_PROGRESS"))
      .mockRejectedValueOnce(new ApiError("La solicitud de cambio de contraseña no pudo completarse. Vuelva a intentarlo.", 409, "CONFLICT"));
    renderApp();
    const user = userEvent.setup();
    await entrarYAbrir(user, false);
    const refrescosAntes = vi.mocked(authApi.apiRefresh).mock.calls.length;

    await enviar(user, false);
    expect(await screen.findByRole("alert")).toHaveTextContent(/en curso/i);
    await enviar(user, false);
    expect(await screen.findByRole("alert")).toHaveTextContent(/no pudo completarse/i);
    expect(screen.getByRole("heading", { name: /^cambiar contraseña$/i })).toBeInTheDocument();
    expect(vi.mocked(authApi.apiRefresh).mock.calls.length).toBe(refrescosAntes);
  });

  it("el aviso del login desaparece al volver a intentar entrar", async () => {
    conSesion(false);
    vi.mocked(authApi.apiChangePassword).mockRejectedValueOnce(agotados());
    renderApp();
    const user = userEvent.setup();
    await entrarYAbrir(user, false);
    await enviar(user, false);
    await screen.findByRole("button", { name: /ingresar/i });
    expect(screen.getByRole("status")).toHaveTextContent(/demasiados intentos/i);

    vi.mocked(authApi.apiLogin).mockRejectedValueOnce(new ApiError("Usuario o contraseña incorrectos", 401, "UNAUTHORIZED"));
    await user.clear(screen.getByLabelText(/usuario/i));
    await user.type(screen.getByLabelText(/usuario/i), "cuenta.sintetica");
    await user.type(screen.getByLabelText(/^contraseña$/i), "ClaveSintetica123");
    await user.click(screen.getByRole("button", { name: /ingresar/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/incorrectos/i);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("respuesta terminal antigua", () => {
  /** Expone el estado y el desenlace del cambio, sin pantallas de por medio. */
  const desenlaces: string[] = [];
  function Sonda() {
    const { accessToken, changePassword } = useAuth();
    return (
      <div>
        <span data-testid="estado">{accessToken ? "con-sesion" : "sin-sesion"}</span>
        <button
          onClick={() => {
            void changePassword({ currentPassword: "ClaveEquivocada1", newPassword: "NuevaClave456", confirmPassword: "NuevaClave456" })
              .then(() => desenlaces.push("ok"))
              .catch((e: unknown) => desenlaces.push(e instanceof SesionCambiadaError ? "sesion-cambiada" : `error:${(e as Error).message}`));
          }}
        >
          Cambiar
        </button>
      </div>
    );
  }

  it("si llega después de que empezó otra sesión, no cierra la nueva ni deja aviso", async () => {
    desenlaces.length = 0;
    vi.mocked(authApi.apiRefresh).mockReset();
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(sesionDePrueba(PERFIL, "csrf-inicial", [], "inicial"));
    render(
      <AuthProvider>
        <Sonda />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"));

    // Mientras la petición está en vuelo empieza otra sesión (otro inicio de sesión,
    // anunciado por otra pestaña); después llega el 401 terminal de la anterior.
    vi.mocked(authApi.apiChangePassword).mockImplementationOnce(async () => {
      comenzarCicloDeSesion();
      throw agotados();
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Cambiar" }));

    await waitFor(() => expect(desenlaces).toEqual(["sesion-cambiada"]));
    expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion");
    expect(leerAvisoDeAcceso()).toBeNull();
    expect(authApi.apiLogout).not.toHaveBeenCalled();
    expect(authApi.apiRefresh, "solo la restauración inicial").toHaveBeenCalledTimes(1);
    expect(authApi.apiChangePassword).toHaveBeenCalledTimes(1);
  });

  it("si el terminal del REINTENTO llega después de que empezó otra sesión, tampoco la cierra ni deja aviso", async () => {
    desenlaces.length = 0;
    vi.mocked(authApi.apiRefresh).mockReset();
    vi.mocked(authApi.apiRefresh)
      .mockResolvedValueOnce(sesionDePrueba(PERFIL, "csrf-inicial", [], "inicial")) // restauración al montar
      .mockResolvedValueOnce(sesionDePrueba(PERFIL, "csrf-renovado", [], "renovada")); // renovación tras el 401 genérico
    render(
      <AuthProvider>
        <Sonda />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"));

    vi.mocked(authApi.apiChangePassword)
      .mockRejectedValueOnce(new ApiError("Token de acceso inválido o expirado", 401, "UNAUTHORIZED"))
      .mockImplementationOnce(async () => {
        comenzarCicloDeSesion();
        throw agotados();
      });
    await userEvent.setup().click(screen.getByRole("button", { name: "Cambiar" }));

    await waitFor(() => expect(desenlaces).toEqual(["sesion-cambiada"]));
    expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion");
    expect(leerAvisoDeAcceso()).toBeNull();
    expect(authApi.apiLogout).not.toHaveBeenCalled();
    expect(authApi.apiChangePassword, "sin un tercer envío").toHaveBeenCalledTimes(2);
    expect(authApi.apiRefresh, "restauración y una renovación").toHaveBeenCalledTimes(2);
  });
});
