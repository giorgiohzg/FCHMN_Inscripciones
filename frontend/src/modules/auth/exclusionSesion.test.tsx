/**
 * Fase 6, hallazgo 27 — exclusión mutua de las operaciones de sesión.
 *
 * Las cuatro operaciones que tocan la cookie —refrescar, cerrar, entrar y
 * cambiar la contraseña— tienen que excluirse entre sí. No solo sus peticiones
 * HTTP: la TRANSICIÓN COMPLETA, incluidos el cambio de ciclo, la adopción y el
 * anuncio. Si el cerrojo cubriera solo la petición, entre soltarlo y adoptar
 * podría colarse otra operación y observar una cookie nueva con un ciclo local
 * anterior.
 *
 * Dos defectos concretos que estas pruebas cubren:
 *   - `ForceChangePasswordPage` llamaba a `apiChangePassword` por su cuenta, así
 *     que la petición que REEMPLAZA la cookie salía fuera del cerrojo.
 *   - `login` bloqueaba solo `apiLogin()` y adoptaba después de soltar;
 *     `logout` tomaba y soltaba el cerrojo en cada intento HTTP.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthContext";
import { reiniciarCoordinador, olvidarUltimoAnuncio } from "./refreshCoordinator";
import { reiniciarCsrf } from "./csrf";
import * as authApi from "./authApi";
import { perfilDePrueba, sesionDePrueba } from "../../test/sesionDePrueba";

vi.mock("./authApi");

/**
 * Escribe el registro autoritativo como lo haría la pestaña que inicia sesión
 * dentro del cerrojo: ciclo activo, con la revisión siguiente.
 */
function autoridadActivaDePrueba(ciclo: string): void {
  const crudo = localStorage.getItem("fchmn.ciclo");
  const revision = (crudo ? (JSON.parse(crudo) as { revision: number }).revision : 0) + 1;
  localStorage.setItem("fchmn.ciclo", JSON.stringify({ ciclo, estado: "active", revision }));
}

/** La revisión vigente, con la que hay que etiquetar los mensajes. */
function revisionDePrueba(): number {
  const crudo = localStorage.getItem("fchmn.ciclo");
  return crudo ? (JSON.parse(crudo) as { revision: number }).revision : 1;
}

const sesionDe = (id: string, username: string, csrf: string) =>
  sesionDePrueba(perfilDePrueba({ id, username }), csrf, ["clubs:read"]);

const SESION_A = sesionDe("uA", "usuario.a", "csrf-A");

/** Web Locks: jsdom no la implementa y sin ella no hay exclusión que medir. */
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
 * Cuenta cuántas operaciones de sesión están DENTRO de su sección crítica a la
 * vez. Cada mock la incrementa al entrar y la decrementa al salir, cediendo el
 * control en medio para que un solapamiento se haga visible.
 *
 * Los 10 ms de dentro del mock NO son sincronización: modelan la latencia de la
 * petición y son lo que mantiene la operación ocupando su sección crítica el
 * tiempo suficiente para que otra, si el cerrojo fallara, se cruzara de forma
 * observable. La prueba nunca espera «un rato a ver si terminan»: para eso está
 * `cuandoTerminen`.
 */
function medidorDeSolapamiento() {
  const m = { enVuelo: 0, maximo: 0, orden: [] as string[], terminadas: 0 };
  const esperas: { cuantas: number; avisar: () => void }[] = [];

  /** Avisa a quien esperaba un término que ya se ha producido. */
  function revisarEsperas(): void {
    for (const e of esperas.splice(0)) {
      if (m.terminadas >= e.cuantas && m.enVuelo === 0) e.avisar();
      else esperas.push(e);
    }
  }

  const envolver = <T,>(nombre: string, valor: T) =>
    async (): Promise<T> => {
      m.enVuelo++;
      m.maximo = Math.max(m.maximo, m.enVuelo);
      m.orden.push(nombre);
      await new Promise((r) => setTimeout(r, 10));
      m.enVuelo--;
      m.terminadas++;
      revisarEsperas();
      return valor;
    };

  /**
   * Promesa que se resuelve por el TÉRMINO EFECTIVO de las operaciones —tantas
   * completadas y ninguna en vuelo—, nunca por tiempo transcurrido. Es la
   * condición que sustituye a las antiguas esperas de reloj: en una máquina
   * lenta espera más, y en una rápida menos, pero espera siempre lo justo.
   */
  const cuandoTerminen = (cuantas: number): Promise<void> =>
    new Promise<void>((resolve) => {
      esperas.push({ cuantas, avisar: resolve });
      revisarEsperas();
    });

  return { m, envolver, cuandoTerminen };
}

