/**
 * C-05: solicitudes de alta e incorporación (RUN no registrado al postular).
 *
 * El club ve las de SU club con los datos declarados; administración ve todas y es la única que
 * las resuelve. La solicitud nunca crea una persona por sí sola.
 *
 * RESOLUCIÓN (administración), en una transacción, con el RUN bloqueado antes que la persona:
 *  - `crear`: comprueba de nuevo que no haya una persona NO eliminada con el RUN. Si solo hay
 *    eliminadas, exige `crearPeseACoincidenciaEliminada: true`: crea una persona NUEVA (no
 *    restaura ni reutiliza la eliminada, no copia cuentas, credenciales, roles ni membresías) y lo
 *    audita. Luego la asigna al club solicitante.
 *  - `vincular`: la persona se busca por el RUN de la solicitud y debe ser la que administración
 *    revisó (`personaEsperadaId`); no se acepta un id arbitrario. Si ya tiene una propuesta
 *    pendiente de ese club, la solicitud queda `resuelta_por_propuesta` sin crear otra membresía.
 *    Si tiene una membresía activa en otro club, es un traslado con confirmación explícita.
 *  - En ambos: fecha efectiva no futura, historial comprobado y auditoría.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { AppError, ForbiddenError, NotFoundError } from "../../shared/errors";
import type { ActorContext } from "../../shared/actorContext";
import { fechaCalendarioAUtc } from "../../shared/fecha.util";
import { audit } from "../audit/audit.service";
import { createPerson } from "../persons/persons.service";
import type { PersonCreateInput } from "../persons/persons.schemas";
import {
  bloquear,
  bloquearMembresiasDePersona,
  decidirActivacion,
  fechaEfectivaValida,
  finalizarPorTraslado,
  historialDePersona,
  type OpcionesDeActivacion,
} from "../swimmer-assignment/membresias.protocolo";
import { assertClubActive, syncSwimmerRole } from "../swimmer-assignment/assignment.service";
import { CLAVES_DE_BLOQUEO } from "./incorporaciones.claves";
import { vistaDeSolicitud } from "./postulacion.service";

type Tx = Prisma.TransactionClient;

export async function listarSolicitudes(
  query: { estado?: "pendiente" | "aprobada" | "rechazada" | "resuelta_por_propuesta"; clubId?: string; page: number; pageSize: number },
  actor: ActorContext
) {
  let clubId: string | undefined;
  if (actor.scope.kind === "club") {
    if (query.clubId && query.clubId !== actor.scope.clubId) throw new ForbiddenError("No tiene permiso para consultar datos de otro club.");
    clubId = actor.scope.clubId;
  } else if (actor.scope.kind === "admin") {
    clubId = query.clubId;
  } else {
    throw new ForbiddenError("No tiene permiso para operar a nivel de club.");
  }
  const where: Prisma.SolicitudAltaIncorporacionWhereInput = { ...(clubId ? { clubId } : {}), ...(query.estado ? { estado: query.estado } : {}) };
  const [filas, total] = await Promise.all([
    prisma.solicitudAltaIncorporacion.findMany({
      where,
      orderBy: [{ creadoEn: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: { id: true },
    }),
    prisma.solicitudAltaIncorporacion.count({ where }),
  ]);
  const items = await Promise.all(filas.map((f) => vistaDeSolicitud(f.id)));
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * Detalle. El club ve la suya; administración ve además las COINCIDENCIAS del RUN: la persona
 * vigente (si alguien la registró en el intertanto) y los identificadores de las eliminadas.
 * Esa información es solo de administración.
 */
