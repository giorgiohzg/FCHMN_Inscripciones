/**
 * Reportes exclusivos de administración que se calculan por CLUB de la inscripción:
 *
 *  - las opciones del selector de clubes del reporte detallado (clubes con al menos una
 *    inscripción confirmada, individual o de relevo, en la competencia);
 *  - el resumen de inscripciones por club.
 *
 * Ninguno entrega datos personales: solo identificadores y nombres de CLUB y cifras.
 *
 * El club es SIEMPRE el de la inscripción (`registrations.club_id`,
 * `relay_registrations.club_id`), nunca la membresía actual de la persona: el resumen
 * describe lo que se inscribió, aunque el nadador haya cambiado de club después.
 */
import { prisma } from "../../shared/prisma.client";
import { ForbiddenError, NotFoundError } from "../../shared/errors";
import type { ActorContext } from "../../shared/actorContext";
import { exigirCompetenciaVisible } from "../competitions/competitions.visibilidad";
import { compararFilasResumen, sumarTotales, type FilaResumenClub, type TotalesResumen } from "./resumenPorClub.rules";

/**
 * Segunda barrera, además de `requireRole("admin")` en la ruta: el servicio no confía en que
 * quien lo llame haya puesto el guard. El alcance sale de la identidad vigente
 * (`buildActorContext`), y quien combina administración con otro rol resuelve a `admin`.
 */
function exigirAdministracion(actor: ActorContext): void {
  if (actor.scope.kind !== "admin") {
    throw new ForbiddenError("Este reporte es exclusivo de administración.");
  }
}

async function competenciaDelReporte(competitionId: string, actor: ActorContext) {
  const competencia = await prisma.competition.findUnique({
    where: { id: competitionId },
    select: { id: true, name: true, status: true, registrationStartAt: true, registrationEndAt: true },
  });
  if (!competencia) throw new NotFoundError("Competencia");
  // Administración ve también las ocultas; la regla sigue siendo la única de AUD-07.
  exigirCompetenciaVisible(competencia, actor);
  return competencia;
}

export interface OpcionClub {
  id: string;
  name: string;
}

/**
 * Clubes con al menos una inscripción CONFIRMADA (individual o de relevo) en la competencia.
 * Una sola consulta; un club que solo tiene relevos aparece, uno que solo tiene canceladas no.
 */
export async function listarClubesConInscripciones(competitionId: string, actor: ActorContext): Promise<{ clubs: OpcionClub[] }> {
  exigirAdministracion(actor);
  await competenciaDelReporte(competitionId, actor);

  const enLaCompetencia = { status: "confirmed" as const, competitionEvent: { competitionId } };
  const clubes = await prisma.club.findMany({
    where: { OR: [{ registrations: { some: enLaCompetencia } }, { relayRegistrations: { some: enLaCompetencia } }] },
    select: { id: true, name: true },
  });
  clubes.sort((a, b) => compararFilasResumen({ clubName: a.name, clubId: a.id }, { clubName: b.name, clubId: b.id }));
  return { clubs: clubes };
}

export interface ResumenPorClub {
  competitionId: string;
  competitionName: string;
  clubs: FilaResumenClub[];
  totales: TotalesResumen;
}

interface FilaSql {
  club_id: string;
  club_name: string;
  varones: number;
  damas: number;
  nadadores: number;
  individuales: number;
  relevos: number;
}

/**
 * Resumen de inscripciones por club de una competencia.
 *
 * Todo se agrega en UNA consulta (sin una consulta por club) y la respuesta no lleva RUN,
 * nombres de personas ni fechas de nacimiento. Reglas:
 *
 *  - Solo inscripciones `confirmed`, igual que los reportes y la exportación.
 *  - `individuales`: cada inscripción individual confirmada cuenta una vez.
 *  - `relevos`: cada EQUIPO confirmado cuenta una vez, sin multiplicar por integrantes.
 *  - `nadadores`: personas DISTINTAS por club, uniendo inscritos individuales e integrantes de
 *    relevos confirmados (`UNION` elimina la repetición dentro del club). Quien solo nada
 *    relevos cuenta.
 *  - `varones` / `damas`: por el sexo de la PERSONA (`persons.gender`, que solo admite `male`
 *    y `female`), no por el género de la prueba: un relevo mixto no crea un tercer grupo.
 *  - Se agrupa por `club_id`: dos clubes con el mismo nombre no se fusionan.
 */
export async function obtenerResumenPorClub(competitionId: string, actor: ActorContext): Promise<ResumenPorClub> {
  exigirAdministracion(actor);
  const competencia = await competenciaDelReporte(competitionId, actor);

  const filas = await prisma.$queryRaw<FilaSql[]>`
    WITH individuales AS (
      SELECT r.club_id, r.person_id
      FROM registrations r
      JOIN competition_events ce ON ce.id = r.competition_event_id
      WHERE ce.competition_id = ${competitionId}
        AND r.status = 'confirmed'::"RegistrationStatus"
    ),
    equipos AS (
      SELECT rr.id, rr.club_id
      FROM relay_registrations rr
      JOIN competition_events ce ON ce.id = rr.competition_event_id
      WHERE ce.competition_id = ${competitionId}
        AND rr.status = 'confirmed'::"RegistrationStatus"
    ),
    nadadores AS (
      SELECT club_id, person_id FROM individuales
      UNION
      SELECT e.club_id, m.person_id
      FROM equipos e
      JOIN relay_registration_members m ON m.relay_registration_id = e.id
    ),
    por_nadadores AS (
      SELECT n.club_id,
             count(*) FILTER (WHERE p.gender = 'male'::"PersonGender")   AS varones,
             count(*) FILTER (WHERE p.gender = 'female'::"PersonGender") AS damas,
             count(*)                                                    AS nadadores
      FROM nadadores n
      JOIN persons p ON p.id = n.person_id
      GROUP BY n.club_id
    ),
    por_individuales AS (SELECT club_id, count(*) AS n FROM individuales GROUP BY club_id),
    por_equipos AS (SELECT club_id, count(*) AS n FROM equipos GROUP BY club_id),
    clubes AS (SELECT club_id FROM individuales UNION SELECT club_id FROM equipos)
    SELECT c.id                              AS club_id,
           c.name                            AS club_name,
           COALESCE(pn.varones, 0)::int      AS varones,
           COALESCE(pn.damas, 0)::int        AS damas,
           COALESCE(pn.nadadores, 0)::int    AS nadadores,
           COALESCE(pi.n, 0)::int            AS individuales,
           COALESCE(pe.n, 0)::int            AS relevos
    FROM clubes k
    JOIN clubs c ON c.id = k.club_id
    LEFT JOIN por_nadadores pn ON pn.club_id = k.club_id
    LEFT JOIN por_individuales pi ON pi.club_id = k.club_id
    LEFT JOIN por_equipos pe ON pe.club_id = k.club_id
  `;

  const clubs: FilaResumenClub[] = filas
    .map((f) => ({
      clubId: f.club_id,
      clubName: f.club_name,
      varones: f.varones,
      damas: f.damas,
      totalNadadores: f.nadadores,
      pruebasIndividuales: f.individuales,
      relevos: f.relevos,
      totalPruebas: f.individuales + f.relevos,
    }))
    .sort(compararFilasResumen);

  return { competitionId: competencia.id, competitionName: competencia.name, clubs, totales: sumarTotales(clubs) };
}
