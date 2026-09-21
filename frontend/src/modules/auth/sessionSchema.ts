import { decodeAccessTokenClaims } from "./jwtClaims";

/**
 * ESQUEMA DE VALIDACIÓN EN TIEMPO DE EJECUCIÓN DE UNA SESIÓN.
 *
 * Un solo lugar que decide si algo "es una sesión", usado tanto por lo que
 * llega del servidor como por lo que llega de otra pestaña por
 * `BroadcastChannel`.
 *
 * Por qué hace falta: `BroadcastChannel` entrega lo que cualquier código del
 * mismo origen decida publicar —otra versión de la aplicación tras un
 * despliegue, una extensión, un script inyectado—. Antes el perfil se adoptaba
 * con un cast (`sesion.user as ...`), que es una afirmación sin comprobar: un
 * mensaje con `ownerType: "otro"` o sin `clubId` entraba igual y el fallo
 * aparecía mucho más tarde, lejos de su origen.
 *
 * La validación anterior era además incompleta: miraba `id`, `username` y
 * `roles`, pero no `ownerType`, `personId` ni `clubId` —de los que dependen el
 * enrutado y el aislamiento entre clubes— y aceptaba cualquier cadena no vacía
 * como access token.
 */

export type OwnerType = "person" | "club" | "system";

const TIPOS_DE_DUENO: readonly string[] = ["person", "club", "system"];

export interface PerfilDeSesion {
  id: string;
  username: string;
  ownerType: OwnerType;
  personId: string | null;
  clubId: string | null;
  roles: string[];
}

export interface SesionValidada {
  accessToken: string;
  csrfToken: string;
  user: PerfilDeSesion;
  mustChangePassword: boolean;
  /** Ciclo de sesión al que pertenece (ver `refreshCoordinator.ts`). */
  ciclo: string;
}

const esCadenaOnulo = (v: unknown): v is string | null => v === null || typeof v === "string";

/** Valida el perfil campo por campo. */
export function validarPerfil(v: unknown): PerfilDeSesion | null {
  if (typeof v !== "object" || v === null) return null;
  const p = v as Record<string, unknown>;

  if (typeof p.id !== "string" || p.id.length === 0) return null;
  if (typeof p.username !== "string" || p.username.length === 0) return null;
  // `ownerType` decide qué pantallas ve el usuario: un valor fuera del enum
  // dejaría la interfaz en un estado que ninguna rama contempla.
  if (typeof p.ownerType !== "string" || !TIPOS_DE_DUENO.includes(p.ownerType)) return null;
  // De estos dos depende el aislamiento entre clubes; `undefined` no vale.
  if (!esCadenaOnulo(p.personId)) return null;
  if (!esCadenaOnulo(p.clubId)) return null;
  if (!Array.isArray(p.roles) || !p.roles.every((r) => typeof r === "string")) return null;

  return {
    id: p.id,
    username: p.username,
    ownerType: p.ownerType as OwnerType,
    personId: p.personId,
    clubId: p.clubId,
    roles: p.roles as string[],
  };
}

/**
 * Valida una sesión completa: forma, token decodificable y COHERENCIA entre el
 * token y el perfil.
 *
 * La comprobación `sub === user.id` es la que impide adoptar una combinación
 * imposible: un access token de un usuario con el perfil de otro. Sin ella, un
 * mensaje construido a mano podía dejar la interfaz mostrando a un usuario
 * mientras las peticiones salían con la credencial de otro.
 */
export function validarSesion(v: unknown, cicloEsperado?: string): SesionValidada | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;

  if (typeof s.accessToken !== "string" || s.accessToken.length === 0) return null;
  // El token CSRF es obligatorio: la comprobación se exige siempre.
  if (typeof s.csrfToken !== "string" || s.csrfToken.length === 0) return null;
  if (typeof s.mustChangePassword !== "boolean") return null;
  if (typeof s.ciclo !== "string" || s.ciclo.length === 0) return null;
  if (cicloEsperado !== undefined && s.ciclo !== cicloEsperado) return null;

  const user = validarPerfil(s.user);
  if (!user) return null;

  // El access token tiene que ser un JWT legible, no una cadena cualquiera.
  const claims = decodeAccessTokenClaims(s.accessToken);
  if (!claims) return null;

  /**
   * COHERENCIA ENTRE EL TOKEN Y EL PERFIL.
   *
   * El token es lo que el backend firmó; el perfil es lo que la interfaz
   * muestra y sobre lo que decide qué pantallas ofrecer. Si discrepan, alguna de
   * las dos cosas es mentira: la aplicación mostraría a un usuario mientras las
   * peticiones salen con la credencial de otro, o daría por buenos roles que el
   * servidor no concedió.
   *
   * Se comparan todos los campos que el backend firma.
   */
  if (claims.sub !== user.id) return null;
  // Sin tolerancia a la ausencia: el backend firma `ownerType` siempre, y un
  // token que no lo traiga no puede describir a este usuario.
  if (claims.ownerType !== user.ownerType) return null;
  if (claims.personId !== user.personId) return null;
  if (claims.clubId !== user.clubId) return null;
  // Mismos roles, sin depender del orden.
  if (claims.roles.length !== user.roles.length) return null;
  const rolesDelToken = new Set(claims.roles);
  if (!user.roles.every((r) => rolesDelToken.has(r))) return null;

  return {
    accessToken: s.accessToken,
    csrfToken: s.csrfToken,
    user,
    mustChangePassword: s.mustChangePassword,
    ciclo: s.ciclo,
  };
}

/**
 * Valida una RESPUESTA DE SESIÓN del servidor (login, refresco, cambio de
 * contraseña), antes de que el cliente le añada el ciclo.
 *
 * Login y cambio de contraseña se fiaban solo de los tipos de TypeScript, que
 * no existen en tiempo de ejecución: una respuesta con `ownerType` inventado, un
 * `clubId` ausente o un token de otro usuario entraba sin más y el fallo
 * aparecía mucho después. Ahora las tres respuestas pasan por el MISMO esquema.
 *
 * @returns la sesión validada, o `null` si la respuesta no sirve.
 */
export function validarRespuestaDeSesion(v: unknown): Omit<SesionValidada, "ciclo"> | null {
  // Se valida contra un ciclo ficticio: lo que importa aquí es todo lo demás.
  const CICLO_PROVISIONAL = "sin-ciclo";
  if (typeof v !== "object" || v === null) return null;
  const validada = validarSesion({ ...(v as object), ciclo: CICLO_PROVISIONAL }, CICLO_PROVISIONAL);
  if (!validada) return null;

  const { ciclo: _descartado, ...resto } = validada;
  return resto;
}
