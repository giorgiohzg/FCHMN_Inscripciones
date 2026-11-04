import { api } from "../../shared/apiClient";

export type AccountStatus = "active" | "locked" | "disabled";

/** Filtro por personalidad jurídica: `si` o `no`. Lo resuelve el servidor, no la página. */
export type EstadoPjFiltro = "si" | "no";

export interface ClubStaffMember {
  id: string;
  roleType: "delegate" | "coach" | "legal_representative";
  person: { id: string; fullName: string; run: string };
}

export interface Club {
  id: string;
  name: string;
  /** `null` = el club todavía no tiene nombre de usuario. */
  username: string | null;
  code: string;
  /** `true` sí · `false` no. Solo booleanos: el estado «pendiente de verificar» ya no existe. */
  hasLegalStatus: boolean;
  rut: string | null;
  legalName: string | null;
  /** `null` = el club no tiene correo registrado. */
  email: string | null;
  staff: ClubStaffMember[];
  isAchmnMember: boolean;
  isAchmnCollaborator: boolean;
  isFchmnMember: boolean;
  isFchmnCollaborator: boolean;
  status: AccountStatus;
  user?: { id: string; username: string; status: AccountStatus; mustChangePassword: boolean; lastLoginAt: string | null } | null;
}

export interface ClubListResult {
  items: Club[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ClubFormInput {
  name: string;
  /**
   * Editable mientras el club no tenga cuenta. `null` (o vacío) lo quita;
   * omitirlo al editar lo conserva.
   */
  username?: string | null;
  code: string;
  /** Obligatorio: `true` o `false`. El servidor rechaza `null` y su omisión. */
  hasLegalStatus: boolean;
  rut?: string;
  legalName?: string;
  /** `null` = sin correo. Al editar, `null` (o vacío) lo elimina; omitirlo lo conserva. */
  email?: string | null;
  delegatePersonIds?: string[];
  coachPersonIds?: string[];
  legalRepresentativePersonId?: string | null;
  isAchmnMember: boolean;
  isAchmnCollaborator: boolean;
  isFchmnMember: boolean;
  isFchmnCollaborator: boolean;
}

export function useClubsApi() {
  return {
    list: (params: { search?: string; status?: AccountStatus; personalidadJuridica?: EstadoPjFiltro; page?: number; pageSize?: number } = {}) => {
      const qs = new URLSearchParams();
      if (params.search) qs.set("search", params.search);
      if (params.status) qs.set("status", params.status);
      if (params.personalidadJuridica) qs.set("personalidadJuridica", params.personalidadJuridica);
      if (params.page) qs.set("page", String(params.page));
      if (params.pageSize) qs.set("pageSize", String(params.pageSize));
      return api.get<ClubListResult>(`/clubs?${qs}`);
    },

    get: (id: string) => api.get<Club>(`/clubs/${id}`),

    create: (input: ClubFormInput) =>
      api.post<Club>(`/clubs`, input),

    update: (id: string, input: Partial<ClubFormInput>) =>
      api.put<Club>(`/clubs/${id}`, input),

    remove: (id: string) => api.delete<void>(`/clubs/${id}`),

    block: (id: string) => api.post<Club>(`/clubs/${id}/block`),

    disable: (id: string) => api.post<Club>(`/clubs/${id}/disable`),

    reactivate: (id: string) =>
      api.post<Club>(`/clubs/${id}/reactivate`),

    /**
     * Crea la cuenta. `username`, si se indica, se asigna en la misma operación;
     * si no, se usa el guardado. Sin ninguno, el servidor responde 400.
     */
    createCredentials: (id: string, username?: string | null) =>
      api.post<{ username: string; temporaryPassword: string }>(`/clubs/${id}/credentials`, username ? { username } : {}),

    resetCredentials: (id: string) =>
      api.post<{ temporaryPassword: string }>(`/clubs/${id}/credentials/reset`),
  };
}
