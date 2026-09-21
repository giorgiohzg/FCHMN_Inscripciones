/**
 * Regresión de la comprobación `username-colision-global` del preflight.
 *
 * El defecto: el `DISTINCT` incluía la columna descriptiva `detalle`, cuyo
 * texto difiere entre una persona ("persona: Ana Pérez") y su propia cuenta de
 * acceso ("cuenta de acceso: ana"). Como ambos comparten nombre de usuario, la
 * consulta los contaba como DOS titulares distintos y reportaba una colisión
 * donde no la hay: bastaba con que una sola persona tuviera credenciales para
 * que el preflight bloqueara la migración con un conflicto inexistente.
 *
 * Se ejecuta la consulta REAL del preflight (importada de `CHECKS`), no una
 * copia, contra datos sembrados a propósito.
 *
 * Los dos casos de colisión verdadera hay que sembrarlos SALTÁNDOSE los
 * disparadores de `username_reservations`, porque desde la Fase 4 la base ya
 * no los admite. Es exactamente el escenario que justifica que el preflight
 * exista: datos que entraron antes de esa garantía, por importación o por
 * corrección manual.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { CHECKS } from "../scripts/migrationChecks";

const CHECK = CHECKS.find((c) => c.id === "username-colision-global")!;

async function colisionesDetectadas(): Promise<{ username: string }[]> {
  return prisma.$queryRawUnsafe<{ username: string }[]>(CHECK.query);
}

const PERSONA_BASE = {
  paternalLastName: "Prueba",
  birthDate: new Date("1990-01-01"),
  gender: "female" as const,
  status: "active" as const,
};

/**
 * Inserta saltándose los disparadores del registro de nombres. El
 * DISABLE/ENABLE va dentro de la misma transacción que las inserciones, así
 * que la ventana no existe para nadie más y al terminar los disparadores
 * quedan como estaban.
 */
async function sinDisparadoresDeReserva(sentencias: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE persons DISABLE TRIGGER persons_username_registry`);
    await tx.$executeRawUnsafe(`ALTER TABLE clubs DISABLE TRIGGER clubs_username_registry`);
    await tx.$executeRawUnsafe(`ALTER TABLE users DISABLE TRIGGER users_username_registry`);
    for (const sentencia of sentencias) await tx.$executeRawUnsafe(sentencia);
    await tx.$executeRawUnsafe(`ALTER TABLE persons ENABLE TRIGGER persons_username_registry`);
    await tx.$executeRawUnsafe(`ALTER TABLE clubs ENABLE TRIGGER clubs_username_registry`);
    await tx.$executeRawUnsafe(`ALTER TABLE users ENABLE TRIGGER users_username_registry`);
  });
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("preflight username-colision-global — sin falsos positivos", () => {
  it("una persona y SU PROPIA cuenta con el mismo nombre no son una colisión", async () => {
    const persona = await prisma.person.create({
      data: { ...PERSONA_BASE, run: "11111111", username: "ana", firstName: "Ana", fullName: "Ana Prueba" },
    });
    await prisma.user.create({
      data: { username: "ana", passwordHash: "x", ownerType: "person", personId: persona.id },
    });

    expect(await colisionesDetectadas(), "mismo titular, mismo nombre: no hay conflicto").toEqual([]);
  });

  it("un club y SU PROPIA cuenta con el mismo nombre tampoco lo son", async () => {
    const club = await prisma.club.create({
      data: { name: "Club Norte", username: "club_norte", code: "CN", email: "cn@test.local", status: "active" },
    });
    await prisma.user.create({
      data: { username: "club_norte", passwordHash: "x", ownerType: "club", clubId: club.id },
    });

    expect(await colisionesDetectadas()).toEqual([]);
  });
});

describe("preflight username-colision-global — colisiones verdaderas", () => {
  it("una persona y un club con el mismo nombre de usuario BLOQUEAN", async () => {
    await prisma.person.create({
      data: { ...PERSONA_BASE, run: "22222222", username: "delfines", firstName: "Ana", fullName: "Ana Prueba" },
    });

    await sinDisparadoresDeReserva([
      `INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at)
       VALUES (gen_random_uuid(), 'Club Delfines', 'delfines', 'CDE', 'cde@test.local', 'active', false, now())`,
    ]);

    const colisiones = await colisionesDetectadas();
    expect(colisiones.map((c) => c.username)).toEqual(["delfines"]);
  });

  it("una cuenta `system` y otro titular con el mismo nombre BLOQUEAN", async () => {
    await prisma.person.create({
      data: { ...PERSONA_BASE, run: "33333333", username: "admin", firstName: "Ana", fullName: "Ana Prueba" },
    });

    await sinDisparadoresDeReserva([
      `INSERT INTO users (id, username, password_hash, must_change_password, status, owner_type, updated_at)
       VALUES (gen_random_uuid(), 'admin', 'x', false, 'active', 'system', now())`,
    ]);

    const colisiones = await colisionesDetectadas();
    expect(colisiones.map((c) => c.username), "la cuenta del sistema es un titular más").toEqual(["admin"]);
  });

  it("el reporte nombra a los dos titulares en conflicto", async () => {
    await prisma.person.create({
      data: { ...PERSONA_BASE, run: "44444444", username: "delfines", firstName: "Ana", fullName: "Ana Pérez" },
    });
    await sinDisparadoresDeReserva([
      `INSERT INTO clubs (id, name, username, code, email, status, has_legal_status, updated_at)
       VALUES (gen_random_uuid(), 'Club Delfines', 'delfines', 'CDE', 'cde@test.local', 'active', false, now())`,
    ]);

    const [fila] = (await prisma.$queryRawUnsafe(CHECK.query)) as { titulares: string }[];
    expect(fila!.titulares).toContain("Ana Pérez");
    expect(fila!.titulares).toContain("Club Delfines");
  });
});
