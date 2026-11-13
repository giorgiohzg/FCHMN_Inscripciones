/**
 * C-05, fase 2: API de incorporaciones por RUN, contra los servicios y la API reales, sobre la
 * base DESECHABLE. Solo datos sintéticos.
 *
 * MÉTODO DE LOS SOLAPAMIENTOS (el de C-02), sin esperas arbitrarias ni ganchos en el código: una
 * conexión `pg` independiente RETIENE un bloqueo que la operación necesita (un bloqueo consultivo
 * del protocolo, o una fila), y cada espera se CONFIRMA en `pg_stat_activity` antes de seguir. Los
 * relojes se controlan pasando `ahora` a los servicios.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import {
  seedRolesAndPermissions,
  createClub,
  createPerson,
  createUser,
  addClubStaff,
  addActiveMembership,
  TEST_PASSWORD,
} from "./helpers/seedRbac";
import { runValido, conFormato } from "./helpers/run";
import * as postulacion from "../src/modules/incorporaciones/postulacion.service";
import * as periodos from "../src/modules/incorporaciones/periodos.service";
import * as altas from "../src/modules/incorporaciones/altas.service";
import * as asignacion from "../src/modules/swimmer-assignment/assignment.service";
import { AppError } from "../src/shared/errors";
import { hoyEnZonaDelNegocio } from "../src/shared/fecha.util";
import type { ActorContext } from "../src/shared/actorContext";

let app: FastifyInstance;
let observador: Client;
const conexiones: Client[] = [];
let correlativo = 0;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const clave = () => `prueba-${process.pid}-${++correlativo}-${Date.now()}`;
const HOY = () => hoyEnZonaDelNegocio();

async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username}: ${res.statusCode} ${res.body}`);
  return res.json().accessToken as string;
}

async function abrirConexion(): Promise<Client> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  conexiones.push(c);
  return c;
}

/** Retiene un bloqueo consultivo del protocolo desde otra conexión, hasta `soltar`. */
async function retener(clave: string) {
  const c = await abrirConexion();
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [clave]);
  return { soltar: async () => void (await c.query("COMMIT")) };
}

/** Confirma que hay al menos `n` sesiones esperando un cerrojo cuya consulta contiene `patron`. */
async function enEspera(n: number, patron: string) {
  for (let i = 0; i < 400; i++) {
    const { rows } = await observador.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`,
      [`%${patron}%`]
    );
    if (rows[0].n >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No se confirmó la espera de ${n} sesiones en «${patron}»`);
}

const ESPERA_BLOQUEO = "pg_advisory_xact_lock(hashtextextended";

// ---------------------------------------------------------------------------
// Mundo sintético
// ---------------------------------------------------------------------------

interface Club {
  id: string;
  token: string;
  usuarioId: string;
  actor: ActorContext;
}

let admin: { id: string; token: string; actor: ActorContext };

async function nuevoClub(prefijo: string): Promise<Club> {
  const n = ++correlativo;
  const code = `${prefijo}${n}`.toUpperCase().slice(0, 8);
  const club = await createClub(`Club Sintético ${prefijo} ${n}`, code, `club.${prefijo}.${n}`);
  const usuario = await createUser({ username: `club.${prefijo}.${n}`, roleNames: ["club"], clubId: club.id });
  return {
    id: club.id,
    token: await login(`club.${prefijo}.${n}`),
    usuarioId: usuario.id,
    actor: { userId: usuario.id, isAdmin: false, scope: { kind: "club", clubId: club.id }, canRegisterPostClose: false },
  };
}

async function nuevoPersonal(clubId: string, rol: "delegate" | "coach" | "legal_representative") {
  const n = ++correlativo;
  const persona = await createPerson({
    run: runValido(60000000 + n),
    username: `staff.${n}`,
    firstName: `Staff${n}`,
    gender: "female",
    roles: [rol],
  });
  await addClubStaff(clubId, persona.id, rol);
  const usuario = await createUser({ username: `staff.${n}`, roleNames: [rol], personId: persona.id });
  return {
    token: await login(`staff.${n}`),
    usuarioId: usuario.id,
    personaId: persona.id,
    actor: { userId: usuario.id, isAdmin: false, scope: { kind: "club" as const, clubId }, canRegisterPostClose: false },
  };
}

/** Persona registrada con un RUN válido y normalizado. */
async function nuevaPersona(opciones: { status?: "active" | "locked" | "disabled" } = {}) {
  const n = ++correlativo;
  const run = runValido(70000000 + n);
  const p = await createPerson({ run, username: `persona.${n}`, firstName: `Sintetica${n}`, gender: "male" });
  if (opciones.status) await prisma.person.update({ where: { id: p.id }, data: { status: opciones.status } });
  return { id: p.id, run, fullName: p.fullName };
}

const runLibre = () => runValido(80000000 + ++correlativo);

const postular = (token: string, run: string, k: string | null = clave(), extra: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/swimmer-assignments",
    headers: { ...auth(token), ...(k ? { "idempotency-key": k } : {}) },
    payload: { run, ...extra },
  });

const segundoPaso = (token: string, cuerpo: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/swimmer-assignments/altas", headers: auth(token), payload: cuerpo });

const intentosDe = (clubId: string) => prisma.intentoIncorporacion.count({ where: { clubId } });

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();
  observador = await abrirConexion();
  const usuario = await createUser({ username: "admin.c05", roleNames: ["admin"] });
  admin = {
    id: usuario.id,
    token: await login("admin.c05"),
    actor: { userId: usuario.id, isAdmin: true, scope: { kind: "admin" }, canRegisterPostClose: true },
  };
}, 120_000);

afterAll(async () => {
  await Promise.all(conexiones.map((c) => c.end().catch(() => undefined)));
  await app?.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. Roles, alcance y privacidad
// ---------------------------------------------------------------------------

describe("1. roles, alcance y privacidad", () => {
  it("la cuenta del club, su delegado, su entrenador y su representante legal postulan en su club por RUN", async () => {
    const club = await nuevoClub("rol");
    const cuentas = [
      club.token,
      (await nuevoPersonal(club.id, "delegate")).token,
      (await nuevoPersonal(club.id, "coach")).token,
      (await nuevoPersonal(club.id, "legal_representative")).token,
    ];
    for (const token of cuentas) {
      const persona = await nuevaPersona();
      const res = await postular(token, conFormato(persona.run)); // con puntos y guion
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({
        resultado: "propuesta_creada",
        propuesta: {
          status: "pending",
          tipo: "alta",
          club: { id: club.id },
          person: { id: persona.id, fullName: persona.fullName, run: persona.run },
        },
        cuota: { limite: 30 },
      });
    }
    expect(await intentosDe(club.id), "las cuatro cuentas comparten la cuota del club").toBe(4);

    // El listado del club conserva nombre, id y RUN de sus propuestas pendientes.
    const lista = await app.inject({ method: "GET", url: "/swimmer-assignments?status=pending", headers: auth(club.token) });
    expect(lista.json().items).toHaveLength(4);
    expect(lista.json().items[0].person).toHaveProperty("run");
  });

  it("estructura y autorización se comprueban ANTES de cobrar: nada de esto consume cuota", async () => {
    const a = await nuevoClub("aut");
    const b = await nuevoClub("aut");
    const persona = await nuevaPersona();
    const nadadora = await createPerson({
      run: runValido(60500000 + ++correlativo),
      username: `nad.${correlativo}`,
      firstName: "Nadadora",
      gender: "female",
    });
    await createUser({ username: `nad.${correlativo}`, roleNames: ["swimmer"], personId: nadadora.id });
    const tokenNadadora = await login(`nad.${correlativo}`);

    expect((await postular(tokenNadadora, persona.run)).statusCode, "un nadador no tiene el permiso").toBe(403);
    expect((await postular(b.token, persona.run, clave(), { clubId: a.id })).statusCode, "club ajeno").toBe(403);
    const conPersonId = await postular(a.token, persona.run, clave(), { personId: persona.id });
    expect(conPersonId.statusCode).toBe(400);
    expect(conPersonId.body).toContain("personId");
    const sinClave = await postular(a.token, persona.run, null);
    expect(sinClave.statusCode).toBe(400);
    expect(sinClave.json().error).toBe("IDEMPOTENCIA_REQUERIDA");
    expect((await postular(a.token, persona.run, "corta")).json().error).toBe("IDEMPOTENCIA_REQUERIDA");

    expect(await intentosDe(a.id)).toBe(0);
    expect(await intentosDe(b.id)).toBe(0);
  });

  it("un RUN inválido se rechaza con 400 y SÍ consume cuota (llegó al servidor)", async () => {
    const club = await nuevoClub("inv");
    const res = await postular(club.token, "12.345.678-9");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("RUN_INVALIDO");
    expect(await intentosDe(club.id)).toBe(1);
  });

  it("persona bloqueada o inhabilitada recibe la propuesta; su estado no cambia y no se revela", async () => {
    const club = await nuevoClub("blq");
    for (const status of ["locked", "disabled"] as const) {
      const persona = await nuevaPersona({ status });
      const res = await postular(club.token, persona.run);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.body).not.toContain(status);
      expect((await prisma.person.findUniqueOrThrow({ where: { id: persona.id } })).status).toBe(status);
    }
  });

  it("RUN que solo coincide con una persona ELIMINADA: el club sigue el flujo de alta y no recibe nada de ella", async () => {
    const club = await nuevoClub("eli");
    const run = runLibre();
    const eliminada = await prisma.person.create({
      data: {
        run,
        firstName: "Eliminada",
        paternalLastName: "Sintetica",
        fullName: "Eliminada Sintetica",
        birthDate: new Date("1980-01-01"),
        gender: "female",
        status: "active",
        deletedAt: new Date(),
      },
    });
    const res = await postular(club.token, run);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ resultado: "requiere_datos_de_alta" });
    expect(res.body).not.toContain(eliminada.id);
    expect(res.body).not.toContain("Eliminada");
  });

  it("detalle de una solicitud: otro club recibe 403; solo administración ve las coincidencias", async () => {
    const a = await nuevoClub("det");
    const b = await nuevoClub("det");
    const r = await postular(a.token, runLibre());
    const paso = await segundoPaso(a.token, {
      intentoId: r.json().intentoId,
      nombres: "Nombre Declarado",
      apellidos: "Apellido Declarado",
    });
    expect(paso.statusCode, paso.body).toBe(201);
    const id = paso.json().solicitud.id;

    expect((await app.inject({ method: "GET", url: `/swimmer-assignments/altas/${id}`, headers: auth(b.token) })).statusCode).toBe(403);
    const propio = await app.inject({ method: "GET", url: `/swimmer-assignments/altas/${id}`, headers: auth(a.token) });
    expect(propio.statusCode).toBe(200);
    expect(propio.json()).not.toHaveProperty("coincidencias");
    const deAdmin = await app.inject({ method: "GET", url: `/swimmer-assignments/altas/${id}`, headers: auth(admin.token) });
    expect(deAdmin.json()).toHaveProperty("coincidencias");
    // El listado de B no muestra la solicitud de A.
    const listaB = await app.inject({ method: "GET", url: "/swimmer-assignments/altas", headers: auth(b.token) });
    expect(listaB.json().items).toHaveLength(0);
  });

  it("los rechazos no devuelven datos personales", async () => {
    const club = await nuevoClub("pri");
    const persona = await nuevaPersona();
    expect((await postular(club.token, persona.run)).statusCode).toBe(201);
    const dup = await postular(club.token, persona.run);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("DUPLICADO");
    expect(dup.body).not.toContain(persona.id);
    expect(dup.body).not.toContain(persona.fullName);
  });
});

