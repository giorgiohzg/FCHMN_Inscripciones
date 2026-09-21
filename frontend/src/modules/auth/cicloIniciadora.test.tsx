/**
 * Fase 6, hallazgo 27 — la PESTAÑA QUE INICIA el refresco.
 *
 * El defecto: `pedirYAdoptar()` aplicaba la respuesta de `/auth/refresh` —estado,
 * token CSRF y perfil persistido— y SOLO DESPUÉS el coordinador comprobaba si el
 * ciclo seguía vigente. Devolver `null` en ese punto no deshacía nada: la
 * pestaña que había pedido el refresco ya se había quedado con la sesión vieja.
 *
 * Las pruebas anteriores no lo detectaban porque miraban la pestaña RECEPTORA
 * —que sí descartaba el anuncio— y no la que había iniciado la operación.
 *
 * Ahora `pedirRenovacion` devuelve la respuesta cruda, el coordinador valida el
 * ciclo y solo entonces llama a `adoptar`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthContext";
import { reiniciarCoordinador, olvidarUltimoAnuncio } from "./refreshCoordinator";
import { reiniciarCsrf, tokenCsrfActual } from "./csrf";
import { ApiError } from "../../shared/apiClient";
import * as authApi from "./authApi";
import { perfilDePrueba, sesionDePrueba, tokenDePerfil } from "../../test/sesionDePrueba";

vi.mock("./authApi");

const CLAVE_PERFIL = "natacion.perfil";

/**
 * El token se DERIVA del perfil: la validación compara `sub`, `ownerType`,
 * `personId`, `clubId` y roles entre los claims y el usuario.
 */
function perfil(id: string, username: string) {
  return perfilDePrueba({ id, username });
}

function tokenDe(sub: string): string {
  return tokenDePerfil(perfil(sub, "cualquiera"), ["clubs:read"]);
}

function sesionDe(id: string, username: string, csrf: string) {
  return sesionDePrueba(perfil(id, username), csrf, ["clubs:read"]);
}

const SESION_A = sesionDe("uA", "usuario.a", "csrf-A");
const SESION_B = sesionDe("uB", "usuario.b", "csrf-B");

/** Promesa que resolvemos nosotros, para dejar el refresco "en vuelo". */
function diferida<T>() {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((r) => (resolver = r));
  return { promesa, resolver };
}

/** Expone la sesión y las acciones que la cambian. */
function Sonda() {
  const { user, accessToken, login, logout, changePassword, restaurando, reintentarRestauracion } = useAuth();
  return (
    <div>
      {/* Dispara un refresco por la misma vía que el resto de la aplicación. */}
      <button onClick={() => void reintentarRestauracion()}>Refrescar</button>
      <span data-testid="estado">{restaurando ? "restaurando" : accessToken ? "con-sesion" : "sin-sesion"}</span>
      <span data-testid="username">{user?.username ?? "-"}</span>
      <span data-testid="token">{accessToken ?? "-"}</span>
      <button onClick={() => void logout().catch(() => undefined)}>Salir</button>
      <button onClick={() => void login("usuario.b", "clave").catch(() => undefined)}>Entrar como B</button>
      <button
        onClick={() =>
          void changePassword({ currentPassword: "vieja", newPassword: "NuevaClave123", confirmPassword: "NuevaClave123" }).catch(
            () => undefined
          )
        }
      >
        Cambiar contraseña
      </button>
    </div>
  );
}

/**
 * Web Locks, que jsdom no implementa.
 *
 * Sin él no hay exclusión entre operaciones de sesión y no se puede ejercitar
 * la serialización de refresco y cierre, que es justo lo que hay que demostrar.
 */
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

/**
 * Fuerza un refresco que llegue de verdad al servidor.
 *
 * El coordinador reutiliza durante diez segundos la última sesión anunciada,
 * así que sin adelantar el reloj el segundo refresco se resolvería con el
 * anuncio en memoria y nunca saldría la petición.
 */
function forzarRefresco(): void {
  olvidarUltimoAnuncio();
  pulsar("Refrescar");
}

