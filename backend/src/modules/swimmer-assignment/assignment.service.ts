import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { audit } from "../audit/audit.service";
import { AppError, ForbiddenError, ValidationError, NotFoundError } from "../../shared/errors";
import { mensajePublicable } from "../../shared/errorPublicable";
import { type ActorContext, assertClubAccess } from "../../shared/actorContext";
import type { Db, TxOption } from "../../shared/transaction";
import type { DirectAssignmentInput, AssignmentListQuery } from "./assignment.schemas";
import { fechaCalendarioAUtc, hoyEnZonaDelNegocio } from "../../shared/fecha.util";
import {
  bloquearMembresiasDePersona,
  decidirActivacion,
  ErrorDeMembresia,
  fechaEfectivaValida,
  finalizarPorTraslado,
  historialDePersona,
  type OpcionesDeActivacion,
} from "./membresias.protocolo";


/**
 * Quién ejecuta una operación que solo el administrador puede pedir.
 *
 * Es deliberadamente MÍNIMO: lo único que estas operaciones necesitan del actor
 * es a quién auditar. El alcance por club no aparece porque no se evalúa —el
 * permiso `swimmer-assignment:approve` ya lo decidió en la capa HTTP—, y un
 * campo que no se usa solo sirve para que alguien crea que protege algo.
 */
interface ContextoDeAuditoria {
  userId: string;
  ipAddress?: string;
}

/**
 * NO HAY UN `ActorContext` LOCAL.
 *
 * Existía uno, con `isAdmin?` y `actorClubId?` **opcionales**, y ese contrato
 * paralelo fue el origen de un defecto real: las rutas de proponer y finalizar
 * pasaban el `ActorContext` de `shared/actorContext` —que no tiene
 * `actorClubId`— y TypeScript lo aceptaba, porque un campo opcional ausente
 * encaja. En ejecución, la comparación `actor.actorClubId !== clubId` era
 * verdadera SIEMPRE para un no administrador, así que ningún club podía
 * proponer ni dar de baja en su propio plantel.
 *
 * Las operaciones con alcance usan ahora el `ActorContext` compartido y
 * `assertClubAccess`, que es exhaustivo sobre los tres alcances posibles.
 */

/**
 * UN SOLO CLUB ACTIVO ES UNA INVARIANTE, NO UN PARÁMETRO.
 *
 * Antes esto se consultaba en `system_settings` (`SWIMMER_SINGLE_CLUB_ACTIVE`)
 * y la regla solo se comprobaba si el parámetro estaba en `true`. Era una
 * configuración que no configuraba nada: la migración crea un índice único
 * parcial sobre `club_swimmers(person_id) WHERE status='active'` de forma
 * incondicional, así que con el parámetro en `false` PostgreSQL seguía
 * rechazando la segunda membresía — y el usuario, en vez del mensaje de
 * negocio, veía un error de base de datos.
 *
 * Se resolvió en favor de la invariante: la comprobación es incondicional y su
 * valor está en dar el mensaje claro ANTES de que la base lo impida. El índice
 * queda como red de seguridad frente a dos inserciones concurrentes, que la
 * comprobación por sí sola no puede evitar.
 */

/**
 * Sincroniza el PersonRole "swimmer" (y el UserRole de acceso, si ya
 * tiene credenciales) según si la persona sigue teniendo AL MENOS una
 * membresía de club activa — se llama después de cualquier cambio de
 * estado en ClubSwimmer. Reemplaza el checkbox manual "nadador" que
 * existía antes en la ficha de Personas: ya no hace falta tenerlo
 * marcado de antemano para poder asignar a alguien a un club — la
 * asignación misma es la que otorga el rol.
 *
 * Hallazgo 18: recibe el cliente de base de datos porque tiene que correr en
 * la MISMA transacción que el cambio de membresía que la provoca. Escritas
 * por separado, un fallo aquí dejaba la membresía guardada y el rol sin
 * sincronizar: un nadador dado de baja conservando el rol activo (y por lo
 * tanto inscribible), o uno recién incorporado sin el rol que necesita.
 */
