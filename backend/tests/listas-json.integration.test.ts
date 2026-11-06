/**
 * SEC-01 contra la aplicación REAL y la base DESECHABLE: un rechazo por exceso de lista, de cuerpo o de
 * multipart no hace trabajo de negocio posterior.
 *
 * Cómo se distingue la autenticación/autorización del trabajo de negocio, sin tocar esos controles:
 *  - Se registra (modelo.acción) de cada consulta a Prisma con `prisma.$use`.
 *  - LÍNEA BASE: una petición autenticada que falla por una validación que YA existía (`personIds: []`,
 *    por ejemplo). Su registro es exactamente lo que cuestan la autenticación y la autorización.
 *  - Una petición rechazada por SEC-01 debe dejar un registro IDÉNTICO a esa línea base: ni una
 *    consulta más (ni a personas, ni a membresías, ni a pruebas, ni a la auditoría).
 *  - CONTROL DE SENSIBILIDAD: una petición que sí supera la validación deja consultas ADICIONALES, así
 *    que el instrumento las ve.
 *  - Con cuerpo mayor al límite el registro está VACÍO: ni siquiera se autenticó.
 *
 * Todo con datos sintéticos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, TEST_PASSWORD } from "./helpers/seedRbac";
import { cuerpoMultipart, CABECERA_MULTIPART, conPlazo, type ParteMultipart } from "./helpers/app-rutas";
import { LIMITES_CUERPO_JSON, LIMITES_LISTAS, LIMITES_MULTIPART_IMPORTACION } from "../src/shared/limites-listas";

let app: FastifyInstance;
let token = "";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const uuids = (cantidad: number) => Array.from({ length: cantidad }, (_, i) => uuid(i + 1));
const auth = { get authorization() { return `Bearer ${token}`; } };

// ---- Registro de consultas -------------------------------------------------------------------------------
const registro: string[] = [];
let grabando = false;
prisma.$use(async (params, next) => {
  if (grabando) registro.push(`${params.model ?? "raw"}.${params.action}`);
  return next(params);
});

async function observar<T>(accion: () => Promise<T>): Promise<{ res: T; consultas: string[] }> {
  registro.length = 0;
  grabando = true;
  try {
    const res = await conPlazo(accion());
    return { res, consultas: [...registro].sort() };
  } finally {
    grabando = false;
  }
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  await truncateAllTables(prisma as unknown as Parameters<typeof truncateAllTables>[0]);
  await seedRolesAndPermissions();
  await createUser({ username: "admin_listas", roleNames: ["admin"] });
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin_listas", password: TEST_PASSWORD } });
  if (login.statusCode !== 200) throw new Error(`login falló: ${login.statusCode} ${login.body}`);
  token = login.json().accessToken;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

// ---- Rutas JSON ------------------------------------------------------------------------------------------
interface RutaJson {
  nombre: string;
  metodo: "POST" | "PUT";
  url: string;
  /** Falla por una validación que ya existía antes de SEC-01. */
  baseline: unknown;
  /** Supera el tope de la lista. */
  exceso: unknown;
  /** Pasa la validación y llega al servicio (a un recurso inexistente). */
  control: unknown;
  limiteDelCuerpo: number;
}