/**
 * Pulsa un botón DENTRO de `act`.
 *
 * `HTMLElement.click()` despacha el evento nativo directamente, sin pasar por
 * Testing Library, así que nada lo envuelve en `act`. Los manejadores de la
 * sonda arrancan operaciones de sesión que actualizan estado **de forma
 * síncrona** antes de su primer `await` —`reintentarRestauracion` hace
 * `setRestaurando(true)` nada más entrar—, y esa actualización caía fuera del
 * control de la prueba: de ahí las advertencias de `act` de `AuthProvider`.
 *
 * Se conserva el `click()` nativo en vez de pasar a `fireEvent` para no cambiar
 * lo que la prueba ejercita; lo único que se añade es el `act` que faltaba.
 */
function pulsar(nombre: string): void {
  act(() => {
    screen.getByRole("button", { name: nombre }).click();
  });
}

/**
 * Vacía las microtareas pendientes, con el ámbito de `act` abierto. SIN RELOJ.
 *
 * Sustituye a las antiguas esperas de 50 ms y 0 ms. La diferencia importa: un
 * plazo fijo da por supuesto que lo que tenga que pasar cabrá en la ventana, lo
 * que en una máquina cargada puede ser falso —y las advertencias volverían—.
 * Aquí no se espera un plazo: todas las promesas en juego son respuestas
 * simuladas ya resueltas, y `act` cede un turno de macrotarea antes de salir, que
 * agota la cadena de microtareas pendientes y confirma lo que produzca.
 *
 * Se usa SOLO donde no hay condición que esperar: para comprobar que algo **no**
 * ocurre, o que una respuesta atrasada **no** pisa lo que ya está en pantalla.
 * Donde sí hay condición, se espera la condición con `waitFor`.
 */
async function vaciarMicrotareas(): Promise<void> {
  await act(async () => {});
}

const montar = () =>
  render(
    <AuthProvider>
      <Sonda />
    </AuthProvider>
  );

const locksOriginal = globalThis.navigator?.locks;

beforeEach(() => {
  instalarCerrojos();
  vi.resetAllMocks();
  sessionStorage.clear();
  reiniciarCoordinador();
  reiniciarCsrf();
  vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-boot" });
  vi.mocked(authApi.apiLogout).mockResolvedValue(undefined);
  vi.mocked(authApi.apiLogin).mockResolvedValue(SESION_B);
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "locks", { value: locksOriginal, configurable: true });
});


