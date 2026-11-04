/**
 * La raíz, las rutas desconocidas y /login frente a la sesión REAL.
 *
 * Incidente del 4 de noviembre de 2026: abrir `/` —que no tenía ruta— o una
 * dirección mal escrita llevaba a `/login` aunque la sesión estuviera restaurada
 * y viva (el `refresh` había respondido 200), y `/login` no redirigía a quien ya
 * tenía sesión. Parecía un cierre de sesión que no había ocurrido.
 *
 * `App.test.tsx` no podía verlo: sustituye `useAuth` y `LoginPage` por
 * marcadores, así que no hay restauración asíncrona ni formulario real. Aquí se
 * usan el `AuthProvider`, el enrutador, los guards y el `LoginPage` REALES; lo
 * único simulado es la capa HTTP (`authApi`) y las pantallas de destino, que
 * son marcadores porque lo que se comprueba es a dónde se llega.
 *
 * Todo con datos sintéticos y servicios simulados (jsdom): no sustituye a una
 * comprobación en un navegador real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { App } from "../../App";
import { reiniciarCoordinador } from "./refreshCoordinator";
import { reiniciarCsrf } from "./csrf";
import { ApiError } from "../../shared/apiClient";
import * as authApi from "./authApi";
import { perfilDePrueba, sesionDePrueba } from "../../test/sesionDePrueba";

vi.mock("./authApi");

// Destinos: marcadores. El resto de las pantallas no se renderiza en estas rutas.
vi.mock("../dashboard/AdminDashboardPage", () => ({ AdminDashboardPage: () => <p>PANTALLA panel admin</p> }));
vi.mock("./ForceChangePasswordPage", () => ({ ForceChangePasswordPage: () => <p>PANTALLA cambiar contraseña</p> }));

const SESION = sesionDePrueba(perfilDePrueba({ id: "u7", username: "admin.fchmn", roles: ["admin"] }), "csrf-prueba", [
  "reports:read",
]);
const SESION_CON_CAMBIO = { ...SESION, mustChangePassword: true };

const RUTAS_DE_ENTRADA = [
  ["la raíz", "/"],
  ["una ruta desconocida", "/esta-ruta-no-existe"],
  ["/login", "/login"],
] as const;

const FORMULARIO = () => screen.queryByRole("button", { name: "Ingresar" });
const ESPERA = () => screen.queryByText(/Restaurando sesión/);

function abrir(ruta: string) {
  window.history.pushState({}, "", ruta);
  return render(<App />);
}

/** Una promesa que la prueba resuelve o rechaza cuando quiere. */
function diferida<T>() {
  let resolver!: (v: T) => void;
  let rechazar!: (e: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
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

describe.each(RUTAS_DE_ENTRADA)("%s", (_nombre, ruta) => {
  it("con una sesión válida restaurada: llega al panel y NUNCA muestra el formulario", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION);

    abrir(ruta);

    expect(await screen.findByText("PANTALLA panel admin")).toBeInTheDocument();
    expect(FORMULARIO(), "el formulario de acceso aparenta un cierre de sesión que no ocurrió").not.toBeInTheDocument();
  });

  it("sin sesión (401 confirmado): conserva el formulario de acceso", async () => {
    vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("Sesión inválida", 401));

    abrir(ruta);

    expect(await screen.findByRole("button", { name: "Ingresar" })).toBeInTheDocument();
    expect(screen.queryByText("PANTALLA panel admin")).not.toBeInTheDocument();
  });

  it("restauración pendiente que termina bien: espera y luego entra, sin pasar por el formulario", async () => {
    const refresco = diferida<typeof SESION>();
    vi.mocked(authApi.apiRefresh).mockReturnValue(refresco.promesa);

    abrir(ruta);

    // Mientras se restaura no se decide nada: ni formulario ni panel.
    expect(await screen.findByText(/Restaurando sesión/)).toBeInTheDocument();
    expect(FORMULARIO()).not.toBeInTheDocument();
    expect(screen.queryByText("PANTALLA panel admin")).not.toBeInTheDocument();

    refresco.resolver(SESION);

    expect(await screen.findByText("PANTALLA panel admin")).toBeInTheDocument();
    expect(FORMULARIO(), "ni siquiera un instante").not.toBeInTheDocument();
    expect(ESPERA()).not.toBeInTheDocument();
  });

  it("restauración pendiente que termina SIN sesión: espera y luego muestra el formulario", async () => {
    const refresco = diferida<typeof SESION>();
    vi.mocked(authApi.apiRefresh).mockReturnValue(refresco.promesa);

    abrir(ruta);
    expect(await screen.findByText(/Restaurando sesión/)).toBeInTheDocument();

    refresco.rechazar(new ApiError("Sesión inválida", 401));

    expect(await screen.findByRole("button", { name: "Ingresar" })).toBeInTheDocument();
  });

  it("con el cambio de contraseña obligatorio: a la pantalla de cambio, no al panel ni al formulario", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION_CON_CAMBIO);

    abrir(ruta);

    expect(await screen.findByText("PANTALLA cambiar contraseña")).toBeInTheDocument();
    expect(screen.queryByText("PANTALLA panel admin")).not.toBeInTheDocument();
    expect(FORMULARIO()).not.toBeInTheDocument();
  });

  it("fallo transitorio de restauración (503): explica y ofrece reintentar, y al reintentar entra", async () => {
    vi.mocked(authApi.apiRefresh)
      .mockRejectedValueOnce(new ApiError("Servicio no disponible", 503))
      .mockResolvedValueOnce(SESION);

    abrir(ruta);

    const reintentar = await screen.findByRole("button", { name: "Reintentar" });
    expect(screen.getByText(/Su sesión no se ha cerrado/), "un 5xx no es una sesión vencida").toBeInTheDocument();
    expect(FORMULARIO(), "no se disfraza de sesión terminada").not.toBeInTheDocument();

    fireEvent.click(reintentar);

    expect(await screen.findByText("PANTALLA panel admin")).toBeInTheDocument();
    expect(FORMULARIO()).not.toBeInTheDocument();
    expect(vi.mocked(authApi.apiRefresh)).toHaveBeenCalledTimes(2);
  });

  it("fallo transitorio y, al reintentar, 401 confirmado: ahora sí el formulario", async () => {
    vi.mocked(authApi.apiRefresh)
      .mockRejectedValueOnce(new ApiError("Servicio no disponible", 503))
      .mockRejectedValueOnce(new ApiError("Sesión inválida", 401));

    abrir(ruta);
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar" }));

    expect(await screen.findByRole("button", { name: "Ingresar" })).toBeInTheDocument();
  });
});

