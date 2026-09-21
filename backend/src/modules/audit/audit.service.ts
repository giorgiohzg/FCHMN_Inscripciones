import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { dbFrom, type TxOption } from "../../shared/transaction";
import type { AuditLogListQuery } from "./audit.schemas";

interface AuditParams {
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  ipAddress?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Campos que NUNCA se guardan en el registro de auditoría ni se emiten en un
 * log, cualquiera sea la profundidad a la que aparezcan.
 *
 * Hoy ninguna llamada audita una fila de `users`, así que en la práctica no se
 * está filtrando nada; esto existe para que siga siendo así. Un `after: user`
 * agregado sin pensarlo dejaría el hash de la contraseña dentro de
 * `audit_logs`, una tabla que la aplicación expone por API a quien tenga
 * `audit:read` y que nunca se borra. La defensa va en el punto por el que
 * pasan todas las escrituras, no en la disciplina de cada llamador.
 */
const CAMPOS_SECRETOS = new Set([
  "password",
  "passwordhash",
  "currentpassword",
  "newpassword",
  "confirmpassword",
  "temporarypassword",
  "token",
  "tokenhash",
  "accesstoken",
  "refreshtoken",
  "secret",
  "authorization",
]);

const REDACTADO = "[redactado]";
const DEMASIADO_PROFUNDO = "[omitido: demasiado profundo]";
const CICLO = "[omitido: referencia circular]";

/** Hasta dónde se recorre antes de cortar el subárbol. */
const PROFUNDIDAD_MAXIMA = 8;

/**
 * Copia el valor sustituyendo por `[redactado]` todo campo sensible.
 *
 * Al llegar al límite de profundidad se DESCARTA el subárbol en vez de
 * devolverlo intacto. Devolverlo era un agujero silencioso: un secreto
 * anidado más allá del octavo nivel se guardaba tal cual, y el límite estaba
 * justamente para no recorrer estructuras hondas. Cortar pierde detalle de
 * contexto; devolver el original perdía la garantía.
 *
 * `vistos` corta las referencias circulares: sin él, un objeto que se apunta a
 * sí mismo hacía recursión hasta agotar la pila y la escritura de auditoría
 * fallaba entera.
 */
function redactar(valor: unknown, profundidad = 0, vistos: WeakSet<object> = new WeakSet()): unknown {
  if (valor === null || typeof valor !== "object") return valor;
  if (valor instanceof Date) return valor;

  if (profundidad >= PROFUNDIDAD_MAXIMA) return DEMASIADO_PROFUNDO;
  if (vistos.has(valor)) return CICLO;
  vistos.add(valor);

  if (Array.isArray(valor)) return valor.map((v) => redactar(v, profundidad + 1, vistos));

  const salida: Record<string, unknown> = {};
  for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
    salida[clave] = CAMPOS_SECRETOS.has(clave.toLowerCase()) ? REDACTADO : redactar(v, profundidad + 1, vistos);
  }
  return salida;
}

/**
 * Aviso ESTRUCTURADO de una auditoría que no se pudo escribir.
 *
 * Antes esto era `console.error("[audit] Failed...", err, params)`, con dos
 * problemas: volcaba `params` entero —incluidos `before` y `after`, que es
 * justo donde podría viajar un secreto— y salía como texto libre, imposible de
 * contar o alertar. Ahora emite una sola línea JSON con un nombre de evento
 * estable y solo los campos que identifican la operación perdida: sirve para
 * una alerta ("cuántos `audit_write_failed` hubo en la última hora") y para
 * reconstruir qué falta, sin arrastrar el contenido.
 */
function avisarAuditoriaPerdida(params: AuditParams, err: unknown): void {
  const codigo = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      event: "audit_write_failed",
      level: "error",
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      userId: params.userId ?? null,
      /**
       * Clase y código, NUNCA el mensaje.
       *
       * El texto de un error de Prisma trae la consulta y los valores que la
       * provocaron; el de un error de sistema trae rutas del servidor. Como
       * este aviso va a los registros de la aplicación —que suelen enviarse a
       * un agregador externo—, se anota lo que permite diagnosticar sin
       * arrastrar contenido: qué operación se perdió, de qué clase fue el
       * error, y su código si lo tiene.
       */
      errorName: err instanceof Error ? err.constructor.name : typeof err,
      errorCode: codigo,
    })
  );
}

