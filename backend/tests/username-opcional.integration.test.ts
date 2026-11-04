/**
 * Etapa 9 — nombre de usuario OPCIONAL y credenciales de acceso, contra la base real.
 *
 * Lo que se comprueba, para personas y para clubes:
 *
 *   1. Se registran sin nombre (NULL), sin generar nombres ni cuentas, y la
 *      reserva global no guarda nada por ellos.
 *   2. Sin cuenta, el nombre se asigna, cambia y quita; la reserva se toma y se
 *      libera en consecuencia.
 *   3. La unicidad sigue siendo GLOBAL entre personas, clubes y cuentas.
 *   4. «Crear credenciales» usa el nombre del cuerpo o el guardado; sin
 *      ninguno, 400 sin escribir. Asignar y crear la cuenta es atómico: un
 *      fallo no deja nombre cambiado, reserva suelta ni cuenta a medias, y el
 *      nombre sigue editable.
 *   5. Con cuenta vigente (activa, bloqueada o inhabilitada) el nombre queda
 *      bloqueado, en el servicio y en la base. Restablecer la contraseña no lo
 *      toca. La cuenta creada inicia sesión.
 *   6. Carreras reales con DOS conexiones: el solapamiento está garantizado por
 *      construcción, no por suerte (mismo método que
 *      `identity-guards-concurrency.integration.test.ts`).
 *
 * En cada escenario se verifica además el invariante del registro de nombres
 * con la MISMA consulta que usa el preflight (`reservas-de-username-incoherentes`):
 * ningún titular con nombre sin su reserva, ninguna reserva huérfana.
 *
 * Solo corre contra la base desechable (`vitest.integration.config.ts`), con
 * datos sintéticos.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Client } from "pg";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, TEST_PASSWORD } from "./helpers/seedRbac";
import * as personsService from "../src/modules/persons/persons.service";
import * as clubsService from "../src/modules/clubs/clubs.service";
import * as assignmentService from "../src/modules/swimmer-assignment/assignment.service";
import { buildServer } from "../src/server";
import { ConflictError, ValidationError } from "../src/shared/errors";
import { MENSAJE_FALTA_USERNAME, MENSAJE_NOMBRE_BLOQUEADO } from "../src/shared/username";
import { CHECKS } from "../scripts/migrationChecks";

let ADMIN: { userId: string };
const ADMIN_USERNAME = "admin_opcional";

const PERSONA_BASE = { firstName: "Ana", paternalLastName: "Prueba", birthDate: new Date("1990-01-01"), gender: "female" as const };
const CLUB_BASE = {
  hasLegalStatus: false,
  isAchmnMember: false,
  isAchmnCollaborator: false,
  isFchmnMember: false,
  isFchmnCollaborator: false,
};

let secuencia = 0;
const siguiente = () => ++secuencia;

async function nuevaPersona(username?: string | null) {
  const n = siguiente();
  return personsService.createPerson({ ...PERSONA_BASE, run: `${10_000_000 + n}-1`, username }, ADMIN);
}

async function nuevoClub(username?: string | null) {
  const n = siguiente();
  return clubsService.createClub({ ...CLUB_BASE, name: `Club ${n}`, code: `C${n}`, username }, ADMIN);
}

/** Da a la persona el rol de nadador, sin el cual no puede tener cuenta. */
async function conRolDeAcceso(personId: string) {
  const club = await nuevoClub();
  await assignmentService.assignSwimmerDirectly({ clubId: club.id, personId }, ADMIN);
}

/**
 * Invariante del registro de nombres, con la consulta del preflight: ningún
 * titular vigente CON NOMBRE sin su reserva, ninguna reserva con dueño
 * equivocado y ninguna huérfana.
 */
async function expectReservasCoherentes() {
  const check = CHECKS.find((c) => c.id === "reservas-de-username-incoherentes")!;
  const filas = await prisma.$queryRawUnsafe<unknown[]>(check.query);
  expect(filas, "el registro de nombres debe describir exactamente a los titulares").toEqual([]);
}

