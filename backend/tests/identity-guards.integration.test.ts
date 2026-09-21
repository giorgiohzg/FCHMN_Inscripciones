/**
 * Garantías de identidad en la BASE de datos (`phase4_identity_guards`).
 *
 * Dos huecos que quedaban abiertos:
 *
 *  1. `username_reservations` guarda el TITULAR de cada nombre. Los
 *     disparadores del registro escuchan `username` y `deleted_at`, pero no
 *     `owner_type`, `person_id` ni `club_id`: cambiar el dueño de una cuenta
 *     dejaba la reserva apuntando al titular anterior y nadie se enteraba.
 *     La decisión es que esas tres columnas son INMUTABLES, y ahora la base
 *     lo exige.
 *
 *  2. "Un solo representante legal por club" y "una persona pertenece a un
 *     solo club" vivían únicamente en `clubs.service`. Una escritura directa
 *     las saltaba, y dos solicitudes simultáneas también: ambas comprobaban
 *     antes de que ninguna escribiera.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser } from "./helpers/seedRbac";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PERSONA_BASE = {
  paternalLastName: "Prueba",
  birthDate: new Date("1990-01-01"),
  gender: "female" as const,
  status: "active" as const,
};

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("el dueño de una cuenta de acceso es inmutable", () => {
  it("RECHAZA traspasar la cuenta a otra persona", async () => {
    const ana = await createPerson({ run: "10000001", username: "ana", firstName: "Ana", gender: "female" });
    const beto = await createPerson({ run: "10000002", username: "beto", firstName: "Beto", gender: "male" });
    const cuenta = await createUser({ username: "ana", roleNames: [], personId: ana.id });

    await expect(prisma.user.update({ where: { id: cuenta.id }, data: { personId: beto.id } })).rejects.toThrow(
      /dueño de una cuenta de acceso no se puede cambiar/i
    );
  });

  it("RECHAZA convertir la cuenta de una persona en la de un club", async () => {
    const ana = await createPerson({ run: "10000003", username: "ana", firstName: "Ana", gender: "female" });
    const club = await createClub("Club Norte", "CN");
    const cuenta = await createUser({ username: "ana", roleNames: [], personId: ana.id });

    await expect(
      prisma.user.update({ where: { id: cuenta.id }, data: { ownerType: "club", personId: null, clubId: club.id } })
    ).rejects.toThrow(/dueño de una cuenta de acceso no se puede cambiar/i);
  });

  it("RECHAZA convertir una cuenta de persona en cuenta del sistema", async () => {
    const ana = await createPerson({ run: "10000004", username: "ana", firstName: "Ana", gender: "female" });
    const cuenta = await createUser({ username: "ana", roleNames: [], personId: ana.id });

    await expect(
      prisma.user.update({ where: { id: cuenta.id }, data: { ownerType: "system", personId: null } })
    ).rejects.toThrow(/dueño de una cuenta de acceso no se puede cambiar/i);
  });

  it("la reserva del nombre sigue apuntando al titular correcto tras un intento fallido", async () => {
    const ana = await createPerson({ run: "10000005", username: "ana", firstName: "Ana", gender: "female" });
    const beto = await createPerson({ run: "10000006", username: "beto", firstName: "Beto", gender: "male" });
    const cuenta = await createUser({ username: "ana", roleNames: [], personId: ana.id });

    await prisma.user.update({ where: { id: cuenta.id }, data: { personId: beto.id } }).catch(() => null);

    const reserva = await prisma.usernameReservation.findUniqueOrThrow({ where: { username: "ana" } });
    expect(reserva.ownerKind).toBe("person");
    expect(reserva.ownerId, "el traspaso habría dejado la reserva a nombre del titular anterior").toBe(ana.id);
  });

  it("los cambios que NO son de dueño siguen permitidos", async () => {
    const ana = await createPerson({ run: "10000007", username: "ana", firstName: "Ana", gender: "female" });
    const cuenta = await createUser({ username: "ana", roleNames: [], personId: ana.id });

    const actualizada = await prisma.user.update({ where: { id: cuenta.id }, data: { status: "locked", failedLoginAttempts: 3 } });
    expect(actualizada.status).toBe("locked");
  });
});

describe("un solo representante legal por club", () => {
  it("la BASE rechaza un segundo representante legal en el mismo club", async () => {
    const club = await createClub("Club Norte", "CN");
    const uno = await createPerson({ run: "20000001", username: "rep_uno", firstName: "Rita", gender: "female" });
    const dos = await createPerson({ run: "20000002", username: "rep_dos", firstName: "Rosa", gender: "female" });

    await prisma.clubStaff.create({ data: { clubId: club.id, personId: uno.id, roleType: "legal_representative" } });

    await expect(
      prisma.clubStaff.create({ data: { clubId: club.id, personId: dos.id, roleType: "legal_representative" } })
    ).rejects.toThrow();

    expect(await prisma.clubStaff.count({ where: { clubId: club.id, roleType: "legal_representative" } })).toBe(1);
  });

  it("varios delegados y varios entrenadores SÍ se admiten", async () => {
    const club = await createClub("Club Norte", "CN");
    const uno = await createPerson({ run: "20000003", username: "del_uno", firstName: "Dora", gender: "female" });
    const dos = await createPerson({ run: "20000004", username: "del_dos", firstName: "Delia", gender: "female" });

    await prisma.clubStaff.create({ data: { clubId: club.id, personId: uno.id, roleType: "delegate" } });
    await prisma.clubStaff.create({ data: { clubId: club.id, personId: dos.id, roleType: "delegate" } });
    await prisma.clubStaff.create({ data: { clubId: club.id, personId: uno.id, roleType: "coach" } });

    expect(await prisma.clubStaff.count({ where: { clubId: club.id } })).toBe(3);
  });

  it("dos clubes pueden tener cada uno SU representante legal", async () => {
    const norte = await createClub("Club Norte", "CN");
    const sur = await createClub("Club Sur", "CS");
    const uno = await createPerson({ run: "20000005", username: "rep_n", firstName: "Rita", gender: "female" });
    const dos = await createPerson({ run: "20000006", username: "rep_s", firstName: "Rosa", gender: "female" });

    await prisma.clubStaff.create({ data: { clubId: norte.id, personId: uno.id, roleType: "legal_representative" } });
    await prisma.clubStaff.create({ data: { clubId: sur.id, personId: dos.id, roleType: "legal_representative" } });

    expect(await prisma.clubStaff.count({ where: { roleType: "legal_representative" } })).toBe(2);
  });
});

describe("una persona pertenece a un solo club, garantizado por la base", () => {
  it("RECHAZA una escritura directa que la haga personal de dos clubes", async () => {
    const norte = await createClub("Club Norte", "CN");
    const sur = await createClub("Club Sur", "CS");
    const persona = await createPerson({ run: "30000001", username: "multi", firstName: "Mía", gender: "female" });

    await prisma.clubStaff.create({ data: { clubId: norte.id, personId: persona.id, roleType: "delegate" } });

    await expect(
      prisma.clubStaff.create({ data: { clubId: sur.id, personId: persona.id, roleType: "coach" } })
    ).rejects.toThrow(/un club a la vez/i);
  });

  it("admite varios cargos de la misma persona en SU club", async () => {
    const club = await createClub("Club Norte", "CN");
    const persona = await createPerson({ run: "30000002", username: "doble_cargo", firstName: "Dora", gender: "female" });

    await prisma.clubStaff.create({ data: { clubId: club.id, personId: persona.id, roleType: "delegate" } });
    await prisma.clubStaff.create({ data: { clubId: club.id, personId: persona.id, roleType: "coach" } });

    expect(await prisma.clubStaff.count({ where: { personId: persona.id } })).toBe(2);
  });

  /**
   * La comprobación de la aplicación no basta para esto: dos solicitudes
   * simultáneas leen ambas "esta persona no es personal de ningún club" antes
   * de que ninguna haya escrito, y las dos siguen adelante. El disparador
   * bloquea la fila de la persona (`FOR UPDATE`), así que la segunda espera a
   * que la primera confirme y recién entonces comprueba — sobre el estado
   * real, no sobre el anterior.
   */
  it("dos asignaciones SIMULTÁNEAS en clubes distintos: solo una prospera", async () => {
    const norte = await createClub("Club Norte", "CN");
    const sur = await createClub("Club Sur", "CS");
    const persona = await createPerson({ run: "30000003", username: "carrera", firstName: "Carla", gender: "female" });

    const resultados = await Promise.allSettled([
      prisma.$transaction((tx) => tx.clubStaff.create({ data: { clubId: norte.id, personId: persona.id, roleType: "delegate" } })),
      prisma.$transaction((tx) => tx.clubStaff.create({ data: { clubId: sur.id, personId: persona.id, roleType: "coach" } })),
    ]);

    const exitosas = resultados.filter((r) => r.status === "fulfilled");
    expect(exitosas, "exactamente una debe prosperar").toHaveLength(1);

    const filas = await prisma.clubStaff.findMany({ where: { personId: persona.id } });
    expect(filas).toHaveLength(1);
    expect([norte.id, sur.id]).toContain(filas[0]!.clubId);
  });

  it("dos representantes legales SIMULTÁNEOS en el mismo club: solo uno prospera", async () => {
    const club = await createClub("Club Norte", "CN");
    const uno = await createPerson({ run: "30000004", username: "rep_a", firstName: "Rita", gender: "female" });
    const dos = await createPerson({ run: "30000005", username: "rep_b", firstName: "Rosa", gender: "female" });

    const resultados = await Promise.allSettled([
      prisma.$transaction((tx) => tx.clubStaff.create({ data: { clubId: club.id, personId: uno.id, roleType: "legal_representative" } })),
      prisma.$transaction((tx) => tx.clubStaff.create({ data: { clubId: club.id, personId: dos.id, roleType: "legal_representative" } })),
    ]);

    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.clubStaff.count({ where: { clubId: club.id, roleType: "legal_representative" } })).toBe(1);
  });
});

