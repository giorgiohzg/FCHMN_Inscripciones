import { extractApiErrorMessage } from "./apiError";
import { tokenCsrfActual } from "../modules/auth/csrf";

/**
 * CLIENTE HTTP ÚNICO.
 *
 * Antes había doce archivos `*Api.ts`, cada uno con su propia constante
 * `API_BASE`, su propia función de manejo de respuesta y el `Authorization`
 * escrito a mano en cada llamada. Ninguno miraba el 401: un token de acceso
 * vencido —cosa que pasa cada quince minutos— producía un error suelto en la
 * pantalla en la que el usuario estuviera, y no había forma de añadir la
 * renovación automática sin repetirla doce veces.
 *
 * Aquí vive todo eso una sola vez: URL base, cabeceras, envío de cookies,
 * traducción de errores y la renovación coordinada ante un 401.
 */

export const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

/**
 * Rutas EXCLUIDAS del bucle automático.
 *
 * Reintentar un 401 de estas tres no tiene sentido y sí tiene consecuencias:
 *   - `/auth/login`: un 401 significa credenciales incorrectas; renovar no
 *     arregla nada y reintentar duplicaría el intento fallido, acercando el
 *     bloqueo de cuenta por RB-15.
 *   - `/auth/refresh`: es la renovación misma. Renovar ante su propio fallo es
 *     una recursión infinita.
 *   - `/auth/logout`: cerrar sesión no necesita una sesión válida.
 *   - `/auth/change-password`: se ejecuta DENTRO del cerrojo de sesión, y la
 *     renovación pediría ese mismo cerrojo —que no es reentrante—, quedando a
 *     la espera de quien la invocó. Era un interbloqueo real. Su 401 lo maneja
 *     `AuthContext.changePassword`, que renueva sin volver a pedir el cerrojo
 *     y reintenta una vez.
 */
const RUTAS_SIN_RENOVACION = ["/auth/login", "/auth/refresh", "/auth/logout", "/auth/change-password"];

/** Estado de sesión que el cliente necesita; lo inyecta el AuthContext. */
export interface PuenteDeSesion {
  /** Token de acceso VIGENTE, o null. Vive en memoria, nunca en disco. */
  obtenerAccessToken(): string | null;
  /** Renueva la sesión. Devuelve el nuevo access token, o null si ya no hay sesión. */
  renovar(): Promise<string | null>;
  /** La sesión terminó definitivamente: limpiar y mandar al login. */
  cerrarPorSesionInvalida(): void;
}

let puente: PuenteDeSesion | null = null;

/** Lo llama `AuthProvider` al montarse. */
export function conectarSesion(p: PuenteDeSesion): void {
  puente = p;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function interpretar<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(extractApiErrorMessage(body, `Error ${res.status}`), res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

function construirCabeceras(init: RequestInit, accessToken: string | null): Headers {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  // `FormData` fija su propio Content-Type con el boundary: ponerlo a mano lo
  // rompería.
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  /**
   * El token CSRF viene de MEMORIA, no de `document.cookie`.
   *
   * La cookie que lo respalda es `HttpOnly`, pertenece al host de la API y va
   * con `Path=/auth`: el JavaScript de la web no puede leerla en ninguno de los
   * escenarios en que la comprobación se activa. El valor llega por el cuerpo
   * de las respuestas de sesión (ver `modules/auth/csrf.ts`).
   */
  const csrf = tokenCsrfActual();
  if (csrf) headers.set("X-CSRF-Token", csrf);
  return headers;
}

async function enviar(path: string, init: RequestInit, accessToken: string | null): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: construirCabeceras(init, accessToken),
    /**
     * Sin esto la cookie `HttpOnly` del refresh token no viaja y la sesión no
     * puede renovarse. Es obligatorio desde que el token dejó de ir en el
     * cuerpo de la respuesta.
     */
    credentials: "include",
  });
}

