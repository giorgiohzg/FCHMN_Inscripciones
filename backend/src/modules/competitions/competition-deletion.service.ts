/**
 * ELIMINACIÓN COMPLETA DE UNA COMPETENCIA.
 *
 * Borra la competencia y TODO lo que le pertenece en exclusiva, en una sola transacción con su
 * auditoría:
 *   - inscripciones individuales, confirmadas o canceladas;
 *   - equipos de relevo, confirmados o cancelados, y sus integrantes;
 *   - pruebas asignadas (`competition_events`) y sus categorías habilitadas;
 *   - jornadas, sus límites y fechas.
 *
 * CONSERVA: las pruebas y demás definiciones de Catálogos (`events`, `categories`, tipos de
 * jornada), personas, clubes, membresías, cuentas, las demás competencias y el registro de
 * auditoría (que guarda el `entityId` como texto, sin clave foránea).
 *
 * POR QUÉ SE BORRA EXPLÍCITAMENTE, EN ORDEN, Y NO EN CASCADA. Las inscripciones y los relevos
 * referencian `competition_events` con `ON DELETE RESTRICT` (hallazgo 7: borrar una prueba no
 * puede arrastrar inscripciones en silencio), y `competition_events` referencia la jornada con
 * `RESTRICT` y, a la vez, con una clave compuesta en `CASCADE`. Un `DELETE` de la competencia
 * falla en cuanto hay una sola inscripción. Aquí se borra de las hojas hacia la raíz, y cada
 * recuento sale de las filas que el propio borrado eliminó (ver «Recuentos»).
 *
 * CONCURRENCIA. Orden de bloqueos (todos `FOR UPDATE`, READ COMMITTED):
 *   1. el consultivo de la predeterminada, en el mismo orden que
 *      `competencia-predeterminada.service.ts` (consultivo → fila);
 *   2. las PRUEBAS de la competencia, antes que la competencia: un alta que ya insertó retiene el
 *      `FOR KEY SHARE` de su prueba y después puede ACTUALIZAR la competencia al llenar el cupo; se
 *      la espera en la prueba sin tener aún la competencia, y no hay ciclo;
 *   3. la COMPETENCIA, y otra vez sus pruebas (agregar una prueba pide `FOR KEY SHARE` sobre la
 *      competencia: ya no puede aparecer otra);
 *   4. los INTEGRANTES de sus relevos, luego los RELEVOS y luego las INSCRIPCIONES individuales.
 *      Es el mismo sentido en que escribe la edición de integrantes (borra integrantes y después
 *      actualiza el relevo); al revés, las dos operaciones podrían esperarse mutuamente.
 * Qué protege cada cosa, sin atribuirle más:
 *   - El bloqueo de las PRUEBAS impide que se creen inscripciones o relevos NUEVOS (su clave
 *     foránea pide `FOR KEY SHARE` sobre la prueba): los que ya estaban escribiendo terminan antes
 *     y los que llegan después fallan porque la prueba ya no existe.
 *   - Ese bloqueo NO detiene un cambio de ESTADO de una fila existente: cancelar no modifica la
 *     clave foránea y no pide ningún bloqueo sobre la prueba. Eso lo cubre el paso 4: una
 *     cancelación en curso se espera, y una que llega después espera a esta transacción y ya no
 *     encuentra la fila.
 *
 * RECUENTOS. Inscripciones y relevos se borran con `DELETE … RETURNING status`: el desglose
 * confirmadas/canceladas describe la versión de cada fila que de verdad se eliminó.
 * *Antecedente:* se contaban antes de borrar, y una cancelación intercalada entre ambos pasos
 * quedaba informada (y auditada) como confirmada.
 *
 * PREDETERMINADA. La marca vive en la propia fila, así que desaparece con ella: no queda
 * ninguna competencia por defecto. Se audita además `COMPETITION_DEFAULT_CLEARED`, como cuando
 * se quita a mano. Los paneles ya invalidan una selección que deja de estar en su lista.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { audit } from "../audit/audit.service";
import { NotFoundError } from "../../shared/errors";
import { LONG_TRANSACTION_OPTIONS } from "../../shared/transaction";
import { CLAVE_BLOQUEO_PREDETERMINADA } from "./competencia-predeterminada.service";

interface ContextoDeAuditoria {
  userId: string;
  ipAddress?: string;
}

export interface RecuentoDeEliminacion {
  inscripcionesIndividuales: number;
  inscripcionesIndividualesConfirmadas: number;
  inscripcionesIndividualesCanceladas: number;
  equiposDeRelevo: number;
  equiposDeRelevoConfirmados: number;
  equiposDeRelevoCancelados: number;
  integrantesDeRelevo: number;
  pruebasAsignadas: number;
  categoriasHabilitadas: number;
  limitesDeJornada: number;
  jornadas: number;
  fechas: number;
}

export interface ResultadoDeEliminacion {
  competitionId: string;
  nombre: string;
  eraPredeterminada: boolean;
  eliminados: RecuentoDeEliminacion;
}

/** Punto de prueba: se ejecuta dentro de la transacción (ver cada opción). */
export type GanchoDePrueba = (tx: Prisma.TransactionClient) => Promise<void>;

