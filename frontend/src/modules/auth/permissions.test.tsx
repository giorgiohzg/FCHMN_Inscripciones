/**
 * Fase 6, hallazgo 27 — `hasPermission()` comprueba permisos de verdad.
 *
 * Antes era literalmente:
 *
 *     const hasPermission = useCallback((_permission: string) => true, []);
 *
 * Devolvía `true` para cualquier permiso, incluidos los inventados. No ocultaba
 * nada y daba la falsa impresión de que existía un control de presentación.
 *
 * También se cubre aquí la restauración de sesión al recargar: el access token
 * vive en memoria y se pierde, así que los permisos tienen que volver del token
 * que emite la renovación.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthContext";
import { reiniciarCoordinador } from "./refreshCoordinator";
import { reiniciarCsrf } from "./csrf";
import { ApiError } from "../../shared/apiClient";
import * as authApi from "./authApi";
import { perfilDePrueba, tokenDePerfil } from "../../test/sesionDePrueba";

vi.mock("./authApi");

/** Arma un JWT de mentira: solo el payload importa, la firma no se verifica en el cliente. */
const PERFIL = perfilDePrueba({ id: "u1", username: "club_uno", ownerType: "club", clubId: "c1", roles: ["club"] });

/**
 * El `sub` del token tiene que coincidir con el `id` del perfil: la validación
 * rechaza una sesión donde el token sea de un usuario y el perfil de otro.
 */
function tokenCon(permissions: string[], roles: string[] = ["club"], clubId: string | null = "c1"): string {
  return tokenDePerfil({ ...PERFIL, roles, clubId }, permissions);
}

/** Respuesta de /auth/refresh: trae el PERFIL COMPLETO, no solo el token. */
function sesionCon(permissions: string[], roles: string[] = ["club"]) {
  return {
    accessToken: tokenCon(permissions, roles),
    mustChangePassword: false,
    csrfToken: "csrf-sesion",
    user: { ...PERFIL, roles },
  };
}

/** Pinta el resultado de consultar varios permisos, para poder leerlos. */
function Sonda({ consultar }: { consultar: string[] }) {
  const { hasPermission, accessToken, restaurando } = useAuth();
  return (
    <div>
      <span data-testid="estado">{restaurando ? "restaurando" : accessToken ? "con-sesion" : "sin-sesion"}</span>
      {consultar.map((p) => (
        <span key={p} data-testid={p}>
          {String(hasPermission(p))}
        </span>
      ))}
    </div>
  );
}

const CONSULTADOS = ["registrations:write", "clubs:write", "permiso:inventado"];

function renderizar() {
  return render(
    <AuthProvider>
      <Sonda consultar={CONSULTADOS} />
    </AuthProvider>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  reiniciarCoordinador();
  reiniciarCsrf();
  vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-sesion" });
  vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("sin sesión", 401));
});

describe("permisos del token vigente", () => {
  it("responde true a los permisos PRESENTES y false a los AUSENTES", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(sesionCon(["registrations:write"]));

    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"));

    expect(screen.getByTestId("registrations:write"), "el permiso está en el token").toHaveTextContent("true");
    // Estos dos devolvían `true` antes, como cualquier otra cadena.
    expect(screen.getByTestId("clubs:write"), "no está en el token").toHaveTextContent("false");
    expect(screen.getByTestId("permiso:inventado"), "ni siquiera existe").toHaveTextContent("false");
  });

  it("sin sesión no concede ningún permiso", async () => {
    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));

    for (const p of CONSULTADOS) {
      expect(screen.getByTestId(p), `${p} sin sesión`).toHaveTextContent("false");
    }
  });

  it("un access token que no se puede decodificar NO abre sesión", async () => {
    // Antes bastaba con que fuera una cadena no vacía y la sesión se adoptaba
    // con la lista de permisos vacía. Ahora la validación lo rechaza entero.
    vi.mocked(authApi.apiRefresh).mockResolvedValue({
      accessToken: "no-es-un-jwt",
      mustChangePassword: false,
      csrfToken: "csrf-sesion",
      user: PERFIL,
    });

    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));

    expect(screen.getByTestId("registrations:write")).toHaveTextContent("false");
  });

  it("NINGÚN camino devuelve true incondicionalmente", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(sesionCon([]));

    renderizar();
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"));

    // Con la lista vacía, todo debe ser false. Es la prueba directa contra el
    // `() => true` anterior.
    for (const p of CONSULTADOS) {
      expect(screen.getByTestId(p), `${p} con lista vacía`).toHaveTextContent("false");
    }
  });
});

