/**
 * Hallazgo 20 — identidad de las cuentas y unicidad global del nombre de
 * usuario, verificado contra PostgreSQL.
 *
 * Tres defectos, todos reproducidos aquí antes de comprobar la corrección:
 *
 *  1. `users.owner_type` podía contradecir a `person_id` / `club_id`, y el
 *     administrador se guardaba como `person` sin persona: un estado inválido
 *     que era imposible prohibir mientras fuera el que usaba el propio seed.
 *  2. `users.username` era único TOTAL, mientras que `persons.username` y
 *     `clubs.username` pasaron a unicidad PARCIAL. Al eliminar lógicamente a
 *     una persona su nombre quedaba libre y se podía volver a registrar, pero
 *     pedir credenciales para la nueva fallaba para siempre: el nombre seguía
 *     ocupado por la cuenta de la eliminada, y no hay forma de renombrar.
 *  3. Una persona y un club podían tomar el MISMO nombre de usuario. El choque
 *     aparecía recién al pedir credenciales para el segundo, con el mismo
 *     callejón sin salida.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser } from "./helpers/seedRbac";
import * as personsService from "../src/modules/persons/persons.service";
import * as clubsService from "../src/modules/clubs/clubs.service";
import * as assignmentService from "../src/modules/swimmer-assignment/assignment.service";

/**
 * Da a una persona el rol que le permite tener credenciales.
 *
 * Los `person_roles` son DERIVADOS: no se marcan a mano, aparecen con la
 * relación que los justifica. Para que alguien pueda acceder al sistema hay que
 * incorporarlo al plantel de un club, y eso es lo que hace esto.
 *
 * Antes estas pruebas pasaban `roles: ["swimmer"]` al crear la persona, que era
 * exactamente la puerta trasera que el hallazgo 32 cerró.
 */
async function conMembresiaEnUnClub(personId: string, sufijo: string): Promise<void> {
  const club = await clubsService.createClub({ ...CLUB_BASE, name: `Club ${sufijo}`, code: sufijo.slice(0, 3).toUpperCase(), username: `club.${sufijo}`, email: `${sufijo}@test.local` }, ADMIN);
  await assignmentService.assignSwimmerDirectly({ clubId: club.id, personId }, ADMIN);
}

let ADMIN: { userId: string };

const PERSONA_BASE = {
  firstName: "Ana",
  paternalLastName: "Pérez",
  birthDate: new Date("1990-01-01"),
  gender: "female" as const,
};

const CLUB_BASE = {
  name: "Club Delfines",
  code: "CDE",
  hasLegalStatus: false,
  email: "cde@test.local",
  isAchmnMember: false,
  isAchmnCollaborator: false,
  isFchmnMember: false,
  isFchmnCollaborator: false,
};

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_identidad", roleNames: ["admin"] });
  ADMIN = { userId: admin.id };
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("coherencia entre el tipo de dueño y sus columnas", () => {
  it("la cuenta del administrador es de tipo `system`, no `person` sin persona", async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: ADMIN.userId } });
    expect(admin.ownerType).toBe("system");
    expect(admin.personId).toBeNull();
    expect(admin.clubId).toBeNull();
  });

  it("la base RECHAZA una cuenta con persona Y club a la vez", async () => {
    const persona = await personsService.createPerson({ ...PERSONA_BASE, run: "11111111-1", username: "ana.perez" }, ADMIN);
    const club = await clubsService.createClub({ ...CLUB_BASE, username: "club.delfines" }, ADMIN);

    await expect(
      prisma.user.create({
        data: {
          // El nombre coincide con el de su titular a propósito: así lo que
          // rechaza la inserción es la restricción de coherencia del dueño y
          // no el disparador que exige esa igualdad (probado aparte).
          username: persona.username,
          passwordHash: "x",
          ownerType: "person",
          personId: persona.id,
          clubId: club.id,
        },
      })
    ).rejects.toThrow(/users_owner_coherente/i);
  });

  it("la base RECHAZA una cuenta que declara persona pero no la tiene", async () => {
    await expect(
      prisma.user.create({ data: { username: "cuenta.huerfana", passwordHash: "x", ownerType: "person" } })
    ).rejects.toThrow(/users_owner_coherente/i);
  });

  it("la base RECHAZA una cuenta `system` con dueño", async () => {
    const persona = await personsService.createPerson({ ...PERSONA_BASE, run: "11111111-1", username: "ana.perez" }, ADMIN);

    await expect(
      prisma.user.create({ data: { username: persona.username, passwordHash: "x", ownerType: "system", personId: persona.id } })
    ).rejects.toThrow(/users_owner_coherente/i);
  });
});

