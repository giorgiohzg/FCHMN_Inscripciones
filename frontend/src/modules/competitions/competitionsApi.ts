import { api } from "../../shared/apiClient";

// individual_closed — «Inscripciones individuales cerradas»: se alcanzó el
// cupo global. Las individuales quedan cerradas para quien no sea
// administrador; los relevos siguen abiertos.
export type CompetitionStatus =
  | "draft"
  | "scheduled"
  | "open"
  | "individual_closed"
  | "closed"
  | "in_progress"
  | "finished"
  | "cancelled";

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

/**
 * Una opción de tipo de relevo para UNA prueba, con su consecuencia ya
 * calculada: `etiqueta` dice cómo quedará la distancia ("4×50" para 200 m en
 * cuatro postas). La calcula el backend para que la pantalla no tenga que
 * repetir la aritmética ni pueda mostrar algo distinto de lo que se guardará.
 */
export interface RelayTypeOption {
  testTypeId: string;
  nombre: string;
  swimmersCount: number;
  etiqueta: string;
  divisible: boolean;
}

/**
 * Una prueba de relevo pendiente de confirmar.
 *
 * Viene una por prueba y NO agrupada por distancia/estilo/género: dos relevos
 * pueden coincidir en los tres y aun así ser distintos (un 4×50 y un 2×100 son
 * ambos "200 Libre damas"), así que agruparlos le impondría a uno la decisión
 * del otro.
 */
export interface RelayToConfirm {
  eventNumber: number;
  distanceMeters: number;
  strokeName: string;
  gender: "male" | "female" | "mixed";
  opciones: RelayTypeOption[];
}

export type RelayDecision =
  | { eventNumber: number; decision: "tipo"; testTypeId: string }
  | { eventNumber: number; decision: "omitir" };

export interface MeetAnalysis {
  /** Ata las decisiones al archivo analizado; se devuelve tal cual al importar. */
  fileHash: string;
  formato: "zip" | "ev3" | "hyv";
  competitionName: string;
  startDate: string;
  endDate: string;
  ageCutoffDate: string;
  dayCount: number;
  eventsTotal: number;
  relevos: RelayToConfirm[];
  requiereConfirmacionDeRelevos: boolean;
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
  /** Cupo de nadadores distintos en toda la competencia. null = sin límite. */
  maxSwimmers: number | null;
  /** Cupo de nadadores distintos por club. null = sin límite. */
  maxSwimmersPerClub: number | null;
  /** Por qué se cerraron las inscripciones. null = abierta, o cerrada antes de existir este campo. */
  registrationsClosedReason: "manual" | "capacity" | "schedule" | null;
  registrationsClosedAt: string | null;
  poolId: string | null;
  pool?: { id: string; name: string; address: string | null; isHeated: boolean; isCovered: boolean; courseLength: "short_25m" | "long_50m" } | null;
  dates: CompetitionDate[];
}
export interface CompetitionCapacityByClub {
  clubId: string;
  clubName: string;
  swimmers: number;
  remaining: number | null;
  isFull: boolean;
}
export interface CompetitionCapacity {
  maxSwimmers: number | null;
  maxSwimmersPerClub: number | null;
  totalSwimmers: number;
  remainingSwimmers: number | null;
  isFull: boolean;
  byClub: CompetitionCapacityByClub[];
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
      maxSwimmers?: number | null;
      maxSwimmersPerClub?: number | null;
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
        maxSwimmers: number | null;
        maxSwimmersPerClub: number | null;
        poolId: string | null;
      }>
    ) => api.put<Competition>(`/competitions/${id}`, input),

    remove: (id: string) =>
      api.delete<void>(`/competitions/${id}`),

    duplicate: (id: string, input: { name: string; registrationStartAt: string; registrationEndAt: string; ageCutoffDate?: string }) =>
      api.post<Competition>(`/competitions/${id}/duplicate`, input),

    transition: (id: string, action: "schedule" | "cancel" | "closeRegistrations" | "start" | "finish") =>
      api.post<Competition>(`/competitions/${id}/${action}`),

    /**
     * Reapertura DELIBERADA de inscripciones.
     *
     * Va aparte de `transition` porque no es una transición más: el backend
     * comprueba además que las fechas sigan vigentes y que el cupo no esté
     * alcanzado, y responde con el motivo concreto si falta alguna.
     */
    reopenRegistrations: (id: string) =>
      api.post<Competition>(`/competitions/${id}/reopenRegistrations`),

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

    /**
     * Cupos y uso actual. El backend recorta `byClub` al alcance del actor:
     * un administrador ve todos los clubes, un club solo el suyo.
     */
    getCapacity: (competitionId: string) =>
      api.get<CompetitionCapacity>(`/competitions/${competitionId}/capacity`),

    // ---------- Importación desde Team Manager (Meet Manager) ----------

    /**
     * FASE 1 — analizar el archivo sin importar nada.
     *
     * Devuelve qué trae el archivo y, una por una, sus pruebas de relevo con
     * las opciones del catálogo. No crea nada: existe para poder decidir antes.
     */
    analyzeMeetEvents: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api.post<MeetAnalysis>(`/competitions/import-meet-events/analyze`, formData);
    },

    /**
     * FASE 2 — importar, con las decisiones de relevo tomadas sobre el
     * análisis.
     *
     * `confirmacion` es opcional porque un archivo sin relevos no necesita
     * ninguna; cuando hay relevos y falta, el backend rechaza la importación
     * en vez de elegir por su cuenta.
     */
    importFromMeetEvents: (
      file: File,
      maxIndividualEventsPerSwimmer: number,
      confirmacion?: { fileHash: string; decisiones: RelayDecision[] }
    ) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("maxIndividualEventsPerSwimmer", String(maxIndividualEventsPerSwimmer));
      if (confirmacion) formData.append("relayDecisions", JSON.stringify(confirmacion));
      return api.post<MeetImportSummary>(`/competitions/import-meet-events`, formData);
    },
  };
}
