/**
 * A1 — un 401 o una renovación ATRASADOS no pueden afectar a la sesión que ya
 * reemplazó a la suya.
 *
 * El defecto: el cliente HTTP, ante un 401, pedía renovar y reintentaba con
 * «el token que hubiera ahora». Si mientras la respuesta viajaba entró otra
 * cuenta, la operación de A (una ESCRITURA incluida) se reenviaba con las
 * credenciales de B, y un 401 atrasado de A llegaba a limpiar la sesión de B y a
 * anunciar su cierre a las demás pestañas.
 *
 * QUÉ ES SIMULADO Y QUÉ NO. Aquí son reales el `AuthProvider`, el puente de
 * sesión, el coordinador (cerrojo, autoridad en `localStorage`, ciclos) y el
 * cliente HTTP `apiFetch`/`apiFetchArchivo`. Son simulados: el módulo `authApi`
 * (las respuestas del servidor), el `fetch` de las peticiones de negocio, los
 * Web Locks (jsdom no los tiene) y las demoras, que se controlan a mano con
 * promesas diferidas. NADA llega a un servidor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthContext";
import {
  reiniciarCoordinador,
  olvidarUltimoAnuncio,
  comenzarCicloDeSesion,
  autoridadActual,
  cicloActual,
} from "./refreshCoordinator";
import { reiniciarCsrf } from "./csrf";
import {
  ApiError,
  SesionCambiadaError,
  apiFetch,
  apiFetchArchivo,
  conectarSesion,
  type PuenteDeSesion,
} from "../../shared/apiClient";
import * as authApi from "./authApi";
import { perfilDePrueba, sesionDePrueba } from "../../test/sesionDePrueba";

vi.mock("./authApi");

/**
 * El módulo del cliente HTTP, TRANSPARENTE salvo por una cosa: registra el puente
 * de sesión que conecta el `AuthProvider`. Así una prueba puede envolver el
 * puente REAL para insertar una barrera en un punto exacto —entre «la renovación
 * se resolvió» y «sale el reintento»—, que de otro modo solo dura microtareas.
 */
const { puentes } = vi.hoisted(() => ({ puentes: [] as unknown[] }));
vi.mock("../../shared/apiClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/apiClient")>();
  return {
    ...actual,
    conectarSesion: (p: PuenteDeSesion) => {
      puentes.push(p);
      actual.conectarSesion(p);
    },
  };
});

const perfil = (id: string, username: string) => perfilDePrueba({ id, username });
const sesionDe = (id: string, username: string, csrf: string, marca = "") =>
  sesionDePrueba(perfil(id, username), csrf, ["clubs:read"], marca);

const SESION_A = sesionDe("uA", "usuario.a", "csrf-A");
const SESION_A_RENOVADA = sesionDe("uA", "usuario.a", "csrf-A2", "renovada");
const SESION_A_OTRO_LOGIN = sesionDe("uA", "usuario.a", "csrf-A3", "otro-login");
const SESION_B = sesionDe("uB", "usuario.b", "csrf-B");

/** Promesa que resolvemos —o rechazamos— nosotros, para dejar algo "en vuelo". */
function diferida<T>() {
  let resolver!: (v: T) => void;
  let rechazar!: (e: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

const respuesta = (status: number, cuerpo: unknown = { message: status === 401 ? "Token expirado" : "ok" }) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { "Content-Disposition": 'attachment; filename="informe.xlsx"' } });

function Sonda() {
  const { user, accessToken, login, logout, restaurando } = useAuth();
  return (
    <div>
      <span data-testid="estado">{restaurando ? "restaurando" : accessToken ? "con-sesion" : "sin-sesion"}</span>
      <span data-testid="username">{user?.username ?? "-"}</span>
      <span data-testid="token">{accessToken ?? "-"}</span>
      <button onClick={() => void logout().catch(() => undefined)}>Salir</button>
      <button onClick={() => void login("usuario", "clave").catch(() => undefined)}>Entrar</button>
    </div>
  );
}

/**
 * Cuántas veces se ha pedido el cerrojo. Es un OBSERVABLE: una operación que
 * espera el cerrojo no deja otro rastro, y las pruebas de A1 necesitan saber que
 * ya está en la cola antes de soltar a quien lo retiene.
 */
let solicitudesDeCerrojo = 0;

