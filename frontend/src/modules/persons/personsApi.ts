import { api, descargarArchivo } from "../../shared/apiClient";

export type PersonRoleType = "swimmer" | "delegate" | "coach" | "legal_representative";
export type AccountStatus = "active" | "locked" | "disabled";

export interface BulkImportRowResult {
  row: number;
  status: "created" | "error";
  fullName?: string;
  errors?: string[];
}
export interface BulkImportSummary {
  totalRows: number;
  createdCount: number;
  errorCount: number;
  results: BulkImportRowResult[];
}

export interface Person {
  id: string;
  run: string;
  username: string;
  firstName: string | null;
  paternalLastName: string | null;
  maternalLastName: string | null;
  fullName: string;
  birthDate: string;
  gender: "male" | "female";
  email: string | null;
  phone?: string | null;
  status: AccountStatus;
  /**
   * Casilla «Habilitar permisos de administrador»: la INTENCIÓN, no el acceso.
   * Quien concede acceso es el rol `admin` de su cuenta; con la marca puesta y
   * sin cuenta, la persona todavía no puede entrar.
   */
  adminAccess: boolean;
  roles: { roleType: PersonRoleType; active: boolean }[];
  user?: { id: string; username: string; status: AccountStatus; mustChangePassword: boolean; lastLoginAt: string | null } | null;
}

export interface PersonListResult {
  items: Person[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PersonFormInput {
  run?: string; // solo en creación
  username?: string; // solo en creación
  firstName: string;
  paternalLastName: string;
  maternalLastName?: string;
  birthDate: string;
  gender: "male" | "female";
  email?: string; // opcional — "" se interpreta como "sin correo"
  phone?: string;
  // SIN `roles`: el backend ya no los acepta ni al crear ni al editar. Los
  // cuatro se derivan de relaciones reales —membresía de club para `swimmer`,
  // nombramiento en la ficha del club para los otros tres—, así que enviarlos
  // no hacía nada y el tipo invitaba a creer lo contrario.
}

export function usePersonsApi() {
  return {
    list: (params: { search?: string; role?: PersonRoleType; status?: AccountStatus; page?: number } = {}) => {
      const qs = new URLSearchParams();
      if (params.search) qs.set("search", params.search);
      if (params.role) qs.set("role", params.role);
      if (params.status) qs.set("status", params.status);
      if (params.page) qs.set("page", String(params.page));
      return api.get<PersonListResult>(`/persons?${qs}`);
    },

    get: (id: string) =>
      api.get<Person>(`/persons/${id}`),

    create: (input: PersonFormInput) =>
      api.post<Person>(`/persons`, input),

    update: (id: string, input: Partial<PersonFormInput>) =>
      api.put<Person>(`/persons/${id}`, input),

    remove: (id: string) =>
      api.delete<void>(`/persons/${id}`),

    block: (id: string) =>
      api.post<Person>(`/persons/${id}/block`),

    disable: (id: string) =>
      api.post<Person>(`/persons/${id}/disable`),

    reactivate: (id: string) =>
      api.post<Person>(`/persons/${id}/reactivate`),

    /**
     * Concede o retira permisos de administrador. El backend exige el rol
     * `admin` además del permiso de escritura, así que ocultar la casilla no
     * es lo que protege esta operación.
     */
    setAdminAccess: (id: string, adminAccess: boolean) =>
      api.put<{ id: string; fullName: string; adminAccess: boolean; tieneCuenta: boolean; sesionesRevocadas: number }>(
        `/persons/${id}/admin-access`,
        { adminAccess }
      ),

    createCredentials: (id: string) =>
      api.post<{ username: string; temporaryPassword: string }>(`/persons/${id}/credentials`),

    resetCredentials: (id: string) =>
      api.post<{ temporaryPassword: string }>(`/persons/${id}/credentials/reset`),

    // ---------- Carga masiva ----------
    downloadBulkImportTemplate: () =>
      // `descargarArchivo` comparte la renovación ante 401 con el resto del
      // cliente: una descarga con el token recién vencido ya no falla.
      descargarArchivo(`/persons/bulk-import/template`, "Plantilla_Carga_Masiva_Personas.xlsx"),

    bulkImport: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      // Sin `Content-Type` a mano: `FormData` fija el suyo con el boundary.
      return api.post<BulkImportSummary>(`/persons/bulk-import`, formData);
    },
  };
}