export async function eliminarCompetenciaCompleta(
  id: string,
  actor: ContextoDeAuditoria,
  opciones: {
    /** Después de borrar y antes de auditar. */
    antesDeAuditar?: GanchoDePrueba;
    /** Con todo bloqueado y antes de borrar: donde antes se contaba. */
    entreRecuentoYBorrado?: GanchoDePrueba;
  } = {}
): Promise<ResultadoDeEliminacion> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CLAVE_BLOQUEO_PREDETERMINADA}, 0))`;
    // Paso 2: las pruebas ANTES que la competencia (ver «Concurrencia»).
    await tx.$queryRaw`SELECT id FROM competition_events WHERE competition_id = ${id} ORDER BY id FOR UPDATE`;
    const filas = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM competitions WHERE id = ${id} FOR UPDATE`;
    if (filas.length === 0) throw new NotFoundError("Competencia");
    // Paso 3: ya no se le pueden agregar pruebas; se vuelven a bloquear las que haya.
    await tx.$queryRaw`SELECT id FROM competition_events WHERE competition_id = ${id} ORDER BY id FOR UPDATE`;
    // Paso 4: integrantes → relevos → inscripciones. Espera a cualquier cancelación o edición en
    // curso de esas filas y deja esperando a las que lleguen después.
    await tx.$queryRaw`
      SELECT m.id FROM relay_registration_members m
        JOIN relay_registrations rr ON rr.id = m.relay_registration_id
        JOIN competition_events ce ON ce.id = rr.competition_event_id
       WHERE ce.competition_id = ${id} ORDER BY m.id FOR UPDATE OF m`;
    await tx.$queryRaw`
      SELECT rr.id FROM relay_registrations rr
        JOIN competition_events ce ON ce.id = rr.competition_event_id
       WHERE ce.competition_id = ${id} ORDER BY rr.id FOR UPDATE OF rr`;
    await tx.$queryRaw`
      SELECT r.id FROM registrations r
        JOIN competition_events ce ON ce.id = r.competition_event_id
       WHERE ce.competition_id = ${id} ORDER BY r.id FOR UPDATE OF r`;

    const competencia = await tx.competition.findUniqueOrThrow({ where: { id } });
    const deLaCompetencia = { competitionEvent: { competitionId: id } };

    if (opciones.entreRecuentoYBorrado) await opciones.entreRecuentoYBorrado(tx);

    // El desglose sale de las filas eliminadas (RETURNING), no de una lectura anterior.
    const integrantes = await tx.relayRegistrationMember.deleteMany({ where: { relayRegistration: deLaCompetencia } });
    const relevos = await tx.$queryRaw<{ status: string }[]>`
      DELETE FROM relay_registrations rr USING competition_events ce
       WHERE rr.competition_event_id = ce.id AND ce.competition_id = ${id}
      RETURNING rr.status::text AS status`;
    const individuales = await tx.$queryRaw<{ status: string }[]>`
      DELETE FROM registrations r USING competition_events ce
       WHERE r.competition_event_id = ce.id AND ce.competition_id = ${id}
      RETURNING r.status::text AS status`;
    const confirmadas = (filas: { status: string }[]) => filas.filter((f) => f.status === "confirmed").length;
    const categorias = await tx.competitionEventCategory.deleteMany({ where: deLaCompetencia });
    const pruebas = await tx.competitionEvent.deleteMany({ where: { competitionId: id } });
    const limites = await tx.sessionLimit.deleteMany({ where: { competitionSession: { competitionId: id } } });
    const jornadas = await tx.competitionSession.deleteMany({ where: { competitionId: id } });
    const fechas = await tx.competitionDate.deleteMany({ where: { competitionId: id } });
    await tx.competition.delete({ where: { id } });

    const eliminados: RecuentoDeEliminacion = {
      inscripcionesIndividuales: individuales.length,
      inscripcionesIndividualesConfirmadas: confirmadas(individuales),
      inscripcionesIndividualesCanceladas: individuales.length - confirmadas(individuales),
      equiposDeRelevo: relevos.length,
      equiposDeRelevoConfirmados: confirmadas(relevos),
      equiposDeRelevoCancelados: relevos.length - confirmadas(relevos),
      integrantesDeRelevo: integrantes.count,
      pruebasAsignadas: pruebas.count,
      categoriasHabilitadas: categorias.count,
      limitesDeJornada: limites.count,
      jornadas: jornadas.count,
      fechas: fechas.count,
    };

    if (opciones.antesDeAuditar) await opciones.antesDeAuditar(tx);

    await audit(
      {
        userId: actor.userId,
        action: "COMPETITION_DELETED",
        entityType: "Competition",
        entityId: id,
        ipAddress: actor.ipAddress,
        before: {
          id: competencia.id,
          name: competencia.name,
          status: competencia.status,
          registrationStartAt: competencia.registrationStartAt,
          registrationEndAt: competencia.registrationEndAt,
          esPredeterminada: competencia.esPredeterminada,
          // Nombres anteriores de los recuentos, que ya leían otras consultas de la auditoría.
          deletedIndividualRegistrations: eliminados.inscripcionesIndividuales,
          deletedRelayRegistrations: eliminados.equiposDeRelevo,
        },
        after: { eliminados },
      },
      { tx }
    );
    if (competencia.esPredeterminada) {
      await audit(
        {
          userId: actor.userId,
          action: "COMPETITION_DEFAULT_CLEARED",
          entityType: "Competition",
          entityId: id,
          ipAddress: actor.ipAddress,
          before: { competenciaPredeterminadaId: id },
          after: { competenciaPredeterminadaId: null, motivo: "competencia eliminada" },
        },
        { tx }
      );
    }

    return { competitionId: id, nombre: competencia.name, eraPredeterminada: competencia.esPredeterminada, eliminados };
  }, LONG_TRANSACTION_OPTIONS);
}