/** Web Locks, que jsdom no implementa: exclusivo por nombre y con cola. */
function instalarCerrojos() {
  const cola = new Map<string, Promise<unknown>>();
  const request = async (nombre: string, fn: () => Promise<unknown>) => {
    solicitudesDeCerrojo++;
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

/** Pulsa un botón DENTRO de `act` (ver `cicloIniciadora.test.tsx`). */
function pulsar(nombre: string): void {
  act(() => {
    screen.getByRole("button", { name: nombre }).click();
  });
}

/** Deja correr lo que el componente haga en respuesta, dentro de `act`. */
async function dentroDeAct<T>(promesa: Promise<T>): Promise<T> {
  let valor!: T;
  await act(async () => {
    valor = await promesa;
  });
  return valor;
}

/**
 * Espera a que el canal entregue lo que haya publicado. El canal real es
 * asíncrono y no hay condición que esperar cuando se comprueba que algo NO se
 * anunció; por eso las comprobaciones de anuncios se apoyan además en el estado
 * (la autoridad del origen, que se escribe de forma síncrona).
 */
async function dejarLlegarElCanal(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

const montar = () =>
  render(
    <AuthProvider>
      <Sonda />
    </AuthProvider>
  );

/** Restaura la sesión de A y espera a que esté en pantalla. */
async function conSesionA() {
  vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A);
  montar();
  await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.a"));
}

const fetchOriginal = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;
let canal: BroadcastChannel;
let anunciados: Array<{ tipo?: string }>;

const cierresAnunciados = () => anunciados.filter((m) => m.tipo === "cerrada").length;

/** La autoridad del origen sigue activa y es la del ciclo vigente en esta pestaña. */
function autoridadActivaDelCicloVigente(): boolean {
  const a = autoridadActual();
  return a !== null && a.estado === "active" && a.ciclo === cicloActual();
}

beforeEach(() => {
  solicitudesDeCerrojo = 0;
  puentes.length = 0;
  instalarCerrojos();
  vi.resetAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  reiniciarCoordinador();
  reiniciarCsrf();
  vi.mocked(authApi.apiCsrf).mockResolvedValue({ csrfToken: "csrf-boot" });
  vi.mocked(authApi.apiLogout).mockResolvedValue(undefined);
  vi.mocked(authApi.apiLogin).mockResolvedValue(SESION_B);

  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  anunciados = [];
  canal = new BroadcastChannel("fchmn-sesion");
  canal.onmessage = (e) => anunciados.push(e.data as { tipo?: string });
});

afterEach(() => {
  vi.useRealTimers();
  // Solo `fetch`: `vi.unstubAllGlobals()` también desmontaría el `BroadcastChannel`
  // acotado al archivo que instala `src/test/setup.ts`, y el canal real de Node
  // no se comunica con el que ya tiene abierto el coordinador.
  vi.stubGlobal("fetch", fetchOriginal);
  canal.close();
  Object.defineProperty(globalThis.navigator, "locks", { value: locksOriginal, configurable: true });
});

/** Que la sesión de B siga intacta y nada la haya tocado. */
async function expectSesionBIntacta() {
  expect(screen.getByTestId("username")).toHaveTextContent("usuario.b");
  expect(screen.getByTestId("token"), "el token es el de B").toHaveTextContent(SESION_B.accessToken);
  expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion");
  expect(autoridadActivaDelCicloVigente(), "ninguna tumba sobre el ciclo vigente").toBe(true);
  expect(authApi.apiLogout, "nadie cerró sesión en el servidor").not.toHaveBeenCalled();
  await dejarLlegarElCanal();
  expect(cierresAnunciados(), "y no se anunció ningún cierre a las demás pestañas").toBe(0);
}

describe("A1 — el 401 INICIAL llega después de que la sesión cambió", () => {
  it("cambio de CUENTA: la escritura no se repite con las credenciales de B y B queda intacta", async () => {
    await conSesionA();

    const enVuelo = diferida<Response>();
    fetchSpy.mockReturnValueOnce(enVuelo.promesa);
    const pendiente = apiFetch("/competitions", { method: "POST", body: JSON.stringify({ name: "Copa" }) }).catch((e: unknown) => e);
    expect(new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers).get("Authorization")).toBe(
      `Bearer ${SESION_A.accessToken}`
    );

    // Mientras la respuesta viaja, entra B.
    pulsar("Entrar");
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));

    // Sin el anuncio reciente del login de B a mano, una renovación tendría que
    // llegar de verdad al servidor: así se distingue «no se intentó» de «se
    // reutilizó lo anunciado».
    olvidarUltimoAnuncio();
    enVuelo.resolver(respuesta(401));
    const error = await dentroDeAct(pendiente);

    expect(error).toBeInstanceOf(SesionCambiadaError);
    expect(fetchSpy, "la escritura salió UNA vez, con el token de A").toHaveBeenCalledTimes(1);
    expect(authApi.apiRefresh, "el 401 de A tampoco rotó el refresh token vigente (el de B)").toHaveBeenCalledTimes(1);
    await expectSesionBIntacta();
  }, 20_000);

  it("el MISMO usuario con otro login es OTRA sesión: un token distinto no basta", async () => {
    await conSesionA();

    const enVuelo = diferida<Response>();
    fetchSpy.mockReturnValueOnce(enVuelo.promesa);
    const pendiente = apiFetch("/competitions", { method: "POST", body: "{}" }).catch((e: unknown) => e);

    // Vuelve a iniciar sesión el mismo usuario: otro ciclo, otro token.
    vi.mocked(authApi.apiLogin).mockResolvedValue(SESION_A_OTRO_LOGIN);
    pulsar("Entrar");
    await waitFor(() => expect(screen.getByTestId("token")).toHaveTextContent(SESION_A_OTRO_LOGIN.accessToken));

    enVuelo.resolver(respuesta(401));
    const error = await dentroDeAct(pendiente);

    expect(error).toBeInstanceOf(SesionCambiadaError);
    expect(fetchSpy, "no se repite bajo el login nuevo").toHaveBeenCalledTimes(1);
    expect(authApi.apiRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("token")).toHaveTextContent(SESION_A_OTRO_LOGIN.accessToken);
    expect(autoridadActivaDelCicloVigente()).toBe(true);
    await dejarLlegarElCanal();
    expect(cierresAnunciados()).toBe(0);
  }, 20_000);

  it("tras un CIERRE de sesión: no renueva, no repite y no anuncia un segundo cierre", async () => {
    await conSesionA();

    const enVuelo = diferida<Response>();
    fetchSpy.mockReturnValueOnce(enVuelo.promesa);
    const pendiente = apiFetch("/competitions", { method: "POST", body: "{}" }).catch((e: unknown) => e);

    pulsar("Salir");
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));
    await dejarLlegarElCanal();
    expect(cierresAnunciados(), "el cierre propio se anunció una vez").toBe(1);

    olvidarUltimoAnuncio();
    enVuelo.resolver(respuesta(401));
    const error = await dentroDeAct(pendiente);

    expect(error).toBeInstanceOf(SesionCambiadaError);
    expect(authApi.apiRefresh, "no hay sesión que renovar: no se llamó al servidor").toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await dejarLlegarElCanal();
    expect(cierresAnunciados(), "ningún cierre adicional").toBe(1);
  }, 20_000);

  it("DESCARGAS: el mismo criterio en `apiFetchArchivo`", async () => {
    await conSesionA();

    const enVuelo = diferida<Response>();
    fetchSpy.mockReturnValueOnce(enVuelo.promesa);
    const pendiente = apiFetchArchivo("/export/team-manager/zip?competitionId=c1", "x.zip").catch((e: unknown) => e);

    pulsar("Entrar");
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));

    enVuelo.resolver(respuesta(401));
    const error = await dentroDeAct(pendiente);

    expect(error).toBeInstanceOf(SesionCambiadaError);
    expect(fetchSpy, "la descarga no se repite con otra sesión").toHaveBeenCalledTimes(1);
    expect(authApi.apiRefresh).toHaveBeenCalledTimes(1);
    await expectSesionBIntacta();
  }, 20_000);
});

