/**
 * Fase 6, hallazgo 27 — TODAS las respuestas de sesión se validan.
 *
 * El refresco y el canal ya pasaban por `sessionSchema`, pero **login y cambio
 * de contraseña se fiaban solo de los tipos de TypeScript**, que no existen en
 * tiempo de ejecución. Una respuesta con `ownerType` inventado, sin `clubId` o
 * con un access token de otro usuario entraba sin más, y el fallo aparecía mucho
 * después, lejos de su origen.
 *
 * Además, una respuesta inválida no puede quedarse a medias: tiene que fallar
 * de forma explícita y **no conservar el token CSRF anterior**.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthContext";
import { reiniciarCoordinador } from "./refreshCoordinator";
import { reiniciarCsrf, tokenCsrfActual } from "./csrf";
import { validarRespuestaDeSesion } from "./sessionSchema";
import { ApiError } from "../../shared/apiClient";
import * as authApi from "./authApi";
import { perfilDePrueba, sesionDePrueba, tokenDePerfil, tokenIncoherente } from "../../test/sesionDePrueba";

vi.mock("./authApi");

const PERFIL_OK = perfilDePrueba({ id: "uA", username: "usuario.a" });

const tokenDe = (sub: string) => tokenDePerfil({ ...PERFIL_OK, id: sub }, ["clubs:read"]);

/** Respuesta válida, para romperla campo a campo. */
const RESPUESTA_OK = sesionDePrueba(PERFIL_OK, "csrf-valido", ["clubs:read"]);

describe("el esquema rechaza cada campo inválido", () => {
  it("acepta una respuesta correcta", () => {
    expect(validarRespuestaDeSesion(RESPUESTA_OK)).not.toBeNull();
  });

  it.each([
    ["sin accessToken", { accessToken: undefined }],
    ["accessToken vacío", { accessToken: "" }],
    ["accessToken que no es un JWT", { accessToken: "cadena-cualquiera" }],
    ["sin csrfToken", { csrfToken: undefined }],
    ["csrfToken nulo", { csrfToken: null }],
    ["mustChangePassword ausente", { mustChangePassword: undefined }],
    ["mustChangePassword no booleano", { mustChangePassword: "no" }],
    ["sin usuario", { user: undefined }],
    ["usuario nulo", { user: null }],
  ])("RECHAZA %s", (_caso, parche) => {
    expect(validarRespuestaDeSesion({ ...RESPUESTA_OK, ...parche })).toBeNull();
  });

  it.each([
    ["sin id", { id: undefined }],
    ["id vacío", { id: "" }],
    ["sin username", { username: undefined }],
    ["ownerType ausente", { ownerType: undefined }],
    ["ownerType fuera del enum", { ownerType: "administrador" }],
    ["personId indefinido", { personId: undefined }],
    ["personId numérico", { personId: 7 }],
    ["clubId indefinido", { clubId: undefined }],
    ["clubId numérico", { clubId: 7 }],
    ["roles ausentes", { roles: undefined }],
    ["roles que no son cadenas", { roles: ["admin", 3] }],
  ])("RECHAZA un perfil %s", (_caso, parche) => {
    expect(validarRespuestaDeSesion({ ...RESPUESTA_OK, user: { ...RESPUESTA_OK.user, ...parche } })).toBeNull();
  });

  /**
   * La coherencia entre el token y el perfil. Sin esta comprobación, la interfaz
   * podía mostrar a un usuario mientras las peticiones salían con la credencial
   * de otro.
   */
  it("RECHAZA un token cuyo `sub` no es el id del usuario", () => {
    expect(validarRespuestaDeSesion({ ...RESPUESTA_OK, accessToken: tokenDe("otro-usuario") })).toBeNull();
  });

  it("los tres tipos de dueño válidos se aceptan", () => {
    // El token acompaña al perfil: la validación compara también `ownerType`.
    for (const ownerType of ["person", "club", "system"] as const) {
      const perfil = perfilDePrueba({ ...PERFIL_OK, ownerType });
      expect(validarRespuestaDeSesion(sesionDePrueba(perfil, "csrf-valido")), ownerType).not.toBeNull();
    }
  });

  /**
   * COHERENCIA CON LOS CLAIMS, no solo con el perfil. Se manipulan los claims
   * del token dejando el perfil intacto: la aplicación no puede mostrar a un
   * usuario mientras el token afirma otra cosa.
   */
  it.each([
    ["ownerType distinto en el token", { ownerType: "club" }],
    ["personId distinto en el token", { personId: "otra-persona" }],
    ["clubId distinto en el token", { clubId: "otro-club" }],
    ["roles distintos en el token", { roles: ["club"] }],
    ["roles de más en el token", { roles: ["admin", "club"] }],
    ["roles vacíos en el token", { roles: [] }],
    ["sub distinto en el token", { sub: "otro-usuario" }],
    ["roles que no son cadenas en el token", { roles: ["admin", 7] }],
    ["permisos que no son cadenas en el token", { permissions: [1, 2] }],
    /**
     * Claims OBLIGATORIOS ausentes. `sub` y `ownerType` los firma el backend
     * siempre; un token sin ellos no describe a nadie en concreto y antes
     * superaba la comprobación de coherencia contra cualquier perfil.
     */
    ["token SIN ownerType", { ownerType: undefined }],
    ["token SIN sub", { sub: undefined }],
    ["token con sub vacío", { sub: "" }],
    ["token SIN roles", { roles: undefined }],
    ["token SIN permisos", { permissions: undefined }],
    /**
     * Y los opcionales con un tipo que no es el suyo: ausencia y basura no son
     * lo mismo. Un `clubId: 42` degradado a `null` casaba con un perfil sin club.
     */
    ["personId numérico en el token", { personId: 42 }],
    ["clubId numérico en el token", { clubId: 42 }],
    ["clubId objeto en el token", { clubId: {} }],
  ])("RECHAZA %s", (_caso, claimsRotos) => {
    const respuesta = { ...RESPUESTA_OK, accessToken: tokenIncoherente(PERFIL_OK, claimsRotos) };
    expect(validarRespuestaDeSesion(respuesta)).toBeNull();
  });
});