// ---------------------------------------------------------------------------
// 2. Cuota
// ---------------------------------------------------------------------------

describe("2. cuota de 30 intentos por club y día de Santiago", () => {
  it("la cuota es compartida: el intento 31 del día responde 429 sin cobrar, aunque venga de otra cuenta", async () => {
    const club = await nuevoClub("cuo");
    const delegado = await nuevoPersonal(club.id, "delegate");
    for (let i = 0; i < 30; i++) {
      const res = await postular(i % 2 === 0 ? club.token : delegado.token, runLibre());
      expect(res.statusCode, `intento ${i + 1}`).toBe(200);
    }
    const res = await postular(delegado.token, runLibre());
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "CUOTA_AGOTADA", details: { cuota: { usados: 30, limite: 30, dia: HOY() } } });
    expect(await intentosDe(club.id)).toBe(30);
    const cuota = await app.inject({ method: "GET", url: "/swimmer-assignments/cuota", headers: auth(club.token) });
    expect(cuota.json()).toMatchObject({ usados: 30, restantes: 0 });
  });

  it("40 solicitudes simultáneas de varias cuentas cobran exactamente 30", async () => {
    const club = await nuevoClub("sim");
    const delegado = await nuevoPersonal(club.id, "delegate");
    const entrenador = await nuevoPersonal(club.id, "coach");
    const tokens = [club.token, delegado.token, entrenador.token];
    const respuestas = await Promise.all(Array.from({ length: 40 }, (_, i) => postular(tokens[i % 3]!, runLibre())));
    const codigos = respuestas.map((r) => r.statusCode);
    expect(codigos.filter((c) => c === 200)).toHaveLength(30);
    expect(codigos.filter((c) => c === 429)).toHaveLength(10);
    expect(await intentosDe(club.id)).toBe(30);
  }, 60_000);

  it("los rechazos esperados quedan contados después del commit; aprobar o rechazar no devuelve cuota", async () => {
    const club = await nuevoClub("rec");
    const persona = await nuevaPersona();
    await postular(club.token, "123"); // RUN inválido
    const ok = await postular(club.token, persona.run);
    await postular(club.token, persona.run); // duplicado
    expect(await intentosDe(club.id)).toBe(3);
    const estados = (await prisma.intentoIncorporacion.findMany({ where: { clubId: club.id }, orderBy: { creadoEn: "asc" } })).map(
      (i) => i.estado
    );
    expect(estados).toEqual(["run_invalido", "propuesta_creada", "duplicado"]);

    await asignacion.rejectAssignment(ok.json().propuesta.id, "sintético", { userId: admin.id });
    expect((await postulacion.cuotaDelClub(club.id)).usados).toBe(3);
  });

  it("las vías administrativas (directa, masiva, reasignación) no pasan por la cuota", async () => {
    const club = await nuevoClub("adm");
    const otro = await nuevoClub("adm");
    const p1 = await nuevaPersona();
    const p2 = await nuevaPersona();
    const m = await asignacion.assignSwimmerDirectly(
      { clubId: club.id, personId: p1.id, fechaEfectiva: "2026-01-05" },
      { userId: admin.id }
    );
    await asignacion.bulkAssignSwimmers({ targetClubId: club.id, personIds: [p2.id] }, { userId: admin.id });
    await asignacion.reassignSwimmerToClub(p1.id, otro.id, { userId: admin.id }, { confirmarFinDeMembresiaId: m.id });
    expect(await intentosDe(club.id)).toBe(0);
    expect(await intentosDe(otro.id)).toBe(0);
  });

  it("el cambio de día en Santiago reinicia el recuento (reloj controlado)", async () => {
    const club = await nuevoClub("dia");
    // 2026-07-15 23:59 en Santiago (invierno, UTC-4) = 2026-07-16 03:59Z; un minuto después ya es el 16.
    const antes = new Date("2026-07-16T03:59:00.000Z");
    const despues = new Date("2026-07-16T04:01:00.000Z");
    for (let i = 0; i < 30; i++) await postulacion.postularComoClub({ run: runLibre() }, club.actor, clave(), { ahora: antes });
    await expect(postulacion.postularComoClub({ run: runLibre() }, club.actor, clave(), { ahora: antes })).rejects.toMatchObject({
      statusCode: 429,
    });
    const r = await postulacion.postularComoClub({ run: runLibre() }, club.actor, clave(), { ahora: despues });
    expect(r.cuerpo.cuota).toEqual({ usados: 1, limite: 30, dia: "2026-07-16" });
  }, 60_000);

  it("un fallo ANTES de confirmar T1 no consume cuota (503 sin intento registrado)", async () => {
    const club = await nuevoClub("ft1");
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION c05_fallo_cobro() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fallo inyectado en el cobro (prueba)'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER c05_fallo_cobro BEFORE INSERT ON intentos_incorporacion FOR EACH ROW EXECUTE FUNCTION c05_fallo_cobro()`);
    try {
      expect((await postular(club.token, runLibre())).statusCode).toBe(503);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS c05_fallo_cobro ON intentos_incorporacion`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS c05_fallo_cobro()`);
    }
    expect(await intentosDe(club.id)).toBe(0);
  });
});

describe("2b. postulación de administración por RUN", () => {
  it("con club explícito crea la propuesta sin cuota ni periodo; sin club 400; RUN sin persona 404", async () => {
    const club = await nuevoClub("pad");
    const otro = await nuevoClub("pad");
    const conClub = await nuevaPersona();
    await addActiveMembership(otro.id, conClub.id, admin.id);
    const ok = await postular(admin.token, conClub.run, null, { clubId: club.id });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().propuesta).toMatchObject({ tipo: "cambio", status: "pending" });
    expect(await intentosDe(club.id), "administración no consume la cuota del club").toBe(0);
    expect((await postular(admin.token, conClub.run, null)).statusCode).toBe(400);
    const sinPersona = await postular(admin.token, runLibre(), null, { clubId: club.id });
    expect(sinPersona.statusCode).toBe(404);
    expect(sinPersona.json().error).toBe("PERSONA_NO_REGISTRADA");
    const cuota = await app.inject({ method: "GET", url: `/swimmer-assignments/cuota?clubId=${club.id}`, headers: auth(admin.token) });
    expect(cuota.json()).toMatchObject({ usados: 0, limite: 30, restantes: 30 });
  });
});

// ---------------------------------------------------------------------------
// 3. Idempotencia
// ---------------------------------------------------------------------------