describe("A1 — el 401 del REINTENTO llega después de que la sesión cambió", () => {
  it("la sesión de B no se cierra ni se anuncia, y el reintento fue el único", async () => {
    await conSesionA();
    olvidarUltimoAnuncio(); // fuerza una renovación que llegue de verdad al servidor
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A_RENOVADA);

    const reintento = diferida<Response>();
    fetchSpy.mockResolvedValueOnce(respuesta(401)).mockReturnValueOnce(reintento.promesa);
    const pendiente = apiFetch("/competitions", { method: "POST", body: "{}" }).catch((e: unknown) => e);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    // El reintento, con el token renovado de A, va en vuelo. Entra B.
    expect(new Headers((fetchSpy.mock.calls[1]![1] as RequestInit).headers).get("Authorization")).toBe(
      `Bearer ${SESION_A_RENOVADA.accessToken}`
    );
    pulsar("Entrar");
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));

    reintento.resolver(respuesta(401));
    const error = await dentroDeAct(pendiente);

    expect(error).toBeInstanceOf(SesionCambiadaError);
    expect((error as Error).message).not.toMatch(/expir/i);
    expect(fetchSpy, "un reintento como máximo").toHaveBeenCalledTimes(2);
    expect(authApi.apiRefresh, "restauración + una renovación").toHaveBeenCalledTimes(2);
    await expectSesionBIntacta();
  }, 20_000);
});

