import { api } from "../../shared/apiClient";

export interface DashboardStats {
  clubCount: number;
  /** Personas no eliminadas con rol de nadador activo; varones + damas = total. */
  swimmerCount: number;
  maleSwimmerCount: number;
  femaleSwimmerCount: number;
  activeCompetitionsCount: number;
  openRegistrationsCount: number;
  registrationsByCompetition: {
    competitionId: string;
    competitionName: string;
    status: string;
    /** Cantidad de INSCRIPCIONES individuales confirmadas (no de personas). */
    individualCount: number;
    /** Cantidad de EQUIPOS de relevo confirmados (no de personas). */
    relayTeamsCount: number;
    /** PERSONAS distintas inscritas (individual confirmada o integrante de relevo confirmado). */
    swimmersCount: number;
    maleSwimmersCount: number;
    femaleSwimmersCount: number;
  }[];
}

export function useDashboardApi() {
  return {
    getStats: () =>
      api.get<DashboardStats>(`/dashboard/stats`),
  };
}
