import { ConflictError, ValidationError, type AppError } from "./errors";
import { dbFrom, type TxOption } from "./transaction";

/**
 * Este módulo resuelve la DISPONIBILIDAD de un nombre de usuario y usa Prisma.
 * El FORMATO vive en `username.schema.ts`, que es un módulo puro: quien solo
 * necesita validar la forma de una cadena no debe arrastrar un `PrismaClient`.
 */

/**
 * Disponibilidad de un nombre de usuario — ÚNICA fuente de verdad (hallazgo 20).
 *
 * El nombre de usuario identifica a quien entra al sistema, y hay tres tablas
 * que lo contienen: `persons.username`, `clubs.username` y `users.username`
 * (esta última es una copia del de su dueño, porque el nombre de usuario no es
 * editable después de crearlo). Cada módulo comprobaba solo SU tabla:
 *
 *   - Personas miraba `persons`, así que un club llamado "delfines" no impedía
 *     crear una persona "delfines"; el choque aparecía después, al crear las
 *     credenciales, con un mensaje que no decía dónde estaba el conflicto.
 *   - Clubes miraba `clubs`, con el problema simétrico.
 *   - La creación de credenciales miraba `users`, ya demasiado tarde: la
 *     persona o el club ya estaban creados y no se podían renombrar, porque el
 *     nombre de usuario es inmutable. La única salida era eliminar y rehacer.
 *
 * Esta función mira las tres a la vez, antes de escribir, y dice cuál es el
 * dueño del nombre. La garantía de verdad la da la base de datos con la tabla
 * de reservas `username_reservations` (migración `phase4_username_registry`);
 * esto existe para dar un mensaje entendible antes de llegar al índice.
 *
 * Solo cuentan las filas VIGENTES: al eliminar lógicamente una persona o un
 * club, su nombre de usuario queda libre otra vez, y con él el de su cuenta.
 */
export interface UsernameOwner {
  kind: "person" | "club" | "user";
  id: string;
}

export interface UsernameCheckOptions extends TxOption {
  /** Persona cuyo nombre de usuario NO cuenta como conflicto (edición). */
  excludePersonId?: string;
  /** Club cuyo nombre de usuario NO cuenta como conflicto (edición). */
  excludeClubId?: string;
}

const ETIQUETA: Record<UsernameOwner["kind"], string> = {
  person: "una persona",
  club: "un club",
  user: "una cuenta de acceso",
};

/** Devuelve quién tiene tomado el nombre de usuario, o `null` si está libre. */
export async function findUsernameOwner(username: string, options: UsernameCheckOptions = {}): Promise<UsernameOwner | null> {
  const db = dbFrom(options);

  const [persona, club, cuenta] = await Promise.all([
    db.person.findFirst({
      where: { username, deletedAt: null, ...(options.excludePersonId ? { id: { not: options.excludePersonId } } : {}) },
      select: { id: true },
    }),
    db.club.findFirst({
      where: { username, deletedAt: null, ...(options.excludeClubId ? { id: { not: options.excludeClubId } } : {}) },
      select: { id: true },
    }),
    db.user.findFirst({
      where: {
        username,
        deletedAt: null,
        /**
         * Se excluye SOLO la cuenta del propio titular, y con el caso NULL
         * explícito. `{ personId: { not: id } }` —y también `NOT`— se traduce a
         * una comparación que en SQL es NULL, y por lo tanto falsa, para toda
         * cuenta sin persona: las del sistema y las de los clubes. Al excluir a
         * una persona se dejaban fuera, sin querer, todas esas cuentas, y su
         * nombre parecía libre. Lo detectó la etapa 9 al probar la colisión con
         * la cuenta del administrador; la base lo rechazaba igual, pero con un
         * error sin explicación.
         */
        AND: [
          ...(options.excludePersonId ? [{ OR: [{ personId: null }, { personId: { not: options.excludePersonId } }] }] : []),
          ...(options.excludeClubId ? [{ OR: [{ clubId: null }, { clubId: { not: options.excludeClubId } }] }] : []),
        ],
      },
      select: { id: true },
    }),
  ]);

  if (persona) return { kind: "person", id: persona.id };
  if (club) return { kind: "club", id: club.id };
  if (cuenta) return { kind: "user", id: cuenta.id };
  return null;
}

