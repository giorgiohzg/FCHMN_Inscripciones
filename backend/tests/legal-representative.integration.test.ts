/**
 * Hallazgo 19 — representante legal: ciclo de vida completo.
 *
 * La regla confirmada, ahora también escrita en el README:
 *
 *   - SÍ es un rol de acceso, con las mismas atribuciones que un delegado
 *     (la equivalencia de permisos se fija en `rbac.definitions.test.ts`).
 *   - Solo existe si el club declara personalidad jurídica (RB-02); si el
 *     club la pierde, el nombramiento se retira.
 *   - Como máximo UNO por club.
 *   - Una persona representa un solo club, igual que delegado y entrenador
 *     (ya cubierto en `authorization.integration.test.ts`).
 *   - El rol funcional y el rol de acceso se derivan del nombramiento: al
 *     retirarlo, ambos se desactivan.
 *
 * Lo que faltaba probar era justamente el ciclo de vida: hasta ahora solo se
 * verificaba que un representante legal ya nombrado quedara acotado a su club.
 * Nada comprobaba qué pasa al reemplazarlo, al retirarlo, o al quitarle al
 * club la personalidad jurídica — los tres caminos por los que alguien deja
 * de serlo y debe perder el acceso.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createPerson, createUser } from "./helpers/seedRbac";
import * as clubsService from "../src/modules/clubs/clubs.service";
import { loadAuthorizationState } from "../src/modules/auth/authorization";

let ADMIN: { userId: string };

/** RUT con dígito verificador válido (RB-02 lo exige si hay personalidad jurídica). */
const RUT_VALIDO = "11111111-1";

const CLUB_CON_PERSONALIDAD = {
  name: "Club Jurídico",
  username: "club_juridico",
  code: "CJU",
  hasLegalStatus: true,
  rut: RUT_VALIDO,
  email: "cju@test.local",
  isAchmnMember: false,
  isAchmnCollaborator: false,
  isFchmnMember: false,
  isFchmnCollaborator: false,
};

async function rolFuncional(personId: string) {
  return prisma.personRole.findUnique({ where: { personId_roleType: { personId, roleType: "legal_representative" } } });
}

