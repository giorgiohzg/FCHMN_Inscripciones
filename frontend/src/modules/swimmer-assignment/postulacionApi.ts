/**
 * C-05, fase 4: postulación por RUN del CLUB y su personal autorizado.
 *
 * Usa el cliente HTTP único (`apiFetch`): sesión, renovación y CSRF no se repiten aquí, y NO
 * reintenta escrituras por su cuenta. El club sale de la sesión en el servidor: no se envía.
 *
 * IDEMPOTENCIA. `POST /swimmer-assignments` exige `Idempotency-Key`. La clave identifica UNA
 * postulación (un RUN): quien llama la genera al empezar y la CONSERVA para reintentar esa misma
 * postulación tras un resultado incierto. Nunca se genera otra automáticamente.
 */
import { apiFetch, api, query } from "../../shared/apiClient";
import type { AssignmentListResult } from "./assignmentApi";
import type { EstadoSolicitudAlta, ListaDeSolicitudes, SolicitudAlta } from "./incorporacionesApi";

export interface CuotaDelClub {
  usados: number;
  limite: number;
  /** Día calendario de America/Santiago al que corresponde la cuenta. */
  dia: string;
  restantes: number;
}

export type PeriodoVigente = { vigente: true; inicio: string; fin: string } | { vigente: false };

/** Lo que el servidor devuelve de una propuesta a su club: nombre, id y RUN acordados. */
export interface PropuestaDelClub {
  id: string;
  status: string;
  club: { id: string; name: string };
  person: { id: string; fullName: string; run: string };
  createdAt: string;
}

export type ResultadoDePostulacion =
  | { resultado: "propuesta_creada"; repeticion?: boolean; propuesta: PropuestaDelClub | null; cuota?: CuotaDelClub }
  | { resultado: "requiere_datos_de_alta"; repeticion?: boolean; intentoId: string; expiraEn: string; cuota?: CuotaDelClub }
  | { resultado: "solicitud_alta_creada"; repeticion?: boolean; solicitud: SolicitudAlta | null; cuota?: CuotaDelClub };

/** Códigos estables de la postulación y del segundo paso (contrato del backend). */
export const CODIGOS_POSTULACION = {
  cuotaAgotada: "CUOTA_AGOTADA",
  fueraDePeriodo: "MEMBRESIA_ACTIVA_FUERA_DE_PERIODO",
  duplicado: "DUPLICADO",
  operacionEnCurso: "OPERACION_EN_CURSO",
  intentoInterrumpido: "INTENTO_INTERRUMPIDO",
  idempotenciaConflicto: "IDEMPOTENCIA_CONFLICTO",
  idempotenciaRequerida: "IDEMPOTENCIA_REQUERIDA",
  runInvalido: "RUN_INVALIDO",
  clubNoDisponible: "CLUB_NO_DISPONIBLE",
  pasoVencido: "PASO_VENCIDO",
  pasoYaUtilizado: "PASO_YA_UTILIZADO",
  pasoNoDisponible: "PASO_NO_DISPONIBLE",
  pasoNoEncontrado: "PASO_NO_ENCONTRADO",
  servicioNoDisponible: "SERVICE_UNAVAILABLE",
} as const;

/**
 * Clave de idempotencia nueva: 8 a 64 caracteres de letras, números, «-» o «_» (contrato).
 * Aleatoria y sin datos de la persona.
 */
export function nuevaClaveDeIdempotencia(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function usePostulacionApi() {
  return {
    /** Primer paso: SOLO el RUN. La clave la decide quien llama (ver arriba). */
    postular: (run: string, claveIdempotencia: string) =>
      apiFetch<ResultadoDePostulacion>("/swimmer-assignments", {
        method: "POST",
        headers: { "Idempotency-Key": claveIdempotencia },
        body: JSON.stringify({ run }),
      }),

    /**
     * Segundo paso de un RUN no registrado: nombre y apellido DECLARADOS, ligados al intento
     * original. No lleva RUN ni crea una persona. Repetirlo con los mismos datos devuelve el mismo
     * resultado (el servidor lo reconoce por su huella).
     */
    completarAlta: (intentoId: string, nombres: string, apellidos: string) =>
      api.post<ResultadoDePostulacion>("/swimmer-assignments/altas", { intentoId, nombres, apellidos }),

    cuota: () => api.get<CuotaDelClub>("/swimmer-assignments/cuota"),
    periodoVigente: () => api.get<PeriodoVigente>("/swimmer-assignments/periodos-cambio/vigente"),

    /** Propuestas y membresías del PROPIO club (el servidor acota el club por la sesión). */
    propuestas: (params: { status?: "pending" | "rejected"; page: number; pageSize: number }) =>
      api.get<AssignmentListResult>(`/swimmer-assignments${query(params)}`),

    /** Solicitudes de alta del PROPIO club. */
    solicitudes: (params: { estado?: EstadoSolicitudAlta; page: number; pageSize: number }) =>
      api.get<ListaDeSolicitudes>(`/swimmer-assignments/altas${query(params)}`),
  };
}
