import { api } from "../../shared/apiClient";

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  user: { id: string; username: string } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  ipAddress: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface AuditLogListResult {
  items: AuditLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditLogFilters {
  userId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
}

export function useAuditApi() {

  return {
    list: (filters: AuditLogFilters = {}) => {
      const qs = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => {
        if (v) qs.set(k, String(v));
      });
      return api.get<AuditLogListResult>(`/audit-logs?${qs}`);
    },

    getFilters: () => api.get<{ entityTypes: string[]; actions: string[] }>(`/audit-logs/filters`),
  };
}