export async function obtenerSolicitud(id: string, actor: ActorContext) {
  const s = await prisma.solicitudAltaIncorporacion.findUnique({ where: { id }, select: { id: true, clubId: true, runNormalizado: true } });
  if (!s) throw new NotFoundError("Solicitud de alta");
  if (actor.scope.kind === "club" && s.clubId !== actor.scope.clubId) throw new ForbiddenError("No tiene permiso para consultar solicitudes de otro club.");
  if (actor.scope.kind === "swimmer") throw new ForbiddenError("No tiene permiso para operar a nivel de club.");
  const solicitud = await vistaDeSolicitud(id);
  if (actor.scope.kind !== "admin") return solicitud;

  const vigente = await prisma.person.findFirst({
    where: { run: s.runNormalizado, deletedAt: null },
    select: { id: true, fullName: true, run: true, clubAssignments: { where: { status: "active" }, select: { id: true, club: { select: { id: true, name: true } }, startDate: true } } },
  });
  const eliminadas = await prisma.person.findMany({ where: { run: s.runNormalizado, deletedAt: { not: null } }, select: { id: true, deletedAt: true } });
  return {
    ...solicitud,
    coincidencias: {
      personaVigente: vigente && { id: vigente.id, fullName: vigente.fullName, run: vigente.run, membresiaActiva: vigente.clubAssignments[0] ?? null },
      eliminadas,
    },
  };
}

/** Bloquea la solicitud (con su RUN antes) y exige que siga pendiente. */
async function bloquearSolicitudPendiente(tx: Tx, id: string) {
  const previa = await tx.solicitudAltaIncorporacion.findUnique({ where: { id }, select: { runNormalizado: true } });
  if (!previa) throw new NotFoundError("Solicitud de alta");
  await bloquear(tx, CLAVES_DE_BLOQUEO.run(previa.runNormalizado));
  await tx.$queryRaw`SELECT id FROM solicitudes_alta_incorporacion WHERE id = ${id} FOR UPDATE`;
  const solicitud = await tx.solicitudAltaIncorporacion.findUniqueOrThrow({ where: { id } });
  if (solicitud.estado !== "pendiente") throw new AppError(409, "SOLICITUD_YA_RESUELTA", "La solicitud ya no está pendiente: otra operación la resolvió.");
  return solicitud;
}

export type AprobacionDeAlta = OpcionesDeActivacion &
  (
    | { modo: "crear"; datosPersona: Omit<PersonCreateInput, "run">; crearPeseACoincidenciaEliminada?: boolean }
    | { modo: "vincular"; personaEsperadaId: string }
  );