/**
 * Pulsa varios botones A LA VEZ y DENTRO de `act`.
 *
 * Dos cosas, las dos necesarias:
 *
 *   - `HTMLElement.click()` despacha el evento nativo sin pasar por Testing
 *     Library, así que nada lo envuelve en `act`. El manejador de «Refrescar»
 *     actualiza estado de forma **síncrona** antes de su primer `await`
 *     —`reintentarRestauracion` empieza con `setRestaurando(true)`—, y esa
 *     actualización quedaba fuera del control de la prueba.
 *   - Los despachos van en UN SOLO `act` para que ninguno se procese antes de
 *     que todos hayan salido: lo que estas pruebas miden es precisamente que las
 *     operaciones arrancan a la vez y aun así no se solapan.
 */
function pulsarALaVez(...nombres: string[]): void {
  act(() => {
    for (const nombre of nombres) screen.getByRole("button", { name: nombre }).click();
  });
}

/**
 * Espera el TÉRMINO de unas operaciones, con el ámbito de `act` abierto.
 *
 * Sustituye a la antigua espera de 50 ms. La diferencia no es cosmética: un
 * plazo fijo da por hecho que todo habrá terminado dentro de la ventana, y en
 * una máquina cargada puede no ser cierto —reapareciendo las advertencias— o
 * puede tapar una transición que la prueba debía esperar explícitamente. Aquí se
 * espera una condición: las operaciones **han terminado**.
 *
 * El `act` que la envuelve sigue siendo necesario porque las actualizaciones de
 * estado que cierran cada operación —adoptar la sesión renovada, limpiar al
 * cerrar— ocurren en las continuaciones inmediatamente posteriores, y al salir
 * `act` las vacía y confirma.
 */
async function esperarTermino(cuandoTerminen: (cuantas: number) => Promise<void>, cuantas: number): Promise<void> {
  await act(async () => {
    await cuandoTerminen(cuantas);
  });
}

function Sonda() {
  const { accessToken, user, login, logout, changePassword, reintentarRestauracion, restaurando } = useAuth();
  return (
    <div>
      <span data-testid="estado">{restaurando ? "restaurando" : accessToken ? "con-sesion" : "sin-sesion"}</span>
      <span data-testid="username">{user?.username ?? "-"}</span>
      <button onClick={() => void reintentarRestauracion()}>Refrescar</button>
      <button onClick={() => void logout().catch(() => undefined)}>Salir</button>
      <button onClick={() => void login("otro", "clave").catch(() => undefined)}>Entrar</button>
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

const locksOriginal = globalThis.navigator?.locks;

beforeEach(() => {
  instalarCerrojos();
  vi.resetAllMocks();
  sessionStorage.clear();
  reiniciarCoordinador();
  reiniciarCsrf();
  vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-boot" });
  localStorage.clear();
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "locks", { value: locksOriginal, configurable: true });
});

describe("ninguna operación de sesión se solapa con otra", () => {
  it("refresco + cambio de contraseña: solapamiento máximo 1", async () => {
    const { m, envolver, cuandoTerminen } = medidorDeSolapamiento();

    // Restauración inicial, fuera de la medición.
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A);
    render(
      <AuthProvider>
        <Sonda />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));

    // A partir de aquí, cada operación pasa por el medidor.
    vi.mocked(authApi.apiRefresh).mockImplementation(envolver("refresh", SESION_A));
    vi.mocked(authApi.apiChangePassword).mockImplementation(
      envolver("change", { ...sesionDe("uA", "usuario.a", "csrf-nueva"), mustChangePassword: false })
    );

    // Las dos se disparan a la vez.
    olvidarUltimoAnuncio();
    pulsarALaVez("Refrescar", "Cambiar contraseña");

    await esperarTermino(cuandoTerminen, 2);

    // Se serializaron, en el orden en que se pidieron.
    expect(m.orden).toEqual(["refresh", "change"]);
    // Y la sesión queda coherente: la adopción del cambio ya está confirmada.
    expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion");
    expect(screen.getByTestId("username")).toHaveTextContent("usuario.a");

    /**
     * Ésta es la garantía. Con el cambio de contraseña fuera del cerrojo —como
     * estaba, invocado desde la página— las dos peticiones salían a la vez, y la
     * respuesta del refresco podía reemplazar la cookie DESPUÉS de la que emite
     * el cambio de contraseña.
     */
    expect(m.maximo, "la petición que reemplaza la cookie no puede solaparse con un refresco").toBe(1);
  }, 20_000);

  it("refresco + logout: solapamiento máximo 1", async () => {
    const { m, envolver, cuandoTerminen } = medidorDeSolapamiento();
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A);
    render(
      <AuthProvider>
        <Sonda />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));

    vi.mocked(authApi.apiRefresh).mockImplementation(envolver("refresh", SESION_A));
    vi.mocked(authApi.apiLogout).mockImplementation(envolver("logout", undefined));

    olvidarUltimoAnuncio();
    pulsarALaVez("Refrescar", "Salir");

    await esperarTermino(cuandoTerminen, 2);

    // El estado final observable: tras el cierre no queda sesión. La limpieza
    // también va dentro del cerrojo, así que nadie observa un estado a medias.
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));
    expect(m.orden).toEqual(["refresh", "logout"]);
    expect(m.maximo).toBe(1);
  }, 20_000);

  it("refresco + login: solapamiento máximo 1", async () => {
    const { m, envolver, cuandoTerminen } = medidorDeSolapamiento();
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A);
    render(
      <AuthProvider>
        <Sonda />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));

    vi.mocked(authApi.apiRefresh).mockImplementation(envolver("refresh", SESION_A));
    vi.mocked(authApi.apiLogin).mockImplementation(envolver("login", sesionDe("uB", "usuario.b", "csrf-B")));

    olvidarUltimoAnuncio();
    pulsarALaVez("Refrescar", "Entrar");

    await esperarTermino(cuandoTerminen, 2);

    // El estado final observable: entra B, que es quien pidió el login.
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));
    expect(m.orden).toEqual(["refresh", "login"]);
    expect(m.maximo).toBe(1);
  }, 20_000);

  it("las CUATRO a la vez: nunca hay dos dentro", async () => {
    const { m, envolver, cuandoTerminen } = medidorDeSolapamiento();
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A);
    render(
      <AuthProvider>
        <Sonda />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));

    vi.mocked(authApi.apiRefresh).mockImplementation(envolver("refresh", SESION_A));
    vi.mocked(authApi.apiLogout).mockImplementation(envolver("logout", undefined));
    vi.mocked(authApi.apiLogin).mockImplementation(envolver("login", sesionDe("uB", "usuario.b", "csrf-B")));
    vi.mocked(authApi.apiChangePassword).mockImplementation(
      envolver("change", { ...sesionDe("uA", "usuario.a", "csrf-nueva"), mustChangePassword: false })
    );

    olvidarUltimoAnuncio();
    pulsarALaVez("Refrescar", "Cambiar contraseña", "Salir", "Entrar");

    await esperarTermino(cuandoTerminen, 4);

    /**
     * El estado final NO es cualquiera: lo determina el orden en que se
     * serializaron. Entran por el cerrojo en el orden en que se pidieron, así
     * que la última es el login de B y eso es lo que queda en pantalla.
     */
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));
    expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion");
    expect(m.orden).toEqual(["refresh", "change", "logout", "login"]);
    expect(m.maximo, "las cuatro comparten una única sección crítica").toBe(1);
  }, 25_000);
});

