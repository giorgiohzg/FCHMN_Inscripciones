import { api } from "../../shared/apiClient";

export type CompetitionStatus = "draft" | "scheduled" | "open" | "closed" | "in_progress" | "finished" | "cancelled";

export interface SessionType {
  id: string;
  name: string;
}
export interface SessionLimit {
  maxIndividualEvents: number | null;
  maxRelayEvents: number | null;
}
export interface CompetitionSession {
  id: string;
  sessionTypeId: string;
  sessionType: SessionType;
  limit: SessionLimit | null;
}
export interface CompetitionDate {
  id: string;
  date: string;
  sessions: CompetitionSession[];
}
export interface MeetImportSummary {
  competitionId: string;
  competitionName: string;
  eventsImported: number;
  eventsSkipped: number;
  sessionsCreated: number;
  warnings: string[];
}

export interface Competition {
  id: string;
  name: string;
  description: string | null;
  status: CompetitionStatus;
  registrationStartAt: string;
  registrationEndAt: string;
  ageCutoffDate: string | null;
  maxIndividualEventsPerSwimmer: number | null;
  /** Máximo de relevos por nadador y jornada (por defecto 1). 0 = sin relevos. */
  maxRelayEventsPerSwimmerPerSession: number;
  poolId: string | null;
  pool?: { id: string; name: string; address: string | null; isHeated: boolean; isCovered: boolean; courseLength: "short_25m" | "long_50m" } | null;
  dates: CompetitionDate[];
}
export interface CompetitionListResult {
  items: Competition[];
  total: number;
  page: number;
  pageSize: number;
}
export interface CompetitionEventItem {
  id: string;
  eventId: string;
  competitionSessionId: string;
  status: "enabled" | "disabled";
  displayOrder: number | null;
  event: { id: string; testTypeId: string; distance: { meters: number }; stroke: { name: string }; gender: "male" | "female" | "mixed"; testType: { name: string; swimmersCount: number } };
  competitionSession: { id: string; sessionType: { name: string }; competitionDate: { date: string } };
  enabledCategories: { category: { id: string; name: string; categoryGroup: { id: string; name: string } | null } }[];
}

export function useCompetitionsApi() {

  return {
    list: (params: { search?: string; status?: CompetitionStatus; page?: number; pageSize?: number } = {}) => {
      const qs = new URLSearchParams();
      if (params.search) qs.set("search", params.search);
      if (params.status) qs.set("status", params.status);
      if (params.page) qs.set("page", String(params.page));
      if (params.pageSize) qs.set("pageSize", String(params.pageSize));
      return api.get<CompetitionListResult>(`/competitions?${qs}`);
    },

    get: (id: string) => api.get<Competition>(`/competitions/${id}`),

    create: (input: {
      name: string;
      description?: string;
      registrationStartAt: string;
      registrationEndAt: string;
      ageCutoffDate: string;
      maxIndividualEventsPerSwimmer: number;
      maxRelayEventsPerSwimmerPerSession: number;
      poolId?: string;
    }) => api.post<Competition>(`/competitions`, input),

    update: (
      id: string,
      input: Partial<{
        name: string;
        description: string;
        registrationStartAt: string;
        registrationEndAt: string;
        ageCutoffDate: string;
        maxIndividualEventsPerSwimmer: number;
        maxRelayEventsPerSwimmerPerSession: number;
        poolId: string | null;
      }>
    ) => api.put<Competition>(`/competitions/${id}`, input),

    remove: (id: string) =>
      api.delete<void>(`/competitions/${id}`),

    duplicate: (id: string, input: { name: string; registrationStartAt: string; registrationEndAt: string; ageCutoffDate?: string }) =>
      api.post<Competition>(`/competitions/${id}/duplicate`, input),

    transition: (id: string, action: "schedule" | "cancel" | "closeRegistrations" | "start" | "finish") =>
      api.post<Competition>(`/competitions/${id}/${action}`),

    addDate: (id: string, date: string) =>
      api.post<CompetitionDate>(`/competitions/${id}/dates`, { date }),
    removeDate: (dateId: string) =>
      api.delete<void>(`/competition-dates/${dateId}`),

    listSessionTypes: () => api.get<SessionType[]>(`/catalogs/session-types`),
    addSession: (dateId: string, sessionTypeId: string) =>
      api.post<CompetitionSession>(`/competition-dates/${dateId}/sessions`, { sessionTypeId }),
    removeSession: (sessionId: string) =>
      api.delete<void>(`/competition-sessions/${sessionId}`),
    setSessionLimit: (sessionId: string, input: SessionLimit) =>
      api.put<SessionLimit>(`/competition-sessions/${sessionId}/limit`, input),

    listCompetitionEvents: (competitionId: string) =>
      api.get<CompetitionEventItem[]>(`/competitions/${competitionId}/events`),
    addCompetitionEvent: (competitionId: string, input: { eventId: string; competitionSessionId: string; categoryIds: string[]; displayOrder?: number }) =>
      api.post<CompetitionEventItem>(`/competitions/${competitionId}/events`, input),
    removeCompetitionEvent: (ceId: string) =>
      api.delete<void>(`/competition-events/${ceId}`),

    updateCompetitionEvent: (ceId: string, input: { competitionSessionId?: string; status?: "enabled" | "disabled"; categoryIds?: string[]; displayOrder?: number }) =>
      api.put<CompetitionEventItem>(`/competition-events/${ceId}`, input),

    // Renumera VARIAS pruebas en una sola solicitud (en vez de una por
    // cada una) — evita disparar decenas de solicitudes en paralelo al
    // mover una prueba entre jornadas/fechas en una competencia grande.
    reorderCompetitionEvents: (updates: { id: string; displayOrder: number }[]) =>
      api.put<{ updated: number }>(`/competition-events/reorder`, { updates }),

    // ---------- Importación desde Team Manager (Meet Manager) ----------
    importFromMeetEvents: (file: File, maxIndividualEventsPerSwimmer: number) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("maxIndividualEventsPerSwimmer", String(maxIndividualEventsPerSwimmer));
      return api.post<MeetImportSummary>(`/competitions/import-meet-events`, formData);
    },
  };
}
