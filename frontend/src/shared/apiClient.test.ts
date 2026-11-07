/**
 * Fase 6, hallazgo 27 — cliente HTTP único, con renovación ante 401.
 *
 * Antes había doce clientes con su propia copia de la URL base, del manejo de
 * respuesta y del `Authorization`, y NINGUNO miraba el 401: un token vencido
 * —cada quince minutos— dejaba un error suelto en la pantalla donde el usuario
 * estuviera.
 *
 * A1 — un 401 ATRASADO no puede afectar a la sesión que ya reemplazó a la que lo
 * provocó. Las pruebas de la segunda mitad del archivo usan un puente de sesión
 * SIMULADO: comprueban lo que el cliente HTTP hace con cada desenlace; que el
 * puente real los produzca bien se comprueba en `sesionAtrasada.test.tsx`.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import {
  apiFetch,
  apiFetchArchivo,
  conectarSesion,
  esMismaSesion,
  ApiError,
  SesionCambiadaError,
  API_BASE,
  type IdentidadDeSesion,
  type RenovacionParaElCliente,
} from "./apiClient";

/** Respuesta mínima con la forma que espera el cliente. */
function respuesta(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob(["contenido"]),
    headers: new Headers({ "Content-Disposition": 'attachment; filename="informe.xlsx"' }),
  } as unknown as Response;
}

/** Promesa que resolvemos nosotros, para dejar una respuesta "en vuelo". */
function diferida<T>() {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((r) => (resolver = r));
  return { promesa, resolver };
}

const SESION_A: IdentidadDeSesion = { ciclo: "ciclo-A", userId: "uA" };
const SESION_B: IdentidadDeSesion = { ciclo: "ciclo-B", userId: "uB" };

let fetchSpy: ReturnType<typeof vi.fn>;
let renovar: Mock<(identidad: IdentidadDeSesion) => Promise<RenovacionParaElCliente>>;
let cerrar: Mock<(identidad: IdentidadDeSesion) => Promise<boolean>>;
let token: string | null;
/** La identidad "vigente" del puente simulado; las pruebas la cambian a mano. */
let identidad: IdentidadDeSesion;

/** Cabecera Authorization de la n-ésima llamada a fetch. */
function autorizacionDe(n: number): string | null {
  const init = fetchSpy.mock.calls[n]![1] as RequestInit;
  return new Headers(init.headers).get("Authorization");
}

beforeEach(() => {
  token = "token-viejo";
  identidad = SESION_A;
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  renovar = vi.fn(async (_identidad: IdentidadDeSesion): Promise<RenovacionParaElCliente> => {
    token = "token-nuevo";
    return { tipo: "renovada", accessToken: token };
  });
  cerrar = vi.fn(async (_identidad: IdentidadDeSesion): Promise<boolean> => true);

  conectarSesion({
    // Token e identidad se leen juntos, como hace el puente real.
    obtenerSesion: () => ({ accessToken: token, identidad }),
    renovar,
    cerrarPorSesionInvalida: cerrar,
  });
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
    expect(cerrar, "cierra la sesión que envió la petición").toHaveBeenCalledWith(SESION_A);
  });

  it("si el servidor confirma que la sesión no vale, no reintenta y la cierra", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    renovar.mockResolvedValue({ tipo: "invalida" });

    await expect(apiFetch("/clubs")).rejects.toThrow(/sesión expiró/i);

    expect(fetchSpy, "sin token nuevo no hay nada que reintentar").toHaveBeenCalledTimes(1);
    expect(cerrar).toHaveBeenCalledTimes(1);
    expect(cerrar).toHaveBeenCalledWith(SESION_A);
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

  it("un fallo TRANSITORIO de la renovación no cierra la sesión", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    renovar.mockRejectedValue(new Error("red caída"));

    await expect(apiFetch("/clubs")).rejects.toMatchObject({ status: 503 });

    expect(fetchSpy, "no hay reintento sin renovación").toHaveBeenCalledTimes(1);
    expect(cerrar, "no se sabe nada de la sesión: no se la expulsa").not.toHaveBeenCalled();
  });
});

/**
 * Las rutas de sesión quedan fuera del bucle automático. Sin esto,
 * `/auth/refresh` se llamaría a sí mismo ante su propio 401 —recursión— y un
 * login con credenciales incorrectas se reintentaría, acercando el bloqueo de
 * cuenta por RB-15.
 *
 * `/auth/csrf` y `/auth/change-password` se llaman DENTRO del cerrojo de sesión:
 * un 401 ahí que entrara al bucle pediría de nuevo ese cerrojo, que no es
 * reentrante, y la operación se esperaría a sí misma.
 */
