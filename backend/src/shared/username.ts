import { ValidationError } from "./errors";
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
        ...(options.excludePersonId ? { personId: { not: options.excludePersonId } } : {}),
        ...(options.excludeClubId ? { clubId: { not: options.excludeClubId } } : {}),
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
      `Los nombres de usuario son únicos entre personas, clubes y cuentas de acceso, y no se pueden cambiar después de crearlos.`,
    { username, conflictWith: dueno.kind }
  );
}
