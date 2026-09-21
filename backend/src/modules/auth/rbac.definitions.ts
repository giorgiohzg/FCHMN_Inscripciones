/**
 * Catálogo de permisos y su asignación por rol — ÚNICA fuente de verdad.
 *
 * Vivía dentro de `prisma/seed.ts`, que se ejecuta al importarse y crea su
 * propio PrismaClient, así que las pruebas no podían reutilizarlo y tenían
 * que redefinir los roles a mano (con el riesgo de que la matriz de permisos
 * probada se fuera separando de la real). Ahora el seed y las pruebas
 * importan esto mismo.
 */

export const PERMISSIONS = [
  "persons:read",
  "persons:write",
  "clubs:read",
  "clubs:write",
  "swimmer-assignment:read",
  "swimmer-assignment:write",
  "swimmer-assignment:approve",
  "catalogs:read",
  "catalogs:write",
  "competitions:read",
  "competitions:write",
  "registrations:read",
  "registrations:write",
  "registrations:write:post-close",
  "reports:read",
  "export:team-manager",
  "audit:read",
] as const;

/**
 * Delegado, Entrenador y Representante Legal comparten exactamente el mismo
 * conjunto de permisos, por decisión de negocio confirmada: el representante
 * legal SÍ es un rol de acceso y opera sobre el club donde fue nombrado, con
 * las mismas atribuciones que un delegado.
 */
export const CLUB_STAFF_PERMISSIONS = [
  "clubs:read",
  "swimmer-assignment:read",
  "swimmer-assignment:write",
  "catalogs:read",
  "competitions:read",
  "registrations:read",
  "registrations:write",
  "reports:read",
];

export const ROLES: Record<string, string[]> = {
  admin: [...PERMISSIONS],
  club: [
    "clubs:read",
    // A-05: solo puede PROPONER (write = crear pendiente), no aprobar.
    "swimmer-assignment:read",
    "swimmer-assignment:write",
    "catalogs:read",
    "competitions:read",
    "registrations:read",
    "registrations:write",
    "reports:read",
  ],
  delegate: CLUB_STAFF_PERMISSIONS,
  coach: CLUB_STAFF_PERMISSIONS,
  legal_representative: CLUB_STAFF_PERMISSIONS,
  /**
   * Un nadador solo gestiona sus PROPIAS pruebas individuales. El permiso
   * habilita la acción en general; que sea "la suya" y no la de otro lo
   * garantiza el alcance del actor (`shared/actorContext.ts`), no el permiso.
   */
  swimmer: [
    "catalogs:read",
    "competitions:read",
    "registrations:read",
    "registrations:write",
    // Para que el asistente autocomplete su propio club.
    "swimmer-assignment:read",
    // Reportes acotados a su propia información.
    "reports:read",
  ],
};
