import { extractApiErrorCode, extractApiErrorMessage } from "./apiError";
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
 * Reintentar un 401 de estas rutas no tiene sentido y sí tiene consecuencias:
 *   - `/auth/login`: un 401 significa credenciales incorrectas; renovar no
 *     arregla nada y reintentar duplicaría el intento fallido, acercando el
 *     límite del login (RB-15; con C-02, el del par usuario–origen).
 *   - `/auth/refresh`: es la renovación misma. Renovar ante su propio fallo es
 *     una recursión infinita.
 *   - `/auth/logout`: cerrar sesión no necesita una sesión válida.
 *   - `/auth/change-password`: se ejecuta DENTRO del cerrojo de sesión, y la
 *     renovación pediría ese mismo cerrojo —que no es reentrante—, quedando a
 *     la espera de quien la invocó. Era un interbloqueo real. Su 401 lo maneja
 *     `AuthContext.changePassword`, que renueva sin volver a pedir el cerrojo
 *     y reintenta una vez.
 */
const RUTAS_SIN_RENOVACION = ["/auth/login", "/auth/refresh", "/auth/logout", "/auth/change-password", "/auth/csrf"];
// `/auth/csrf` está aquí por la misma razón que `/auth/change-password`: la
// renovación la llama DENTRO del cerrojo de sesión (`asegurarTokenCsrf`) para
// reconstruir el token CSRF (`asegurarTokenCsrf`). Si esa llamada respondiera 401
// y entrara al bucle, la renovación pediría el cerrojo que ya sostiene quien la
// invocó —Web Locks no es reentrante— y la promesa en curso se esperaría a sí
// misma. Un 401 ahí se propaga tal cual.

/**
 * QUIÉN ENVIÓ UNA PETICIÓN, no solo con qué token.
 *
 * Un token distinto NO demuestra que sea la misma sesión: el de la sesión de B
 * también es «otro token» respecto al de A, y reenviar con él una operación que
 * nació bajo A la ejecutaría con credenciales ajenas. Lo que identifica una
 * sesión es el CICLO —lo que va de un login a su cierre; ver
 * `modules/auth/refreshCoordinator.ts`—, y el usuario dentro de él.
 *
 * `userId` es `null` cuando la petición salió sin sesión (antes de restaurarla).
 * Eso no es otra identidad: es «todavía sin identificar», y puede completarse.
 */
export interface IdentidadDeSesion {
  ciclo: string;
  userId: string | null;
}

/**
 * ¿`actual` sigue siendo la sesión bajo la que salió `origen`?
 *
 * El ciclo tiene que ser el mismo; el usuario, también, salvo que `origen`
 * saliera sin sesión (`userId === null`): en ese caso la renovación que restaura
 * la sesión lo completa, y es el flujo normal de un arranque.
 */
export function esMismaSesion(origen: IdentidadDeSesion, actual: IdentidadDeSesion): boolean {
  if (origen.ciclo !== actual.ciclo) return false;
  return origen.userId === null || origen.userId === actual.userId;
}

/**
 * Desenlaces de una renovación vistos desde el cliente HTTP. Son TRES y no se
 * deben confundir:
 *
 *   - `renovada`: la MISMA sesión (mismo ciclo y usuario) tiene un token nuevo y
 *     válido. Es lo único con lo que se puede repetir la petición.
 *   - `invalida`: el servidor confirmó, para esa misma sesión, que ya no vale.
 *   - `cambiada`: mientras tanto la sesión es OTRA (otra cuenta, otro login, un
 *     cierre en otra pestaña) o no se pudo establecer. La operación no se repite
 *     y la sesión actual NO se toca: no es la que falló.
 */
export type RenovacionParaElCliente =
  | { tipo: "renovada"; accessToken: string }
  | { tipo: "invalida" }
  | { tipo: "cambiada" };