describe("los permisos se actualizan tras un refresco", () => {
  /**
   * CON RELOJ FALSO, TODO LO QUE MUEVE EL TIEMPO VA DENTRO DE `act`.
   *
   * `waitFor` de Testing Library envuelve sus esperas en `act`; `vi.waitFor` y
   * `vi.advanceTimersByTimeAsync` **no**, porque son utilidades de Vitest y no
   * saben nada de React. Aquí hacen falta las de Vitest: son ellas las que
   * adelantan el reloj falso. El problema es lo que pasa mientras: el refresco
   * proactivo de `AuthProvider` dispara `renovar()`, la respuesta se adopta con
   * `aplicarSesion` y esa actualización de estado caía fuera del control de la
   * prueba. De ahí las advertencias.
   *
   * Y el vaciado va DENTRO de `act`, con las comprobaciones FUERA. No al revés:
   * dentro del ámbito de `act` React acumula su trabajo y no lo confirma en el
   * DOM hasta salir, así que un `waitFor` metido dentro esperaría eternamente un
   * cambio que no puede ver. Por eso desaparecen aquí los `vi.waitFor`: con el
   * reloj falso no hay nada que sondear —`advanceTimersByTimeAsync` cede un
   * macrotarea que vacía la cadena de microtareas de las respuestas simuladas—,
   * y una comprobación directa es además más estricta que un sondeo.
   */
  const vaciar = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  /**
   * El refresco proactivo corre cada 12 minutos (el access token dura 15). Se
   * adelanta el reloj en vez de esperar: lo que importa es que la lista de
   * permisos venga del token NUEVO y no quede congelada la del login.
   */
  it("un permiso RETIRADO deja de concederse tras la siguiente emisión", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(authApi.apiRefresh)
        // Emisión inicial (restauración al montar): tiene los dos permisos.
        .mockResolvedValueOnce(sesionCon(["registrations:write", "clubs:write"]))
        // Emisión siguiente: un administrador le retiró `clubs:write`. El
        // backend recalcula los permisos en cada emisión de token.
        .mockResolvedValueOnce(sesionCon(["registrations:write"]));

      renderizar();
      // La restauración inicial no depende del reloj: resuelve en microtareas.
      await vaciar(0);
      expect(screen.getByTestId("clubs:write")).toHaveTextContent("true");

      await vaciar(12 * 60_000);

      expect(screen.getByTestId("clubs:write"), "el permiso retirado ya no se concede").toHaveTextContent("false");
      expect(screen.getByTestId("registrations:write"), "el que conserva sigue vigente").toHaveTextContent("true");
      expect(authApi.apiRefresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("un permiso CONCEDIDO después aparece sin necesidad de volver a entrar", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(authApi.apiRefresh)
        .mockResolvedValueOnce(sesionCon([]))
        .mockResolvedValueOnce(sesionCon(["clubs:write"]));

      renderizar();
      await vaciar(0);
      expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion");
      expect(screen.getByTestId("clubs:write")).toHaveTextContent("false");

      await vaciar(12 * 60_000);

      expect(screen.getByTestId("clubs:write")).toHaveTextContent("true");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("restauración de sesión al recargar", () => {
  /**
   * El access token vive en MEMORIA y se pierde al recargar; la cookie del
   * refresh sigue en el navegador. Sin este intento, cada F5 mandaría al login
   * a un usuario con sesión perfectamente válida.
   */
  it("recupera la sesión con la cookie, sin credenciales en el almacenamiento", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValue(sesionCon(["registrations:write"]));

    renderizar();

    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"));
    expect(authApi.apiRefresh, "la cookie va sola: no se le pasa ningún token").toHaveBeenCalledWith();

    const volcado = JSON.stringify(sessionStorage);
    expect(volcado, "ninguna credencial en el almacenamiento").not.toContain("encabezado.");
  });

  it("si la cookie ya no vale, queda sin sesión (y no en un limbo)", async () => {
    vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("Sesión inválida", 401));

    renderizar();

    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));
  });
});
