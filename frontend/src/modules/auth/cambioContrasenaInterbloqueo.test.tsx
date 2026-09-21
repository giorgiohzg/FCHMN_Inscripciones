/**
 * Fase 6 — el CAMBIO DE CONTRASEÑA no puede interbloquearse con la renovación.
 *
 * `changePassword` corre entero dentro del cerrojo de sesión, incluida la
 * petición HTTP. Si esa petición responde 401 —el access token venció mientras
 * el usuario rellenaba el formulario—, hace falta renovar y reintentar. Ahí
 * estaba el interbloqueo:
 *
 *   changePassword toma el cerrojo
 *     → POST /auth/change-password responde 401
 *       → el cliente HTTP llamaba a renovar()
 *         → renovar() pedía el MISMO cerrojo, que sostiene changePassword,
 *           que a su vez espera a que termine la petición. Bloqueo mutuo.
 *
 * Web Locks no es reentrante, así que no se resuelve solo. Tampoco vale una
 * bandera de módulo "ya lo tengo": en JavaScript no hay hilo que distinga una
 * llamada ANIDADA de una operación CONCURRENTE de la misma pestaña, de modo que
 * esa bandera dejaba pasar también a las concurrentes y anulaba la exclusión.
 *
 * La salida es explícita: `/auth/change-password` queda FUERA del bucle
 * automático de 401 del cliente HTTP, y quien está dentro del cerrojo llama a
 * `renovarDentroDelCerrojo`, que renueva sin volver a pedirlo.
 *
 * **Los tiempos de espera de estas pruebas son cortos a propósito**: un
 * interbloqueo no produce un fallo de aserción, produce una promesa que nunca
 * se resuelve. Con el timeout por defecto la suite se quedaría colgada medio
 * minuto por caso; así falla en un segundo y dice exactamente qué se atascó.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthContext";
import { reiniciarCoordinador, comenzarCicloDeSesion } from "./refreshCoordinator";
import { reiniciarCsrf, tokenCsrfActual } from "./csrf";
import { ApiError, apiFetch, conectarSesion } from "../../shared/apiClient";
import * as authApi from "./authApi";
import { perfilDePrueba, sesionDePrueba } from "../../test/sesionDePrueba";

vi.mock("./authApi");

const PERFIL = perfilDePrueba({ id: "uA", username: "usuario.a" });
const sesion = (csrf: string) => sesionDePrueba(PERFIL, csrf, ["clubs:read"]);

const SESION_INICIAL = sesion("csrf-inicial");
const SESION_RENOVADA = sesion("csrf-renovado");
const SESION_TRAS_CAMBIO = sesion("csrf-tras-cambio");

/** Cuánto se espera antes de declarar que algo está atascado. */
const ESPERA_CORTA = { timeout: 1_000, interval: 10 };

function Sonda() {
  const { accessToken, logout, changePassword } = useAuth();
  return (
    <div>
      <span data-testid="estado">{accessToken ? "con-sesion" : "sin-sesion"}</span>
      <span data-testid="csrf">{tokenCsrfActual() ?? "-"}</span>
      <button
        onClick={() => {
          void changePassword({ currentPassword: "vieja", newPassword: "NuevaClave123", confirmPassword: "NuevaClave123" })
            .then(() => marcar("cambio:ok"))
            .catch((e: Error) => marcar(`cambio:error:${e.message}`));
        }}
      >
        Cambiar contraseña
      </button>
      <button
        onClick={() => {
          void logout()
            .then(() => marcar("logout:ok"))
            .catch(() => marcar("logout:error"));
        }}
      >
        Salir
      </button>
    </div>
  );
}

/**
 * Registro de finalizaciones.
 *
 * Lo que hay que demostrar no es el valor devuelto sino que la promesa TERMINA.
 * Un interbloqueo deja este registro vacío para siempre.
 */
let terminadas: string[] = [];
const marcar = (que: string) => terminadas.push(que);

