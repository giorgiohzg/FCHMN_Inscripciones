/**
 * Las operaciones NUEVAS del 2026-10-31, probadas con usuarios SIN permiso.
 *
 * Cada cambio de este lote añadió o modificó una entrada a la API: el tercer
 * estado de la personalidad jurídica, el filtro del listado de clubes y la
 * fecha efectiva en los cuatro endpoints que activan una membresía. El ensayo de
 * carga las ejercitó todas con el administrador, que tiene todos los permisos:
 * eso demuestra que funcionan, **no** que estén protegidas.
 *
 * Se prueba por HTTP contra la aplicación real (`app.inject`), porque es la
 * única forma de comprobar lo que vería alguien llamando a la API por su cuenta.
 *
 * Los cuatro actores:
 *   - `admin`                  — tiene todo; es el control positivo.
 *   - `club`                   — tiene `swimmer-assignment:write`, NO `approve`,
 *                                y NO `clubs:write`.
 *   - `delegado`               — mismos permisos que el club (CLUB_STAFF_PERMISSIONS).
 *   - `nadador`                — no tiene ninguno de los dos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addClubStaff, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";

let app: FastifyInstance;
const tokens: Record<string, string> = {};
const ctx = { clubId: "", otroClubId: "", personaId: "", adminUserId: "", asignacionId: "" };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username} falló: ${res.statusCode} ${res.body}`);
  return res.json().accessToken;
}

const CLUB_NUEVO = {
  name: "CLUB RECIEN CREADO",
  code: "NUEVO",
  username: "club.nuevo",
  email: "nuevo@example.invalid",
  hasLegalStatus: null,
  isAchmnMember: false,
  isAchmnCollaborator: false,
  isFchmnMember: false,
  isFchmnCollaborator: false,
};

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  await truncateAllTables(prisma as unknown as Parameters<typeof truncateAllTables>[0]);
  await seedRolesAndPermissions();

  const club = await createClub("Club Uno", "CU", "club_uno");
  const otro = await createClub("Club Dos", "CD", "club_dos");
  ctx.clubId = club.id;
  ctx.otroClubId = otro.id;

  const admin = await createUser({ username: "admin_permisos", roleNames: ["admin"] });
  ctx.adminUserId = admin.id;
  await createUser({ username: "club_uno", roleNames: ["club"], clubId: club.id });

  const delegado = await createPerson({ run: "50000001", username: "deleg_uno", firstName: "Delia", gender: "female", roles: [] });
  await addClubStaff(club.id, delegado.id, "delegate");
  await createUser({ username: "deleg_uno", roleNames: ["delegate"], personId: delegado.id });

  const nadador = await createPerson({ run: "50000002", username: "nada_uno", firstName: "Nadia", gender: "female", roles: [] });
  await addActiveMembership(club.id, nadador.id, admin.id);
  await createUser({ username: "nada_uno", roleNames: ["swimmer"], personId: nadador.id });

  // Una persona libre, para intentar asignarla.
  const libre = await createPerson({ run: "50000003", username: "libre_uno", firstName: "Lucía", gender: "female", roles: [] });
  ctx.personaId = libre.id;

  // Una propuesta pendiente, para intentar aprobarla.
  const propuesta = await prisma.clubSwimmer.create({
    data: { clubId: otro.id, personId: libre.id, status: "pending", requestedByUserId: admin.id },
  });
  ctx.asignacionId = propuesta.id;

  for (const u of ["admin_permisos", "club_uno", "deleg_uno", "nada_uno"]) tokens[u] = await login(u);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** Los tres actores que NO deberían poder, con el nombre que sale en el informe. */
const SIN_PERMISO: [string, string][] = [
  ["club_uno", "la cuenta del club"],
  ["deleg_uno", "un delegado"],
  ["nada_uno", "un nadador"],
];

describe("crear un club con el tercer estado (POST /clubs — clubs:write)", () => {
  it.each(SIN_PERMISO)("%s (%s) recibe 403", async (usuario) => {
    const res = await app.inject({ method: "POST", url: "/clubs", headers: auth(tokens[usuario]!), payload: CLUB_NUEVO });
    expect(res.statusCode).toBe(403);
    // Y no se creó nada.
    expect(await prisma.club.count({ where: { code: "NUEVO" } })).toBe(0);
  });

  it("sin ningún token recibe 401", async () => {
    const res = await app.inject({ method: "POST", url: "/clubs", payload: CLUB_NUEVO });
    expect(res.statusCode).toBe(401);
  });

  it("el administrador sí puede, y el club queda PENDIENTE", async () => {
    const res = await app.inject({ method: "POST", url: "/clubs", headers: auth(tokens.admin_permisos!), payload: CLUB_NUEVO });
    expect(res.statusCode).toBe(201);
    expect(res.json().hasLegalStatus).toBeNull();
  });
});

describe("cambiar la personalidad jurídica (PUT /clubs/:id — clubs:write)", () => {
  const cambio = { hasLegalStatus: null, isAchmnMember: false, isAchmnCollaborator: false, isFchmnMember: false, isFchmnCollaborator: false };

  it.each(SIN_PERMISO)("%s (%s) recibe 403", async (usuario) => {
    const antes = await prisma.club.findUniqueOrThrow({ where: { id: ctx.clubId } });
    const res = await app.inject({ method: "PUT", url: `/clubs/${ctx.clubId}`, headers: auth(tokens[usuario]!), payload: cambio });
    expect(res.statusCode).toBe(403);
    // El estado no se movió.
    const despues = await prisma.club.findUniqueOrThrow({ where: { id: ctx.clubId } });
    expect(despues.hasLegalStatus).toBe(antes.hasLegalStatus);
  });

  it("ni siquiera sobre SU PROPIO club: el club no se edita a sí mismo", async () => {
    const res = await app.inject({ method: "PUT", url: `/clubs/${ctx.clubId}`, headers: auth(tokens.club_uno!), payload: cambio });
    expect(res.statusCode).toBe(403);
  });
});

