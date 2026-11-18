import { prisma } from "../../shared/prisma.client";
import { computeEffectiveStatus } from "../competitions/competitions.rules";

/**
 * Sección 21: "El dashboard del administrador debe mostrar: número de
 * clubes, número de nadadores, número de competencias activas,
 * inscripciones abiertas, cantidad de nadadores inscritos por competencia."
 *
 * TOTALES POR GÉNERO. Se cuentan por el sexo de la PERSONA (`persons.gender`, que solo admite
 * `male` y `female`), nunca por el género de la prueba: una prueba o un relevo mixto no crea una
 * tercera categoría. Cada total se calcula sobre el MISMO conjunto que sus dos subtotales, así
 * que varones + damas = total.
 */

/** Universo de «Nadadores registrados»: personas no eliminadas con rol de nadador activo. */
const NADADOR_REGISTRADO = { deletedAt: null, roles: { some: { roleType: "swimmer" as const, active: true } } };

export interface TotalesPorGenero {
  total: number;
  varones: number;
  damas: number;
}

function totalesDe(filas: readonly { gender: "male" | "female"; _count: { _all: number } }[]): TotalesPorGenero {
  const varones = filas.find((f) => f.gender === "male")?._count._all ?? 0;
  const damas = filas.find((f) => f.gender === "female")?._count._all ?? 0;
  return { total: varones + damas, varones, damas };
}

/**
 * Personas DISTINTAS inscritas en cada competencia, por sexo: con al menos una inscripción
 * individual confirmada o integrando un relevo confirmado (también quien solo nada relevos).
 * Es el mismo conjunto que cuentan los cupos (`readCapacityUsage`); una prueba de integración
 * compara ambos. El `UNION` (sin `ALL`) deja a cada persona una sola vez por competencia aunque
 * tenga varias pruebas o nade individuales y relevos. Es UNA sentencia: todas las competencias
 * se cuentan sobre la misma instantánea.
 */
export async function nadadoresInscritosPorGenero(competitionIds: readonly string[]): Promise<Map<string, TotalesPorGenero>> {
  const resultado = new Map<string, TotalesPorGenero>(competitionIds.map((id) => [id, { total: 0, varones: 0, damas: 0 }]));
  if (competitionIds.length === 0) return resultado;
  const ids = [...competitionIds];
  const filas = await prisma.$queryRaw<{ competition_id: string; gender: "male" | "female"; personas: number }[]>`
    WITH inscritos AS (
      SELECT ce.competition_id, r.person_id
        FROM registrations r
        JOIN competition_events ce ON ce.id = r.competition_event_id
       WHERE r.status = 'confirmed' AND ce.competition_id = ANY(${ids})
      UNION
      SELECT ce.competition_id, m.person_id
        FROM relay_registration_members m
        JOIN relay_registrations rr ON rr.id = m.relay_registration_id
        JOIN competition_events ce ON ce.id = rr.competition_event_id
       WHERE rr.status = 'confirmed' AND ce.competition_id = ANY(${ids})
    )
    SELECT i.competition_id, p.gender::text AS gender, count(*)::int AS personas
      FROM inscritos i
      JOIN persons p ON p.id = i.person_id
     GROUP BY i.competition_id, p.gender`;
  for (const f of filas) {
    const t = resultado.get(f.competition_id);
    if (!t) continue;
    if (f.gender === "male") t.varones = f.personas;
    else if (f.gender === "female") t.damas = f.personas;
    t.total = t.varones + t.damas;
  }
  return resultado;
}

export async function getDashboardStats() {
  const [clubCount, nadadoresPorGenero, competitions] = await Promise.all([
    prisma.club.count({ where: { deletedAt: null, status: "active" } }),
    prisma.person.groupBy({ by: ["gender"], where: NADADOR_REGISTRADO, _count: { _all: true } }),
    prisma.competition.findMany(),
  ]);
  const nadadores = totalesDe(nadadoresPorGenero);

  // Igual que en competitions.service: se aplica el auto-cómputo de
  // estado (RB-07) antes de contar, para que el dashboard nunca muestre
  // una competencia "abierta" cuya fecha de cierre ya pasó.
  const now = new Date();
  const withEffectiveStatus = competitions.map((c: { status: any; registrationStartAt: Date; registrationEndAt: Date; id: string; name: string }) => ({
    ...c,
    effectiveStatus: computeEffectiveStatus(c.status, c.registrationStartAt, c.registrationEndAt, now),
  }));

  const activeCompetitionsCount = withEffectiveStatus.filter((c: { effectiveStatus: string }) =>
    ["scheduled", "open", "in_progress"].includes(c.effectiveStatus)
  ).length;
  const openRegistrationsCount = withEffectiveStatus.filter((c: { effectiveStatus: string }) => c.effectiveStatus === "open").length;

  const relevantCompetitions = withEffectiveStatus.filter((c: { effectiveStatus: string }) =>
    ["scheduled", "open", "in_progress", "closed"].includes(c.effectiveStatus)
  );

  const inscritosPorCompetencia = await nadadoresInscritosPorGenero(relevantCompetitions.map((c: { id: string }) => c.id));

  const registrationsByCompetition = await Promise.all(
    relevantCompetitions.map(async (c: { id: string; name: string; effectiveStatus: string }) => {
      const [individualCount, relayCount] = await Promise.all([
        prisma.registration.count({ where: { status: "confirmed", competitionEvent: { competitionId: c.id } } }),
        prisma.relayRegistration.count({ where: { status: "confirmed", competitionEvent: { competitionId: c.id } } }),
      ]);
      const inscritos = inscritosPorCompetencia.get(c.id)!;
      return {
        competitionId: c.id,
        competitionName: c.name,
        status: c.effectiveStatus,
        // Cantidad de INSCRIPCIONES y de EQUIPOS (no de personas), como antes.
        individualCount,
        relayTeamsCount: relayCount,
        // PERSONAS distintas inscritas.
        swimmersCount: inscritos.total,
        maleSwimmersCount: inscritos.varones,
        femaleSwimmersCount: inscritos.damas,
      };
    })
  );

  return {
    clubCount,
    swimmerCount: nadadores.total,
    maleSwimmerCount: nadadores.varones,
    femaleSwimmerCount: nadadores.damas,
    activeCompetitionsCount,
    openRegistrationsCount,
    registrationsByCompetition,
  };
}
