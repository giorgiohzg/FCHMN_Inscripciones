/**
 * Asignación de Nadadores a Clubes: listado ordenado por apellidos en el SERVIDOR, antes de paginar
 * (`orden=nadador` y `nadador_desc`), sobre el MISMO conjunto que sin `orden` (también las
 * membresías de personas eliminadas), y lista de la asignación masiva por apellidos. Por HTTP contra
 * la base DESECHABLE. Datos SINTÉTICOS.
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
let clubUno = "";
let clubDos = "";
let adminId = "";
let cuerpo = 60_000_000;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
async function login(username: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login ${username}: ${res.statusCode}`);
  return res.json().accessToken as string;
}
const persona = (p: { firstName?: string | null; paternalLastName?: string | null; maternalLastName?: string | null; fullName: string; deleted?: boolean; run?: string }) =>
  prisma.person.create({
    data: {
      run: p.run ?? runValido(++cuerpo),
      firstName: p.firstName ?? null,
      paternalLastName: p.paternalLastName ?? null,
      maternalLastName: p.maternalLastName ?? null,
      fullName: p.fullName,
      birthDate: new Date("1980-02-02T00:00:00Z"),
      gender: "male",
      status: "active",
      deletedAt: p.deleted ? new Date() : null,
    },
  });
const membresia = (clubId: string, personId: string, status: "active" | "pending" | "ended" = "active") =>
  prisma.clubSwimmer.create({
    data: {
      clubId,
      personId,
      status,
      requestedByUserId: adminId,
      reviewedByUserId: status === "pending" ? null : adminId,
      reviewedAt: status === "pending" ? null : new Date(),
      startDate: status === "pending" ? null : fechaCalendarioAUtc("2024-01-01"),
      endDate: status === "ended" ? new Date() : null,
      fechaTermino: status === "ended" ? fechaCalendarioAUtc("2024-12-31") : null,
    },
  });

/** Orden esperado de las membresías del club Uno (nombre completo almacenado). */
const ESPERADO_UNO: string[] = [];
/** Id de la persona con dos membresías (una en cada club). */
let dosMembresiasId = "";
let sinClubRojasId = "";

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();
  adminId = (await createUser({ username: "admin_asig", roleNames: ["admin"] })).id;
  clubUno = (await createClub("Club Uno", "UNO", "club_uno")).id;
  clubDos = (await createClub("Club Dos", "DOS", "club_dos")).id;
  await createUser({ username: "club_uno", roleNames: ["club"], clubId: clubUno });

  // 22 personas «Zeta» activas en el club Uno (más que una página de 20), insertadas al revés.
  for (let i = 21; i >= 0; i--) {
    const n = String(i).padStart(2, "0");
    const p = await persona({ firstName: `Nombre${n}`, paternalLastName: "Zeta", maternalLastName: "Prueba", fullName: `Nombre${n} Zeta Prueba` });
    await membresia(clubUno, p.id);
  }
  const casos = [
    await persona({ fullName: "Antiguo Sin Campos" }), // histórico: al final
    await persona({ firstName: "Juan", paternalLastName: "Pérez", maternalLastName: "Rojas", fullName: "Juan Pérez Rojas B", run: runValido(30_000_002) }),
    await persona({ firstName: "Ana María", paternalLastName: "de la Fuente", maternalLastName: null, fullName: "Ana María de la Fuente" }),
    await persona({ firstName: "Juan", paternalLastName: "Perez", maternalLastName: "Rojas", fullName: "Juan Perez Rojas A", run: runValido(30_000_001) }),
    await persona({ firstName: "Iñaki", paternalLastName: "Ñuñez", maternalLastName: "Ábalos", fullName: "Iñaki Ñuñez Ábalos" }),
    // Eliminada con membresía activa: el listado de Asignación la sigue mostrando; el plantel, no.
    await persona({ firstName: "Eliminada", paternalLastName: "Aaaa", fullName: "Eliminada Aaaa", deleted: true }),
  ];
  for (const p of casos) await membresia(clubUno, p.id);
  // Una persona con dos membresías: finalizada en Dos y activa en Uno.
  const dos = await persona({ firstName: "Doble", paternalLastName: "Bbbb", maternalLastName: "Ccc", fullName: "Doble Bbbb Ccc" });
  dosMembresiasId = dos.id;
  await membresia(clubDos, dos.id, "ended");
  await membresia(clubUno, dos.id);
  // Una propuesta pendiente en Dos y personas sin club para la asignación masiva.
  const pendiente = await persona({ firstName: "Pendiente", paternalLastName: "Mmmm", fullName: "Pendiente Mmmm" });
  await membresia(clubDos, pendiente.id, "pending");
  sinClubRojasId = (await persona({ firstName: "Carla", paternalLastName: "Rojas", maternalLastName: "Ávila", fullName: "Carla Rojas Ávila" })).id;
  await persona({ firstName: "Beatriz", paternalLastName: "Álvarez", maternalLastName: null, fullName: "Beatriz Álvarez" });
  await persona({ fullName: "Sin Club Antiguo" });

  ESPERADO_UNO.push(
    "Eliminada Aaaa",
    "Doble Bbbb Ccc",
    "Ana María de la Fuente",
    "Iñaki Ñuñez Ábalos",
    "Juan Perez Rojas A",
    "Juan Pérez Rojas B",
    ...Array.from({ length: 22 }, (_, i) => `Nombre${String(i).padStart(2, "0")} Zeta Prueba`),
    "Antiguo Sin Campos"
  );

  tokenAdmin = await login("admin_asig");
  tokenClub = await login("club_uno");
});

