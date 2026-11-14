/**
 * ACCESOS POR ROL en la sesión: funciones efectivas, ocultamiento y rutas protegidas.
 *
 *  - Se piden al iniciar o restaurar la sesión y en cada renovación (cambia el token), y otra vez
 *    al recibir 403 `FUNCION_DESHABILITADA`.
 *  - No se piden con el cambio OBLIGATORIO de contraseña pendiente.
 *  - Se descartan las respuestas tardías de otra cuenta, de otra sesión o de una versión anterior.
 *  - Un fallo de carga no oculta nada ni cierra la sesión: decide el servidor.
 *  - Menús, el botón «Cambiar contraseña» y las rutas (también por URL directa) siguen la lista.
 * Interacción simulada con jsdom y servicios simulados; datos sintéticos.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AccesosProvider, useAccesos } from "./AccesosContext";
import { RequiereFuncion, CambioDeContrasenaPermitido } from "./RequiereFuncion";
import { AppShell } from "../../shared/AppShell";

type Sesion = { user: { id: string; username: string; ownerType: string; personId: string | null; clubId: string | null; roles: string[] } | null; accessToken: string | null; mustChangePassword: boolean };
let sesion: Sesion;

vi.mock("./AuthContext", async () => {
  const real = await vi.importActual<typeof import("./AuthContext")>("./AuthContext");
  return {
    ...real,
    useAuth: () => ({
      ...sesion,
      permissions: [],
      hasRole: (r: string) => sesion.user?.roles.includes(r) ?? false,
      hasPermission: () => true,
      restaurando: false,
      restauracionFallida: false,
      login: vi.fn(),
      logout: vi.fn(),
      changePassword: vi.fn(),
      reintentarRestauracion: vi.fn(),
    }),
  };
});

const get = vi.fn();
vi.mock("../../shared/apiClient", async () => {
  const real = await vi.importActual<typeof import("../../shared/apiClient")>("../../shared/apiClient");
  return { ...real, api: { ...real.api, get: (path: string) => get(path) } };
});

const { avisarSiFuncionDeshabilitada, ApiError } = await import("../../shared/apiClient");

function diferida<T>() {
  let resolver!: (v: T) => void;
  let rechazar!: (e: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

const usuario = (id: string, roles = ["delegate"]) => ({ id, username: `u-${id}`, ownerType: "person", personId: "p1", clubId: "c1", roles });

function Sonda() {
  const { deshabilitada, estado, version } = useAccesos();
  return (
    <p data-testid="sonda">
      {estado}|{version}|{["menu.reportes", "reportes.exportar", "cuenta.cambio_voluntario_contrasena"].filter(deshabilitada).join(",")}
    </p>
  );
}
const sonda = () => screen.getByTestId("sonda").textContent;

function montar(ui = <Sonda />) {
  return render(
    <MemoryRouter>
      <AccesosProvider>{ui}</AccesosProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  get.mockReset();
  sesion = { user: usuario("A"), accessToken: "token-1", mustChangePassword: false };
});

describe("funciones efectivas de la sesión", () => {
  it("se piden al iniciar la sesión y se aplican", async () => {
    get.mockResolvedValue({ userId: "A", version: 3, deshabilitadas: ["reportes.exportar"] });
    montar();
    await waitFor(() => expect(sonda()).toBe("cargado|3|reportes.exportar"));
    expect(get).toHaveBeenCalledWith("/auth/accesos");
  });

  it("se vuelven a pedir al renovar (token nuevo) y al recibir FUNCION_DESHABILITADA", async () => {
    get.mockResolvedValue({ userId: "A", version: 3, deshabilitadas: [] });
    const vista = montar();
    await waitFor(() => expect(sonda()).toBe("cargado|3|"));

    get.mockResolvedValue({ userId: "A", version: 4, deshabilitadas: ["menu.reportes"] });
    sesion = { ...sesion, accessToken: "token-2" };
    vista.rerender(
      <MemoryRouter>
        <AccesosProvider>
          <Sonda />
        </AccesosProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(sonda()).toBe("cargado|4|menu.reportes"));

    get.mockResolvedValue({ userId: "A", version: 5, deshabilitadas: ["menu.reportes", "reportes.exportar"] });
    act(() => {
      avisarSiFuncionDeshabilitada(new ApiError("apagada", 403, "FUNCION_DESHABILITADA"));
    });
    await waitFor(() => expect(sonda()).toBe("cargado|5|menu.reportes,reportes.exportar"));
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("otro 403 (CSRF, permiso) no provoca una nueva consulta", async () => {
    get.mockResolvedValue({ userId: "A", version: 1, deshabilitadas: [] });
    montar();
    await waitFor(() => expect(sonda()).toBe("cargado|1|"));
    act(() => {
      avisarSiFuncionDeshabilitada(new ApiError("prohibido", 403, "FORBIDDEN"));
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("con el cambio obligatorio pendiente no se piden", async () => {
    sesion = { ...sesion, mustChangePassword: true };
    montar();
    await new Promise((r) => setTimeout(r, 0));
    expect(get).not.toHaveBeenCalled();
    expect(sonda()).toBe("sin-sesion|-1|");
  });

  it("descarta la respuesta tardía de OTRA cuenta", async () => {
    const tardia = diferida<unknown>();
    get.mockReturnValueOnce(tardia.promesa).mockResolvedValueOnce({ userId: "B", version: 1, deshabilitadas: [] });
    const vista = montar();
    sesion = { user: usuario("B"), accessToken: "token-B", mustChangePassword: false };
    vista.rerender(
      <MemoryRouter>
        <AccesosProvider>
          <Sonda />
        </AccesosProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(sonda()).toBe("cargado|1|"));
    await act(async () => tardia.resolver({ userId: "A", version: 9, deshabilitadas: ["menu.reportes"] }));
    expect(sonda(), "la de la cuenta A no se aplica a B").toBe("cargado|1|");
  });

  it("descarta la respuesta tardía de la sesión ANTERIOR de la misma cuenta y una versión vieja", async () => {
    const vieja = diferida<unknown>();
    get.mockReturnValueOnce(vieja.promesa).mockResolvedValueOnce({ userId: "A", version: 7, deshabilitadas: [] });
    const vista = montar();
    sesion = { ...sesion, accessToken: "token-2" };
    vista.rerender(
      <MemoryRouter>
        <AccesosProvider>
          <Sonda />
        </AccesosProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(sonda()).toBe("cargado|7|"));
    await act(async () => vieja.resolver({ userId: "A", version: 6, deshabilitadas: ["menu.reportes"] }));
    expect(sonda()).toBe("cargado|7|");

    // Una respuesta VIGENTE pero de versión anterior a la ya conocida tampoco pisa.
    get.mockResolvedValueOnce({ userId: "A", version: 6, deshabilitadas: ["menu.reportes"] });
    act(() => {
      avisarSiFuncionDeshabilitada(new ApiError("apagada", 403, "FUNCION_DESHABILITADA"));
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sonda()).toBe("cargado|7|");
  });

  it("un fallo de carga no oculta nada (decide el servidor) y se conserva lo último sabido", async () => {
    get.mockRejectedValueOnce(new ApiError("no disponible", 503, "CONFIGURACION_ACCESOS_NO_DISPONIBLE"));
    const vista = montar();
    await waitFor(() => expect(sonda()).toBe("error|-1|"));

    get.mockResolvedValueOnce({ userId: "A", version: 2, deshabilitadas: ["reportes.exportar"] });
    sesion = { ...sesion, accessToken: "token-2" };
    vista.rerender(
      <MemoryRouter>
        <AccesosProvider>
          <Sonda />
        </AccesosProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(sonda()).toBe("cargado|2|reportes.exportar"));
    get.mockRejectedValueOnce(new Error("red caída"));
    act(() => {
      avisarSiFuncionDeshabilitada(new ApiError("apagada", 403, "FUNCION_DESHABILITADA"));
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sonda()).toBe("cargado|2|reportes.exportar");
  });

  it("una respuesta con forma inválida se ignora", async () => {
    get.mockResolvedValue({ userId: "A", version: "x", deshabilitadas: "todo" });
    montar();
    await new Promise((r) => setTimeout(r, 0));
    expect(sonda()).toBe("cargando|-1|");
  });
});

/**
 * CONTEXTO DE AUTORIZACIÓN. Las restricciones cargadas pertenecen a la cuenta CON SUS ROLES
 * efectivos (y su club): si los roles cambian sin cambiar `userId`, lo cargado antes ya no
 * corresponde. Administración tiene prioridad siempre, con o sin datos.
 */