async function tieneRolDeAcceso(userId: string) {
  const estado = await loadAuthorizationState(userId);
  return estado?.roles.includes("legal_representative") ?? false;
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_replegal", roleNames: ["admin"] });
  ADMIN = { userId: admin.id };
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("representante legal — nombramiento", () => {
  it("nombrarlo le otorga el rol funcional y el rol de acceso", async () => {
    const persona = await createPerson({ run: "40000001", username: "rep_uno", firstName: "Rita", gender: "female", roles: [] });
    const usuario = await createUser({ username: "rep_uno", roleNames: [], personId: persona.id });

    await clubsService.createClub({ ...CLUB_CON_PERSONALIDAD, legalRepresentativePersonId: persona.id }, ADMIN);

    expect((await rolFuncional(persona.id))?.active).toBe(true);
    expect(await tieneRolDeAcceso(usuario.id), "el nombramiento es lo que otorga el acceso").toBe(true);
  });

  /**
   * Antes esta designación se DESCARTABA en silencio y el club se creaba igual.
   * Ahora se rechaza: quien la pidió se enteraba solo al mirar la ficha, y el
   * representante legal es una vía de acceso al sistema.
   */
  it("un club SIN personalidad jurídica no admite representante legal: se RECHAZA", async () => {
    const persona = await createPerson({ run: "40000002", username: "rep_dos", firstName: "Raúl", gender: "male", roles: [] });

    await expect(
      clubsService.createClub(
        { ...CLUB_CON_PERSONALIDAD, hasLegalStatus: false, rut: undefined, legalRepresentativePersonId: persona.id },
        ADMIN
      )
    ).rejects.toThrow(/Solo los clubes con personalidad jurídica/);

    // Nada quedó a medias: ni el club, ni el nombramiento, ni el rol.
    expect(await prisma.club.count({ where: { code: CLUB_CON_PERSONALIDAD.code } })).toBe(0);
    expect(await prisma.clubStaff.count({ where: { roleType: "legal_representative" } })).toBe(0);
    expect(await rolFuncional(persona.id)).toBeNull();
  });

  it("un club PENDIENTE de verificar tampoco admite representante legal", async () => {
    const persona = await createPerson({ run: "40000008", username: "rep_pend", firstName: "Pamela", gender: "female", roles: [] });

    await expect(
      clubsService.createClub(
        { ...CLUB_CON_PERSONALIDAD, hasLegalStatus: null, rut: undefined, legalRepresentativePersonId: persona.id },
        ADMIN
      )
    ).rejects.toThrow(/pendiente de verificar/i);

    expect(await prisma.clubStaff.count({ where: { roleType: "legal_representative" } })).toBe(0);
  });
});

describe("representante legal — pérdida del nombramiento", () => {
  it("reemplazarlo deja UNO solo y el saliente pierde el rol", async () => {
    const saliente = await createPerson({ run: "40000003", username: "rep_sale", firstName: "Sofía", gender: "female", roles: [] });
    const usuarioSaliente = await createUser({ username: "rep_sale", roleNames: [], personId: saliente.id });
    const entrante = await createPerson({ run: "40000004", username: "rep_entra", firstName: "Elena", gender: "female", roles: [] });

    const club = await clubsService.createClub({ ...CLUB_CON_PERSONALIDAD, legalRepresentativePersonId: saliente.id }, ADMIN);
    await clubsService.updateClub(club.id, { hasLegalStatus: true, rut: RUT_VALIDO, legalRepresentativePersonId: entrante.id }, ADMIN);

    const nombrados = await prisma.clubStaff.findMany({ where: { clubId: club.id, roleType: "legal_representative" } });
    expect(nombrados, "como máximo un representante legal por club").toHaveLength(1);
    expect(nombrados[0]!.personId).toBe(entrante.id);

    expect((await rolFuncional(saliente.id))?.active).toBe(false);
    expect(await tieneRolDeAcceso(usuarioSaliente.id), "quien deja el cargo pierde el acceso").toBe(false);
    expect((await rolFuncional(entrante.id))?.active).toBe(true);
  });

  it("retirarlo sin reemplazo desactiva su rol funcional y su rol de acceso", async () => {
    const persona = await createPerson({ run: "40000005", username: "rep_retiro", firstName: "Rosa", gender: "female", roles: [] });
    const usuario = await createUser({ username: "rep_retiro", roleNames: [], personId: persona.id });

    const club = await clubsService.createClub({ ...CLUB_CON_PERSONALIDAD, legalRepresentativePersonId: persona.id }, ADMIN);
    await clubsService.updateClub(club.id, { hasLegalStatus: true, rut: RUT_VALIDO, legalRepresentativePersonId: null }, ADMIN);

    expect(await prisma.clubStaff.count({ where: { clubId: club.id, roleType: "legal_representative" } })).toBe(0);
    expect((await rolFuncional(persona.id))?.active).toBe(false);
    expect(await tieneRolDeAcceso(usuario.id)).toBe(false);
  });

  /**
   * ESTE COMPORTAMIENTO CAMBIÓ A PROPÓSITO — 2026-10-31.
   *
   * Antes, poner el indicador en `false` retiraba el cargo «solo»: borraba la
   * fila de `club_staff` y desactivaba el rol de acceso de esa persona, sin
   * avisar. Con dos estados pasaba poco. Al añadir «pendiente de verificar», la
   * transición «pendiente → no» se vuelve rutinaria y cada vez le quitaría a
   * alguien su acceso como efecto colateral de cambiar una casilla.
   *
   * Ahora el cambio de estado se RECHAZA mientras haya un representante
   * designado, y retirarlo es una petición explícita. Dos pasos, para que quitar
   * el acceso de una persona sea una decisión visible.
   */
  it("perder la personalidad jurídica NO retira el cargo en silencio: se rechaza el cambio", async () => {
    const persona = await createPerson({ run: "40000006", username: "rep_sinpj", firstName: "Pía", gender: "female", roles: [] });
    const usuario = await createUser({ username: "rep_sinpj", roleNames: [], personId: persona.id });

    const club = await clubsService.createClub({ ...CLUB_CON_PERSONALIDAD, legalRepresentativePersonId: persona.id }, ADMIN);

    await expect(clubsService.updateClub(club.id, { hasLegalStatus: false }, ADMIN)).rejects.toThrow(/Retírelo expresamente/);

    // El club no cambió de estado y NADA se borró.
    const sinCambios = await prisma.club.findUniqueOrThrow({ where: { id: club.id } });
    expect(sinCambios.hasLegalStatus).toBe(true);
    expect(sinCambios.rut, "el RUT sigue siendo el que tenía").toBe(club.rut);
    expect(await prisma.clubStaff.count({ where: { clubId: club.id, roleType: "legal_representative" } })).toBe(1);
    expect((await rolFuncional(persona.id))?.active).toBe(true);
    expect(await tieneRolDeAcceso(usuario.id), "el acceso sigue intacto tras el rechazo").toBe(true);
  });

  it("retirándolo primero, el club sí puede quedar sin personalidad jurídica", async () => {
    const persona = await createPerson({ run: "40000009", username: "rep_dospasos", firstName: "Dora", gender: "female", roles: [] });
    const usuario = await createUser({ username: "rep_dospasos", roleNames: [], personId: persona.id });

    const club = await clubsService.createClub({ ...CLUB_CON_PERSONALIDAD, legalRepresentativePersonId: persona.id }, ADMIN);

    // Paso 1 — retiro explícito, con la personalidad jurídica todavía en `true`.
    await clubsService.updateClub(club.id, { hasLegalStatus: true, rut: RUT_VALIDO, legalRepresentativePersonId: null }, ADMIN);
    expect(await prisma.clubStaff.count({ where: { clubId: club.id, roleType: "legal_representative" } })).toBe(0);
    expect((await rolFuncional(persona.id))?.active).toBe(false);
    expect(await tieneRolDeAcceso(usuario.id)).toBe(false);

    // Paso 2 — ahora el estado puede cambiar, y el RUT se descarta (RB-02).
    await clubsService.updateClub(club.id, { hasLegalStatus: false }, ADMIN);
    const actualizado = await prisma.club.findUniqueOrThrow({ where: { id: club.id } });
    expect(actualizado.hasLegalStatus).toBe(false);
    expect(actualizado.rut, "sin personalidad jurídica no se conserva el RUT (RB-02)").toBeNull();
  });
});

describe("representante legal — un solo club", () => {
  it("no puede serlo de dos clubes a la vez", async () => {
    const persona = await createPerson({ run: "40000007", username: "rep_doble", firstName: "Dora", gender: "female", roles: [] });
    await clubsService.createClub({ ...CLUB_CON_PERSONALIDAD, legalRepresentativePersonId: persona.id }, ADMIN);

    await expect(
      clubsService.createClub(
        {
          ...CLUB_CON_PERSONALIDAD,
          name: "Otro Club",
          username: "club_otro",
          code: "COT",
          // 12345678-5 también tiene dígito verificador válido.
          rut: "12345678-5",
          email: "cot@test.local",
          legalRepresentativePersonId: persona.id,
        },
        ADMIN
      )
    ).rejects.toThrow(/un club a la vez/i);
  });
});