/** Estado de sesión que el cliente necesita; lo inyecta el AuthContext. */
export interface PuenteDeSesion {
  /**
   * El token VIGENTE y la identidad a la que pertenece, leídos en el MISMO
   * instante. Van juntos a propósito: leerlos por separado dejaba un hueco en el
   * que podían describir sesiones distintas. El token vive en memoria, nunca en
   * disco.
   */
  obtenerSesion(): { accessToken: string | null; identidad: IdentidadDeSesion };
  /**
   * Renueva la sesión SI `identidad` sigue siendo la vigente; si no, responde
   * `cambiada` sin llegar al servidor. Nunca devuelve el token de otra sesión.
   *
   * La comprobación debe hacerse también DENTRO de la sección crítica, después de
   * esperar el cerrojo y antes de emitir la renovación o reutilizar un anuncio:
   * esperar puede llevar un rato y la sesión pudo cambiar entre medias.
   */
  renovar(identidad: IdentidadDeSesion): Promise<RenovacionParaElCliente>;
  /**
   * La sesión de `identidad` terminó: limpiar y mandar al login, pero SOLO si
   * sigue siendo la vigente —el ciclo Y el usuario, no solo el ciclo—. Devuelve
   * si cerró; `false` significa que ya hay otra sesión y no se tocó.
   * Comprobación y cierre ocurren juntos, bajo el cerrojo de sesión.
   */
  cerrarPorSesionInvalida(identidad: IdentidadDeSesion): Promise<boolean>;
}

let puente: PuenteDeSesion | null = null;

