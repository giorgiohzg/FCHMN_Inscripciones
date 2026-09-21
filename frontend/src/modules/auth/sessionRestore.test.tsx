/**
 * Fase 6, hallazgo 27 — restauración de sesión y fallos transitorios.
 *
 * Dos defectos distintos:
 *
 *  1. `/auth/refresh` devolvía solo el access token. Como el access token vive
 *     en memoria y se pierde al recargar, el refresco es la ÚNICA vía de
 *     reconstruir la sesión — y sin el perfil, quien recargaba quedaba
 *     autenticado sin saber quién era. El perfil de `sessionStorage` no puede
 *     tapar el hueco: puede estar vacío (pestaña nueva, modo privado, datos
 *     borrados) mientras la cookie sigue siendo válida.
 *
 *  2. Cualquier error de renovación borraba la sesión. Un corte de red o un
 *     reinicio del servidor expulsaban al usuario aunque su cookie fuera
 *     perfectamente válida, perdiendo lo que estuviera haciendo.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthContext";
import { reiniciarCoordinador } from "./refreshCoordinator";
import { reiniciarCsrf } from "./csrf";
import { ApiError } from "../../shared/apiClient";
import * as authApi from "./authApi";
import { perfilDePrueba, sesionDePrueba } from "../../test/sesionDePrueba";

vi.mock("./authApi");

/**
 * Sesión de un administrador, tal como la devuelve el backend al refrescar.
 *
 * El token se DERIVA del perfil: la validación compara `sub`, `ownerType`,
 * `personId`, `clubId` y roles entre los claims y el usuario, así que los
 * fixtures no pueden escribir cada mitad por su cuenta.
 */
const PERFIL_ADMIN = perfilDePrueba({ id: "u7", username: "admin.fchmn", roles: ["admin"] });

// La comprobación CSRF se exige siempre, con cualquier SameSite: una sesión real
// siempre trae token.
const SESION_ADMIN = sesionDePrueba(PERFIL_ADMIN, "csrf-sesion", ["clubs:write", "audit:read"]);

/** Muestra todo lo que la aplicación necesita saber de la sesión. */
function Sonda() {
  const { user, permissions, mustChangePassword, restaurando, accessToken, hasRole, hasPermission } = useAuth();
  return (
    <div>
      <span data-testid="estado">{restaurando ? "restaurando" : accessToken ? "con-sesion" : "sin-sesion"}</span>
      <span data-testid="username">{user?.username ?? "-"}</span>
      <span data-testid="ownerType">{user?.ownerType ?? "-"}</span>
      <span data-testid="clubId">{user?.clubId ?? "-"}</span>
      <span data-testid="roles">{(user?.roles ?? []).join(",")}</span>
      <span data-testid="permissions">{permissions.join(",")}</span>
      <span data-testid="mustChange">{String(mustChangePassword)}</span>
      <span data-testid="esAdmin">{String(hasRole("admin"))}</span>
      <span data-testid="puedeAuditar">{String(hasPermission("audit:read"))}</span>
    </div>
  );
}

const renderizar = () =>
  render(
    <AuthProvider>
      <Sonda />
    </AuthProvider>
  );

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  reiniciarCoordinador();
  reiniciarCsrf();
  vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-sesion" });
  vi.mocked(authApi.apiLogout).mockResolvedValue(undefined);
});

