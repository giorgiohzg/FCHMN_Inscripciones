/**
 * Concurrencia REAL sobre las garantías de `phase4_identity_guards`.
 *
 * `Promise.allSettled` sobre dos llamadas de Prisma no demuestra nada: nada
 * obliga a que las dos transacciones se solapen, así que la prueba pasa
 * igual aunque se ejecuten uno detrás de otro y la garantía sea solo la
 * comprobación secuencial de siempre.
 *
 * Aquí se usan DOS CONEXIONES independientes con transacciones coordinadas a
 * mano, de modo que el solapamiento está garantizado por construcción:
 *
 *   1. A abre transacción e inserta (toma el bloqueo).
 *   2. B abre transacción e inserta ⇒ se comprueba que QUEDA BLOQUEADA,
 *      esperando a A. Ese bloqueo es la garantía: sin él, B leería el estado
 *      anterior a A y concluiría que no hay conflicto.
 *   3. A confirma.
 *   4. B se desbloquea y FALLA, porque ahora sí ve la fila de A.
 *
 * El paso 2 es el que distingue una garantía concurrente de una comprobación
 * ingenua, y es el que no se puede escribir con `Promise.allSettled`.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Client } from "pg";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser } from "./helpers/seedRbac";

const conexiones: Client[] = [];

async function abrirConexion(): Promise<Client> {
  const cliente = new Client({ connectionString: process.env.DATABASE_URL });
  await cliente.connect();
  conexiones.push(cliente);
  return cliente;
}

/**
 * Comprueba que una promesa NO se resuelve dentro del plazo dado.
 *
 * Por sí solo esto NO demuestra que haya un bloqueo: una consulta lenta se ve
 * igual. Por eso siempre se combina con `esperandoUnBloqueo`, que lo confirma
 * en el catálogo del propio motor.
 */
async function siguePendiente(promesa: Promise<unknown>, ms = 700): Promise<boolean> {
  const centinela = Symbol("pendiente");
  const resultado = await Promise.race([
    promesa.then(
      () => "resuelta",
      () => "rechazada"
    ),
    new Promise((r) => setTimeout(() => r(centinela), ms)),
  ]);
  return resultado === centinela;
}

/**
 * Confirma en `pg_stat_activity` que la conexión indicada está detenida
 * esperando un CERROJO, no simplemente tardando.
 *
 * Es la diferencia entre "la promesa sigue pendiente" —que también ocurriría
 * con una consulta lenta o una conexión trabada— y "PostgreSQL puso a esta
 * transacción a esperar a la otra", que es la garantía que se quiere probar.
 * Se consulta desde una TERCERA conexión, para no interferir.
 */
async function esperandoUnBloqueo(observador: Client, pid: number, intentos = 40): Promise<string | null> {
  for (let i = 0; i < intentos; i++) {
    const { rows } = await observador.query<{ wait_event_type: string | null; state: string }>(
      `SELECT wait_event_type, state FROM pg_stat_activity WHERE pid = $1`,
      [pid]
    );
    if (rows[0]?.wait_event_type === "Lock") return rows[0].state;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function pidDe(cliente: Client): Promise<number> {
  const { rows } = await cliente.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0]!.pid;
}

/** Nivel de aislamiento efectivo de la transacción en curso. */
async function aislamientoDe(cliente: Client): Promise<string> {
  const { rows } = await cliente.query<{ transaction_isolation: string }>("SHOW transaction_isolation");
  return rows[0]!.transaction_isolation;
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
});

