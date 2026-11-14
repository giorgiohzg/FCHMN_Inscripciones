/**
 * CATÁLOGO FIJO DE FUNCIONES CONFIGURABLES POR ROL (opción A: solo restringir y restituir).
 *
 * Es la ÚNICA fuente de verdad de qué se puede apagar y para quién. Cada función declara:
 *  - un identificador ESTABLE (es lo que se guarda en `accesos_por_rol.funcion`);
 *  - su menú, si es una acción (regla jerárquica: una acción solo rige con su menú encendido);
 *  - las pantallas, rutas HTTP y permisos que la protegen hoy;
 *  - en qué roles APLICA: el techo del código. La configuración nunca puede superarlo.
 *
 * Roles configurables: nadador, delegado y entrenador. La cuenta de club (`club`) y el
 * representante legal (`legal_representative`) figuran en `aplicaA` para evaluar la SUMA de roles,
 * pero no se configuran: conservan siempre sus atribuciones actuales. Administración no se
 * evalúa: tiene acceso completo.
 *
 * Fuera del catálogo, siempre disponibles: cerrar sesión, el cambio OBLIGATORIO de contraseña,
 * `/auth/me`, `/auth/refresh`, `/auth/csrf`, el inicio y las lecturas compartidas por todas las
 * pantallas (competencias, catálogos, club vigente).
 *
 * EXCEPCIÓN EXPLÍCITA: la exportación a Team Manager (`/export/team-manager/*`) NO es
 * configurable. Conserva sus permisos actuales (`export:team-manager`) y no lleva guarda de
 * función, aunque se oculte el menú Reportes.
 */

export const ROLES_CONFIGURABLES = ["swimmer", "delegate", "coach"] as const;
export type RolConfigurable = (typeof ROLES_CONFIGURABLES)[number];

/** Roles que suman en la evaluación sin configurarse: conservan su matriz del código. */
export const ROLES_NO_CONFIGURABLES = ["club", "legal_representative"] as const;

export type MetodoHttp = "GET" | "POST" | "PUT";

export interface RutaDeFuncion {
  metodo: MetodoHttp;
  ruta: string;
  /** Permiso que la ruta ya exige (`requirePermission`); la guarda de función se SUMA a él. */
  permiso: string;
  /** Si la ruta es compartida, otras funciones que también la habilitan (basta una). */
  compartidaCon?: readonly string[];
  /** Condición adicional, cuando la ruta sirve a dos funciones según su consulta. */
  condicion?: string;
}

export interface FuncionDelCatalogo {
  id: string;
  /** Menú al que pertenece una acción; `null` en los menús y en las funciones de cuenta. */
  menu: string | null;
  etiqueta: string;
  /** Pantallas (rutas de la interfaz) donde está el menú o el control. */
  pantallas: readonly string[];
  rutas: readonly RutaDeFuncion[];
  /** Roles en que la función existe hoy (techo del código). Fuera de ellos: «No aplica». */
  aplicaA: readonly string[];
}

const PERSONAL_Y_CLUB = ["delegate", "coach", "legal_representative", "club"] as const;
const TODOS = ["swimmer", ...PERSONAL_Y_CLUB] as const;

const ATENCION_INSCRIPCION_Y_RELEVOS = ["menu.inscripciones", "menu.relevos"] as const;
const POSTULACION_Y_LISTADOS = ["incorporaciones.postular", "incorporaciones.listados"] as const;