/** Web Locks, que jsdom no implementa. Sin él no hay nada que interbloquear. */
function instalarCerrojos() {
  const cola = new Map<string, Promise<unknown>>();
  const request = async (nombre: string, fn: () => Promise<unknown>) => {
    const anterior = cola.get(nombre) ?? Promise.resolve();
    const propio = anterior.then(fn, fn);
    cola.set(
      nombre,
      propio.catch(() => undefined)
    );
    return propio;
  };
  Object.defineProperty(globalThis.navigator, "locks", { value: { request }, configurable: true });
}

const locksOriginal = globalThis.navigator?.locks;

const montar = () =>
  render(
    <AuthProvider>
      <Sonda />
    </AuthProvider>
  );

beforeEach(() => {
  instalarCerrojos();
  vi.resetAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  terminadas = [];
  reiniciarCoordinador();
  reiniciarCsrf();
  vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-boot" });
  vi.mocked(authApi.apiLogout).mockResolvedValue(undefined);
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "locks", { value: locksOriginal, configurable: true });
});

async function conSesionActiva() {
  vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_INICIAL);
  montar();
  await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"), ESPERA_CORTA);
}

describe("change-password → 401 → refresh → reintento", () => {
  it("el reintento termina y la sesión nueva se adopta", async () => {
    await conSesionActiva();

    // El access token vence justo antes de enviar el formulario.
    vi.mocked(authApi.apiChangePassword)
      .mockRejectedValueOnce(new ApiError("Token expirado", 401))
      .mockResolvedValueOnce(SESION_TRAS_CAMBIO);
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_RENOVADA);

    screen.getByRole("button", { name: "Cambiar contraseña" }).click();

    /**
     * Si el cerrojo fuera reentrante-por-espera, esta espera se agotaría: la
     * renovación estaría pidiendo el cerrojo que sostiene el cambio.
     */
    await waitFor(() => expect(terminadas, "la operación debe TERMINAR").toContain("cambio:ok"), ESPERA_CORTA);

    expect(authApi.apiRefresh, "hubo renovación: la inicial y la del 401").toHaveBeenCalledTimes(2);
    expect(authApi.apiChangePassword, "y un único reintento").toHaveBeenCalledTimes(2);
    expect(tokenCsrfActual(), "vale el CSRF de la sesión emitida por el cambio").toBe("csrf-tras-cambio");
    expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion");
  }, 10_000);

  it("el cerrojo queda LIBRE: la siguiente operación de sesión entra", async () => {
    await conSesionActiva();
    vi.mocked(authApi.apiChangePassword)
      .mockRejectedValueOnce(new ApiError("Token expirado", 401))
      .mockResolvedValueOnce(SESION_TRAS_CAMBIO);
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_RENOVADA);

    screen.getByRole("button", { name: "Cambiar contraseña" }).click();
    await waitFor(() => expect(terminadas).toContain("cambio:ok"), ESPERA_CORTA);

    // Un cerrojo mal soltado no se nota hasta la operación siguiente.
    screen.getByRole("button", { name: "Salir" }).click();
    await waitFor(() => expect(terminadas).toContain("logout:ok"), ESPERA_CORTA);
    expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion");
  }, 10_000);

  /**
   * LOS DOS DESENLACES QUE NO SON "renovada" NO SON EL MISMO, y confundirlos
   * tenía consecuencias opuestas.
   */
  it("`invalida`: limpia la sesión y PROPAGA EL CIERRE a las demás pestañas", async () => {
    const canal = new BroadcastChannel("fchmn-sesion");
    const recibidos: unknown[] = [];
    canal.onmessage = (e) => recibidos.push(e.data);

    await conSesionActiva();
    vi.mocked(authApi.apiChangePassword).mockRejectedValue(new ApiError("Token expirado", 401));
    // El servidor confirma que la sesión terminó.
    vi.mocked(authApi.apiRefresh).mockRejectedValueOnce(new ApiError("Sesión inválida", 401));

    screen.getByRole("button", { name: "Cambiar contraseña" }).click();

    await waitFor(
      () => expect(terminadas.some((t) => t.startsWith("cambio:error")), "debe terminar, con error").toBe(true),
      ESPERA_CORTA
    );
    expect(authApi.apiChangePassword, "no se reintenta contra una sesión muerta").toHaveBeenCalledTimes(1);

    /**
     * Antes solo se relanzaba el error: el usuario se quedaba ATRAPADO en la
     * pantalla de cambio obligatorio —sin sesión válida y sin forma de volver al
     * login— y las demás pestañas seguían mostrando una sesión muerta.
     */
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"), ESPERA_CORTA);
    // Se espera el anuncio, que es la condición comprobada; el mensaje de
    // `BroadcastChannel` se entrega de forma asíncrona.
    await waitFor(
      () =>
        expect(
          recibidos.some((m) => (m as { tipo?: string }).tipo === "cerrada"),
          "el cierre tiene que anunciarse, igual que en cualquier otro 401 confirmado"
        ).toBe(true),
      ESPERA_CORTA
    );

    canal.close();
  }, 10_000);

  it("`descartada`: conserva la sesión y no anuncia nada", async () => {
    const canal = new BroadcastChannel("fchmn-sesion");
    const recibidos: unknown[] = [];
    canal.onmessage = (e) => recibidos.push(e.data);

    await conSesionActiva();
    vi.mocked(authApi.apiChangePassword).mockRejectedValue(new ApiError("Token expirado", 401));

    /**
     * El ciclo cambia MIENTRAS la renovación está en vuelo: es lo que ocurre
     * cuando otra pestaña entra o cierra a mitad de la operación. El resultado
     * pertenece a un ciclo muerto y se descarta, pero de ESTA sesión no se sabe
     * nada malo: no hay nada que limpiar, y quien cambió el ciclo ya hizo lo que
     * tocaba. Limpiar aquí cerraría la sesión que la otra pestaña acaba de abrir.
     */
    vi.mocked(authApi.apiRefresh).mockImplementation(async () => {
      comenzarCicloDeSesion();
      return SESION_RENOVADA;
    });

    screen.getByRole("button", { name: "Cambiar contraseña" }).click();

    await waitFor(
      () => expect(terminadas.some((t) => t.startsWith("cambio:error")), "termina, con error").toBe(true),
      ESPERA_CORTA
    );

    expect(screen.getByTestId("estado"), "la sesión NO se limpia").toHaveTextContent("con-sesion");
    // Comprobación NEGATIVA: no hay condición que esperar, así que se agota la
    // cadena de microtareas pendientes en vez de conceder un plazo.
    await act(async () => {});
    expect(
      recibidos.some((m) => (m as { tipo?: string }).tipo === "cerrada"),
      "y no se anuncia ningún cierre"
    ).toBe(false);
    expect(authApi.apiChangePassword, "tampoco se reintenta: el ciclo ya no es el mismo").toHaveBeenCalledTimes(1);

    canal.close();
  }, 10_000);

  /**
   * La otra mitad de la solución, comprobada sobre el cliente HTTP REAL: su
   * bucle automático de 401 no puede activarse en `/auth/change-password`. Si se
   * activara, la renovación saldría desde FUERA del cerrojo que sostiene el
   * cambio, pediría ese mismo cerrojo y se quedaría esperando a quien la invocó.
   */
  it("un 401 del cambio NO dispara el bucle automático del cliente HTTP", async () => {
    const renovaciones: string[] = [];
    conectarSesion({
      obtenerAccessToken: () => "token",
      renovar: async () => {
        renovaciones.push("renovar");
        return "token-nuevo";
      },
      cerrarPorSesionInvalida: () => undefined,
    });

    const fetchFalso = vi.fn(
      async () => new Response(JSON.stringify({ message: "Token expirado" }), { status: 401 })
    );
    vi.stubGlobal("fetch", fetchFalso);

    await expect(apiFetch("/auth/change-password", { method: "POST" })).rejects.toMatchObject({ status: 401 });
    expect(renovaciones, "el cliente no renueva por su cuenta en esta ruta").toEqual([]);
    expect(fetchFalso, "y por tanto tampoco reintenta").toHaveBeenCalledTimes(1);

    // Contraste: en cualquier otra ruta el bucle SÍ actúa.
    await expect(apiFetch("/clubs", { method: "GET" })).rejects.toMatchObject({ status: 401 });
    expect(renovaciones).toEqual(["renovar"]);

    vi.unstubAllGlobals();
  });
});
