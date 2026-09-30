import { AppError, ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from "./errors";

/**
 * Traducción de errores de Prisma a errores de dominio.
 *
 * Sin esto, cualquier violación de índice único o de clave foránea salía como
 * 500 "Error interno del servidor": el usuario no distinguía un problema real
 * del sistema de un dato duplicado, y en los reportes de error se perdía la
 * causa.
 *
 * Importa especialmente ahora que las reglas de unicidad viven en la base de
 * datos (índices parciales de la migración `phase2_integrity`): la carrera
 * entre dos solicitudes ya no se detecta contando filas, sino recibiendo el
 * P2002 de PostgreSQL, y ese caso debe llegar al cliente como un 409
 * entendible y reintentable, no como un error interno.
 */

interface PrismaKnownError {
  code: string;
  meta?: { target?: string[] | string; modelName?: string; field_name?: string };
  /**
   * El texto del motor. Solo se usa para DISTINGUIR situaciones dentro de un
   * mismo código —P2028 agrupa varias—, nunca para mostrárselo a nadie.
   * Opcional porque un error sintético puede no traerlo.
   */
  message?: string;
}

function isPrismaKnownError(err: unknown): err is PrismaKnownError {
  return typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string";
}

/**
 * Clave de conflicto único: `Modelo.columna[,columna...]`.
 *
 * NO es el nombre del índice. Este mapa estaba indexado por nombre de índice
 * (`registrations_unique_confirmed_person_event`, etc.) y por eso NINGUNA de
 * sus entradas llegaba a usarse: Prisma no informa el nombre del índice.
 * Verificado contra PostgreSQL provocando los nueve conflictos reales — lo que
 * llega en `meta` es el modelo y la lista de COLUMNAS físicas del índice:
 *
 *   {"modelName":"Registration","target":["competition_event_id","person_id"]}
 *   {"modelName":"Category","target":["test_type_id","name"]}
 *
 * El resultado era que un nadador inscrito dos veces, un RUN repetido o una
 * membresía duplicada recibían el texto genérico "Ya existe un registro con
 * esos datos." en vez del mensaje de la regla. El código (409) siempre fue
 * correcto; lo que se perdía era la explicación.
 *
 * Las columnas van en el orden del índice, en minúsculas y separadas por coma
 * — igual que las normaliza `uniqueConflictKeys`.
 */
const UNIQUE_CONFLICT_MESSAGES: Record<string, string> = {
  "Registration.competition_event_id,person_id": "Ese nadador ya está inscrito en esta prueba.",
  "RelayRegistration.competition_event_id,club_id,category_id": "El club ya tiene un equipo inscrito para esta prueba y categoría.",
  "ClubSwimmer.person_id": "Ese nadador ya tiene una membresía activa en un club.",
  "Person.run": "Ya existe una persona registrada con ese RUN.",
  "Person.username": "Ya existe una persona con ese nombre de usuario.",
  "Club.username": "Ya existe un club con ese nombre de usuario.",
  // `users.username` reúne las cuentas de personas y de clubes. Los servicios
  // sí lo comprueban antes ("Ya existe una cuenta con ese nombre de usuario"),
  // así que este mensaje es el respaldo para la carrera entre dos altas
  // simultáneas, donde la única defensa es el índice.
  "User.username": "Ese nombre de usuario ya está tomado por otra cuenta de acceso (de una persona o de un club).",
  // Alta de persona con el mismo rol repetido en la lista. Prisma informa el
  // modelo EXTERIOR de la creación anidada (`Person`), no `PersonRole`.
  "Person.person_id,role_type": "La persona no puede tener dos veces el mismo rol.",
  "PersonRole.person_id,role_type": "La persona no puede tener dos veces el mismo rol.",
  "Category.test_type_id,name": "Ya existe una categoría con ese nombre para ese tipo de prueba.",
  "Event.test_type_id,distance_id,stroke_id,gender": "Ya existe una prueba con esa combinación de tipo, distancia, estilo y género.",
};

/** Normaliza `meta.target` a `columna[,columna...]` en minúsculas. */
function normalizeTarget(target?: string[] | string): string | undefined {
  if (!target) return undefined;
  const partes = (Array.isArray(target) ? target : target.split(","))
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  return partes.length > 0 ? partes.join(",") : undefined;
}

/**
 * Claves candidatas para un P2002, de la más específica a la más general.
 *
 * La primera es `Modelo.columnas`, que es la forma que usan el mapa y los
 * overrides. La segunda, solo `columnas`, es el respaldo para cuando el error
 * llega SIN `modelName` — ocurre, por ejemplo, con errores propagados desde
 * `$transaction` por lotes, donde el modelo no viaja en `meta`. En ese caso no
 * se puede distinguir `Person.username` de `Club.username`, así que el mapa no
 * define claves sin modelo y el conflicto sale con el texto genérico: es
 * preferible a atribuirle el mensaje del modelo equivocado.
 *
 * No hay compatibilidad con nombres de índice: ninguna de estas claves lo es.
 * Si un motor informara el nombre del índice en `target`, entraría aquí
 * normalizado como clave simple y no coincidiría con nada — el conflicto
 * seguiría saliendo como 409 genérico, nunca como error interno.
 */
export function uniqueConflictKeys(meta?: { target?: string[] | string; modelName?: string }): string[] {
  const columnas = normalizeTarget(meta?.target);
  if (!columnas) return [];
  return meta?.modelName ? [`${meta.modelName}.${columnas}`, columnas] : [columnas];
}

/**
 * Devuelve el error de dominio equivalente, o `null` si no es un error de
 * Prisma reconocido (en cuyo caso corresponde tratarlo como error interno).
 */
export function translatePrismaError(err: unknown): AppError | null {
  if (!isPrismaKnownError(err)) return null;

  switch (err.code) {
    case "P2002": {
      // Violación de restricción única.
      const claves = uniqueConflictKeys(err.meta);
      const specific = claves.map((k) => UNIQUE_CONFLICT_MESSAGES[k]).find((m) => m !== undefined);
      return new ConflictError(specific ?? "Ya existe un registro con esos datos.", claves[0] ? { constraint: claves[0] } : undefined);
    }

    case "P2003":
      // Clave foránea: se referencia algo que no existe, o se intenta borrar
      // algo referenciado (por ejemplo, una prueba de competencia con
      // inscripciones, ahora protegida con ON DELETE RESTRICT).
      return new ConflictError("La operación afecta a registros relacionados y no puede completarse. Revise los datos vinculados.");

    case "P2014":
      // Violación de una relación requerida: el cambio dejaría huérfano un
      // registro que depende de este.
      return new ConflictError("La operación rompería un vínculo obligatorio entre registros.");

    case "P2025":
      return new NotFoundError("El registro");

    case "P2034":
      // Conflicto de escritura o interbloqueo bajo aislamiento serializable:
      // dos solicitudes intentaron a la vez algo que no puede coexistir.
      return new ConflictError("Otra operación modificó estos datos al mismo tiempo. Vuelva a intentarlo.");

    /**
     * P2028 — «Transaction API error». UN SOLO CÓDIGO PARA VARIAS COSAS
     * DISTINTAS, y por eso no se traduce en bloque.
     *
     * Prisma lo emite al menos en estas situaciones:
     *
     *   - no se consiguió una conexión libre para ABRIR la transacción dentro
     *     del plazo de espera (`maxWait`). Es saturación pasajera: nada está
     *     roto y reintentar tiene sentido;
     *   - la transacción ya abierta agotó SU plazo (`timeout`) y quedó
     *     expirada, o se intentó usar una transacción cerrada o desconocida.
     *     Eso no es carga: es una operación que tardó más de lo previsto o un
     *     uso indebido del cliente, y reintentarlo a ciegas no lo arregla.
     *
     * Solo el primero se reconoce aquí. El resto se deja sin traducir a
     * propósito, para que caiga en el 500 genérico y quede REGISTRADO como
     * error: es lo que hay que ir a mirar, no algo que el usuario deba
     * reintentar. La respuesta al usuario no cambia de forma en ningún caso
     * —nunca lleva el mensaje del motor—, lo que cambia es la clasificación.
     *
     * El plazo agotado al abrir se observó de verdad: al probar la
     * concurrencia entre la casilla de administrador y la creación de
     * credenciales, con el conjunto de conexiones todavía frío, la segunda
     * operación no alcanzaba a abrir su transacción. Salía cruda, como error
     * interno.
     *
     * P2034 sigue siendo el conflicto CONCURRENTE propiamente dicho —dos
     * transacciones que no pueden coexistir—, y se distingue de esto tanto en
     * el estado como en el mensaje.
     */
    case "P2028":
      return /unable to start a transaction/i.test(err.message ?? "")
        ? new ServiceUnavailableError(
            "El sistema no pudo atender la operación en este momento. Intente nuevamente en unos instantes."
          )
        : null;

    case "P2000":
      // Valor más largo que la columna. Es un dato del cliente, no una falla
      // del sistema: salía como 500 y el usuario no sabía qué campo acortar.
      return new ValidationError("Uno de los valores enviados excede el largo máximo permitido.");

    case "P2011":
      // Violación de NOT NULL: falta un dato obligatorio que el esquema de
      // entrada no alcanzó a exigir.
      return new ValidationError("Falta un dato obligatorio para completar la operación.");

    /**
     * Errores de CONEXIÓN a la base (clase P1xxx). No son un 500: la
     * aplicación está bien, lo que no responde es la base. Un 503 le dice al
     * cliente —y a cualquier balanceador o sonda— que reintentar tiene
     * sentido, mientras que un 500 sugiere un defecto que reintentar no
     * arregla. Se emparejan con la sonda de disponibilidad de `/ready`.
     */
    case "P1000": // autenticación contra la base rechazada
    case "P1001": // no se puede alcanzar el servidor
    case "P1002": // tiempo de espera agotado al conectar
    case "P1008": // tiempo de espera agotado en la operación
    case "P1017": // el servidor cerró la conexión
      return new ServiceUnavailableError();

    default:
      return null;
  }
}

/**
 * Ejecuta una operación traduciendo los errores de Prisma. Se usa donde la
 * regla de negocio se garantiza con una restricción de base de datos y el
 * mensaje al usuario debe ser el de la regla, no el del motor.
 *
 * Las claves de `overrides` son las mismas de `UNIQUE_CONFLICT_MESSAGES`:
 * `Modelo.columna[,columna...]`, nunca el nombre del índice.
 */
export async function withTranslatedPrismaErrors<T>(operation: () => Promise<T>, overrides?: Record<string, AppError>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (isPrismaKnownError(err) && overrides) {
      for (const clave of uniqueConflictKeys(err.meta)) {
        const override = overrides[clave];
        if (override) throw override;
      }
    }
    const translated = translatePrismaError(err);
    if (translated) throw translated;
    throw err;
  }
}

export { ValidationError };
