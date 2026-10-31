import { api } from "../../shared/apiClient";

export type AssignmentStatus = "pending" | "active" | "rejected" | "ended";

export interface ClubSwimmerAssignment {
  id: string;
  clubId: string;
  personId: string;
  status: AssignmentStatus;
  requestedByUserId: string;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  /**
   * Fecha EFECTIVA de inicio, como fecha de CALENDARIO.
   *
   * El servidor la guarda en una columna `DATE` y Prisma la serializa como
   * medianoche UTC (`"2026-10-30T00:00:00.000Z"`). **Nunca pasarla por
   * `new Date(...).toLocaleDateString()`**: al oeste de Greenwich eso muestra el
   * día ANTERIOR. Se formatea con `formatearFechaCalendario`.
   */
  startDate: string | null;
  endDate: string | null;
  club: { id: string; name: string };
  person: { id: string; fullName: string; run: string };
}

export interface AssignmentListResult {
  items: ClubSwimmerAssignment[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SwimmerForBulkAssign {
  id: string;
  fullName: string;
  run: string;
  gender: "male" | "female";
  birthDate: string;
}

export interface BulkAssignRowResult {
  personId: string;
  fullName: string;
  status: "assigned" | "error";
  error?: string;
}
export interface BulkAssignSummary {
  totalCount: number;
  assignedCount: number;
  errorCount: number;
  results: BulkAssignRowResult[];
}

export function useSwimmerAssignmentApi() {
  return {
    list: (params: { clubId?: string; personId?: string; status?: AssignmentStatus; page?: number; pageSize?: number } = {}) => {
      const qs = new URLSearchParams();
      if (params.clubId) qs.set("clubId", params.clubId);
      if (params.personId) qs.set("personId", params.personId);
      if (params.status) qs.set("status", params.status);
      if (params.page) qs.set("page", String(params.page));
      if (params.pageSize) qs.set("pageSize", String(params.pageSize));
      return api.get<AssignmentListResult>(`/swimmer-assignments?${qs}`);
    },

    propose: (clubId: string, personId: string) =>
      api.post<ClubSwimmerAssignment>(`/swimmer-assignments`, { clubId, personId }),

    /** Asignación directa (solo admin): queda activa de inmediato, sin pasar por "pendiente". */
    assignDirectly: (clubId: string, personId: string, fechaEfectiva?: string) =>
      api.post<ClubSwimmerAssignment>(`/swimmer-assignments/direct`, { clubId, personId, fechaEfectiva }),

    /** `fechaEfectiva` en AAAA-MM-DD; sin ella, el servidor usa hoy en Chile. */
    approve: (id: string, fechaEfectiva?: string) =>
      api.post<ClubSwimmerAssignment>(`/swimmer-assignments/${id}/approve`, { fechaEfectiva }),

    reject: (id: string, reason?: string) =>
      api.post<ClubSwimmerAssignment>(`/swimmer-assignments/${id}/reject`, { reason }),

    end: (id: string) =>
      api.post<ClubSwimmerAssignment>(`/swimmer-assignments/${id}/end`),

    // ---------- Asignación masiva ----------

    /** `clubFilter`: ID de un club, o "none" para nadadores sin club asignado. */
    listSwimmersByClub: (clubFilter: string, search?: string) => {
      const qs = new URLSearchParams({ clubFilter });
      if (search) qs.set("search", search);
      return api.get<SwimmerForBulkAssign[]>(`/swimmer-assignments/swimmers-by-club?${qs}`);
    },

    /**
     * `fechaEfectiva` (AAAA-MM-DD) se aplica a TODA la tanda: una sola fecha
     * para todas las membresías, no el instante de cada escritura.
     */
    bulkAssign: (targetClubId: string, personIds: string[], fechaEfectiva?: string) =>
      api.post<BulkAssignSummary>(`/swimmer-assignments/bulk-assign`, { targetClubId, personIds, fechaEfectiva }),

    /** Club actual del nadador (null si no tiene ninguno activo). */
    getCurrentClub: (personId: string) =>
      api.get<(ClubSwimmerAssignment & { club: { id: string; name: string } }) | null>(`/swimmer-assignments/current-club/${personId}`),

    /** Cambia de club en un solo paso (finaliza el anterior si existía). */
    reassign: (personId: string, newClubId: string, fechaEfectiva?: string) =>
      api.post<ClubSwimmerAssignment>(`/swimmer-assignments/reassign/${personId}`, { newClubId, fechaEfectiva }),
  };
}
