import type { Db } from "../../shared/transaction";
import { contarEquiposIncumplidores } from "../relay-registrations/relay-membership.rules";

/**
 * Cuántos equipos de relevo CONFIRMADOS de la competencia tienen algún integrante sin
 * inscripción individual confirmada en ella. Lectura pura: no escribe nada.
 *
 * Se muestra como aviso al activar la condición («exigir una individual para relevos»)
 * y en el detalle de la competencia. Cuenta EQUIPOS distintos, no integrantes.
 */
export async function contarEquiposDeRelevoIncumplidores(db: Db, competitionId: string): Promise<number> {
  const equipos = await db.relayRegistration.findMany({
    where: { status: "confirmed", competitionEvent: { competitionId } },
    select: { id: true, members: { select: { personId: true } } },
  });
  if (equipos.length === 0) return 0;

  const personIds = [...new Set(equipos.flatMap((e) => e.members.map((m) => m.personId)))];
  const conIndividual = await db.registration.findMany({
    where: { status: "confirmed", personId: { in: personIds }, competitionEvent: { competitionId } },
    select: { personId: true },
    distinct: ["personId"],
  });

  return contarEquiposIncumplidores(
    equipos.map((e) => ({ relayRegistrationId: e.id, personIds: e.members.map((m) => m.personId) })),
    new Set(conIndividual.map((r) => r.personId))
  );
}