/** Lanza `ValidationError` si el nombre de usuario ya está tomado. */
export async function assertUsernameAvailable(username: string, options: UsernameCheckOptions = {}): Promise<void> {
  const dueno = await findUsernameOwner(username, options);
  if (!dueno) return;

  throw new ValidationError(
    `El nombre de usuario "${username}" ya está en uso por ${ETIQUETA[dueno.kind]}. ` +
      `Los nombres de usuario son únicos entre personas, clubes y cuentas de acceso, y no se pueden cambiar una vez creadas las credenciales.`,
    { username, conflictWith: dueno.kind }
  );
}

/**
 * ¿Tiene el titular una cuenta de acceso VIGENTE?
 *
 * Vigente = no eliminada lógicamente, cualquiera sea su estado: una cuenta
 * bloqueada o inhabilitada sigue llamándose así y puede volver a activarse,
 * así que también bloquea el nombre. Es el mismo criterio que aplica
 * `titular_forbid_rename_con_cuenta` en la base.
 */
export async function tieneCuentaVigente(titular: { personId: string } | { clubId: string }, options: TxOption = {}): Promise<boolean> {
  const cuenta = await dbFrom(options).user.findFirst({ where: { ...titular, deletedAt: null }, select: { id: true } });
  return cuenta !== null;
}

/** Crear credenciales sin nombre guardado ni enviado: 400, sin escribir. */
export const MENSAJE_FALTA_USERNAME =
  "Indique un nombre de usuario para crear las credenciales: el titular todavía no tiene uno. " +
  "Solo letras, números, puntos, guiones y guiones bajos, de 4 a 30 caracteres.";

export const MENSAJE_NOMBRE_BLOQUEADO =
  "El nombre de usuario ya no se puede cambiar: las credenciales de acceso se crearon con él y es el nombre con el que se entra al sistema.";

/**
 * Traduce las excepciones que lanzan los DISPARADORES de identidad.
 *
 * Las comprobaciones del servicio dan el mensaje en el caso normal, pero no
 * pueden ver lo que otra transacción todavía no confirmó: en una carrera, quien
 * decide es la base (`username_registry_reserve`, `titular_forbid_rename_con_cuenta`,
 * `users_username_igual_al_titular`). Sin esto, ese rechazo —correcto— llegaba
 * al usuario como error interno. Los textos que se reconocen son los de las
 * propias migraciones del proyecto, no del motor.
 */
export function traducirErrorDeIdentidad(err: unknown): AppError | null {
  const mensaje = err instanceof Error ? err.message : "";
  /**
   * La reserva lanza `unique_violation` desde un disparador, y Prisma lo
   * entrega como P2002 SIN columnas (`target: null`) y sin el texto del
   * disparador —verificado contra PostgreSQL—. Un índice único real siempre
   * informa sus columnas, así que `target` nulo en una persona, un club o una
   * cuenta identifica este caso sin confundirlo con otros conflictos.
   */
  const conocido = err as { code?: string; meta?: { target?: unknown; modelName?: string } };
  const esReserva =
    conocido?.code === "P2002" &&
    (conocido.meta?.target === null || conocido.meta?.target === undefined) &&
    ["Person", "Club", "User"].includes(conocido.meta?.modelName ?? "");
  if (esReserva || mensaje.includes("ya está en uso por otro titular")) {
    return new ConflictError("Ese nombre de usuario acaba de ser tomado por otro titular. Elija otro y vuelva a intentarlo.");
  }
  if (mensaje.includes("tiene una cuenta de acceso vigente")) {
    return new ConflictError(MENSAJE_NOMBRE_BLOQUEADO);
  }
  if (mensaje.includes("debe ser el de su titular")) {
    return new ConflictError("El nombre de usuario cambió mientras se creaban las credenciales. Recargue la ficha y vuelva a intentarlo.");
  }
  return null;
}

/** Ejecuta la operación traduciendo los rechazos de los disparadores de identidad. */
export async function conErroresDeIdentidad<T>(operacion: () => Promise<T>): Promise<T> {
  try {
    return await operacion();
  } catch (err) {
    const traducido = traducirErrorDeIdentidad(err);
    if (traducido) throw traducido;
    throw err;
  }
}