const RUTAS: RutaJson[] = [
  {
    nombre: "crear inscripción de relevo",
    metodo: "POST",
    url: "/relay-registrations",
    baseline: { competitionEventId: uuid(900), clubId: uuid(901), personIds: [] },
    exceso: { competitionEventId: uuid(900), clubId: uuid(901), personIds: uuids(LIMITES_LISTAS.integrantesDeRelevo + 1) },
    control: { competitionEventId: uuid(900), clubId: uuid(901), personIds: uuids(4) },
    limiteDelCuerpo: LIMITES_CUERPO_JSON.relevos,
  },
  {
    nombre: "editar inscripción de relevo",
    metodo: "PUT",
    url: `/relay-registrations/${uuid(800)}`,
    baseline: { personIds: [] },
    exceso: { personIds: uuids(LIMITES_LISTAS.integrantesDeRelevo + 1) },
    control: { personIds: uuids(4) },
    limiteDelCuerpo: LIMITES_CUERPO_JSON.relevos,
  },
  {
    nombre: "asignación masiva",
    metodo: "POST",
    url: "/swimmer-assignments/bulk-assign",
    baseline: { targetClubId: uuid(900), personIds: [] },
    exceso: { targetClubId: uuid(900), personIds: uuids(LIMITES_LISTAS.asignacionMasiva + 1) },
    control: { targetClubId: uuid(900), personIds: uuids(2) },
    limiteDelCuerpo: LIMITES_CUERPO_JSON.asignacionMasiva,
  },
  {
    nombre: "crear club",
    metodo: "POST",
    url: "/clubs",
    baseline: {},
    exceso: { name: "Club Sintético", code: "SINT", hasLegalStatus: false, delegatePersonIds: uuids(LIMITES_LISTAS.delegadosPorClub + 1) },
    control: { name: "Club Sintético", code: "SINT", hasLegalStatus: false, delegatePersonIds: uuids(2) },
    limiteDelCuerpo: LIMITES_CUERPO_JSON.clubes,
  },
  {
    nombre: "editar club (entrenadores)",
    metodo: "PUT",
    url: `/clubs/${uuid(800)}`,
    baseline: {},
    exceso: { hasLegalStatus: false, coachPersonIds: uuids(LIMITES_LISTAS.entrenadoresPorClub + 1) },
    control: { hasLegalStatus: false, coachPersonIds: uuids(2) },
    limiteDelCuerpo: LIMITES_CUERPO_JSON.clubes,
  },
  {
    nombre: "agregar prueba a la competencia",
    metodo: "POST",
    url: `/competitions/${uuid(800)}/events`,
    baseline: { eventId: uuid(900), competitionSessionId: uuid(901), categoryIds: [] },
    exceso: { eventId: uuid(900), competitionSessionId: uuid(901), categoryIds: uuids(LIMITES_LISTAS.categoriasPorPrueba + 1) },
    control: { eventId: uuid(900), competitionSessionId: uuid(901), categoryIds: uuids(2) },
    limiteDelCuerpo: LIMITES_CUERPO_JSON.categoriasPorPrueba,
  },
  {
    nombre: "editar prueba de la competencia",
    metodo: "PUT",
    url: `/competition-events/${uuid(800)}`,
    baseline: { categoryIds: [] },
    exceso: { categoryIds: uuids(LIMITES_LISTAS.categoriasPorPrueba + 1) },
    control: { categoryIds: uuids(2) },
    limiteDelCuerpo: LIMITES_CUERPO_JSON.categoriasPorPrueba,
  },
  {
    nombre: "reordenar pruebas",
    metodo: "PUT",
    url: "/competition-events/reorder",
    baseline: { updates: [] },
    exceso: { updates: Array.from({ length: LIMITES_LISTAS.reordenamientos + 1 }, (_, i) => ({ id: uuid(i + 1), displayOrder: i + 1 })) },
    control: { updates: [{ id: uuid(1), displayOrder: 1 }] },
    limiteDelCuerpo: LIMITES_CUERPO_JSON.reordenamientos,
  },
];

const enviarJson = (ruta: RutaJson, cuerpo: unknown, conToken = true) =>
  app.inject({ method: ruta.metodo, url: ruta.url, headers: { "content-type": "application/json", ...(conToken ? auth : {}) }, payload: JSON.stringify(cuerpo) });

describe.each(RUTAS)("$metodo $url ($nombre)", (ruta) => {
  it("la línea base (validación previa) solo cuesta autenticación y autorización", async () => {
    const { res, consultas } = await observar(() => enviarJson(ruta, ruta.baseline));

    expect(res.statusCode).toBe(400);
    expect(consultas.length).toBeGreaterThan(0); // la autenticación sí consulta
    expect(consultas.every((c) => /^(RefreshSession|User|UserRole|ClubStaff|Role|Permission|RolePermission)\./.test(c))).toBe(true);
  });

  it("el exceso de lista deja EXACTAMENTE las mismas consultas que la línea base (cero trabajo de negocio)", async () => {
    const base = await observar(() => enviarJson(ruta, ruta.baseline));
    const exceso = await observar(() => enviarJson(ruta, ruta.exceso));

    expect(exceso.res.statusCode).toBe(400);
    expect(exceso.res.json().error).toBe("VALIDATION_ERROR");
    expect(exceso.consultas).toEqual(base.consultas);
  });

  it("CONTROL DE SENSIBILIDAD: una petición válida sí deja consultas de negocio adicionales", async () => {
    const base = await observar(() => enviarJson(ruta, ruta.baseline));
    const control = await observar(() => enviarJson(ruta, ruta.control));

    expect(control.res.statusCode).toBeGreaterThanOrEqual(400); // el recurso no existe
    expect(control.consultas.length).toBeGreaterThan(base.consultas.length);
  });

  it("un cuerpo mayor al límite recibe 413 SIN autenticarse: ni una consulta", async () => {
    const payload = JSON.stringify({ relleno: "a".repeat(ruta.limiteDelCuerpo + 1) });

    const { res, consultas } = await observar(() => app.inject({ method: ruta.metodo, url: ruta.url, headers: { "content-type": "application/json", ...auth }, payload }));

    expect(res.statusCode).toBe(413);
    expect(res.body.length).toBeLessThan(400);
    expect(consultas).toEqual([]);
  });

  it("sin token: un cuerpo pequeño recibe 401; uno mayor al límite, 413 (el tamaño se comprueba antes)", async () => {
    const chico = await enviarJson(ruta, ruta.baseline, false);
    const grande = await app.inject({
      method: ruta.metodo,
      url: ruta.url,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ relleno: "a".repeat(ruta.limiteDelCuerpo + 1) }),
    });

    expect(chico.statusCode).toBe(401);
    expect(grande.statusCode).toBe(413);
  });
});

