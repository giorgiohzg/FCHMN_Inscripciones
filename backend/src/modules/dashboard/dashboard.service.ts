import { prisma } from "../../shared/prisma.client";
import { computeEffectiveStatus } from "../competitions/competitions.rules";

/**
 * Sección 21: "El dashboard del administrador debe mostrar: número de
 * clubes, número de nadadores, número de competencias activas,
 * inscripciones abiertas, cantidad de nadadores inscritos por competencia."
 */
export async function getDashboardStats() {
  const [clubCount, swimmerCount, competitions] = await Promise.all([
    prisma.club.count({ where: { deletedAt: null, status: "active" } }),
    prisma.person.count({ where: { deletedAt: null, roles: { some: { roleType: "swimmer", active: true } } } }),
    prisma.competition.findMany(),
  ]);

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

  const registrationsByCompetition = await Promise.all(
    relevantCompetitions.map(async (c: { id: string; name: string; effectiveStatus: string }) => {
      const [individualCount, relayCount] = await Promise.all([
        prisma.registration.count({ where: { status: "confirmed", competitionEvent: { competitionId: c.id } } }),
        prisma.relayRegistration.count({ where: { status: "confirmed", competitionEvent: { competitionId: c.id } } }),
      ]);
      return {
        competitionId: c.id,
        competitionName: c.name,
        status: c.effectiveStatus,
        individualCount,
        relayTeamsCount: relayCount,
      };
    })
  );

  return {
    clubCount,
    swimmerCount,
    activeCompetitionsCount,
    openRegistrationsCount,
    registrationsByCompetition,
  };
}
