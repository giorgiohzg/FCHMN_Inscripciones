import { api, descargarArchivo } from "../../shared/apiClient";

/*
 * Los reportes NO entregan el RUN (SEC-02), para ningún rol. Estos tipos no lo declaran, y la
 * interfaz no lo lee ni lo reenvía: una API anterior a ese cambio todavía lo incluye en su JSON,
 * y la pantalla lo ignora por completo.
 */
export interface IndividualReportRow {
  competencia: string;
  club: string;
  nombreCompleto: string;
  fechaNacimiento: string;
  categoria: string;
  prueba: string;
  distancia: string;
  estilo: string;
  genero: string;
  fecha: string;
  jornada: string;
  tipoDePrueba: string;
}

export interface RelayReportRow {
  competencia: string;
  equipoClub: string;
  prueba: string;
  categoria: string;
  genero: string;
  fecha: string;
  jornada: string;
  integrante1: string;
  integrante2: string;
  integrante3: string;
  integrante4: string;
}

export interface ReportEventLine {
  number: number | null;
  text: string;
}

export interface ClubGroupSwimmerRow {
  /**
   * Identificador INTERNO de la persona: la clave estable de la fila (el nombre puede repetirse).
   * No es un dato anónimo: sigue asociado a una persona. Opcional por la TRANSICIÓN: una API
   * anterior no lo envía y la pantalla cae a la posición dentro del club; ver `ReportsPage`.
   */
  personId?: string;
  nombreCompleto: string;
  edad: number;
  categoria: string;
  genero: string;
  pruebas: ReportEventLine[];
  relevos: ReportEventLine[];
}
export interface ClubGroup {
  clubName: string;
  totalNadadores: number;
  totalPruebasIndividuales: number;
  totalRelevos: number;
  swimmers: ClubGroupSwimmerRow[];
}

export interface RegistrationsReportResult {
  competitionName: string;
  individualRows: IndividualReportRow[];
  relayRows: RelayReportRow[];
  groupedByClub: ClubGroup[];
}

export interface ReportFilters {
  competitionId: string;
  clubId?: string;
  competitionDateId?: string;
  sessionTypeId?: string;
  competitionEventId?: string;
  categoryId?: string;
  gender?: "male" | "female" | "mixed";
}

function buildQs(filters: ReportFilters, extra: Record<string, string> = {}) {
  const qs = new URLSearchParams();
  qs.set("competitionId", filters.competitionId);
  if (filters.clubId) qs.set("clubId", filters.clubId);
  if (filters.competitionDateId) qs.set("competitionDateId", filters.competitionDateId);
  if (filters.sessionTypeId) qs.set("sessionTypeId", filters.sessionTypeId);
  if (filters.competitionEventId) qs.set("competitionEventId", filters.competitionEventId);
  if (filters.categoryId) qs.set("categoryId", filters.categoryId);
  if (filters.gender) qs.set("gender", filters.gender);
  Object.entries(extra).forEach(([k, v]) => qs.set(k, v));
  return qs;
}

export function useReportsApi() {

  return {
    getRegistrationsReport: (filters: ReportFilters) =>
      api.get<RegistrationsReportResult>(`/reports/registrations?${buildQs(filters)}`),

    /** Descarga el archivo exportado directamente en el navegador. */
    downloadExport: (filters: ReportFilters, format: "csv" | "xlsx" | "pdf") =>
      descargarArchivo(`/reports/registrations/export?${buildQs(filters, { format })}`, `reporte.${format}`),

    /** Descarga el ZIP para Team Manager, con un .CL2 y un .HY3 (Módulo 11). */
    downloadTeamManagerExport: (competitionId: string, clubId: string) =>
      descargarArchivo(`/export/team-manager/zip?${new URLSearchParams({ competitionId, clubId })}`, "export.zip"),
  };
}