/**
 * Registra un evento de auditoría.
 *
 * CLASIFICACIÓN (hallazgo 23). Hay dos modos, y el llamador elige cuál según
 * lo que esté registrando:
 *
 *   1. TRANSACCIONAL — `audit(params, { tx })`.
 *      Para acciones de negocio que deben ser trazables: altas, bajas,
 *      modificaciones y cambios de estado de personas, clubes, membresías,
 *      competencias e inscripciones. La auditoría comparte la transacción del
 *      cambio, así que o quedan las dos cosas o no queda ninguna. Si la
 *      escritura de auditoría falla, LANZA y la operación se revierte: es
 *      deliberado, porque un cambio de negocio sin rastro es peor que un
 *      cambio que no ocurrió. También es obligatorio a nivel técnico:
 *      PostgreSQL aborta la transacción completa ante cualquier sentencia
 *      fallida, así que tragarse el error solo conseguiría que reapareciera
 *      —irrecuperable y sin contexto— en el COMMIT.
 *
 *   2. BEST-EFFORT — `audit(params)`, sin `tx`.
 *      Para eventos secundarios que no cambian datos de negocio: inicio y
 *      cierre de sesión, intentos fallidos, exportaciones, y el rastro de una
 *      operación que YA se revirtió (una importación fallida, cuyo registro no
 *      puede vivir en la transacción que se deshizo). No lanza: dejar a alguien
 *      sin poder entrar al sistema porque no se pudo anotar su login sería
 *      desproporcionado. A cambio, cada pérdida emite un evento estructurado
 *      `audit_write_failed` sobre el que se puede alertar.
 */
export async function audit(params: AuditParams, options?: TxOption): Promise<void> {
  const db = dbFrom(options);
  try {
    await db.auditLog.create({
      data: {
        userId: params.userId ?? null,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId ?? null,
        ipAddress: params.ipAddress ?? null,
        before: redactar(params.before) as any,
        after: redactar(params.after) as any,
      },
    });
  } catch (err) {
    if (options?.tx) throw err;
    avisarAuditoriaPerdida(params, err);
  }
}

/**
 * Escribe y audita en la MISMA transacción.
 *
 * Es la forma corta del modo transaccional, y existe para que la garantía sea
 * estructural en vez de depender de que cada llamador se acuerde: no hay manera
 * de usar este helper y que la escritura quede sin rastro, porque el registro
 * va dentro de la misma transacción que la operación.
 *
 * Convertir a mano las ~50 escrituras de negocio —abrir la transacción,
 * mover la auditoría adentro, pasar `{ tx }`— habría dejado cincuenta
 * oportunidades de olvidarse de una. Aquí el olvido no compila: `describe` es
 * obligatorio.
 *
 * `options.tx` permite anidarlo en una transacción del llamador; Prisma no
 * admite transacciones anidadas, así que en ese caso se reutiliza la que ya
 * está abierta en vez de abrir otra.
 *
 * @param operation qué escribir, usando el cliente transaccional que recibe.
 * @param describe  qué registrar, a partir del resultado de la escritura.
 */
export async function withAudit<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  describe: (result: T) => AuditParams,
  options?: TxOption
): Promise<T> {
  const ejecutar = async (tx: Prisma.TransactionClient): Promise<T> => {
    const resultado = await operation(tx);
    await audit(describe(resultado), { tx });
    return resultado;
  };

  if (options?.tx) return ejecutar(options.tx);
  return prisma.$transaction(ejecutar);
}

/**
 * Sección 19: consulta del registro de auditoría. Solo lectura — el
 * registro de auditoría en sí nunca se modifica ni se borra desde la
 * aplicación (integridad del rastro).
 */
export async function listAuditLogs(query: AuditLogListQuery) {
  const where: any = {};
  if (query.userId) where.userId = query.userId;
  if (query.entityType) where.entityType = query.entityType;
  if (query.entityId) where.entityId = query.entityId;
  if (query.action) where.action = { contains: query.action, mode: "insensitive" };
  if (query.dateFrom || query.dateTo) {
    where.createdAt = {};
    if (query.dateFrom) where.createdAt.gte = query.dateFrom;
    if (query.dateTo) where.createdAt.lte = query.dateTo;
  }

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { id: true, username: true } } },
      // `createdAt` no es único: sin `id` la paginación puede repetir u omitir.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { items, total, page: query.page, pageSize: query.pageSize };
}

/** Catálogo de valores distintos de `entityType` y `action` ya registrados — para poblar filtros en la UI sin hardcodear una lista. */
export async function listDistinctEntityTypesAndActions() {
  const [entityTypes, actions] = await Promise.all([
    prisma.auditLog.findMany({ distinct: ["entityType"], select: { entityType: true }, orderBy: { entityType: "asc" } }),
    prisma.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" } }),
  ]);
  return {
    entityTypes: entityTypes.map((e: { entityType: string }) => e.entityType),
    actions: actions.map((a: { action: string }) => a.action),
  };
}
