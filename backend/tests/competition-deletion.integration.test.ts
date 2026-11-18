/**
 * ELIMINACIÓN COMPLETA DE COMPETENCIAS (`competition-deletion.service.ts`), contra la base
 * desechable.
 *
 * Montaje sintético: dos competencias, A y B, que COMPARTEN las mismas pruebas de Catálogos. Cada
 * una con fecha, jornada, límite, dos pruebas asignadas con categorías, inscripciones individuales
 * confirmadas y canceladas, y relevos confirmados y cancelados con sus cuatro integrantes. Hay
 * además una persona que solo nada relevos.
 *
 *  - Eliminar A borra exactamente lo suyo y lo informa; B, Catálogos, personas, clubes,
 *    membresías, cuentas y la auditoría anterior quedan intactos.
 *  - Contraprueba: un `DELETE` directo de la competencia falla por las claves `RESTRICT`.
 *  - Un fallo dentro de la transacción revierte todo, sin auditoría.
 *  - La predeterminada desaparece con su fila y se audita; después se puede marcar otra.
 *  - Por HTTP: administración 200 con los recuentos; delegado 403; sin sesión 401; inexistente 404.
 *  - Concurrencia: una inscripción en curso se espera y se cuenta; una que llega durante la
 *    eliminación falla y no deja huérfanos.
 *
 * Datos sintéticos. Solo contra la base desechable (ver `helpers/testDb.ts`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addClubStaff, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";
import { eliminarCompetenciaCompleta } from "../src/modules/competitions/competition-deletion.service";
import { marcarPredeterminada } from "../src/modules/competitions/competencia-predeterminada.service";
import * as registrationsService from "../src/modules/registrations/registrations.service";
import * as relayService from "../src/modules/relay-registrations/relay-registrations.service";

let app: FastifyInstance;
const DIA = 86_400_000;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username} devolvió ${res.statusCode}`);
  return res.json().accessToken as string;
}

interface Entorno {
  adminId: string;
  clubId: string;
  personas: string[]; // 0..5 hacen individuales y relevos; 6 y 7, solo relevos
  catalogo: { eventoIndividual: string; eventoRelevo: string; categoriaIndividual: string; categoriaRelevo: string; tipoJornada: string };
}
let E: Entorno;
let tokens: { admin: string; delegado: string };

async function sembrar(): Promise<Entorno> {
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_elim", roleNames: ["admin"] });
  const club = await createClub("Club Eliminación Sintético", "ELI");
  const personas: string[] = [];
  for (let i = 0; i < 8; i++) {
    const p = await createPerson({ run: String(30000300 + i), username: `nad_elim_${i}`, firstName: `Sintético${i}`, gender: i % 2 ? "female" : "male", roles: ["swimmer"] });
    await addActiveMembership(club.id, p.id, admin.id);
    personas.push(p.id);
  }
  const delegado = await createPerson({ run: "30000399", username: "deleg_elim", firstName: "Delegada", gender: "female", roles: ["delegate"] });
  await addClubStaff(club.id, delegado.id, "delegate");
  await createUser({ username: "deleg_elim", roleNames: ["delegate"], personId: delegado.id });

  const individual = await prisma.testType.create({ data: { name: "Individual", swimmersCount: 1 } });
  const relevo = await prisma.testType.create({ data: { name: "Relevo", swimmersCount: 4 } });
  const d50 = await prisma.distance.create({ data: { meters: 50 } });
  const d200 = await prisma.distance.create({ data: { meters: 200 } });
  const libre = await prisma.stroke.create({ data: { name: "Libre" } });
  const tipoJornada = await prisma.sessionType.create({ data: { name: "Mañana" } });
  const eventoIndividual = await prisma.event.create({ data: { testTypeId: individual.id, distanceId: d50.id, strokeId: libre.id, gender: "mixed" } });
  const eventoRelevo = await prisma.event.create({ data: { testTypeId: relevo.id, distanceId: d200.id, strokeId: libre.id, gender: "mixed" } });
  const categoriaIndividual = await prisma.category.create({ data: { testTypeId: individual.id, name: "Master sintética", minAge: 18, maxAge: 99 } });
  const categoriaRelevo = await prisma.category.create({ data: { testTypeId: relevo.id, name: "Relevo sintético", minAge: 100, maxAge: 500 } });

  return {
    adminId: admin.id,
    clubId: club.id,
    personas,
    catalogo: { eventoIndividual: eventoIndividual.id, eventoRelevo: eventoRelevo.id, categoriaIndividual: categoriaIndividual.id, categoriaRelevo: categoriaRelevo.id, tipoJornada: tipoJornada.id },
  };
}

async function montarCompetencia(nombre: string) {
  const ahora = Date.now();
  const c = await prisma.competition.create({
    data: { name: nombre, status: "open", registrationStartAt: new Date(ahora - DIA), registrationEndAt: new Date(ahora + 10 * DIA) },
  });
  const fecha = await prisma.competitionDate.create({ data: { competitionId: c.id, date: new Date("2030-03-01T00:00:00.000Z") } });
  const jornada = await prisma.competitionSession.create({ data: { competitionDateId: fecha.id, sessionTypeId: E.catalogo.tipoJornada, competitionId: c.id } });
  await prisma.sessionLimit.create({ data: { competitionSessionId: jornada.id, maxIndividualEvents: 3, maxRelayEvents: 1 } });
  const ceInd = await prisma.competitionEvent.create({ data: { competitionId: c.id, eventId: E.catalogo.eventoIndividual, competitionSessionId: jornada.id, displayOrder: 1 } });
  const ceRel = await prisma.competitionEvent.create({ data: { competitionId: c.id, eventId: E.catalogo.eventoRelevo, competitionSessionId: jornada.id, displayOrder: 2 } });
  await prisma.competitionEventCategory.create({ data: { competitionEventId: ceInd.id, categoryId: E.catalogo.categoriaIndividual } });
  await prisma.competitionEventCategory.create({ data: { competitionEventId: ceRel.id, categoryId: E.catalogo.categoriaRelevo } });

  const base = { clubId: E.clubId, registeredByUserId: E.adminId };
  // 4 individuales confirmadas y 2 canceladas.
  for (let i = 0; i < 6; i++) {
    await prisma.registration.create({
      data: { ...base, competitionEventId: ceInd.id, personId: E.personas[i]!, categoryId: E.catalogo.categoriaIndividual, status: i < 4 ? "confirmed" : "cancelled" },
    });
  }
  // Un relevo confirmado (con las dos personas que solo nadan relevos) y uno cancelado.
  const integrantes = [
    [E.personas[0]!, E.personas[1]!, E.personas[6]!, E.personas[7]!],
    [E.personas[2]!, E.personas[3]!, E.personas[4]!, E.personas[5]!],
  ];
  for (const [k, grupo] of integrantes.entries()) {
    await prisma.relayRegistration.create({
      data: {
        ...base,
        competitionEventId: ceRel.id,
        categoryId: E.catalogo.categoriaRelevo,
        status: k === 0 ? "confirmed" : "cancelled",
        members: { create: grupo.map((personId, j) => ({ personId, orderPosition: j + 1 })) },
      },
    });
  }
  return { competencia: c, ceInd, ceRel, jornada, fecha };
}

/** Recuento de todo lo que pertenece a una competencia. */
async function contenidoDe(competitionId: string) {
  const deLa = { competitionEvent: { competitionId } };
  return {
    competencia: await prisma.competition.count({ where: { id: competitionId } }),
    fechas: await prisma.competitionDate.count({ where: { competitionId } }),
    jornadas: await prisma.competitionSession.count({ where: { competitionId } }),
    limites: await prisma.sessionLimit.count({ where: { competitionSession: { competitionId } } }),
    pruebas: await prisma.competitionEvent.count({ where: { competitionId } }),
    categorias: await prisma.competitionEventCategory.count({ where: deLa }),
    individuales: await prisma.registration.count({ where: deLa }),
    relevos: await prisma.relayRegistration.count({ where: deLa }),
    integrantes: await prisma.relayRegistrationMember.count({ where: { relayRegistration: deLa } }),
  };
}
const LLENA = { competencia: 1, fechas: 1, jornadas: 1, limites: 1, pruebas: 2, categorias: 2, individuales: 6, relevos: 2, integrantes: 8 };
const VACIA = { competencia: 0, fechas: 0, jornadas: 0, limites: 0, pruebas: 0, categorias: 0, individuales: 0, relevos: 0, integrantes: 0 };