describe("A1 — mismo usuario y mismo ciclo: el camino normal sigue funcionando", () => {
  it("renueva una vez y reintenta una vez con el token RENOVADO de la misma sesión", async () => {
    await conSesionA();
    olvidarUltimoAnuncio();
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A_RENOVADA);
    fetchSpy.mockResolvedValueOnce(respuesta(401)).mockResolvedValueOnce(respuesta(200, { ok: true }));

    const resultado = await dentroDeAct(apiFetch<{ ok: boolean }>("/clubs"));

    expect(resultado).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers).get("Authorization")).toBe(
      `Bearer ${SESION_A.accessToken}`
    );
    expect(new Headers((fetchSpy.mock.calls[1]![1] as RequestInit).headers).get("Authorization")).toBe(
      `Bearer ${SESION_A_RENOVADA.accessToken}`
    );
    expect(authApi.apiRefresh, "restauración + una renovación").toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("token")).toHaveTextContent(SESION_A_RENOVADA.accessToken);
  }, 20_000);

  it("un 401 legítimo (la sesión de ESTE ciclo ya no vale) sí cierra y anuncia, una sola vez", async () => {
    await conSesionA();
    olvidarUltimoAnuncio();
    vi.mocked(authApi.apiRefresh).mockRejectedValueOnce(new ApiError("Sesión inválida", 401));
    fetchSpy.mockResolvedValueOnce(respuesta(401));

    const error = await dentroDeAct(apiFetch("/clubs").catch((e: unknown) => e));

    expect(error).toMatchObject({ status: 401, message: expect.stringMatching(/sesión expiró/i) });
    expect(fetchSpy, "sin sesión no hay reintento").toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));
    await waitFor(() => expect(cierresAnunciados()).toBe(1));
  }, 20_000);
});

describe("A1 — la renovación termina después de un cambio de sesión", () => {
  it("`descartada` (cambió el ciclo en pleno vuelo): no reutiliza ningún token y no repite", async () => {
    await conSesionA();
    olvidarUltimoAnuncio();
    fetchSpy.mockResolvedValueOnce(respuesta(401));

    // Mientras la renovación viaja, otra pestaña inicia sesión: el ciclo cambia.
    vi.mocked(authApi.apiRefresh).mockImplementationOnce(async () => {
      comenzarCicloDeSesion();
      return SESION_A_RENOVADA;
    });

    const error = await dentroDeAct(apiFetch("/competitions", { method: "POST", body: "{}" }).catch((e: unknown) => e));

    expect(error).toBeInstanceOf(SesionCambiadaError);
    expect(fetchSpy, "antes devolvía el token que hubiera y reintentaba").toHaveBeenCalledTimes(1);
    // No se adoptó la renovación descartada ni se limpió nada.
    expect(screen.getByTestId("token")).toHaveTextContent(SESION_A.accessToken);
    expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion");
    expect(autoridadActivaDelCicloVigente()).toBe(true);
    await dejarLlegarElCanal();
    expect(cierresAnunciados()).toBe(0);
  }, 20_000);

  it("`invalida` que llega con un login ya EN COLA: el cierre condicional lo encuentra cambiado", async () => {
    await conSesionA();
    olvidarUltimoAnuncio();
    fetchSpy.mockResolvedValueOnce(respuesta(401));
    const refresco = diferida<typeof SESION_A>();
    vi.mocked(authApi.apiRefresh).mockReturnValueOnce(refresco.promesa);

    const pendiente = apiFetch("/competitions", { method: "POST", body: "{}" }).catch((e: unknown) => e);
    await waitFor(() => expect(authApi.apiRefresh).toHaveBeenCalledTimes(2));

    // El login pide el cerrojo mientras el refresco lo sostiene: queda en cola,
    // DELANTE de cualquier cierre que el veredicto provoque después.
    pulsar("Entrar");
    await act(async () => {
      refresco.rechazar(new ApiError("Sesión inválida", 401));
    });
    const error = await dentroDeAct(pendiente);
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));

    expect(error, "el 401 era de la sesión A, ya sustituida").toBeInstanceOf(SesionCambiadaError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expectSesionBIntacta();
  }, 20_000);
});

