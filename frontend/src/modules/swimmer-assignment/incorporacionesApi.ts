/**
 * C-05: cliente de periodos de cambio y solicitudes de alta (pantallas de administración, fase 3).
 * Usa el cliente HTTP único: sesión, CSRF y errores no se repiten aquí.
 */
import { api, query } from "../../shared/apiClient";
import type { OpcionesDeActivacion } from "./assignmentApi";

export interface PeriodoDeCambio {
  id: string;
  /** Fechas de calendario inclusivas (America/Santiago). */
  inicio: string;
  fin: string;
  motivo: string | null;
  creadoEn: string;
  /** Instante del cierre anticipado; null = no cerrado. */
  cerradoEn: string | null;
}

export type EstadoSolicitudAlta = "pendiente" | "aprobada" | "rechazada" | "resuelta_por_propuesta";

export interface SolicitudAlta {
  id: string;
  estado: EstadoSolicitudAlta;
  club: { id: string; name: string };
  run: string;
  /** DECLARADOS por el club: no verificados. */
  nombres: string;
  apellidos: string;
  creadoEn: string;
  revisadoEn: string | null;
  motivoRechazo: string | null;
  /** Persona vinculada o creada al resolver (verificada por administración). */
  persona: { id: string; fullName: string; run: string } | null;
}

/** Detalle para administración: incluye las coincidencias del RUN. */
export interface DetalleSolicitudAlta extends SolicitudAlta {
  coincidencias?: {
    personaVigente: {
      id: string;
      fullName: string;
      run: string;
      membresiaActiva: { id: string; club: { id: string; name: string }; startDate: string | null } | null;
    } | null;
    eliminadas: { id: string; deletedAt: string }[];
  };
}

export interface ListaDeSolicitudes {
  items: SolicitudAlta[];
  total: number;
  page: number;
  pageSize: number;
}

/** Datos VERIFICADOS de la persona nueva (sin RUN: es el de la solicitud). */
export interface DatosDePersonaNueva {
  firstName: string;
  paternalLastName: string;
  maternalLastName?: string;
  birthDate: string;
  gender: "male" | "female";
  email?: string;
  phone?: string;
}

export type ResolucionDeAlta = OpcionesDeActivacion &
  (
    | { modo: "crear"; datosPersona: DatosDePersonaNueva; crearPeseACoincidenciaEliminada?: boolean }
    | { modo: "vincular"; personaEsperadaId: string }
  );

export const CODIGOS_ALTA = {
  personaYaRegistrada: "PERSONA_YA_REGISTRADA",
  personaNoRegistrada: "PERSONA_NO_REGISTRADA",
  personaDistinta: "PERSONA_DISTINTA",
  coincidenciaEliminada: "COINCIDENCIA_ELIMINADA",
  periodoSolapado: "PERIODO_SOLAPADO",
  periodoYaCerrado: "PERIODO_YA_CERRADO",
} as const;

export function useIncorporacionesApi() {
  return {
    listarPeriodos: () => api.get<PeriodoDeCambio[]>("/swimmer-assignments/periodos-cambio"),
    crearPeriodo: (datos: { inicio: string; fin: string; motivo?: string }) => api.post<PeriodoDeCambio>("/swimmer-assignments/periodos-cambio", datos),
    cerrarPeriodo: (id: string) => api.post<PeriodoDeCambio>(`/swimmer-assignments/periodos-cambio/${id}/cerrar`, {}),

    listarSolicitudes: (params: { estado?: EstadoSolicitudAlta; page?: number; pageSize?: number } = {}) =>
      api.get<ListaDeSolicitudes>(`/swimmer-assignments/altas${query(params)}`),
    obtenerSolicitud: (id: string) => api.get<DetalleSolicitudAlta>(`/swimmer-assignments/altas/${id}`),
    /** Resolución ATÓMICA en el servidor: crea o vincula a la persona y la asigna en una transacción. */
    aprobarSolicitud: (id: string, resolucion: ResolucionDeAlta) => api.post<SolicitudAlta>(`/swimmer-assignments/altas/${id}/aprobar`, resolucion),
    rechazarSolicitud: (id: string, motivo?: string) => api.post<SolicitudAlta>(`/swimmer-assignments/altas/${id}/rechazar`, motivo ? { motivo } : {}),
  };
}
