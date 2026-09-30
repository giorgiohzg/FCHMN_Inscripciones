/**
 * Lectura del uso de cupos de una competencia y aplicación del cierre
 * automático.
 *
 * La lectura tiene que ocurrir DENTRO de la misma transacción serializable
 * que hace el alta: el cupo es una regla agregada sobre un conjunto de filas
 * y ningún índice único puede expresarla. Contar fuera y escribir después
 * dejaría la misma ventana que ya se cerró para los límites por nadador
 * (hallazgo 9): dos solicitudes simultáneas leerían el mismo total y ambas
 * insertarían. Por eso todas estas funciones reciben el cliente `tx`.
 */
import type { Prisma } from "@prisma/client";
import { audit } from "../audit/audit.service";
import type { ActorContext } from "../../shared/actorContext";
import { shouldCloseRegistrations } from "./competition-capacity.rules";
import { computeEffectiveStatus } from "./competitions.rules";

/** Subconjunto del cliente Prisma que estas funciones necesitan. */
type Db = Prisma.TransactionClient;

export interface CompetitionCapacityUsage {
  /** Identidad de cada nadador distinto con inscripción activa. */
  swimmerIds: Set<string>;
  /** Por club, los nadadores distintos que ese club tiene inscritos. */
  swimmerIdsByClub: Map<string, Set<string>>;
}

/**
 * Nadadores DISTINTOS con inscripción activa en la competencia.
 *
 * Suma las dos vías por las que alguien queda inscrito:
 *   - una inscripción individual confirmada;
 *   - ser integrante de un equipo de relevo confirmado.
 *
 * Se devuelven los identificadores, no solo los totales, porque para decidir
 * si un alta consume cupo hay que saber si esas personas concretas ya estaban.
 */
export async function readCapacityUsage(db: Db, competitionId: string): Promise<CompetitionCapacityUsage> {
  const individuales = await db.registration.findMany({
    where: { status: "confirmed", competitionEvent: { competitionId } },
    select: { personId: true, clubId: true },
  });

  const relevos = await db.relayRegistration.findMany({
    where: { status: "confirmed", competitionEvent: { competitionId } },
    select: { clubId: true, members: { select: { personId: true } } },
  });

  const swimmerIds = new Set<string>();
  const swimmerIdsByClub = new Map<string, Set<string>>();

  function anotar(personId: string, clubId: string) {
    swimmerIds.add(personId);
    let delClub = swimmerIdsByClub.get(clubId);
    if (!delClub) {
      delClub = new Set<string>();
      swimmerIdsByClub.set(clubId, delClub);
    }
    delClub.add(personId);
  }

  for (const r of individuales) anotar(r.personId, r.clubId);
  // El club de un integrante de relevo es el del EQUIPO, no el de una
  // membresía suelta: es el club en cuya representación compite.
  for (const rr of relevos) for (const m of rr.members) anotar(m.personId, rr.clubId);

  return { swimmerIds, swimmerIdsByClub };
}

/** Cuántos de `personIds` no estaban ya inscritos (global y por club). */
export function contarNuevos(
  usage: CompetitionCapacityUsage,
  clubId: string,
  personIds: readonly string[]
): { newToCompetition: number; newToClub: number } {
  const delClub = usage.swimmerIdsByClub.get(clubId) ?? new Set<string>();
  // `Set` sobre los entrantes: un equipo de relevo con el mismo nadador
  // repetido no puede contar dos cupos. (Esa repetición ya la rechaza la
  // validación de relevos, pero el conteo no debe depender de ello.)
  const entrantes = new Set(personIds);
  let newToCompetition = 0;
  let newToClub = 0;
  for (const id of entrantes) {
    if (!usage.swimmerIds.has(id)) newToCompetition++;
    if (!delClub.has(id)) newToClub++;
  }
  return { newToCompetition, newToClub };
}

/** Totales legibles para la interfaz y para los mensajes de error. */
export function resumirUso(usage: CompetitionCapacityUsage, clubId?: string) {
  return {
    totalSwimmers: usage.swimmerIds.size,
    clubSwimmers: clubId ? (usage.swimmerIdsByClub.get(clubId)?.size ?? 0) : 0,
  };
}

/**
 * Cierra las inscripciones si el cupo global quedó alcanzado.
 *
 * Se ejecuta dentro de la misma transacción que el alta, de modo que el
 * cierre y la inscripción que lo provoca son atómicos: no existe un estado
 * intermedio en el que la competencia esté llena y todavía figure abierta.
 *
 * Solo actúa sobre `scheduled` y `open`. Un estado terminal o manual
 * (draft, cancelled, in_progress, finished) no se toca nunca por un efecto
 * colateral: esos requieren una acción explícita del administrador, igual que
 * en `computeEffectiveStatus`.
 */