describe("el refresco reconstruye el perfil COMPLETO", () => {
  /**
   * Es el escenario que importa: pestaña nueva o almacenamiento borrado, con la
   * cookie todavía válida. Nada puede venir de `sessionStorage` porque no hay
   * nada; todo tiene que llegar en la respuesta del refresco.
   */
  it("con sessionStorage VACÍO, recupera usuario, roles, club, permisos y estado", async () => {
    expect(sessionStorage.length, "punto de partida: sin nada guardado").toBe(0);
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION_ADMIN);

    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"));

    expect(screen.getByTestId("username"), "sin esto la aplicación no sabe quién entró").toHaveTextContent("admin.fchmn");
    expect(screen.getByTestId("ownerType")).toHaveTextContent("system");
    expect(screen.getByTestId("roles")).toHaveTextContent("admin");
    expect(screen.getByTestId("permissions")).toHaveTextContent("clubs:write,audit:read");
    expect(screen.getByTestId("mustChange")).toHaveTextContent("false");
  });

  it("el acceso administrativo queda disponible tras recargar", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION_ADMIN);

    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"));

    // Con el perfil vacío, `hasRole("admin")` daba false y el enrutador mandaba
    // a /no-autorizado a un administrador con sesión válida.
    expect(screen.getByTestId("esAdmin"), "las rutas de admin dependen de esto").toHaveTextContent("true");
    expect(screen.getByTestId("puedeAuditar")).toHaveTextContent("true");
  });

  it("recupera también el club de un usuario de club", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue({
      ...sesionDePrueba(
        perfilDePrueba({ id: "u8", username: "club_uno", ownerType: "club", clubId: "club-42", roles: ["club"] }),
        "csrf-sesion",
        ["registrations:write"]
      ),
    });

    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"));

    // El `clubId` decide qué plantel ve: sin él, un club no ve nada suyo.
    expect(screen.getByTestId("clubId")).toHaveTextContent("club-42");
    expect(screen.getByTestId("roles")).toHaveTextContent("club");
  });

  it("un cambio de contraseña pendiente sobrevive a la recarga", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue({ ...SESION_ADMIN, mustChangePassword: true });

    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"));

    // Si se perdiera, un usuario con cambio obligatorio entraría al sistema sin
    // cambiar la contraseña con solo recargar la página.
    expect(screen.getByTestId("mustChange")).toHaveTextContent("true");
  });

  it("el perfil del servidor MANDA sobre el guardado en el navegador", async () => {
    // Perfil viejo en caché: roles de club.
    sessionStorage.setItem(
      "natacion.perfil",
      JSON.stringify({ id: "u7", username: "nombre.viejo", ownerType: "club", personId: null, clubId: "c9", roles: ["club"] })
    );
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION_ADMIN);

    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"));

    expect(screen.getByTestId("username"), "la caché no puede ganarle al servidor").toHaveTextContent("admin.fchmn");
    expect(screen.getByTestId("ownerType")).toHaveTextContent("system");
  });
});

describe("un fallo TRANSITORIO no borra la sesión", () => {
  it.each([
    ["red caída", new TypeError("Failed to fetch")],
    ["servidor caído (503)", new ApiError("Servicio no disponible", 503)],
    ["error interno (500)", new ApiError("Error interno", 500)],
    ["timeout de la pasarela (504)", new ApiError("Gateway timeout", 504)],
  ])("%s: conserva el perfil y no expulsa al usuario", async (_caso, error) => {
    // Perfil en caché, como tras una recarga con la sesión abierta.
    sessionStorage.setItem("natacion.perfil", JSON.stringify(SESION_ADMIN.user));
    vi.mocked(authApi.apiRefresh).mockRejectedValue(error);

    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).not.toHaveTextContent("restaurando"));

    // No hay access token —no se pudo obtener—, pero la cookie sigue ahí y el
    // perfil no se borra: la próxima petición volverá a intentarlo.
    expect(screen.getByTestId("username"), "un corte de red no es una sesión inválida").toHaveTextContent("admin.fchmn");
    expect(sessionStorage.getItem("natacion.perfil"), "la caché del perfil se conserva").not.toBeNull();
  });

  it.each([["sesión expirada (401)", new ApiError("Sesión inválida", 401)]])("%s: SÍ borra la sesión", async (_caso, error) => {
    sessionStorage.setItem("natacion.perfil", JSON.stringify(SESION_ADMIN.user));
    vi.mocked(authApi.apiRefresh).mockRejectedValue(error);

    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));

    // El servidor sí opinó sobre la credencial: hay que volver a entrar.
    expect(screen.getByTestId("username")).toHaveTextContent("-");
    expect(sessionStorage.getItem("natacion.perfil")).toBeNull();
  });
});