async function inventarioGlobal() {
  return {
    eventos: await prisma.event.count(),
    categorias: await prisma.category.count(),
    tiposDePrueba: await prisma.testType.count(),
    tiposDeJornada: await prisma.sessionType.count(),
    distancias: await prisma.distance.count(),
    estilos: await prisma.stroke.count(),
    personas: await prisma.person.count(),
    roles: await prisma.personRole.count(),
    clubes: await prisma.club.count(),
    membresias: await prisma.clubSwimmer.count(),
    personal: await prisma.clubStaff.count(),
    cuentas: await prisma.user.count(),
  };
}

beforeAll(async () => {
  app = await buildServer();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  E = await sembrar();
  tokens = { admin: await login("admin_elim"), delegado: await login("deleg_elim") };
});

afterAll(async () => {
  await app.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("eliminación completa", () => {
  it("contraprueba: un DELETE directo de la competencia falla por las claves RESTRICT", async () => {
    const { competencia } = await montarCompetencia("Copa A sintética");
    await expect(prisma.$executeRaw`DELETE FROM competitions WHERE id = ${competencia.id}`).rejects.toThrow();
    expect(await contenidoDe(competencia.id)).toEqual(LLENA);
  });

  it("elimina todo lo de A, informa los recuentos reales y conserva B, Catálogos y lo demás", async () => {
    const a = await montarCompetencia("Copa A sintética");
    const b = await montarCompetencia("Copa B sintética");
    // Auditoría previa de A: debe sobrevivir a la eliminación.
    await prisma.auditLog.create({ data: { userId: E.adminId, action: "COMPETITION_UPDATED", entityType: "Competition", entityId: a.competencia.id } });
    const antes = await inventarioGlobal();

    const r = await eliminarCompetenciaCompleta(a.competencia.id, { userId: E.adminId, ipAddress: "127.0.0.1" });

    expect(r).toEqual({
      competitionId: a.competencia.id,
      nombre: "Copa A sintética",
      eraPredeterminada: false,
      eliminados: {
        inscripcionesIndividuales: 6,
        inscripcionesIndividualesConfirmadas: 4,
        inscripcionesIndividualesCanceladas: 2,
        equiposDeRelevo: 2,
        equiposDeRelevoConfirmados: 1,
        equiposDeRelevoCancelados: 1,
        integrantesDeRelevo: 8,
        pruebasAsignadas: 2,
        categoriasHabilitadas: 2,
        limitesDeJornada: 1,
        jornadas: 1,
        fechas: 1,
      },
    });
    expect(await contenidoDe(a.competencia.id)).toEqual(VACIA);
    expect(await contenidoDe(b.competencia.id)).toEqual(LLENA);
    expect(await inventarioGlobal()).toEqual(antes);
    // B sigue usando las MISMAS pruebas de Catálogos.
    expect(await prisma.competitionEvent.count({ where: { eventId: { in: [E.catalogo.eventoIndividual, E.catalogo.eventoRelevo] } } })).toBe(2);

    const previa = await prisma.auditLog.count({ where: { action: "COMPETITION_UPDATED", entityId: a.competencia.id } });
    expect(previa).toBe(1);
    const auditoria = await prisma.auditLog.findMany({ where: { action: "COMPETITION_DELETED" } });
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toMatchObject({ userId: E.adminId, entityType: "Competition", entityId: a.competencia.id, ipAddress: "127.0.0.1" });
    expect(auditoria[0]!.before).toMatchObject({ name: "Copa A sintética", esPredeterminada: false, deletedIndividualRegistrations: 6, deletedRelayRegistrations: 2 });
    expect(auditoria[0]!.after).toEqual({ eliminados: r.eliminados });
    expect(await prisma.auditLog.count({ where: { action: "COMPETITION_DEFAULT_CLEARED" } })).toBe(0);
  });

  it("una competencia sin inscripciones ni estructura también se elimina", async () => {
    const c = await prisma.competition.create({ data: { name: "Vacía sintética", registrationStartAt: new Date(), registrationEndAt: new Date(Date.now() + DIA) } });
    const r = await eliminarCompetenciaCompleta(c.id, { userId: E.adminId });
    expect(Object.values(r.eliminados).every((n) => n === 0)).toBe(true);
    expect(await prisma.competition.count({ where: { id: c.id } })).toBe(0);
  });

  it("ante un fallo dentro de la transacción revierte TODO y no audita", async () => {
    const a = await montarCompetencia("Copa A sintética");
    await expect(
      eliminarCompetenciaCompleta(a.competencia.id, { userId: E.adminId }, {
        antesDeAuditar: async () => {
          throw new Error("fallo sintético antes de auditar");
        },
      })
    ).rejects.toThrow("fallo sintético antes de auditar");
    expect(await contenidoDe(a.competencia.id)).toEqual(LLENA);
    expect(await prisma.auditLog.count({ where: { action: "COMPETITION_DELETED" } })).toBe(0);
  });

  it("si falla la propia auditoría, tampoco se elimina nada", async () => {
    const a = await montarCompetencia("Copa A sintética");
    // `userId` inexistente: la clave foránea de audit_logs rechaza el registro.
    await expect(eliminarCompetenciaCompleta(a.competencia.id, { userId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow();
    expect(await contenidoDe(a.competencia.id)).toEqual(LLENA);
  });
});

describe("competencia predeterminada", () => {
  it("la marca desaparece con la fila, se audita, y después se puede marcar otra", async () => {
    const a = await montarCompetencia("Copa A sintética");
    const b = await montarCompetencia("Copa B sintética");
    await marcarPredeterminada(a.competencia.id, { userId: E.adminId });

    const r = await eliminarCompetenciaCompleta(a.competencia.id, { userId: E.adminId });
    expect(r.eraPredeterminada).toBe(true);
    expect(await prisma.competition.count({ where: { esPredeterminada: true } })).toBe(0);
    const limpieza = await prisma.auditLog.findMany({ where: { action: "COMPETITION_DEFAULT_CLEARED" } });
    expect(limpieza.map((f) => [f.entityId, f.before, f.after])).toEqual([
      [a.competencia.id, { competenciaPredeterminadaId: a.competencia.id }, { competenciaPredeterminadaId: null, motivo: "competencia eliminada" }],
    ]);

    const lista = (await app.inject({ method: "GET", url: "/competitions?pageSize=50", headers: auth(tokens.admin) })).json();
    expect(lista.items.map((c: { id: string }) => c.id)).toEqual([b.competencia.id]);
    expect(lista.items[0].esPredeterminada).toBe(false);

    const marcar = await app.inject({ method: "PUT", url: `/competitions/${b.competencia.id}/predeterminada`, headers: auth(tokens.admin) });
    expect(marcar.json()).toEqual({ competenciaPredeterminadaId: b.competencia.id, cambio: true });
  });
});

describe("por HTTP", () => {
  it("administración recibe 200 con lo eliminado", async () => {
    const a = await montarCompetencia("Copa A sintética");
    const r = await app.inject({ method: "DELETE", url: `/competitions/${a.competencia.id}`, headers: auth(tokens.admin) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ competitionId: a.competencia.id, nombre: "Copa A sintética", eliminados: { inscripcionesIndividuales: 6, equiposDeRelevo: 2 } });
    expect(await contenidoDe(a.competencia.id)).toEqual(VACIA);
  });

  it("delegado 403 y sin sesión 401, sin eliminar ni auditar", async () => {
    const a = await montarCompetencia("Copa A sintética");
    expect((await app.inject({ method: "DELETE", url: `/competitions/${a.competencia.id}`, headers: auth(tokens.delegado) })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/competitions/${a.competencia.id}` })).statusCode).toBe(401);
    expect(await contenidoDe(a.competencia.id)).toEqual(LLENA);
    expect(await prisma.auditLog.count({ where: { action: "COMPETITION_DELETED" } })).toBe(0);
  });

  it("una competencia inexistente responde 404 sin auditar", async () => {
    const r = await app.inject({ method: "DELETE", url: "/competitions/00000000-0000-0000-0000-000000000000", headers: auth(tokens.admin) });
    expect(r.statusCode).toBe(404);
    expect(await prisma.auditLog.count({ where: { action: "COMPETITION_DELETED" } })).toBe(0);
  });
});

describe("concurrencia", () => {
  it("espera a una inscripción en curso y la incluye en lo eliminado", async () => {
    const a = await montarCompetencia("Copa A sintética");
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    let insertada!: () => void;
    const yaInsertada = new Promise<void>((r) => (insertada = r));

    const alta = prisma.$transaction(async (tx) => {
      await tx.registration.create({
        data: { competitionEventId: a.ceInd.id, personId: E.personas[6]!, clubId: E.clubId, categoryId: E.catalogo.categoriaIndividual, registeredByUserId: E.adminId },
      });
      insertada();
      await puerta;
    }, { timeout: 20_000 });
    await yaInsertada;

    let terminada = false;
    const eliminacion = eliminarCompetenciaCompleta(a.competencia.id, { userId: E.adminId }).then((r) => {
      terminada = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(terminada).toBe(false); // espera el bloqueo de la prueba

    soltar();
    await alta;
    const r = await eliminacion;
    expect(r.eliminados.inscripcionesIndividuales).toBe(7);
    expect(r.eliminados.inscripcionesIndividualesConfirmadas).toBe(5);
    expect(await contenidoDe(a.competencia.id)).toEqual(VACIA);
    expect(await prisma.registration.count()).toBe(0);
  });

  it("una inscripción que llega durante la eliminación falla y no deja huérfanos", async () => {
    const a = await montarCompetencia("Copa A sintética");
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    let bloqueada!: () => void;
    const yaBloqueada = new Promise<void>((r) => (bloqueada = r));

    const eliminacion = eliminarCompetenciaCompleta(a.competencia.id, { userId: E.adminId }, {
      antesDeAuditar: async () => {
        bloqueada();
        await puerta;
      },
    });
    await yaBloqueada;

    const alta = prisma.registration.create({
      data: { competitionEventId: a.ceInd.id, personId: E.personas[7]!, clubId: E.clubId, categoryId: E.catalogo.categoriaIndividual, registeredByUserId: E.adminId },
    });
    const resultadoAlta = alta.then(
      () => "creada",
      () => "rechazada"
    );
    await new Promise((r) => setTimeout(r, 300));
    soltar();

    await eliminacion;
    expect(await resultadoAlta).toBe("rechazada");
    expect(await prisma.registration.count()).toBe(0);
    expect(await contenidoDe(a.competencia.id)).toEqual(VACIA);
  });
});

// ---------------------------------------------------------------------------
// COORDINACIÓN EXPLÍCITA entre transacciones. Nada depende de una espera fija: cada paso
// avanza cuando la base MUESTRA el estado esperado (una sesión esperando un bloqueo) o cuando
// una promesa concreta se resuelve. El sondeo solo decide cada cuánto se mira.
// ---------------------------------------------------------------------------

async function esperarHasta(condicion: () => Promise<boolean>, descripcion: string, plazoMs = 15_000) {
  const limite = Date.now() + plazoMs;
  while (!(await condicion())) {
    if (Date.now() > limite) throw new Error(`No ocurrió a tiempo: ${descripcion}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Sesiones de esta base que esperan un bloqueo con una sentencia que coincide con `patron`. */
async function esperandoBloqueo(patron: string): Promise<number> {
  const filas = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${patron}`;
  return filas[0]!.n;
}

/**
 * Retiene la fila de una cuenta con FOR UPDATE. Toda escritura de auditoría de esa cuenta
 * necesita FOR KEY SHARE sobre ella (clave foránea de audit_logs), así que un servicio real
 * queda detenido JUSTO al auditar: después de su escritura principal y antes de lo que sigue.
 */
function retenerCuenta(userId: string) {
  let soltar!: () => void;
  const liberada = new Promise<void>((r) => (soltar = r));
  let avisar!: () => void;
  const tomada = new Promise<void>((r) => (avisar = r));
  const fin = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      avisar();
      await liberada;
    },
    { timeout: 30_000 }
  );
  return { tomada, soltar: () => soltar(), fin };
}

interface Observada<T> {
  listo: boolean;
  valor?: T;
  error?: unknown;
}

/** Sigue una promesa sin esperarla: para saber si ya terminó y cómo. */
function observar<T>(p: Promise<T>): Observada<T> {
  const estado: Observada<T> = { listo: false };
  p.then(
    (v) => Object.assign(estado, { listo: true, valor: v }),
    (e) => Object.assign(estado, { listo: true, error: e })
  );
  return estado;
}

async function auditoriaDe(competitionId: string) {
  const fila = await prisma.auditLog.findFirstOrThrow({ where: { action: "COMPETITION_DELETED", entityId: competitionId } });
  return (fila.after as { eliminados: Record<string, number> }).eliminados;
}

describe("recuentos frente a cancelaciones concurrentes", () => {
  it("una cancelación que entra entre el recuento y el borrado queda descrita tal como se eliminó (individual y relevo)", async () => {
    const a = await montarCompetencia("Copa A sintética");
    const individual = await prisma.registration.findFirstOrThrow({ where: { competitionEvent: { competitionId: a.competencia.id }, status: "confirmed" } });
    const relevo = await prisma.relayRegistration.findFirstOrThrow({ where: { competitionEvent: { competitionId: a.competencia.id }, status: "confirmed" } });

    let cancelInd!: Observada<number>;
    let cancelRel!: Observada<number>;
    const r = await eliminarCompetenciaCompleta(a.competencia.id, { userId: E.adminId }, {
      entreRecuentoYBorrado: async () => {
        // Dos cancelaciones por otra conexión. O terminan (nada las bloquea) o quedan esperando un
        // bloqueo de esta transacción: se avanza en cuanto ocurre una de las dos cosas, para cada una.
        cancelInd = observar(prisma.$executeRaw`UPDATE registrations SET status = 'cancelled' WHERE id = ${individual.id} AND status = 'confirmed'`);
        cancelRel = observar(prisma.$executeRaw`UPDATE relay_registrations SET status = 'cancelled' WHERE id = ${relevo.id} AND status = 'confirmed'`);
        await esperarHasta(
          async () =>
            (cancelInd.listo || (await esperandoBloqueo("UPDATE registrations%")) > 0) &&
            (cancelRel.listo || (await esperandoBloqueo("UPDATE relay_registrations%")) > 0),
          "las dos cancelaciones terminaron o quedaron esperando"
        );
      },
    });
    await esperarHasta(async () => cancelInd.listo && cancelRel.listo, "las cancelaciones concluyen tras la eliminación");
    expect(cancelInd.error).toBeUndefined();
    expect(cancelRel.error).toBeUndefined();

    // 1 = la cancelación se aplicó ANTES del borrado (la fila eliminada estaba cancelada);
    // 0 = esperó y encontró la fila ya eliminada (la fila eliminada estaba confirmada).
    const ind = cancelInd.valor!;
    const rel = cancelRel.valor!;
    expect(r.eliminados).toMatchObject({
      inscripcionesIndividuales: 6,
      inscripcionesIndividualesConfirmadas: 4 - ind,
      inscripcionesIndividualesCanceladas: 2 + ind,
      equiposDeRelevo: 2,
      equiposDeRelevoConfirmados: 1 - rel,
      equiposDeRelevoCancelados: 1 + rel,
      integrantesDeRelevo: 8,
    });
    expect(await auditoriaDe(a.competencia.id)).toEqual(r.eliminados);
    expect(await contenidoDe(a.competencia.id)).toEqual(VACIA);
  });

  it("cancelaciones REALES en curso (sin confirmar) se esperan y se cuenta su estado final (individual y relevo)", async () => {
    const a = await montarCompetencia("Copa A sintética");
    const otroAdmin = await createUser({ username: "admin_cancela", roleNames: ["admin"] });
    const actorCancela = { userId: otroAdmin.id, isAdmin: true, scope: { kind: "admin" as const }, canRegisterPostClose: true };
    // La persona 2 no integra el relevo confirmado: su individual se puede cancelar.
    const individual = await prisma.registration.findFirstOrThrow({ where: { personId: E.personas[2]!, competitionEvent: { competitionId: a.competencia.id } } });
    const relevo = await prisma.relayRegistration.findFirstOrThrow({ where: { competitionEvent: { competitionId: a.competencia.id }, status: "confirmed" } });

    // Las dos cancelaciones reales escriben su fila y quedan detenidas al auditar, SIN confirmar.
    const retencion = retenerCuenta(otroAdmin.id);
    await retencion.tomada;
    const cancelInd = observar(registrationsService.cancelRegistration(individual.id, actorCancela));
    const cancelRel = observar(relayService.cancelRelayRegistration(relevo.id, actorCancela));
    await esperarHasta(async () => (await esperandoBloqueo("%audit_logs%")) === 2 || cancelInd.listo || cancelRel.listo, "las dos cancelaciones esperan al auditar");
    expect(cancelInd.error).toBeUndefined();
    expect(cancelRel.error).toBeUndefined();
    expect([cancelInd.listo, cancelRel.listo]).toEqual([false, false]);

    const eliminacion = observar(eliminarCompetenciaCompleta(a.competencia.id, { userId: E.adminId }));
    // La eliminación tiene que esperar esas filas, al bloquearlas o al borrarlas.
    await esperarHasta(async () => (await esperandoBloqueo("%registrations%")) >= 1, "la eliminación espera las filas en cancelación");
    expect(eliminacion.listo).toBe(false);

    retencion.soltar();
    await retencion.fin;
    await esperarHasta(async () => eliminacion.listo && cancelInd.listo && cancelRel.listo, "todo concluye");
    expect(eliminacion.error).toBeUndefined();
    expect(cancelInd.error).toBeUndefined();
    expect(cancelRel.error).toBeUndefined();

    expect(eliminacion.valor!.eliminados).toMatchObject({
      inscripcionesIndividuales: 6,
      inscripcionesIndividualesConfirmadas: 3,
      inscripcionesIndividualesCanceladas: 3,
      equiposDeRelevo: 2,
      equiposDeRelevoConfirmados: 0,
      equiposDeRelevoCancelados: 2,
      integrantesDeRelevo: 8,
    });
    expect(await auditoriaDe(a.competencia.id)).toEqual(eliminacion.valor!.eliminados);
    expect(await contenidoDe(a.competencia.id)).toEqual(VACIA);
  });
});

describe("orden de bloqueos frente al alta real que llena el cupo", () => {
  it("la eliminación espera al alta detenida tras insertar; el alta cierra la competencia y nadie se interbloquea", async () => {
    const a = await montarCompetencia("Copa Cupo sintética");
    // Ya hay 6 nadadores distintos activos (individuales y relevo confirmados): el séptimo llena el cupo.
    await prisma.competition.update({ where: { id: a.competencia.id }, data: { maxSwimmers: 7 } });
    const otroAdmin = await createUser({ username: "admin_alta", roleNames: ["admin"] });
    const actorAlta = { userId: otroAdmin.id, isAdmin: true, scope: { kind: "admin" as const }, canRegisterPostClose: true };

    // 1. El alta inserta su inscripción (FOR KEY SHARE sobre la prueba) y queda detenida al auditar,
    //    ANTES de actualizar la competencia por el cupo.
    const retencion = retenerCuenta(otroAdmin.id);
    await retencion.tomada;
    const alta = observar(registrationsService.createRegistration({ competitionEventId: a.ceInd.id, personId: E.personas[4]!, clubId: E.clubId }, actorAlta));
    await esperarHasta(async () => (await esperandoBloqueo("%audit_logs%")) === 1 || alta.listo, "el alta espera al auditar");
    expect(alta.error).toBeUndefined();
    expect(alta.listo).toBe(false);

    // 2. La eliminación empieza y queda esperando la prueba retenida por el alta.
    const eliminacion = observar(eliminarCompetenciaCompleta(a.competencia.id, { userId: E.adminId }));
    await esperarHasta(async () => (await esperandoBloqueo("%competition_events%FOR UPDATE%")) === 1 || eliminacion.listo, "la eliminación espera la prueba");
    expect(eliminacion.listo).toBe(false);

    // 3. Se suelta el alta: audita, ACTUALIZA LA COMPETENCIA (cierre por cupo) y confirma. Si la
    //    eliminación retuviera ya la competencia, aquí habría un interbloqueo.
    retencion.soltar();
    await retencion.fin;
    await esperarHasta(async () => alta.listo && eliminacion.listo, "alta y eliminación concluyen");
    expect(alta.error).toBeUndefined();
    expect(eliminacion.error).toBeUndefined();

    // El alta cerró la competencia por cupo antes de que se eliminara (lo deja auditado).
    const cierres = await prisma.auditLog.findMany({ where: { entityId: a.competencia.id, NOT: { action: "COMPETITION_DELETED" } }, select: { action: true } });
    expect(cierres.map((c) => c.action)).toContain("COMPETITION_REGISTRATIONS_AUTO_CLOSED_BY_CAPACITY");
    // La inscripción del alta se eliminó y se contó.
    expect(eliminacion.valor!.eliminados).toMatchObject({ inscripcionesIndividuales: 7, inscripcionesIndividualesConfirmadas: 5 });
    expect(await contenidoDe(a.competencia.id)).toEqual(VACIA);
  });
});