export async function cerrarSiSeAlcanzoElCupo(
  db: Db,
  competitionId: string,
  totalSwimmers: number,
  actor: ActorContext
): Promise<boolean> {
  /**
   * LA FILA DE LA COMPETENCIA SE LEE AQUÍ, DENTRO DE LA TRANSACCIÓN.
   *
   * Antes llegaba como parámetro, leída fuera. Además de decidir sobre un
   * dato potencialmente obsoleto, eso dejaba un agujero de concurrencia que
   * ninguna transacción serializable podía cerrar:
   *
   *   - la reapertura LEE `registrations` y ESCRIBE `competitions`;
   *   - el alta ESCRIBÍA `registrations` y no leía `competitions` en ningún
   *     momento dentro de su transacción.
   *
   * Con una sola de las dos aristas no hay ciclo, y PostgreSQL confirmaba las
   * dos: la reapertura contaba de menos y dejaba la competencia ABIERTA con
   * el cupo ya alcanzado. Leer la fila aquí crea la arista que faltaba, se
   * forma el ciclo y el detector de serialización aborta una de las dos.
   *
   * El orden se mantiene: `registrations` primero (ya las leyó y escribió
   * quien llama), `competitions` al final.
   */
  const competition = await db.competition.findUnique({
    where: { id: competitionId },
    select: { id: true, status: true, maxSwimmers: true, registrationStartAt: true, registrationEndAt: true },
  });
  if (!competition) return false;

  if (!shouldCloseRegistrations(competition.maxSwimmers, totalSwimmers)) return false;

  /**
   * SE DECIDE POR EL ESTADO EFECTIVO, no por el guardado.
   *
   * Esto costó un fallo. Se intentó exigir `status === "open"` sobre la fila,
   * razonando que `scheduled` era inalcanzable porque en una competencia
   * programada no se puede inscribir. Es falso: el auto-estado se calcula al
   * LEER y solo se persiste en esa lectura, así que una competencia cuyas
   * fechas ya la sitúan abierta puede seguir guardada como `scheduled` si
   * nadie la ha leído por la vía que lo persiste. Con la comprobación sobre
   * la fila, el cierre por cupo no ocurría nunca en ese caso.
   *
   * Calcularlo aquí es además lo correcto por sí mismo: una competencia que
   * de verdad no ha abierto no debe quedar en cierre parcial, y el estado
   * efectivo es el único que distingue los dos casos.
   *
   * Si el efectivo ya es `individual_closed` o `closed`, esto NO hace nada.
   * Es lo que permite que un administrador inscriba por encima del cupo sin
   * que cada alta suya vuelva a "cerrar" lo ya cerrado, reescribiendo la marca
   * de tiempo y llenando la auditoría de cierres repetidos.
   */
  const estadoEfectivo = computeEffectiveStatus(
    competition.status,
    competition.registrationStartAt,
    competition.registrationEndAt,
    new Date()
  );
  if (estadoEfectivo !== "open") return false;

  /**
   * El cupo lleno cierra las INDIVIDUALES, no la competencia entera.
   *
   * Los relevos se forman con nadadores que ya ocupan cupo: no consumen
   * ninguno, así que no hay razón para bloquearlos. Antes esto escribía
   * `closed` y dejaba a los clubes sin poder armar sus equipos.
   */
  await db.competition.update({
    where: { id: competition.id },
    data: {
      status: "individual_closed",
      registrationsClosedReason: "capacity",
      registrationsClosedAt: new Date(),
      updatedBy: actor.userId,
    },
  });

  await audit(
    {
      userId: actor.userId,
      action: "COMPETITION_REGISTRATIONS_AUTO_CLOSED_BY_CAPACITY",
      entityType: "Competition",
      entityId: competition.id,
      ipAddress: actor.ipAddress,
      before: { status: competition.status, estadoEfectivo, maxSwimmers: competition.maxSwimmers },
      after: { status: "individual_closed", totalSwimmers },
    },
    { tx: db }
  );

  return true;
}

/**
 * Deja constancia de una inscripción que un administrador hizo POR ENCIMA del
 * cupo.
 *
 * Es una acción de auditoría distinta de la excepción por cierre, y la
 * distinción importa: «operé con las inscripciones cerradas» y «metí un
 * nadador más de los que caben» son dos permisos excepcionales diferentes, y
 * quien revise después necesita poder contarlos por separado. Pueden darse a
 * la vez.
 *
 * Se guarda el conteo y el máximo VIGENTES en el momento, no solo el hecho:
 * el cupo se puede editar más tarde, y sin esos dos números el registro no
 * permitiría reconstruir por cuánto se excedió.
 */
export async function registrarExcesoDeCupo(
  db: Db,
  params: {
    competitionId: string;
    entityType: "Registration" | "RelayRegistration";
    entityId: string;
    maxSwimmers: number;
    totalSwimmersAntes: number;
    totalSwimmersDespues: number;
    nuevosNadadores: number;
  },
  actor: ActorContext
): Promise<void> {
  await audit(
    {
      userId: actor.userId,
      action: "REGISTRATION_CREATED_OVER_CAPACITY_BY_ADMIN",
      entityType: params.entityType,
      entityId: params.entityId,
      ipAddress: actor.ipAddress,
      after: {
        competitionId: params.competitionId,
        maxSwimmers: params.maxSwimmers,
        totalSwimmersAntes: params.totalSwimmersAntes,
        totalSwimmersDespues: params.totalSwimmersDespues,
        nuevosNadadores: params.nuevosNadadores,
        excedente: params.totalSwimmersDespues - params.maxSwimmers,
      },
    },
    { tx: db }
  );
}