/**
 * Un 403 en `/auth/refresh` o `/auth/logout` NO es una sesión expirada: es la
 * comprobación CSRF, que falla por motivos perfectamente normales —otra pestaña
 * rotó el token, o la página se recargó y el valor en memoria se perdió—. Antes
 * se trataba igual que un 401 y expulsaba al usuario con la sesión intacta en
 * el servidor.
 */
describe("un 403 es un fallo CSRF, no una sesión expirada", () => {
  it("rehace el bootstrap y reintenta UNA vez, sin borrar nada", async () => {
    vi.mocked(authApi.apiCsrf)
      .mockResolvedValueOnce({ csrfToken: "csrf-viejo" })
      .mockResolvedValueOnce({ csrfToken: "csrf-nuevo" });
    vi.mocked(authApi.apiRefresh)
      // Primer intento: el token en memoria ya no coincide con la cookie.
      .mockRejectedValueOnce(new ApiError("Comprobación de seguridad fallida", 403))
      // Tras rehacer el bootstrap, el reintento funciona.
      .mockResolvedValueOnce(SESION_ADMIN);

    renderizar();

    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"));
    expect(screen.getByTestId("username"), "la sesión se recupera sola").toHaveTextContent("admin.fchmn");
    expect(authApi.apiCsrf, "un bootstrap inicial y otro forzado por el 403").toHaveBeenCalledTimes(2);
    expect(authApi.apiRefresh).toHaveBeenCalledTimes(2);
  });

  it("si el 403 PERSISTE, conserva la sesión local en vez de expulsar", async () => {
    sessionStorage.setItem("natacion.perfil", JSON.stringify(SESION_ADMIN.user));
    vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf" });
    vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("Comprobación de seguridad fallida", 403));

    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).not.toHaveTextContent("restaurando"));

    // No hay access token, pero la cookie del servidor sigue viva: borrar el
    // perfil obligaría a volver a entrar por un problema que no es de sesión.
    expect(screen.getByTestId("username"), "el 403 no invalida la sesión").toHaveTextContent("admin.fchmn");
    expect(sessionStorage.getItem("natacion.perfil")).not.toBeNull();
    expect(authApi.apiRefresh, "un intento y un único reintento").toHaveBeenCalledTimes(2);
  });

  it("un 403 al CERRAR sesión tampoco la da por cerrada", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION_ADMIN);
    vi.mocked(authApi.apiLogout).mockRejectedValue(new ApiError("Comprobación de seguridad fallida", 403));

    let fallo: Error | null = null;
    function Prueba() {
      const { logout, accessToken } = useAuth();
      return (
        <div>
          <span data-testid="sesion">{accessToken ? "con-sesion" : "sin-sesion"}</span>
          <button
            onClick={() => {
              void logout().catch((e: Error) => {
                fallo = e;
              });
            }}
          >
            Salir
          </button>
        </div>
      );
    }

    render(
      <AuthProvider>
        <Prueba />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("sesion")).toHaveTextContent("con-sesion"));

    screen.getByRole("button", { name: "Salir" }).click();

    // El servidor NO revocó nada: la cookie sigue viva y decir "sesión cerrada"
    // sería mentir.
    await waitFor(() => expect(fallo, "el cierre debe informar el fallo").not.toBeNull());
  });
});

/**
 * LOGOUT ANTE UN 403: bootstrap y UN reintento.
 *
 * El 403 de `/auth/logout` es una comprobación CSRF fallida, no una sesión
 * expirada: pasa cuando el token en memoria se perdió al recargar o dejó de
 * coincidir. Antes se trataba como fallo definitivo y el usuario no podía
 * cerrar sesión sin recargar la página.
 */