describe("3. idempotencia", () => {
  it("misma clave y mismo contenido: devuelve lo creado sin cobrar ni crear otra propuesta", async () => {
    const club = await nuevoClub("ide");
    const persona = await nuevaPersona();
    const k = clave();
    const primera = await postular(club.token, persona.run, k);
    expect(primera.statusCode).toBe(201);
    const repetida = await postular(club.token, conFormato(persona.run), k); // mismo RUN, otro formato
    expect(repetida.statusCode).toBe(200);
    expect(repetida.json()).toMatchObject({
      resultado: "propuesta_creada",
      repeticion: true,
      propuesta: { id: primera.json().propuesta.id },
    });
    expect(await intentosDe(club.id)).toBe(1);
    expect(await prisma.clubSwimmer.count({ where: { clubId: club.id, personId: persona.id } })).toBe(1);
  });

  it("misma clave con otro RUN: conflicto, sin búsqueda, sin cobro y sin datos", async () => {
    const club = await nuevoClub("idc");
    const a = await nuevaPersona();
    const b = await nuevaPersona();
    const k = clave();
    await postular(club.token, a.run, k);
    const otra = await postular(club.token, b.run, k);
    expect(otra.statusCode).toBe(409);
    expect(otra.json().error).toBe("IDEMPOTENCIA_CONFLICTO");
    expect(otra.body).not.toContain(b.id);
    expect(await intentosDe(club.id)).toBe(1);
    expect(await prisma.clubSwimmer.count({ where: { personId: b.id } })).toBe(0);
  });

  it("diez repeticiones simultáneas con la misma clave ejecutan la operación una sola vez", async () => {
    const club = await nuevoClub("idr");
    const persona = await nuevaPersona();
    const k = clave();
    const respuestas = await Promise.all(Array.from({ length: 10 }, () => postular(club.token, persona.run, k)));
    const codigos = respuestas.map((r) => (r.statusCode === 409 ? `409 ${r.json().error}` : String(r.statusCode)));
    expect(codigos.filter((c) => c === "201")).toHaveLength(1);
    for (const c of codigos) expect(["201", "200", "409 OPERACION_EN_CURSO"]).toContain(c);
    expect(await intentosDe(club.id)).toBe(1);
    expect(await prisma.clubSwimmer.count({ where: { clubId: club.id, personId: persona.id } })).toBe(1);
  });

  it("la repetición vuelve a pasar por permiso y alcance: quien perdió el cargo recibe 403", async () => {
    const club = await nuevoClub("idp");
    const delegado = await nuevoPersonal(club.id, "delegate");
    const persona = await nuevaPersona();
    const k = clave();
    expect((await postular(delegado.token, persona.run, k)).statusCode).toBe(201);
    await prisma.clubStaff.deleteMany({ where: { personId: delegado.personaId } });
    expect((await postular(delegado.token, persona.run, k)).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 4. Segundo paso
// ---------------------------------------------------------------------------

describe("4. segundo paso (RUN no registrado)", () => {
  it("crea la solicitud sin persona provisional, no cobra, es de uso único y repetirlo con lo mismo devuelve lo creado", async () => {
    const club = await nuevoClub("sp");
    const run = runLibre();
    const r = await postular(club.token, run);
    expect(r.json()).toMatchObject({ resultado: "requiere_datos_de_alta" });
    const cuerpo = { intentoId: r.json().intentoId, nombres: "  Ana  María ", apellidos: "Sintética Pérez" };
    const personasAntes = await prisma.person.count();

    const paso = await segundoPaso(club.token, cuerpo);
    expect(paso.statusCode, paso.body).toBe(201);
    expect(paso.json().solicitud).toMatchObject({
      estado: "pendiente",
      run,
      nombres: "Ana María",
      apellidos: "Sintética Pérez",
      persona: null,
    });
    expect(await prisma.person.count(), "no se crea una persona provisional").toBe(personasAntes);
    expect(await intentosDe(club.id), "el segundo paso no cobra").toBe(1);
    const intento = await prisma.intentoIncorporacion.findUniqueOrThrow({ where: { id: cuerpo.intentoId } });
    expect(intento).toMatchObject({ estado: "alta_registrada", runNormalizado: null });
    expect(intento.consumidoEn).not.toBeNull();

    const repetido = await segundoPaso(club.token, cuerpo);
    expect(repetido.statusCode).toBe(200);
    expect(repetido.json()).toMatchObject({ repeticion: true, solicitud: { id: paso.json().solicitud.id } });
    const otro = await segundoPaso(club.token, { ...cuerpo, nombres: "Otro Nombre" });
    expect(otro.statusCode).toBe(409);
    expect(otro.json().error).toBe("PASO_YA_UTILIZADO");
    expect(await prisma.solicitudAltaIncorporacion.count({ where: { clubId: club.id } })).toBe(1);
  });

  it("vencido: se rechaza y se retira el RUN temporal (reloj controlado)", async () => {
    const club = await nuevoClub("spv");
    const inicio = new Date();
    const r = await postulacion.postularComoClub({ run: runLibre() }, club.actor, clave(), { ahora: inicio });
    const intentoId = r.cuerpo.intentoId as string;
    const tarde = new Date(inicio.getTime() + 16 * 60_000);
    await expect(
      postulacion.completarAlta({ intentoId, nombres: "Ana", apellidos: "Sintética" }, club.actor, { ahora: tarde })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PASO_VENCIDO",
    });
    expect((await prisma.intentoIncorporacion.findUniqueOrThrow({ where: { id: intentoId } })).runNormalizado).toBeNull();
  });

  it("desde otra cuenta del mismo club o desde otro club: no existe (404); con RUN en el cuerpo: 400", async () => {
    const a = await nuevoClub("spo");
    const b = await nuevoClub("spo");
    const delegadoA = await nuevoPersonal(a.id, "delegate");
    const r = await postular(a.token, runLibre());
    const cuerpo = { intentoId: r.json().intentoId, nombres: "Ana", apellidos: "Sintética" };
    expect((await segundoPaso(delegadoA.token, cuerpo)).statusCode).toBe(404);
    expect((await segundoPaso(b.token, cuerpo)).statusCode).toBe(404);
    expect((await segundoPaso(a.token, { ...cuerpo, run: runLibre() })).statusCode).toBe(400);
    expect((await segundoPaso(a.token, cuerpo)).statusCode, "el dueño todavía puede completarlo").toBe(201);
  });

  it("una solicitud pendiente por club y RUN; otro club puede presentar la suya en paralelo", async () => {
    const a = await nuevoClub("spd");
    const b = await nuevoClub("spd");
    const run = runLibre();
    const datos = { nombres: "Ana", apellidos: "Sintética" };
    const r1 = await postular(a.token, run);
    expect((await segundoPaso(a.token, { intentoId: r1.json().intentoId, ...datos })).statusCode).toBe(201);
    const r2 = await postular(a.token, run);
    const dup = await segundoPaso(a.token, { intentoId: r2.json().intentoId, ...datos });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("DUPLICADO");
    const rb = await postular(b.token, run);
    expect((await segundoPaso(b.token, { intentoId: rb.json().intentoId, ...datos })).statusCode).toBe(201);
  });

  it("persona registrada entre los dos pasos: se vuelven a aplicar las reglas (sin club → propuesta; activa fuera de periodo → 409; con periodo → cambio)", async () => {
    const club = await nuevoClub("spe");
    const otro = await nuevoClub("spe");
    const datos = { nombres: "Ana", apellidos: "Sintética" };

    // Sin membresía activa.
    const run1 = runLibre();
    const r1 = await postular(club.token, run1);
    const p1 = await createPerson({ run: run1, username: `entre.${++correlativo}`, firstName: "Entre", gender: "female" });
    const paso1 = await segundoPaso(club.token, { intentoId: r1.json().intentoId, ...datos });
    expect(paso1.statusCode, paso1.body).toBe(201);
    expect(paso1.json()).toMatchObject({ resultado: "propuesta_creada", propuesta: { person: { id: p1.id } } });
    expect((await prisma.intentoIncorporacion.findUniqueOrThrow({ where: { id: r1.json().intentoId } })).estado).toBe(
      "resuelto_por_propuesta"
    );

    // Con membresía activa en otro club y sin periodo.
    const run2 = runLibre();
    const r2 = await postular(club.token, run2);
    const p2 = await createPerson({ run: run2, username: `entre.${++correlativo}`, firstName: "Entre", gender: "female" });
    await addActiveMembership(otro.id, p2.id, admin.id);
    const paso2 = await segundoPaso(club.token, { intentoId: r2.json().intentoId, ...datos });
    expect(paso2.statusCode).toBe(409);
    expect(paso2.json().error).toBe("MEMBRESIA_ACTIVA_FUERA_DE_PERIODO");
    expect(paso2.body).not.toContain(otro.id);
    expect(
      (await prisma.intentoIncorporacion.findUniqueOrThrow({ where: { id: r2.json().intentoId } })).consumidoEn,
      "el rechazo consume el paso"
    ).not.toBeNull();

    // Con periodo vigente: propuesta de cambio.
    const periodo = await periodos.crearPeriodo({ inicio: HOY(), fin: HOY() }, { userId: admin.id });
    try {
      const run3 = runLibre();
      const r3 = await postular(club.token, run3);
      const p3 = await createPerson({ run: run3, username: `entre.${++correlativo}`, firstName: "Entre", gender: "female" });
      await addActiveMembership(otro.id, p3.id, admin.id);
      const paso3 = await segundoPaso(club.token, { intentoId: r3.json().intentoId, ...datos });
      expect(paso3.statusCode, paso3.body).toBe(201);
      expect(paso3.json().propuesta.person.id).toBe(p3.id);
    } finally {
      await periodos.cerrarPeriodo(periodo.id, { userId: admin.id });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Derecho de ejecución (T2), fallos y mantenimiento
// ---------------------------------------------------------------------------

describe("5. T2 retrasado, rollback y mantenimiento", () => {
  it("un T2 detenido que pierde su derecho (marcado interrumpido) no continúa: sin propuesta y con el intento cobrado", async () => {
    const club = await nuevoClub("t2");
    const persona = await nuevaPersona();
    const retencion = await retener(`c05:club:${club.id}`);
    const enCurso = postulacion.postularComoClub({ run: persona.run }, club.actor, clave()).then(
      (r) => ({ ok: r }),
      (e) => ({ error: e as AppError })
    );
    await enEspera(1, ESPERA_BLOQUEO); // T1 confirmado; T2 espera el bloqueo del club
    const intento = await prisma.intentoIncorporacion.findFirstOrThrow({ where: { clubId: club.id } });
    expect(intento.estado).toBe("en_curso");

    // El mantenimiento, con el reloj adelantado más allá del plazo, lo marca interrumpido.
    const barrido = await postulacion.mantenerIntentos(new Date(intento.creadoEn.getTime() + 3 * 60_000));
    expect(barrido.interrumpidos).toBeGreaterThanOrEqual(1);
    await retencion.soltar();

    const resultado = await enCurso;
    expect("error" in resultado && resultado.error.code).toBe("INTENTO_INTERRUMPIDO");
    expect(await prisma.clubSwimmer.count({ where: { personId: persona.id } }), "no quedó propuesta").toBe(0);
    expect((await prisma.intentoIncorporacion.findUniqueOrThrow({ where: { id: intento.id } })).estado).toBe("interrumpido");
    expect((await postulacion.cuotaDelClub(club.id)).usados, "el intento sigue contado").toBe(1);
  });

  it("si falla la auditoría, no queda propuesta ni se devuelven datos; el intento cobrado se conserva", async () => {
    const club = await nuevoClub("rb");
    const persona = await nuevaPersona();
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION c05_fallo_auditoria() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fallo inyectado en la auditoría (prueba)'; END $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER c05_fallo_auditoria BEFORE INSERT ON audit_logs FOR EACH ROW
      WHEN (NEW.action = 'SWIMMER_ASSIGNMENT_PROPOSED') EXECUTE FUNCTION c05_fallo_auditoria()`);
    try {
      const res = await postular(club.token, persona.run);
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain(persona.id);
      expect(res.body).not.toContain(persona.fullName);
      expect(res.body).not.toContain(persona.run);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS c05_fallo_auditoria ON audit_logs`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS c05_fallo_auditoria()`);
    }
    expect(await prisma.clubSwimmer.count({ where: { personId: persona.id } })).toBe(0);
    const intento = await prisma.intentoIncorporacion.findFirstOrThrow({ where: { clubId: club.id } });
    expect(intento.estado).toBe("error_tecnico");
    expect((await postulacion.cuotaDelClub(club.id)).usados).toBe(1);
  });

  it("el mantenimiento marca interrumpidos los intentos antiguos en curso y retira el RUN de los pasos vencidos", async () => {
    const club = await nuevoClub("mt");
    const ahora = new Date();
    const r = await postulacion.postularComoClub({ run: runLibre() }, club.actor, clave(), { ahora });
    // Un intento en curso de otra cuenta del club, creado después y nunca resuelto (proceso caído).
    const huerfano = await prisma.intentoIncorporacion.create({
      data: {
        clubId: club.id,
        userId: club.usuarioId,
        dia: new Date(`${HOY()}T00:00:00Z`),
        claveIdempotencia: clave(),
        huellaContenido: Buffer.alloc(32),
        estado: "en_curso",
        tokenEjecucion: crypto.randomUUID(),
        creadoEn: ahora,
      },
    });
    const res = await postulacion.mantenerIntentos(new Date(ahora.getTime() + 20 * 60_000));
    expect(res.interrumpidos).toBeGreaterThanOrEqual(1);
    expect(res.runsRetirados).toBeGreaterThanOrEqual(1);
    expect((await prisma.intentoIncorporacion.findUniqueOrThrow({ where: { id: huerfano.id } })).estado).toBe("interrumpido");
    expect(
      (await prisma.intentoIncorporacion.findUniqueOrThrow({ where: { id: r.cuerpo.intentoId as string } })).runNormalizado
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Periodos
// ---------------------------------------------------------------------------

describe("6. periodos de cambio", () => {
  it("solo administración los gestiona; solapados 409; cerrar dos veces 409; sin vía de edición ni reapertura; auditados", async () => {
    const club = await nuevoClub("per");
    const crear = (token: string, cuerpo: object) =>
      app.inject({ method: "POST", url: "/swimmer-assignments/periodos-cambio", headers: auth(token), payload: cuerpo });
    expect((await crear(club.token, { inicio: HOY(), fin: HOY() })).statusCode).toBe(403);
    const ok = await crear(admin.token, { inicio: HOY(), fin: "2027-01-31", motivo: "Periodo sintético" });
    expect(ok.statusCode, ok.body).toBe(201);
    const solapado = await crear(admin.token, { inicio: "2027-01-31", fin: "2027-02-05" });
    expect(solapado.json().error).toBe("PERIODO_SOLAPADO");
    const id = ok.json().id;
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      expect(
        (await app.inject({ method, url: `/swimmer-assignments/periodos-cambio/${id}`, headers: auth(admin.token), payload: {} }))
          .statusCode,
        method
      ).toBe(404);
    }
    expect(
      (await app.inject({ method: "POST", url: `/swimmer-assignments/periodos-cambio/${id}/cerrar`, headers: auth(admin.token) }))
        .statusCode
    ).toBe(200);
    const otraVez = await app.inject({
      method: "POST",
      url: `/swimmer-assignments/periodos-cambio/${id}/cerrar`,
      headers: auth(admin.token),
    });
    expect(otraVez.json().error).toBe("PERIODO_YA_CERRADO");
    const acciones = (await prisma.auditLog.findMany({ where: { entityId: id }, select: { action: true } })).map((a) => a.action).sort();
    expect(acciones).toEqual(["CHANGE_PERIOD_CLOSED", "CHANGE_PERIOD_CREATED"]);
    expect(
      (await app.inject({ method: "GET", url: "/swimmer-assignments/periodos-cambio/vigente", headers: auth(club.token) })).json()
    ).toEqual({ vigente: false });
  });

  it("tras un cierre anticipado, administración puede crear OTRO periodo con las mismas fechas: el cerrado no se reabre ni cambia", async () => {
    const crear = (cuerpo: object) => app.inject({ method: "POST", url: "/swimmer-assignments/periodos-cambio", headers: auth(admin.token), payload: cuerpo });
    const fechas = { inicio: HOY(), fin: "2027-03-31" };
    const primero = await crear({ ...fechas, motivo: "Primero (sintético)" });
    expect(primero.statusCode, primero.body).toBe(201);
    const idCerrado = primero.json().id;
    try {
      const cerrar = await app.inject({ method: "POST", url: `/swimmer-assignments/periodos-cambio/${idCerrado}/cerrar`, headers: auth(admin.token) });
      expect(cerrar.statusCode, cerrar.body).toBe(200);
      const antes = await prisma.periodoCambioClub.findUniqueOrThrow({ where: { id: idCerrado } });

      const nuevo = await crear({ ...fechas, motivo: "Nuevo tras el cierre (sintético)" });
      expect(nuevo.statusCode, nuevo.body).toBe(201);
      expect(nuevo.json().id, "es OTRO registro").not.toBe(idCerrado);
      expect(nuevo.json()).toMatchObject({ inicio: fechas.inicio, fin: fechas.fin, cerradoEn: null });
      expect(await prisma.periodoCambioClub.findUniqueOrThrow({ where: { id: idCerrado } }), "el cerrado no cambia").toEqual(antes);
      const auditoria = await prisma.auditLog.findMany({ where: { entityId: nuevo.json().id }, select: { action: true, userId: true } });
      expect(auditoria).toEqual([{ action: "CHANGE_PERIOD_CREATED", userId: admin.id }]);

      // Los ABIERTOS siguen sin poder solaparse.
      expect((await crear({ inicio: "2027-03-31", fin: "2027-04-02" })).json().error).toBe("PERIODO_SOLAPADO");
      await periodos.cerrarPeriodo(nuevo.json().id, { userId: admin.id });
    } finally {
      // Ningún periodo abierto de esta prueba queda vigente para las siguientes.
      const abiertos = await prisma.periodoCambioClub.findMany({ where: { cerradoEn: null, inicio: { lte: new Date("2027-03-31T00:00:00Z") } }, select: { id: true } });
      for (const p of abiertos) await periodos.cerrarPeriodo(p.id, { userId: admin.id }).catch(() => undefined);
    }
  });

  it("cerrar el periodo conserva las propuestas y solicitudes pendientes; después ya no admite cambios", async () => {
    const club = await nuevoClub("pce");
    const otro = await nuevoClub("pce");
    const periodo = await periodos.crearPeriodo({ inicio: HOY(), fin: HOY() }, { userId: admin.id });
    let cerrado = false;
    try {
      const conClub = await nuevaPersona();
      await addActiveMembership(otro.id, conClub.id, admin.id);
      const cambio = await postular(club.token, conClub.run);
      expect(cambio.statusCode, cambio.body).toBe(201);
      expect(cambio.json().propuesta.tipo).toBe("cambio");
      const r = await postular(club.token, runLibre());
      const solicitud = (await segundoPaso(club.token, { intentoId: r.json().intentoId, nombres: "Ana", apellidos: "Sintética" })).json()
        .solicitud;

      await periodos.cerrarPeriodo(periodo.id, { userId: admin.id });
      cerrado = true;
      expect((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: cambio.json().propuesta.id } })).status).toBe("pending");
      expect((await prisma.solicitudAltaIncorporacion.findUniqueOrThrow({ where: { id: solicitud.id } })).estado).toBe("pendiente");

      const otraConClub = await nuevaPersona();
      await addActiveMembership(otro.id, otraConClub.id, admin.id);
      expect((await postular(club.token, otraConClub.run)).json().error).toBe("MEMBRESIA_ACTIVA_FUERA_DE_PERIODO");
    } finally {
      if (!cerrado) await periodos.cerrarPeriodo(periodo.id, { userId: admin.id });
    }
  });

  it("cierre concurrente con una postulación de cambio: el cierre espera a la postulación, que se confirma válida", async () => {
    const club = await nuevoClub("pcc");
    const otro = await nuevoClub("pcc");
    const periodo = await periodos.crearPeriodo({ inicio: HOY(), fin: HOY() }, { userId: admin.id });
    const persona = await nuevaPersona();
    await addActiveMembership(otro.id, persona.id, admin.id);

    // La otra conexión inserta (sin confirmar) una pendiente del mismo club y persona: la
    // postulación lee el periodo con FOR SHARE y se detiene al insertar su propuesta.
    const retencion = await abrirConexion();
    await retencion.query("BEGIN");
    await retencion.query(
      `INSERT INTO club_swimmers (id, club_id, person_id, status, requested_by_user_id, updated_at) VALUES (gen_random_uuid(), $1, $2, 'pending', $3, now())`,
      [club.id, persona.id, admin.id]
    );
    const enCurso = postular(club.token, persona.run);
    await enEspera(1, 'INSERT INTO "public"."club_swimmers"');
    const cierre = periodos.cerrarPeriodo(periodo.id, { userId: admin.id });
    await enEspera(1, "FROM periodos_cambio_club WHERE id");
    await retencion.query("ROLLBACK");

    const res = await enCurso;
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().propuesta.tipo).toBe("cambio");
    const cerrado = await cierre;
    expect(cerrado.cerradoEn).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Resolución administrativa y concurrencia
// ---------------------------------------------------------------------------

describe("7. resolución: traslado confirmado y protocolo común", () => {
  async function pendienteDeCambio() {
    const destino = await nuevoClub("res");
    const origen = await nuevoClub("res");
    const persona = await nuevaPersona({ status: "locked" });
    const vigente = await asignacion.assignSwimmerDirectly(
      { clubId: origen.id, personId: persona.id, fechaEfectiva: "2026-01-10" },
      { userId: admin.id }
    );
    const propuesta = await prisma.clubSwimmer.create({
      data: { clubId: destino.id, personId: persona.id, status: "pending", requestedByUserId: destino.usuarioId },
    });
    return { destino, origen, persona, vigente, propuesta };
  }

  it("aprobar un cambio exige confirmar la membresía vigente; con ella, finaliza el día anterior y activa la MISMA propuesta, sin reactivar a la persona", async () => {
    const { persona, vigente, propuesta } = await pendienteDeCambio();
    const aprobar = (cuerpo: object) =>
      app.inject({ method: "POST", url: `/swimmer-assignments/${propuesta.id}/approve`, headers: auth(admin.token), payload: cuerpo });

    const sinConfirmar = await aprobar({ fechaEfectiva: "2026-03-10" });
    expect(sinConfirmar.statusCode).toBe(409);
    expect(sinConfirmar.json()).toMatchObject({ error: "CONFIRMACION_REQUERIDA", details: { membresiaVigente: { id: vigente.id } } });
    expect((await aprobar({ fechaEfectiva: "2026-03-10", confirmarFinDeMembresiaId: propuesta.id })).json().error).toBe("REVISAR_DE_NUEVO");

    const ok = await aprobar({ fechaEfectiva: "2026-03-10", confirmarFinDeMembresiaId: vigente.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().id).toBe(propuesta.id);
    const { rows } = await observador.query(
      `SELECT id, status, start_date::text AS inicio, fecha_termino::text AS termino, end_date IS NOT NULL AS con_instante FROM club_swimmers WHERE person_id = $1 ORDER BY start_date`,
      [persona.id]
    );
    expect(rows).toEqual([
      { id: vigente.id, status: "ended", inicio: "2026-01-10", termino: "2026-03-09", con_instante: true },
      { id: propuesta.id, status: "active", inicio: "2026-03-10", termino: null, con_instante: false },
    ]);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: persona.id } })).status, "no se reactiva").toBe("locked");
    const acciones = (
      await prisma.auditLog.findMany({ where: { entityId: { in: [vigente.id, propuesta.id] } }, select: { action: true } })
    ).map((a) => a.action);
    expect(acciones).toEqual(expect.arrayContaining(["SWIMMER_ASSIGNMENT_ENDED_BY_TRANSFER", "SWIMMER_ASSIGNMENT_APPROVED"]));
  });

  it("aprobar frente a rechazar: se serializan y el segundo ve la propuesta resuelta (409)", async () => {
    const club = await nuevoClub("ar");
    const persona = await nuevaPersona();
    const propuesta = await prisma.clubSwimmer.create({
      data: { clubId: club.id, personId: persona.id, status: "pending", requestedByUserId: club.usuarioId },
    });
    const retencion = await retener(`c05:persona:${persona.id}`);
    const rechazo = asignacion.rejectAssignment(propuesta.id, "sintético", { userId: admin.id }).then(
      (r) => r,
      (e) => e
    );
    await enEspera(1, ESPERA_BLOQUEO);
    const aprobacion = asignacion.approveAssignment(propuesta.id, { userId: admin.id }).then(
      (r) => r,
      (e) => e
    );
    await enEspera(2, ESPERA_BLOQUEO);
    await retencion.soltar();
    expect((await rechazo).status).toBe("rejected");
    expect((await aprobacion).code).toBe("SOLICITUD_YA_RESUELTA");
    expect((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: propuesta.id } })).status).toBe("rejected");
  });

  it("aprobar frente a finalizar la vigente: si finalizar va primero, la aprobación exige revisar de nuevo y no activa nada", async () => {
    const { persona, vigente, propuesta, origen } = await pendienteDeCambio();
    const retencion = await retener(`c05:persona:${persona.id}`);
    const fin = asignacion.endAssignment(vigente.id, origen.actor, { fechaTermino: "2026-02-01" }).then(
      (r) => r,
      (e) => e
    );
    await enEspera(1, ESPERA_BLOQUEO);
    const aprobacion = asignacion
      .approveAssignment(propuesta.id, { userId: admin.id }, { fechaEfectiva: "2026-03-10", confirmarFinDeMembresiaId: vigente.id })
      .then(
        (r) => r,
        (e) => e
      );
    await enEspera(2, ESPERA_BLOQUEO);
    await retencion.soltar();
    expect((await fin).status).toBe("ended");
    expect((await aprobacion).code).toBe("REVISAR_DE_NUEVO");
    expect((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: propuesta.id } })).status).toBe("pending");
  });

  it("aprobar frente a finalizar: si aprobar va primero, finalizar encuentra la membresía ya finalizada (409)", async () => {
    const { persona, vigente, propuesta, origen } = await pendienteDeCambio();
    const retencion = await retener(`c05:persona:${persona.id}`);
    const aprobacion = asignacion
      .approveAssignment(propuesta.id, { userId: admin.id }, { fechaEfectiva: "2026-03-10", confirmarFinDeMembresiaId: vigente.id })
      .then(
        (r) => r,
        (e) => e
      );
    await enEspera(1, ESPERA_BLOQUEO);
    const fin = asignacion.endAssignment(vigente.id, origen.actor, { fechaTermino: "2026-02-01" }).then(
      (r) => r,
      (e) => e
    );
    await enEspera(2, ESPERA_BLOQUEO);
    await retencion.soltar();
    expect((await aprobacion).status).toBe("active");
    expect((await fin).code).toBe("MEMBRESIA_NO_ACTIVA");
  });

  it("aprobar frente a reasignar: la reasignación va primero y la aprobación ve otra membresía vigente (revisar de nuevo)", async () => {
    const { persona, vigente, propuesta } = await pendienteDeCambio();
    const tercero = await nuevoClub("res");
    const retencion = await retener(`c05:persona:${persona.id}`);
    const reasignacion = asignacion
      .reassignSwimmerToClub(
        persona.id,
        tercero.id,
        { userId: admin.id },
        { fechaEfectiva: "2026-02-01", confirmarFinDeMembresiaId: vigente.id }
      )
      .then(
        (r) => r,
        (e) => e
      );
    await enEspera(1, ESPERA_BLOQUEO);
    const aprobacion = asignacion
      .approveAssignment(propuesta.id, { userId: admin.id }, { fechaEfectiva: "2026-03-10", confirmarFinDeMembresiaId: vigente.id })
      .then(
        (r) => r,
        (e) => e
      );
    await enEspera(2, ESPERA_BLOQUEO);
    await retencion.soltar();
    expect((await reasignacion).clubId).toBe(tercero.id);
    expect((await aprobacion).code).toBe("REVISAR_DE_NUEVO");
    expect(await prisma.clubSwimmer.count({ where: { personId: persona.id, status: "active" } })).toBe(1);
  });

  it("/direct y bulk-assign siguen rechazando a quien está activo en otro club; reassign exige la confirmación", async () => {
    const { persona, vigente, destino } = await pendienteDeCambio();
    const directa = await app.inject({
      method: "POST",
      url: "/swimmer-assignments/direct",
      headers: auth(admin.token),
      payload: { clubId: destino.id, personId: persona.id },
    });
    expect(directa.statusCode).toBe(400);
    expect(directa.json().message).toContain("membresía activa");
    const masiva = await asignacion.bulkAssignSwimmers({ targetClubId: destino.id, personIds: [persona.id] }, { userId: admin.id });
    expect(masiva.errorCount).toBe(1);
    // Fase 3: cada fila rechazada trae su código estable, para que la interfaz no lea el texto.
    expect(masiva.results[0]).toMatchObject({ status: "error", codigo: "VALIDATION_ERROR" });
    const sinConfirmar = await app.inject({
      method: "POST",
      url: `/swimmer-assignments/reassign/${persona.id}`,
      headers: auth(admin.token),
      payload: { newClubId: destino.id },
    });
    expect(sinConfirmar.json().error).toBe("CONFIRMACION_REQUERIDA");
    expect((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: vigente.id } })).status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// 8. Fechas e historial
// ---------------------------------------------------------------------------

describe("8. fechas efectivas e historial incompleto", () => {
  it("fecha futura rechazada en aprobación, directa, masiva, reasignación y alta, sin escribir nada", async () => {
    const club = await nuevoClub("fut");
    const persona = await nuevaPersona();
    const manana = "2099-01-01";
    const propuesta = await prisma.clubSwimmer.create({
      data: { clubId: club.id, personId: persona.id, status: "pending", requestedByUserId: club.usuarioId },
    });
    const llamadas = [
      () => asignacion.approveAssignment(propuesta.id, { userId: admin.id }, { fechaEfectiva: manana }),
      () => asignacion.assignSwimmerDirectly({ clubId: club.id, personId: persona.id, fechaEfectiva: manana }, { userId: admin.id }),
      () => asignacion.bulkAssignSwimmers({ targetClubId: club.id, personIds: [persona.id], fechaEfectiva: manana }, { userId: admin.id }),
      () => asignacion.reassignSwimmerToClub(persona.id, club.id, { userId: admin.id }, { fechaEfectiva: manana }),
      () =>
        altas.aprobarSolicitud(
          "00000000-0000-4000-8000-000000000000",
          { modo: "vincular", personaEsperadaId: persona.id, fechaEfectiva: manana },
          admin.actor
        ),
    ];
    for (const llamada of llamadas) await expect(llamada()).rejects.toMatchObject({ statusCode: 400, code: "FECHA_FUTURA" });
    expect(await prisma.clubSwimmer.count({ where: { personId: persona.id, status: "active" } })).toBe(0);
  });

  it("el término es el día calendario anterior: cambio de mes, de año y bisiesto", async () => {
    for (const [inicioAnterior, efectiva, termino] of [
      ["2026-02-01", "2026-03-01", "2026-02-28"],
      ["2025-11-01", "2026-01-01", "2025-12-31"],
      ["2024-01-10", "2024-03-01", "2024-02-29"],
    ] as const) {
      const a = await nuevoClub("dia");
      const b = await nuevoClub("dia");
      const persona = await nuevaPersona();
      const vigente = await asignacion.assignSwimmerDirectly(
        { clubId: a.id, personId: persona.id, fechaEfectiva: inicioAnterior },
        { userId: admin.id }
      );
      await asignacion.reassignSwimmerToClub(
        persona.id,
        b.id,
        { userId: admin.id },
        { fechaEfectiva: efectiva, confirmarFinDeMembresiaId: vigente.id }
      );
      const { rows } = await observador.query(`SELECT fecha_termino::text AS t FROM club_swimmers WHERE id = $1`, [vigente.id]);
      expect(rows[0].t, efectiva).toBe(termino);
    }
  });

  it("una fecha igual o anterior al inicio de la membresía vigente se rechaza (conflicto conocido)", async () => {
    const a = await nuevoClub("ini");
    const b = await nuevoClub("ini");
    const persona = await nuevaPersona();
    const vigente = await asignacion.assignSwimmerDirectly(
      { clubId: a.id, personId: persona.id, fechaEfectiva: "2026-05-10" },
      { userId: admin.id }
    );
    await expect(
      asignacion.reassignSwimmerToClub(
        persona.id,
        b.id,
        { userId: admin.id },
        { fechaEfectiva: "2026-05-10", confirmarFinDeMembresiaId: vigente.id, aceptarHistorialIncompleto: true }
      )
    ).rejects.toMatchObject({ code: "CONFLICTO_DE_FECHAS" });
  });

  it("historial con término desconocido: exige aceptación explícita, la audita y no completa ningún registro", async () => {
    const a = await nuevoClub("his");
    const b = await nuevoClub("his");
    const persona = await nuevaPersona();
    // Una membresía finalizada ANTES de C-05: término desconocido y end_date hoy.
    const antigua = await prisma.clubSwimmer.create({
      data: {
        clubId: a.id,
        personId: persona.id,
        status: "ended",
        requestedByUserId: admin.id,
        startDate: new Date("2025-01-01T00:00:00Z"),
        endDate: new Date(),
      },
    });
    await expect(
      asignacion.assignSwimmerDirectly({ clubId: b.id, personId: persona.id, fechaEfectiva: "2026-06-01" }, { userId: admin.id })
    ).rejects.toMatchObject({
      code: "HISTORIAL_INCOMPLETO",
      details: { membresias: [antigua.id] },
    });
    const ok = await asignacion.assignSwimmerDirectly(
      { clubId: b.id, personId: persona.id, fechaEfectiva: "2026-06-01", aceptarHistorialIncompleto: true },
      { userId: admin.id }
    );
    const registro = await prisma.auditLog.findFirstOrThrow({ where: { entityId: ok.id, action: "SWIMMER_ASSIGNMENT_DIRECT" } });
    expect((registro.after as { historialIncompletoAceptado: string[] }).historialIncompletoAceptado).toEqual([antigua.id]);
    expect((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: antigua.id } })).fechaTermino, "no se completa").toBeNull();
  });

  it("masiva: la fila con historial incompleto lleva su código y se puede reintentar SOLA con aceptación explícita", async () => {
    const a = await nuevoClub("bhi");
    const b = await nuevoClub("bhi");
    const conIncertidumbre = await nuevaPersona();
    const limpia = await nuevaPersona();
    const antigua = await prisma.clubSwimmer.create({
      data: { clubId: a.id, personId: conIncertidumbre.id, status: "ended", requestedByUserId: admin.id, startDate: new Date("2025-01-01T00:00:00Z"), endDate: new Date() },
    });
    const primera = await asignacion.bulkAssignSwimmers({ targetClubId: b.id, personIds: [conIncertidumbre.id, limpia.id], fechaEfectiva: "2026-06-01" }, { userId: admin.id });
    const porId = Object.fromEntries(primera.results.map((r) => [r.personId, r]));
    expect(porId[conIncertidumbre.id]).toMatchObject({ status: "error", codigo: "HISTORIAL_INCOMPLETO" });
    expect(porId[limpia.id]).toMatchObject({ status: "assigned" });
    expect(porId[limpia.id]!.codigo, "una fila asignada no trae código").toBeUndefined();

    const reintento = await asignacion.bulkAssignSwimmers(
      { targetClubId: b.id, personIds: [conIncertidumbre.id], fechaEfectiva: "2026-06-01", aceptarHistorialIncompleto: true },
      { userId: admin.id }
    );
    expect(reintento).toMatchObject({ assignedCount: 1, errorCount: 0 });
    const nueva = await prisma.clubSwimmer.findFirstOrThrow({ where: { personId: conIncertidumbre.id, clubId: b.id, status: "active" } });
    const registro = await prisma.auditLog.findFirstOrThrow({ where: { entityId: nueva.id, action: "SWIMMER_ASSIGNMENT_DIRECT" } });
    expect((registro.after as { historialIncompletoAceptado: string[] }).historialIncompletoAceptado).toEqual([antigua.id]);
  });

  it("masiva: un conflicto conocido conserva su código y no se elude con la aceptación", async () => {
    const a = await nuevoClub("bcf");
    const b = await nuevoClub("bcf");
    const persona = await nuevaPersona();
    await prisma.clubSwimmer.create({
      data: { clubId: a.id, personId: persona.id, status: "ended", requestedByUserId: admin.id, startDate: new Date("2025-01-01T00:00:00Z"), endDate: new Date(), fechaTermino: new Date("2026-05-31T00:00:00Z") },
    });
    const r = await asignacion.bulkAssignSwimmers(
      { targetClubId: b.id, personIds: [persona.id], fechaEfectiva: "2026-05-15", aceptarHistorialIncompleto: true },
      { userId: admin.id }
    );
    expect(r.results[0]).toMatchObject({ status: "error", codigo: "CONFLICTO_DE_FECHAS" });
    expect(await prisma.clubSwimmer.count({ where: { personId: persona.id, clubId: b.id } })).toBe(0);
  });

  it("un término CONOCIDO posterior a la fecha nueva bloquea aunque se acepte la incertidumbre; un término desconocido con la operación anterior sigue exigiendo aceptación", async () => {
    const a = await nuevoClub("con");
    const b = await nuevoClub("con");
    const persona = await nuevaPersona();
    await prisma.clubSwimmer.create({
      data: {
        clubId: a.id,
        personId: persona.id,
        status: "ended",
        requestedByUserId: admin.id,
        startDate: new Date("2025-01-01T00:00:00Z"),
        endDate: new Date("2025-08-01T15:00:00Z"),
        fechaTermino: new Date("2025-07-31T00:00:00Z"),
      },
    });
    await expect(
      asignacion.assignSwimmerDirectly(
        { clubId: b.id, personId: persona.id, fechaEfectiva: "2025-07-01", aceptarHistorialIncompleto: true },
        { userId: admin.id }
      )
    ).rejects.toMatchObject({ code: "CONFLICTO_DE_FECHAS" });

    // Término desconocido con la OPERACIÓN (end_date) anterior a la fecha nueva: sigue siendo
    // incompleta. end_date no acredita una fecha de pertenencia ni omite la aceptación.
    const otra = await nuevaPersona();
    const desconocida = await prisma.clubSwimmer.create({
      data: {
        clubId: a.id,
        personId: otra.id,
        status: "ended",
        requestedByUserId: admin.id,
        startDate: new Date("2025-01-01T00:00:00Z"),
        endDate: new Date("2025-08-01T15:00:00Z"),
      },
    });
    await expect(
      asignacion.assignSwimmerDirectly({ clubId: b.id, personId: otra.id, fechaEfectiva: "2025-09-01" }, { userId: admin.id })
    ).rejects.toMatchObject({ code: "HISTORIAL_INCOMPLETO", details: { membresias: [desconocida.id] } });
    expect(await prisma.clubSwimmer.count({ where: { personId: otra.id, clubId: b.id } }), "el rechazo no crea nada").toBe(0);
    const ok = await asignacion.assignSwimmerDirectly(
      { clubId: b.id, personId: otra.id, fechaEfectiva: "2025-09-01", aceptarHistorialIncompleto: true },
      { userId: admin.id }
    );
    const registro = await prisma.auditLog.findFirstOrThrow({ where: { entityId: ok.id, action: "SWIMMER_ASSIGNMENT_DIRECT" } });
    expect((registro.after as { historialIncompletoAceptado: string[] }).historialIncompletoAceptado).toEqual([desconocida.id]);
    expect((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: desconocida.id } })).fechaTermino, "no se infiere el término").toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Solicitudes de alta: resolución administrativa
// ---------------------------------------------------------------------------

describe("9. resolución de solicitudes de alta", () => {
  async function solicitudPendiente(club: Club, run = runLibre()) {
    const r = await postular(club.token, run);
    const paso = await segundoPaso(club.token, { intentoId: r.json().intentoId, nombres: "Ana", apellidos: "Sintética" });
    return { id: paso.json().solicitud.id as string, run };
  }
  const DATOS = { firstName: "Ana", paternalLastName: "Sintética", birthDate: "1990-05-05", gender: "female" };
  const aprobar = (id: string, cuerpo: object) =>
    app.inject({ method: "POST", url: `/swimmer-assignments/altas/${id}/aprobar`, headers: auth(admin.token), payload: cuerpo });

  it("crear: registra a la persona, la asigna al club solicitante y deja la solicitud aprobada", async () => {
    const club = await nuevoClub("alc");
    const s = await solicitudPendiente(club);
    const delClub = await app.inject({
      method: "POST",
      url: `/swimmer-assignments/altas/${s.id}/aprobar`,
      headers: auth(club.token),
      payload: { modo: "crear", datosPersona: DATOS },
    });
    expect(delClub.statusCode, "solo administración resuelve").toBe(403);
    const res = await aprobar(s.id, { modo: "crear", datosPersona: DATOS });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ estado: "aprobada", persona: { run: s.run } });
    expect(await prisma.clubSwimmer.count({ where: { clubId: club.id, personId: res.json().persona.id, status: "active" } })).toBe(1);
    expect((await aprobar(s.id, { modo: "crear", datosPersona: DATOS })).json().error).toBe("SOLICITUD_YA_RESUELTA");
  });

  it("coincidencia SOLO con eliminadas: sin confirmación expresa 409; con ella, una persona NUEVA sin modificar ni heredar nada", async () => {
    const club = await nuevoClub("ale");
    const otroClub = await nuevoClub("ale");
    const run = runLibre();
    const eliminada = await prisma.person.create({
      data: {
        run,
        firstName: "Antigua",
        paternalLastName: "Sintetica",
        fullName: "Antigua Sintetica",
        birthDate: new Date("1970-01-01"),
        gender: "female",
        status: "active",
        deletedAt: new Date("2025-01-01T00:00:00Z"),
      },
    });
    const membresiaVieja = await prisma.clubSwimmer.create({
      data: {
        clubId: otroClub.id,
        personId: eliminada.id,
        status: "ended",
        requestedByUserId: admin.id,
        endDate: new Date("2024-12-31T12:00:00Z"),
      },
    });
    const s = await solicitudPendiente(club, run);

    const detalle = await app.inject({ method: "GET", url: `/swimmer-assignments/altas/${s.id}`, headers: auth(admin.token) });
    expect(detalle.json().coincidencias.eliminadas.map((e: { id: string }) => e.id)).toEqual([eliminada.id]);
    const sinConfirmar = await aprobar(s.id, { modo: "crear", datosPersona: DATOS });
    expect(sinConfirmar.json()).toMatchObject({ error: "COINCIDENCIA_ELIMINADA", details: { personasEliminadas: [eliminada.id] } });

    const res = await aprobar(s.id, {
      modo: "crear",
      datosPersona: DATOS,
      crearPeseACoincidenciaEliminada: true,
      aceptarHistorialIncompleto: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    const nueva = res.json().persona.id;
    expect(nueva).not.toBe(eliminada.id);
    const despues = await prisma.person.findUniqueOrThrow({ where: { id: eliminada.id } });
    expect(despues.deletedAt, "la eliminada no se restaura").not.toBeNull();
    expect(despues.updatedAt.getTime()).toBe(eliminada.updatedAt.getTime());
    expect(
      (await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: membresiaVieja.id } })).personId,
      "sus relaciones siguen con ella"
    ).toBe(eliminada.id);
    expect(await prisma.user.count({ where: { personId: nueva } }), "sin cuentas heredadas").toBe(0);
    expect(await prisma.clubSwimmer.count({ where: { personId: nueva } }), "solo la membresía nueva").toBe(1);
    expect((await prisma.solicitudAltaIncorporacion.findUniqueOrThrow({ where: { id: s.id } })).personaCreadaPeseAEliminada).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "PERSON_CREATED_DESPITE_DELETED_MATCH", entityId: nueva } })).toBe(1);
  });

  it("vincular: exige la persona revisada; si ya hay una propuesta pendiente de ese club, se resuelve por ella", async () => {
    const club = await nuevoClub("alv");
    const s = await solicitudPendiente(club);
    const persona = await createPerson({ run: s.run, username: `vinc.${++correlativo}`, firstName: "Vinculada", gender: "female" });
    const otra = await nuevaPersona();
    expect((await aprobar(s.id, { modo: "crear", datosPersona: DATOS })).json().error, "ya registrada: hay que vincular").toBe(
      "PERSONA_YA_REGISTRADA"
    );
    expect((await aprobar(s.id, { modo: "vincular", personaEsperadaId: otra.id })).json().error).toBe("PERSONA_DISTINTA");
    const ok = await aprobar(s.id, { modo: "vincular", personaEsperadaId: persona.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().estado).toBe("aprobada");

    const s2 = await solicitudPendiente(club);
    const p2 = await createPerson({ run: s2.run, username: `vinc.${++correlativo}`, firstName: "ConPropuesta", gender: "female" });
    const propuesta = await prisma.clubSwimmer.create({
      data: { clubId: club.id, personId: p2.id, status: "pending", requestedByUserId: admin.id },
    });
    const res = await aprobar(s2.id, { modo: "vincular", personaEsperadaId: p2.id });
    expect(res.json().estado).toBe("resuelta_por_propuesta");
    expect((await prisma.solicitudAltaIncorporacion.findUniqueOrThrow({ where: { id: s2.id } })).propuestaExistenteId).toBe(propuesta.id);
    expect(await prisma.clubSwimmer.count({ where: { personId: p2.id } }), "no se crea otra membresía").toBe(1);
  });

  it("rechazar conserva la solicitud como historial", async () => {
    const club = await nuevoClub("alr");
    const s = await solicitudPendiente(club);
    const res = await app.inject({
      method: "POST",
      url: `/swimmer-assignments/altas/${s.id}/rechazar`,
      headers: auth(admin.token),
      payload: { motivo: "Datos no verificables (sintético)" },
    });
    expect(res.json()).toMatchObject({ estado: "rechazada", motivoRechazo: "Datos no verificables (sintético)" });
  });
});

// ---------------------------------------------------------------------------
// 10. Baja simple con fecha de término elegida
// ---------------------------------------------------------------------------

describe("10. baja simple con fecha de término elegida", () => {
  const baja = (token: string, id: string, cuerpo?: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/swimmer-assignments/${id}/end`,
      headers: auth(token),
      ...(cuerpo === undefined ? {} : { payload: cuerpo }),
    });

  /** Membresía activa en un club nuevo, con inicio conocido. */
  async function activaDesde(inicio: string) {
    const club = await nuevoClub("baj");
    const persona = await nuevaPersona();
    const membresia = await asignacion.assignSwimmerDirectly({ clubId: club.id, personId: persona.id, fechaEfectiva: inicio }, { userId: admin.id });
    return { club, persona, membresia };
  }

  /** Estado observable de la membresía y de su auditoría de baja, para comprobar que nada cambió. */
  async function estado(id: string) {
    const fila = await prisma.clubSwimmer.findUniqueOrThrow({ where: { id } });
    return {
      status: fila.status,
      fechaTermino: fila.fechaTermino,
      endDate: fila.endDate,
      bajas: await prisma.auditLog.count({ where: { entityId: id, action: "SWIMMER_ASSIGNMENT_ENDED" } }),
    };
  }
  const SIN_CAMBIOS = { status: "active", fechaTermino: null, endDate: null, bajas: 0 };

  it("baja retroactiva: fecha_termino guarda la fecha elegida, end_date y la auditoría el instante real; otra membresía puede empezar después", async () => {
    const { club, persona, membresia } = await activaDesde("2026-01-10");
    const alta = await prisma.auditLog.findFirstOrThrow({ where: { entityId: membresia.id, action: "SWIMMER_ASSIGNMENT_DIRECT" } });
    const antes = new Date();
    const res = await baja(club.token, membresia.id, { fechaTermino: "2026-03-31" });
    const despues = new Date();
    expect(res.statusCode, res.body).toBe(200);

    const fila = await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: membresia.id } });
    expect(fila.status).toBe("ended");
    expect(utcDia(fila.fechaTermino)).toBe("2026-03-31");
    // El instante de la operación es el real: no retrocede a la fecha elegida.
    expect(fila.endDate!.getTime()).toBeGreaterThanOrEqual(antes.getTime() - 1000);
    expect(fila.endDate!.getTime()).toBeLessThanOrEqual(despues.getTime() + 1000);
    const registro = await prisma.auditLog.findFirstOrThrow({ where: { entityId: membresia.id, action: "SWIMMER_ASSIGNMENT_ENDED" } });
    expect(registro.createdAt.getTime()).toBeGreaterThanOrEqual(antes.getTime() - 1000);
    expect(registro.userId).toBe(club.usuarioId);
    expect(registro.after).toMatchObject({ status: "ended", fechaTermino: "2026-03-31T00:00:00.000Z", historialIncompletoAceptado: [] });
    // No se modifican operaciones anteriores.
    expect(await prisma.auditLog.findUniqueOrThrow({ where: { id: alta.id } })).toEqual(alta);

    const otro = await nuevoClub("baj");
    await expect(
      asignacion.assignSwimmerDirectly({ clubId: otro.id, personId: persona.id, fechaEfectiva: "2026-03-31" }, { userId: admin.id })
    ).rejects.toMatchObject({ code: "CONFLICTO_DE_FECHAS" });
    await expect(
      asignacion.assignSwimmerDirectly({ clubId: otro.id, personId: persona.id, fechaEfectiva: "2026-04-01" }, { userId: admin.id })
    ).resolves.toMatchObject({ status: "active" });
  });

  it("baja hasta hoy inclusive: otra membresía no puede empezar hoy (solo después de hoy)", async () => {
    const { club, persona, membresia } = await activaDesde("2026-01-10");
    const res = await baja(club.token, membresia.id, { fechaTermino: HOY() });
    expect(res.statusCode, res.body).toBe(200);
    expect(utcDia((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: membresia.id } })).fechaTermino)).toBe(HOY());
    const otro = await nuevoClub("baj");
    await expect(
      asignacion.assignSwimmerDirectly({ clubId: otro.id, personId: persona.id, fechaEfectiva: HOY() }, { userId: admin.id })
    ).rejects.toMatchObject({ code: "CONFLICTO_DE_FECHAS" });
    expect(await prisma.clubSwimmer.count({ where: { personId: persona.id, clubId: otro.id } })).toBe(0);
  });

  it("la fecha de término igual al inicio es válida", async () => {
    const { club, membresia } = await activaDesde("2026-02-02");
    const res = await baja(club.token, membresia.id, { fechaTermino: "2026-02-02" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "ended" });
    expect(utcDia((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: membresia.id } })).fechaTermino)).toBe("2026-02-02");
  });

  it("rechaza sin cambiar nada: fecha ausente, vacía, mal formada, inexistente, futura, anterior al inicio o campos extra", async () => {
    const { club, membresia } = await activaDesde("2026-01-10");
    const casos: [Record<string, unknown> | undefined, number, string][] = [
      [undefined, 400, "sin cuerpo"],
      [{}, 400, "sin fecha"],
      [{ fechaTermino: "" }, 400, "vacía"],
      [{ fechaTermino: null }, 400, "nula"],
      [{ fechaTermino: "31-03-2026" }, 400, "formato"],
      [{ fechaTermino: "2026-03-31T00:00:00Z" }, 400, "con hora"],
      [{ fechaTermino: "2026-02-30" }, 400, "inexistente"],
      [{ fechaTermino: "2026-13-01" }, 400, "mes inexistente"],
      [{ fechaTermino: "2099-01-01" }, 400, "futura"],
      [{ fechaTermino: "2026-01-09" }, 409, "anterior al inicio"],
      [{ fechaTermino: "2026-03-31", endDate: "2026-03-31" }, 400, "campo extra"],
    ];
    for (const [cuerpo, codigo, caso] of casos) {
      const res = await baja(club.token, membresia.id, cuerpo);
      expect(res.statusCode, `${caso}: ${res.body}`).toBe(codigo);
    }
    expect((await baja(club.token, membresia.id, { fechaTermino: "2099-01-01" })).json().error).toBe("FECHA_FUTURA");
    expect((await baja(club.token, membresia.id, { fechaTermino: "2026-01-09" })).json().error).toBe("CONFLICTO_DE_FECHAS");
    expect(await estado(membresia.id)).toEqual(SIN_CAMBIOS);
  });

  it("el límite de «hoy» es el día de Santiago del instante de la operación", async () => {
    const { membresia } = await activaDesde("2026-01-10");
    // 2026-11-13 02:59:59Z = 2026-11-12 23:59:59 en Santiago (UTC-3): el 13 todavía es futuro.
    const ahora = new Date("2026-11-13T02:59:59Z");
    await expect(asignacion.endAssignment(membresia.id, admin.actor, { fechaTermino: "2026-11-13" }, { ahora })).rejects.toMatchObject({
      code: "FECHA_FUTURA",
      details: { hoy: "2026-11-12" },
    });
    expect(await estado(membresia.id)).toEqual(SIN_CAMBIOS);
    const r = await asignacion.endAssignment(membresia.id, admin.actor, { fechaTermino: "2026-11-12" }, { ahora });
    expect(utcDia(r.fechaTermino)).toBe("2026-11-12");
    expect(r.endDate?.toISOString(), "end_date es el instante de la operación").toBe(ahora.toISOString());
  });

  it("alcance y permisos: nadador 403, club ajeno 403, club propio y administración sí; el club no puede aceptar incertidumbre", async () => {
    const { club, membresia } = await activaDesde("2026-01-10");
    const ajeno = await nuevoClub("baj");
    const nadadora = await createPerson({ run: runValido(60600000 + ++correlativo), username: `nad.${correlativo}`, firstName: "Nadadora", gender: "female" });
    await createUser({ username: `nad.${correlativo}`, roleNames: ["swimmer"], personId: nadadora.id });
    const tokenNadadora = await login(`nad.${correlativo}`);
    const cuerpo = { fechaTermino: "2026-03-31" };

    expect((await baja(tokenNadadora, membresia.id, cuerpo)).statusCode, "nadador").toBe(403);
    expect((await baja(ajeno.token, membresia.id, cuerpo)).statusCode, "club ajeno").toBe(403);
    expect((await baja(club.token, membresia.id, { ...cuerpo, aceptarHistorialIncompleto: true })).statusCode, "club que se otorga la aceptación").toBe(403);
    expect((await baja(club.token, "00000000-0000-0000-0000-000000000000", cuerpo)).statusCode, "inexistente").toBe(404);
    expect(await estado(membresia.id)).toEqual(SIN_CAMBIOS);
    expect((await baja(club.token, membresia.id, cuerpo)).statusCode, "club propio").toBe(200);

    const otra = await activaDesde("2026-01-10");
    expect((await baja(admin.token, otra.membresia.id, cuerpo)).statusCode, "administración").toBe(200);
  });

  it("inicio desconocido: no se inventa; el club recibe 409 (requiere administración) y solo administración acepta, auditado", async () => {
    const club = await nuevoClub("baj");
    const persona = await nuevaPersona();
    const sinInicio = await prisma.clubSwimmer.create({
      data: { clubId: club.id, personId: persona.id, status: "active", requestedByUserId: admin.id },
    });
    const cuerpo = { fechaTermino: "2026-03-31" };

    const delClub = await baja(club.token, sinInicio.id, cuerpo);
    expect(delClub.statusCode).toBe(409);
    expect(delClub.json()).toMatchObject({ error: "HISTORIAL_INCOMPLETO", details: { membresias: [sinInicio.id], requiereAdministracion: true } });
    expect((await baja(club.token, sinInicio.id, { ...cuerpo, aceptarHistorialIncompleto: true })).statusCode).toBe(403);
    expect((await baja(admin.token, sinInicio.id, cuerpo)).json().error, "administración también debe aceptar expresamente").toBe("HISTORIAL_INCOMPLETO");
    expect(await estado(sinInicio.id)).toEqual(SIN_CAMBIOS);

    const ok = await baja(admin.token, sinInicio.id, { ...cuerpo, aceptarHistorialIncompleto: true });
    expect(ok.statusCode, ok.body).toBe(200);
    const fila = await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: sinInicio.id } });
    expect(fila.startDate, "el inicio no se completa").toBeNull();
    expect(utcDia(fila.fechaTermino)).toBe("2026-03-31");
    const registro = await prisma.auditLog.findFirstOrThrow({ where: { entityId: sinInicio.id, action: "SWIMMER_ASSIGNMENT_ENDED" } });
    expect(registro.userId).toBe(admin.id);
    expect((registro.after as { historialIncompletoAceptado: string[] }).historialIncompletoAceptado).toEqual([sinInicio.id]);
  });

  it("si falla la auditoría de la baja, se revierte todo: la membresía sigue activa y los roles no cambian", async () => {
    const { persona, membresia } = await activaDesde("2026-01-10");
    const roles = async () =>
      (await prisma.personRole.findMany({ where: { personId: persona.id }, orderBy: { id: "asc" } })).map((r) => JSON.stringify(r));
    const rolesAntes = await roles();
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION c05_fallo_baja() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fallo inyectado en la auditoría de la baja (prueba)'; END $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER c05_fallo_baja BEFORE INSERT ON audit_logs FOR EACH ROW
      WHEN (NEW.action = 'SWIMMER_ASSIGNMENT_ENDED') EXECUTE FUNCTION c05_fallo_baja()`);
    try {
      await expect(asignacion.endAssignment(membresia.id, admin.actor, { fechaTermino: "2026-03-31" })).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS c05_fallo_baja ON audit_logs`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS c05_fallo_baja()`);
    }
    expect(await estado(membresia.id)).toEqual(SIN_CAMBIOS);
    expect(await roles()).toEqual(rolesAntes);
  });

  describe("concurrencia con reasignar (protocolo común)", () => {
    async function vigenteEnOrigen() {
      const origen = await nuevoClub("bcr");
      const destino = await nuevoClub("bcr");
      const persona = await nuevaPersona({ status: "locked" });
      const vigente = await asignacion.assignSwimmerDirectly({ clubId: origen.id, personId: persona.id, fechaEfectiva: "2026-01-10" }, { userId: admin.id });
      return { origen, destino, persona, vigente };
    }
    const capturar = <T>(p: Promise<T>): Promise<T | AppError> =>
      p.then(
        (r) => r,
        (e: AppError) => e
      );

    it("si reasignar va primero, la baja encuentra la membresía ya finalizada (409) y no pisa el término del traslado", async () => {
      const { origen, destino, persona, vigente } = await vigenteEnOrigen();
      const retencion = await retener(`c05:persona:${persona.id}`);
      const reasignacion = capturar(
        asignacion.reassignSwimmerToClub(persona.id, destino.id, { userId: admin.id }, { fechaEfectiva: "2026-02-01", confirmarFinDeMembresiaId: vigente.id })
      );
      await enEspera(1, ESPERA_BLOQUEO);
      const fin = capturar(asignacion.endAssignment(vigente.id, origen.actor, { fechaTermino: "2026-01-20" }));
      await enEspera(2, ESPERA_BLOQUEO);
      await retencion.soltar();
      expect(await reasignacion).toMatchObject({ status: "active", clubId: destino.id });
      expect(await fin).toMatchObject({ code: "MEMBRESIA_NO_ACTIVA" });
      expect(utcDia((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: vigente.id } })).fechaTermino), "término del traslado").toBe("2026-01-31");
    });

    it("si la baja va primero, la reasignación confirmada exige revisar de nuevo y no activa nada", async () => {
      const { origen, destino, persona, vigente } = await vigenteEnOrigen();
      const retencion = await retener(`c05:persona:${persona.id}`);
      const fin = capturar(asignacion.endAssignment(vigente.id, origen.actor, { fechaTermino: "2026-01-20" }));
      await enEspera(1, ESPERA_BLOQUEO);
      const reasignacion = capturar(
        asignacion.reassignSwimmerToClub(persona.id, destino.id, { userId: admin.id }, { fechaEfectiva: "2026-02-01", confirmarFinDeMembresiaId: vigente.id })
      );
      await enEspera(2, ESPERA_BLOQUEO);
      await retencion.soltar();
      expect(await fin).toMatchObject({ status: "ended" });
      expect(await reasignacion).toMatchObject({ code: "REVISAR_DE_NUEVO" });
      expect(utcDia((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: vigente.id } })).fechaTermino), "término elegido").toBe("2026-01-20");
      expect(await prisma.clubSwimmer.count({ where: { personId: persona.id, clubId: destino.id } })).toBe(0);
    });
  });
});

/** Fecha de calendario de una columna DATE leída por Prisma (medianoche UTC). */
function utcDia(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