afterAll(async () => {
  await Promise.all(conexiones.map((c) => c.end().catch(() => void 0)));
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("una persona en dos clubes, con transacciones solapadas", () => {
  it("la segunda transacción ESPERA a la primera y después es rechazada", async () => {
    const norte = await createClub("Club Norte", "CN");
    const sur = await createClub("Club Sur", "CS");
    const persona = await createPerson({ run: "80000001", username: "carrera_a", firstName: "Carla", gender: "female" });

    const a = await abrirConexion();
    const b = await abrirConexion();
    const observador = await abrirConexion();
    const pidB = await pidDe(b);

    await a.query("BEGIN");
    await b.query("BEGIN");

    // El nivel de aislamiento no se supone: se lee. Es el predeterminado de
    // PostgreSQL y el que usa la aplicación, y de él depende el paso 4 (que B
    // vea la fila de A al desbloquearse en vez de su instantánea anterior).
    expect(await aislamientoDe(a)).toBe("read committed");
    expect(await aislamientoDe(b)).toBe("read committed");

    // 1. A inserta: el disparador TOCA la fila de la persona con un UPDATE
    //    real, que es lo que serializa a las dos transacciones.
    await a.query(
      `INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES (gen_random_uuid(), $1, $2, 'delegate')`,
      [norte.id, persona.id]
    );

    // 2. B intenta insertar en OTRO club: debe quedar esperando ese bloqueo.
    const insercionB = b.query(
      `INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES (gen_random_uuid(), $1, $2, 'coach')`,
      [sur.id, persona.id]
    );

    expect(
      await siguePendiente(insercionB),
      "sin el bloqueo, B habría leído 'esta persona no tiene club' y seguido adelante"
    ).toBe(true);

    // Y no está simplemente lenta: el motor la tiene esperando un CERROJO.
    expect(
      await esperandoUnBloqueo(observador, pidB),
      "pg_stat_activity debe mostrar a B con wait_event_type = 'Lock'"
    ).toBe("active");

    // 3. A confirma.
    await a.query("COMMIT");

    // 4. B se desbloquea y falla contra el estado ya confirmado por A.
    await expect(insercionB).rejects.toThrow(/un club a la vez/i);
    await b.query("ROLLBACK");

    const filas = await prisma.clubStaff.findMany({ where: { personId: persona.id } });
    expect(filas).toHaveLength(1);
    expect(filas[0]!.clubId).toBe(norte.id);
  }, 60_000);

  it("si la primera transacción se DESHACE, la segunda prospera", async () => {
    const norte = await createClub("Club Norte", "CN");
    const sur = await createClub("Club Sur", "CS");
    const persona = await createPerson({ run: "80000002", username: "carrera_b", firstName: "Bea", gender: "female" });

    const a = await abrirConexion();
    const b = await abrirConexion();

    await a.query("BEGIN");
    await b.query("BEGIN");

    await a.query(
      `INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES (gen_random_uuid(), $1, $2, 'delegate')`,
      [norte.id, persona.id]
    );
    const insercionB = b.query(
      `INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES (gen_random_uuid(), $1, $2, 'coach')`,
      [sur.id, persona.id]
    );

    expect(await siguePendiente(insercionB)).toBe(true);

    // A se deshace: el conflicto que bloqueaba a B nunca existió.
    await a.query("ROLLBACK");

    await expect(insercionB).resolves.toBeTruthy();
    await b.query("COMMIT");

    const filas = await prisma.clubStaff.findMany({ where: { personId: persona.id } });
    expect(filas).toHaveLength(1);
    expect(filas[0]!.clubId).toBe(sur.id);
  }, 60_000);

  /**
   * Comportamiento bajo REPEATABLE READ, comprobado — no supuesto.
   *
   * Este caso encontró un defecto real. Con la versión anterior del
   * disparador, que usaba `SELECT ... FOR UPDATE`, la garantía valía SOLO bajo
   * READ COMMITTED: `FOR UPDATE` no modifica la fila, así que al confirmar A
   * no había conflicto de serialización, B seguía con su instantánea anterior
   * y las DOS inserciones prosperaban. La persona quedaba como personal de dos
   * clubes.
   *
   * El disparador ahora toca la fila de la persona (`UPDATE ... SET updated_at
   * = updated_at`), y bajo RR eso aborta con 40001. La garantía deja de
   * depender del nivel de aislamiento; lo que cambia es el error que recibe
   * quien pierde la carrera.
   */
  it("bajo REPEATABLE READ la garantía se mantiene, pero el error es de serialización", async () => {
    const norte = await createClub("Club Norte", "CN");
    const sur = await createClub("Club Sur", "CS");
    const persona = await createPerson({ run: "80000006", username: "carrera_rr", firstName: "Rita", gender: "female" });

    const a = await abrirConexion();
    const b = await abrirConexion();
    const observador = await abrirConexion();
    const pidB = await pidDe(b);

    await a.query("BEGIN");
    await b.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(await aislamientoDe(b)).toBe("repeatable read");

    await a.query(
      `INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES (gen_random_uuid(), $1, $2, 'delegate')`,
      [norte.id, persona.id]
    );
    const insercionB = b.query(
      `INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES (gen_random_uuid(), $1, $2, 'coach')`,
      [sur.id, persona.id]
    );

    expect(await siguePendiente(insercionB)).toBe(true);
    expect(await esperandoUnBloqueo(observador, pidB)).toBe("active");

    await a.query("COMMIT");

    const error = await insercionB.then(() => null).catch((e) => e as { code?: string; message: string });
    await b.query("ROLLBACK");

    expect(error, "la segunda no puede prosperar").not.toBeNull();
    expect(error!.code, "bajo REPEATABLE READ el motor aborta por serialización").toBe("40001");
    expect(await prisma.clubStaff.count({ where: { personId: persona.id } })).toBe(1);
  }, 60_000);

  it("dos cargos de la MISMA persona en el MISMO club no se estorban", async () => {
    const club = await createClub("Club Norte", "CN");
    const persona = await createPerson({ run: "80000003", username: "carrera_c", firstName: "Cira", gender: "female" });

    const a = await abrirConexion();
    const b = await abrirConexion();
    await a.query("BEGIN");
    await b.query("BEGIN");

    await a.query(
      `INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES (gen_random_uuid(), $1, $2, 'delegate')`,
      [club.id, persona.id]
    );
    const insercionB = b.query(
      `INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES (gen_random_uuid(), $1, $2, 'coach')`,
      [club.id, persona.id]
    );

    // B espera igual (el bloqueo es por persona), pero al desbloquearse pasa:
    // el mismo club no es un conflicto.
    expect(await siguePendiente(insercionB)).toBe(true);
    await a.query("COMMIT");
    await expect(insercionB).resolves.toBeTruthy();
    await b.query("COMMIT");

    expect(await prisma.clubStaff.count({ where: { personId: persona.id } })).toBe(2);
  }, 60_000);
});

describe("dos representantes legales del mismo club, con transacciones solapadas", () => {
  it("la segunda ESPERA en el índice único y después es rechazada", async () => {
    const club = await createClub("Club Norte", "CN");
    const uno = await createPerson({ run: "80000004", username: "rep_x", firstName: "Rita", gender: "female" });
    const dos = await createPerson({ run: "80000005", username: "rep_y", firstName: "Rosa", gender: "female" });

    const a = await abrirConexion();
    const b = await abrirConexion();
    const observador = await abrirConexion();
    const pidB = await pidDe(b);
    await a.query("BEGIN");
    await b.query("BEGIN");
    expect(await aislamientoDe(b)).toBe("read committed");

    await a.query(
      `INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES (gen_random_uuid(), $1, $2, 'legal_representative')`,
      [club.id, uno.id]
    );

    /**
     * B espera sobre la entrada AÚN NO CONFIRMADA del índice único parcial:
     * PostgreSQL no puede decidir si hay conflicto hasta saber si A confirma.
     * Ese es el comportamiento que hace segura la garantía; una comprobación
     * previa en la aplicación no tiene forma de esperar así.
     */
    const insercionB = b.query(
      `INSERT INTO club_staff (id, club_id, person_id, role_type) VALUES (gen_random_uuid(), $1, $2, 'legal_representative')`,
      [club.id, dos.id]
    );

    expect(await siguePendiente(insercionB)).toBe(true);
    expect(
      await esperandoUnBloqueo(observador, pidB),
      "el cerrojo aquí es sobre la entrada no confirmada del índice único"
    ).toBe("active");

    await a.query("COMMIT");

    await expect(insercionB).rejects.toThrow(/club_staff_unique_legal_representative/i);
    await b.query("ROLLBACK");

    expect(await prisma.clubStaff.count({ where: { clubId: club.id, roleType: "legal_representative" } })).toBe(1);
  }, 60_000);
});

describe("dos personas reclamando el mismo nombre de usuario, con transacciones solapadas", () => {
  it("la segunda ESPERA en la reserva global y después es rechazada", async () => {
    const a = await abrirConexion();
    const b = await abrirConexion();
    await a.query("BEGIN");
    await b.query("BEGIN");

    const persona = (run: string, nombre: string) =>
      `INSERT INTO persons (id, run, username, first_name, paternal_last_name, full_name, birth_date, gender, status, updated_at)
       VALUES (gen_random_uuid(), '${run}', 'disputado', '${nombre}', 'Prueba', '${nombre} Prueba', '1990-01-01', 'female', 'active', now())`;

    await a.query(persona("81000001", "Ana"));
    const insercionB = b.query(persona("81000002", "Bea"));

    expect(await siguePendiente(insercionB), "la reserva global serializa a las dos").toBe(true);

    await a.query("COMMIT");

    await expect(insercionB).rejects.toThrow();
    await b.query("ROLLBACK");

    expect(await prisma.person.count({ where: { username: "disputado" } })).toBe(1);
    expect(await prisma.usernameReservation.count({ where: { username: "disputado" } })).toBe(1);
  }, 60_000);
});


/**
 * Carrera entre crear/reactivar una cuenta y renombrar a su titular.
 *
 * Las dos operaciones se comprobaban mirando la tabla de la otra, y ninguna
 * podía ver lo que la otra todavía no había confirmado: la cuenta leía el
 * nombre viejo del titular, el renombrado no encontraba ninguna cuenta
 * vigente, y ambas confirmaban. Quedaba una cuenta vigente con un nombre que
 * ya no era el de su titular.
 *
 * La fila del titular es ahora el punto de encuentro: el renombrado la
 * actualiza por definición, y el disparador de la cuenta la toca con
 * `UPDATE ... RETURNING` en vez de leerla. Una de las dos espera; la que
 * pierde ve el estado ya confirmado (READ COMMITTED) o aborta con 40001
 * (REPEATABLE READ).
 *
 * `users_username_igual_al_titular` tiene DOS ramas —persona y club— con su
 * propia consulta cada una, así que los escenarios se recorren para las dos:
 * probar solo la de personas dejaba la mitad de la función sin ejercitar.
 */
interface Titular {
  tipo: "persona" | "club";
  /** Valor de `owner_kind` en `username_reservations` para este tipo. */
  ownerKind: "person" | "club";
  /** Crea el titular y devuelve su id y su nombre de usuario inicial. */
  crear: (semilla: string) => Promise<{ id: string; username: string }>;
  /** SQL que renombra al titular. */
  renombrar: string;
  /** SQL que crea una cuenta para ese titular. */
  alta: string;
  /** Estado final del titular, para comprobar que no cambió. */
  usernameActual: (id: string) => Promise<string>;
}

const TITULARES: Titular[] = [
  {
    tipo: "persona",
    ownerKind: "person",
    crear: async (semilla) => {
      const p = await createPerson({ run: semilla, username: `t_${semilla}`, firstName: "Ana", gender: "female" });
      return { id: p.id, username: p.username };
    },
    renombrar: `UPDATE persons SET username = $2 WHERE id = $1`,
    alta: `INSERT INTO users (id, username, password_hash, must_change_password, status, owner_type, person_id, updated_at)
           VALUES (gen_random_uuid(), $2, 'x', false, 'active', 'person', $1, now())`,
    usernameActual: async (id) => (await prisma.person.findUniqueOrThrow({ where: { id } })).username,
  },
  {
    tipo: "club",
    ownerKind: "club",
    crear: async (semilla) => {
      const c = await createClub(`Club ${semilla}`, semilla.slice(0, 5), `t_${semilla}`);
      return { id: c.id, username: c.username };
    },
    renombrar: `UPDATE clubs SET username = $2 WHERE id = $1`,
    alta: `INSERT INTO users (id, username, password_hash, must_change_password, status, owner_type, club_id, updated_at)
           VALUES (gen_random_uuid(), $2, 'x', false, 'active', 'club', $1, now())`,
    usernameActual: async (id) => (await prisma.club.findUniqueOrThrow({ where: { id } })).username,
  },
];

/**
 * Estado de la reserva de un nombre: quién lo tiene, o `null` si está libre.
 *
 * Comprobar solo el titular y la cuenta deja fuera la mitad del invariante: el
 * registro de nombres es lo que impide que otro titular tome el nombre que
 * quedó suelto, y una reserva mal atribuida no se ve en ninguna de las otras
 * dos tablas.
 */
async function reservaDe(username: string): Promise<{ ownerKind: string; ownerId: string } | null> {
  const r = await prisma.usernameReservation.findUnique({ where: { username } });
  return r ? { ownerKind: r.ownerKind, ownerId: r.ownerId } : null;
}

/** Comprueba las DOS reservas en juego: la que se libera y la que se toma. */
async function comprobarReservas(t: Titular, id: string, opciones: { tomada: string; libre: string }) {
  expect(await reservaDe(opciones.tomada), `"${opciones.tomada}" debe estar reservado por su titular`).toEqual({
    ownerKind: t.ownerKind,
    ownerId: id,
  });
  expect(await reservaDe(opciones.libre), `"${opciones.libre}" debe haber quedado libre`).toBeNull();
}

/** Cuentas del titular, vigentes o no. */
async function cuentasDe(t: Titular, id: string, soloVigentes = false) {
  const where = t.tipo === "persona" ? { personId: id } : { clubId: id };
  return prisma.user.count({ where: { ...where, ...(soloVigentes ? { deletedAt: null } : {}) } });
}

describe.each(TITULARES)("alta de cuenta contra renombrado del titular ($tipo)", (t) => {
  let semilla = 0;
  const nuevaSemilla = () => `9${t.tipo === "persona" ? "1" : "2"}00000${++semilla}`;

  it("si la cuenta va primero, el renombrado ESPERA y después es rechazado", async () => {
    const titular = await t.crear(nuevaSemilla());

    const a = await abrirConexion();
    const b = await abrirConexion();
    const observador = await abrirConexion();
    const pidB = await pidDe(b);

    await a.query("BEGIN");
    await b.query("BEGIN");
    expect(await aislamientoDe(a)).toBe("read committed");

    // A crea la cuenta: el disparador TOCA la fila del titular.
    await a.query(t.alta, [titular.id, titular.username]);

    // B intenta renombrar al titular: choca con esa misma fila.
    const renombradoB = b.query(t.renombrar, [titular.id, "nombre_nuevo"]);

    expect(await siguePendiente(renombradoB)).toBe(true);
    expect(await esperandoUnBloqueo(observador, pidB), "el renombrado espera la fila del titular").toBe("active");

    await a.query("COMMIT");

    await expect(renombradoB).rejects.toThrow(/cuenta de acceso vigente/i);
    await b.query("ROLLBACK");

    expect(await t.usernameActual(titular.id)).toBe(titular.username);
    expect(await cuentasDe(t, titular.id, true)).toBe(1);
    // La reserva sigue siendo una sola y a nombre del titular.
    const reservas = await prisma.usernameReservation.findMany({ where: { username: titular.username } });
    expect(reservas).toHaveLength(1);
    expect(reservas[0]!.ownerId).toBe(titular.id);
  }, 60_000);

  it("si el renombrado va primero, el alta de la cuenta ESPERA y después es rechazada", async () => {
    const titular = await t.crear(nuevaSemilla());

    const a = await abrirConexion();
    const b = await abrirConexion();
    const observador = await abrirConexion();
    const pidB = await pidDe(b);

    await a.query("BEGIN");
    await b.query("BEGIN");

    await a.query(t.renombrar, [titular.id, "nombre_nuevo"]);

    // B crea la cuenta con el nombre VIEJO, que ya no será el del titular.
    const altaB = b.query(t.alta, [titular.id, titular.username]);

    expect(await siguePendiente(altaB)).toBe(true);
    expect(await esperandoUnBloqueo(observador, pidB)).toBe("active");

    await a.query("COMMIT");

    await expect(altaB).rejects.toThrow(/debe ser el de su titular/i);
    await b.query("ROLLBACK");

    expect(await t.usernameActual(titular.id)).toBe("nombre_nuevo");
    expect(await cuentasDe(t, titular.id)).toBe(0);
    // El nombre viejo quedó libre y el nuevo reservado para el mismo titular.
    expect(await prisma.usernameReservation.count({ where: { username: titular.username } })).toBe(0);
    expect(await prisma.usernameReservation.findFirst({ where: { username: "nombre_nuevo" } })).toMatchObject({
      ownerId: titular.id,
    });
  }, 60_000);

  it("si el renombrado se DESHACE, el alta prospera con el nombre original", async () => {
    const titular = await t.crear(nuevaSemilla());

    const a = await abrirConexion();
    const b = await abrirConexion();
    await a.query("BEGIN");
    await b.query("BEGIN");

    await a.query(t.renombrar, [titular.id, "nombre_nuevo"]);
    const altaB = b.query(t.alta, [titular.id, titular.username]);

    expect(await siguePendiente(altaB)).toBe(true);

    await a.query("ROLLBACK");

    await expect(altaB).resolves.toBeTruthy();
    await b.query("COMMIT");

    expect(await t.usernameActual(titular.id)).toBe(titular.username);
    expect(await cuentasDe(t, titular.id, true)).toBe(1);
    expect(await prisma.usernameReservation.count({ where: { username: titular.username } })).toBe(1);
  }, 60_000);

  it("REACTIVAR una cuenta contra un renombrado simultáneo: la reactivación es rechazada", async () => {
    const titular = await t.crear(nuevaSemilla());
    const datos =
      t.tipo === "persona"
        ? { username: titular.username, passwordHash: "x", ownerType: "person" as const, personId: titular.id }
        : { username: titular.username, passwordHash: "x", ownerType: "club" as const, clubId: titular.id };
    const cuenta = await prisma.user.create({ data: datos });
    await prisma.user.update({ where: { id: cuenta.id }, data: { deletedAt: new Date() } });

    const a = await abrirConexion();
    const b = await abrirConexion();
    const observador = await abrirConexion();
    const pidB = await pidDe(b);

    await a.query("BEGIN");
    await b.query("BEGIN");

    // A renombra al titular: puede, porque su única cuenta está eliminada.
    await a.query(t.renombrar, [titular.id, "nombre_nuevo"]);

    // B reactiva la cuenta vieja, que conserva el nombre anterior.
    const reactivacionB = b.query(`UPDATE users SET deleted_at = NULL WHERE id = $1`, [cuenta.id]);

    expect(await siguePendiente(reactivacionB)).toBe(true);
    expect(await esperandoUnBloqueo(observador, pidB)).toBe("active");

    await a.query("COMMIT");

    await expect(reactivacionB).rejects.toThrow(/debe ser el de su titular/i);
    await b.query("ROLLBACK");

    const despues = await prisma.user.findUniqueOrThrow({ where: { id: cuenta.id } });
    expect(despues.deletedAt, "la cuenta sigue eliminada").not.toBeNull();
    expect(await t.usernameActual(titular.id)).toBe("nombre_nuevo");
    // El renombrado sí prosperó: el nombre viejo quedó libre —la cuenta que lo
    // conserva está eliminada y no lo retiene— y el nuevo pasó al titular.
    await comprobarReservas(t, titular.id, { tomada: "nombre_nuevo", libre: titular.username });
  }, 60_000);

  it("si el renombrado se DESHACE, la reactivación prospera", async () => {
    const titular = await t.crear(nuevaSemilla());
    const datos =
      t.tipo === "persona"
        ? { username: titular.username, passwordHash: "x", ownerType: "person" as const, personId: titular.id }
        : { username: titular.username, passwordHash: "x", ownerType: "club" as const, clubId: titular.id };
    const cuenta = await prisma.user.create({ data: datos });
    await prisma.user.update({ where: { id: cuenta.id }, data: { deletedAt: new Date() } });

    const a = await abrirConexion();
    const b = await abrirConexion();
    await a.query("BEGIN");
    await b.query("BEGIN");

    await a.query(t.renombrar, [titular.id, "nombre_nuevo"]);
    const reactivacionB = b.query(`UPDATE users SET deleted_at = NULL WHERE id = $1`, [cuenta.id]);

    expect(await siguePendiente(reactivacionB)).toBe(true);
    await a.query("ROLLBACK");

    await expect(reactivacionB).resolves.toBeTruthy();
    await b.query("COMMIT");

    expect((await prisma.user.findUniqueOrThrow({ where: { id: cuenta.id } })).deletedAt).toBeNull();
    expect(await t.usernameActual(titular.id)).toBe(titular.username);
    // El renombrado se deshizo: el nombre original sigue siendo del titular, y
    // la cuenta reactivada comparte esa misma reserva en vez de crear otra.
    await comprobarReservas(t, titular.id, { tomada: titular.username, libre: "nombre_nuevo" });
    expect(await prisma.usernameReservation.count({ where: { ownerId: titular.id } }), "un titular, una reserva").toBe(1);
  }, 60_000);

  it("bajo REPEATABLE READ la carrera aborta por serialización", async () => {
    const titular = await t.crear(nuevaSemilla());

    const a = await abrirConexion();
    const b = await abrirConexion();
    await a.query("BEGIN");
    await b.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(await aislamientoDe(b)).toBe("repeatable read");

    await a.query(t.renombrar, [titular.id, "nombre_nuevo"]);
    const altaB = b.query(t.alta, [titular.id, titular.username]);

    expect(await siguePendiente(altaB)).toBe(true);
    await a.query("COMMIT");

    const error = await altaB.then(() => null).catch((e) => e as { code?: string; message: string });
    await b.query("ROLLBACK");

    expect(error).not.toBeNull();
    expect(error!.code, "sin tocar la fila del titular, B habría seguido con su instantánea").toBe("40001");
    expect(await cuentasDe(t, titular.id)).toBe(0);
    expect(await t.usernameActual(titular.id)).toBe("nombre_nuevo");
    // Solo prosperó el renombrado: el registro debe reflejar exactamente eso,
    // sin rastro de la cuenta abortada.
    await comprobarReservas(t, titular.id, { tomada: "nombre_nuevo", libre: titular.username });
  }, 60_000);
});

/**
 * RB-06 — «un nadador activo, un solo club», bajo concurrencia real.
 *
 * La regla se comprueba en el servicio para poder dar un mensaje entendible,
 * pero esa comprobación **no puede** cubrir dos altas simultáneas: ambas leen
 * "no hay membresía activa" antes de que la otra escriba. Lo único que lo
 * impide es el índice único parcial
 * `club_swimmers_unique_active_person`, y esta prueba lo ejercita en vez de
 * limitarse a comprobar que existe.
 *
 * Va deliberadamente por SQL, no por la API: pasando por el servicio, la
 * comprobación previa rechazaría la segunda y la prueba pasaría sin que la base
 * hiciera nada — demostraría lo contrario de lo que quiere demostrar.
 */
describe("un nadador en dos clubes a la vez, con transacciones solapadas", () => {
  /** Inserta una membresía ACTIVA por SQL directo, saltándose el servicio. */
  const insertarMembresiaActiva = (cliente: Client, clubId: string, personId: string, usuarioId: string) =>
    cliente.query(
      `INSERT INTO club_swimmers (id, club_id, person_id, status, requested_by_user_id, start_date, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'active', $3, now(), now(), now())`,
      [clubId, personId, usuarioId]
    );

  it("la segunda transacción ESPERA a la primera y después la rechaza el índice", async () => {
    const norte = await createClub("Club Norte", "CN");
    const sur = await createClub("Club Sur", "CS");
    const persona = await createPerson({ run: "80000101", username: "carrera_membresia", firstName: "Carla", gender: "female" });
    const quienPide = await createUser({ username: "admin_carrera", roleNames: ["admin"] });

    const a = await abrirConexion();
    const b = await abrirConexion();
    const observador = await abrirConexion();
    const pidB = await pidDe(b);

    await a.query("BEGIN");
    await b.query("BEGIN");

    // El paso 4 depende de que B vea la fila de A al desbloquearse, en vez de
    // su instantánea anterior: eso es `read committed`, y se lee, no se supone.
    expect(await aislamientoDe(a)).toBe("read committed");
    expect(await aislamientoDe(b)).toBe("read committed");

    // 1. A inserta la membresía activa: toma la entrada del índice único.
    await insertarMembresiaActiva(a, norte.id, persona.id, quienPide.id);

    // 2. B intenta activar a la MISMA persona en otro club. El índice único
    //    parcial la pone a esperar: no puede decidir si hay conflicto hasta
    //    saber si A confirma o deshace.
    const insercionB = insertarMembresiaActiva(b, sur.id, persona.id, quienPide.id);

    expect(
      await siguePendiente(insercionB),
      "sin el índice, B habría insertado su fila y habría dos membresías activas"
    ).toBe(true);

    // Y no está simplemente lenta: el motor la tiene esperando un CERROJO.
    expect(
      await esperandoUnBloqueo(observador, pidB),
      "pg_stat_activity debe mostrar a B con wait_event_type = 'Lock'"
    ).toBe("active");

    // 3. A confirma.
    await a.query("COMMIT");

    // 4. B se desbloquea y falla contra el estado ya confirmado por A.
    await expect(insercionB).rejects.toThrow(/club_swimmers_unique_active_person/i);
    await b.query("ROLLBACK");

    const activas = await prisma.clubSwimmer.findMany({ where: { personId: persona.id, status: "active" } });
    expect(activas, "exactamente una membresía activa").toHaveLength(1);
    expect(activas[0]!.clubId, "la que prosperó es la de A").toBe(norte.id);
  }, 60_000);

  it("si la primera transacción se DESHACE, la segunda prospera", async () => {
    const norte = await createClub("Club Norte", "CN");
    const sur = await createClub("Club Sur", "CS");
    const persona = await createPerson({ run: "80000102", username: "carrera_membresia_2", firstName: "Bea", gender: "female" });
    const quienPide = await createUser({ username: "admin_carrera_2", roleNames: ["admin"] });

    const a = await abrirConexion();
    const b = await abrirConexion();
    const observador = await abrirConexion();
    const pidB = await pidDe(b);

    await a.query("BEGIN");
    await b.query("BEGIN");

    await insertarMembresiaActiva(a, norte.id, persona.id, quienPide.id);
    const insercionB = insertarMembresiaActiva(b, sur.id, persona.id, quienPide.id);

    expect(await siguePendiente(insercionB)).toBe(true);
    expect(await esperandoUnBloqueo(observador, pidB)).toBe("active");

    // A deshace: el conflicto desaparece y B debe poder continuar. Es el
    // contraste que demuestra que el bloqueo era por la fila de A y no un
    // rechazo incondicional.
    await a.query("ROLLBACK");

    await expect(insercionB).resolves.toBeDefined();
    await b.query("COMMIT");

    const activas = await prisma.clubSwimmer.findMany({ where: { personId: persona.id, status: "active" } });
    expect(activas).toHaveLength(1);
    expect(activas[0]!.clubId, "la que prosperó es la de B").toBe(sur.id);
  }, 60_000);
});
