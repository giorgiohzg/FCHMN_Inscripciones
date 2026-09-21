import { apiFetch } from "../../shared/apiClient";

/**
 * Tipo de dueño de la cuenta, igual que el enum `OwnerType` del backend.
 * `system` es la cuenta administrativa: sin persona y sin club.
 */
export type OwnerType = "person" | "club" | "system";

/**
 * NINGUNA de estas respuestas trae ya `refreshToken`.
 *
 * Viaja en una cookie `HttpOnly` que el navegador guarda y adjunta solo a
 * `/auth/*`; este código no lo ve ni podría verlo, que es exactamente el
 * objetivo. Solo el access token —quince minutos, en memoria— llega hasta aquí.
 */
export interface PerfilDeSesion {
  id: string;
  username: string;
  ownerType: OwnerType;
  personId: string | null;
  clubId: string | null;
  roles: string[];
}

export interface LoginResponse {
  accessToken: string;
  mustChangePassword: boolean;
  /**
   * Token CSRF. SIEMPRE presente: la comprobación se exige con cualquier
   * `SameSite` (era `string | null` cuando dependía de la configuración, y ese
   * `null` permitía que el cliente se desactivara solo).
   */
  csrfToken: string;
  user: {
    id: string;
    username: string;
    // `system` es la cuenta administrativa, sin persona ni club. El backend ya
    // la enviaba; aquí faltaba y el tipo mentía sobre lo que podía llegar.
    ownerType: OwnerType;
    personId: string | null;
    clubId: string | null;
    roles: string[];
  };
}

export function apiLogin(username: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
}

/**
 * Renovación. No recibe ni devuelve el refresh token: la cookie va y vuelve
 * sola.
 *
 * Devuelve el PERFIL COMPLETO, no solo el token. Es la única vía de
 * reconstruir la sesión al recargar la página —el access token vive en memoria
 * y se pierde—, así que si no trajera el usuario, quien recargue quedaría
 * autenticado sin saber quién es. No puede depender de `sessionStorage`: ese
 * almacenamiento puede estar vacío (pestaña nueva, modo privado, datos
 * borrados) mientras la cookie sigue siendo válida.
 */
export function apiRefresh(): Promise<LoginResponse> {
  return apiFetch<LoginResponse>("/auth/refresh", { method: "POST" });
}

/**
 * Bootstrap del token CSRF. Ver `csrf.ts` para el porqué de que exista.
 * Es un GET y no cambia estado de negocio.
 */
export function apiCsrf(): Promise<{ csrfToken: string }> {
  return apiFetch<{ csrfToken: string }>("/auth/csrf");
}

export function apiLogout(): Promise<void> {
  return apiFetch<void>("/auth/logout", { method: "POST" });
}

/**
 * Cambia la contraseña y devuelve una SESIÓN NUEVA.
 *
 * El backend revoca todas las sesiones anteriores al cambiar la contraseña, y
 * en la misma respuesta reemplaza la cookie por la de la sesión nueva. Aquí
 * solo llega el access token.
 */
export function apiChangePassword(payload: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<LoginResponse> {
  // Devuelve una sesión COMPLETA —con perfil—, igual que login y refresco: es la
  // que el cliente adopta, y sin usuario quedaría autenticado sin saber quién es.
  return apiFetch<LoginResponse>("/auth/change-password", { method: "POST", body: JSON.stringify(payload) });
}

// `apiForgotPassword` se eliminó junto con el endpoint del backend: la
// recuperación de contraseña es administrativa (un administrador restablece
// la credencial y entrega una contraseña temporal).