/**
 * Petición a la API, con renovación automática ante un 401.
 *
 * COMO MÁXIMO una renovación y UN reintento. Si el reintento vuelve a dar 401,
 * la sesión se da por terminada: insistir solo produciría un bucle contra un
 * servidor que ya dijo que no.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const sesion = puente;
  const primera = await enviar(path, init, sesion?.obtenerAccessToken() ?? null);

  const puedeRenovar = sesion !== null && !RUTAS_SIN_RENOVACION.some((r) => path.startsWith(r));
  if (primera.status !== 401 || !puedeRenovar) {
    return interpretar<T>(primera);
  }

  /**
   * `renovar()` distingue dos desenlaces muy distintos:
   *   - devuelve `null` → la SESIÓN ya no vale (el servidor respondió 401/403);
   *   - LANZA           → el intento no llegó a concluir (red, timeout, 5xx).
   *
   * Solo el primero justifica expulsar al usuario. Tratar un corte de red como
   * sesión inválida lo echaba al login cada vez que el wifi parpadeaba,
   * perdiendo lo que estuviera haciendo, y la cookie seguía siendo válida.
   */
  let nuevoToken: string | null;
  try {
    nuevoToken = await sesion.renovar();
  } catch {
    throw new ApiError(
      "No se pudo comprobar la sesión con el servidor. Compruebe su conexión e inténtelo de nuevo.",
      // 503: no se sabe nada de la sesión, solo que el servidor no respondió.
      503
    );
  }

  if (!nuevoToken) {
    sesion.cerrarPorSesionInvalida();
    throw new ApiError("La sesión expiró. Vuelva a iniciar sesión.", 401);
  }

  const segunda = await enviar(path, init, nuevoToken);
  if (segunda.status === 401) {
    // Renovamos y AUN ASÍ nos rechaza: no es un token vencido, es una sesión
    // que ya no vale.
    sesion.cerrarPorSesionInvalida();
    throw new ApiError("La sesión expiró. Vuelva a iniciar sesión.", 401);
  }
  return interpretar<T>(segunda);
}

/** Atajos para no repetir `method` en cada llamada. */
export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "POST", body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
};

/**
 * Petición que devuelve un archivo (exportaciones a CSV/Excel/PDF/HY3).
 *
 * Comparte la renovación con `apiFetch` pero entrega el contenido en bruto en
 * vez de interpretar JSON. Devuelve también el nombre que propone el servidor
 * en `Content-Disposition`, que es el que ve el usuario al guardar.
 */
export async function apiFetchArchivo(
  path: string,
  nombrePorOmision: string,
  init: RequestInit = {}
): Promise<{ blob: Blob; filename: string }> {
  const sesion = puente;
  let res = await enviar(path, init, sesion?.obtenerAccessToken() ?? null);

  if (res.status === 401 && sesion) {
    let nuevoToken: string | null;
    try {
      nuevoToken = await sesion.renovar();
    } catch {
      throw new ApiError("No se pudo comprobar la sesión con el servidor. Compruebe su conexión e inténtelo de nuevo.", 503);
    }
    if (!nuevoToken) {
      sesion.cerrarPorSesionInvalida();
      throw new ApiError("La sesión expiró. Vuelva a iniciar sesión.", 401);
    }
    res = await enviar(path, init, nuevoToken);
    if (res.status === 401) {
      sesion.cerrarPorSesionInvalida();
      throw new ApiError("La sesión expiró. Vuelva a iniciar sesión.", 401);
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(extractApiErrorMessage(body, `Error ${res.status}`), res.status);
  }

  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  return { blob: await res.blob(), filename: match?.[1] ?? nombrePorOmision };
}

/**
 * Descarga un archivo y se lo entrega al usuario.
 *
 * La maniobra del enlace temporal estaba repetida en tres archivos distintos,
 * palabra por palabra. Aquí vive una vez.
 */
export async function descargarArchivo(path: string, nombrePorOmision: string): Promise<void> {
  const { blob, filename } = await apiFetchArchivo(path, nombrePorOmision);

  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Sin esto el blob queda retenido en memoria mientras viva la pestaña.
  window.URL.revokeObjectURL(url);
}

/** Construye un query string omitiendo los parámetros vacíos. */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [clave, valor] of Object.entries(params)) {
    if (valor === undefined || valor === null || valor === "") continue;
    qs.set(clave, String(valor));
  }
  const texto = qs.toString();
  return texto ? `?${texto}` : "";
}