describe("A1 — restauración", () => {
  it("un 401 del refresco de arranque que llega con un login en cola NO cierra la sesión nueva", async () => {
    const refresco = diferida<typeof SESION_A>();
    vi.mocked(authApi.apiRefresh).mockReturnValueOnce(refresco.promesa);
    montar();
    await waitFor(() => expect(authApi.apiRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("estado")).toHaveTextContent("restaurando");

    pulsar("Entrar");
    await act(async () => {
      refresco.rechazar(new ApiError("Sesión inválida", 401));
    });

    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("con-sesion"));
    expect(authApi.apiRefresh).toHaveBeenCalledTimes(1);
    await expectSesionBIntacta();
  }, 20_000);

  it("contraste: sin cambio de sesión, ese mismo 401 sí limpia y anuncia", async () => {
    vi.mocked(authApi.apiRefresh).mockRejectedValueOnce(new ApiError("Sesión inválida", 401));
    sessionStorage.setItem("natacion.perfil", JSON.stringify(SESION_A.user));
    montar();

    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));
    await waitFor(() => expect(cierresAnunciados()).toBe(1));
  }, 20_000);
});

describe("A1 — renovación proactiva", () => {
  it("un 401 de la renovación periódica que llega con un login en cola NO cierra la sesión nueva", async () => {
    // Solo los intervalos son simulados: el resto del reloj (y `waitFor`) es real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await conSesionA();
    olvidarUltimoAnuncio();

    const refresco = diferida<typeof SESION_A>();
    vi.mocked(authApi.apiRefresh).mockReturnValueOnce(refresco.promesa);
    await act(async () => {
      vi.advanceTimersByTime(12 * 60_000);
    });
    await vi.waitFor(() => expect(authApi.apiRefresh).toHaveBeenCalledTimes(2));

    pulsar("Entrar");
    await act(async () => {
      refresco.rechazar(new ApiError("Sesión inválida", 401));
    });

    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));
    await expectSesionBIntacta();
  }, 20_000);

  it("contraste: sin cambio de sesión, el 401 de la renovación periódica sí cierra", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await conSesionA();
    olvidarUltimoAnuncio();
    vi.mocked(authApi.apiRefresh).mockRejectedValueOnce(new ApiError("Sesión inválida", 401));

    await act(async () => {
      vi.advanceTimersByTime(12 * 60_000);
    });

    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));
    await waitFor(() => expect(cierresAnunciados()).toBe(1));
  }, 20_000);
});

/* ========================================================================== *
 * A1 (corrección)
 *
 * Todo lo de abajo se ordena con BARRERAS —promesas diferidas y el contador de
 * solicitudes del cerrojo—, no con plazos: cada prueba sabe, antes de soltar la
 * barrera, que la operación que importa ya está esperando en la cola.
 * ========================================================================== */

/** Espera a que la operación recién lanzada haya pedido el cerrojo: ya está EN LA COLA. */
const esperarEnCola = (base: number) => vi.waitFor(() => expect(solicitudesDeCerrojo).toBe(base + 1));

/**
 * Envuelve el puente REAL: tras resolverse la renovación y ANTES de devolverla al
 * cliente HTTP, ejecuta `trasRenovar`. Es la barrera entre «la renovación se
 * resolvió» y «sale el reintento».
 */
