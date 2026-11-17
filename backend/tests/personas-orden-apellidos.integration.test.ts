/**
 * Listado de Personas ordenado por apellidos en el SERVIDOR, antes de paginar (`orden=apellidos` y
 * `apellidos_desc`), y componentes del nombre en el plantel ordenado. Por HTTP contra la base
 * DESECHABLE. Datos SINTÉTICOS.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { fechaCalendarioAUtc } from "../src/shared/fecha.util";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createUser, TEST_PASSWORD } from "./helpers/seedRbac";
import { runValido } from "./helpers/run";

let app: FastifyInstance;
let tokenAdmin = "";
let tokenClub = "";
let clubId = "";
let cuerpo = 50_000_000;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
async function login(username: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login ${username}: ${res.statusCode}`);
  return res.json().accessToken as string;
}
const persona = (p: {
  firstName?: string | null;
  paternalLastName?: string | null;
  maternalLastName?: string | null;
  fullName: string;
  status?: "active" | "locked";
  deleted?: boolean;
  run?: string;
}) =>
  prisma.person.create({
    data: {
      run: p.run ?? runValido(++cuerpo),
      firstName: p.firstName ?? null,
      paternalLastName: p.paternalLastName ?? null,
      maternalLastName: p.maternalLastName ?? null,
      fullName: p.fullName,
      birthDate: new Date("1980-02-02T00:00:00Z"),
      gender: "male",
      status: p.status ?? "active",
      deletedAt: p.deleted ? new Date() : null,
    },
  });

/** Orden esperado (nombre completo almacenado), por apellido paterno, materno y nombres. */
const ESPERADO: string[] = [];

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();
  const admin = await createUser({ username: "admin_orden", roleNames: ["admin"] });
  clubId = (await createClub("Club Orden", "ORD", "club_orden")).id;
  await createUser({ username: "club_orden", roleNames: ["club"], clubId });

  // 22 personas «Zeta» (más que una página de 20), insertadas al revés.
  for (let i = 21; i >= 0; i--) {
    const n = String(i).padStart(2, "0");
    await persona({ firstName: `Nombre${n}`, paternalLastName: "Zeta", maternalLastName: "Prueba", fullName: `Nombre${n} Zeta Prueba` });
  }
  await persona({ fullName: "Antiguo Sin Campos" }); // histórico: al final
  await persona({
    firstName: "Juan",
    paternalLastName: "Pérez",
    maternalLastName: "Rojas",
    fullName: "Juan Pérez Rojas B",
    run: runValido(20_000_002),
  });
  await persona({ firstName: "Ana María", paternalLastName: "de la Fuente", maternalLastName: null, fullName: "Ana María de la Fuente" });
  await persona({
    firstName: "Juan",
    paternalLastName: "Perez",
    maternalLastName: "Rojas",
    fullName: "Juan Perez Rojas A",
    run: runValido(20_000_001),
  });
  await persona({ firstName: "Iñaki", paternalLastName: "Ñuñez", maternalLastName: "Ábalos", fullName: "Iñaki Ñuñez Ábalos" });
  await persona({ firstName: "Eliminada", paternalLastName: "Aaaa", fullName: "Eliminada Aaaa", deleted: true });
  const bloqueada = await persona({ firstName: "Bloqueada", paternalLastName: "Bbbb", fullName: "Bloqueada Bbbb", status: "locked" });
  ESPERADO.push(
    "Bloqueada Bbbb",
    "Ana María de la Fuente",
    "Iñaki Ñuñez Ábalos",
    "Juan Perez Rojas A",
    "Juan Pérez Rojas B",
    ...Array.from({ length: 22 }, (_, i) => `Nombre${String(i).padStart(2, "0")} Zeta Prueba`),
    "Antiguo Sin Campos"
  );

  // Plantel: una membresía activa con componentes, para el listado de Editar Club.
  await prisma.clubSwimmer.create({
    data: {
      clubId,
      personId: bloqueada.id,
      status: "active",
      requestedByUserId: admin.id,
      reviewedByUserId: admin.id,
      reviewedAt: new Date(),
      startDate: fechaCalendarioAUtc("2025-01-01"),
    },
  });

  tokenAdmin = await login("admin_orden");
  tokenClub = await login("club_orden");
});

afterAll(async () => {
  await app?.close();
});

const pagina = (orden: string, page: number, extra = "") =>
  app.inject({ method: "GET", url: `/persons?orden=${orden}&page=${page}&pageSize=20${extra}`, headers: auth(tokenAdmin) });
const nombres = (res: { json: () => { items: { fullName: string }[] } }) => res.json().items.map((p) => p.fullName);

describe("GET /persons con orden por apellidos", () => {
  it("ascendente sobre el conjunto completo, antes de paginar; sin eliminadas; homónimos, tildes, Ñ y compuestos", async () => {
    const p1 = await pagina("apellidos", 1);
    const p2 = await pagina("apellidos", 2);
    expect(p1.statusCode).toBe(200);
    expect(p1.json().total).toBe(28);
    expect([...nombres(p1), ...nombres(p2)]).toEqual(ESPERADO);
  });

  it("descendente: el orden completo invertido, también entre páginas", async () => {
    const p1 = await pagina("apellidos_desc", 1);
    const p2 = await pagina("apellidos_desc", 2);
    expect([...nombres(p1), ...nombres(p2)]).toEqual([...ESPERADO].reverse());
  });

  it("conserva la búsqueda y los filtros", async () => {
    expect(nombres(await pagina("apellidos", 1, "&search=Rojas"))).toEqual(["Juan Perez Rojas A", "Juan Pérez Rojas B"]);
    const bloqueadas = await pagina("apellidos", 1, "&status=locked");
    expect(nombres(bloqueadas)).toEqual(["Bloqueada Bbbb"]);
    expect(bloqueadas.json().total).toBe(1);
  });

  it("sin `orden` el listado sigue como antes (por nombre completo almacenado)", async () => {
    const res = await app.inject({ method: "GET", url: "/persons?page=1&pageSize=3", headers: auth(tokenAdmin) });
    expect(nombres(res)).toEqual(["Ana María de la Fuente", "Antiguo Sin Campos", "Bloqueada Bbbb"]);
  });

  it("rechaza un orden desconocido y conserva el acceso: la cuenta del club no lista personas", async () => {
    expect((await pagina("nombre", 1)).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/persons?orden=apellidos", headers: auth(tokenClub) })).statusCode).toBe(403);
  });

  it("no altera los datos almacenados", async () => {
    const p = await prisma.person.findFirstOrThrow({ where: { fullName: "Iñaki Ñuñez Ábalos" } });
    expect([p.firstName, p.paternalLastName, p.maternalLastName]).toEqual(["Iñaki", "Ñuñez", "Ábalos"]);
    expect(p.run).toMatch(/^\d{7,8}[0-9K]$/);
  });
});

describe("Plantel ordenado: componentes del nombre", () => {
  it("cada membresía trae nombres y apellidos separados además del nombre completo y el RUN", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/swimmer-assignments?clubId=${clubId}&status=active&orden=apellidos&page=1&pageSize=20`,
      headers: auth(tokenAdmin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].person).toMatchObject({
      fullName: "Bloqueada Bbbb",
      firstName: "Bloqueada",
      paternalLastName: "Bbbb",
      maternalLastName: null,
    });
  });
});
