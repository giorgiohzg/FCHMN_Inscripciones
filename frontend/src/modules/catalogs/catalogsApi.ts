import { api } from "../../shared/apiClient";

export type EventGender = "male" | "female" | "mixed";

export interface TestType {
  id: string;
  name: string;
  swimmersCount: number;
}
export interface Distance {
  id: string;
  meters: number;
}
export interface Stroke {
  id: string;
  name: string;
}
export interface CategoryGroup {
  id: string;
  name: string;
}
export interface Category {
  id: string;
  testTypeId: string;
  categoryGroupId: string | null;
  name: string;
  minAge: number;
  maxAge: number;
  testType: { id: string; name: string };
  categoryGroup: { id: string; name: string } | null;
}
export interface EventItem {
  id: string;
  testTypeId: string;
  distanceId: string;
  strokeId: string;
  gender: EventGender;
  testType: { id: string; name: string; swimmersCount: number };
  distance: { id: string; meters: number };
  stroke: { id: string; name: string };
}

export function useCatalogsApi() {

  return {
    listTestTypes: () => api.get<TestType[]>(`/catalogs/test-types`),

    // ---------- Distancias ----------
    listDistances: () => api.get<Distance[]>(`/catalogs/distances`),
    createDistance: (meters: number) =>
      api.post<Distance>(`/catalogs/distances`, { meters }),
    updateDistance: (id: string, meters: number) =>
      api.put<Distance>(`/catalogs/distances/${id}`, { meters }),
    deleteDistance: (id: string) =>
      api.delete<void>(`/catalogs/distances/${id}`),

    // ---------- Estilos ----------
    listStrokes: () => api.get<Stroke[]>(`/catalogs/strokes`),
    createStroke: (name: string) =>
      api.post<Stroke>(`/catalogs/strokes`, { name }),
    updateStroke: (id: string, name: string) =>
      api.put<Stroke>(`/catalogs/strokes/${id}`, { name }),
    deleteStroke: (id: string) =>
      api.delete<void>(`/catalogs/strokes/${id}`),

    // ---------- Grupos de categorías ----------
    listCategoryGroups: () => api.get<CategoryGroup[]>(`/catalogs/category-groups`),
    createCategoryGroup: (name: string) =>
      api.post<CategoryGroup>(`/catalogs/category-groups`, { name }),
    updateCategoryGroup: (id: string, name: string) =>
      api.put<CategoryGroup>(`/catalogs/category-groups/${id}`, { name }),
    deleteCategoryGroup: (id: string) =>
      api.delete<void>(`/catalogs/category-groups/${id}`),

    // ---------- Categorías ----------
    listCategories: (testTypeId?: string) => {
      const qs = new URLSearchParams();
      if (testTypeId) qs.set("testTypeId", testTypeId);
      return api.get<{ items: Category[]; total: number }>(`/catalogs/categories?${qs}`);
    },
    createCategory: (input: { testTypeId: string; categoryGroupId?: string | null; name: string; minAge: number; maxAge: number }) =>
      api.post<Category>(`/catalogs/categories`, input),
    updateCategory: (id: string, input: { categoryGroupId?: string | null; name?: string; minAge?: number; maxAge?: number }) =>
      api.put<Category>(`/catalogs/categories/${id}`, input),
    deleteCategory: (id: string) =>
      api.delete<void>(`/catalogs/categories/${id}`),

    // ---------- Pruebas ----------
    listEvents: (filters: { testTypeId?: string } = {}) => {
      const qs = new URLSearchParams();
      if (filters.testTypeId) qs.set("testTypeId", filters.testTypeId);
      return api.get<{ items: EventItem[]; total: number }>(`/catalogs/events?${qs}`);
    },
    createEvent: (input: { testTypeId: string; distanceId: string; strokeId: string; gender: EventGender }) =>
      api.post<EventItem>(`/catalogs/events`, input),
    updateEvent: (id: string, input: { gender?: EventGender }) =>
      api.put<EventItem>(`/catalogs/events/${id}`, input),
    deleteEvent: (id: string) =>
      api.delete<void>(`/catalogs/events/${id}`),
  };
}
