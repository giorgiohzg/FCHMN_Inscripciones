import { z } from "zod";
import { uuidField } from "../../shared/uuid.schema";
import { EDAD_MINIMA_MAXIMA, EDAD_MINIMA_MINIMA } from "./resumenPorClub.rules";

export const registrationsReportQuerySchema = z.object({
  competitionId: uuidField("Debe seleccionar una competencia"),
  clubId: uuidField().optional(),
  competitionDateId: uuidField().optional(),
  sessionTypeId: uuidField().optional(),
  competitionEventId: uuidField().optional(),
  categoryId: uuidField().optional(),
  gender: z.enum(["male", "female", "mixed"]).optional(),
});
export type RegistrationsReportQuery = z.infer<typeof registrationsReportQuerySchema>;

export const exportFormatSchema = z.object({
  format: z.enum(["csv", "xlsx", "pdf"]),
});

/** Reportes de administración por club (opciones del selector y resumen): solo la competencia. */
export const competenciaDelReporteQuerySchema = z.object({
  competitionId: uuidField("Debe seleccionar una competencia"),
});

const MENSAJE_EDAD_MINIMA = `La edad mínima debe ser un número entero entre ${EDAD_MINIMA_MINIMA} y ${EDAD_MINIMA_MAXIMA}`;

/**
 * Resumen por club: la competencia y, opcional, la edad mínima de la columna de edad.
 *
 * Llega como texto de la URL y solo se aceptan dígitos sin signo, sin decimales, sin espacios,
 * sin exponente y sin ceros a la izquierda («0», «7», «70»): un valor vacío, «7.5», «-1»,
 * «abc», «Infinity», «1e2», «070» o un parámetro repetido se rechazan con 400, igual que lo que
 * quede fuera de [0, 150]. Si se omite, el servicio usa `EDAD_MINIMA_POR_OMISION` (70).
 */
export const resumenPorClubQuerySchema = competenciaDelReporteQuerySchema.extend({
  edadMinima: z
    .string({ error: MENSAJE_EDAD_MINIMA })
    .regex(/^(0|[1-9][0-9]{0,2})$/, MENSAJE_EDAD_MINIMA)
    .transform(Number)
    .pipe(z.number().int().min(EDAD_MINIMA_MINIMA, MENSAJE_EDAD_MINIMA).max(EDAD_MINIMA_MAXIMA, MENSAJE_EDAD_MINIMA))
    .optional(),
});
