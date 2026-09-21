import { api } from "../../shared/apiClient";

export type AccountStatus = "active" | "locked" | "disabled";

export interface ClubStaffMember {
  id: string;
  roleType: "delegate" | "coach" | "legal_representative";
  person: { id: string; fullName: string; run: string };
}

export interface Club {
  id: string;
  name: string;
  username: string;
  code: string;
  hasLegalStatus: boolean;
  rut: string | null;
  legalName: string | null;
  email: string;
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
  username?: string; // solo en creación
  code: string;
  hasLegalStatus: boolean;
  rut?: string;
  legalName?: string;
  email: string;
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
    list: (params: { search?: string; status?: AccountStatus; page?: number; pageSize?: number } = {}) => {
      const qs = new URLSearchParams();
      if (params.search) qs.set("search", params.search);
      if (params.status) qs.set("status", params.status);
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

    createCredentials: (id: string) =>
      api.post<{ username: string; temporaryPassword: string }>(`/clubs/${id}/credentials`),

    resetCredentials: (id: string) =>
      api.post<{ temporaryPassword: string }>(`/clubs/${id}/credentials/reset`),
  };
}
