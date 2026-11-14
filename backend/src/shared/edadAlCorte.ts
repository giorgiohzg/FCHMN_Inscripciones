/**
 * EDAD AL CORTE para PRESENTAR inscripciones y relevos ya existentes.
 *
 * Los paneles muestran la edad de cada inscrito a la fecha de corte de SU competencia. Antes la
 * tomaban del plantel activo, así que se perdía cuando la membresía terminaba pero la inscripción
 * seguía confirmada. Aquí se calcula desde los datos de la propia inscripción (persona y
 * competencia), con el mismo criterio y respaldo que las reglas: `computeAge` contra
 * `ageCutoffDate` o, si falta, `getDefaultAgeCutoffDate()`.
 *
 * Lee la fecha de nacimiento SOLO para calcular: el resultado es un número y la fecha no sale de
 * aquí. No cambia qué personas ve cada actor; eso lo siguen decidiendo los listados.
 */
import { prisma } from "./prisma.client";
import { computeAge, getDefaultAgeCutoffDate } from "./age.util";

export interface ParPersonaCompetencia {
  personId: string;
  competitionId: string;
}

/** Devuelve una función que da la edad al corte de cada par pedido (o `undefined` si falta un dato). */
export async function edadesAlCorte(pares: readonly ParPersonaCompetencia[]): Promise<(par: ParPersonaCompetencia) => number | undefined> {
  if (pares.length === 0) return () => undefined;
  const personIds = [...new Set(pares.map((p) => p.personId))];
  const competitionIds = [...new Set(pares.map((p) => p.competitionId))];
  const [personas, competencias] = await Promise.all([
    prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, birthDate: true } }),
    prisma.competition.findMany({ where: { id: { in: competitionIds } }, select: { id: true, ageCutoffDate: true } }),
  ]);
  const nacimiento = new Map(personas.map((p) => [p.id, p.birthDate]));
  const corte = new Map(competencias.map((c) => [c.id, c.ageCutoffDate ?? getDefaultAgeCutoffDate()]));
  return ({ personId, competitionId }) => {
    const n = nacimiento.get(personId);
    const c = corte.get(competitionId);
    return n && c ? computeAge(n, c) : undefined;
  };
}
