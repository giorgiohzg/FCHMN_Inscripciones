/**
 * ACCESOS POR ROL — configuración, evaluación y guardado (opción A: solo restringir).
 *
 * EVALUACIÓN (`evaluarFuncion`), sobre los roles EFECTIVOS de la solicitud, que `authenticate`
 * recarga de la base en cada petición, ya reducidos si el club no está operativo. Nunca se usa
 * la copia del JWT.
 *  - Administración → permitida siempre.
 *  - Roles a los que la función APLICA (techo del código). Si ninguno → «no aplica»: la guarda
 *    no decide y siguen mandando las protecciones actuales (permiso, guardas de rol, alcance).
 *    Así la configuración nunca concede nada.
 *  - Si alguno aplica → permitida si ALGUNO la permite (los accesos se SUMAN):
 *      · rol no configurable (cuenta de club, representante legal): siempre, como hoy;
 *      · rol configurable: su menú encendido Y la función encendida.
 *  - Si ninguno de los que aplican la permite → denegada (`FUNCION_DESHABILITADA`).
 * Sin filas en `accesos_por_rol` nada queda denegado: el comportamiento es exactamente el actual.
 *
 * CACHÉ POR VERSIÓN. Cada solicitud protegida lee la fila de versión (una consulta por clave
 * primaria). Si coincide con la versión en memoria se usa esa copia; si no, versión y filas se
 * vuelven a leer JUNTAS en una transacción REPEATABLE READ, de modo que nunca se guardan en
 * caché filas de una versión con el número de otra. Una solicitud iniciada después de confirmar
 * un cambio lee la versión nueva y evalúa con ella.
 *
 * FALLOS. Si la configuración no se puede leer, la solicitud se RECHAZA con 503
 * `CONFIGURACION_ACCESOS_NO_DISPONIBLE`: un fallo nunca concede acceso. Ni ese error ni
 * `FUNCION_DESHABILITADA` (403) cierran la sesión: no son 401.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { AppError, ValidationError } from "../../shared/errors";
import { audit } from "../audit/audit.service";
import {
  CATALOGO,
  GRUPOS,
  NO_CONFIGURABLES,
  ACCIONES_SIEMPRE_DISPONIBLES,
  ROLES_CONFIGURABLES,
  celdasConfigurables,
  esRolConfigurable,
  funcionDelCatalogo,
  type RolConfigurable,
} from "./catalogo";

export class FuncionDeshabilitadaError extends AppError {
  constructor(funcion: string) {
    super(403, "FUNCION_DESHABILITADA", "Esta función está deshabilitada para su cuenta. Consulte con la administración.", { funcion });
  }
}

export class ConfiguracionNoDisponibleError extends AppError {
  constructor() {
    super(503, "CONFIGURACION_ACCESOS_NO_DISPONIBLE", "No se pudo comprobar la configuración de accesos. Intente nuevamente en unos instantes.");
  }
}

export class ConfiguracionCambiadaError extends AppError {
  constructor(vigente: ConfiguracionAdministrativa) {
    super(
      409,
      "CONFIGURACION_CAMBIADA",
      "Otra persona guardó cambios en la configuración de accesos. Revise el estado vigente y vuelva a aplicar sus cambios si corresponde.",
      { vigente }
    );
  }
}

export interface ConfiguracionVigente {
  version: number;
  /** Claves `rol:funcion` apagadas. */
  deshabilitadas: ReadonlySet<string>;
}

const clave = (rol: string, funcion: string) => `${rol}:${funcion}`;

let cache: ConfiguracionVigente | null = null;

/** Solo para pruebas: olvida la copia en memoria. */
export function olvidarCacheDeAccesos(): void {
  cache = null;
}