export async function aprobarSolicitud(id: string, input: AprobacionDeAlta, actor: ActorContext, opciones?: { ahora?: Date }) {
  const ahora = opciones?.ahora ?? new Date();
  const fechaEfectiva = fechaEfectivaValida(input.fechaEfectiva, ahora);

  const solicitudId = await prisma.$transaction(async (tx) => {
    const solicitud = await bloquearSolicitudPendiente(tx, id);
    await assertClubActive(solicitud.clubId, tx);
    const vigente = await tx.person.findFirst({ where: { run: solicitud.runNormalizado, deletedAt: null }, select: { id: true } });

    let personaId: string;
    let creadaPeseAEliminada = false;
    if (input.modo === "crear") {
      if (vigente) {
        throw new AppError(409, "PERSONA_YA_REGISTRADA", "Ya hay una persona registrada con ese RUN: use «vincular» tras revisarla.", { personaId: vigente.id });
      }
      const eliminadas = await tx.person.findMany({ where: { run: solicitud.runNormalizado, deletedAt: { not: null } }, select: { id: true } });
      if (eliminadas.length > 0 && input.crearPeseACoincidenciaEliminada !== true) {
        throw new AppError(
          409,
          "COINCIDENCIA_ELIMINADA",
          "El RUN coincide con personas eliminadas. Para crear una persona NUEVA (sin restaurar ni heredar nada) confírmelo expresamente.",
          { personasEliminadas: eliminadas.map((e) => e.id) }
        );
      }
      const persona = await createPerson({ ...input.datosPersona, run: solicitud.runNormalizado }, actor, { tx });
      personaId = persona.id;
      if (eliminadas.length > 0) {
        creadaPeseAEliminada = true;
        await audit(
          {
            userId: actor.userId,
            action: "PERSON_CREATED_DESPITE_DELETED_MATCH",
            entityType: "Person",
            entityId: persona.id,
            ipAddress: actor.ipAddress,
            after: { personaId: persona.id, solicitudId: id, coincidenciasEliminadas: eliminadas.map((e) => e.id) },
          },
          { tx }
        );
      }
    } else {
      if (!vigente) throw new AppError(409, "PERSONA_NO_REGISTRADA", "No hay una persona registrada con el RUN de la solicitud: use «crear».");
      if (vigente.id !== input.personaEsperadaId) {
        throw new AppError(409, "PERSONA_DISTINTA", "La persona registrada con ese RUN no es la que revisó. Revise de nuevo.");
      }
      personaId = vigente.id;
    }

    const bloqueadas = await bloquearMembresiasDePersona(tx, personaId);
    const pendiente = bloqueadas.find((m) => m.status === "pending" && m.club_id === solicitud.clubId);
    const revision = { revisadoPorUserId: actor.userId, revisadoEn: ahora };
    if (pendiente) {
      // Ya hay una propuesta pendiente de ese club: la solicitud se resuelve por ella, sin otra membresía.
      await tx.solicitudAltaIncorporacion.update({ where: { id }, data: { estado: "resuelta_por_propuesta", personaId, propuestaExistenteId: pendiente.id, ...revision } });
      await audit(
        { userId: actor.userId, action: "SWIMMER_INCORPORATION_REQUEST_RESOLVED_BY_PROPOSAL", entityType: "SolicitudAltaIncorporacion", entityId: id, ipAddress: actor.ipAddress, after: { id, personaId, propuestaId: pendiente.id } },
        { tx }
      );
      return id;
    }

    const historial = await historialDePersona(tx, personaId);
    const decision = decidirActivacion(bloqueadas, historial, solicitud.clubId, { ...input, fechaEfectiva }, { permiteTraslado: true });
    const anterior = decision.vigente ? await finalizarPorTraslado(tx, decision.vigente, decision.fechaEfectiva, ahora) : null;
    const membresia = await tx.clubSwimmer.create({
      data: {
        clubId: solicitud.clubId,
        personId: personaId,
        status: "active",
        requestedByUserId: solicitud.solicitadoPorUserId,
        reviewedByUserId: actor.userId,
        reviewedAt: ahora,
        startDate: fechaCalendarioAUtc(decision.fechaEfectiva),
      },
    });
    await syncSwimmerRole(personaId, tx);
    await tx.solicitudAltaIncorporacion.update({
      where: { id },
      data: { estado: "aprobada", personaId, membresiaId: membresia.id, personaCreadaPeseAEliminada: creadaPeseAEliminada, ...revision },
    });
    if (anterior) {
      await audit(
        { userId: actor.userId, action: "SWIMMER_ASSIGNMENT_ENDED_BY_TRANSFER", entityType: "ClubSwimmer", entityId: anterior.id, ipAddress: actor.ipAddress, after: { ...anterior, nuevaMembresiaId: membresia.id, via: "solicitud-alta" } },
        { tx }
      );
    }
    await audit(
      {
        userId: actor.userId,
        action: "SWIMMER_INCORPORATION_REQUEST_APPROVED",
        entityType: "SolicitudAltaIncorporacion",
        entityId: id,
        ipAddress: actor.ipAddress,
        after: { id, modo: input.modo, personaId, membresiaId: membresia.id, membresiaFinalizadaId: anterior?.id ?? null, historialIncompletoAceptado: decision.historialIncompletoAceptado },
      },
      { tx }
    );
    return id;
  });

  return vistaDeSolicitud(solicitudId);
}

export async function rechazarSolicitud(id: string, motivo: string | undefined, actor: ActorContext, opciones?: { ahora?: Date }) {
  const ahora = opciones?.ahora ?? new Date();
  await prisma.$transaction(async (tx) => {
    await bloquearSolicitudPendiente(tx, id);
    await tx.solicitudAltaIncorporacion.update({
      where: { id },
      data: { estado: "rechazada", motivoRechazo: motivo?.trim() || null, revisadoPorUserId: actor.userId, revisadoEn: ahora },
    });
    await audit({ userId: actor.userId, action: "SWIMMER_INCORPORATION_REQUEST_REJECTED", entityType: "SolicitudAltaIncorporacion", entityId: id, ipAddress: actor.ipAddress, after: { id, estado: "rechazada" } }, { tx });
  });
  return vistaDeSolicitud(id);
}