describe("cerrar sesión reintenta UNA vez ante un 403", () => {
  /** Monta la aplicación con un botón de salida y captura el error, si lo hay. */
  function montarConSalida() {
    const capturado: { error: Error | null } = { error: null };

    function Prueba() {
      const { logout, accessToken } = useAuth();
      return (
        <div>
          <span data-testid="sesion">{accessToken ? "con-sesion" : "sin-sesion"}</span>
          <button
            onClick={() => {
              void logout().catch((e: Error) => {
                capturado.error = e;
              });
            }}
          >
            Salir
          </button>
        </div>
      );
    }

    render(
      <AuthProvider>
        <Prueba />
      </AuthProvider>
    );
    return capturado;
  }

  it("403 → bootstrap → reintento con ÉXITO: dos logouts, un bootstrap extra", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION_ADMIN);
    vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-nuevo" });
    vi.mocked(authApi.apiLogout)
      .mockRejectedValueOnce(new ApiError("Comprobación de seguridad fallida", 403))
      .mockResolvedValueOnce(undefined);

    const capturado = montarConSalida();
    await waitFor(() => expect(screen.getByTestId("sesion")).toHaveTextContent("con-sesion"));
    const bootstrapsDeArranque = vi.mocked(authApi.apiCsrf).mock.calls.length;

    screen.getByRole("button", { name: "Salir" }).click();

    await waitFor(() => expect(screen.getByTestId("sesion")).toHaveTextContent("sin-sesion"));
    expect(capturado.error, "el cierre acabó bien").toBeNull();
    expect(authApi.apiLogout, "un intento y UN reintento").toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(authApi.apiCsrf).mock.calls.length - bootstrapsDeArranque,
      "exactamente un bootstrap forzado por el 403"
    ).toBe(1);
  });

  it("403 que PERSISTE: no insiste más y conserva el estado local", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION_ADMIN);
    vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf" });
    vi.mocked(authApi.apiLogout).mockRejectedValue(new ApiError("Comprobación de seguridad fallida", 403));

    const capturado = montarConSalida();
    await waitFor(() => expect(screen.getByTestId("sesion")).toHaveTextContent("con-sesion"));

    screen.getByRole("button", { name: "Salir" }).click();

    await waitFor(() => expect(capturado.error).not.toBeNull());
    expect(authApi.apiLogout, "sin bucle: dos llamadas y se detiene").toHaveBeenCalledTimes(2);
    // La sesión sigue viva en el servidor; decir lo contrario sería mentir.
    expect(screen.getByTestId("sesion"), "el estado local NO se limpia").toHaveTextContent("con-sesion");
    expect(capturado.error!.message).toMatch(/no se pudo cerrar la sesión/i);
  });

  it("401: la sesión ya no existía, se limpia sin reintentar", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION_ADMIN);
    vi.mocked(authApi.apiLogout).mockRejectedValue(new ApiError("Sesión inválida", 401));

    const capturado = montarConSalida();
    await waitFor(() => expect(screen.getByTestId("sesion")).toHaveTextContent("con-sesion"));

    screen.getByRole("button", { name: "Salir" }).click();

    await waitFor(() => expect(screen.getByTestId("sesion")).toHaveTextContent("sin-sesion"));
    expect(authApi.apiLogout, "un 401 no se reintenta: el objetivo ya está cumplido").toHaveBeenCalledTimes(1);
    expect(capturado.error).toBeNull();
  });

  it("un fallo de red no se reintenta y conserva el estado", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION_ADMIN);
    vi.mocked(authApi.apiLogout).mockRejectedValue(new TypeError("Failed to fetch"));

    const capturado = montarConSalida();
    await waitFor(() => expect(screen.getByTestId("sesion")).toHaveTextContent("con-sesion"));

    screen.getByRole("button", { name: "Salir" }).click();

    await waitFor(() => expect(capturado.error).not.toBeNull());
    expect(authApi.apiLogout, "el reintento es SOLO para el 403").toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("sesion")).toHaveTextContent("con-sesion");
  });
});

