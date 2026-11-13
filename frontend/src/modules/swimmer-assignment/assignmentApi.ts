import { api, ApiError } from "../../shared/apiClient";

export type AssignmentStatus = "pending" | "active" | "rejected" | "ended";

/** Respuesta de `current-club`: únicamente el club al que pertenece hoy el nadador. */
export interface ClubActual {
  club: { id: string; name: string };
}

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
  /**
   * C-05: ÚLTIMO DÍA de pertenencia (fecha de calendario, inclusiva). Nula en una
   * finalizada = término DESCONOCIDO (membresías anteriores a C-05).
   */
  fechaTermino?: string | null;
  /**
   * INSTANTE en que se registró la operación que finalizó la membresía. **No** es una
   * fecha de pertenencia: nunca se muestra como «hasta» ni sustituye a `fechaTermino`.
   */
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
  /** C-05: código estable del rechazo de la fila (p. ej. `HISTORIAL_INCOMPLETO`). */
  codigo?: string;
}
export interface BulkAssignSummary {
  totalCount: number;
  assignedCount: number;
  errorCount: number;
  results: BulkAssignRowResult[];
}

/**
 * C-05: opciones de una ACTIVACIÓN (aprobar, reasignar, asignar directo, masiva, resolver un alta).
 * Todas se envían EXPRESAMENTE: la interfaz no las rellena por su cuenta.
 */
export interface OpcionesDeActivacion {
  /** `AAAA-MM-DD`, hoy o anterior en Santiago. */
  fechaEfectiva: string;
  /** Id de la membresía ACTIVA en otro club que administración confirmó finalizar. */
  confirmarFinDeMembresiaId?: string;
  /** Aceptación administrativa EXPLÍCITA de un historial con fechas desconocidas. */
  aceptarHistorialIncompleto?: boolean;
}

/** C-05: baja simple. `fechaTermino` es OBLIGATORIA; el servidor ya no elige una. */
export interface DatosDeBaja {
  fechaTermino: string;
  aceptarHistorialIncompleto?: boolean;
}

/** Códigos estables de C-05 con los que la interfaz decide (nunca por el texto). */
export const CODIGOS = {
  confirmacionRequerida: "CONFIRMACION_REQUERIDA",
  revisarDeNuevo: "REVISAR_DE_NUEVO",
  historialIncompleto: "HISTORIAL_INCOMPLETO",
  conflictoDeFechas: "CONFLICTO_DE_FECHAS",
  fechaFutura: "FECHA_FUTURA",
  membresiaNoActiva: "MEMBRESIA_NO_ACTIVA",
  yaPertenece: "YA_PERTENECE",
  solicitudYaResuelta: "SOLICITUD_YA_RESUELTA",
} as const;

/** `details.conflictos` de un 409 `CONFLICTO_DE_FECHAS`, validado; vacío si no tiene esa forma. */
export function conflictosDelError(err: unknown): { membresiaId: string; motivo: string }[] {
  if (!(err instanceof ApiError)) return [];
  const lista = (err.details as { conflictos?: unknown } | undefined)?.conflictos;
  if (!Array.isArray(lista)) return [];
  return lista.filter(
    (c): c is { membresiaId: string; motivo: string } =>
      typeof c === "object" && c !== null && typeof (c as { membresiaId?: unknown }).membresiaId === "string" && typeof (c as { motivo?: unknown }).motivo === "string"
  );
}

/** `details.membresias` de un 409 `HISTORIAL_INCOMPLETO`, validado. */
export function membresiasIncompletasDelError(err: unknown): string[] {
  if (!(err instanceof ApiError)) return [];
  const lista = (err.details as { membresias?: unknown } | undefined)?.membresias;
  return Array.isArray(lista) ? lista.filter((x): x is string => typeof x === "string") : [];
}

/** Código del error, solo si es un `ApiError` con código. */
export const codigoDelError = (err: unknown): string | undefined => (err instanceof ApiError ? err.code : undefined);

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

    // `propose(clubId, personId)` se retiró: no tenía llamadas y el servidor ya no acepta
    // `personId`. La postulación por RUN (fase 4) tendrá su propio cliente.

    /** Asignación directa (solo admin): queda activa de inmediato. No traslada: rechaza a quien está activo en otro club. */
    assignDirectly: (clubId: string, personId: string, opciones: Omit<OpcionesDeActivacion, "confirmarFinDeMembresiaId">) =>
      api.post<ClubSwimmerAssignment>(`/swimmer-assignments/direct`, { clubId, personId, ...opciones }),

    approve: (id: string, opciones: OpcionesDeActivacion) => api.post<ClubSwimmerAssignment>(`/swimmer-assignments/${id}/approve`, opciones),

    reject: (id: string, reason?: string) => api.post<ClubSwimmerAssignment>(`/swimmer-assignments/${id}/reject`, { reason }),

    /** Baja simple con la fecha de término ELEGIDA (obligatoria). */
    end: (id: string, datos: DatosDeBaja) => api.post<ClubSwimmerAssignment>(`/swimmer-assignments/${id}/end`, datos),

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
    bulkAssign: (targetClubId: string, personIds: string[], opciones: Omit<OpcionesDeActivacion, "confirmarFinDeMembresiaId">) =>
      api.post<BulkAssignSummary>(`/swimmer-assignments/bulk-assign`, { targetClubId, personIds, ...opciones }),

    /** Club actual del nadador (null si no tiene ninguno activo). Solo el club: no la membresía. */
    getCurrentClub: (personId: string) => api.get<ClubActual | null>(`/swimmer-assignments/current-club/${personId}`),

    /** Traslado administrativo: con membresía vigente exige confirmarla (`confirmarFinDeMembresiaId`). */
    reassign: (personId: string, newClubId: string, opciones: OpcionesDeActivacion) =>
      api.post<ClubSwimmerAssignment>(`/swimmer-assignments/reassign/${personId}`, { newClubId, ...opciones }),
  };
}