function conBarreraTrasLaRenovacion(trasRenovar: () => Promise<void>): void {
  const real = puentes[puentes.length - 1] as PuenteDeSesion;
  conectarSesion({
    ...real,
    renovar: async (identidad) => {
      const resultado = await real.renovar(identidad);
      await trasRenovar();
      return resultado;
    },
  });
}

/** Inicia sesión como B y espera a que esté en pantalla. */
async function entrarComoB(): Promise<void> {
  pulsar("Entrar");
  await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));
}

describe("A1 (corrección) — la identidad se comprueba DESPUÉS de esperar el cerrojo", () => {
  it("lo retiene un CIERRE de sesión: la renovación de la petición antigua no llega al servidor", async () => {
    await conSesionA();
    olvidarUltimoAnuncio();

    const enVuelo = diferida<Response>();
    fetchSpy.mockReturnValueOnce(enVuelo.promesa);
    const pendiente = apiFetch("/competitions", { method: "POST", body: "{}" }).catch((e: unknown) => e);

    // El cierre toma el cerrojo y se queda esperando al servidor.
    const cierreDelServidor = diferida<void>();
    vi.mocked(authApi.apiLogout).mockReturnValueOnce(cierreDelServidor.promesa);
    pulsar("Salir");
    await vi.waitFor(() => expect(authApi.apiLogout).toHaveBeenCalledTimes(1));

    // El 401 llega con el cerrojo ocupado: la sesión de A AÚN es la vigente, así que
    // la comprobación de entrada pasa y la renovación queda en cola.
    const base = solicitudesDeCerrojo;
    enVuelo.resolver(respuesta(401));
    await esperarEnCola(base);

    // Se suelta el cierre: la sesión de A deja de existir ANTES de que la renovación entre.
    await act(async () => {
      cierreDelServidor.resolver();
    });
    const error = await dentroDeAct(pendiente);

    expect(error).toBeInstanceOf(SesionCambiadaError);
    expect(authApi.apiRefresh, "antes la renovación salía igualmente hacia el servidor").toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion");
    await dejarLlegarElCanal();
    expect(cierresAnunciados(), "solo el cierre propio").toBe(1);
  }, 20_000);

  it("lo retiene un LOGIN de otra cuenta: no se renueva por causa de la petición antigua", async () => {
    await conSesionA();
    olvidarUltimoAnuncio();

    const enVuelo = diferida<Response>();
    fetchSpy.mockReturnValueOnce(enVuelo.promesa);
    const pendiente = apiFetch("/competitions", { method: "POST", body: "{}" }).catch((e: unknown) => e);

    const loginDelServidor = diferida<typeof SESION_B>();
    vi.mocked(authApi.apiLogin).mockReturnValueOnce(loginDelServidor.promesa);
    pulsar("Entrar");
    await vi.waitFor(() => expect(authApi.apiLogin).toHaveBeenCalledTimes(1));

    const base = solicitudesDeCerrojo;
    enVuelo.resolver(respuesta(401));
    await esperarEnCola(base);

    await act(async () => {
      loginDelServidor.resolver(SESION_B);
    });
    const error = await dentroDeAct(pendiente);
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));

    expect(error).toBeInstanceOf(SesionCambiadaError);
    expect(authApi.apiRefresh, "el 401 de A no rotó el refresh token de B").toHaveBeenCalledTimes(1);
    expect(fetchSpy, "la escritura de A no se repitió bajo B").toHaveBeenCalledTimes(1);
    await expectSesionBIntacta();
  }, 20_000);
});

