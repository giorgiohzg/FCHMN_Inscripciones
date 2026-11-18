/**
 * MENSAJE DEL LOGIN editable por administración (interfaz).
 *
 *  - El login lo lee SIN sesión, sin credenciales, y lo muestra como texto plano con sus saltos.
 *  - Ante cualquier fallo de esa lectura conserva el texto por defecto y se puede iniciar sesión.
 *  - La pantalla de administración valida vacío y largo, y guarda por la API administrativa.
 *
 * Todo es SIMULADO (fetch y API espiados); la persistencia y los permisos reales están en
 * `backend/tests/parametros-mensaje-login.integration.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const login = vi.fn();
vi.mock("./AuthContext", () => ({
  useAuth: () => ({ login, user: { username: "admin" }, logout: vi.fn(), hasRole: () => true }),
}));
vi.mock("../../shared/AvisosTerceros", () => ({ AvisosTerceros: () => null }));

const leer = vi.fn();
const guardar = vi.fn();
vi.mock("../../shared/apiClient", async () => {
  const real = await vi.importActual<typeof import("../../shared/apiClient")>("../../shared/apiClient");
  return { ...real, api: { ...real.api, get: (...a: unknown[]) => leer(...a), put: (...a: unknown[]) => guardar(...a) } };
});

import { LoginPage } from "./LoginPage";
import { MENSAJE_DE_ACCESO_POR_DEFECTO, leerMensajeDeAcceso } from "./mensajeDeAcceso";
import { MensajeDeAccesoPage } from "../accesos/MensajeDeAccesoPage";

const fetchOriginal = globalThis.fetch;
let fetchFalso: ReturnType<typeof vi.fn>;

function respuesta(cuerpo: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(cuerpo), { status, headers: { "Content-Type": "application/json" } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchFalso = vi.fn();
  vi.stubGlobal("fetch", fetchFalso);
});
afterEach(() => {
  vi.stubGlobal("fetch", fetchOriginal);
});

function montarLogin() {
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>
  );
}

const mensaje = () => screen.getByTestId("mensaje-de-acceso");

describe("login: lectura pública del mensaje", () => {
  it("el texto por defecto es el mensaje vigente completo, con la pregunta inicial", () => {
    expect(MENSAJE_DE_ACCESO_POR_DEFECTO.startsWith("¿Olvidó su contraseña? Solicite a un administrador de la Federación")).toBe(true);
    expect(MENSAJE_DE_ACCESO_POR_DEFECTO.endsWith("el sistema le pedirá definir una nueva al ingresar.")).toBe(true);
  });

  it("muestra el texto guardado, con saltos de línea y SIN interpretar HTML", async () => {
    fetchFalso.mockReturnValue(respuesta({ texto: "Línea uno\nLínea <b>dos</b>" }));
    montarLogin();
    await waitFor(() => expect(mensaje().textContent).toBe("Línea uno\nLínea <b>dos</b>"));
    expect(mensaje().querySelector("b")).toBeNull();
    expect(mensaje().style.whiteSpace).toBe("pre-line");
  });

  it("pide la ruta pública sin credenciales ni cabecera de autorización", async () => {
    fetchFalso.mockReturnValue(respuesta({ texto: "Hola" }));
    montarLogin();
    await waitFor(() => expect(fetchFalso).toHaveBeenCalledTimes(1));
    const [url, init] = fetchFalso.mock.calls[0]! as [string, RequestInit];
    expect(url).toMatch(/\/mensaje-de-acceso$/);
    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  it.each([
    ["un error de red", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["un 500", () => respuesta({ error: "INTERNAL" }, 500)],
    ["un cuerpo inesperado", () => respuesta({ otro: 1 })],
    ["un texto vacío", () => respuesta({ texto: "   " })],
  ])("ante %s conserva el texto por defecto y se puede iniciar sesión", async (_caso, falla) => {
    fetchFalso.mockImplementation(falla);
    login.mockResolvedValue({ mustChangePassword: false });
    montarLogin();
    await waitFor(() => expect(fetchFalso).toHaveBeenCalled());
    expect(mensaje().textContent).toBe(MENSAJE_DE_ACCESO_POR_DEFECTO);

    fireEvent.change(screen.getByLabelText("Nombre de usuario"), { target: { value: "usuario.sintetico" } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "clave-sintetica" } });
    fireEvent.click(screen.getByRole("button", { name: "Ingresar" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("usuario.sintetico", "clave-sintetica"));
  });

  it("leerMensajeDeAcceso devuelve null ante cualquier fallo, nunca lanza", async () => {
    fetchFalso.mockRejectedValue(new Error("caída"));
    await expect(leerMensajeDeAcceso()).resolves.toBeNull();
  });
});

describe("pantalla de administración del mensaje", () => {
  const estado = { texto: "Mensaje actual", porDefecto: false, textoPorDefecto: MENSAJE_DE_ACCESO_POR_DEFECTO, maximo: 20, actualizadoEn: null };

  function montarPantalla() {
    render(
      <MemoryRouter>
        <MensajeDeAccesoPage />
      </MemoryRouter>
    );
  }

  it("carga el texto vigente y lo guarda por la ruta administrativa", async () => {
    leer.mockResolvedValue(estado);
    guardar.mockResolvedValue({ mensaje: { ...estado, texto: "Nuevo\ntexto" }, cambio: true });
    montarPantalla();
    const campo = (await screen.findByLabelText("Mensaje")) as HTMLTextAreaElement;
    expect(leer).toHaveBeenCalledWith("/administracion/mensaje-de-acceso");
    expect(campo.value).toBe("Mensaje actual");

    fireEvent.change(campo, { target: { value: "Nuevo\ntexto" } });
    expect(screen.getByTestId("vista-previa-mensaje").textContent).toBe("Nuevo\ntexto");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(guardar).toHaveBeenCalledWith("/administracion/mensaje-de-acceso", { texto: "Nuevo\ntexto" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Mensaje guardado/);
  });

  it("no permite guardar un mensaje vacío ni uno que supera el máximo", async () => {
    leer.mockResolvedValue(estado);
    montarPantalla();
    const campo = await screen.findByLabelText("Mensaje");
    const boton = () => screen.getByRole("button", { name: "Guardar" });

    fireEvent.change(campo, { target: { value: "   " } });
    expect(boton()).toBeDisabled();
    expect(screen.getByText("El mensaje no puede quedar vacío.")).toBeInTheDocument();

    fireEvent.change(campo, { target: { value: "x".repeat(21) } });
    expect(boton()).toBeDisabled();
    expect(screen.getByText("El mensaje no puede superar los 20 caracteres.")).toBeInTheDocument();

    fireEvent.change(campo, { target: { value: "x".repeat(20) } });
    expect(boton()).toBeEnabled();
    expect(guardar).not.toHaveBeenCalled();
  });

  it("durante el guardado el texto no se puede modificar y la respuesta no borra nada escrito después", async () => {
    leer.mockResolvedValue(estado);
    let responder!: (v: unknown) => void;
    guardar.mockImplementation(() => new Promise((r) => (responder = r)));
    montarPantalla();
    const campo = (await screen.findByLabelText("Mensaje")) as HTMLTextAreaElement;
    fireEvent.change(campo, { target: { value: "Primero" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(guardar).toHaveBeenCalledTimes(1));

    // Mientras espera: campo bloqueado; un intento de escribir no cambia ni el texto ni la vista previa.
    expect(campo).toBeDisabled();
    expect(screen.getByRole("button", { name: "Guardando..." })).toBeDisabled();
    fireEvent.change(campo, { target: { value: "Escrito durante el guardado" } });
    expect(screen.getByTestId("vista-previa-mensaje").textContent).toBe("Primero");

    responder({ mensaje: { ...estado, texto: "Primero" }, cambio: true });
    expect(await screen.findByRole("status")).toHaveTextContent(/Mensaje guardado/);
    expect(campo).toBeEnabled();
    expect(campo.value).toBe("Primero");
    expect(screen.getByTestId("vista-previa-mensaje").textContent).toBe("Primero");
    // Nada pendiente: lo que se ve es lo guardado.
    expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Descartar cambios" })).toBeDisabled();
  });

  it("si el guardado falla, conserva lo escrito, vuelve a habilitar el campo y permite reintentar", async () => {
    leer.mockResolvedValue(estado);
    guardar.mockRejectedValueOnce(new Error("Sin conexión sintética")).mockResolvedValueOnce({ mensaje: { ...estado, texto: "Reintento" }, cambio: true });
    montarPantalla();
    const campo = (await screen.findByLabelText("Mensaje")) as HTMLTextAreaElement;
    fireEvent.change(campo, { target: { value: "Reintento" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sin conexión sintética");
    expect(campo).toBeEnabled();
    expect(campo.value).toBe("Reintento");
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Mensaje guardado/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(guardar).toHaveBeenCalledTimes(2);
  });

  it("muestra el error del servidor si no se pudo guardar", async () => {
    leer.mockResolvedValue(estado);
    guardar.mockRejectedValue(new Error("Requiere uno de los siguientes roles: admin"));
    montarPantalla();
    fireEvent.change(await screen.findByLabelText("Mensaje"), { target: { value: "Otro" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Requiere uno de los siguientes roles: admin");
  });
});