function Sonda() {
  const { accessToken, user, login, changePassword, restaurando } = useAuth();
  return (
    <div>
      <span data-testid="estado">{restaurando ? "restaurando" : accessToken ? "con-sesion" : "sin-sesion"}</span>
      <span data-testid="username">{user?.username ?? "-"}</span>
      <button onClick={() => void login("u", "c").catch(() => undefined)}>Entrar</button>
      <button
        onClick={() =>
          void changePassword({ currentPassword: "v", newPassword: "NuevaClave123", confirmPassword: "NuevaClave123" }).catch(
            () => undefined
          )
        }
      >
        Cambiar contraseña
      </button>
    </div>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  reiniciarCoordinador();
  reiniciarCsrf();
  vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-boot" });
  vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("Sesión inválida", 401));
});

describe("una respuesta inválida falla y no deja estado a medias", () => {
  it("LOGIN con una respuesta inválida: no inicia sesión ni cambia el CSRF", async () => {
    // Respuesta que el tipo de TypeScript aceptaría pero el esquema no.
    vi.mocked(authApi.apiLogin).mockResolvedValue({
      ...RESPUESTA_OK,
      user: { ...RESPUESTA_OK.user, ownerType: "administrador" },
    } as unknown as Awaited<ReturnType<typeof authApi.apiLogin>>);

    let fallo: Error | null = null;
    function Prueba() {
      const { login, accessToken } = useAuth();
      return (
        <div>
          <span data-testid="estado">{accessToken ? "con-sesion" : "sin-sesion"}</span>
          <button
            onClick={() => {
              void login("u", "c").catch((e: Error) => {
                fallo = e;
              });
            }}
          >
            Entrar
          </button>
        </div>
      );
    }

    render(
      <AuthProvider>
        <Prueba />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));
    const csrfAntes = tokenCsrfActual();

    screen.getByRole("button", { name: "Entrar" }).click();

    await waitFor(() => expect(fallo).not.toBeNull());
    expect(screen.getByTestId("estado"), "no se inicia una sesión que no se puede usar").toHaveTextContent("sin-sesion");
    expect(tokenCsrfActual(), "y el token CSRF anterior no se pisa").toBe(csrfAntes);
    expect(sessionStorage.getItem("natacion.perfil"), "ni se persiste un perfil inválido").toBeNull();
  });

  it("CAMBIO DE CONTRASEÑA con respuesta inválida: falla y conserva la sesión", async () => {
    // Sesión válida de partida.
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce({
      ...RESPUESTA_OK,
      csrfToken: "csrf-inicial",
    } as unknown as Awaited<ReturnType<typeof authApi.apiRefresh>>);
    vi.mocked(authApi.apiChangePassword).mockResolvedValue({
      ...RESPUESTA_OK,
      accessToken: tokenDe("otro-usuario"),
    } as unknown as Awaited<ReturnType<typeof authApi.apiChangePassword>>);

    /**
     * Se recoge el fallo para poder esperar la CONDICIÓN —la operación terminó,
     * y terminó mal— en vez de conceder un plazo y suponer que habrá acabado.
     * Es el mismo patrón de la prueba anterior.
     */
    let fallo: Error | null = null;
    function Prueba() {
      const { user, changePassword } = useAuth();
      return (
        <div>
          <span data-testid="username">{user?.username ?? "-"}</span>
          <button
            onClick={() => {
              void changePassword({
                currentPassword: "v",
                newPassword: "NuevaClave123",
                confirmPassword: "NuevaClave123",
              }).catch((e: Error) => {
                fallo = e;
              });
            }}
          >
            Cambiar contraseña
          </button>
        </div>
      );
    }

    render(
      <AuthProvider>
        <Prueba />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));
    expect(tokenCsrfActual()).toBe("csrf-inicial");

    screen.getByRole("button", { name: "Cambiar contraseña" }).click();
    await waitFor(() => expect(fallo).not.toBeNull());

    // El token del usuario equivocado no puede adoptarse.
    expect(screen.getByTestId("username"), "la sesión anterior se conserva").toHaveTextContent("usuario.a");
    expect(tokenCsrfActual(), "y su token CSRF también").toBe("csrf-inicial");
  });

  it("una respuesta VÁLIDA sí se adopta (la validación no bloquea lo legítimo)", async () => {
    vi.mocked(authApi.apiLogin).mockResolvedValue({
      ...RESPUESTA_OK,
      csrfToken: "csrf-login",
    } as unknown as Awaited<ReturnType<typeof authApi.apiLogin>>);

    render(
      <AuthProvider>
        <Sonda />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));

    screen.getByRole("button", { name: "Entrar" }).click();

    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));
    expect(tokenCsrfActual()).toBe("csrf-login");
  });
});