/**
 * CAMBIO DE CUENTA ENTRE PESTAÑAS.
 *
 * El navegador tiene UNA cookie de sesión. Cuando otra pestaña entra como B, la
 * sesión de A dejó de existir: esta pestaña no puede seguir mostrando a A, ni
 * cerrar sesión creyendo que cierra la de A cuando en realidad revocaría la de B.
 */
describe("login en otra pestaña: esta adopta la sesión nueva", () => {
  it("la pestaña que mostraba A pasa a mostrar B", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A);
    render(
      <AuthProvider>
        <Sonda />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));

    // Otra pestaña inicia sesión como B: fija la autoridad del origen —eso hace
    // dentro de su cerrojo— y lo publica.
    const canal = new BroadcastChannel("fchmn-sesion");
    const sesionB = sesionDe("uB", "usuario.b", "csrf-B");
    autoridadActivaDePrueba("ciclo-de-B");
    canal.postMessage({
      tipo: "iniciada",
      ciclo: "ciclo-de-B",
      revision: revisionDePrueba(),
      en: Date.now(),
      sesion: { ...sesionB, ciclo: "ciclo-de-B" },
    });

    await waitFor(() => expect(screen.getByTestId("username"), "no puede seguir mostrando a A").toHaveTextContent("usuario.b"));
    canal.close();
  });

  it("y al cerrar sesión cierra la de B, que es la que existe", async () => {
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A);
    vi.mocked(authApi.apiLogout).mockResolvedValue(undefined);
    render(
      <AuthProvider>
        <Sonda />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));

    const canal = new BroadcastChannel("fchmn-sesion");
    const sesionB = sesionDe("uB", "usuario.b", "csrf-B");
    autoridadActivaDePrueba("ciclo-de-B");
    canal.postMessage({
      tipo: "iniciada",
      ciclo: "ciclo-de-B",
      revision: revisionDePrueba(),
      en: Date.now(),
      sesion: { ...sesionB, ciclo: "ciclo-de-B" },
    });
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));

    pulsarALaVez("Salir");

    // Cierra la sesión que de verdad existe, sin creer que cierra otra cosa.
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));
    expect(authApi.apiLogout).toHaveBeenCalledTimes(1);
    canal.close();
  });
});
