import { api } from "../../shared/apiClient";

export interface EnabledCompetitionEvent {
  id: string;
  displayOrder: number | null;
  event: { id: string; distance: { meters: number }; stroke: { name: string }; testType: { name: string; swimmersCount: number }; gender: "male" | "female" | "mixed" };
  competitionSession: { id: string; sessionType: { name: string }; competitionDate: { date: string } };
  enabledCategories: { category: { id: string; name: string; minAge: number; maxAge: number } }[];
}

export interface ClubEligibilityEntry {
  personId: string;
  fullName: string;
  run: string;
  gender: "male" | "female";
  eligibleEvents: { competitionEventId: string; categoryId: string; categoryName: string }[];
  registeredEventIds: string[];
}

export interface EligibleSwimmer {
  id: string;
  fullName: string;
  run: string;
  gender: "male" | "female";
  birthDate: string;
}

export interface AvailableIndividualEvent {
  competitionEventId: string;
  distanceMeters: number;
  strokeName: string;
  sessionTypeName: string;
  competitionDate: string;
  categoryId: string;
  categoryName: string;
}

export interface RegistrationItem {
  id: string;
  status: "confirmed" | "cancelled";
  isPostCloseException?: boolean;
  seedTimeCentiseconds: number | null;
  person: { id: string; fullName: string; firstName: string | null; paternalLastName: string | null; run: string };
  club: { id: string; name: string };
  category: { id: string; name: string };
  competitionEvent: {
    competition: { id: string; name: string; isRegistrationOpen: boolean };
    event: { distance: { meters: number }; stroke: { name: string }; testType: { name: string; swimmersCount: number }; gender: "male" | "female" | "mixed" };
    competitionSession: { sessionType: { name: string }; competitionDate: { date: string } };
  };
}

export function useRegistrationsApi() {

  return {
    listEnabledEvents: (competitionId: string) =>
      api.get<EnabledCompetitionEvent[]>(`/competitions/${competitionId}/enabled-events`),

    listEligibleSwimmers: (params: { clubId: string; competitionEventId: string; categoryId: string }) => {
      const qs = new URLSearchParams(params);
      return api.get<EligibleSwimmer[]>(`/registrations/eligible-swimmers?${qs}`);
    },

    /** Nadadores activos del club (nuevo orden de inscripción: sin depender todavía de ninguna prueba). */
    listClubSwimmers: (clubId: string) => {
      const qs = new URLSearchParams({ clubId });
      return api.get<EligibleSwimmer[]>(`/registrations/club-swimmers?${qs}`);
    },

    /** Todas las pruebas individuales disponibles para el nadador en esta competencia — la categoría ya viene resuelta. */
    listAvailableEvents: (competitionId: string, personId: string) => {
      const qs = new URLSearchParams({ competitionId, personId });
      return api.get<AvailableIndividualEvent[]>(`/registrations/available-events?${qs}`);
    },

    /** Panel de Inscripción (arrastrar y soltar): elegibilidad de todo el plantel del club de una vez. */
    listClubEligibilityMatrix: (competitionId: string, clubId: string) => {
      const qs = new URLSearchParams({ competitionId, clubId });
      return api.get<ClubEligibilityEntry[]>(`/registrations/club-eligibility-matrix?${qs}`);
    },

    create: (input: { competitionEventId: string; clubId: string; personId: string; seedTimeCentiseconds?: number }) =>
      api.post<RegistrationItem>(`/registrations`, input),

    update: (id: string, input: { seedTimeCentiseconds: number | null }) =>
      api.put<RegistrationItem>(`/registrations/${id}`, input),

    /**
     * `/registrations` PAGINA en el servidor: `pageSize` por omisión 50, máximo
     * 200 (`registrations.schemas.ts`). El cliente no enviaba `page` ni
     * `pageSize` y trataba `items` como la lista entera, así que una competencia
     * con más de 50 inscripciones confirmadas de un club mostraba solo las 50
     * primeras — sin aviso. Quien necesite el conjunto completo debe usar
     * `traerTodasLasPaginas` (ver `shared/paginacion.ts`).
     */
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
      return api.get<{ items: RegistrationItem[]; total: number; page: number; pageSize: number }>(`/registrations?${qs}`);
    },

    cancel: (id: string) => api.post<RegistrationItem>(`/registrations/${id}/cancel`),
  };
}
