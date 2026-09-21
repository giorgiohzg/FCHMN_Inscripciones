/**
 * Decodifica el "payload" de un JWT de acceso para leer sus roles,
 * permisos y club VIGENTES — sin verificar la firma (no hace falta: el
 * backend ya lo validó al emitirlo, y esto se usa solo para
 * mostrar/ocultar partes de la interfaz, nunca como control de
 * seguridad real; toda autorización de verdad se revalida siempre en
 * el servidor).
 *
 * Se usa para mantener `user.roles`/`user.clubId` al día cada vez que el
 * token de acceso se renueva en segundo plano — antes, el refresco solo
 * actualizaba el token pero dejaba estos datos "congelados" desde el
 * momento del login original durante toda la sesión (ej. si a un
 * delegado se le reasigna a otro club mientras sigue con sesión abierta).
 */
/** Un array de cadenas, o `null` si no lo es (incluido un elemento no-cadena). */
function soloCadenas(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

/**
 * Claim que el backend firma como `string | null | ausente`.
 *
 * Hay que distinguir tres casos y NO dos: ausente y `null` significan lo mismo
 * —el usuario no tiene persona, o no tiene club—, pero un número o un objeto no
 * son "ausencia", son un token que no se entiende. Degradarlos a `null`, como se
 * hacía, los volvía indistinguibles de la ausencia legítima, y un token con
 * `clubId: 42` pasaba la comprobación de coherencia contra un perfil sin club.
 */
function cadenaOpcional(v: unknown): { ok: true; valor: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, valor: null };
  return typeof v === "string" ? { ok: true, valor: v } : { ok: false };
}

export function decodeAccessTokenClaims(
  accessToken: string
): {
  sub: string;
  ownerType: string;
  personId: string | null;
  clubId: string | null;
  roles: string[];
  permissions: string[];
} | null {
  try {
    const payloadSegment = accessToken.split(".")[1];
    if (!payloadSegment) return null;
    // Base64URL -> Base64 estándar antes de decodificar.
    const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    const payload = JSON.parse(json);

    /**
     * Unos claims malformados invalidan el TOKEN ENTERO, no se degradan a
     * listas vacías. Antes `roles: [1, {}]` se convertía en `[]` y el token se
     * aceptaba: la interfaz seguía adelante con una autorización que no era la
     * que el servidor firmó, sin que nada avisara.
     */
    const roles = soloCadenas(payload.roles);
    const permissions = soloCadenas(payload.permissions);
    if (roles === null || permissions === null) return null;

    /**
     * `sub` y `ownerType` son OBLIGATORIOS: el backend los firma siempre (ver
     * `AccessTokenClaims` en `jwt.util.ts`). Devolverlos como `null` cuando
     * faltan dejaba pasar tokens incompletos: un token sin `ownerType` superaba
     * la comprobación de coherencia contra CUALQUIER perfil.
     */
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof payload.ownerType !== "string" || payload.ownerType.length === 0) return null;

    const personId = cadenaOpcional(payload.personId);
    const clubId = cadenaOpcional(payload.clubId);
    if (!personId.ok || !clubId.ok) return null;

    return {
      // `sub` es el ID del usuario dueño del token. Se expone para poder
      // comprobar que un token y un perfil corresponden al MISMO usuario antes
      // de adoptarlos juntos (ver `sessionSchema.ts`).
      sub: payload.sub,
      // El backend firma también estos tres; se leen para poder comprobar que el
      // token y el perfil describen al MISMO usuario.
      ownerType: payload.ownerType,
      personId: personId.valor,
      clubId: clubId.valor,
      /**
       * Cada elemento tiene que ser una cadena, no solo el contenedor un array.
       * Antes bastaba `Array.isArray`, así que un `roles: [1, {}]` pasaba y esos
       * valores acababan en `hasRole()` y en la lista de permisos, donde nunca
       * coincidirían con nada pero tampoco harían saltar ningún error.
       */
      roles,
      permissions,
    };
  } catch {
    return null;
  }
}
