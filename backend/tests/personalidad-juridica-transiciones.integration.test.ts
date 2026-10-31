/**
 * Las TRANSICIONES entre los tres estados de la personalidad jurídica,
 * ejecutadas contra PostgreSQL y a través de los servicios reales.
 *
 * Lo que estas pruebas protegen es un borrado silencioso. Antes, poner el
 * indicador en `false` ejecutaba `replaceClubStaff(legal_representative, [])`:
 * retiraba el nombramiento y recalculaba el rol de acceso de esa persona, sin
 * avisar. Con dos estados eso pasaba poco; al añadir «pendiente de verificar»,
 * la transición «pendiente → no» se vuelve rutinaria, y cada vez le quitaría a
 * alguien su acceso como efecto colateral de cambiar una casilla.
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
async function crearClub(opts: { sufijo: string; estado: boolean | null; rut?: string; representante?: string }) {
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
const actualizacion = (estado: boolean | null, extra: Record<string, unknown> = {}) => ({
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
  it("pendiente: se guarda NULL, no false", async () => {
    const club = await crearClub({ sufijo: "pend", estado: null });
    expect(club.hasLegalStatus).toBeNull();

    const enLaBase = await prisma.club.findUniqueOrThrow({ where: { id: club.id } });
    expect(enLaBase.hasLegalStatus).toBeNull();
  });

  it("verificado como SIN personalidad jurídica: se guarda false, distinguible de pendiente", async () => {
    const club = await crearClub({ sufijo: "nopj", estado: false });
    expect(club.hasLegalStatus).toBe(false);
  });

  it("con personalidad jurídica y RUT: se guarda true y el RUT normalizado", async () => {
    const club = await crearClub({ sufijo: "conpj", estado: true, rut: RUT_VALIDO });
    expect(club.hasLegalStatus).toBe(true);
    expect(club.rut).toBe("111111111");
  });

  it("pendiente CON RUT: conserva el RUT y NO pasa a verificado", async () => {
    const club = await crearClub({ sufijo: "pendrut", estado: null, rut: RUT_VALIDO });
    expect(club.rut).toBe("111111111");
    // Lo esencial: tener el RUT no cambia el estado por su cuenta.
    expect(club.hasLegalStatus).toBeNull();
  });

  it("verificado como SIN personalidad jurídica: el RUT se descarta", async () => {
    const club = await crearClub({ sufijo: "nopjrut", estado: false, rut: RUT_VALIDO });
    expect(club.rut).toBeNull();
  });

  it("pendiente: NO se puede designar representante legal", async () => {
    const persona = await nuevaPersona("1");
    await expect(crearClub({ sufijo: "pendrep", estado: null, representante: persona.id })).rejects.toThrow();
  });
});

describe("transiciones de estado", () => {
  it("pendiente → con personalidad jurídica, aportando el RUT", async () => {
    const club = await crearClub({ sufijo: "t1", estado: null });
    const actualizado = await clubsService.updateClub(club.id, actualizacion(true, { rut: RUT_VALIDO }), ADMIN);
    expect(actualizado.hasLegalStatus).toBe(true);
    expect(actualizado.rut).toBe("111111111");
  });

  it("pendiente → verificado que no la tiene: el RUT que hubiera se descarta", async () => {
    const club = await crearClub({ sufijo: "t2", estado: null, rut: RUT_VALIDO });
    const actualizado = await clubsService.updateClub(club.id, actualizacion(false), ADMIN);
    expect(actualizado.hasLegalStatus).toBe(false);
    expect(actualizado.rut).toBeNull();
  });

  it("con personalidad jurídica → pendiente, sin representante: permitido", async () => {
    const club = await crearClub({ sufijo: "t3", estado: true, rut: RUT_VALIDO });
    const actualizado = await clubsService.updateClub(club.id, actualizacion(null), ADMIN);
    expect(actualizado.hasLegalStatus).toBeNull();
    // El RUT no se descarta: con el estado pendiente sigue siendo un dato útil.
    expect(actualizado.rut).toBe("111111111");
  });

  it("un null explícito NO se confunde con «no enviado»", async () => {
    const club = await crearClub({ sufijo: "t4", estado: true, rut: RUT_VALIDO });
    const actualizado = await clubsService.updateClub(club.id, actualizacion(null), ADMIN);
    // Si el servicio usara `input.hasLegalStatus ?? before.hasLegalStatus`,
    // esto habría seguido en `true` y marcar el club como pendiente no haría nada.
    expect(actualizado.hasLegalStatus).toBeNull();
  });

  it("el RUT se mantiene si no se envía el campo", async () => {
    const club = await crearClub({ sufijo: "t5", estado: true, rut: RUT_VALIDO });
    const actualizado = await clubsService.updateClub(club.id, actualizacion(true), ADMIN);
    expect(actualizado.rut).toBe("111111111");
  });

  it("el RUT se puede cambiar por otro válido", async () => {
    const club = await crearClub({ sufijo: "t6", estado: null, rut: RUT_VALIDO });
    const actualizado = await clubsService.updateClub(club.id, actualizacion(null, { rut: OTRO_RUT_VALIDO }), ADMIN);
    expect(actualizado.rut).toBe("222222222");
    expect(actualizado.hasLegalStatus).toBeNull();
  });
});

describe("el representante legal bloquea el cambio de estado", () => {
  async function clubConRepresentante(sufijo: string) {
    const persona = await nuevaPersona(sufijo);
    const club = await crearClub({ sufijo, estado: true, rut: RUT_VALIDO, representante: persona.id });
    expect(await representanteDe(club.id)).not.toBeNull();
    return { club, persona };
  }

  it("true → pendiente se RECHAZA mientras haya representante designado", async () => {
    const { club } = await clubConRepresentante("r1");
    await expect(clubsService.updateClub(club.id, actualizacion(null), ADMIN)).rejects.toThrow(/Retírelo expresamente/);
  });

  it("el mensaje del rechazo nombra el estado al que se intentaba pasar", async () => {
    const { club } = await clubConRepresentante("r2");
    await expect(clubsService.updateClub(club.id, actualizacion(null), ADMIN)).rejects.toThrow(/pendiente de verificar/);
    await expect(clubsService.updateClub(club.id, actualizacion(false), ADMIN)).rejects.toThrow(/no tiene personalidad jurídica/);
  });

  it("true → false se RECHAZA mientras haya representante designado", async () => {
    const { club } = await clubConRepresentante("r3");
    await expect(clubsService.updateClub(club.id, actualizacion(false), ADMIN)).rejects.toThrow(/Retírelo expresamente/);
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
  });

  it("retirándolo expresamente primero, el cambio de estado sí procede", async () => {
    const { club, persona } = await clubConRepresentante("r5");

    // Paso 1: retirar el nombramiento, con el estado todavía en `true`.
    await clubsService.updateClub(club.id, actualizacion(true, { rut: RUT_VALIDO, legalRepresentativePersonId: null }), ADMIN);
    expect(await representanteDe(club.id)).toBeNull();
    // El rol derivado se recalcula, porque la persona ya no es personal del club.
    expect((await rolDe(persona.id))?.active ?? false).toBe(false);

    // Paso 2: ahora el estado puede cambiar.
    const actualizado = await clubsService.updateClub(club.id, actualizacion(null), ADMIN);
    expect(actualizado.hasLegalStatus).toBeNull();
  });

  it("estando pendiente, designar un representante se RECHAZA", async () => {
    const club = await crearClub({ sufijo: "r6", estado: null });
    const persona = await nuevaPersona("r6b");
    await expect(
      clubsService.updateClub(club.id, actualizacion(null, { legalRepresentativePersonId: persona.id }), ADMIN)
    ).rejects.toThrow();
    expect(await representanteDe(club.id)).toBeNull();
  });

  it("los delegados y entrenadores NO se ven afectados por el cambio de estado", async () => {
    const delegado = await nuevaPersona("r7");
    const club = await crearClub({ sufijo: "r7c", estado: true, rut: RUT_VALIDO });
    await clubsService.updateClub(club.id, actualizacion(true, { rut: RUT_VALIDO, delegatePersonIds: [delegado.id] }), ADMIN);
    expect(await prisma.clubStaff.count({ where: { clubId: club.id, roleType: "delegate" } })).toBe(1);

    // Pasar a pendiente no toca al delegado: la regla es solo del representante legal.
    await clubsService.updateClub(club.id, actualizacion(null, { delegatePersonIds: [delegado.id] }), ADMIN);
    expect(await prisma.clubStaff.count({ where: { clubId: club.id, roleType: "delegate" } })).toBe(1);
    expect((await prisma.personRole.findFirst({ where: { personId: delegado.id, roleType: "delegate" } }))?.active).toBe(true);
  });
});

describe("el filtro del listado distingue los tres estados", () => {
  beforeEach(async () => {
    await crearClub({ sufijo: "fsi", estado: true, rut: RUT_VALIDO });
    await crearClub({ sufijo: "fno", estado: false });
    await crearClub({ sufijo: "fpe1", estado: null });
    await crearClub({ sufijo: "fpe2", estado: null });
  });

  const listar = (personalidadJuridica?: "si" | "no" | "pendiente") =>
    clubsService.listClubs({ page: 1, pageSize: 50, personalidadJuridica }, { userId: ADMIN.userId, scope: { kind: "admin" } } as never);

  it("«pendiente» devuelve solo los de estado NULL, no los false", async () => {
    const r = await listar("pendiente");
    expect(r.total).toBe(2);
    expect(r.items.every((c) => c.hasLegalStatus === null)).toBe(true);
  });

  it("«no» devuelve solo los false, no los pendientes", async () => {
    const r = await listar("no");
    expect(r.total).toBe(1);
    expect(r.items[0]!.hasLegalStatus).toBe(false);
  });

  it("«si» devuelve solo los true", async () => {
    const r = await listar("si");
    expect(r.total).toBe(1);
    expect(r.items[0]!.hasLegalStatus).toBe(true);
  });

  it("sin filtro devuelve los cuatro", async () => {
    expect((await listar()).total).toBe(4);
  });
});