/**
 * El bootstrap del token CSRF ya no traga los errores. Si los tragara, el
 * refresco saldría sin la cabecera, el servidor respondería 403 y —antes de
 * distinguir el 403— eso expulsaba al usuario: un corte de red de un segundo
 * terminaba cerrando su sesión.
 */
describe("un bootstrap CSRF que falla no expulsa al usuario", () => {
  it.each([
    ["red caída", new TypeError("Failed to fetch")],
    ["error del servidor (500)", new ApiError("Error interno", 500)],
    ["servicio no disponible (503)", new ApiError("No disponible", 503)],
  ])("%s: conserva la sesión y NO intenta el refresco a ciegas", async (_caso, error) => {
    sessionStorage.setItem("natacion.perfil", JSON.stringify(SESION_ADMIN.user));
    vi.mocked(authApi.apiCsrf).mockRejectedValue(error);
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION_ADMIN);

    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).not.toHaveTextContent("restaurando"));

    expect(screen.getByTestId("username"), "un fallo de bootstrap no es una sesión inválida").toHaveTextContent("admin.fchmn");
    expect(sessionStorage.getItem("natacion.perfil")).not.toBeNull();
    // Lo importante: no se llega a refrescar sabiendo que faltará la cabecera.
    expect(authApi.apiRefresh, "no se refresca a ciegas").not.toHaveBeenCalled();
  });
});

describe("cerrar sesión no puede darse por hecho si no llegó al servidor", () => {
  it("si el logout falla por red, LANZA y no anuncia un cierre que no ocurrió", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION_ADMIN);
    vi.mocked(authApi.apiLogout).mockRejectedValue(new TypeError("Failed to fetch"));

    // Se ejercita el método directamente: es su contrato lo que se prueba.
    let capturado: Error | null = null;
    function Prueba() {
      const { logout, accessToken } = useAuth();
      return (
        <div>
          <span data-testid="sesion">{accessToken ? "con-sesion" : "sin-sesion"}</span>
          <button
            onClick={() => {
              void logout().catch((e: Error) => {
                capturado = e;
              });
            }}
          >
            Salir
          </button>
        </div>
      );
    }

    render(
      <AuthProvider>
        <Prueba />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("sesion")).toHaveTextContent("con-sesion"));

    screen.getByRole("button", { name: "Salir" }).click();

    /**
     * El refresh token vive en una cookie `HttpOnly` que este código no puede
     * borrar, y solo el servidor puede revocarlo. Decir "sesión cerrada" sin
     * que el servidor se haya enterado deja al usuario creyendo que salió de un
     * equipo compartido mientras su cookie sigue viva.
     */
    await waitFor(() => expect(capturado, "el cierre debe informar el fallo").not.toBeNull());
    expect(capturado!.message).toMatch(/no se pudo cerrar la sesión/i);
  });

  it("un 401 al cerrar sesión SÍ es éxito: ya no había sesión", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(SESION_ADMIN);
    vi.mocked(authApi.apiLogout).mockRejectedValue(new ApiError("Sesión inválida", 401));

    let fallo: Error | null = null;
    function Prueba() {
      const { logout, accessToken } = useAuth();
      return (
        <div>
          <span data-testid="sesion">{accessToken ? "con-sesion" : "sin-sesion"}</span>
          <button
            onClick={() => {
              void logout().catch((e: Error) => {
                fallo = e;
              });
            }}
          >
            Salir
          </button>
        </div>
      );
    }

    render(
      <AuthProvider>
        <Prueba />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("sesion")).toHaveTextContent("con-sesion"));

    screen.getByRole("button", { name: "Salir" }).click();

    await waitFor(() => expect(screen.getByTestId("sesion")).toHaveTextContent("sin-sesion"));
    expect(fallo, "el objetivo estaba cumplido").toBeNull();
  });
});