describe("cambio de roles de la misma cuenta", () => {
  const rerender = (vista: ReturnType<typeof render>, ui: React.ReactElement) =>
    vista.rerender(
      <MemoryRouter initialEntries={["/reportes"]}>
        <AccesosProvider>{ui}</AccesosProvider>
      </MemoryRouter>
    );

  function Pantalla() {
    return (
      <>
        <Sonda />
        <AppShell>
          <Routes>
            <Route element={<RequiereFuncion funciones={["menu.reportes"]} titulo="Reportes" />}>
              <Route path="/reportes" element={<p>pantalla de reportes</p>} />
            </Route>
          </Routes>
        </AppShell>
      </>
    );
  }

  it("delegado restringido que pasa a administración: conserva menús y URL mientras la consulta está pendiente y cuando falla", async () => {
    get.mockResolvedValueOnce({ userId: "A", version: 3, deshabilitadas: ["menu.reportes", "reportes.exportar"] });
    const vista = render(
      <MemoryRouter initialEntries={["/reportes"]}>
        <AccesosProvider>
          <Pantalla />
        </AccesosProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(sonda()).toBe("cargado|3|menu.reportes,reportes.exportar"));
    expect(screen.getByRole("alert")).toHaveTextContent("deshabilitada");

    // La misma cuenta recibe legítimamente administración (sesión actualizada, token nuevo).
    const pendiente = diferida<unknown>();
    get.mockReturnValueOnce(pendiente.promesa);
    sesion = { user: usuario("A", ["admin", "delegate"]), accessToken: "token-2", mustChangePassword: false };
    rerender(vista, <Pantalla />);

    expect(sonda(), "administración no hereda las restricciones del delegado").toMatch(/\|$/);
    expect(screen.getByRole("link", { name: "Reportes" })).toBeInTheDocument();
    expect(screen.getByText("pantalla de reportes")).toBeInTheDocument();

    await act(async () => pendiente.rechazar(new ApiError("no disponible", 503, "CONFIGURACION_ACCESOS_NO_DISPONIBLE")));
    expect(sonda()).toMatch(/\|$/);
    expect(screen.getByRole("link", { name: "Reportes" })).toBeInTheDocument();
    expect(screen.getByText("pantalla de reportes")).toBeInTheDocument();
  });

  it("una respuesta tardía del contexto anterior (delegado) no vuelve a aplicar sus restricciones", async () => {
    get.mockResolvedValueOnce({ userId: "A", version: 3, deshabilitadas: [] });
    const vista = render(
      <MemoryRouter initialEntries={["/reportes"]}>
        <AccesosProvider>
          <Pantalla />
        </AccesosProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(sonda()).toBe("cargado|3|"));

    // Una denegación dispara una consulta del contexto DELEGADO que queda en vuelo.
    const tardia = diferida<unknown>();
    get.mockReturnValueOnce(tardia.promesa);
    act(() => {
      avisarSiFuncionDeshabilitada(new ApiError("apagada", 403, "FUNCION_DESHABILITADA"));
    });

    // Cambian los roles sin cambiar `userId` ni el token: la sesión actualizada trae otros roles.
    const nueva = diferida<unknown>();
    get.mockReturnValueOnce(nueva.promesa);
    sesion = { ...sesion, user: usuario("A", ["admin", "delegate"]) };
    rerender(vista, <Pantalla />);

    await act(async () => tardia.resolver({ userId: "A", version: 4, deshabilitadas: ["menu.reportes"] }));
    expect(sonda()).toMatch(/\|$/);
    expect(screen.getByRole("link", { name: "Reportes" })).toBeInTheDocument();
    expect(screen.getByText("pantalla de reportes")).toBeInTheDocument();
    await act(async () => nueva.resolver({ userId: "A", version: 4, deshabilitadas: [] }));
    expect(sonda()).toBe("cargado|4|");
  });

  it("delegado que pasa a entrenador: no reutiliza lo del delegado; si la consulta falla queda sin datos (decide el servidor)", async () => {
    get.mockResolvedValueOnce({ userId: "A", version: 3, deshabilitadas: ["reportes.exportar"] });
    const vista = montar();
    await waitFor(() => expect(sonda()).toBe("cargado|3|reportes.exportar"));

    const pendiente = diferida<unknown>();
    get.mockReturnValueOnce(pendiente.promesa);
    sesion = { user: usuario("A", ["coach"]), accessToken: "token-2", mustChangePassword: false };
    vista.rerender(
      <MemoryRouter>
        <AccesosProvider>
          <Sonda />
        </AccesosProvider>
      </MemoryRouter>
    );
    expect(sonda()).toBe("cargando|-1|");
    await act(async () => pendiente.rechazar(new Error("red caída")));
    expect(sonda()).toBe("error|-1|");
  });

  it("administración tiene prioridad aunque una respuesta traiga funciones apagadas", async () => {
    sesion = { user: usuario("A", ["admin", "delegate"]), accessToken: "token-1", mustChangePassword: false };
    get.mockResolvedValue({ userId: "A", version: 2, deshabilitadas: ["menu.reportes", "cuenta.cambio_voluntario_contrasena"] });
    montar();
    await waitFor(() => expect(sonda()).toBe("cargado|2|"));
  });

  it("mismo contexto (renovación con los mismos roles): se conserva lo último sabido si la consulta falla", async () => {
    get.mockResolvedValueOnce({ userId: "A", version: 3, deshabilitadas: ["reportes.exportar"] });
    const vista = montar();
    await waitFor(() => expect(sonda()).toBe("cargado|3|reportes.exportar"));
    get.mockRejectedValueOnce(new Error("red caída"));
    sesion = { ...sesion, user: usuario("A", ["delegate"]), accessToken: "token-2" };
    vista.rerender(
      <MemoryRouter>
        <AccesosProvider>
          <Sonda />
        </AccesosProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(sonda()).toBe("cargado|3|reportes.exportar");
  });
});

describe("menús y rutas", () => {
  it("el menú y «Cambiar contraseña» se ocultan según las funciones; Cerrar sesión siempre está", async () => {
    get.mockResolvedValue({ userId: "A", version: 1, deshabilitadas: ["menu.reportes", "cuenta.cambio_voluntario_contrasena"] });
    montar(<AppShell>contenido</AppShell>);
    await waitFor(() => expect(screen.queryByRole("link", { name: "Reportes" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Inscripciones" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Cambiar contraseña" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeInTheDocument();
  });

  it("sin restricciones el menú es el de siempre, y administración no recibe botones nuevos de otros roles", async () => {
    get.mockResolvedValue({ userId: "A", version: 0, deshabilitadas: [] });
    montar(<AppShell>contenido</AppShell>);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: "Reportes" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cambiar contraseña" })).toBeInTheDocument();
    // Un delegado no ve la pantalla de administración de accesos.
    expect(screen.queryByRole("link", { name: "Accesos por rol" })).not.toBeInTheDocument();
  });

  it("una ruta apagada muestra el aviso también por URL directa (asistente)", async () => {
    get.mockResolvedValue({ userId: "A", version: 1, deshabilitadas: ["inscripciones.crear"] });
    render(
      <MemoryRouter initialEntries={["/inscripciones/nueva"]}>
        <AccesosProvider>
          <Routes>
            <Route element={<RequiereFuncion funciones={["menu.inscripciones", "inscripciones.crear"]} titulo="Nueva inscripción" />}>
              <Route path="/inscripciones/nueva" element={<p>asistente</p>} />
            </Route>
          </Routes>
        </AccesosProvider>
      </MemoryRouter>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Esta función está deshabilitada para su cuenta");
    expect(screen.queryByText("asistente")).not.toBeInTheDocument();
  });

  it("cambio voluntario apagado: aviso; con el cambio obligatorio la pantalla se muestra igual", async () => {
    get.mockResolvedValue({ userId: "A", version: 1, deshabilitadas: ["cuenta.cambio_voluntario_contrasena"] });
    const arbol = (
      <MemoryRouter initialEntries={["/cambiar-password"]}>
        <AccesosProvider>
          <Routes>
            <Route element={<CambioDeContrasenaPermitido />}>
              <Route path="/cambiar-password" element={<p>formulario de cambio</p>} />
            </Route>
          </Routes>
        </AccesosProvider>
      </MemoryRouter>
    );
    const vista = render(arbol);
    expect(await screen.findByRole("alert")).toHaveTextContent("deshabilitada");
    vista.unmount();

    sesion = { ...sesion, mustChangePassword: true };
    render(arbol);
    expect(screen.getByText("formulario de cambio")).toBeInTheDocument();
  });
});
