/**
 * Las TRANSICIONES entre los dos estados de la personalidad jurídica
 * (`true` / `false`), ejecutadas contra PostgreSQL y a través de los servicios
 * reales.
 *
 * Hasta la etapa 10a existía un tercer estado, «pendiente de verificar»
 * (`null`); se retiró del contrato público y sus clubes pasaron a «No tiene».
 * Lo que estas pruebas protegen sigue siendo un borrado silencioso: antes,
 * poner el indicador en `false` ejecutaba `replaceClubStaff(legal_representative, [])`
 * y le quitaba a alguien su acceso como efecto colateral de cambiar una casilla.
 * Ahora se rechaza y se exige retirar el nombramiento de forma expresa.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, createPerson } from "./helpers/seedRbac";
import * as clubsService from "../src/modules/clubs/clubs.service";

let ADMIN: { userId: string };

const RUT_VALIDO = "11111111-1";
// RUT evidentemente sintéticos: un valor con dígito verificador correcto en
// el rango 76-77 millones podría pertenecer a una empresa real.
const OTRO_RUT_VALIDO = "22222222-2";

const BASE = {
  email: "contacto@example.invalid",
  isAchmnMember: false,
  isAchmnCollaborator: false,
  isFchmnMember: false,
  isFchmnCollaborator: false,
  delegatePersonIds: [],
  coachPersonIds: [],
};

/** Crea un club en el estado pedido. */
async function crearClub(opts: { sufijo: string; estado: boolean; rut?: string; representante?: string }) {
  return clubsService.createClub(
    {
      ...BASE,
      name: `Club ${opts.sufijo}`,
      code: opts.sufijo.slice(0, 5).toUpperCase(),
      username: `club.${opts.sufijo}`,
      hasLegalStatus: opts.estado,
      rut: opts.rut,
      legalRepresentativePersonId: opts.representante ?? null,
    },
    ADMIN
  );
}

/** Los campos de una actualización, que exige el estado siempre explícito. */
const actualizacion = (estado: boolean, extra: Record<string, unknown> = {}) => ({
  ...BASE,
  hasLegalStatus: estado,
  ...extra,
});

async function nuevaPersona(sufijo: string) {
  return createPerson({ run: `1234567${sufijo}`, username: `persona.${sufijo}`, firstName: `Persona${sufijo}`, gender: "female" });
}

const representanteDe = async (clubId: string) =>
  prisma.clubStaff.findFirst({ where: { clubId, roleType: "legal_representative" } });

const rolDe = async (personId: string) =>
  prisma.personRole.findFirst({ where: { personId, roleType: "legal_representative" } });