describe("el formulario real: iniciar sesión sigue funcionando y no hace bucles", () => {
  it("login correcto desde /login: llega al panel una sola vez", async () => {
    vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("Sesión inválida", 401));
    vi.mocked(authApi.apiLogin).mockResolvedValue(SESION);

    abrir("/login");
    fireEvent.change(await screen.findByLabelText("Nombre de usuario"), { target: { value: "admin.fchmn" } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "clave-sintetica" } });
    fireEvent.click(screen.getByRole("button", { name: "Ingresar" }));

    expect(await screen.findByText("PANTALLA panel admin")).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/dashboard"));
    expect(FORMULARIO()).not.toBeInTheDocument();
    expect(vi.mocked(authApi.apiLogin)).toHaveBeenCalledTimes(1);
  });

  it("login con cambio de contraseña pendiente: a la pantalla de cambio", async () => {
    vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("Sesión inválida", 401));
    vi.mocked(authApi.apiLogin).mockResolvedValue(SESION_CON_CAMBIO);

    abrir("/login");
    fireEvent.change(await screen.findByLabelText("Nombre de usuario"), { target: { value: "admin.fchmn" } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "clave-sintetica" } });
    fireEvent.click(screen.getByRole("button", { name: "Ingresar" }));

    expect(await screen.findByText("PANTALLA cambiar contraseña")).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/cambiar-password"));
  });

  it("credenciales rechazadas: el formulario se queda, con su error", async () => {
    vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("Sesión inválida", 401));
    vi.mocked(authApi.apiLogin).mockRejectedValue(new ApiError("Credenciales inválidas", 401));

    abrir("/login");
    fireEvent.change(await screen.findByLabelText("Nombre de usuario"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "y" } });
    fireEvent.click(screen.getByRole("button", { name: "Ingresar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Credenciales inválidas");
    expect(window.location.pathname).toBe("/login");
  });
});
