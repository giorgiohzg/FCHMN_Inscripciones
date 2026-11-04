/**
 * La SIGLA es el identificador único del club: garantía de la base
 * (`clubs_code_unique_active`, entre clubes no eliminados, incluidos los inactivos),
 * comprobación legible al crear y editar, y comportamiento frente a la concurrencia.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, createClub as crearClubDePrueba } from "./helpers/seedRbac";
import * as clubsService from "../src/modules/clubs/clubs.service";
import { translatePrismaError } from "../src/shared/prismaErrors";
import { ConflictError, ValidationError } from "../src/shared/errors";
import { normalizarSigla } from "../src/shared/clubCode";

let ACTOR: { userId: string };
let contador = 0;

const datos = (code: string, extra: Record<string, unknown> = {}) => {
  contador++;
  return {
    name: `Club Sigla ${contador}`,
    code,
    hasLegalStatus: false,
    isAchmnMember: false,
    isAchmnCollaborator: false,
    isFchmnMember: false,
    isFchmnCollaborator: false,
    ...extra,
  } as Parameters<typeof clubsService.createClub>[0];
};

const edicion = (code: string) => ({ code, hasLegalStatus: false }) as Parameters<typeof clubsService.updateClub>[1];

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_sigla", roleNames: ["admin"] });
  ACTOR = { userId: admin.id };
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("al crear", () => {
  it("rechaza una sigla repetida, sin distinguir mayúsculas ni espacios, con un mensaje que nombra al club", async () => {
    await clubsService.createClub(datos("CNV", { name: "Club Valle" }), ACTOR);
    for (const repetida of ["CNV", "cnv", " cNv "]) {
      const intento = clubsService.createClub(datos(repetida), ACTOR);
      await expect(intento).rejects.toBeInstanceOf(ValidationError);
      await expect(intento).rejects.toThrow(/La sigla «CNV» ya está en uso por el club «Club Valle»/);
    }
    expect(await prisma.club.count()).toBe(1);
  });

  it("guarda la sigla normalizada", async () => {
    const c = await clubsService.createClub(datos("abc"), ACTOR);
    expect(c.code).toBe("ABC");
  });

  it("un club INACTIVO conserva su sigla", async () => {
    const c = await clubsService.createClub(datos("INA", { name: "Club Dormido" }), ACTOR);
    await prisma.club.update({ where: { id: c.id }, data: { status: "disabled" } });
    await expect(clubsService.createClub(datos("ina"), ACTOR)).rejects.toThrow(/«Club Dormido» \(inactivo\)/);
  });

  it("un club ELIMINADO lógicamente libera la sigla", async () => {
    const c = await clubsService.createClub(datos("DEL"), ACTOR);
    await prisma.club.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
    const nuevo = await clubsService.createClub(datos("DEL"), ACTOR);
    expect(nuevo.code).toBe("DEL");
  });
});

describe("al editar", () => {
  it("rechaza tomar la sigla de otro club, también de uno inactivo, y sin distinguir mayúsculas", async () => {
    const a = await clubsService.createClub(datos("AAA"), ACTOR);
    const b = await clubsService.createClub(datos("BBB"), ACTOR);
    await expect(clubsService.updateClub(b.id, edicion("aaa"), ACTOR)).rejects.toThrow(/ya está en uso/);
    await prisma.club.update({ where: { id: a.id }, data: { status: "disabled" } });
    await expect(clubsService.updateClub(b.id, edicion("AAA"), ACTOR)).rejects.toThrow(/\(inactivo\)/);
    expect((await prisma.club.findUniqueOrThrow({ where: { id: b.id } })).code).toBe("BBB");
  });

  it("guardar el club sin cambiar la sigla, o cambiando solo sus mayúsculas, no choca consigo mismo", async () => {
    const a = await clubsService.createClub(datos("AAA"), ACTOR);
    await clubsService.updateClub(a.id, edicion("AAA"), ACTOR);
    await clubsService.updateClub(a.id, edicion("aaa"), ACTOR);
    expect((await prisma.club.findUniqueOrThrow({ where: { id: a.id } })).code).toBe("AAA");
  });

  it("una sigla liberada se puede tomar", async () => {
    const a = await clubsService.createClub(datos("AAA"), ACTOR);
    const b = await clubsService.createClub(datos("BBB"), ACTOR);
    await clubsService.updateClub(a.id, edicion("CCC"), ACTOR);
    await clubsService.updateClub(b.id, edicion("AAA"), ACTOR);
    expect((await prisma.club.findUniqueOrThrow({ where: { id: b.id } })).code).toBe("AAA");
  });
});

describe("la restricción de la base es la garantía final", () => {
  const conflicto = /clubs_code_unique_active|Unique constraint/i;

  it("impide el duplicado por SQL/Prisma directo: mayúsculas, espacios, tabuladores y otros blancos", async () => {
    await crearClubDePrueba("Uno", "ABC", "club_uno");
    for (const [i, variante] of ["ABC", "abc", " abc ", "\tABC\n", " abc　", "﻿AbC"].entries()) {
      await expect(crearClubDePrueba(`Dup ${i}`, variante, `club_dup${i}`), JSON.stringify(variante)).rejects.toThrow(conflicto);
    }
  });

  it("incluye a los inactivos, excluye a los eliminados, y restaurar un eliminado no puede crear un duplicado", async () => {
    const a = await crearClubDePrueba("Uno", "ABC", "club_uno");
    await prisma.club.update({ where: { id: a.id }, data: { status: "locked" } });
    await expect(crearClubDePrueba("Dos", "ABC", "club_dos")).rejects.toThrow(conflicto);

    await prisma.club.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
    await crearClubDePrueba("Dos", "ABC", "club_dos");
    await expect(prisma.club.update({ where: { id: a.id }, data: { deletedAt: null } })).rejects.toThrow(conflicto);
  });

  it("el error se traduce a un 409 con el mensaje de la sigla", async () => {
    await crearClubDePrueba("Uno", "ABC", "club_uno");
    const err = await crearClubDePrueba("Dos", "abc", "club_dos").catch((e: unknown) => e);
    const traducido = translatePrismaError(err);
    expect(traducido).toBeInstanceOf(ConflictError);
    expect(traducido?.message).toMatch(/Esa sigla ya está en uso por otro club/);
  });

  it("normalización de la aplicación = normalización de la base", async () => {
    for (const v of ["abc", " aBc ", "\tabc\r\n", " abc ", "﻿abc　", "ñandú"]) {
      const [fila] = await prisma.$queryRaw<{ n: string }[]>`SELECT club_code_normalizado(${v}) AS n`;
      expect(fila!.n, JSON.stringify(v)).toBe(normalizarSigla(v));
    }
  });
});

describe("concurrencia: dos operaciones que reclaman la misma sigla", () => {
  it("dos ALTAS simultáneas: gana una; la otra recibe 409 con el mensaje de la sigla", async () => {
    for (let ronda = 0; ronda < 4; ronda++) {
      const sigla = `CO${ronda}`;
      const r = await Promise.allSettled([clubsService.createClub(datos(sigla), ACTOR), clubsService.createClub(datos(sigla.toLowerCase()), ACTOR)]);
      expect(r.filter((x) => x.status === "fulfilled"), `ronda ${ronda}`).toHaveLength(1);
      const rechazo = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
      const motivo = translatePrismaError(rechazo.reason) ?? rechazo.reason;
      expect(motivo.message).toMatch(/sigla/i);
      expect(await prisma.club.count({ where: { code: sigla } })).toBe(1);
    }
  });

  it("ALTA y EDICIÓN simultáneas sobre la misma sigla: una sola la obtiene", async () => {
    for (let ronda = 0; ronda < 4; ronda++) {
      const sigla = `ED${ronda}`;
      const otro = await clubsService.createClub(datos(`OT${ronda}`), ACTOR);
      await Promise.allSettled([clubsService.createClub(datos(sigla), ACTOR), clubsService.updateClub(otro.id, edicion(sigla), ACTOR)]);
      expect(await prisma.club.count({ where: { code: sigla, deletedAt: null } }), `ronda ${ronda}`).toBe(1);
    }
  });
});