describe("unicidad global del nombre de usuario", () => {
  it("un club NO puede tomar el nombre de usuario de una persona", async () => {
    await personsService.createPerson({ ...PERSONA_BASE, run: "11111111-1", username: "delfines" }, ADMIN);

    await expect(clubsService.createClub({ ...CLUB_BASE, username: "delfines" }, ADMIN)).rejects.toThrow(/ya está en uso por una persona/i);
  });

  it("una persona NO puede tomar el nombre de usuario de un club", async () => {
    await clubsService.createClub({ ...CLUB_BASE, username: "delfines" }, ADMIN);

    await expect(personsService.createPerson({ ...PERSONA_BASE, run: "11111111-1", username: "delfines" }, ADMIN)).rejects.toThrow(
      /ya está en uso por un club/i
    );
  });

  it("la BASE lo impide aunque se salte la comprobación de la aplicación", async () => {
    // Sin la reserva global esto pasaba: son tablas distintas y PostgreSQL no
    // tiene índices únicos entre tablas, así que la única defensa era la
    // comprobación de la aplicación — inútil ante una escritura directa o una
    // carrera entre dos altas simultáneas.
    await personsService.createPerson({ ...PERSONA_BASE, run: "11111111-1", username: "delfines" }, ADMIN);

    const error = await prisma.club
      .create({ data: { name: "Club Colado", username: "delfines", code: "CCO", email: "cco@test.local", status: "active" } })
      .then(() => null)
      .catch((e) => e as { code?: string });

    /**
     * El disparador lanza con SQLSTATE `unique_violation`, así que llega como
     * P2002 y el manejador global lo traduce a 409 — nunca a un error interno.
     * El texto explicativo del disparador NO sobrevive: Prisma reemplaza el
     * mensaje de una violación de unicidad por el suyo y, al no venir de un
     * índice que conozca, deja el genérico. El mensaje que ve el usuario en el
     * camino normal es el de `assertUsernameAvailable`, verificado arriba;
     * esto es el respaldo de la base para cuando ese camino no se recorre.
     */
    expect(error?.code, "debe ser una violación de unicidad, no un error interno").toBe("P2002");

    expect(await prisma.club.count({ where: { username: "delfines" } }), "el club no se creó").toBe(0);
  });

  it("una persona y SU cuenta comparten titular: no chocan entre sí", async () => {
    const persona = await personsService.createPerson({ ...PERSONA_BASE, run: "11111111-1", username: "ana.perez" }, ADMIN);
    await conMembresiaEnUnClub(persona.id, "ana");

    const credenciales = await personsService.createCredentials(persona.id, ADMIN);

    expect(credenciales.username).toBe("ana.perez");
    const reservas = await prisma.usernameReservation.findMany({ where: { username: "ana.perez" } });
    expect(reservas, "un solo nombre reservado, un solo titular").toHaveLength(1);
    expect(reservas[0]!.ownerKind).toBe("person");
    expect(reservas[0]!.ownerId).toBe(persona.id);
  });
});

describe("liberación del nombre al eliminar lógicamente", () => {
  it("eliminar una persona CON credenciales libera su nombre para una persona nueva", async () => {
    const primera = await personsService.createPerson(
      { ...PERSONA_BASE, run: "11111111-1", username: "reutilizable" },
      ADMIN
    );
    await conMembresiaEnUnClub(primera.id, "primera");
    await personsService.createCredentials(primera.id, ADMIN);

    await personsService.softDeletePerson(primera.id, ADMIN);

    expect(await prisma.usernameReservation.count({ where: { username: "reutilizable" } }), "la reserva debe liberarse").toBe(0);

    // El defecto: esto funcionaba...
    const segunda = await personsService.createPerson(
      { ...PERSONA_BASE, run: "12345678-5", username: "reutilizable" },
      ADMIN
    );
    await conMembresiaEnUnClub(segunda.id, "segunda");
    // ...y esto fallaba para siempre, porque `users.username` era único TOTAL
    // y la cuenta de la persona eliminada seguía reteniendo el nombre.
    const credenciales = await personsService.createCredentials(segunda.id, ADMIN);
    expect(credenciales.username).toBe("reutilizable");

    // Quedan las dos cuentas: la eliminada conserva su historial.
    expect(await prisma.user.count({ where: { username: "reutilizable" } })).toBe(2);
    expect(await prisma.user.count({ where: { username: "reutilizable", deletedAt: null } })).toBe(1);
  });

  it("mientras la persona siga vigente, su nombre NO se libera", async () => {
    const persona = await personsService.createPerson({ ...PERSONA_BASE, run: "11111111-1", username: "ocupado" }, ADMIN);

    expect(await prisma.usernameReservation.count({ where: { username: "ocupado" } })).toBe(1);
    expect(await prisma.usernameReservation.findFirst({ where: { username: "ocupado" } })).toMatchObject({
      ownerKind: "person",
      ownerId: persona.id,
    });
  });

  it("eliminar un club libera su nombre y el de su cuenta", async () => {
    const club = await clubsService.createClub({ ...CLUB_BASE, username: "club.libre" }, ADMIN);
    await clubsService.createClubCredentials(club.id, ADMIN);

    await clubsService.softDeleteClub(club.id, ADMIN);

    expect(await prisma.usernameReservation.count({ where: { username: "club.libre" } })).toBe(0);
    await expect(clubsService.createClub({ ...CLUB_BASE, name: "Club Nuevo", code: "CNU", username: "club.libre" }, ADMIN)).resolves.toBeTruthy();
  });
});