// ---- Multipart de analizar e importar Meet Events -----------------------------------------------------------
const FASES = [
  { nombre: "analizar", url: "/competitions/import-meet-events/analyze" },
  { nombre: "importar", url: "/competitions/import-meet-events" },
] as const;

const archivo: ParteMultipart = { nombre: "file", archivo: "programa.ev3", valor: "contenido sintético" };
const maximo: ParteMultipart = { nombre: "maxIndividualEventsPerSwimmer", valor: "2" };
const HUELLA = "a".repeat(64);

const enviarMultipart = (url: string, partes: ParteMultipart[]) =>
  app.inject({ method: "POST", url, headers: { ...CABECERA_MULTIPART, ...auth }, payload: cuerpoMultipart(partes) });

describe.each(FASES)("multipart · $nombre", (fase) => {
  /** Línea base: falla por validación previa, ya autenticada y autorizada y antes de llamar al servicio. */
  const baseline = (): ParteMultipart[] => (fase.nombre === "analizar" ? [maximo] : [archivo]); // sin archivo / sin máximo → 400

  const CASOS: Array<[string, ParteMultipart[], number, string]> = [
    ["campo truncado cuyo fragmento sigue siendo JSON válido", [archivo, maximo, { nombre: "relayDecisions", valor: JSON.stringify({ fileHash: HUELLA, decisiones: [] }) + " ".repeat(LIMITES_MULTIPART_IMPORTACION.fieldSize + 10) }], 413, "PAYLOAD_TOO_LARGE"],
    ["campo desconocido truncado", [archivo, maximo, { nombre: "otro", valor: "x".repeat(LIMITES_MULTIPART_IMPORTACION.fieldSize + 1) }], 413, "PAYLOAD_TOO_LARGE"],
    ["nombre de campo de más de 64 caracteres", [archivo, maximo, { nombre: "n".repeat(65), valor: "1" }], 413, "PAYLOAD_TOO_LARGE"],
    ["cinco campos", [archivo, maximo, { nombre: "a", valor: "1" }, { nombre: "b", valor: "2" }, { nombre: "c", valor: "3" }, { nombre: "d", valor: "4" }], 413, "FST_FIELDS_LIMIT"],
    ["dos archivos", [archivo, maximo, { nombre: "file", archivo: "otro.ev3", valor: "otro" }], 413, "FST_FILES_LIMIT"],
    ["archivo con un nombre de campo distinto de «file»", [{ nombre: "adjunto", archivo: "programa.ev3", valor: "x".repeat(100_000) }, maximo], 400, "VALIDATION_ERROR"],
    ["más de seis partes", [archivo, maximo, ...Array.from({ length: 6 }, () => ({}))], 413, "FST_PARTS_LIMIT"],
  ];

  it("la línea base (validación previa) solo cuesta autenticación y autorización", async () => {
    const { res, consultas } = await observar(() => enviarMultipart(fase.url, baseline()));

    expect(res.statusCode).toBe(400);
    expect(consultas.length).toBeGreaterThan(0);
    expect(consultas.every((c) => /^(RefreshSession|User|UserRole|ClubStaff|Role|Permission|RolePermission)\./.test(c))).toBe(true);
  });

  it.each(CASOS)("%s: rechazo %i %s, termina y deja las mismas consultas que la línea base", async (_nombre, partes, estado, codigo) => {
    const base = await observar(() => enviarMultipart(fase.url, baseline()));
    const rechazo = await observar(() => enviarMultipart(fase.url, partes));

    expect(rechazo.res.statusCode).toBe(estado);
    expect(rechazo.res.json().error).toBe(codigo);
    expect(rechazo.res.body.length).toBeLessThan(500);
    expect(rechazo.consultas).toEqual(base.consultas);
  });

  it("CONTROL DE SENSIBILIDAD: un archivo ilegible que SÍ llega al servicio deja consultas adicionales", async () => {
    const base = await observar(() => enviarMultipart(fase.url, baseline()));
    const control = await observar(() => enviarMultipart(fase.url, [archivo, maximo]));

    expect(control.consultas.length).toBeGreaterThan(base.consultas.length);
  });
});