describe("filtrar por personalidad jurídica (GET /clubs — clubs:read)", () => {
  it("un nadador no puede listar clubes", async () => {
    const res = await app.inject({ method: "GET", url: "/clubs?personalidadJuridica=pendiente", headers: auth(tokens.nada_uno!) });
    expect(res.statusCode).toBe(403);
  });

  /**
   * El club y el delegado SÍ tienen `clubs:read`, así que el filtro les
   * responde. Lo que se comprueba aquí es que **el alcance sigue aplicándose
   * por encima del filtro nuevo**: un parámetro de consulta no puede servir
   * para ver clubes ajenos.
   */
  it("el club puede filtrar, pero solo se ve a sí mismo", async () => {
    const res = await app.inject({ method: "GET", url: "/clubs?personalidadJuridica=pendiente", headers: auth(tokens.club_uno!) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((c: { id: string }) => c.id);
    expect(ids).toEqual([ctx.clubId]);
    expect(ids).not.toContain(ctx.otroClubId);
  });

  it("un valor inválido en el filtro se rechaza con 400, no se ignora", async () => {
    const res = await app.inject({ method: "GET", url: "/clubs?personalidadJuridica=quizas", headers: auth(tokens.admin_permisos!) });
    expect(res.statusCode).toBe(400);
  });
});

describe("fecha efectiva: asignación directa (POST /swimmer-assignments/direct — approve)", () => {
  const cuerpo = () => ({ clubId: ctx.clubId, personId: ctx.personaId, fechaEfectiva: "2026-10-30" });

  it.each(SIN_PERMISO)("%s (%s) recibe 403", async (usuario) => {
    const res = await app.inject({ method: "POST", url: "/swimmer-assignments/direct", headers: auth(tokens[usuario]!), payload: cuerpo() });
    expect(res.statusCode).toBe(403);
  });

  it("el club tiene `write` pero NO `approve`: no puede activar por su cuenta", async () => {
    const res = await app.inject({ method: "POST", url: "/swimmer-assignments/direct", headers: auth(tokens.club_uno!), payload: cuerpo() });
    expect(res.statusCode).toBe(403);
    // Nada quedó activo: la fecha efectiva no abre una puerta nueva.
    expect(await prisma.clubSwimmer.count({ where: { personId: ctx.personaId, status: "active" } })).toBe(0);
  });
});

describe("fecha efectiva: asignación masiva (POST /bulk-assign — approve)", () => {
  it.each(SIN_PERMISO)("%s (%s) recibe 403", async (usuario) => {
    const res = await app.inject({
      method: "POST",
      url: "/swimmer-assignments/bulk-assign",
      headers: auth(tokens[usuario]!),
      payload: { targetClubId: ctx.clubId, personIds: [ctx.personaId], fechaEfectiva: "2026-10-30" },
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.clubSwimmer.count({ where: { personId: ctx.personaId, status: "active" } })).toBe(0);
  });
});

describe("fecha efectiva: aprobación (POST /:id/approve — approve)", () => {
  it.each(SIN_PERMISO)("%s (%s) recibe 403", async (usuario) => {
    const res = await app.inject({
      method: "POST",
      url: `/swimmer-assignments/${ctx.asignacionId}/approve`,
      headers: auth(tokens[usuario]!),
      payload: { fechaEfectiva: "2026-10-30" },
    });
    expect(res.statusCode).toBe(403);
    const sinCambios = await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: ctx.asignacionId } });
    expect(sinCambios.status).toBe("pending");
    expect(sinCambios.startDate).toBeNull();
  });
});

describe("fecha efectiva: reasignación (POST /reassign/:personId — approve)", () => {
  it.each(SIN_PERMISO)("%s (%s) recibe 403", async (usuario) => {
    const res = await app.inject({
      method: "POST",
      url: `/swimmer-assignments/reassign/${ctx.personaId}`,
      headers: auth(tokens[usuario]!),
      payload: { newClubId: ctx.clubId, fechaEfectiva: "2026-10-30" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("la validación no se adelanta al permiso", () => {
  /**
   * Un 400 en vez de un 403 sería una fuga: diría que el cuerpo llegó a
   * validarse, y de paso qué forma espera la API, a alguien que no tiene
   * derecho a usarla.
   */
  it("con un cuerpo inválido, un usuario sin permiso sigue recibiendo 403 y no 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/swimmer-assignments/bulk-assign",
      headers: auth(tokens.nada_uno!),
      payload: { targetClubId: "no-es-un-uuid", personIds: [], fechaEfectiva: "30-10-2026" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("con permiso, ese mismo cuerpo inválido sí recibe 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/swimmer-assignments/bulk-assign",
      headers: auth(tokens.admin_permisos!),
      payload: { targetClubId: "no-es-un-uuid", personIds: [], fechaEfectiva: "30-10-2026" },
    });
    expect(res.statusCode).toBe(400);
  });
});
