/**
 * Fase 4, hallazgo 18 — atomicidad de los flujos compuestos.
 *
 * El defecto: varios flujos escribían en más de una tabla mediante llamadas
 * sucesivas al cliente Prisma GLOBAL. No compartían transacción, así que un
 * fallo entre dos escrituras dejaba la mitad del cambio confirmada:
 *
 *   - `createClub`: el club quedaba creado sin su plantilla de delegados y
 *     entrenadores, o con personal en `ClubStaff` pero sin el `PersonRole`
 *     derivado que les da acceso.
 *   - `assignSwimmerDirectly` / `approveAssignment` / `endAssignment`: la
 *     membresía quedaba escrita y el rol "swimmer" sin sincronizar — un
 *     nadador dado de baja conservando el rol (y por lo tanto inscribible),
 *     o uno recién incorporado sin el rol que necesita.
 *
 * Estas pruebas provocan el fallo EN MEDIO del flujo y comprueban que no
 * queda nada escrito. Contra el código anterior fallan: la fila principal
 * seguía ahí.
 *
 * El fallo se inyecta con un middleware de Prisma en vez de `vi.spyOn`
 * sobre los delegados: los delegados son Proxies y espiarlos deja el cliente
 * roto para el resto del archivo (ver la nota extensa en
 * `import-export-services.integration.test.ts`). El middleware también
 * alcanza a las consultas hechas con el cliente transaccional, que es
 * justamente donde hay que interrumpir.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import type { ActorContext } from "../src/shared/actorContext";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser } from "./helpers/seedRbac";
import * as clubsService from "../src/modules/clubs/clubs.service";
import * as assignmentService from "../src/modules/swimmer-assignment/assignment.service";

/** Punto de fallo activo, o `null` para dejar pasar todo. */
const inyector: { model: string | null; action: string | null } = { model: null, action: null };

class FalloInyectado extends Error {
  constructor(model: string, action: string) {
    super(`fallo inyectado en ${model}.${action}`);
  }
}

prisma.$use(async (params, next) => {
  if (inyector.model && params.model === inyector.model && params.action === inyector.action) {
    throw new FalloInyectado(inyector.model, inyector.action!);
  }
  return next(params);
});

/** Interrumpe el flujo en la primera llamada a `model.action`. */
async function conFalloEn<T>(model: string, action: string, fn: () => Promise<T>): Promise<unknown> {
  inyector.model = model;
  inyector.action = action;
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  } finally {
    inyector.model = null;
    inyector.action = null;
  }
}

let ADMIN: { userId: string };

/**
 * Contexto de actor COMPLETO, para las operaciones que evalúan alcance
 * (`proposeAssignment`, `endAssignment`).
 *
 * Antes estas llamadas pasaban `ADMIN`, que encajaba
 * porque el servicio tenía un `ActorContext` local con campos opcionales. Ese
 * contrato paralelo fue el origen de un defecto real —dos rutas pasaban un
 * contexto sin `actorClubId` y ningún club podía proponer ni finalizar—, así que
 * se eliminó. Ahora hay un solo tipo, y construirlo obliga a declarar el alcance
 * de verdad.
 */