describe("un refresco en vuelo no puede resucitar en la pestaña que lo inició", () => {
  it("logout en la MISMA pestaña: espera al refresco y la sesión queda cerrada", async () => {
    // Primera restauración: sesión de A activa.
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A);
    montar();
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));

    // Un refresco queda EN VUELO.
    const enVuelo = diferida<typeof SESION_A>();
    vi.mocked(authApi.apiRefresh).mockReturnValueOnce(enVuelo.promesa);
    forzarRefresco();
    await waitFor(() => expect(authApi.apiRefresh).toHaveBeenCalledTimes(2));

    /**
     * El usuario cierra sesión mientras el refresco sigue en vuelo.
     *
     * Las dos operaciones comparten cerrojo, así que el cierre NO se ejecuta
     * todavía: espera. Antes no lo hacía, y ahí estaba la carrera —el refresco
     * consumía la cookie y escribía su `Set-Cookie` después del borrado, con lo
     * que quedaba una sesión renovable que el usuario creía cerrada—.
     */
    pulsar("Salir");
    /**
     * Aquí no hay condición que esperar: lo que se comprueba es que algo **no**
     * sucede. Sin cerrojo, `apiLogout()` saldría a las pocas microtareas de la
     * pulsación —el cerrojo simulado encadena con `.then`—, así que agotar la
     * cadena de microtareas es una comprobación más exigente que un plazo fijo,
     * y no depende de la velocidad de la máquina.
     */
    await vaciarMicrotareas();
    expect(authApi.apiLogout, "el cierre espera su turno").not.toHaveBeenCalled();

    // Al terminar el refresco, el cierre procede.
    enVuelo.resolver(SESION_A);

    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));
    expect(authApi.apiLogout, "y ahora sí llega al servidor").toHaveBeenCalledTimes(1);

    // El estado final es el correcto: nada de la sesión sobrevive.
    expect(screen.getByTestId("username"), "el perfil no puede volver").toHaveTextContent("-");
    expect(screen.getByTestId("token")).toHaveTextContent("-");
    expect(sessionStorage.getItem(CLAVE_PERFIL), "ni el perfil persistido").toBeNull();
  }, 20_000);

  it("login de OTRO usuario en la misma pestaña: permanece B", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A);
    montar();
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));

    const enVuelo = diferida<typeof SESION_A>();
    vi.mocked(authApi.apiRefresh).mockReturnValueOnce(enVuelo.promesa);
    forzarRefresco();
    await waitFor(() => expect(authApi.apiRefresh).toHaveBeenCalledTimes(2));

    /**
     * Entra el usuario B mientras el refresco de A sigue en vuelo. Comparten
     * cerrojo, así que el login espera; al soltarse, primero termina el
     * refresco de A y después entra B.
     */
    pulsar("Entrar como B");
    enVuelo.resolver(SESION_A);

    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));

    /**
     * La respuesta de A ya está resuelta y su cadena de continuaciones es
     * finita: agotarla es exactamente darle su oportunidad de pisar la sesión.
     * Si lo hiciera, se vería en las comprobaciones siguientes.
     */
    await vaciarMicrotareas();

    // Y el resultado del refresco de A, que terminó antes, no vuelve a pisarla.
    expect(screen.getByTestId("username")).toHaveTextContent("usuario.b");
    expect(screen.getByTestId("token"), "el token debe ser el de B").toHaveTextContent(tokenDe("uB"));
    expect(JSON.parse(sessionStorage.getItem(CLAVE_PERFIL)!).username).toBe("usuario.b");
    expect(tokenCsrfActual()).toBe("csrf-B");
  }, 20_000);

  it("cambio de contraseña: permanece la sesión nueva", async () => {
    vi.mocked(authApi.apiChangePassword).mockResolvedValue({
      ...sesionDe("uA", "usuario.a", "csrf-cambiada"),
      mustChangePassword: false,
    });
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A);
    montar();
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));

    const enVuelo = diferida<typeof SESION_A>();
    vi.mocked(authApi.apiRefresh).mockReturnValueOnce(enVuelo.promesa);
    forzarRefresco();
    await waitFor(() => expect(authApi.apiRefresh).toHaveBeenCalledTimes(2));

    // El backend revoca TODAS las sesiones anteriores y emite otra. La petición
    // comparte cerrojo con el refresco, así que espera a que este termine.
    pulsar("Cambiar contraseña");
    enVuelo.resolver(SESION_A);
    await waitFor(() => expect(tokenCsrfActual()).toBe("csrf-cambiada"));
    // Se agota lo que quede de la respuesta del refresco revocado, que es lo
    // único que podría deshacer lo anterior.
    await vaciarMicrotareas();

    // La respuesta del refresco pertenece a la sesión ya revocada.
    expect(tokenCsrfActual(), "el CSRF de la sesión revocada no puede volver").toBe("csrf-cambiada");
    expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion");
  }, 20_000);

  it("si el ciclo NO cambió, la respuesta sí se adopta", async () => {
    // El contraste: la validación no bloquea el camino normal.
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A);
    montar();
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));

    const segunda = sesionDe("uA", "usuario.a.renovado", "csrf-A2");
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(segunda);
    forzarRefresco();

    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a.renovado"));
    expect(tokenCsrfActual()).toBe("csrf-A2");
  }, 20_000);
});

describe("un 401 confirmado se propaga a las demás pestañas", () => {
  it("publica el cierre en vez de limpiar solo localmente", async () => {
    const canal = new BroadcastChannel("fchmn-sesion");
    const recibidos: unknown[] = [];
    canal.onmessage = (e) => recibidos.push(e.data);

    sessionStorage.setItem(CLAVE_PERFIL, JSON.stringify(SESION_A.user));
    vi.mocked(authApi.apiRefresh).mockRejectedValue(new ApiError("Sesión inválida", 401));

    montar();
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));

    /**
     * Se espera el ANUNCIO, que es la condición que la prueba comprueba —el
     * mensaje de `BroadcastChannel` se entrega de forma asíncrona—, en vez de
     * dar por hecho que habrá llegado en un plazo.
     *
     * Antes se llamaba `limpiarSesion(false)` —sin avisar—, y las otras
     * pestañas seguían mostrando una sesión que el servidor ya había declarado
     * inválida.
     */
    await waitFor(() =>
      expect(recibidos.some((m) => (m as { tipo?: string }).tipo === "cerrada"), "el cierre debe anunciarse").toBe(true)
    );
    canal.close();
  });
});