async function leerVersionYFilas(): Promise<ConfiguracionVigente> {
  const [fila, filas] = await prisma.$transaction(
    [
      prisma.configuracionAccesos.findUnique({ where: { id: 1 }, select: { version: true } }),
      prisma.accesoPorRol.findMany({ select: { rol: true, funcion: true, habilitada: true } }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
  if (!fila) throw new Error("Falta la fila de versión de la configuración de accesos");
  return { version: fila.version, deshabilitadas: new Set(filas.filter((f) => !f.habilitada).map((f) => clave(f.rol, f.funcion))) };
}

/** Configuración vigente AHORA. Lanza `ConfiguracionNoDisponibleError` si no se puede leer. */
export async function cargarConfiguracionVigente(): Promise<ConfiguracionVigente> {
  try {
    const fila = await prisma.configuracionAccesos.findUnique({ where: { id: 1 }, select: { version: true } });
    if (!fila) throw new Error("Falta la fila de versión de la configuración de accesos");
    if (cache && cache.version === fila.version) return cache;
    const leida = await leerVersionYFilas();
    // Solo se reemplaza la copia por una de versión igual o mayor: una lectura lenta y antigua
    // no pisa una más reciente.
    if (!cache || leida.version >= cache.version) cache = leida;
    return leida;
  } catch {
    throw new ConfiguracionNoDisponibleError();
  }
}

export type Decision = "permitida" | "denegada" | "no_aplica";

function encendida(config: ConfiguracionVigente, rol: RolConfigurable, funcion: string | null): boolean {
  return funcion === null || !config.deshabilitadas.has(clave(rol, funcion));
}

/** Decide UNA función para los roles efectivos dados. Ver la cabecera del módulo. */
export function evaluarFuncion(funcion: string, roles: readonly string[], config: ConfiguracionVigente): Decision {
  const f = funcionDelCatalogo(funcion);
  if (!f) throw new Error(`Función fuera del catálogo: ${funcion}`);
  if (roles.includes("admin")) return "permitida";
  const aplicables = roles.filter((r) => f.aplicaA.includes(r));
  if (aplicables.length === 0) return "no_aplica";
  const alguno = aplicables.some((r) => !esRolConfigurable(r) || (encendida(config, r, f.menu) && encendida(config, r, f.id)));
  return alguno ? "permitida" : "denegada";
}

/**
 * Para una ruta habilitada por VARIAS funciones (endpoints compartidos): basta que una la
 * permita. Solo se deniega si alguna quedó denegada y ninguna la permite; si a ninguna le
 * aplica, la guarda no decide.
 */
export function evaluarAlgunaFuncion(funciones: readonly string[], roles: readonly string[], config: ConfiguracionVigente): { decision: Decision; funcion: string } {
  const decisiones = funciones.map((funcion) => ({ funcion, decision: evaluarFuncion(funcion, roles, config) }));
  const permitida = decisiones.find((d) => d.decision === "permitida");
  if (permitida) return permitida;
  const denegada = decisiones.find((d) => d.decision === "denegada");
  if (denegada) return denegada;
  return { funcion: funciones[0]!, decision: "no_aplica" };
}

/** Funciones del catálogo que la sesión tiene DENEGADAS ahora (para ocultar controles). */
export function funcionesDeshabilitadas(roles: readonly string[], config: ConfiguracionVigente): string[] {
  return CATALOGO.filter((f) => evaluarFuncion(f.id, roles, config) === "denegada").map((f) => f.id);
}

// ---------------------------------------------------------------------------------------------
// Administración
// ---------------------------------------------------------------------------------------------

export type ValoresPorRol = Record<RolConfigurable, Record<string, boolean>>;

export interface ConfiguracionAdministrativa {
  version: number;
  valores: ValoresPorRol;
  ultimaModificacion: { en: string; por: { id: string; username: string } | null } | null;
}

function valoresDesde(deshabilitadas: ReadonlySet<string>): ValoresPorRol {
  const valores = Object.fromEntries(ROLES_CONFIGURABLES.map((r) => [r, {} as Record<string, boolean>])) as ValoresPorRol;
  for (const { rol, funcion } of celdasConfigurables()) valores[rol][funcion] = !deshabilitadas.has(clave(rol, funcion));
  return valores;
}

type Lector = Pick<Prisma.TransactionClient, "configuracionAccesos" | "accesoPorRol">;

async function leerAdministrativa(db: Lector): Promise<ConfiguracionAdministrativa> {
  const fila = await db.configuracionAccesos.findUnique({
    where: { id: 1 },
    select: { version: true, actualizadoEn: true, actualizadoPor: { select: { id: true, username: true } } },
  });
  if (!fila) throw new ConfiguracionNoDisponibleError();
  const filas = await db.accesoPorRol.findMany({ select: { rol: true, funcion: true, habilitada: true } });
  return {
    version: fila.version,
    valores: valoresDesde(new Set(filas.filter((f) => !f.habilitada).map((f) => clave(f.rol, f.funcion)))),
    ultimaModificacion: fila.actualizadoEn
      ? { en: fila.actualizadoEn.toISOString(), por: fila.actualizadoPor ? { id: fila.actualizadoPor.id, username: fila.actualizadoPor.username } : null }
      : null,
  };
}

/** Configuración para la pantalla, con el catálogo y el inventario. Lectura coherente. */
export async function leerConfiguracionAdministrativa() {
  try {
    const configuracion = await prisma.$transaction((tx) => leerAdministrativa(tx), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { ...configuracion, ...descripcionDelCatalogo() };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new ConfiguracionNoDisponibleError();
  }
}

export function descripcionDelCatalogo() {
  return {
    roles: ROLES_CONFIGURABLES,
    grupos: GRUPOS.map((g) => ({
      menu: g.menu ? describir(g.menu) : null,
      acciones: g.acciones.map(describir),
      noConfigurables: NO_CONFIGURABLES.filter((n) => n.menu === g.menu).map((n) => ({ id: n.id, etiqueta: n.etiqueta, nota: n.nota })),
    })),
    siempreDisponibles: ACCIONES_SIEMPRE_DISPONIBLES,
  };
}

function describir(id: string) {
  const f = funcionDelCatalogo(id)!;
  return { id: f.id, etiqueta: f.etiqueta, menu: f.menu, aplicaA: ROLES_CONFIGURABLES.filter((r) => f.aplicaA.includes(r)) };
}

/**
 * Valida el estado completo enviado: exactamente las celdas configurables, ni una más ni una
 * menos. Rechaza roles, funciones o combinaciones fuera del catálogo (por ejemplo, «Nadador —
 * Armar un equipo», que no aplica, o Team Manager, que no es configurable).
 */
export function validarValores(valores: unknown): Set<string> {
  if (typeof valores !== "object" || valores === null || Array.isArray(valores)) throw new ValidationError("La configuración debe ser un objeto por rol");
  const errores: string[] = [];
  const deshabilitadas = new Set<string>();
  const esperadas = new Set(celdasConfigurables().map((c) => clave(c.rol, c.funcion)));
  const recibidas = new Set<string>();
  for (const [rol, funciones] of Object.entries(valores as Record<string, unknown>)) {
    if (!esRolConfigurable(rol)) {
      errores.push(`Rol no configurable: ${rol.slice(0, 40)}`);
      continue;
    }
    if (typeof funciones !== "object" || funciones === null || Array.isArray(funciones)) {
      errores.push(`Valores inválidos para ${rol}`);
      continue;
    }
    for (const [funcion, habilitada] of Object.entries(funciones as Record<string, unknown>)) {
      const k = clave(rol, funcion);
      if (!esperadas.has(k)) {
        errores.push(funcionDelCatalogo(funcion) ? `La función ${funcion} no aplica a ${rol}` : `Función fuera del catálogo: ${funcion.slice(0, 80)}`);
        continue;
      }
      if (typeof habilitada !== "boolean") {
        errores.push(`Valor no booleano en ${k}`);
        continue;
      }
      recibidas.add(k);
      if (!habilitada) deshabilitadas.add(k);
    }
  }
  for (const k of esperadas) if (!recibidas.has(k)) errores.push(`Falta la celda ${k}`);
  if (errores.length > 0) throw new ValidationError("La configuración de accesos no es válida", { errores: errores.slice(0, 50) });
  return deshabilitadas;
}

export interface ResultadoDelGuardado {
  configuracion: Awaited<ReturnType<typeof leerConfiguracionAdministrativa>>;
  cambios: number;
}

/**
 * Guarda el estado completo con CONTROL DE VERSIÓN. Dentro de una transacción:
 *  1. bloquea la fila de versión (`FOR UPDATE`) y la compara con la esperada; si otra
 *     administración guardó entretanto → 409 `CONFIGURACION_CAMBIADA` con el estado vigente,
 *     sin escribir nada ni reintentar;
 *  2. calcula las diferencias; si no hay ninguna, no cambia la versión ni audita;
 *  3. reemplaza las filas, incrementa la versión y audita `ROLE_ACCESS_UPDATED` con actor,
 *     versión anterior y nueva y solo las celdas que cambiaron. Todo o nada.
 */
export async function guardarConfiguracion(
  entrada: { version: number; valores: unknown },
  actor: { userId: string; ipAddress?: string }
): Promise<ResultadoDelGuardado> {
  const deseadas = validarValores(entrada.valores);
  const cambios = await prisma.$transaction(async (tx) => {
    const bloqueada = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM configuracion_accesos WHERE id = 1 FOR UPDATE`;
    if (bloqueada.length === 0) throw new ConfiguracionNoDisponibleError();
    const versionActual = bloqueada[0]!.version;
    if (versionActual !== entrada.version) {
      throw new ConfiguracionCambiadaError({ ...(await leerAdministrativa(tx)) });
    }

    const filas = await tx.accesoPorRol.findMany({ select: { rol: true, funcion: true, habilitada: true } });
    const actuales = new Set(filas.filter((f) => !f.habilitada).map((f) => clave(f.rol, f.funcion)));
    const diferencias = celdasConfigurables()
      .map(({ rol, funcion }) => ({ rol, funcion, antes: !actuales.has(clave(rol, funcion)), despues: !deseadas.has(clave(rol, funcion)) }))
      .filter((d) => d.antes !== d.despues);
    if (diferencias.length === 0) return 0;

    const ahora = new Date();
    await tx.accesoPorRol.deleteMany({});
    if (deseadas.size > 0) {
      await tx.accesoPorRol.createMany({
        data: [...deseadas].map((k) => {
          const [rol, funcion] = k.split(":") as [string, string];
          return { rol, funcion, habilitada: false, actualizadoPorUserId: actor.userId, actualizadoEn: ahora };
        }),
      });
    }
    await tx.configuracionAccesos.update({
      where: { id: 1 },
      data: { version: versionActual + 1, actualizadoPorUserId: actor.userId, actualizadoEn: ahora },
    });
    await audit(
      {
        userId: actor.userId,
        action: "ROLE_ACCESS_UPDATED",
        entityType: "ConfiguracionAccesos",
        entityId: "1",
        ipAddress: actor.ipAddress,
        before: { version: versionActual, celdas: diferencias.map((d) => ({ rol: d.rol, funcion: d.funcion, habilitada: d.antes })) },
        after: { version: versionActual + 1, celdas: diferencias.map((d) => ({ rol: d.rol, funcion: d.funcion, habilitada: d.despues })) },
      },
      { tx }
    );
    return diferencias.length;
  });
  return { configuracion: await leerConfiguracionAdministrativa(), cambios };
}