function actorAdmin(): ActorContext {
  return { userId: ADMIN.userId, isAdmin: true, scope: { kind: "admin" }, canRegisterPostClose: true };
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_tx", roleNames: ["admin"] });
  ADMIN = { userId: admin.id };
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("createClub — club, plantilla y roles derivados en una sola transacción", () => {
  const datosDeClub = (delegatePersonIds: string[]) => ({
    name: "Club Transaccional",
    username: "club_tx",
    code: "CTX",
    hasLegalStatus: false,
    email: "ctx@test.local",
    delegatePersonIds,
    coachPersonIds: [],
    isAchmnMember: false,
    isAchmnCollaborator: false,
    isFchmnMember: false,
    isFchmnCollaborator: false,
  });

  it("si falla al agregar la plantilla, el club NO queda creado", async () => {
    const delegado = await createPerson({ run: "11111111-1", username: "deleg_tx", firstName: "Delia", gender: "female", roles: ["delegate"] });

    const error = await conFalloEn("ClubStaff", "createMany", () => clubsService.createClub(datosDeClub([delegado.id]), ADMIN));

    expect(error).toBeInstanceOf(FalloInyectado);
    expect(await prisma.club.count(), "el club debe revertirse junto con su plantilla").toBe(0);
    expect(await prisma.clubStaff.count()).toBe(0);
  });

  it("si falla al sincronizar el rol funcional, no queda ni el club ni la plantilla", async () => {
    // Persona sin el rol `delegate` todavía: al agregarla como delegada, el
    // servicio crea su `PersonRole`. Ese es el punto de fallo.
    const persona = await createPerson({ run: "22222222-2", username: "sinrol_tx", firstName: "Nadia", gender: "female", roles: ["swimmer"] });

    const error = await conFalloEn("PersonRole", "create", () => clubsService.createClub(datosDeClub([persona.id]), ADMIN));

    expect(error).toBeInstanceOf(FalloInyectado);
    expect(await prisma.club.count()).toBe(0);
    expect(await prisma.clubStaff.count(), "la plantilla ya escrita debe revertirse").toBe(0);
    expect(await prisma.personRole.count({ where: { personId: persona.id, roleType: "delegate" } })).toBe(0);
  });

  it("updateClub: si falla al reemplazar la plantilla, no cambia NI la ficha NI el personal", async () => {
    const original = await createPerson({ run: "77777777-7", username: "orig_tx", firstName: "Olga", gender: "female", roles: ["swimmer"] });
    const club = await clubsService.createClub(datosDeClub([original.id]), ADMIN);

    const reemplazo = await createPerson({ run: "88888888-8", username: "reemp_tx", firstName: "Rita", gender: "female", roles: ["swimmer"] });

    const error = await conFalloEn("ClubStaff", "createMany", () =>
      clubsService.updateClub(club.id, { name: "Nombre Cambiado", hasLegalStatus: false, delegatePersonIds: [reemplazo.id] }, ADMIN)
    );

    expect(error).toBeInstanceOf(FalloInyectado);

    // La ficha se actualiza ANTES de tocar la plantilla: sin transacción, el
    // nombre nuevo quedaba guardado aunque el personal no llegara a cambiar.
    const despues = await prisma.club.findUniqueOrThrow({ where: { id: club.id } });
    expect(despues.name, "el cambio de nombre debe revertirse con el resto").toBe("Club Transaccional");

    const plantilla = await prisma.clubStaff.findMany({ where: { clubId: club.id, roleType: "delegate" } });
    expect(plantilla).toHaveLength(1);
    expect(plantilla[0]!.personId).toBe(original.id);

    const rolOriginal = await prisma.personRole.findUnique({
      where: { personId_roleType: { personId: original.id, roleType: "delegate" } },
    });
    expect(rolOriginal?.active, "la persona saliente conserva su rol si el reemplazo no se completó").toBe(true);
  });

  it("en el camino feliz el club queda con su plantilla y el rol derivado activo", async () => {
    const persona = await createPerson({ run: "33333333-3", username: "ok_tx", firstName: "Rosa", gender: "female", roles: ["swimmer"] });

    const club = await clubsService.createClub(datosDeClub([persona.id]), ADMIN);

    expect(club.id).toBeTruthy();
    expect(await prisma.clubStaff.count({ where: { clubId: club.id, roleType: "delegate" } })).toBe(1);
    const rol = await prisma.personRole.findUnique({ where: { personId_roleType: { personId: persona.id, roleType: "delegate" } } });
    expect(rol?.active).toBe(true);
  });
});

describe("membresías de nadador — la membresía y el rol derivado son atómicos", () => {
  it("assignSwimmerDirectly: si falla al crear el rol, la membresía NO queda escrita", async () => {
    const club = await createClub("Club Uno", "CU1");
    // Sin ningún rol previo: la asignación es la que crea el `PersonRole`.
    const persona = await prisma.person.create({
      data: {
        run: "44444444-4",
        username: "nadad_tx",
        firstName: "Nico",
        paternalLastName: "Prueba",
        fullName: "Nico Prueba",
        birthDate: new Date("1995-05-05"),
        gender: "male",
        status: "active",
      },
    });

    const error = await conFalloEn("PersonRole", "create", () =>
      assignmentService.assignSwimmerDirectly({ clubId: club.id, personId: persona.id }, ADMIN)
    );

    expect(error).toBeInstanceOf(FalloInyectado);
    expect(await prisma.clubSwimmer.count(), "la membresía debe revertirse con el rol").toBe(0);
    expect(await prisma.personRole.count({ where: { personId: persona.id } })).toBe(0);
  });

  it("endAssignment: si falla al desactivar el rol, la membresía sigue activa", async () => {
    const club = await createClub("Club Dos", "CU2");
    const persona = await createPerson({ run: "55555555-5", username: "baja_tx", firstName: "Ana", gender: "female", roles: ["swimmer"] });
    const membresia = await assignmentService.assignSwimmerDirectly(
      { clubId: club.id, personId: persona.id },
      ADMIN
    );

    const error = await conFalloEn("PersonRole", "update", () => assignmentService.endAssignment(membresia.id, actorAdmin()));

    expect(error).toBeInstanceOf(FalloInyectado);

    // Lo que el defecto producía: membresía "ended" con el rol de nadador
    // todavía activo, es decir, alguien fuera del club pero inscribible.
    const despues = await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: membresia.id } });
    expect(despues.status, "la baja debe revertirse si el rol no pudo desactivarse").toBe("active");
    expect(despues.endDate).toBeNull();

    const rol = await prisma.personRole.findUnique({ where: { personId_roleType: { personId: persona.id, roleType: "swimmer" } } });
    expect(rol?.active).toBe(true);
  });

  it("reassignSwimmerToClub: si falla al crear la nueva membresía, la anterior NO queda finalizada", async () => {
    const clubOrigen = await createClub("Club Origen", "COR");
    const clubDestino = await createClub("Club Destino", "CDE");
    const persona = await createPerson({ run: "99999999-9", username: "tras_tx", firstName: "Tere", gender: "female", roles: ["swimmer"] });
    const membresia = await assignmentService.assignSwimmerDirectly(
      { clubId: clubOrigen.id, personId: persona.id },
      ADMIN
    );

    // El traspaso finaliza la membresía anterior y crea la nueva: el fallo se
    // inyecta en la creación, con la baja ya escrita.
    const error = await conFalloEn("ClubSwimmer", "create", () =>
      assignmentService.reassignSwimmerToClub(persona.id, clubDestino.id, ADMIN)
    );

    expect(error).toBeInstanceOf(FalloInyectado);

    const anterior = await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: membresia.id } });
    expect(anterior.status, "sin la nueva membresía, el nadador no puede quedar sin club").toBe("active");
    expect(anterior.endDate).toBeNull();
    expect(await prisma.clubSwimmer.count({ where: { clubId: clubDestino.id } })).toBe(0);
  });

  it("approveAssignment: si falla al crear el rol, la solicitud sigue pendiente", async () => {
    const club = await createClub("Club Aprueba", "CAP");
    // Sin rol previo: aprobar la solicitud es lo que crea el `PersonRole`.
    const persona = await prisma.person.create({
      data: {
        run: "12121212-1",
        username: "aprob_tx",
        firstName: "Pía",
        paternalLastName: "Prueba",
        fullName: "Pía Prueba",
        birthDate: new Date("1992-03-03"),
        gender: "female",
        status: "active",
      },
    });
    const solicitud = await assignmentService.proposeAssignment({ clubId: club.id, personId: persona.id }, actorAdmin());

    const error = await conFalloEn("PersonRole", "create", () => assignmentService.approveAssignment(solicitud.id, ADMIN));

    expect(error).toBeInstanceOf(FalloInyectado);

    const despues = await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: solicitud.id } });
    expect(despues.status, "una aprobación a medias debe poder reintentarse desde el mismo estado").toBe("pending");
    expect(despues.reviewedAt).toBeNull();
    expect(await prisma.personRole.count({ where: { personId: persona.id, roleType: "swimmer" } })).toBe(0);
  });

  it("endAssignment en el camino feliz desactiva la membresía y el rol juntos", async () => {
    const club = await createClub("Club Tres", "CU3");
    const persona = await createPerson({ run: "66666666-6", username: "ok2_tx", firstName: "Bea", gender: "female", roles: ["swimmer"] });
    const membresia = await assignmentService.assignSwimmerDirectly(
      { clubId: club.id, personId: persona.id },
      ADMIN
    );

    await assignmentService.endAssignment(membresia.id, actorAdmin());

    const despues = await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: membresia.id } });
    expect(despues.status).toBe("ended");
    const rol = await prisma.personRole.findUnique({ where: { personId_roleType: { personId: persona.id, roleType: "swimmer" } } });
    expect(rol?.active).toBe(false);
  });
});