export async function syncSwimmerRole(personId: string, db: Db) {
  const stillActive = await db.clubSwimmer.findFirst({ where: { personId, status: "active" } });

  const existingPersonRole = await db.personRole.findUnique({ where: { personId_roleType: { personId, roleType: "swimmer" } } });
  if (stillActive) {
    if (existingPersonRole) {
      if (!existingPersonRole.active) await db.personRole.update({ where: { id: existingPersonRole.id }, data: { active: true } });
    } else {
      await db.personRole.create({ data: { personId, roleType: "swimmer", active: true } });
    }
  } else if (existingPersonRole?.active) {
    await db.personRole.update({ where: { id: existingPersonRole.id }, data: { active: false } });
  }

  const user = await db.user.findUnique({ where: { personId } });
  if (!user) return;
  const roleRecord = await db.role.findUnique({ where: { name: "swimmer" } });
  if (!roleRecord) return;
  const hasUserRole = await db.userRole.findUnique({ where: { userId_roleId: { userId: user.id, roleId: roleRecord.id } } });
  if (stillActive && !hasUserRole) {
    await db.userRole.create({ data: { userId: user.id, roleId: roleRecord.id } });
  } else if (!stillActive && hasUserRole) {
    await db.userRole.delete({ where: { userId_roleId: { userId: user.id, roleId: roleRecord.id } } });
  }
}

export async function assertClubActive(clubId: string, db: Db = prisma) {
  const club = await db.club.findFirst({ where: { id: clubId, deletedAt: null } });
  if (!club) throw new NotFoundError("Club");
  if (club.status !== "active") throw new ValidationError("El club no está activo");
  return club;
}

/**
 * RB-06/A-04: retorna la asignación activa actual del nadador, si existe.
 * Usado también por otros módulos (ej. inscripciones) para determinar
 * automáticamente a qué club pertenece un nadador en un momento dado.
 */
export async function getCurrentClubForPerson(personId: string) {
  return prisma.clubSwimmer.findFirst({
    where: { personId, status: "active" },
    include: { club: { select: { id: true, name: true } } },
  });
}

/**
 * Respuesta de `GET /swimmer-assignments/current-club/:personId` (auditoría AUD-15).
 *
 * Devolvía la fila de membresía completa —quién la solicitó y la revisó, fechas, motivo de
 * rechazo— a cualquier usuario de club que consultara a cualquier persona, cuando el flujo de
 * propuesta (A-05) solo necesita saber A QUÉ CLUB pertenece. Ahora entrega únicamente el club.
 *
 * `getCurrentClubForPerson` conserva la membresía completa para quienes la necesitan por dentro
 * (cambio de club y fin de membresía).
 */
export async function getCurrentClubSummary(personId: string): Promise<{ club: { id: string; name: string } } | null> {
  const actual = await getCurrentClubForPerson(personId);
  return actual ? { club: { id: actual.club.id, name: actual.club.name } } : null;
}

/**
 * `restrictToClubId`: `undefined` = sin restricción (admin). Cualquier
 * otro valor SÍ restringe — incluido `null`, que significa "sin club
 * real detrás" (ej. rol delegado marcado pero no asignado a ningún
 * club): en ese caso no debe ver ninguna asignación, nunca todas.
 */
