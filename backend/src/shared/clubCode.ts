import { ValidationError } from "./errors";
import { dbFrom, type TxOption } from "./transaction";

/**
 * LA SIGLA ES EL IDENTIFICADOR ÚNICO DEL CLUB.
 *
 * La garantía la da la base: el índice único parcial `clubs_code_unique_active`, sobre
 * `club_code_normalizado(code)`, entre los clubes NO eliminados lógicamente —incluidos
 * los inactivos—. Esta normalización y la de esa función SQL deben coincidir: sin
 * blancos a los lados y en mayúsculas.
 */
export function normalizarSigla(raw: string): string {
  return raw.trim().toUpperCase();
}

export interface ClubConSigla {
  id: string;
  name: string;
  code: string;
  status: string;
}

/** Mensaje del conflicto de sigla: el mismo para la comprobación y para la restricción de la base. */
export const MENSAJE_SIGLA_EN_USO = "Esa sigla ya está en uso por otro club. La sigla identifica al club y no se puede repetir, tampoco con un club inactivo.";

/**
 * Comprobación legible antes de escribir, al crear o editar un club.
 *
 * Solo da el mensaje claro: dos operaciones simultáneas pueden pasarla a la vez, y entonces
 * la garantía final es el índice único (ver `translatePrismaError`, que da el mismo mensaje).
 */
export async function assertSiglaDisponible(sigla: string, options: TxOption & { excludeClubId?: string } = {}): Promise<void> {
  const normalizada = normalizarSigla(sigla);
  const filas = await dbFrom(options).$queryRaw<ClubConSigla[]>`
    SELECT id, name, code, status::text AS status
      FROM clubs
     WHERE deleted_at IS NULL AND club_code_normalizado(code) = ${normalizada}`;
  const ajeno = filas.find((c) => c.id !== options.excludeClubId);
  if (!ajeno) return;
  const estado = ajeno.status === "active" ? "" : " (inactivo)";
  throw new ValidationError(
    `La sigla «${normalizada}» ya está en uso por el club «${ajeno.name}»${estado}. La sigla identifica al club y no se puede repetir, tampoco con un club inactivo.`,
    { code: normalizada, conflictWith: ajeno.id }
  );
}