describe("A1 (corrección) — la sesión cambia ENTRE la renovación y el reintento", () => {
  it("ESCRITURA: no sale una segunda petición y B queda intacta", async () => {
    await conSesionA();
    olvidarUltimoAnuncio();
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A_RENOVADA);
    fetchSpy.mockResolvedValue(respuesta(401));
    conBarreraTrasLaRenovacion(entrarComoB);

    const error = await apiFetch("/competitions", { method: "POST", body: JSON.stringify({ name: "Copa" }) }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(SesionCambiadaError);
    expect(fetchSpy, "la escritura salió UNA vez: el reintento se canceló").toHaveBeenCalledTimes(1);
    expect(authApi.apiRefresh, "restauración + la renovación de A").toHaveBeenCalledTimes(2);
    await expectSesionBIntacta();
  }, 20_000);

  it("DESCARGA: tampoco sale la segunda petición", async () => {
    await conSesionA();
    olvidarUltimoAnuncio();
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A_RENOVADA);
    fetchSpy.mockResolvedValue(respuesta(401));
    conBarreraTrasLaRenovacion(entrarComoB);

    const error = await apiFetchArchivo("/export/team-manager/zip?competitionId=c1", "x.zip").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SesionCambiadaError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expectSesionBIntacta();
  }, 20_000);

  it("el MISMO usuario que vuelve a iniciar sesión en esa ventana también la cancela", async () => {
    await conSesionA();
    olvidarUltimoAnuncio();
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A_RENOVADA);
    fetchSpy.mockResolvedValue(respuesta(401));
    vi.mocked(authApi.apiLogin).mockResolvedValue(SESION_A_OTRO_LOGIN);
    conBarreraTrasLaRenovacion(async () => {
      pulsar("Entrar");
      await waitFor(() => expect(screen.getByTestId("token")).toHaveTextContent(SESION_A_OTRO_LOGIN.accessToken));
    });

    const error = await apiFetch("/competitions", { method: "POST", body: "{}" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SesionCambiadaError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(autoridadActivaDelCicloVigente()).toBe(true);
    await dejarLlegarElCanal();
    expect(cierresAnunciados()).toBe(0);
  }, 20_000);

  it("contraste: con la barrera pero SIN cambio de sesión, el reintento sale con el token renovado", async () => {
    await conSesionA();
    olvidarUltimoAnuncio();
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A_RENOVADA);
    fetchSpy.mockResolvedValueOnce(respuesta(401)).mockResolvedValueOnce(respuesta(200, { ok: true }));
    conBarreraTrasLaRenovacion(async () => undefined);

    await expect(apiFetch("/competitions", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new Headers((fetchSpy.mock.calls[1]![1] as RequestInit).headers).get("Authorization")).toBe(
      `Bearer ${SESION_A_RENOVADA.accessToken}`
    );
  }, 20_000);
});

describe("A1 (corrección) — el cierre exige la identidad completa", () => {
  /**
   * «Mismo ciclo, distinto usuario» NO ocurre por el camino normal: cada login
   * abre un ciclo nuevo (`comenzarCicloDeSesion`). Se reproduce por el único
   * camino por el que puede existir —un aviso de otra pestaña que reutiliza el
   * ciclo vigente—, que es justo lo que `sessionSchema.ts` dice que puede llegar
   * por el canal.
   */
  it("GARANTÍA EXISTENTE: cada inicio de sesión abre un ciclo distinto, incluso del mismo usuario", async () => {
    await conSesionA();
    const ciclos = [cicloActual()];

    await entrarComoB();
    ciclos.push(cicloActual());

    vi.mocked(authApi.apiLogin).mockResolvedValue(SESION_A_OTRO_LOGIN);
    pulsar("Entrar");
    await waitFor(() => expect(screen.getByTestId("token")).toHaveTextContent(SESION_A_OTRO_LOGIN.accessToken));
    ciclos.push(cicloActual());

    expect(new Set(ciclos).size, "tres sesiones, tres ciclos").toBe(3);
  }, 20_000);

  it("MISMO ciclo, otro usuario: el cierre pedido por la identidad anterior no limpia ni anuncia nada", async () => {
    await conSesionA();
    // Un login real deja la autoridad escrita en el origen (la restauración no la escribe).
    vi.mocked(authApi.apiLogin).mockResolvedValueOnce(SESION_A);
    pulsar("Entrar");
    await vi.waitFor(() => expect(autoridadActual()).not.toBeNull());
    olvidarUltimoAnuncio();
    const cicloDeA = cicloActual();

    // Una renovación de A queda sosteniendo el cerrojo, esperando al servidor.
    const refresco = diferida<typeof SESION_A>();
    vi.mocked(authApi.apiRefresh).mockReturnValueOnce(refresco.promesa);
    fetchSpy.mockResolvedValueOnce(respuesta(401));
    const pendiente = apiFetch("/competitions", { method: "POST", body: "{}" }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(authApi.apiRefresh).toHaveBeenCalledTimes(2));

    // Llega, por el canal, el inicio de sesión de B REUTILIZANDO el ciclo vigente.
    // Queda en la cola del cerrojo, DELANTE de cualquier cierre que provoque el 401.
    const base = solicitudesDeCerrojo;
    const autoridad = autoridadActual()!;
    canal.postMessage({
      tipo: "iniciada",
      ciclo: autoridad.ciclo,
      revision: autoridad.revision + 1,
      en: Date.now(),
      sesion: { ...SESION_B, ciclo: autoridad.ciclo },
    });
    await esperarEnCola(base);

    // El servidor rechaza la renovación de A: veredicto `invalida` para el ciclo vigente.
    await act(async () => {
      refresco.rechazar(new ApiError("Sesión inválida", 401));
    });
    const error = await dentroDeAct(pendiente);
    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("usuario.b"));

    expect(cicloActual(), "el ciclo es EL MISMO: solo cambió el usuario").toBe(cicloDeA);
    expect(error, "el veredicto era sobre la sesión de A, no sobre la de B").toBeInstanceOf(SesionCambiadaError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expectSesionBIntacta();
  }, 20_000);
});

