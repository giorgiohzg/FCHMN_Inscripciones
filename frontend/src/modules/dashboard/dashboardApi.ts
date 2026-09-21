import { api } from "../../shared/apiClient";

export interface DashboardStats {
  clubCount: number;
  swimmerCount: number;
  activeCompetitionsCount: number;
  openRegistrationsCount: number;
  registrationsByCompetition: {
    competitionId: string;
    competitionName: string;
    status: string;
    individualCount: number;
    relayTeamsCount: number;
  }[];
}

export function useDashboardApi() {
  return {
    getStats: () =>
      api.get<DashboardStats>(`/dashboard/stats`),
  };
}