describe("rutas excluidas del bucle automático", () => {
  it.each(["/auth/login", "/auth/refresh", "/auth/logout", "/auth/change-password", "/auth/csrf"])(
    "%s no renueva ante un 401",
    async (ruta) => {
      fetchSpy.mockResolvedValue(respuesta(401, { message: "Credenciales inválidas" }));

      await expect(apiFetch(ruta, { method: "POST" })).rejects.toThrow(/Credenciales inválidas/);

      expect(renovar, `${ruta} no debe entrar al bucle`).not.toHaveBeenCalled();
      expect(cerrar, `${ruta} tampoco cierra la sesión`).not.toHaveBeenCalled();
      expect(fetchSpy, "una sola petición, sin reintento").toHaveBeenCalledTimes(1);
    }
  );

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

/**
 * A1 — IDENTIDAD DE LA SESIÓN QUE ENVIÓ LA PETICIÓN.
 *
 * Un 401 puede llegar mucho después de que la sesión que lo provocó fue
 * reemplazada (otra cuenta entró, o la misma volvió a iniciar sesión). Lo que
 * importa entonces es ese 401 NO toque a la sesión nueva: ni repetir la operación
 * con sus credenciales, ni cerrarla.
 */
describe("A1 — un 401 atrasado no afecta a la sesión que ya reemplazó a la suya", () => {
  it("SesionCambiadaError es un ApiError pero NO lleva 401: ese código cierra sesiones", () => {
    const error = new SesionCambiadaError();

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).not.toBe(401);
    expect(error.message).toMatch(/sesión cambió/i);
  });

  it("la renovación recibe la identidad capturada al ENVIAR, no la que haya al responder", async () => {
    const enVuelo = diferida<Response>();
    fetchSpy.mockReturnValueOnce(enVuelo.promesa);
    renovar.mockResolvedValue({ tipo: "cambiada" });

    const pendiente = apiFetch("/clubs", { method: "POST", body: "{}" });
    pendiente.catch(() => undefined);

    // Mientras la petición viaja, entra otra cuenta.
    identidad = SESION_B;
    token = "token-de-B";
    enVuelo.resolver(respuesta(401));

    await expect(pendiente).rejects.toBeInstanceOf(SesionCambiadaError);
    expect(renovar).toHaveBeenCalledTimes(1);
    expect(renovar, "se pregunta por la sesión A, que es la que envió").toHaveBeenCalledWith(SESION_A);
  });

  it("`cambiada`: no se repite la operación, ni siquiera una ESCRITURA, y no se cierra nada", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    // Cuando se consulta la renovación, la sesión actual ya es la de B.
    renovar.mockImplementation(async () => {
      identidad = SESION_B;
      token = "token-de-B";
      return { tipo: "cambiada" };
    });

    await expect(apiFetch("/competitions", { method: "POST", body: JSON.stringify({ name: "Copa" }) })).rejects.toBeInstanceOf(
      SesionCambiadaError
    );

    expect(fetchSpy, "la escritura salió UNA vez y no se reenvía con credenciales ajenas").toHaveBeenCalledTimes(1);
    expect(autorizacionDe(0), "y esa vez fue con el token de A").toBe("Bearer token-viejo");
    expect(cerrar, "la sesión actual (B) no se toca").not.toHaveBeenCalled();
  });

  it("el reintento usa el token que entrega la renovación, NO el que haya en ese momento", async () => {
    fetchSpy.mockResolvedValueOnce(respuesta(401)).mockResolvedValueOnce(respuesta(200, { ok: true }));
    renovar.mockImplementation(async () => {
      // Entre medias el estado actual pasó a ser otro; el puente entrega el de A.
      token = "token-actual-ajeno";
      return { tipo: "renovada", accessToken: "token-renovado-de-A" };
    });

    await apiFetch("/clubs");

    expect(autorizacionDe(1)).toBe("Bearer token-renovado-de-A");
  });

  it("`invalida` pero la sesión ya es otra: no se cierra y se avisa del cambio, no de expiración", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    renovar.mockResolvedValue({ tipo: "invalida" });
    // El cierre condicional comprueba y descubre que ya hay otra sesión.
    cerrar.mockResolvedValue(false);

    const error = await apiFetch("/clubs").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SesionCambiadaError);
    expect((error as Error).message, "no debe decir que la sesión expiró").not.toMatch(/expir/i);
    expect(cerrar).toHaveBeenCalledWith(SESION_A);
    expect(fetchSpy, "sin repetición").toHaveBeenCalledTimes(1);
  });

  it("el 401 del REINTENTO también es atrasado: si la sesión cambió, no la cierra", async () => {
    const reintento = diferida<Response>();
    fetchSpy.mockResolvedValueOnce(respuesta(401)).mockReturnValueOnce(reintento.promesa);
    cerrar.mockResolvedValue(false);

    const pendiente = apiFetch("/clubs", { method: "POST", body: "{}" });
    pendiente.catch(() => undefined);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    // Entra otra cuenta mientras el reintento viaja; después llega SU 401.
    identidad = SESION_B;
    reintento.resolver(respuesta(401));

    await expect(pendiente).rejects.toBeInstanceOf(SesionCambiadaError);
    expect(cerrar, "se intenta cerrar la sesión A, y el puente se niega: ya no es la vigente").toHaveBeenCalledWith(SESION_A);
    expect(fetchSpy, "un reintento como máximo").toHaveBeenCalledTimes(2);
    expect(renovar, "y una sola renovación").toHaveBeenCalledTimes(1);
  });

  it("si el reintento sí corresponde a la misma sesión y vuelve a dar 401, la cierra (sin bucle)", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    cerrar.mockResolvedValue(true);

    await expect(apiFetch("/clubs")).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/sesión expiró/i) });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(renovar).toHaveBeenCalledTimes(1);
    expect(cerrar).toHaveBeenCalledTimes(1);
  });

  describe("esMismaSesion", () => {
    it("mismo ciclo y mismo usuario", () => {
      expect(esMismaSesion(SESION_A, { ...SESION_A })).toBe(true);
    });

    it("otro ciclo NO es la misma sesión, aunque sea el mismo usuario (un login nuevo)", () => {
      expect(esMismaSesion(SESION_A, { ciclo: "ciclo-A2", userId: "uA" })).toBe(false);
    });

    it("mismo ciclo pero otro usuario: tampoco", () => {
      expect(esMismaSesion(SESION_A, { ciclo: "ciclo-A", userId: "uB" })).toBe(false);
    });

    it("una petición que salió SIN sesión puede completarse en el mismo ciclo (la restauración)", () => {
      expect(esMismaSesion({ ciclo: "ciclo-A", userId: null }, SESION_A)).toBe(true);
      // …pero no en otro ciclo.
      expect(esMismaSesion({ ciclo: "ciclo-A", userId: null }, SESION_B)).toBe(false);
    });

    it("lo contrario no vale: con usuario conocido, perder la sesión es un cambio", () => {
      expect(esMismaSesion(SESION_A, { ciclo: "ciclo-A", userId: null })).toBe(false);
    });
  });
});