export const CATALOGO: readonly FuncionDelCatalogo[] = [
  // ---------------------------------------------------------------- Inscripciones
  {
    id: "menu.inscripciones",
    menu: null,
    etiqueta: "Inscripciones",
    pantallas: ["/inscripciones", "/inscripciones/nueva"],
    rutas: [
      { metodo: "GET", ruta: "/competitions/:id/enabled-events", permiso: "registrations:read", compartidaCon: ["menu.relevos"] },
      { metodo: "GET", ruta: "/registrations/club-swimmers", permiso: "registrations:read", compartidaCon: ["menu.relevos"] },
      { metodo: "GET", ruta: "/registrations/club-eligibility-matrix", permiso: "registrations:read" },
      { metodo: "GET", ruta: "/registrations/available-events", permiso: "registrations:read" },
      { metodo: "GET", ruta: "/registrations/eligible-swimmers", permiso: "registrations:read" },
      { metodo: "GET", ruta: "/registrations", permiso: "registrations:read", condicion: "status=confirmed (lista operativa)" },
    ],
    aplicaA: TODOS,
  },
  {
    id: "inscripciones.crear",
    menu: "menu.inscripciones",
    etiqueta: "Inscribir",
    pantallas: ["/inscripciones", "/inscripciones/nueva"],
    rutas: [{ metodo: "POST", ruta: "/registrations", permiso: "registrations:write" }],
    aplicaA: TODOS,
  },
  {
    id: "inscripciones.editar_tiempo",
    menu: "menu.inscripciones",
    etiqueta: "Editar el tiempo",
    pantallas: ["/inscripciones"],
    rutas: [{ metodo: "PUT", ruta: "/registrations/:id", permiso: "registrations:write" }],
    aplicaA: TODOS,
  },
  {
    id: "inscripciones.cancelar",
    menu: "menu.inscripciones",
    etiqueta: "Cancelar y deshacer",
    pantallas: ["/inscripciones"],
    rutas: [{ metodo: "POST", ruta: "/registrations/:id/cancel", permiso: "registrations:write" }],
    aplicaA: TODOS,
  },
  {
    id: "inscripciones.historial",
    menu: "menu.inscripciones",
    etiqueta: "Ver el historial",
    pantallas: ["/inscripciones"],
    rutas: [{ metodo: "GET", ruta: "/registrations", permiso: "registrations:read", condicion: "status=cancelled o sin estado (historial)" }],
    aplicaA: TODOS,
  },
  // ---------------------------------------------------------------- Relevos
  {
    id: "menu.relevos",
    menu: null,
    etiqueta: "Inscripciones de Relevo",
    pantallas: ["/inscripciones-relevos", "/inscripciones-relevos/nueva"],
    rutas: [
      { metodo: "GET", ruta: "/competitions/:id/enabled-events", permiso: "registrations:read", compartidaCon: ["menu.inscripciones"] },
      { metodo: "GET", ruta: "/registrations/club-swimmers", permiso: "registrations:read", compartidaCon: ["menu.inscripciones"] },
      { metodo: "GET", ruta: "/relay-registrations", permiso: "registrations:read", condicion: "status=confirmed (lista operativa)" },
    ],
    aplicaA: TODOS,
  },
  {
    id: "relevos.armar",
    menu: "menu.relevos",
    etiqueta: "Armar un equipo",
    pantallas: ["/inscripciones-relevos", "/inscripciones-relevos/nueva"],
    rutas: [{ metodo: "POST", ruta: "/relay-registrations", permiso: "registrations:write" }],
    // Un nadador no arma relevos: el servicio responde 403 al alcance `swimmer` (invariante).
    aplicaA: PERSONAL_Y_CLUB,
  },
  {
    id: "relevos.editar",
    menu: "menu.relevos",
    etiqueta: "Editar un equipo",
    pantallas: ["/inscripciones-relevos"],
    rutas: [{ metodo: "PUT", ruta: "/relay-registrations/:id", permiso: "registrations:write" }],
    aplicaA: PERSONAL_Y_CLUB,
  },
  {
    id: "relevos.cancelar",
    menu: "menu.relevos",
    etiqueta: "Cancelar un equipo",
    pantallas: ["/inscripciones-relevos"],
    rutas: [{ metodo: "POST", ruta: "/relay-registrations/:id/cancel", permiso: "registrations:write" }],
    aplicaA: PERSONAL_Y_CLUB,
  },
  {
    id: "relevos.historial",
    menu: "menu.relevos",
    etiqueta: "Ver el historial",
    pantallas: ["/inscripciones-relevos"],
    rutas: [{ metodo: "GET", ruta: "/relay-registrations", permiso: "registrations:read", condicion: "status=cancelled o sin estado (historial)" }],
    aplicaA: TODOS,
  },
  // ---------------------------------------------------------------- Reportes
  {
    id: "menu.reportes",
    menu: null,
    etiqueta: "Reportes",
    pantallas: ["/reportes"],
    // El menú no tiene rutas propias: sus lecturas de apoyo (competencias, club vigente) son
    // compartidas por todas las pantallas. Apagarlo apaga sus acciones.
    rutas: [],
    aplicaA: TODOS,
  },
  {
    id: "reportes.generar",
    menu: "menu.reportes",
    etiqueta: "Generar reporte",
    pantallas: ["/reportes"],
    rutas: [{ metodo: "GET", ruta: "/reports/registrations", permiso: "reports:read" }],
    aplicaA: TODOS,
  },
  {
    id: "reportes.exportar",
    menu: "menu.reportes",
    etiqueta: "Exportar CSV, Excel o PDF",
    pantallas: ["/reportes"],
    rutas: [{ metodo: "GET", ruta: "/reports/registrations/export", permiso: "reports:read" }],
    aplicaA: TODOS,
  },
  // ---------------------------------------------------------------- Incorporaciones (C-05)
  {
    id: "menu.incorporaciones",
    menu: null,
    etiqueta: "Incorporaciones",
    pantallas: ["/incorporaciones"],
    rutas: [],
    aplicaA: PERSONAL_Y_CLUB,
  },
  {
    id: "incorporaciones.postular",
    menu: "menu.incorporaciones",
    etiqueta: "Postular por RUN",
    pantallas: ["/incorporaciones"],
    rutas: [
      { metodo: "POST", ruta: "/swimmer-assignments", permiso: "swimmer-assignment:write" },
      { metodo: "GET", ruta: "/swimmer-assignments/cuota", permiso: "swimmer-assignment:write", compartidaCon: ["incorporaciones.listados"] },
      { metodo: "GET", ruta: "/swimmer-assignments/periodos-cambio/vigente", permiso: "swimmer-assignment:write", compartidaCon: ["incorporaciones.listados"] },
    ],
    aplicaA: PERSONAL_Y_CLUB,
  },
  {
    id: "incorporaciones.completar_alta",
    menu: "menu.incorporaciones",
    etiqueta: "Completar el alta (segundo paso)",
    pantallas: ["/incorporaciones"],
    rutas: [{ metodo: "POST", ruta: "/swimmer-assignments/altas", permiso: "swimmer-assignment:write" }],
    aplicaA: PERSONAL_Y_CLUB,
  },
  {
    id: "incorporaciones.listados",
    menu: "menu.incorporaciones",
    etiqueta: "Ver propuestas y solicitudes",
    pantallas: ["/incorporaciones"],
    rutas: [
      { metodo: "GET", ruta: "/swimmer-assignments", permiso: "swimmer-assignment:read" },
      { metodo: "GET", ruta: "/swimmer-assignments/:id", permiso: "swimmer-assignment:read" },
      { metodo: "GET", ruta: "/swimmer-assignments/altas", permiso: "swimmer-assignment:write" },
      { metodo: "GET", ruta: "/swimmer-assignments/altas/:id", permiso: "swimmer-assignment:write" },
      { metodo: "GET", ruta: "/swimmer-assignments/cuota", permiso: "swimmer-assignment:write", compartidaCon: ["incorporaciones.postular"] },
      { metodo: "GET", ruta: "/swimmer-assignments/periodos-cambio/vigente", permiso: "swimmer-assignment:write", compartidaCon: ["incorporaciones.postular"] },
    ],
    aplicaA: PERSONAL_Y_CLUB,
  },
  // ---------------------------------------------------------------- Cuenta
  {
    id: "cuenta.cambio_voluntario_contrasena",
    menu: null,
    etiqueta: "Cambio voluntario de contraseña",
    pantallas: ["/cambiar-password"],
    // Solo el voluntario: con el cambio OBLIGATORIO vigente, la ruta no consulta esta función.
    rutas: [{ metodo: "POST", ruta: "/auth/change-password", permiso: "(sesión propia)", condicion: "sin cambio obligatorio pendiente" }],
    aplicaA: TODOS,
  },
] as const;

