import { api } from "../../shared/apiClient";

export type PoolCourseLength = "short_25m" | "long_50m";

export interface Pool {
  id: string;
  name: string;
  address: string | null;
  isHeated: boolean;
  isCovered: boolean;
  courseLength: PoolCourseLength;
}

export interface PoolFormInput {
  name: string;
  address?: string;
  isHeated: boolean;
  isCovered: boolean;
  courseLength: PoolCourseLength;
}

export function usePoolsApi() {

  return {
    list: (search?: string) => {
      const qs = search ? `?search=${encodeURIComponent(search)}` : "";
      return api.get<Pool[]>(`/pools${qs}`);
    },
    get: (id: string) => api.get<Pool>(`/pools/${id}`),
    create: (input: PoolFormInput) =>
      api.post<Pool>(`/pools`, input),
    update: (id: string, input: Partial<PoolFormInput>) =>
      api.put<Pool>(`/pools/${id}`, input),
    remove: (id: string) => api.delete<void>(`/pools/${id}`),
  };
}