describe("A1 — descargas (apiFetchArchivo)", () => {
  it("renueva una vez y reintenta una vez con el token de la renovación", async () => {
    fetchSpy.mockResolvedValueOnce(respuesta(401)).mockResolvedValueOnce(respuesta(200));

    const { filename } = await apiFetchArchivo("/export/team-manager/zip", "por-omision.zip");

    expect(filename).toBe("informe.xlsx");
    expect(renovar).toHaveBeenCalledWith(SESION_A);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(autorizacionDe(1)).toBe("Bearer token-nuevo");
  });

  it("`cambiada`: la descarga no se repite con credenciales de otra sesión ni cierra nada", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    renovar.mockResolvedValue({ tipo: "cambiada" });

    await expect(apiFetchArchivo("/reports/x", "x.xlsx")).rejects.toBeInstanceOf(SesionCambiadaError);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cerrar).not.toHaveBeenCalled();
  });

  it("el 401 del reintento con la sesión ya cambiada no la cierra", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    cerrar.mockResolvedValue(false);

    await expect(apiFetchArchivo("/reports/x", "x.xlsx")).rejects.toBeInstanceOf(SesionCambiadaError);

    expect(fetchSpy, "un reintento como máximo").toHaveBeenCalledTimes(2);
    expect(cerrar).toHaveBeenCalledWith(SESION_A);
  });

  it("sesión realmente inválida: cierra y dice que expiró", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    renovar.mockResolvedValue({ tipo: "invalida" });

    await expect(apiFetchArchivo("/reports/x", "x.xlsx")).rejects.toMatchObject({ status: 401 });

    expect(cerrar).toHaveBeenCalledWith(SESION_A);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * A1 (corrección) — la sesión se vuelve a comprobar JUSTO ANTES del reintento.
 *
 * `renovar` responde `renovada` describiendo la sesión en el momento en que
 * respondió. Para cuando el reintento sale pudo cambiar la sesión; el cliente
 * lo comprueba por su cuenta, sin fiarse de esa respuesta. El puente simulado
 * cambia la sesión DENTRO de `renovar`, justo antes de devolver `renovada`:
 * es la barrera determinista entre «la renovación se resolvió» y «sale la
 * segunda petición».
 */
describe("A1 (corrección) — recomprobación inmediatamente antes del reintento", () => {
  /** La renovación termina bien… y la sesión cambia antes de que el cliente reintente. */
  function renovarYCambiarDeSesion(nueva: IdentidadDeSesion) {
    renovar.mockImplementation(async () => {
      identidad = nueva;
      token = "token-de-la-sesion-nueva";
      return { tipo: "renovada", accessToken: "token-renovado-de-A" };
    });
  }

  it("ESCRITURA: no sale una segunda petición, y la sesión posterior no se cierra", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    renovarYCambiarDeSesion(SESION_B);

    await expect(
      apiFetch("/competitions", { method: "POST", body: JSON.stringify({ name: "Copa" }) })
    ).rejects.toBeInstanceOf(SesionCambiadaError);

    expect(fetchSpy, "la escritura salió UNA vez; el reintento se canceló").toHaveBeenCalledTimes(1);
    expect(autorizacionDe(0)).toBe("Bearer token-viejo");
    expect(cerrar, "no se cierra la sesión posterior").not.toHaveBeenCalled();
    expect(renovar, "ni se vuelve a renovar").toHaveBeenCalledTimes(1);
  });

  it("DESCARGA: tampoco sale la segunda petición", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    renovarYCambiarDeSesion(SESION_B);

    await expect(apiFetchArchivo("/export/team-manager/zip", "x.zip")).rejects.toBeInstanceOf(SesionCambiadaError);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cerrar).not.toHaveBeenCalled();
  });

  it("el MISMO usuario con otro ciclo (otro login) también la cancela: el token no es la identidad", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    renovarYCambiarDeSesion({ ciclo: "ciclo-A2", userId: "uA" });

    await expect(apiFetch("/clubs", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(SesionCambiadaError);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("otro usuario en el MISMO ciclo la cancela igualmente", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    renovarYCambiarDeSesion({ ciclo: SESION_A.ciclo, userId: "uB" });

    await expect(apiFetch("/clubs", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(SesionCambiadaError);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("se perdió la sesión (usuario conocido → ninguno): cancela, no reintenta sin credenciales", async () => {
    fetchSpy.mockResolvedValue(respuesta(401));
    renovarYCambiarDeSesion({ ciclo: SESION_A.ciclo, userId: null });

    await expect(apiFetch("/clubs")).rejects.toBeInstanceOf(SesionCambiadaError);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("contraste: la misma sesión con el token renovado SÍ reintenta, con ESE token", async () => {
    fetchSpy.mockResolvedValueOnce(respuesta(401)).mockResolvedValueOnce(respuesta(200, { ok: true }));
    renovar.mockImplementation(async () => ({ tipo: "renovada", accessToken: "token-renovado-de-A" }));

    await expect(apiFetch("/clubs", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(autorizacionDe(1)).toBe("Bearer token-renovado-de-A");
  });

  it("restauración legítima: salió SIN sesión y la renovación la completa en el mismo ciclo", async () => {
    token = null;
    identidad = { ciclo: SESION_A.ciclo, userId: null };
    fetchSpy.mockResolvedValueOnce(respuesta(401)).mockResolvedValueOnce(respuesta(200, { ok: true }));
    renovar.mockImplementation(async () => {
      // La restauración deja a A en la sesión, en el mismo ciclo.
      identidad = SESION_A;
      token = "token-restaurado";
      return { tipo: "renovada", accessToken: "token-restaurado" };
    });

    await expect(apiFetch("/clubs")).resolves.toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(autorizacionDe(0), "la primera salió sin credenciales").toBeNull();
    expect(autorizacionDe(1)).toBe("Bearer token-restaurado");
  });

  it("…pero no vale para otro ciclo: salió sin sesión y ahora hay una sesión de otro ciclo", async () => {
    token = null;
    identidad = { ciclo: SESION_A.ciclo, userId: null };
    fetchSpy.mockResolvedValue(respuesta(401));
    renovar.mockImplementation(async () => {
      identidad = SESION_B;
      return { tipo: "renovada", accessToken: "token-de-B" };
    });

    await expect(apiFetch("/clubs", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(SesionCambiadaError);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