/** Agrupación para la pantalla: menús con sus acciones, y las funciones de cuenta. */
export const GRUPOS = [
  { menu: "menu.inscripciones", acciones: ["inscripciones.crear", "inscripciones.editar_tiempo", "inscripciones.cancelar", "inscripciones.historial"] },
  { menu: "menu.relevos", acciones: ["relevos.armar", "relevos.editar", "relevos.cancelar", "relevos.historial"] },
  { menu: "menu.reportes", acciones: ["reportes.generar", "reportes.exportar"] },
  { menu: "menu.incorporaciones", acciones: ["incorporaciones.postular", "incorporaciones.completar_alta", "incorporaciones.listados"] },
  { menu: null, acciones: ["cuenta.cambio_voluntario_contrasena"] },
] as const;

/** Lo que el inventario muestra sin casillas: conserva sus permisos actuales. */
export const NO_CONFIGURABLES = [
  {
    id: "reportes.team_manager",
    menu: "menu.reportes",
    etiqueta: "Exportar a Team Manager (.zip)",
    nota: "No configurable: conserva sus permisos actuales.",
    rutas: [
      { metodo: "GET", ruta: "/export/team-manager/zip", permiso: "export:team-manager" },
      { metodo: "GET", ruta: "/export/team-manager/hy3", permiso: "export:team-manager" },
    ],
  },
] as const;

export const ACCIONES_SIEMPRE_DISPONIBLES = [
  "Cerrar sesión (POST /auth/logout)",
  "Cambio obligatorio de contraseña (POST /auth/change-password con el cambio pendiente)",
  "Inicio, restauración y renovación de la sesión (/auth/login, /auth/refresh, /auth/csrf, /auth/me, /auth/accesos)",
] as const;

const POR_ID = new Map(CATALOGO.map((f) => [f.id, f]));

export function funcionDelCatalogo(id: string): FuncionDelCatalogo | undefined {
  return POR_ID.get(id);
}

export function esRolConfigurable(rol: string): rol is RolConfigurable {
  return (ROLES_CONFIGURABLES as readonly string[]).includes(rol);
}

/** ¿La función existe hoy para ese rol? (techo del código) */
export function aplica(funcion: string, rol: string): boolean {
  return POR_ID.get(funcion)?.aplicaA.includes(rol) ?? false;
}

/** Celdas configurables: pares (rol configurable, función) dentro del techo. */
export function celdasConfigurables(): { rol: RolConfigurable; funcion: string }[] {
  return ROLES_CONFIGURABLES.flatMap((rol) => CATALOGO.filter((f) => f.aplicaA.includes(rol)).map((f) => ({ rol, funcion: f.id })));
}

export { ATENCION_INSCRIPCION_Y_RELEVOS, POSTULACION_Y_LISTADOS };