describe("la reserva de nombre sigue coherente con el ciclo normal", () => {
  it("crear persona, darle credenciales y eliminarla libera el nombre una sola vez", async () => {
    const persona = await prisma.person.create({
      data: { ...PERSONA_BASE, run: "40000001", username: "ciclo", firstName: "Ciro", fullName: "Ciro Prueba" },
    });
    await prisma.user.create({ data: { username: "ciclo", passwordHash: "x", ownerType: "person", personId: persona.id } });

    expect(await prisma.usernameReservation.count({ where: { username: "ciclo" } })).toBe(1);

    await prisma.$transaction(async (tx) => {
      await tx.person.update({ where: { id: persona.id }, data: { deletedAt: new Date() } });
      await tx.user.updateMany({ where: { personId: persona.id }, data: { deletedAt: new Date() } });
    });

    expect(await prisma.usernameReservation.count({ where: { username: "ciclo" } })).toBe(0);
  });
});

/**
 * La reversión de `phase4_user_identity` es CONDICIONAL, y su condición no es
 * teórica: la incumple cualquier instalación que haya usado la función que la
 * migración vino a habilitar —reutilizar el nombre de usuario de una cuenta
 * eliminada—. Esta prueba construye exactamente ese estado y comprueba que la
 * reversión se detiene con un mensaje accionable en vez de fallar con un error
 * de índice duplicado.
 */
