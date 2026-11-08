import { prisma } from "../../shared/prisma.client";
import { NotFoundError } from "../../shared/errors";
import { computeEffectiveStatus, type CompetitionStatus } from "./competitions.rules";

/**
 * Quién puede ver una competencia en Borrador o Programada (auditoría AUD-07).
 *
 * La regla vigente: esas competencias son solo del administrador. `GET /competitions` y
 * `GET /competitions/:id` ya la aplicaban —el detalle responde 404 y no 403, para no revelar
 * siquiera que existe—, pero los endpoints que cuelgan de la competencia no: sus pruebas
 * asignadas, su capacidad, la elegibilidad de nadadores, los reportes y la exportación a Team
 * Manager respondían a cualquier usuario con el permiso, bastándole el identificador.
 *
 * Este módulo es el criterio ÚNICO. Lo aplican todos los endpoints secundarios, de modo que
 * una competencia oculta lo está en todos ellos o en ninguno.
 *
 *  - El estado es el EFECTIVO (`computeEffectiveStatus`, una función pura): una competencia
 *    guardada como «programada» cuya inscripción ya abrió por fecha ES visible, igual que en el
 *    detalle. No se persiste nada: `applyAutoStatus` sigue siendo el único que escribe, y se
 *    conserva donde ya estaba.
 *  - El administrador ve todas, sin consultar nada.
 *  - `visibleInRegistrationPanels` NO interviene. Esa casilla solo decide qué competencias
 *    aparecen en los DESPLEGABLES de los paneles; no es un permiso. Una competencia abierta
 *    pero oculta en los paneles sigue siendo accesible por estos endpoints.
 *  - Para quien no es administrador, una competencia inexistente y una oculta responden lo
 *    mismo (404): si no, la diferencia entre «lista vacía» y «404» sería un oráculo.
 */

/** Lo que hace falta para decidir: el estado guardado y la ventana de inscripción. */
export interface CompetenciaConEstado {
  status: string;
  registrationStartAt: Date;
  registrationEndAt: Date;
}

/** Del actor, solo importa si es administrador. */
export interface QuienConsulta {
  isAdmin: boolean;
}

/** ¿El actor puede ver esta competencia, según su estado efectivo? Función pura: no escribe. */
export function competenciaVisiblePara(competencia: CompetenciaConEstado, actor: QuienConsulta, ahora: Date = new Date()): boolean {
  if (actor.isAdmin) return true;
  const efectivo = computeEffectiveStatus(competencia.status as CompetitionStatus, competencia.registrationStartAt, competencia.registrationEndAt, ahora);
  return efectivo !== "draft" && efectivo !== "scheduled";
}

/** Para quien YA tiene la competencia cargada: lanza el mismo 404 que el detalle. */
export function exigirCompetenciaVisible(competencia: CompetenciaConEstado, actor: QuienConsulta): void {
  if (!competenciaVisiblePara(competencia, actor)) throw new NotFoundError("Competencia");
}

/** Para quien solo tiene el identificador. El administrador pasa sin consultar. */
export async function exigirCompetenciaVisiblePorId(competitionId: string, actor: QuienConsulta): Promise<void> {
  if (actor.isAdmin) return;
  const competencia = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: { status: true, registrationStartAt: true, registrationEndAt: true },
  });
  if (!competencia) throw new NotFoundError("Competencia");
  exigirCompetenciaVisible(competencia, actor);
}