const reservaDe = (username: string) => prisma.usernameReservation.findUnique({ where: { username } });

/** Adapta personas y clubes a una misma interfaz para recorrer los dos. */
interface Titular {
  tipo: "persona" | "club";
  ownerKind: "person" | "club";
  crear: (username?: string | null) => Promise<{ id: string }>;
  editarUsername: (id: string, username: string | null) => Promise<unknown>;
  crearCredenciales: (id: string, username?: string | null) => Promise<{ username: string; temporaryPassword: string }>;
  restablecer: (id: string) => Promise<{ temporaryPassword: string }>;
  bloquear: (id: string) => Promise<unknown>;
  inhabilitar: (id: string) => Promise<unknown>;
  usernameDe: (id: string) => Promise<string | null>;
  cuentasDe: (id: string) => Promise<number>;
  tabla: "persons" | "clubs";
}

const TITULARES: Titular[] = [
  {
    tipo: "persona",
    ownerKind: "person",
    crear: async (username) => {
      const p = await nuevaPersona(username);
      await conRolDeAcceso(p.id);
      return p;
    },
    editarUsername: (id, username) => personsService.updatePerson(id, { username }, ADMIN),
    crearCredenciales: (id, username) => personsService.createCredentials(id, ADMIN, { username }),
    restablecer: (id) => personsService.resetCredentials(id, ADMIN),
    bloquear: (id) => personsService.blockPerson(id, ADMIN),
    inhabilitar: (id) => personsService.disablePerson(id, ADMIN),
    usernameDe: async (id) => (await prisma.person.findUniqueOrThrow({ where: { id } })).username,
    cuentasDe: (id) => prisma.user.count({ where: { personId: id } }),
    tabla: "persons",
  },
  {
    tipo: "club",
    ownerKind: "club",
    crear: (username) => nuevoClub(username),
    editarUsername: (id, username) => clubsService.updateClub(id, { hasLegalStatus: false, username }, ADMIN),
    crearCredenciales: (id, username) => clubsService.createClubCredentials(id, ADMIN, { username }),
    restablecer: (id) => clubsService.resetClubCredentials(id, ADMIN),
    bloquear: (id) => clubsService.blockClub(id, ADMIN),
    inhabilitar: (id) => clubsService.disableClub(id, ADMIN),
    usernameDe: async (id) => (await prisma.club.findUniqueOrThrow({ where: { id } })).username,
    cuentasDe: (id) => prisma.user.count({ where: { clubId: id } }),
    tabla: "clubs",
  },
];

/** El error con que terminó una promesa, o `null` si se cumplió. */
const errorDe = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: ADMIN_USERNAME, roleNames: ["admin"] });
  ADMIN = { userId: admin.id };
});

const conexiones: Client[] = [];