describe("reversión condicional del registro de nombres", () => {
  /**
   * El bloque de verificación del paso 4, extraído LITERALMENTE del plan de
   * reversión: se prueba el archivo que se entrega, no una copia. Se ejecuta
   * solo ese bloque porque `$executeRawUnsafe` admite una sentencia por
   * llamada, y es exactamente la parte condicional.
   */
  const ROLLBACK = readFileSync(
    join(__dirname, "..", "prisma", "migrations", "20260906010000_phase4_user_identity", "rollback.sql"),
    "utf8"
  );
  const MARCA = "DO $reversion_condicional$";
  const GUARDA = ROLLBACK.slice(ROLLBACK.indexOf(MARCA), ROLLBACK.indexOf("$reversion_condicional$;") + "$reversion_condicional$;".length);

  it("se BLOQUEA cuando un nombre fue reutilizado tras eliminar la cuenta anterior", async () => {
    const primera = await prisma.person.create({
      data: { ...PERSONA_BASE, run: "50000001", username: "reciclado", firstName: "Rita", fullName: "Rita Prueba" },
    });
    await prisma.user.create({ data: { username: "reciclado", passwordHash: "x", ownerType: "person", personId: primera.id } });

    await prisma.$transaction(async (tx) => {
      await tx.person.update({ where: { id: primera.id }, data: { deletedAt: new Date() } });
      await tx.user.updateMany({ where: { personId: primera.id }, data: { deletedAt: new Date() } });
    });

    // El nombre se reutiliza: esto es lo que la migración habilitó.
    const segunda = await prisma.person.create({
      data: { ...PERSONA_BASE, run: "50000002", username: "reciclado", firstName: "Rosa", fullName: "Rosa Prueba" },
    });
    await prisma.user.create({ data: { username: "reciclado", passwordHash: "x", ownerType: "person", personId: segunda.id } });

    expect(await prisma.user.count({ where: { username: "reciclado" } }), "una vigente y una eliminada").toBe(2);

    // Se intenta el paso 4 dentro de una transacción que se descarta después.
    const error = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(GUARDA);
      })
      .then(() => null)
      .catch((e) => e as Error);

    expect(error, "la reversión debe detenerse, no completarse a medias").not.toBeNull();
    expect(error!.message).toMatch(/REVERSIÓN BLOQUEADA/);
    expect(error!.message).toMatch(/reciclado/);

    // Y la base quedó como estaba: el índice parcial sigue vigente.
    const indices = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='users_username_unique_active'`
    );
    expect(indices).toHaveLength(1);
  });

  it("procede cuando NO hay nombres reutilizados", async () => {
    const persona = await prisma.person.create({
      data: { ...PERSONA_BASE, run: "50000003", username: "sin_reciclar", firstName: "Sara", fullName: "Sara Prueba" },
    });
    await prisma.user.create({ data: { username: "sin_reciclar", passwordHash: "x", ownerType: "person", personId: persona.id } });

    // Se ejecuta y se descarta: solo interesa que NO se bloquee.
    const error = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(GUARDA);
        throw new Error("descartar");
      })
      .then(() => null)
      .catch((e) => e as Error);

    expect(error!.message, "el único error debe ser el descarte deliberado").toBe("descartar");
  });
});

/**
 * Punto 4: el nombre de una cuenta es el de su titular.
 *
 * La decisión es que deben ser iguales — el nombre de usuario es UNO por
 * titular, y la cuenta es su credencial, no una identidad aparte. La
 * aplicación ya lo hacía; lo que faltaba era que la base lo exigiera, porque
 * mientras pudieran divergir el registro de nombres podía acabar con dos
 * reservas para el mismo titular y ninguna forma de saber cuál era la buena.
 */
describe("el nombre de una cuenta es el de su titular", () => {
  it("RECHAZA una cuenta de persona con un nombre distinto", async () => {
    const ana = await createPerson({ run: "60000001", username: "ana", firstName: "Ana", gender: "female" });

    await expect(
      prisma.user.create({ data: { username: "otro_nombre", passwordHash: "x", ownerType: "person", personId: ana.id } })
    ).rejects.toThrow(/debe ser el de su titular/i);
  });

  it("RECHAZA una cuenta de club con un nombre distinto", async () => {
    const club = await createClub("Club Norte", "CN");

    await expect(
      prisma.user.create({ data: { username: "otro_nombre", passwordHash: "x", ownerType: "club", clubId: club.id } })
    ).rejects.toThrow(/debe ser el de su titular/i);
  });

  it("RECHAZA renombrar la cuenta apartándola de su titular", async () => {
    const ana = await createPerson({ run: "60000002", username: "ana", firstName: "Ana", gender: "female" });
    const cuenta = await createUser({ username: "ana", roleNames: [], personId: ana.id });

    await expect(prisma.user.update({ where: { id: cuenta.id }, data: { username: "ana2" } })).rejects.toThrow(
      /debe ser el de su titular/i
    );
  });

  it("ADMITE la cuenta del sistema, que no tiene titular del que copiar", async () => {
    const admin = await prisma.user.create({ data: { username: "admin_libre", passwordHash: "x", ownerType: "system" } });
    expect(admin.username).toBe("admin_libre");
  });

  it("titular y cuenta comparten UNA sola reserva", async () => {
    const ana = await createPerson({ run: "60000003", username: "ana", firstName: "Ana", gender: "female" });
    await createUser({ username: "ana", roleNames: [], personId: ana.id });

    const reservas = await prisma.usernameReservation.findMany({ where: { ownerKind: "person", ownerId: ana.id } });
    expect(reservas, "un titular, un nombre, una reserva").toHaveLength(1);
    expect(reservas[0]!.username).toBe("ana");
  });
});

/**
 * Puntos abiertos de la revisión anterior: el disparador de igualdad solo
 * escuchaba `users`, así que quedaban dos formas de volver a separar los dos
 * nombres sin que nada lo advirtiera.
 */
describe("renombrar al titular", () => {
  it("RECHAZA renombrar una persona con cuenta vigente", async () => {
    const ana = await createPerson({ run: "70000001", username: "ana", firstName: "Ana", gender: "female" });
    await createUser({ username: "ana", roleNames: [], personId: ana.id });

    await expect(prisma.person.update({ where: { id: ana.id }, data: { username: "ana_nueva" } })).rejects.toThrow(
      /cuenta de acceso vigente/i
    );
  });

  it("RECHAZA renombrar un club con cuenta vigente", async () => {
    const club = await createClub("Club Norte", "CN");
    await createUser({ username: club.username, roleNames: [], clubId: club.id });

    await expect(prisma.club.update({ where: { id: club.id }, data: { username: "otro_nombre" } })).rejects.toThrow(
      /cuenta de acceso vigente/i
    );
  });

  it("ADMITE renombrar a un titular SIN cuenta: es la salida del preflight y de una restauración", async () => {
    const ana = await createPerson({ run: "70000002", username: "ana", firstName: "Ana", gender: "female" });

    const renombrada = await prisma.person.update({ where: { id: ana.id }, data: { username: "ana_nueva" } });

    expect(renombrada.username).toBe("ana_nueva");
    // Y la reserva sigue al día: el nombre viejo queda libre, el nuevo tomado.
    expect(await prisma.usernameReservation.count({ where: { username: "ana" } })).toBe(0);
    expect(await prisma.usernameReservation.findFirst({ where: { username: "ana_nueva" } })).toMatchObject({
      ownerKind: "person",
      ownerId: ana.id,
    });
  });

  it("ADMITE renombrar cuando la única cuenta está eliminada", async () => {
    const ana = await createPerson({ run: "70000003", username: "ana", firstName: "Ana", gender: "female" });
    const cuenta = await createUser({ username: "ana", roleNames: [], personId: ana.id });
    await prisma.user.update({ where: { id: cuenta.id }, data: { deletedAt: new Date() } });

    await expect(prisma.person.update({ where: { id: ana.id }, data: { username: "ana_nueva" } })).resolves.toBeTruthy();
  });
});

describe("reactivar una cuenta eliminada", () => {
  it("RECHAZA reactivarla si su nombre ya no es el de su titular", async () => {
    const ana = await createPerson({ run: "71000001", username: "ana", firstName: "Ana", gender: "female" });
    const cuenta = await createUser({ username: "ana", roleNames: [], personId: ana.id });

    // Se elimina y se renombra: es exactamente lo que indica el plan de
    // reversión de `phase4_user_identity` para liberar el nombre.
    await prisma.user.update({ where: { id: cuenta.id }, data: { deletedAt: new Date() } });
    await prisma.user.update({ where: { id: cuenta.id }, data: { username: `ana_${cuenta.id}` } });

    // El nombre queda libre y otra persona lo toma.
    await prisma.person.update({ where: { id: ana.id }, data: { username: "ana_retirada" } });
    await createPerson({ run: "71000002", username: "ana", firstName: "Otra", gender: "female" });

    /**
     * Reactivar la cuenta vieja solo toca `deleted_at`. Antes eso no disparaba
     * nada —el disparador escuchaba `username`— y la cuenta volvía a estar
     * vigente con un nombre que ya no es el de su titular.
     */
    await expect(prisma.user.update({ where: { id: cuenta.id }, data: { deletedAt: null } })).rejects.toThrow(
      /debe ser el de su titular/i
    );
  });

  it("ADMITE reactivarla si su nombre sigue siendo el de su titular", async () => {
    const ana = await createPerson({ run: "71000003", username: "ana", firstName: "Ana", gender: "female" });
    const cuenta = await createUser({ username: "ana", roleNames: [], personId: ana.id });

    await prisma.user.update({ where: { id: cuenta.id }, data: { deletedAt: new Date() } });
    const reactivada = await prisma.user.update({ where: { id: cuenta.id }, data: { deletedAt: null } });

    expect(reactivada.deletedAt).toBeNull();
    expect(await prisma.usernameReservation.count({ where: { username: "ana" } })).toBe(1);
  });

  it("una cuenta ELIMINADA sí puede llevar un nombre desalineado", async () => {
    const ana = await createPerson({ run: "71000004", username: "ana", firstName: "Ana", gender: "female" });
    const cuenta = await createUser({ username: "ana", roleNames: [], personId: ana.id });

    await prisma.user.update({ where: { id: cuenta.id }, data: { deletedAt: new Date() } });
    const renombrada = await prisma.user.update({ where: { id: cuenta.id }, data: { username: "ana_historica" } });

    expect(renombrada.username, "es historial, y el plan de reversión necesita poder renombrarlas").toBe("ana_historica");
  });
});
