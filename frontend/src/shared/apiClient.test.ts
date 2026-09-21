/**
 * Fase 6, hallazgo 27 — cliente HTTP único, con renovación ante 401.
 *
 * Antes había doce clientes con su propia copia de la URL base, del manejo de
 * respuesta y del `Authorization`, y NINGUNO miraba el 401: un token vencido
 * —cada quince minutos— dejaba un error suelto en la pantalla donde el usuario
 * estuviera.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { apiFetch, conectarSesion, ApiError, API_BASE } from "./apiClient";

/** Respuesta mínima con la forma que espera el cliente. */
function respuesta(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob(),
    headers: new Headers(),
  } as unknown as Response;
}

let fetchSpy: ReturnType<typeof vi.fn>;
let renovar: Mock<[], Promise<string | null>>;
let cerrar: Mock<[], void>;
let token: string | null;

/** Cabecera Authorization de la n-ésima llamada a fetch. */
function autorizacionDe(n: number): string | null {
  const init = fetchSpy.mock.calls[n]![1] as RequestInit;
  return new Headers(init.headers).get("Authorization");
}

beforeEach(() => {
  token = "token-viejo";
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  renovar = vi.fn(async (): Promise<string | null> => {
    token = "token-nuevo";
    return token;
  });
  cerrar = vi.fn();

  conectarSesion({ obtenerAccessToken: () => token, renovar, cerrarPorSesionInvalida: cerrar });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("forma de la petición", () => {
  it("antepone la URL base y adjunta el token vigente", async () => {
    fetchSpy.mockResolvedValue(respuesta(200, { ok: true }));

    await apiFetch("/clubs");

    expect(fetchSpy.mock.calls[0]![0]).toBe(`${API_BASE}/clubs`);
    expect(autorizacionDe(0)).toBe("Bearer token-viejo");
  });

  /**
   * Sin `credentials: "include"` el navegador NO manda la cookie HttpOnly del
   * refresh token, y la sesión no puede renovarse ni sobrevivir a una recarga.
   */
  it("envía las cookies (credentials: include)", async () => {
    fetchSpy.mockResolvedValue(respuesta(200));

    await apiFetch("/clubs");

    expect((fetchSpy.mock.calls[0]![1] as RequestInit).credentials).toBe("include");
  });

  it("un 204 no intenta interpretar JSON", async () => {
    fetchSpy.mockResolvedValue(respuesta(204));

    await expect(apiFetch("/clubs/1")).resolves.toBeUndefined();
  });

  it("traduce el error del backend a un mensaje legible", async () => {
    fetchSpy.mockResolvedValue(respuesta(409, { message: "Ya existe un club con ese nombre" }));

    await expect(apiFetch("/clubs")).rejects.toThrow(/Ya existe un club/);
    await expect(apiFetch("/clubs")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("renovación ante un 401", () => {
  it("renueva UNA vez y reintenta UNA vez, con el token nuevo", async () => {
    fetchSpy.mockResolvedValueOnce(respuesta(401)).mockResolvedValueOnce(respuesta(200, { items: [] }));

    const resultado = await apiFetch<{ items: unknown[] }>("/clubs");

    expect(renovar).toHaveBeenCalledTimes(1);
    expect(fetchSpy, "una petición original + un reintento").toHaveBeenCalledTimes(2);
    expect(autorizacionDe(1), "el reintento debe llevar el token NUEVO").toBe("Bearer token-nuevo");
    expect(resultado).toEqual({ items: [] });
  });

  it("si el reintento vuelve a dar 401, se rinde y cierra la sesión", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));

    await expect(apiFetch("/clubs")).rejects.toThrow(/sesión expiró/i);

    expect(renovar, "como máximo una renovación").toHaveBeenCalledTimes(1);
    expect(fetchSpy, "como máximo un reintento: insistir sería un bucle").toHaveBeenCalledTimes(2);
    expect(cerrar).toHaveBeenCalledTimes(1);
  });

  it("si la renovación no devuelve token, no reintenta y cierra la sesión", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    renovar.mockResolvedValue(null);

    await expect(apiFetch("/clubs")).rejects.toThrow(/sesión expiró/i);

    expect(fetchSpy, "sin token nuevo no hay nada que reintentar").toHaveBeenCalledTimes(1);
    expect(cerrar).toHaveBeenCalledTimes(1);
  });

  it("un 403 NO dispara renovación: es falta de permisos, no de sesión", async () => {
    fetchSpy.mockResolvedValue(respuesta(403, { message: "No autorizado" }));

    await expect(apiFetch("/clubs")).rejects.toThrow(/No autorizado/);

    expect(renovar).not.toHaveBeenCalled();
    expect(cerrar).not.toHaveBeenCalled();
  });

  it("un 500 tampoco", async () => {
    fetchSpy.mockResolvedValue(respuesta(500, { message: "Error interno" }));

    await expect(apiFetch("/clubs")).rejects.toThrow();
    expect(renovar).not.toHaveBeenCalled();
  });
});

/**
 * Las tres rutas de sesión quedan fuera del bucle automático. Sin esto,
 * `/auth/refresh` se llamaría a sí mismo ante su propio 401 —recursión— y un
 * login con credenciales incorrectas se reintentaría, acercando el bloqueo de
 * cuenta por RB-15.
 */
describe("rutas excluidas del bucle automático", () => {
  it.each(["/auth/login", "/auth/refresh", "/auth/logout"])("%s no renueva ante un 401", async (ruta) => {
    fetchSpy.mockResolvedValue(respuesta(401, { message: "Credenciales inválidas" }));

    await expect(apiFetch(ruta, { method: "POST" })).rejects.toThrow(/Credenciales inválidas/);

    expect(renovar, `${ruta} no debe entrar al bucle`).not.toHaveBeenCalled();
    expect(fetchSpy, "una sola petición, sin reintento").toHaveBeenCalledTimes(1);
  });

  it("el error de login llega tal cual, no convertido en 'sesión expirada'", async () => {
    fetchSpy.mockResolvedValue(respuesta(401, { message: "Usuario o contraseña incorrectos" }));

    // Es lo que ve el usuario al equivocarse: debe decir qué pasó.
    await expect(apiFetch("/auth/login", { method: "POST" })).rejects.toThrow(/Usuario o contraseña incorrectos/);
  });
});

describe("cabeceras", () => {
  it("pone Content-Type JSON cuando hay cuerpo", async () => {
    fetchSpy.mockResolvedValue(respuesta(200));

    await apiFetch("/clubs", { method: "POST", body: JSON.stringify({ name: "Club" }) });

    expect(new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers).get("Content-Type")).toBe("application/json");
  });

  it("NO lo pone con FormData: el navegador debe fijar su propio boundary", async () => {
    fetchSpy.mockResolvedValue(respuesta(200));
    const form = new FormData();
    form.append("file", new Blob(["x"]), "a.xlsx");

    await apiFetch("/persons/bulk-import", { method: "POST", body: form });

    // Fijarlo a mano rompe la subida: el servidor no encuentra el separador.
    expect(new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers).get("Content-Type")).toBeNull();
  });

  it("sin sesión no manda Authorization", async () => {
    token = null;
    fetchSpy.mockResolvedValue(respuesta(200));

    await apiFetch("/auth/login", { method: "POST" });

    expect(autorizacionDe(0)).toBeNull();
  });
});
