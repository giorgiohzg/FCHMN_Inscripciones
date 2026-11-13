import { z } from "zod";
import { uuidField } from "../../shared/uuid.schema";
import { esFechaCalendarioValida, FORMATO_FECHA_CALENDARIO } from "../../shared/fecha.util";
import { personCreateSchema } from "../persons/persons.schemas";
import { fechaEfectivaField } from "../swimmer-assignment/assignment.schemas";

const fechaCalendario = (campo: string) =>
  z
    .string({ error: `Debe indicar la fecha de ${campo}` })
    .trim()
    .regex(FORMATO_FECHA_CALENDARIO, "Use el formato AAAA-MM-DD (fecha de calendario, sin hora)")
    .refine(esFechaCalendarioValida, "Esa fecha no existe");

/** Periodo global de cambio de club: fechas inclusivas de America/Santiago. */
export const crearPeriodoSchema = z
  .object({
    inicio: fechaCalendario("inicio"),
    fin: fechaCalendario("fin"),
    motivo: z.string().trim().max(300).optional(),
  })
  .strict();

export const cerrarPeriodoSchema = z.object({}).strict();

export const listarSolicitudesQuerySchema = z.object({
  estado: z.enum(["pendiente", "aprobada", "rechazada", "resuelta_por_propuesta"]).optional(),
  clubId: uuidField("Club inválido").optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const cuotaQuerySchema = z.object({ clubId: uuidField("Club inválido").optional() });

const camposDeActivacion = {
  fechaEfectiva: fechaEfectivaField,
  confirmarFinDeMembresiaId: uuidField("Membresía a finalizar inválida").optional(),
  aceptarHistorialIncompleto: z.boolean().optional(),
};

/**
 * Resolución administrativa de una solicitud de alta. El RUN NO viaja: es el de la solicitud.
 * `crear` lleva los datos verificados de la persona; `vincular`, la persona que se revisó.
 */
export const aprobarSolicitudSchema = z.discriminatedUnion("modo", [
  z
    .object({
      modo: z.literal("crear"),
      datosPersona: personCreateSchema.omit({ run: true }),
      crearPeseACoincidenciaEliminada: z.boolean().optional(),
      ...camposDeActivacion,
    })
    .strict(),
  z
    .object({
      modo: z.literal("vincular"),
      personaEsperadaId: uuidField("Persona inválida"),
      ...camposDeActivacion,
    })
    .strict(),
]);

export const rechazarSolicitudSchema = z.object({ motivo: z.string().trim().max(500).optional() }).strict();
