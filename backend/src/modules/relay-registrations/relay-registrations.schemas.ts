import { z } from "zod";
import { listaAcotada } from "../../shared/listaAcotada";
import { LIMITES_LISTAS } from "../../shared/limites-listas";

const MENSAJE_MAXIMO_INTEGRANTES = `Un equipo de relevo admite como máximo ${LIMITES_LISTAS.integrantesDeRelevo} integrantes`;

export const createRelayRegistrationSchema = z.object({
  competitionEventId: z.string().uuid("Prueba de relevo inválida"),
  clubId: z.string().uuid("Club inválido"),
  // La cantidad EXACTA la impone el tipo de prueba (`TestType.swimmersCount`,
  // 4 en un relevo estándar) y se valida en el servicio: así un futuro tipo
  // de relevo de otra cantidad no obliga a tocar este esquema. Aquí solo se
  // exige que sea un equipo (más de un nadador).
  // El tope de `integrantesDeRelevo` es TÉCNICO (SEC-01) y se comprueba antes de validar elementos; la
  // cantidad exacta sigue siendo la de `swimmersCount`.
  personIds: listaAcotada(LIMITES_LISTAS.integrantesDeRelevo, z.array(z.string().uuid()).min(2, "Un equipo de relevo debe tener más de un nadador"), MENSAJE_MAXIMO_INTEGRANTES),
  // La categoría YA NO se ingresa manualmente: se calcula automáticamente
  // (edad combinada de los 4 nadadores vs. fecha de corte de la competencia).
  seedTimeCentiseconds: z.coerce.number().int().min(0).optional(), // tiempo estimado del EQUIPO (opcional)
});
export type CreateRelayRegistrationInput = z.infer<typeof createRelayRegistrationSchema>;

export const updateRelayRegistrationSchema = z.object({
  seedTimeCentiseconds: z.coerce.number().int().min(0).nullable().optional(),
  // Si se entrega, reemplaza los 4 integrantes Y su orden — en pruebas
  // Combinado, el orden esperado es Espalda, Pecho, Mariposa, Libre.
  personIds: listaAcotada(LIMITES_LISTAS.integrantesDeRelevo, z.array(z.string().uuid()).min(2, "Un equipo de relevo debe tener más de un nadador"), MENSAJE_MAXIMO_INTEGRANTES).optional(),
});
export type UpdateRelayRegistrationInput = z.infer<typeof updateRelayRegistrationSchema>;

export const relayRegistrationListQuerySchema = z.object({
  competitionId: z.string().uuid().optional(),
  competitionEventId: z.string().uuid().optional(),
  clubId: z.string().uuid().optional(),
  status: z.enum(["confirmed", "cancelled"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type RelayRegistrationListQuery = z.infer<typeof relayRegistrationListQuerySchema>;