afterAll(async () => {
  await app?.close();
});

type Fila = { id: string; clubId: string; status: string; person: { id: string; fullName: string; firstName: string | null; paternalLastName: string | null; maternalLastName: string | null } };
const listado = (qs: string, token = tokenAdmin) => app.inject({ method: "GET", url: `/swimmer-assignments?${qs}`, headers: auth(token) });
const filas = (res: { json: () => { items: Fila[] } }) => res.json().items;
const nombres = (res: { json: () => { items: Fila[] } }) => filas(res).map((f) => f.person.fullName);
async function todas(qs: string, token = tokenAdmin): Promise<Fila[]> {
  const res: Fila[] = [];
  for (let page = 1; ; page++) {
    const r = await listado(`${qs}&page=${page}&pageSize=20`, token);
    expect(r.statusCode).toBe(200);
    res.push(...filas(r));
    if (page * 20 >= r.json().total) return res;
  }
}

describe("GET /swimmer-assignments con orden por nadador", () => {
  it("ascendente sobre el conjunto filtrado completo, antes de paginar; homónimos, tildes, Ñ, compuestos e históricos al final", async () => {
    const p1 = await listado(`clubId=${clubUno}&orden=nadador&page=1&pageSize=20`);
    const p2 = await listado(`clubId=${clubUno}&orden=nadador&page=2&pageSize=20`);
    expect(p1.statusCode).toBe(200);
    expect(p1.json().total).toBe(ESPERADO_UNO.length);
    expect([...nombres(p1), ...nombres(p2)]).toEqual(ESPERADO_UNO);
  });

  it("descendente: el orden completo invertido, también entre páginas", async () => {
    const p1 = await listado(`clubId=${clubUno}&orden=nadador_desc&page=1&pageSize=20`);
    const p2 = await listado(`clubId=${clubUno}&orden=nadador_desc&page=2&pageSize=20`);
    expect([...nombres(p1), ...nombres(p2)]).toEqual([...ESPERADO_UNO].reverse());
  });

  it("mismo conjunto que sin `orden` (incluidas personas eliminadas) en cada filtro de estado", async () => {
    for (const status of ["", "&status=active", "&status=pending", "&status=ended"]) {
      const conOrden = await todas(`orden=nadador${status}`);
      const sinOrden = await todas(`x=1${status}`);
      expect(conOrden.map((f) => f.id).sort(), `estado ${status || "todas"}`).toEqual(sinOrden.map((f) => f.id).sort());
    }
    expect((await todas("orden=nadador&status=pending")).map((f) => f.person.fullName)).toEqual(["Pendiente Mmmm"]);
    expect((await todas("orden=nadador&status=ended")).map((f) => f.person.fullName)).toEqual(["Doble Bbbb Ccc"]);
  });

  it("desempate estable: las dos membresías de una persona quedan juntas, por id, en ambos sentidos", async () => {
    const asc = (await todas("orden=nadador")).filter((f) => f.person.id === dosMembresiasId).map((f) => f.id);
    const desc = (await todas("orden=nadador_desc")).filter((f) => f.person.id === dosMembresiasId).map((f) => f.id);
    expect(asc).toHaveLength(2);
    expect(asc).toEqual([...asc].sort());
    expect(desc).toEqual([...asc].reverse());
    const lista = (await todas("orden=nadador")).map((f) => f.person.id);
    const i = lista.indexOf(dosMembresiasId);
    expect(lista[i + 1]).toBe(dosMembresiasId);
  });

  it("cada fila trae los componentes del nombre", async () => {
    const res = await listado(`clubId=${clubUno}&orden=nadador&page=1&pageSize=20`);
    expect(filas(res)[3]!.person).toMatchObject({ fullName: "Iñaki Ñuñez Ábalos", firstName: "Iñaki", paternalLastName: "Ñuñez", maternalLastName: "Ábalos" });
  });

  it("sin `orden` sigue como antes (más recientes primero) y `apellidos` sigue excluyendo eliminadas", async () => {
    const reciente = await prisma.clubSwimmer.findFirstOrThrow({ orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    expect(filas(await listado("page=1&pageSize=1"))[0]!.id).toBe(reciente.id);
    const plantel = await todas(`clubId=${clubUno}&status=active&orden=apellidos`);
    expect(plantel.map((f) => f.person.fullName)).not.toContain("Eliminada Aaaa");
    expect(plantel).toHaveLength(ESPERADO_UNO.length - 1);
  });

  it("conserva el alcance: la cuenta del club solo ve su club, aunque pida otro; un orden desconocido se rechaza", async () => {
    const propias = await todas(`orden=nadador&clubId=${clubDos}`, tokenClub);
    expect(propias.every((f) => f.clubId === clubUno)).toBe(true);
    expect(propias.map((f) => f.person.fullName)).toEqual(ESPERADO_UNO);
    expect((await listado("orden=nombre")).statusCode).toBe(400);
  });
});

describe("GET /swimmer-assignments/swimmers-by-club por apellidos", () => {
  const masiva = (qs: string, token = tokenAdmin) => app.inject({ method: "GET", url: `/swimmer-assignments/swimmers-by-club?${qs}`, headers: auth(token) });

  it("«Sin club»: lista completa por apellido paterno, materno y nombres, con los componentes; históricos al final", async () => {
    const res = await masiva("clubFilter=none");
    expect(res.statusCode).toBe(200);
    // Quien solo tiene una propuesta pendiente no tiene membresía activa: también es «sin club».
    expect(res.json().map((p: { fullName: string }) => p.fullName)).toEqual(["Beatriz Álvarez", "Pendiente Mmmm", "Carla Rojas Ávila", "Sin Club Antiguo"]);
    expect(res.json()[2]).toMatchObject({ id: sinClubRojasId, firstName: "Carla", paternalLastName: "Rojas", maternalLastName: "Ávila" });
  });

  it("filtro por club y búsqueda se conservan", async () => {
    const club = await masiva(`clubFilter=${clubUno}`);
    // Sin la eliminada (como antes) y por apellidos.
    expect(club.json().map((p: { fullName: string }) => p.fullName)).toEqual(ESPERADO_UNO.filter((n) => n !== "Eliminada Aaaa"));
    const busqueda = await masiva(`clubFilter=${clubUno}&search=Rojas`);
    expect(busqueda.json().map((p: { fullName: string }) => p.fullName)).toEqual(["Juan Perez Rojas A", "Juan Pérez Rojas B"]);
  });

  it("sigue siendo exclusiva de administración", async () => {
    expect((await masiva("clubFilter=none", tokenClub)).statusCode).toBe(403);
  });

  it("no altera los datos almacenados", async () => {
    const p = await prisma.person.findFirstOrThrow({ where: { fullName: "Iñaki Ñuñez Ábalos" } });
    expect([p.firstName, p.paternalLastName, p.maternalLastName]).toEqual(["Iñaki", "Ñuñez", "Ábalos"]);
    expect(p.run).toMatch(/^\d{7,8}[0-9K]$/);
  });
});
