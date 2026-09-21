import type { PerfilDeSesion } from "../modules/auth/sessionSchema";

/**
 * Ayudantes para construir sesiones de prueba COHERENTES.
 *
 * Desde que la validación compara el token con el perfil —`sub`, `ownerType`,
 * `personId`, `clubId` y roles—, una fixture que firme el token por su cuenta y
 * describa el perfil aparte se desincroniza en cuanto se toca cualquiera de los
 * dos, y la prueba falla por un motivo que no tiene que ver con lo que quiere
 * comprobar. Aquí el token se DERIVA del perfil, así que siempre concuerdan.
 *
 * Para los casos negativos existe `tokenIncoherente`, que rompe un campo a
 * propósito.
 */

export function perfilDePrueba(parcial: Partial<PerfilDeSesion> = {}): PerfilDeSesion {
  return {
    id: "u1",
    username: "usuario.prueba",
    ownerType: "system",
    personId: null,
    clubId: null,
    roles: ["admin"],
    ...parcial,
  };
}

/** JWT de mentira —sin firma real— cuyos claims describen exactamente al perfil. */
export function tokenDePerfil(perfil: PerfilDeSesion, permisos: string[] = [], marca = ""): string {
  const payload = btoa(
    JSON.stringify({
      sub: perfil.id,
      ownerType: perfil.ownerType,
      personId: perfil.personId,
      clubId: perfil.clubId,
      roles: perfil.roles,
      permissions: permisos,
      marca,
    })
  );
  return `encabezado.${payload}.firma`;
}

/** Token cuyos claims NO concuerdan con el perfil, para los casos negativos. */
export function tokenIncoherente(perfil: PerfilDeSesion, roto: Record<string, unknown>): string {
  const payload = btoa(
    JSON.stringify({
      sub: perfil.id,
      ownerType: perfil.ownerType,
      personId: perfil.personId,
      clubId: perfil.clubId,
      roles: perfil.roles,
      permissions: [],
      ...roto,
    })
  );
  return `encabezado.${payload}.firma`;
}

/** Sesión completa y válida, tal como la devuelve el backend. */
export function sesionDePrueba(perfil: PerfilDeSesion, csrfToken: string, permisos: string[] = [], marca = "") {
  return {
    accessToken: tokenDePerfil(perfil, permisos, marca),
    csrfToken,
    mustChangePassword: false,
    user: perfil,
  };
}