describe("A1 (corrección) — restauración legítima y renovación normal", () => {
  it("una petición que salió ANTES de restaurar la sesión se completa y se reintenta con la sesión restaurada", async () => {
    const restauracion = diferida<typeof SESION_A>();
    vi.mocked(authApi.apiRefresh).mockReturnValueOnce(restauracion.promesa);
    montar();
    await waitFor(() => expect(authApi.apiRefresh).toHaveBeenCalledTimes(1));

    // Sale sin credenciales: la identidad aún no se conoce (`userId: null`).
    fetchSpy.mockResolvedValueOnce(respuesta(401)).mockResolvedValueOnce(respuesta(200, { ok: true }));
    const pendiente = apiFetch<{ ok: boolean }>("/clubs");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    await act(async () => {
      restauracion.resolver(SESION_A);
    });
    const resultado = await dentroDeAct(pendiente);

    expect(resultado).toEqual({ ok: true });
    expect(authApi.apiRefresh, "la restauración sirvió también a la petición: una sola renovación").toHaveBeenCalledTimes(1);
    expect(new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers).get("Authorization")).toBeNull();
    expect(new Headers((fetchSpy.mock.calls[1]![1] as RequestInit).headers).get("Authorization")).toBe(
      `Bearer ${SESION_A.accessToken}`
    );
    expect(screen.getByTestId("username")).toHaveTextContent("usuario.a");
  }, 20_000);

  it("si esa restauración la rechaza el servidor, la sesión se limpia UNA sola vez", async () => {
    const restauracion = diferida<typeof SESION_A>();
    vi.mocked(authApi.apiRefresh).mockReturnValueOnce(restauracion.promesa);
    sessionStorage.setItem("natacion.perfil", JSON.stringify(SESION_A.user));
    montar();
    await waitFor(() => expect(authApi.apiRefresh).toHaveBeenCalledTimes(1));

    fetchSpy.mockResolvedValueOnce(respuesta(401));
    const pendiente = apiFetch("/clubs").catch((e: unknown) => e);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    await act(async () => {
      restauracion.rechazar(new ApiError("Sesión inválida", 401));
    });
    const error = await dentroDeAct(pendiente);

    expect(error).toBeInstanceOf(ApiError);
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("sin-sesion"));
    await dejarLlegarElCanal();
    expect(cierresAnunciados(), "el primero en cerrar anuncia; el otro encuentra el ciclo ya cerrado").toBe(1);
  }, 20_000);

  it("renovación normal de la misma identidad y ciclo: una renovación, un reintento, token renovado", async () => {
    await conSesionA();
    olvidarUltimoAnuncio();
    vi.mocked(authApi.apiRefresh).mockResolvedValueOnce(SESION_A_RENOVADA);
    fetchSpy.mockResolvedValueOnce(respuesta(401)).mockResolvedValueOnce(respuesta(200, { ok: true }));

    await expect(dentroDeAct(apiFetch("/clubs", { method: "POST", body: "{}" }))).resolves.toEqual({ ok: true });

    expect(authApi.apiRefresh).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("token")).toHaveTextContent(SESION_A_RENOVADA.accessToken);
    await dejarLlegarElCanal();
    expect(cierresAnunciados()).toBe(0);
  }, 20_000);
});