beforeEach(async () => {
  await truncateAllTables(prisma as unknown as Parameters<typeof truncateAllTables>[0]);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin.pruebas", roleNames: ["admin"] });
  ADMIN = { userId: admin.id };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("crear un club en cada estado", () => {
  it("sin personalidad jurídica: se guarda false", async () => {
    const club = await crearClub({ sufijo: "nopj", estado: false });
    expect(club.hasLegalStatus).toBe(false);
    expect((await prisma.club.findUniqueOrThrow({ where: { id: club.id } })).hasLegalStatus).toBe(false);
  });

  it("con personalidad jurídica y RUT: se guarda true y el RUT normalizado", async () => {
    const club = await crearClub({ sufijo: "conpj", estado: true, rut: RUT_VALIDO });
    expect(club.hasLegalStatus).toBe(true);
    expect(club.rut).toBe("111111111");
  });

  it("sin personalidad jurídica: el RUT se descarta", async () => {
    const club = await crearClub({ sufijo: "nopjrut", estado: false, rut: RUT_VALIDO });
    expect(club.rut).toBeNull();
  });

  it("sin personalidad jurídica: NO se puede designar representante legal", async () => {
    const persona = await nuevaPersona("1");
    await expect(crearClub({ sufijo: "norep", estado: false, representante: persona.id })).rejects.toThrow(
      /Solo los clubes con personalidad jurídica/
    );
    expect(await prisma.club.count({ where: { code: "NOREP" } })).toBe(0);
  });
});

describe("transiciones de estado", () => {
  it("«No tiene» → con personalidad jurídica, aportando el RUT", async () => {
    const club = await crearClub({ sufijo: "t1", estado: false });
    const actualizado = await clubsService.updateClub(club.id, actualizacion(true, { rut: RUT_VALIDO }), ADMIN);
    expect(actualizado.hasLegalStatus).toBe(true);
    expect(actualizado.rut).toBe("111111111");
  });

  it("con personalidad jurídica → «No tiene» (sin representante): el RUT se descarta", async () => {
    const club = await crearClub({ sufijo: "t2", estado: true, rut: RUT_VALIDO });
    const actualizado = await clubsService.updateClub(club.id, actualizacion(false), ADMIN);
    expect(actualizado.hasLegalStatus).toBe(false);
    expect(actualizado.rut).toBeNull();
  });

  it("el RUT se mantiene si no se envía el campo", async () => {
    const club = await crearClub({ sufijo: "t5", estado: true, rut: RUT_VALIDO });
    const actualizado = await clubsService.updateClub(club.id, actualizacion(true), ADMIN);
    expect(actualizado.rut).toBe("111111111");
  });

  it("el RUT se puede cambiar por otro válido", async () => {
    const club = await crearClub({ sufijo: "t6", estado: true, rut: RUT_VALIDO });
    const actualizado = await clubsService.updateClub(club.id, actualizacion(true, { rut: OTRO_RUT_VALIDO }), ADMIN);
    expect(actualizado.rut).toBe("222222222");
    expect(actualizado.hasLegalStatus).toBe(true);
  });
});

describe("el representante legal bloquea el cambio de estado", () => {
  async function clubConRepresentante(sufijo: string) {
    const persona = await nuevaPersona(sufijo);
    const club = await crearClub({ sufijo, estado: true, rut: RUT_VALIDO, representante: persona.id });
    expect(await representanteDe(club.id)).not.toBeNull();
    return { club, persona };
  }

  it("true → false se RECHAZA mientras haya representante designado, con un mensaje que lo explica", async () => {
    const { club } = await clubConRepresentante("r1");
    await expect(clubsService.updateClub(club.id, actualizacion(false), ADMIN)).rejects.toThrow(/Retírelo expresamente/);
    await expect(clubsService.updateClub(club.id, actualizacion(false), ADMIN)).rejects.toThrow(/no tiene personalidad jurídica/);
  });

  it("tras el rechazo, el nombramiento y el rol de acceso siguen INTACTOS", async () => {
    const { club, persona } = await clubConRepresentante("r4");
    await expect(clubsService.updateClub(club.id, actualizacion(false), ADMIN)).rejects.toThrow();

    // Nada se borró: ni la fila de plantilla, ni el rol, ni el estado del club.
    expect(await representanteDe(club.id)).not.toBeNull();
    const rol = await rolDe(persona.id);
    expect(rol?.active).toBe(true);
    const enLaBase = await prisma.club.findUniqueOrThrow({ where: { id: club.id } });
    expect(enLaBase.hasLegalStatus).toBe(true);
    expect(enLaBase.rut).toBe("111111111");
  });

  it("retirándolo expresamente primero, el cambio de estado sí procede", async () => {
    const { club, persona } = await clubConRepresentante("r5");

    // Paso 1: retirar el nombramiento, con el estado todavía en `true`.
    await clubsService.updateClub(club.id, actualizacion(true, { rut: RUT_VALIDO, legalRepresentativePersonId: null }), ADMIN);
    expect(await representanteDe(club.id)).toBeNull();
    // El rol derivado se recalcula, porque la persona ya no es personal del club.
    expect((await rolDe(persona.id))?.active ?? false).toBe(false);

    // Paso 2: ahora el estado puede cambiar.
    const actualizado = await clubsService.updateClub(club.id, actualizacion(false), ADMIN);
    expect(actualizado.hasLegalStatus).toBe(false);
  });

  it("sin personalidad jurídica, designar un representante se RECHAZA", async () => {
    const club = await crearClub({ sufijo: "r6", estado: false });
    const persona = await nuevaPersona("6b");
    await expect(
      clubsService.updateClub(club.id, actualizacion(false, { legalRepresentativePersonId: persona.id }), ADMIN)
    ).rejects.toThrow(/Solo los clubes con personalidad jurídica/);
    expect(await representanteDe(club.id)).toBeNull();
  });

  it("los delegados y entrenadores NO se ven afectados por el cambio de estado", async () => {
    const delegado = await nuevaPersona("7");
    const club = await crearClub({ sufijo: "r7c", estado: true, rut: RUT_VALIDO });
    await clubsService.updateClub(club.id, actualizacion(true, { rut: RUT_VALIDO, delegatePersonIds: [delegado.id] }), ADMIN);
    expect(await prisma.clubStaff.count({ where: { clubId: club.id, roleType: "delegate" } })).toBe(1);

    // Pasar a «No tiene» no toca al delegado: la regla es solo del representante legal.
    await clubsService.updateClub(club.id, actualizacion(false, { delegatePersonIds: [delegado.id] }), ADMIN);
    expect(await prisma.clubStaff.count({ where: { clubId: club.id, roleType: "delegate" } })).toBe(1);
    expect((await prisma.personRole.findFirst({ where: { personId: delegado.id, roleType: "delegate" } }))?.active).toBe(true);
  });
});

describe("el filtro del listado distingue los dos estados", () => {
  beforeEach(async () => {
    await crearClub({ sufijo: "fsi", estado: true, rut: RUT_VALIDO });
    await crearClub({ sufijo: "fno1", estado: false });
    await crearClub({ sufijo: "fno2", estado: false });
  });

  const listar = (personalidadJuridica?: "si" | "no") =>
    clubsService.listClubs({ page: 1, pageSize: 50, personalidadJuridica }, { userId: ADMIN.userId, scope: { kind: "admin" } } as never);

  it("«no» devuelve solo los false", async () => {
    const r = await listar("no");
    expect(r.total).toBe(2);
    expect(r.items.every((c) => c.hasLegalStatus === false)).toBe(true);
  });

  it("«si» devuelve solo los true", async () => {
    const r = await listar("si");
    expect(r.total).toBe(1);
    expect(r.items[0]!.hasLegalStatus).toBe(true);
  });

  it("sin filtro devuelve los tres", async () => {
    expect((await listar()).total).toBe(3);
  });
});