export async function listAssignments(query: AssignmentListQuery, restrictToClubId?: string | null) {
  const where: any = {};
  if (query.clubId) where.clubId = query.clubId;
  if (query.personId) where.personId = query.personId;
  if (query.status) where.status = query.status;
  if (restrictToClubId !== undefined) where.clubId = restrictToClubId ?? "__sin_club_real__";

  const [items, total] = await Promise.all([
    prisma.clubSwimmer.findMany({
      where,
      include: {
        club: { select: { id: true, name: true } },
        person: { select: { id: true, fullName: true, run: true } },
      },
      // La asignación masiva crea muchas filas con el mismo `createdAt`.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.clubSwimmer.count({ where }),
  ]);

  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getAssignmentById(id: string) {
  const assignment = await prisma.clubSwimmer.findUnique({
    where: { id },
    include: { club: { select: { id: true, name: true } }, person: { select: { id: true, fullName: true, run: true } } },
  });
  if (!assignment) throw new NotFoundError("Solicitud de asignación");
  return assignment;
}

/**
 * Asignación directa (sin flujo de propuesta/aprobación): un administrador
 * agrega un nadador a un club y la asignación queda ACTIVA de inmediato.
 *
 * C-05: sigue RECHAZANDO a quien tiene una membresía activa en OTRO club (no es un traslado;
 * los traslados van por la aprobación con confirmación o por `reassign`). Aplica el protocolo
 * común (`membresias.protocolo.ts`): bloqueo de la persona y de sus membresías antes de
 * evaluar, fecha efectiva no futura y comprobación del historial.
 */
export async function assignSwimmerDirectly(
  input: DirectAssignmentInput,
  actor: ContextoDeAuditoria,
  options?: TxOption & { ahora?: Date }
) {
  const ahora = options?.ahora ?? new Date();
  const fechaEfectiva = fechaEfectivaValida(input.fechaEfectiva, ahora);

  const escribir = async (tx: Prisma.TransactionClient) => {
    await assertClubActive(input.clubId, tx);
    const bloqueadas = await bloquearMembresiasDePersona(tx, input.personId);
    // Mismos mensajes que antes de C-05, ahora evaluados con las filas bloqueadas.
    const activa = bloqueadas.find((m) => m.status === "active");
    if (activa && activa.club_id === input.clubId) {
      throw new ValidationError("El nadador ya pertenece activamente a este club");
    }
    if (activa) {
      const clubVigente = await tx.club.findUnique({ where: { id: activa.club_id }, select: { name: true } });
      throw new ValidationError(
        `El nadador ya tiene una membresía activa en "${clubVigente?.name ?? "otro club"}". ` + `Debe finalizarla antes de asignarlo a un nuevo club.`
      );
    }
    const historial = await historialDePersona(tx, input.personId);
    const decision = decidirActivacion(
      bloqueadas,
      historial,
      input.clubId,
      { fechaEfectiva, aceptarHistorialIncompleto: input.aceptarHistorialIncompleto },
      { permiteTraslado: false, mensajeSinTraslado: () => "El nadador ya tiene una membresía activa en otro club." }
    );

    const created = await tx.clubSwimmer.create({
      data: {
        clubId: input.clubId,
        personId: input.personId,
        status: "active",
        requestedByUserId: actor.userId,
        reviewedByUserId: actor.userId,
        // `reviewedAt` es la marca de auditoría: CUÁNDO se hizo. Instante.
        reviewedAt: ahora,
        // `startDate` es el dato del negocio: DESDE CUÁNDO pertenece. Fecha.
        startDate: fechaCalendarioAUtc(decision.fechaEfectiva),
      },
    });
    await syncSwimmerRole(input.personId, tx);
    await audit(
      {
        userId: actor.userId,
        action: "SWIMMER_ASSIGNMENT_DIRECT",
        entityType: "ClubSwimmer",
        entityId: created.id,
        ipAddress: actor.ipAddress,
        after: { ...created, historialIncompletoAceptado: decision.historialIncompletoAceptado },
      },
      { tx }
    );
    return created;
  };

  // Prisma no anida transacciones: si el llamador ya abrió una, se escribe en ella.
  return options?.tx ? escribir(options.tx) : prisma.$transaction(escribir);
}

/**
 * Lista nadadores (rol activo) filtrados por su club ACTUAL: `clubFilter`
 * es un ID de club (muestra los activos en ese club) o el literal
 * `"none"` (muestra los que no tienen ningún club activo asignado) — es
 * el filtro que alimenta la pantalla de asignación masiva.
 */
export async function listSwimmersByClubFilter(query: { clubFilter: string; search?: string }) {
  const searchWhere = query.search
    ? {
        OR: [
          { fullName: { contains: query.search, mode: "insensitive" as const } },
          { run: { contains: query.search, mode: "insensitive" as const } },
        ],
      }
    : {};

  /**
   * SIN filtrar por el rol `swimmer`.
   *
   * El rol es DERIVADO: lo activa `syncSwimmerRole` cuando la persona pasa a
   * tener una membresía activa. Exigirlo aquí volvía la opción «Sin club»
   * estructuralmente vacía para quien más la necesita: una persona recién
   * creada no tiene club y, por eso mismo, tampoco tiene el rol — así que
   * quedaba invisible justo en la pantalla que existe para asignarla.
   *
   * Para el filtro por club el rol era además redundante: tener una membresía
   * activa en ese club ya implica el rol.
   */
  const baseWhere = {
    deletedAt: null,
    status: "active" as const,
    ...searchWhere,
  };

  const where =
    query.clubFilter === "none"
      ? { ...baseWhere, clubAssignments: { none: { status: "active" as const } } }
      : { ...baseWhere, clubAssignments: { some: { status: "active" as const, clubId: query.clubFilter } } };

  const persons = await prisma.person.findMany({
    where,
    orderBy: { fullName: "asc" },
    select: { id: true, fullName: true, run: true, gender: true, birthDate: true },
  });

  return persons;
}

export interface BulkAssignRowResult {
  personId: string;
  fullName: string;
  status: "assigned" | "error";
  error?: string;
  /**
   * C-05: código ESTABLE del rechazo (el de `AppError`, p. ej. `HISTORIAL_INCOMPLETO`,
   * `CONFLICTO_DE_FECHAS` o `VALIDATION_ERROR`), para que la interfaz decida sin leer el texto.
   * Ausente en un fallo inesperado, que solo lleva el mensaje genérico.
   */
  codigo?: string;
}

export interface BulkAssignSummary {
  totalCount: number;
  assignedCount: number;
  errorCount: number;
  results: BulkAssignRowResult[];
}

/**
 * Asigna varios nadadores al mismo club de una sola vez, reutilizando
 * exactamente las mismas reglas que `assignSwimmerDirectly` (uno por
 * uno, en una transacción por persona) — un nadador con problemas (ej. ya
 * tiene membresía activa en otro club) NO detiene el procesamiento de los
 * demás; se acumula un reporte por nadador.
 *
 * La fecha se resuelve y se valida UNA VEZ, antes del bucle: toda la tanda comparte la misma
 * fecha efectiva, y una fecha futura rechaza la operación entera (400) sin asignar a nadie.
 */
export async function bulkAssignSwimmers(
  input: { targetClubId: string; personIds: string[]; fechaEfectiva?: string; aceptarHistorialIncompleto?: boolean },
  actor: ContextoDeAuditoria,
  opciones?: { ahora?: Date }
): Promise<BulkAssignSummary> {
  const ahora = opciones?.ahora ?? new Date();
  const fechaEfectiva = fechaEfectivaValida(input.fechaEfectiva, ahora);
  await assertClubActive(input.targetClubId);

  const results: BulkAssignRowResult[] = [];
  let assignedCount = 0;

  for (const personId of input.personIds) {
    const person = await prisma.person.findFirst({ where: { id: personId, deletedAt: null } });
    const fullName = person?.fullName ?? personId;
    try {
      // Sin `ahora`: la fecha ya está fijada para toda la tanda, pero cada fila conserva el
      // instante real de su escritura en la auditoría.
      await assignSwimmerDirectly({ clubId: input.targetClubId, personId, fechaEfectiva, aceptarHistorialIncompleto: input.aceptarHistorialIncompleto }, actor);
      results.push({ personId, fullName, status: "assigned" });
      assignedCount++;
    } catch (err) {
      // Solo lo previsto llega al resultado; lo inesperado queda en el registro interno.
      results.push({
        personId,
        fullName,
        status: "error",
        error: mensajePublicable(err, "asignacion-masiva", personId),
        ...(err instanceof AppError ? { codigo: err.code } : {}),
      });
    }
  }

  return { totalCount: results.length, assignedCount, errorCount: results.length - assignedCount, results };
}

/**
 * Reasigna un nadador a otro club en un solo paso (traslado administrativo, en cualquier fecha).
 *
 * C-05: si hay una membresía activa en otro club, exige CONFIRMAR explícitamente cuál se
 * finaliza (`confirmarFinDeMembresiaId`); sin ella, o si cambió, responde 409 y no toca nada.
 * La anterior termina el día calendario previo a la fecha efectiva (`fecha_termino`), y su
 * `end_date` registra el instante de la operación. Todo en una transacción auditada.
 */
export async function reassignSwimmerToClub(
  personId: string,
  newClubId: string,
  actor: ContextoDeAuditoria,
  opcionesDeActivacion: OpcionesDeActivacion = {},
  opciones?: { ahora?: Date }
) {
  const ahora = opciones?.ahora ?? new Date();
  const fechaEfectiva = fechaEfectivaValida(opcionesDeActivacion.fechaEfectiva, ahora);
  await assertClubActive(newClubId);

  return prisma.$transaction(async (tx) => {
    const bloqueadas = await bloquearMembresiasDePersona(tx, personId);
    if (bloqueadas.some((m) => m.status === "active" && m.club_id === newClubId)) {
      throw new ValidationError("El nadador ya pertenece activamente a ese club");
    }
    const historial = await historialDePersona(tx, personId);
    const decision = decidirActivacion(bloqueadas, historial, newClubId, { ...opcionesDeActivacion, fechaEfectiva }, { permiteTraslado: true });

    const anterior = decision.vigente ? await finalizarPorTraslado(tx, decision.vigente, decision.fechaEfectiva, ahora) : null;
    const created = await tx.clubSwimmer.create({
      data: {
        clubId: newClubId,
        personId,
        status: "active",
        requestedByUserId: actor.userId,
        reviewedByUserId: actor.userId,
        reviewedAt: ahora, // marca de auditoría
        startDate: fechaCalendarioAUtc(decision.fechaEfectiva), // fecha efectiva
      },
    });
    await syncSwimmerRole(personId, tx);
    if (anterior) {
      await audit(
        {
          userId: actor.userId,
          action: "SWIMMER_ASSIGNMENT_ENDED_BY_TRANSFER",
          entityType: "ClubSwimmer",
          entityId: anterior.id,
          ipAddress: actor.ipAddress,
          after: { ...anterior, nuevaMembresiaId: created.id, via: "reassign" },
        },
        { tx }
      );
    }
    await audit(
      {
        userId: actor.userId,
        action: "SWIMMER_REASSIGNED",
        entityType: "ClubSwimmer",
        entityId: created.id,
        ipAddress: actor.ipAddress,
        before: anterior,
        after: { ...created, historialIncompletoAceptado: decision.historialIncompletoAceptado },
      },
      { tx }
    );
    return created;
  });
}

/**
 * C-05: ya NO existe una propuesta por `personId`. El club y su personal postulan por RUN
 * (`incorporaciones/postulacion.service.ts`), y administración también puede postular por RUN
 * con un club explícito. Este módulo conserva la resolución administrativa.
 */

/**
 * A-05: solo un administrador puede aprobar. Activa la MISMA fila pendiente (conserva su id).
 *
 * C-05: protocolo común. Tras bloquear a la persona y sus membresías, la propuesta debe seguir
 * pendiente (si no, 409 `SOLICITUD_YA_RESUELTA`). Si la persona tiene una membresía activa en
 * otro club, la aprobación es un TRASLADO y exige confirmar esa membresía; se finaliza el día
 * calendario anterior a la fecha efectiva y la nueva se activa, todo en una transacción. La
 * aprobación no reactiva a la persona ni desbloquea su cuenta.
 */
export async function approveAssignment(
  id: string,
  actor: ContextoDeAuditoria,
  opcionesDeActivacion: OpcionesDeActivacion = {},
  opciones?: { ahora?: Date }
) {
  const ahora = opciones?.ahora ?? new Date();
  const fechaEfectiva = fechaEfectivaValida(opcionesDeActivacion.fechaEfectiva, ahora);
  const before = await getAssignmentById(id);

  return prisma.$transaction(async (tx) => {
    const bloqueadas = await bloquearMembresiasDePersona(tx, before.personId);
    const propuesta = bloqueadas.find((m) => m.id === id);
    if (!propuesta || propuesta.status !== "pending") {
      throw new ErrorDeMembresia(409, "SOLICITUD_YA_RESUELTA", "La propuesta ya no está pendiente: otra operación la resolvió.");
    }
    const historial = await historialDePersona(tx, before.personId);
    const decision = decidirActivacion(bloqueadas, historial, before.clubId, { ...opcionesDeActivacion, fechaEfectiva }, { permiteTraslado: true });

    const anterior = decision.vigente ? await finalizarPorTraslado(tx, decision.vigente, decision.fechaEfectiva, ahora) : null;
    const updated = await tx.clubSwimmer.update({
      where: { id },
      data: {
        status: "active",
        startDate: fechaCalendarioAUtc(decision.fechaEfectiva), // fecha efectiva
        reviewedByUserId: actor.userId,
        reviewedAt: ahora, // marca de auditoría
      },
    });
    await syncSwimmerRole(before.personId, tx);
    if (anterior) {
      await audit(
        {
          userId: actor.userId,
          action: "SWIMMER_ASSIGNMENT_ENDED_BY_TRANSFER",
          entityType: "ClubSwimmer",
          entityId: anterior.id,
          ipAddress: actor.ipAddress,
          after: { ...anterior, nuevaMembresiaId: id, via: "approve" },
        },
        { tx }
      );
    }
    await audit(
      {
        userId: actor.userId,
        action: "SWIMMER_ASSIGNMENT_APPROVED",
        entityType: "ClubSwimmer",
        entityId: id,
        ipAddress: actor.ipAddress,
        before,
        after: { ...updated, membresiaFinalizadaId: anterior?.id ?? null, historialIncompletoAceptado: decision.historialIncompletoAceptado },
      },
      { tx }
    );
    return updated;
  });
}

/** Rechazar: mismo protocolo; la propuesta debe seguir pendiente tras bloquear. */
export async function rejectAssignment(id: string, reason: string | undefined, actor: ContextoDeAuditoria, opciones?: { ahora?: Date }) {
  const ahora = opciones?.ahora ?? new Date();
  const before = await getAssignmentById(id);

  return prisma.$transaction(async (tx) => {
    const bloqueadas = await bloquearMembresiasDePersona(tx, before.personId);
    const propuesta = bloqueadas.find((m) => m.id === id);
    if (!propuesta || propuesta.status !== "pending") {
      throw new ErrorDeMembresia(409, "SOLICITUD_YA_RESUELTA", "La propuesta ya no está pendiente: otra operación la resolvió.");
    }
    const updated = await tx.clubSwimmer.update({
      where: { id },
      data: { status: "rejected", reviewedByUserId: actor.userId, reviewedAt: ahora, rejectionReason: reason ?? null },
    });
    await audit(
      { userId: actor.userId, action: "SWIMMER_ASSIGNMENT_REJECTED", entityType: "ClubSwimmer", entityId: id, ipAddress: actor.ipAddress, before, after: updated },
      { tx }
    );
    return updated;
  });
}

/**
 * Baja simple de una membresía activa (club con alcance propio, o administración).
 *
 * C-05: la FECHA DE TÉRMINO la elige quien registra la baja (puede ser una renuncia comunicada
 * después) y es obligatoria: el servidor no elige ayer ni hoy. Es el último día de pertenencia
 * (inclusivo) y se guarda en `fecha_termino`; el instante real de la operación queda en
 * `end_date` y en la auditoría, sin retroceder. No toca inscripciones ni operaciones anteriores.
 *
 *  - Igual o anterior a hoy en Santiago (400 `FECHA_FUTURA`).
 *  - No anterior al inicio CONOCIDO; el mismo día del inicio es válido (409 `CONFLICTO_DE_FECHAS`).
 *  - Con inicio DESCONOCIDO no se inventa: 409 `HISTORIAL_INCOMPLETO`, que solo administración
 *    puede aceptar (`aceptarHistorialIncompleto`, auditado). Una cuenta de club que la envíe
 *    recibe 403: no puede otorgarse esa aceptación.
 *
 * Una baja hasta hoy inclusive implica que otra membresía solo podrá empezar después de hoy; una
 * baja retroactiva admite un inicio posterior a ella, si el historial lo permite.
 * Protocolo común: bloqueo de la persona, membresía todavía activa tras bloquear, roles y auditoría
 * en la misma transacción.
 */
export async function endAssignment(
  id: string,
  actor: ActorContext,
  input: { fechaTermino: string; aceptarHistorialIncompleto?: boolean },
  opciones?: { ahora?: Date }
) {
  const ahora = opciones?.ahora ?? new Date();
  const before = await getAssignmentById(id);
  assertClubAccess(actor, before.clubId);
  if (input.aceptarHistorialIncompleto === true && actor.scope.kind !== "admin") {
    throw new ForbiddenError("Solo administración puede aceptar un historial incompleto.");
  }
  const hoy = hoyEnZonaDelNegocio(ahora);
  if (input.fechaTermino > hoy) {
    throw new ErrorDeMembresia(400, "FECHA_FUTURA", `La fecha de término no puede ser posterior a hoy (${hoy}, America/Santiago).`, { hoy });
  }

  return prisma.$transaction(async (tx) => {
    const bloqueadas = await bloquearMembresiasDePersona(tx, before.personId);
    const membresia = bloqueadas.find((m) => m.id === id);
    if (!membresia || membresia.status !== "active") {
      throw new ErrorDeMembresia(409, "MEMBRESIA_NO_ACTIVA", "La membresía ya no está activa: otra operación la cambió.");
    }
    let historialIncompletoAceptado: string[] = [];
    if (membresia.start_date === null) {
      if (input.aceptarHistorialIncompleto !== true) {
        throw new ErrorDeMembresia(
          409,
          "HISTORIAL_INCOMPLETO",
          "La membresía no tiene fecha de inicio registrada: la fecha de término no se puede comprobar. Requiere revisión de administración.",
          { membresias: [id], requiereAdministracion: true }
        );
      }
      historialIncompletoAceptado = [id];
    } else if (input.fechaTermino < membresia.start_date) {
      throw new ErrorDeMembresia(409, "CONFLICTO_DE_FECHAS", `La fecha de término no puede ser anterior al inicio de la membresía (${membresia.start_date}).`, {
        conflictos: [{ membresiaId: id, motivo: `la membresía empezó el ${membresia.start_date}` }],
      });
    }
    const updated = await tx.clubSwimmer.update({
      where: { id },
      data: { status: "ended", endDate: ahora, fechaTermino: fechaCalendarioAUtc(input.fechaTermino) },
    });
    await syncSwimmerRole(before.personId, tx);
    await audit(
      {
        userId: actor.userId,
        action: "SWIMMER_ASSIGNMENT_ENDED",
        entityType: "ClubSwimmer",
        entityId: id,
        ipAddress: actor.ipAddress,
        before,
        after: { ...updated, historialIncompletoAceptado },
      },
      { tx }
    );
    return updated;
  });
}
