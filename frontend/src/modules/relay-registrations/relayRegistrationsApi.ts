import { api } from "../../shared/apiClient";

export interface RelayRegistrationItem {
  id: string;
  status: "confirmed" | "cancelled";
  isPostCloseException?: boolean;
  seedTimeCentiseconds: number | null;
  club: { id: string; name: string };
  category: { id: string; name: string };
  competitionEvent: {
    competition?: { id: string; name: string };
    event: { distance: { meters: number }; stroke: { name: string }; testType: { name: string; swimmersCount: number }; gender: "male" | "female" | "mixed" };
    competitionSession: { sessionType: { name: string }; competitionDate: { date: string } };
  };
  members: { orderPosition: number; person: { id: string; fullName: string; run: string } }[];
}

export function useRelayRegistrationsApi() {

  return {
    create: (input: { competitionEventId: string; clubId: string; personIds: string[]; seedTimeCentiseconds?: number }) =>
      api.post<RelayRegistrationItem>(`/relay-registrations`, input),

    update: (id: string, input: { seedTimeCentiseconds?: number | null; personIds?: string[] }) =>
      api.put<RelayRegistrationItem>(`/relay-registrations/${id}`, input),

    /** Pagina en el servidor igual que `/registrations`: ver la nota de allí. */
    list: (
      params: {
        competitionId?: string;
        clubId?: string;
        status?: "confirmed" | "cancelled";
        page?: number;
        pageSize?: number;
      } = {}
    ) => {
      const qs = new URLSearchParams();
      if (params.competitionId) qs.set("competitionId", params.competitionId);
      if (params.clubId) qs.set("clubId", params.clubId);
      if (params.status) qs.set("status", params.status);
      if (params.page) qs.set("page", String(params.page));
      if (params.pageSize) qs.set("pageSize", String(params.pageSize));
      return api.get<{ items: RelayRegistrationItem[]; total: number; page: number; pageSize: number }>(
        `/relay-registrations?${qs}`
      );
    },

    cancel: (id: string) => api.post<RelayRegistrationItem>(`/relay-registrations/${id}/cancel`),
  };
}