afterAll(async () => {
  await Promise.all(conexiones.map((c) => c.end().catch(() => void 0)));
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. Titulares sin nombre
// ---------------------------------------------------------------------------

describe("titulares sin nombre de usuario", () => {
  it("varias personas y varios clubes se registran sin nombre, sin cuenta y sin reservas", async () => {
    const personas = [await nuevaPersona(), await nuevaPersona(null), await nuevaPersona()];
    const clubes = [await nuevoClub(), await nuevoClub(null), await nuevoClub()];

    for (const t of [...personas, ...clubes]) expect(t.username).toBeNull();

    const ids = [...personas, ...clubes].map((t) => t.id);
    expect(await prisma.usernameReservation.count({ where: { ownerId: { in: ids } } }), "un titular sin nombre no reserva nada").toBe(0);
    expect(await prisma.user.count({ where: { OR: [{ personId: { in: ids } }, { clubId: { in: ids } }] } }), "no se crea ninguna cuenta").toBe(0);
    // La ausencia es NULL, nunca una cadena vacía.
    const vacios = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT (SELECT count(*) FROM persons WHERE username = '')::int + (SELECT count(*) FROM clubs WHERE username = '')::int AS n`
    );
    expect(vacios[0]!.n).toBe(0);
    await expectReservasCoherentes();
  });

  it("la base rechaza la cadena vacía aunque se salte la API", async () => {
    const p = await nuevaPersona();
    const c = await nuevoClub();
    await expect(prisma.$executeRawUnsafe(`UPDATE persons SET username = '' WHERE id = $1`, p.id)).rejects.toThrow(/persons_username_no_vacio/);
    await expect(prisma.$executeRawUnsafe(`UPDATE clubs SET username = '   ' WHERE id = $1`, c.id)).rejects.toThrow(/clubs_username_no_vacio/);
  });
});

// ---------------------------------------------------------------------------
// 2 y 3. Asignar, cambiar y quitar sin cuenta; unicidad global
// ---------------------------------------------------------------------------

describe.each(TITULARES)("sin cuenta, el nombre es editable ($tipo)", (t) => {
  it("asignar, cambiar y quitar: la reserva se toma y se libera", async () => {
    const titular = await t.crear();

    await t.editarUsername(titular.id, "nombre.uno");
    expect(await t.usernameDe(titular.id)).toBe("nombre.uno");
    expect(await reservaDe("nombre.uno")).toMatchObject({ ownerKind: t.ownerKind, ownerId: titular.id });

    await t.editarUsername(titular.id, "nombre.dos");
    expect(await t.usernameDe(titular.id)).toBe("nombre.dos");
    expect(await reservaDe("nombre.uno"), "el nombre anterior queda libre").toBeNull();
    expect(await reservaDe("nombre.dos")).toMatchObject({ ownerId: titular.id });

    await t.editarUsername(titular.id, null);
    expect(await t.usernameDe(titular.id)).toBeNull();
    expect(await reservaDe("nombre.dos"), "quitarlo también lo libera").toBeNull();
    expect(await prisma.usernameReservation.count({ where: { ownerId: titular.id } })).toBe(0);
    await expectReservasCoherentes();

    // Liberado de verdad: otro titular puede tomarlo.
    const otro = await nuevaPersona("nombre.uno");
    expect(otro.username).toBe("nombre.uno");
    await expectReservasCoherentes();
  });

  it.each([
    ["una persona", async () => void (await nuevaPersona("tomado.x"))],
    ["un club", async () => void (await nuevoClub("tomado.x"))],
    [
      "una cuenta del sistema",
      async () => void (await createUser({ username: "tomado.x", roleNames: ["admin"] })),
    ],
  ])("no puede tomar el nombre que ya tiene %s", async (_, ocupar) => {
    await ocupar();
    const titular = await t.crear("propio.nombre");

    const error = await errorDe(t.editarUsername(titular.id, "tomado.x"));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toMatch(/ya está en uso/);
    expect(await t.usernameDe(titular.id), "el nombre no cambió").toBe("propio.nombre");
    await expectReservasCoherentes();
  });

  it("tampoco al registrarse", async () => {
    await nuevaPersona("ya.existe");
    await expect(t.crear("ya.existe")).rejects.toThrow(/ya está en uso/);
  });
});

// ---------------------------------------------------------------------------
// 4. Crear credenciales
// ---------------------------------------------------------------------------

describe.each(TITULARES)("crear credenciales ($tipo)", (t) => {
  it("con nombre guardado y SIN cuerpo: usa el guardado", async () => {
    const titular = await t.crear("guardado.uno");
    const r = await t.crearCredenciales(titular.id);
    expect(r.username).toBe("guardado.uno");
    expect(await t.cuentasDe(titular.id)).toBe(1);
    await expectReservasCoherentes();
  });

  it("sin nombre guardado y SIN cuerpo: 400 y no escribe nada", async () => {
    const titular = await t.crear();
    const error = await errorDe(t.crearCredenciales(titular.id));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe(MENSAJE_FALTA_USERNAME);
    expect(await t.cuentasDe(titular.id)).toBe(0);
    expect(await t.usernameDe(titular.id)).toBeNull();
    await expectReservasCoherentes();
  });

  it("sin nombre guardado y CON cuerpo: asigna el nombre y crea la cuenta juntos", async () => {
    const titular = await t.crear();
    const r = await t.crearCredenciales(titular.id, "desde.cuerpo");
    expect(r.username).toBe("desde.cuerpo");
    expect(await t.usernameDe(titular.id)).toBe("desde.cuerpo");
    expect(await reservaDe("desde.cuerpo")).toMatchObject({ ownerKind: t.ownerKind, ownerId: titular.id });
    await expectReservasCoherentes();
  });

  it("con nombre guardado y un cuerpo DISTINTO: el del cuerpo reemplaza al guardado y lo libera", async () => {
    const titular = await t.crear("viejo.nombre");
    const r = await t.crearCredenciales(titular.id, "nuevo.nombre");
    expect(r.username).toBe("nuevo.nombre");
    expect(await t.usernameDe(titular.id)).toBe("nuevo.nombre");
    expect(await reservaDe("viejo.nombre")).toBeNull();
    await expectReservasCoherentes();
  });

  it("el nombre de una cuenta del sistema también cuenta como tomado (mensaje claro, sin error interno)", async () => {
    const titular = await t.crear();
    // Antes, excluir al propio titular dejaba fuera las cuentas sin persona ni
    // club, y este nombre parecía libre hasta que la base lo rechazaba.
    const error = await errorDe(t.crearCredenciales(titular.id, ADMIN_USERNAME));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toMatch(/ya está en uso por una cuenta de acceso/);
    expect(await t.cuentasDe(titular.id)).toBe(0);
    expect(await t.usernameDe(titular.id)).toBeNull();
  });

  it("FALLO por nombre tomado: nada cambia y el nombre sigue editable", async () => {
    await nuevoClub("ocupado.ya");
    const titular = await t.crear();

    const error = await errorDe(t.crearCredenciales(titular.id, "ocupado.ya"));
    expect(error).toBeInstanceOf(ValidationError);
    expect(await t.cuentasDe(titular.id), "ninguna cuenta a medias").toBe(0);
    expect(await t.usernameDe(titular.id), "el nombre no quedó asignado").toBeNull();
    await expectReservasCoherentes();

    // Sigue editable: el fallo no lo bloqueó.
    await t.editarUsername(titular.id, "libre.ahora");
    expect(await t.usernameDe(titular.id)).toBe("libre.ahora");
  });
});

describe("crear credenciales — fallo DESPUÉS de validar el nombre (persona sin rol de acceso)", () => {
  it("se revierte la asignación: la persona queda sin nombre, sin reserva y editable", async () => {
    const persona = await nuevaPersona(); // sin membresía: no tiene rol de acceso

    const error = await errorDe(personsService.createCredentials(persona.id, ADMIN, { username: "sin.rol" }));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toMatch(/ningún rol que otorgue acceso/);

    expect((await prisma.person.findUniqueOrThrow({ where: { id: persona.id } })).username).toBeNull();
    expect(await reservaDe("sin.rol"), "la reserva tomada dentro de la transacción se deshizo").toBeNull();
    expect(await prisma.user.count({ where: { personId: persona.id } })).toBe(0);
    await expectReservasCoherentes();

    await personsService.updatePerson(persona.id, { username: "sin.rol" }, ADMIN);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: persona.id } })).username).toBe("sin.rol");
  });
});

// ---------------------------------------------------------------------------
// 5. Bloqueo con cuenta vigente
// ---------------------------------------------------------------------------

describe.each(TITULARES)("con cuenta vigente el nombre queda bloqueado ($tipo)", (t) => {
  it("cambiarlo o quitarlo se rechaza; reenviar el mismo no es un cambio", async () => {
    const titular = await t.crear();
    await t.crearCredenciales(titular.id, "con.cuenta");

    for (const intento of ["otro.nombre", null]) {
      const error = await errorDe(t.editarUsername(titular.id, intento));
      expect(error, `intento: ${intento}`).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toBe(MENSAJE_NOMBRE_BLOQUEADO);
    }
    await t.editarUsername(titular.id, "con.cuenta");
    expect(await t.usernameDe(titular.id)).toBe("con.cuenta");
  });

  it.each(["bloquear", "inhabilitar"] as const)("con la cuenta al %s, sigue bloqueado", async (accion) => {
    const titular = await t.crear();
    await t.crearCredenciales(titular.id, "cuenta.parada");
    await t[accion](titular.id);

    const error = await errorDe(t.editarUsername(titular.id, "otro.nombre"));
    expect((error as Error).message).toBe(MENSAJE_NOMBRE_BLOQUEADO);
    expect(await t.usernameDe(titular.id)).toBe("cuenta.parada");
  });

  it("la protección SQL existente lo rechaza aunque se salte el servicio, también hacia NULL", async () => {
    const titular = await t.crear();
    await t.crearCredenciales(titular.id, "sql.protegido");

    for (const valor of ["por.sql", null]) {
      await expect(prisma.$executeRawUnsafe(`UPDATE ${t.tabla} SET username = $1 WHERE id = $2`, valor, titular.id)).rejects.toThrow(
        /cuenta de acceso vigente/
      );
    }
    expect(await t.usernameDe(titular.id)).toBe("sql.protegido");
  });

  it("restablecer la contraseña no cambia ni desbloquea el nombre", async () => {
    const titular = await t.crear();
    await t.crearCredenciales(titular.id, "con.reset");
    await t.restablecer(titular.id);

    expect(await t.usernameDe(titular.id)).toBe("con.reset");
    const error = await errorDe(t.editarUsername(titular.id, "despues.reset"));
    expect((error as Error).message).toBe(MENSAJE_NOMBRE_BLOQUEADO);
    await expectReservasCoherentes();
  });

  it("no se pueden crear credenciales dos veces", async () => {
    const titular = await t.crear();
    await t.crearCredenciales(titular.id, "una.sola");
    await expect(t.crearCredenciales(titular.id, "otra.mas")).rejects.toThrow(/ya tiene credenciales/);
    expect(await t.usernameDe(titular.id)).toBe("una.sola");
  });
});

// ---------------------------------------------------------------------------
// Contrato HTTP e inicio de sesión
// ---------------------------------------------------------------------------

describe("contrato HTTP e inicio de sesión", () => {
  async function conApp<T>(fn: (app: Awaited<ReturnType<typeof buildServer>>, auth: { authorization: string }) => Promise<T>) {
    const app = await buildServer();
    await app.ready();
    try {
      const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: ADMIN_USERNAME, password: TEST_PASSWORD } });
      return await fn(app, { authorization: `Bearer ${login.json().accessToken}` });
    } finally {
      await app.close();
    }
  }

  it("persona: alta sin nombre, credenciales sin cuerpo = 400, con cuerpo = 201, y la cuenta entra y se restablece", async () => {
    await conApp(async (app, auth) => {
      const alta = await app.inject({
        method: "POST",
        url: "/persons",
        headers: auth,
        payload: { run: "12345678-5", firstName: "Lia", paternalLastName: "Prueba", birthDate: "1990-01-01", gender: "female" },
      });
      expect(alta.statusCode, alta.body).toBe(201);
      expect(alta.json().username).toBeNull();
      const id = alta.json().id as string;
      await conRolDeAcceso(id);

      for (const payload of [undefined, {}, { username: "" }]) {
        const r = await app.inject({ method: "POST", url: `/persons/${id}/credentials`, headers: auth, ...(payload ? { payload } : {}) });
        expect(r.statusCode, `cuerpo ${JSON.stringify(payload)}: ${r.body}`).toBe(400);
        expect(r.body).toContain("Indique un nombre de usuario");
      }
      expect(await prisma.user.count({ where: { personId: id } })).toBe(0);

      const creada = await app.inject({ method: "POST", url: `/persons/${id}/credentials`, headers: auth, payload: { username: " lia.prueba " } });
      expect(creada.statusCode, creada.body).toBe(201);
      expect(creada.json().username).toBe("lia.prueba");

      const entra = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "lia.prueba", password: creada.json().temporaryPassword } });
      expect(entra.statusCode, entra.body).toBe(200);
      expect(entra.json().mustChangePassword).toBe(true);

      const reset = await app.inject({ method: "POST", url: `/persons/${id}/credentials/reset`, headers: auth });
      expect(reset.statusCode).toBe(200);
      const entraOtraVez = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "lia.prueba", password: reset.json().temporaryPassword } });
      expect(entraOtraVez.statusCode).toBe(200);

      const renombrar = await app.inject({ method: "PUT", url: `/persons/${id}`, headers: auth, payload: { username: "otro.nombre" } });
      expect(renombrar.statusCode).toBe(400);
      expect(renombrar.body).toContain("ya no se puede cambiar");
    });
  });

  it("club: alta sin nombre, nombre asignado al editar, credenciales SIN cuerpo con el guardado", async () => {
    await conApp(async (app, auth) => {
      const alta = await app.inject({
        method: "POST",
        url: "/clubs",
        headers: auth,
        payload: { ...CLUB_BASE, name: "Club Http", code: "CHTTP" },
      });
      expect(alta.statusCode, alta.body).toBe(201);
      expect(alta.json().username).toBeNull();
      const id = alta.json().id as string;

      const editar = await app.inject({ method: "PUT", url: `/clubs/${id}`, headers: auth, payload: { hasLegalStatus: false, username: "club.http" } });
      expect(editar.statusCode, editar.body).toBe(200);

      const creada = await app.inject({ method: "POST", url: `/clubs/${id}/credentials`, headers: auth });
      expect(creada.statusCode, creada.body).toBe(201);
      expect(creada.json().username).toBe("club.http");

      const entra = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "club.http", password: creada.json().temporaryPassword } });
      expect(entra.statusCode).toBe(200);
    });
  });

  it("una cuenta YA existente antes de este cambio sigue entrando y su nombre sigue bloqueado", async () => {
    // Persona y cuenta como las dejaba la versión anterior: nombre siempre presente.
    const persona = await nuevaPersona("cuenta.previa");
    await conRolDeAcceso(persona.id);
    await createUser({ username: "cuenta.previa", roleNames: ["swimmer"], personId: persona.id });

    await conApp(async (app) => {
      const entra = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "cuenta.previa", password: TEST_PASSWORD } });
      expect(entra.statusCode).toBe(200);
    });
    const error = await errorDe(personsService.updatePerson(persona.id, { username: "nuevo.previo" }, ADMIN));
    expect((error as Error).message).toBe(MENSAJE_NOMBRE_BLOQUEADO);
  });
});

// ---------------------------------------------------------------------------
// 6. Carreras reales, con dos conexiones
// ---------------------------------------------------------------------------

async function abrirConexion(): Promise<Client> {
  const cliente = new Client({ connectionString: process.env.DATABASE_URL });
  await cliente.connect();
  conexiones.push(cliente);
  return cliente;
}

/** ¿Sigue pendiente la promesa tras `ms`? Se combina con el resultado final. */
async function siguePendiente(promesa: Promise<unknown>, ms = 700): Promise<boolean> {
  const centinela = Symbol("pendiente");
  const r = await Promise.race([promesa.then(() => "fin", () => "fin"), new Promise((res) => setTimeout(() => res(centinela), ms))]);
  return r === centinela;
}

describe("concurrencia real", () => {
  it("dos titulares reclaman el mismo nombre: quien crea credenciales ESPERA y es rechazado sin dejar nada", async () => {
    const x = await nuevaPersona();
    const y = await nuevaPersona();
    await conRolDeAcceso(y.id);

    const a = await abrirConexion();
    await a.query("BEGIN");
    await a.query(`UPDATE persons SET username = 'disputado' WHERE id = $1`, [x.id]);

    const creacion = errorDe(personsService.createCredentials(y.id, ADMIN, { username: "disputado" }));
    expect(await siguePendiente(creacion), "la reserva global serializa a las dos").toBe(true);

    await a.query("COMMIT");
    const error = await creacion;

    expect(error, "el perdedor recibe un conflicto explícito, no un error interno").toBeInstanceOf(ConflictError);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: y.id } })).username, "y no quedó con el nombre").toBeNull();
    expect(await prisma.user.count({ where: { personId: y.id } }), "ni con una cuenta a medias").toBe(0);
    expect(await reservaDe("disputado")).toMatchObject({ ownerId: x.id });
    await expectReservasCoherentes();
  }, 60_000);

  it("renombrar mientras otra transacción crea la cuenta: el renombrado ESPERA y es rechazado", async () => {
    const persona = await nuevaPersona("original.uno");
    await conRolDeAcceso(persona.id);

    const a = await abrirConexion();
    await a.query("BEGIN");
    // Alta de la cuenta: su disparador TOCA la fila del titular.
    await a.query(
      `INSERT INTO users (id, username, password_hash, must_change_password, status, owner_type, person_id, updated_at)
       VALUES (gen_random_uuid(), 'original.uno', 'x', false, 'active', 'person', $1, now())`,
      [persona.id]
    );

    const renombrado = errorDe(personsService.updatePerson(persona.id, { username: "renombrado.uno" }, ADMIN));
    expect(await siguePendiente(renombrado)).toBe(true);

    await a.query("COMMIT");
    const error = await renombrado;

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe(MENSAJE_NOMBRE_BLOQUEADO);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: persona.id } })).username).toBe("original.uno");
    expect(await reservaDe("renombrado.uno")).toBeNull();
    await expectReservasCoherentes();
  }, 60_000);

  it("crear credenciales con nombre nuevo mientras otra transacción renombra: aborta sin cuenta ni nombre propio", async () => {
    const persona = await nuevaPersona("antes.uno");
    await conRolDeAcceso(persona.id);

    const a = await abrirConexion();
    await a.query("BEGIN");
    await a.query(`UPDATE persons SET username = 'renombrado.ya' WHERE id = $1`, [persona.id]);

    const creacion = errorDe(personsService.createCredentials(persona.id, ADMIN, { username: "desde.cuerpo" }));
    expect(await siguePendiente(creacion)).toBe(true);

    await a.query("COMMIT");
    const error = await creacion;

    expect(error).toBeInstanceOf(ConflictError);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: persona.id } })).username, "gana el renombrado confirmado").toBe("renombrado.ya");
    expect(await prisma.user.count({ where: { personId: persona.id } })).toBe(0);
    expect(await reservaDe("desde.cuerpo")).toBeNull();
    await expectReservasCoherentes();

    // Y el titular sigue editable: el intento fallido no lo bloqueó.
    await personsService.updatePerson(persona.id, { username: "despues.uno" }, ADMIN);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: persona.id } })).username).toBe("despues.uno");
  }, 60_000);

  it("club: crear credenciales con nombre nuevo mientras otro club toma ese nombre", async () => {
    const otro = await nuevoClub();
    const club = await nuevoClub();

    const a = await abrirConexion();
    await a.query("BEGIN");
    await a.query(`UPDATE clubs SET username = 'club.disputado' WHERE id = $1`, [otro.id]);

    const creacion = errorDe(clubsService.createClubCredentials(club.id, ADMIN, { username: "club.disputado" }));
    expect(await siguePendiente(creacion)).toBe(true);

    await a.query("COMMIT");
    expect(await creacion).toBeInstanceOf(ConflictError);
    expect((await prisma.club.findUniqueOrThrow({ where: { id: club.id } })).username).toBeNull();
    expect(await prisma.user.count({ where: { clubId: club.id } })).toBe(0);
    await expectReservasCoherentes();
  }, 60_000);
});
