import { API_BASE, api } from "../../shared/apiClient";

/**
 * MENSAJE DEL LOGIN: el texto bajo el botón «Ingresar», editable por administración.
 *
 * Es texto plano: se muestra como texto, con sus saltos de línea (`white-space: pre-line`), y
 * nunca se interpreta como HTML.
 *
 * `MENSAJE_DE_ACCESO_POR_DEFECTO` es el mensaje que estaba escrito en `LoginPage.tsx`, y debe
 * coincidir con `MENSAJE_LOGIN_POR_DEFECTO` del backend (`parametros.service.ts`; una prueba del
 * backend lo compara). El login lo muestra desde el primer momento y lo conserva si la lectura
 * pública falla: iniciar sesión nunca depende de este texto.
 */
export const MENSAJE_DE_ACCESO_POR_DEFECTO =
  "¿Olvidó su contraseña? Solicite a un administrador de la Federación que restablezca su acceso: recibirá una contraseña temporal y el sistema le pedirá definir una nueva al ingresar.";

/**
 * Lee el mensaje vigente SIN sesión. No pasa por `apiFetch`: un 401 aquí no debe intentar renovar
 * ni cerrar ninguna sesión, y no se envían credenciales. Ante cualquier fallo —red, estado no 2xx,
 * cuerpo inesperado o texto vacío— devuelve `null` y el login sigue con el texto por defecto.
 */
export async function leerMensajeDeAcceso(signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await fetch(`${API_BASE}/mensaje-de-acceso`, { credentials: "omit", cache: "no-store", signal });
    if (!r.ok) return null;
    const cuerpo: unknown = await r.json();
    const texto = (cuerpo as { texto?: unknown } | null)?.texto;
    return typeof texto === "string" && texto.trim() !== "" ? texto : null;
  } catch {
    return null;
  }
}

export interface MensajeDeAccesoAdministrativo {
  texto: string;
  porDefecto: boolean;
  textoPorDefecto: string;
  maximo: number;
  actualizadoEn: string | null;
}

export function useMensajeDeAccesoApi() {
  return {
    leer: () => api.get<MensajeDeAccesoAdministrativo>("/administracion/mensaje-de-acceso"),
    guardar: (texto: string) =>
      api.put<{ mensaje: MensajeDeAccesoAdministrativo; cambio: boolean }>("/administracion/mensaje-de-acceso", { texto }),
  };
}