/** Lo llama `AuthProvider` al montarse. */
export function conectarSesion(p: PuenteDeSesion): void {
  puente = p;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Código estructurado del backend, si lo envió (ver `extractApiErrorCode`). Opcional: los usos existentes no lo necesitan. */
    readonly code?: string,
    /**
     * `details` ESTRUCTURADO del backend, tal como llegó (p. ej. `membresiaVigente` o
     * `membresias` en los 409 de C-05). Es para decidir con datos, nunca extrayendo
     * identificadores del texto del mensaje. Quien lo use debe validar su forma.
     */
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * La operación se canceló porque la sesión bajo la que salió ya no es la actual.
 *
 * Es una cancelación del CLIENTE, no una respuesta del servidor, y por eso no
 * lleva 401: ese código significa «esta sesión no vale» y varios flujos reaccionan
 * a él cerrándola. Aquí la sesión que no vale es la antigua; la actual está bien
 * y no debe cerrarse. 409 se lee como «el estado cambió bajo la operación». Quien
 * necesite distinguirlo debe usar `instanceof SesionCambiadaError`, no el código.
 */
export class SesionCambiadaError extends ApiError {
  constructor() {
    super(
      "La sesión cambió mientras se procesaba la solicitud, por lo que no se repitió. " +
        "Revise el estado actual e inténtelo de nuevo si corresponde.",
      409
    );
    this.name = "SesionCambiadaError";
  }
}

async function interpretar<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(extractApiErrorMessage(body, `Error ${res.status}`), res.status, extractApiErrorCode(body), detallesDelError(body));
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** `details` del cuerpo de error, si es un objeto; cualquier otra forma se descarta. */
function detallesDelError(body: unknown): unknown {
  const d = (body as { details?: unknown } | null)?.details;
  return typeof d === "object" && d !== null ? d : undefined;
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
  // Token e identidad se leen JUNTOS, antes de enviar: son los de la sesión bajo
  // la que nace esta operación, y con ella se compara todo lo que venga después.
  const origen = sesion?.obtenerSesion() ?? null;
  const primera = await enviar(path, init, origen?.accessToken ?? null);

  const puedeRenovar = sesion !== null && !RUTAS_SIN_RENOVACION.some((r) => path.startsWith(r));
  if (primera.status !== 401 || !puedeRenovar) {
    return interpretar<T>(primera);
  }

  // Con `puedeRenovar` verdadero hay puente y, por tanto, origen.
  const nuevoToken = await renovarParaReintentar(sesion, origen!.identidad);
  // Sin ningún `await` entre esta comprobación y el envío (ver la función).
  exigirLaMismaSesion(sesion, origen!.identidad);

  const segunda = await enviar(path, init, nuevoToken);
  if (segunda.status === 401) {
    // Renovamos y AUN ASÍ nos rechaza: no es un token vencido, es una sesión
    // que ya no vale. Si entre tanto la sesión cambió, esta respuesta es de la
    // anterior y no se le imputa a la actual (ver `rendirse`).
    return rendirse(sesion, origen!.identidad);
  }
  return interpretar<T>(segunda);
}

/**
 * Renueva la sesión bajo la que salió una petición que recibió un 401, y
 * devuelve el token con el que REPETIRLA. Si no hay forma legítima de repetirla,
 * LANZA.
 *
 * `sesion.renovar` distingue tres desenlaces (ver `RenovacionParaElCliente`) y
 * un cuarto sale por excepción:
 *   - `renovada` → devuelve el token de ESA sesión;
 *   - `invalida` → el servidor confirmó que ya no vale: se cierra, si sigue
 *     siendo la vigente;
 *   - `cambiada` → la sesión es otra: la operación no se repite;
 *   - LANZA      → el intento no llegó a concluir (red, timeout, 5xx).
 *
 * Solo `invalida` justifica expulsar al usuario. Tratar un corte de red como
 * sesión inválida lo echaba al login cada vez que el wifi parpadeaba, perdiendo
 * lo que estuviera haciendo, y la cookie seguía siendo válida.
 *
 * Y `cambiada` ya NO devuelve «el token que haya ahora»: eso reenviaba una
 * operación nacida bajo la cuenta A con las credenciales de la cuenta B, y un 401
 * atrasado de A cerraba la sesión de B.
 */
async function renovarParaReintentar(sesion: PuenteDeSesion, identidad: IdentidadDeSesion): Promise<string> {
  let resultado: RenovacionParaElCliente;
  try {
    resultado = await sesion.renovar(identidad);
  } catch {
    throw new ApiError(
      "No se pudo comprobar la sesión con el servidor. Compruebe su conexión e inténtelo de nuevo.",
      // 503: no se sabe nada de la sesión, solo que el servidor no respondió.
      503
    );
  }

  if (resultado.tipo === "cambiada") throw new SesionCambiadaError();
  if (resultado.tipo === "invalida") return rendirse(sesion, identidad);
  return resultado.accessToken;
}

/**
 * Última comprobación ANTES de repetir una petición: la sesión actual sigue
 * siendo aquella bajo la que nació. Si no, la operación se cancela.
 *
 * Hace falta aunque `renovar` ya haya respondido `renovada`, porque esa respuesta
 * describe la sesión en el momento en que se produjo, y para cuando el
 * reintento sale pudieron pasar las esperas anteriores (el cerrojo, la propia
 * renovación). Es síncrona A PROPÓSITO y se llama inmediatamente antes de
 * `enviar`: no hay `await` entre una y otra, así que nada puede cambiar la
 * sesión entre «sigue siendo la misma» y la salida de la petición. No pide el
 * cerrojo —se leería de nuevo con la misma ventana— ni renueva: solo lee.
 *
 * No cierra nada: la sesión que hay ahora no es la que falló.
 */
function exigirLaMismaSesion(sesion: PuenteDeSesion, identidad: IdentidadDeSesion): void {
  if (!esMismaSesion(identidad, sesion.obtenerSesion().identidad)) throw new SesionCambiadaError();
}

/**
 * Da por terminada la sesión de `identidad` —y solo esa— y lanza el error que
 * corresponde. Nunca devuelve.
 *
 * El cierre es condicional: si mientras tanto entró otra sesión, el 401 que nos
 * trajo hasta aquí pertenece a la anterior. En ese caso no se cierra ni se
 * anuncia nada, y el error es el de «la sesión cambió», no el de «expiró».
 */
async function rendirse(sesion: PuenteDeSesion, identidad: IdentidadDeSesion): Promise<never> {
  const cerrada = await sesion.cerrarPorSesionInvalida(identidad);
  if (!cerrada) throw new SesionCambiadaError();
  throw new ApiError("La sesión expiró. Vuelva a iniciar sesión.", 401);
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
  const origen = sesion?.obtenerSesion() ?? null;
  let res = await enviar(path, init, origen?.accessToken ?? null);

  if (res.status === 401 && sesion) {
    // Mismo tratamiento que `apiFetch`: identidad capturada al enviar, una sola
    // renovación y un solo reintento, y ninguna reacción si la sesión cambió.
    const nuevoToken = await renovarParaReintentar(sesion, origen!.identidad);
    exigirLaMismaSesion(sesion, origen!.identidad);
    res = await enviar(path, init, nuevoToken);
    if (res.status === 401) {
      return rendirse(sesion, origen!.identidad);
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(extractApiErrorMessage(body, `Error ${res.status}`), res.status, extractApiErrorCode(body), detallesDelError(body));
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
