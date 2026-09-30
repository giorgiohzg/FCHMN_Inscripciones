/**
 * Permisos de administrador por persona — camino REAL contra PostgreSQL.
 *
 * La regla de fondo: **la marca es la intención y el rol es el acceso**.
 * `persons.admin_access` se puede poner antes de que exista la cuenta;
 * ninguna consulta de autorización la lee. Quien concede acceso es la fila de
 * `user_roles`, y `loadAuthorizationState` la relee en cada solicitud.
 *
 * Lo que aquí se comprueba es lo que solo se ve con la base delante: que las
 * dos no se separen, que la autorización efectiva cambie de verdad, que nadie
 * pueda dejar el sistema sin administradores —ni siquiera dos personas a la
 * vez— y que los demás roles sobrevivan intactos.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addClubStaff, TEST_PASSWORD } from "./helpers/seedRbac";
import * as personsService from "../src/modules/persons/persons.service";
import { ROL_ADMIN } from "../src/modules/persons/admin-access";
import { ConflictError } from "../src/shared/errors";
import { loadAuthorizationState } from "../src/modules/auth/authorization";
import { hashPassword } from "../src/modules/auth/password.util";

type Actor = { userId: string; ipAddress?: string };
let ADMIN: Actor;

/** La cuenta administrativa del sistema: sin persona, y nunca se toca. */
let cuentaSystem: { id: string };

async function crearCuentaSystem() {
  const rol = await prisma.role.findUniqueOrThrow({ where: { name: "admin" } });
  const user = await prisma.user.create({
    data: {
      username: "system_admin",
      passwordHash: await hashPassword(TEST_PASSWORD),
      ownerType: "system",
      status: "active",
      // La columna tiene `@default(true)`, y con el cambio pendiente
      // `requireAuth` cierra TODAS las rutas: sin esto, la cuenta sirve como
      // actor de los servicios pero no puede llamar a la API.
      mustChangePassword: false,
      userRoles: { create: [{ roleId: rol.id }] },
    },
  });
  return user;
}

let contador = 30_000_000;
async function crearPersona(nombre: string, roles: ("swimmer" | "delegate")[] = []) {
  contador++;
  return createPerson({
    run: `${contador}-1`,
    username: `p_${contador}`,
    firstName: nombre,
    gender: "female",
    birthYear: 1990,
    // [] explícito, no undefined: el ayudante de siembra interpreta la
    // ausencia como «nadadora» (opts.roles ?? ["swimmer"]), y varias de estas
    // pruebas necesitan una persona SIN ningún rol funcional.
    roles,
  });
}

/**
 * Cuenta de acceso de una persona.
 *
 * El nombre de usuario NO se elige: la base exige que el de una cuenta
 * vigente sea el de su titular (`users_username_del_titular`). Pasar uno
 * propio fallaba con una restricción cuyo mensaje es claro pero que aparece
 * en mitad de un `create` y cuesta atribuir.
 */
async function cuentaPara(
  persona: { id: string; username: string },
  roleNames: string[] = ["swimmer"],
  opts: { status?: "active" | "locked" | "disabled" } = {}
) {
  return createUser({ username: persona.username, roleNames, personId: persona.id, status: opts.status });
}

/** Roles VIGENTES de la cuenta de una persona, leídos de la base. */
async function rolesDeLaCuenta(personId: string): Promise<string[]> {
  const user = await prisma.user.findFirst({ where: { personId }, include: { userRoles: { include: { role: true } } } });
  return (user?.userRoles ?? []).map((ur) => ur.role.name).sort();
}

async function marcaEnLaPersona(personId: string): Promise<boolean> {
  return (await prisma.person.findUniqueOrThrow({ where: { id: personId } })).adminAccess;
}

/**
 * La aplicación real, para las pruebas que van por HTTP. Se construye una vez:
 * no guarda estado de negocio —roles y permisos se releen de la base en cada
 * solicitud—, así que el truncado de `beforeEach` la deja igual de válida.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  cuentaSystem = await crearCuentaSystem();
  ADMIN = { userId: cuentaSystem.id };
});

afterAll(async () => {
  await app?.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

/** Inicia sesión y devuelve el access token. */
async function iniciarSesion(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username} falló con ${res.statusCode}: ${res.body}`);
  return res.json().accessToken as string;
}

/** `PUT /persons/:id/admin-access`, opcionalmente sin token. */
async function llamarAdminAccess(personId: string, adminAccess: boolean, token?: string) {
  return app.inject({
    method: "PUT",
    url: `/persons/${personId}/admin-access`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { adminAccess },
  });
}

// ---------------------------------------------------------------------------

describe("conceder permisos a una persona CON cuenta", () => {
  it("la marca y el rol se mueven juntos, y la autorización lo refleja", async () => {
    const persona = await crearPersona("Ada", ["swimmer"]);
    const cuenta = await cuentaPara(persona);

    expect((await loadAuthorizationState(cuenta.id))!.roles).not.toContain("admin");

    await personsService.setAdminAccess(persona.id, true, ADMIN);

    expect(await marcaEnLaPersona(persona.id)).toBe(true);
    expect(await rolesDeLaCuenta(persona.id)).toContain("admin");

    // Lo que de verdad importa: la autorización efectiva cambió.
    const estado = (await loadAuthorizationState(cuenta.id))!;
    expect(estado.roles).toContain("admin");
    expect(estado.permissions).toContain("persons:write");
    expect(estado.permissions).toContain("competitions:write");
  });

  it("CONSERVA los demás roles de la cuenta", async () => {
    const persona = await crearPersona("Bea", ["swimmer"]);
    const cuenta = await cuentaPara(persona, ["swimmer", "delegate"]);

    await personsService.setAdminAccess(persona.id, true, ADMIN);

    expect(await rolesDeLaCuenta(persona.id)).toEqual(["admin", "delegate", "swimmer"]);
    expect((await loadAuthorizationState(cuenta.id))!.roles.sort()).toEqual(["admin", "delegate", "swimmer"]);
  });

  it("el alcance administrativo prevalece sobre el vínculo con un club", async () => {
    const club = await createClub("Club Uno", "CU1");
    const persona = await crearPersona("Cora", ["delegate"]);
    const cuenta = await cuentaPara(persona, ["delegate"]);
    await addClubStaff(club.id, persona.id, "delegate");

    // Antes de conceder, su sesión queda acotada a ese club.
    expect((await loadAuthorizationState(cuenta.id))!.clubId).toBe(club.id);

    await personsService.setAdminAccess(persona.id, true, ADMIN);

    // Después, sin club: el alcance administrativo no depende de ninguno.
    const estado = (await loadAuthorizationState(cuenta.id))!;
    expect(estado.clubId).toBeNull();
    expect(estado.roles).toContain("admin");
    // Y el vínculo con el club SIGUE ahí: no se borró nada.
    expect(await prisma.clubStaff.count({ where: { personId: persona.id } })).toBe(1);
  });

  it("la base impide el doble vínculo, así que la rama defensiva no es alcanzable desde la API", async () => {
    /**
     * REGISTRO DE UN LÍMITE, no de una funcionalidad.
     *
     * `resolvePersonClubId` LANZA cuando una persona figura como personal de
     * más de un club, y esa rama fue parte de la justificación para que un
     * administrador se salte la resolución de club. Al intentar montar el
     * escenario resultó que **la base no lo permite**: hay una restricción que
     * rechaza el segundo vínculo.
     *
     * O sea que la rama solo puede activarse con datos anteriores a esa
     * restricción o insertados por fuera —que es lo que su propio comentario
     * dice—, no con nada que la aplicación pueda crear hoy. Se deja esto
     * escrito para que nadie vuelva a justificar un cambio con un escenario
     * que no ocurre; la razón válida para saltarse la resolución es otra, y es
     * la que prueba el caso anterior: el alcance administrativo no depende de
     * ningún club.
     */
    const a = await createClub("Club A", "CLA");
    const b = await createClub("Club B", "CLB");
    const persona = await crearPersona("Dina", ["delegate"]);
    await addClubStaff(a.id, persona.id, "delegate");

    await expect(addClubStaff(b.id, persona.id, "coach")).rejects.toThrow(/un club a la vez/i);
  });

  it("marcar dos veces no duplica nada ni audita de más", async () => {
    const persona = await crearPersona("Eva", ["swimmer"]);
    await cuentaPara(persona);

    await personsService.setAdminAccess(persona.id, true, ADMIN);
    await personsService.setAdminAccess(persona.id, true, ADMIN);

    expect(await rolesDeLaCuenta(persona.id)).toEqual(["admin", "swimmer"]);
    const concesiones = await prisma.auditLog.count({ where: { action: "PERSON_ADMIN_ACCESS_GRANTED" } });
    expect(concesiones, "la segunda no cambió nada: no se audita").toBe(1);
  });
});

describe("conceder a una persona SIN cuenta", () => {
  it("guarda la marca y NO crea credenciales", async () => {
    const persona = await crearPersona("Fina");

    const r = await personsService.setAdminAccess(persona.id, true, ADMIN);

    expect(r.adminAccess).toBe(true);
    expect(r.tieneCuenta).toBe(false);
    expect(await marcaEnLaPersona(persona.id)).toBe(true);
    expect(await prisma.user.count({ where: { personId: persona.id } }), "no se creó ninguna cuenta").toBe(0);
  });

  it("funciona aunque la persona no tenga NINGÚN rol funcional", async () => {
    const persona = await crearPersona("Gala");
    expect(await prisma.personRole.count({ where: { personId: persona.id } })).toBe(0);

    await personsService.setAdminAccess(persona.id, true, ADMIN);
    expect(await marcaEnLaPersona(persona.id)).toBe(true);
  });

  it("«Crear credenciales» le da una cuenta administrativa, sin exigir otro rol", async () => {
    const persona = await crearPersona("Hana");
    await personsService.setAdminAccess(persona.id, true, ADMIN);

    // Sin la marca, esto se rechazaría por no tener ningún rol de acceso.
    const credenciales = await personsService.createCredentials(persona.id, ADMIN);

    expect(credenciales.temporaryPassword).toBeTruthy();
    expect(await rolesDeLaCuenta(persona.id)).toEqual(["admin"]);

    const cuenta = await prisma.user.findFirstOrThrow({ where: { personId: persona.id } });
    expect(cuenta.mustChangePassword, "contraseña temporal, cambio obligatorio").toBe(true);

    const estado = (await loadAuthorizationState(cuenta.id))!;
    expect(estado.roles).toEqual(["admin"]);
    expect(estado.clubId).toBeNull();
  });

  it("sin la marca y sin roles funcionales, crear credenciales sigue rechazándose", async () => {
    const persona = await crearPersona("Ida");
    await expect(personsService.createCredentials(persona.id, ADMIN)).rejects.toThrow(/no tiene ningún rol que otorgue acceso/i);
  });
});

describe("retirar permisos", () => {
  async function personaAdministradoraConCuenta(nombre: string, roles: string[] = ["swimmer"]) {
    const persona = await crearPersona(nombre, ["swimmer"]);
    const cuenta = await cuentaPara(persona, roles);
    await personsService.setAdminAccess(persona.id, true, ADMIN);
    return { persona, cuenta };
  }

  it("quita SOLO el rol administrativo y conserva los demás", async () => {
    const { persona, cuenta } = await personaAdministradoraConCuenta("Juana", ["swimmer", "delegate"]);
    expect(await rolesDeLaCuenta(persona.id)).toContain("admin");

    await personsService.setAdminAccess(persona.id, false, ADMIN);

    expect(await marcaEnLaPersona(persona.id)).toBe(false);
    expect(await rolesDeLaCuenta(persona.id)).toEqual(["delegate", "swimmer"]);
    expect((await loadAuthorizationState(cuenta.id))!.roles).not.toContain("admin");
  });

  it("los PersonRole funcionales quedan intactos", async () => {
    const { persona } = await personaAdministradoraConCuenta("Kira");
    const antes = await prisma.personRole.count({ where: { personId: persona.id } });

    await personsService.setAdminAccess(persona.id, false, ADMIN);

    expect(await prisma.personRole.count({ where: { personId: persona.id } })).toBe(antes);
  });

  it("los permisos se pierden en la SIGUIENTE lectura de autorización", async () => {
    const { persona, cuenta } = await personaAdministradoraConCuenta("Lena");
    expect((await loadAuthorizationState(cuenta.id))!.permissions).toContain("persons:write");

    await personsService.setAdminAccess(persona.id, false, ADMIN);

    // `authenticate` llama exactamente a esto en cada solicitud.
    expect((await loadAuthorizationState(cuenta.id))!.permissions).not.toContain("persons:write");
  });

  it("revoca los refresh tokens de esa cuenta, y solo de esa", async () => {
    const { persona, cuenta } = await personaAdministradoraConCuenta("Mia");
    const otra = await crearPersona("Nora", ["swimmer"]);
    const cuentaAjena = await cuentaPara(otra);

    for (const userId of [cuenta.id, cuentaAjena.id]) {
      await prisma.refreshToken.create({
        data: { userId, tokenHash: `hash_${userId}`, expiresAt: new Date(Date.now() + 86_400_000) },
      });
    }

    const r = await personsService.setAdminAccess(persona.id, false, ADMIN);

    expect(r.sesionesRevocadas).toBe(1);
    expect((await prisma.refreshToken.findFirstOrThrow({ where: { userId: cuenta.id } })).revokedAt).not.toBeNull();
    expect(
      (await prisma.refreshToken.findFirstOrThrow({ where: { userId: cuentaAjena.id } })).revokedAt,
      "la sesión de otra persona no se toca"
    ).toBeNull();
  });
});

describe("no se puede dejar el sistema sin administradores", () => {
  /** Deja a `persona` como ÚNICA administradora: la cuenta system se retira. */
  async function unicaAdministradora() {
    const persona = await crearPersona("Olga", ["swimmer"]);
    const cuenta = await cuentaPara(persona);
    await personsService.setAdminAccess(persona.id, true, ADMIN);
    // Se inhabilita la cuenta system para que quede una sola administradora.
    await prisma.user.update({ where: { id: cuentaSystem.id }, data: { status: "disabled" } });
    return { persona, cuenta };
  }

  it("RECHAZA retirar el rol a la última administradora", async () => {
    const { persona } = await unicaAdministradora();

    await expect(personsService.setAdminAccess(persona.id, false, ADMIN)).rejects.toThrow(/sin ningún administrador/i);
    expect(await marcaEnLaPersona(persona.id), "no se escribió nada").toBe(true);
  });

  it("RECHAZA bloquearla, inhabilitarla y eliminarla", async () => {
    const { persona } = await unicaAdministradora();

    await expect(personsService.blockPerson(persona.id, ADMIN)).rejects.toThrow(/sin ningún administrador/i);
    await expect(personsService.disablePerson(persona.id, ADMIN)).rejects.toThrow(/sin ningún administrador/i);
    await expect(personsService.softDeletePerson(persona.id, ADMIN)).rejects.toThrow(/sin ningún administrador/i);

    const fila = await prisma.person.findUniqueOrThrow({ where: { id: persona.id } });
    expect(fila.status).toBe("active");
    expect(fila.deletedAt).toBeNull();
  });

  it("la cuenta `system` CUENTA como administrador: con ella activa, sí se puede retirar", async () => {
    const persona = await crearPersona("Pia", ["swimmer"]);
    await cuentaPara(persona);
    await personsService.setAdminAccess(persona.id, true, ADMIN);

    await personsService.setAdminAccess(persona.id, false, ADMIN);
    expect(await marcaEnLaPersona(persona.id)).toBe(false);

    // Y la cuenta system sigue intacta, con su rol.
    const system = await prisma.user.findUniqueOrThrow({
      where: { id: cuentaSystem.id },
      include: { userRoles: { include: { role: true } } },
    });
    expect(system.status).toBe("active");
    expect(system.userRoles.map((ur) => ur.role.name)).toContain("admin");
    expect(system.personId, "nunca se convierte en persona").toBeNull();
  });

  it("un administrador BLOQUEADO no cuenta: retirar al otro se rechaza", async () => {
    const bloqueada = await crearPersona("Queca", ["swimmer"]);
    await cuentaPara(bloqueada, ["swimmer"], { status: "locked" });
    await personsService.setAdminAccess(bloqueada.id, true, ADMIN);

    const activa = await crearPersona("Rita", ["swimmer"]);
    await cuentaPara(activa);
    await personsService.setAdminAccess(activa.id, true, ADMIN);

    await prisma.user.update({ where: { id: cuentaSystem.id }, data: { status: "disabled" } });

    await expect(personsService.setAdminAccess(activa.id, false, ADMIN)).rejects.toThrow(/sin ningún administrador/i);
  });

  it("CONCURRENCIA: dos retiros simultáneos de los dos últimos no pueden pasar ambos", async () => {
    const a = await crearPersona("Sara", ["swimmer"]);
    const b = await crearPersona("Tina", ["swimmer"]);
    await cuentaPara(a);
    await cuentaPara(b);
    await personsService.setAdminAccess(a.id, true, ADMIN);
    await personsService.setAdminAccess(b.id, true, ADMIN);
    await prisma.user.update({ where: { id: cuentaSystem.id }, data: { status: "disabled" } });

    await Promise.allSettled([
      personsService.setAdminAccess(a.id, false, ADMIN),
      personsService.setAdminAccess(b.id, false, ADMIN),
    ]);

    /**
     * El resultado prohibido es cero administradores utilizables. Da igual
     * cuál de los dos retiros gane —o si los dos fallan por conflicto—, pero
     * no pueden ganar los dos.
     */
    const quedan = await prisma.user.count({
      where: {
        status: "active",
        deletedAt: null,
        userRoles: { some: { role: { name: "admin" } } },
        OR: [{ person: { is: null } }, { person: { is: { status: "active", deletedAt: null } } }],
      },
    });
    expect(quedan, "nunca puede quedar el sistema sin administradores").toBeGreaterThanOrEqual(1);
  });
});

/**
 * La casilla y la creación de credenciales escriben en tablas distintas
 * —`persons.admin_access` y `user_roles`— para sostener UNA sola verdad. Estas
 * pruebas ejecutan las dos a la vez, que es cuando esa verdad se puede partir.
 */
describe("concurrencia entre la casilla y la creación de credenciales", () => {
  interface EstadoFinal {
    marca: boolean;
    tieneCuenta: boolean;
    /** `null` cuando no hay cuenta: no hay rol que comparar. */
    rolAdmin: boolean | null;
    roles: string[];
  }

  async function leerEstado(personId: string): Promise<EstadoFinal> {
    const persona = await prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { adminAccess: true } });
    const cuenta = await prisma.user.findFirst({
      where: { personId, deletedAt: null },
      include: { userRoles: { include: { role: true } } },
    });
    const roles = (cuenta?.userRoles ?? []).map((ur) => ur.role.name).sort();
    return { marca: persona.adminAccess, tieneCuenta: Boolean(cuenta), rolAdmin: cuenta ? roles.includes(ROL_ADMIN) : null, roles };
  }

  /**
   * LA INVARIANTE, escrita una sola vez: si la cuenta existe, su rol `admin`
   * dice exactamente lo mismo que la marca de la persona. Sin cuenta no hay
   * nada que alinear — la marca sola es una intención, no un acceso.
   */
  function exigirCoherencia(estado: EstadoFinal, contexto: string) {
    if (!estado.tieneCuenta) return;
    expect(estado.rolAdmin, `${contexto} — marca=${estado.marca}, roles=[${estado.roles.join(", ")}]`).toBe(estado.marca);
  }

  /**
   * Un rechazo aceptable es el conflicto de serialización: explícito (409),
   * con un mensaje que dice qué hacer, y reintentable. Cualquier otro error
   * significa que la operación se rompió por otra causa.
   */
  function exigirConflictoRecuperable(motivo: unknown, contexto: string) {
    const detalle = `${contexto} — ${(motivo as { code?: string })?.code ?? "sin código"}: ${(motivo as Error)?.message}`;
    expect(motivo, detalle).toBeInstanceOf(ConflictError);
    expect((motivo as ConflictError).statusCode, contexto).toBe(409);
    expect((motivo as ConflictError).message, contexto).toMatch(/al mismo tiempo.*int[ée]ntelo|vuelva a intentarlo/i);
  }

  /**
   * BARRER EL ENTRELAZADO, en vez de repetir la misma carrera y confiar en la
   * suerte.
   *
   * Lanzar las dos operaciones a la vez no prueba nada: `createCredentials`
   * empieza calculando el hash de la contraseña, así que una casilla lanzada
   * al mismo tiempo casi siempre termina ANTES de que la creación llegue a
   * leer la marca, y el desenlace es el bueno por casualidad. Se comprobó:
   * con la lectura fuera de la transacción —el fallo que se está
   * corrigiendo— esa versión de la prueba pasaba igual.
   *
   * Por eso la casilla se lanza con distintos retrasos. Y esos retrasos NO
   * son milisegundos fijos: una máquina de integración continua más lenta
   * —o más rápida— corre la ventana entera y dejaría el barrido apuntando a
   * donde ya no hay nada. Se miden aquí, contra esta máquina, y se expresan
   * como fracciones de lo que tarda una creación de credenciales completa.
   *
   * ESTE BARRIDO ES EL QUE GUARDA LA REGRESIÓN. Se comprobó devolviendo el
   * código a su forma anterior —lecturas fuera de la transacción y el hash
   * calculado entre la lectura y la escritura— y las dos direcciones fallan
   * con los estados incoherentes exactos. Las dos pruebas deterministas de
   * más arriba comprueban la invariante sin relojes, pero no discriminan esa
   * regresión: allí está explicado por qué.
   *
   * Lo que no se puede quitar del todo es la dependencia del reloj: el
   * entrelazado que rompía la invariante ocurre entre una lectura y una
   * escritura que, ya corregidas, no dejan ningún punto observable donde
   * detenerse. Expresar los retrasos en múltiplos de algo medido AQUÍ es lo
   * que evita que el barrido apunte al vacío en una máquina distinta.
   */
  const FRACCIONES_DE_LA_REFERENCIA = [0, 0.25, 0.5, 0.75, 1, 1.25];

  /** Cuánto tarda una creación de credenciales completa en esta máquina. */
  async function medirReferencia(): Promise<number> {
    const persona = await crearPersona("Referencia", ["swimmer"]);
    const inicio = Date.now();
    await personsService.createCredentials(persona.id, ADMIN);
    // Un piso para que en una máquina muy rápida el barrido no colapse a cero.
    return Math.max(40, Date.now() - inicio);
  }

  /**
   * ENTRELAZADO DETERMINISTA, sin relojes.
   *
   * La idea es detener la casilla justo entre su lectura y su escritura
   * —la ventana donde las dos filas se separaban— y dejar que la creación de
   * credenciales la atraviese entera.
   *
   * CUÁL ES LA VENTANA, EXACTAMENTE. No es «mientras la casilla actualiza»:
   * eso PostgreSQL ya lo serializa solo. Se comprobó intentándolo —pausando
   * la casilla dentro de su `UPDATE`— y se vio en `pg_stat_activity` que el
   * `INSERT` de la cuenta quedaba esperando un `ShareLock` sobre el
   * identificador de esa transacción: la comprobación de clave foránea no
   * puede pasar por encima de una fila en curso de actualización. Los tres
   * participantes se quedaban esperándose.
   *
   * La ventana verdadera es la contraria: entre la LECTURA de la marca que
   * hace la creación de credenciales y su propio `INSERT`, con la casilla
   * entera —actualización y confirmación— metida en medio. Por eso se pausa
   * la CREACIÓN, con un disparador `BEFORE INSERT` sobre `users` que pide un
   * cerrojo consultivo: se ejecuta antes de que el insert tome nada, así que
   * la casilla circula sin estorbo.
   *
   * QUÉ PRUEBA Y QUÉ NO PRUEBA ESTE CRUCE. Comprueba la invariante bajo un
   * entrelazado exacto y sin depender de ningún reloj, y que el desenlace es
   * un conflicto traducido. NO sirve, por sí solo, como guardia contra la
   * regresión de sacar la lectura de la transacción: se midió devolviendo el
   * código a esa forma y el cruce seguía saliendo bien, porque las OTRAS
   * lecturas que la creación hace dentro de su transacción —la comprobación
   * del nombre de usuario— ya bastan para que PostgreSQL detecte el
   * conflicto en este entrelazado concreto. De esa regresión se encarga el
   * barrido de más abajo, y así está comprobado.
   */
  const CLAVE_DEL_CERROJO = 918_273_645;
  const DISPARADOR = "prueba_pausa_users";

  async function instalarLaPausa() {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${DISPARADOR}() RETURNS trigger AS $BODY$
      BEGIN
        PERFORM pg_advisory_xact_lock(${CLAVE_DEL_CERROJO});
        RETURN NEW;
      END;
      $BODY$ LANGUAGE plpgsql;`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${DISPARADOR} ON users;`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${DISPARADOR} BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION ${DISPARADOR}();`
    );
  }

  async function quitarLaPausa() {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${DISPARADOR} ON users;`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${DISPARADOR}();`);
  }

  /** Espera —preguntando, no durmiendo— a que alguien quede detenido en el cerrojo. */
  async function esperarAQueLaCreacionSeDetenga() {
    const limite = Date.now() + 15_000;
    while (Date.now() < limite) {
      const filas = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      if (Number(filas[0]!.n) > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("la creación nunca quedó detenida en el cerrojo: la prueba no llegó a provocar el entrelazado");
  }

  interface ResultadoDelCruce {
    casilla: PromiseSettledResult<unknown>;
    credenciales: PromiseSettledResult<unknown>;
  }

  function asentar<T>(promesa: Promise<T>): Promise<PromiseSettledResult<T>> {
    return promesa.then(
      (value) => ({ status: "fulfilled", value }) as PromiseSettledResult<T>,
      (reason) => ({ status: "rejected", reason }) as PromiseSettledResult<T>
    );
  }

  /**
   * Ejecuta el cruce: la creación de credenciales entra primero, lee la marca
   * y se queda detenida justo antes de insertar la cuenta; la casilla se
   * ejecuta ENTERA por encima; después se suelta la creación.
   */
  async function cruzarConLaCreacionPausada(personId: string, valorDeLaCasilla: boolean): Promise<ResultadoDelCruce> {
    let soltar!: () => void;
    let avisarQueTieneElCerrojo!: () => void;
    const liberar = new Promise<void>((r) => (soltar = r));
    const yaLoTiene = new Promise<void>((r) => (avisarQueTieneElCerrojo = r));

    await instalarLaPausa();

    const barrera = prisma.$transaction(
      async (tx) => {
        // `$executeRaw` y no `$queryRaw`: la función devuelve `void` y Prisma
        // no sabe deserializar ese tipo como resultado de una consulta.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CLAVE_DEL_CERROJO})`;
        avisarQueTieneElCerrojo();
        await liberar;
      },
      { maxWait: 20_000, timeout: 60_000 }
    );

    try {
      await yaLoTiene;

      // La creación arranca, lee la marca y se detiene en el disparador,
      // justo antes de insertar la cuenta.
      const credenciales = asentar(personsService.createCredentials(personId, ADMIN));
      await esperarAQueLaCreacionSeDetenga();

      // La casilla pasa entera por encima: nada la bloquea.
      const casilla = await asentar(personsService.setAdminAccess(personId, valorDeLaCasilla, ADMIN));

      soltar();
      return { casilla, credenciales: await credenciales };
    } finally {
      soltar();
      await barrera.catch(() => undefined);
      await quitarLaPausa();
    }
  }

  /**
   * CALENTAR EL CONJUNTO DE CONEXIONES antes de medir nada.
   *
   * Prisma abre conexiones a demanda y de una en una, y aquí cada una tarda
   * cientos de milisegundos en establecerse (PostgreSQL en Docker). La
   * consecuencia, comprobada: la segunda operación de la carrera no
   * alcanzaba a ABRIR su transacción dentro del plazo y fallaba con P2028
   * —saturación— en lugar de llegar a competir. Se medía el conjunto de
   * conexiones, no la invariante.
   *
   * Seis consultas simultáneas bastan para que el conjunto crezca —hacen
   * falta cuatro a la vez en el cruce determinista: la barrera, la casilla,
   * las credenciales y la sesión que observa los bloqueos—; a partir de ahí
   * las transacciones se solapan de verdad.
   */
  beforeAll(async () => {
    await Promise.all([1, 2, 3, 4, 5, 6].map(() => prisma.person.count()));
  });

  function conRetraso<T>(ms: number, operacion: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolver, rechazar) => {
      setTimeout(() => operacion().then(resolver, rechazar), ms);
    });
  }

  it("DETERMINISTA — marcar mientras se crean las credenciales: la cuenta nunca nace sin el rol que la marca promete", async () => {
    const persona = await crearPersona("Determinista A", ["swimmer"]);

    const { casilla, credenciales } = await cruzarConLaCreacionPausada(persona.id, true);

    for (const [nombre, resultado] of [["setAdminAccess", casilla], ["createCredentials", credenciales]] as const) {
      if (resultado.status === "rejected") exigirConflictoRecuperable(resultado.reason, `cruce determinista · ${nombre}`);
    }

    const estado = await leerEstado(persona.id);
    exigirCoherencia(estado, "cruce determinista: marcar + crear credenciales");

    /**
     * Con este entrelazado, una de las dos TIENE que ceder: la creación leyó
     * la marca antes de que la casilla la cambiara, así que dejarlas pasar a
     * las dos sería precisamente la incoherencia. Que ceda por conflicto
     * —explícito y reintentable— es el comportamiento correcto.
     */
    expect(
      casilla.status === "rejected" || credenciales.status === "rejected",
      "en este cruce las dos no pueden salir bien: una debe fallar por conflicto"
    ).toBe(true);
  });

  it("DETERMINISTA — desmarcar mientras se crean las credenciales: la cuenta nunca nace con un rol que la marca negó", async () => {
    const persona = await crearPersona("Determinista B", ["swimmer"]);
    await personsService.setAdminAccess(persona.id, true, ADMIN);

    const { casilla, credenciales } = await cruzarConLaCreacionPausada(persona.id, false);

    for (const [nombre, resultado] of [["setAdminAccess", casilla], ["createCredentials", credenciales]] as const) {
      if (resultado.status === "rejected") exigirConflictoRecuperable(resultado.reason, `cruce determinista · ${nombre}`);
    }

    const estado = await leerEstado(persona.id);
    exigirCoherencia(estado, "cruce determinista: desmarcar + crear credenciales");
    expect(
      estado.marca === false && estado.rolAdmin === true,
      "cruce determinista: acceso administrativo sin marca que lo declare"
    ).toBe(false);
    expect(casilla.status === "rejected" || credenciales.status === "rejected").toBe(true);
  });

  it("marcar + crear credenciales a la vez: la cuenta nunca nace sin el rol que la marca promete", async () => {
    const referencia = await medirReferencia();
    for (const fraccion of FRACCIONES_DE_LA_REFERENCIA) {
      const retraso = Math.round(fraccion * referencia);
      const persona = await crearPersona(`Concurrente A${retraso}`, ["swimmer"]);
      const contexto = `casilla a ${fraccion}× la referencia (${retraso} ms)`;

      const [marcado, credenciales] = await Promise.allSettled([
        conRetraso(retraso, () => personsService.setAdminAccess(persona.id, true, ADMIN)),
        personsService.createCredentials(persona.id, ADMIN),
      ]);

      for (const [nombre, resultado] of [["setAdminAccess", marcado], ["createCredentials", credenciales]] as const) {
        if (resultado.status === "rejected") exigirConflictoRecuperable(resultado.reason, `${contexto} · ${nombre}`);
      }

      const estado = await leerEstado(persona.id);
      exigirCoherencia(estado, `${contexto}: marcar + crear credenciales`);

      /**
       * Y el caso concreto que motivó el cambio: si las DOS operaciones
       * salieron bien, la marca quedó puesta y la cuenta existe, así que la
       * cuenta tiene que poder administrar. Antes nacía sin el rol.
       */
      if (marcado.status === "fulfilled" && credenciales.status === "fulfilled") {
        expect(estado.marca, contexto).toBe(true);
        expect(estado.rolAdmin, `${contexto}: ambas salieron bien, la cuenta debe ser administrativa`).toBe(true);
      }
    }
  });

  it("desmarcar + crear credenciales a la vez: la cuenta nunca nace con un rol que la marca ya negó", async () => {
    const referencia = await medirReferencia();
    for (const fraccion of FRACCIONES_DE_LA_REFERENCIA) {
      const retraso = Math.round(fraccion * referencia);
      const persona = await crearPersona(`Concurrente B${retraso}`, ["swimmer"]);
      // La marca puesta ANTES, con la persona todavía sin cuenta: es el estado
      // desde el que la creación de credenciales hereda el rol.
      await personsService.setAdminAccess(persona.id, true, ADMIN);
      const contexto = `casilla a ${fraccion}× la referencia (${retraso} ms)`;

      const [desmarcado, credenciales] = await Promise.allSettled([
        conRetraso(retraso, () => personsService.setAdminAccess(persona.id, false, ADMIN)),
        personsService.createCredentials(persona.id, ADMIN),
      ]);

      for (const [nombre, resultado] of [["setAdminAccess", desmarcado], ["createCredentials", credenciales]] as const) {
        if (resultado.status === "rejected") exigirConflictoRecuperable(resultado.reason, `${contexto} · ${nombre}`);
      }

      const estado = await leerEstado(persona.id);
      exigirCoherencia(estado, `${contexto}: desmarcar + crear credenciales`);

      /**
       * El desenlace prohibido, dicho aparte porque es el peligroso: una
       * cuenta con acceso administrativo real y una marca que lo niega. Nadie
       * lo vería en la ficha.
       */
      expect(
        estado.marca === false && estado.rolAdmin === true,
        `${contexto}: acceso administrativo sin marca que lo declare`
      ).toBe(false);
    }
  });

  it("tras un conflicto, repetir la operación funciona y deja el estado coherente", async () => {
    /**
     * «Recuperable» no es solo el mensaje: la transacción abortada no debe
     * dejar nada a medias. Aquí se fuerza el reintento de lo que haya fallado
     * y se comprueba que el segundo intento sí llega a término.
     */
    const persona = await crearPersona("Concurrente Reintento", ["swimmer"]);

    const [marcado, credenciales] = await Promise.allSettled([
      personsService.setAdminAccess(persona.id, true, ADMIN),
      personsService.createCredentials(persona.id, ADMIN),
    ]);

    if (marcado.status === "rejected") await personsService.setAdminAccess(persona.id, true, ADMIN);
    if (credenciales.status === "rejected") await personsService.createCredentials(persona.id, ADMIN);

    const estado = await leerEstado(persona.id);
    expect(estado.marca, "tras reintentar, la marca quedó puesta").toBe(true);
    expect(estado.tieneCuenta, "tras reintentar, la cuenta existe").toBe(true);
    exigirCoherencia(estado, "tras el reintento");
    expect(estado.rolAdmin).toBe(true);
  });

  it("una cuenta duplicada sigue siendo imposible aunque se pida dos veces a la vez", async () => {
    /**
     * La creación de credenciales pasó a ser serializable; conviene dejar
     * fijado que eso no relajó la otra garantía que ya tenía.
     */
    const persona = await crearPersona("Concurrente Doble", ["swimmer"]);

    const resultados = await Promise.allSettled([
      personsService.createCredentials(persona.id, ADMIN),
      personsService.createCredentials(persona.id, ADMIN),
    ]);

    expect(resultados.filter((r) => r.status === "fulfilled"), "solo una puede crear la cuenta").toHaveLength(1);
    expect(await prisma.user.count({ where: { personId: persona.id, deletedAt: null } })).toBe(1);
  });
});

describe("estado de la persona y del acceso", () => {
  it("no se conceden permisos a una persona inhabilitada", async () => {
    const persona = await crearPersona("Ursula", ["swimmer"]);
    await cuentaPara(persona);
    await personsService.disablePerson(persona.id, ADMIN);

    await expect(personsService.setAdminAccess(persona.id, true, ADMIN)).rejects.toThrow(/bloqueada, inhabilitada o eliminada/i);
  });

  it("una persona inhabilitada NO obtiene acceso aunque su cuenta figure activa", async () => {
    /**
     * `users.status` y `persons.status` son columnas distintas y nada en la
     * base obliga a que coincidan. Aquí se fuerza esa incoherencia a mano
     * —reactivando solo la cuenta— porque es justo el agujero que la
     * comprobación nueva cierra.
     */
    const persona = await crearPersona("Vera", ["swimmer"]);
    const cuenta = await cuentaPara(persona);
    await personsService.setAdminAccess(persona.id, true, ADMIN);
    await personsService.disablePerson(persona.id, ADMIN);
    await prisma.user.update({ where: { id: cuenta.id }, data: { status: "active", deletedAt: null } });

    const estado = (await loadAuthorizationState(cuenta.id))!;
    expect(estado.usable, "la persona está inhabilitada: la sesión no es utilizable").toBe(false);
  });

  it("las cuentas `system` y `club` no cambian de comportamiento", async () => {
    const club = await createClub("Club Dos", "CD2");
    const cuentaClub = await createUser({ username: club.username, roleNames: ["club"], clubId: club.id });

    for (const id of [cuentaSystem.id, cuentaClub.id]) {
      const estado = (await loadAuthorizationState(id))!;
      expect(estado.usable, `cuenta ${id}`).toBe(true);
    }
    expect((await loadAuthorizationState(cuentaClub.id))!.clubId).toBe(club.id);
  });

  it("una persona eliminada pierde el acceso aunque tuviera la marca", async () => {
    const persona = await crearPersona("Wanda", ["swimmer"]);
    const cuenta = await cuentaPara(persona);
    await personsService.setAdminAccess(persona.id, true, ADMIN);

    await personsService.softDeletePerson(persona.id, ADMIN);

    expect((await loadAuthorizationState(cuenta.id))!.usable).toBe(false);
  });
});

describe("auditoría", () => {
  it("registra concesión y revocación, sin contraseñas ni tokens", async () => {
    const persona = await crearPersona("Xena", ["swimmer"]);
    await cuentaPara(persona);

    await personsService.setAdminAccess(persona.id, true, ADMIN);
    await personsService.setAdminAccess(persona.id, false, ADMIN);

    const registros = await prisma.auditLog.findMany({
      where: { action: { in: ["PERSON_ADMIN_ACCESS_GRANTED", "PERSON_ADMIN_ACCESS_REVOKED"] } },
      orderBy: { createdAt: "asc" },
    });
    expect(registros.map((r) => r.action)).toEqual(["PERSON_ADMIN_ACCESS_GRANTED", "PERSON_ADMIN_ACCESS_REVOKED"]);
    expect(registros.every((r) => r.entityId === persona.id)).toBe(true);

    const texto = JSON.stringify(registros);
    for (const prohibido of ["password", "passwordHash", "token", "tokenHash", TEST_PASSWORD]) {
      expect(texto.toLowerCase(), `no debe aparecer ${prohibido}`).not.toContain(prohibido.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * La casilla oculta en el frontend no protege nada: lo que protege es la ruta.
 * Estas pruebas llaman a la API por HTTP (`app.inject`), que es exactamente lo
 * que haría alguien que se saltara la interfaz.
 */
describe("la API exige el rol de administrador, no solo el permiso", () => {
  /** Añade un permiso a un rol, como si alguien reajustara la matriz RBAC. */
  async function concederPermisoAlRol(roleName: string, code: string) {
    const [rol, permiso] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { name: roleName } }),
      prisma.permission.findUniqueOrThrow({ where: { code } }),
    ]);
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: rol.id, permissionId: permiso.id } },
      update: {},
      create: { roleId: rol.id, permissionId: permiso.id },
    });
  }

  async function sinRastro(personId: string) {
    expect(await marcaEnLaPersona(personId), "la marca no debe haber cambiado").toBe(false);
    expect(await rolesDeLaCuenta(personId), "no debe haberse agregado el rol").not.toContain("admin");
    const auditoría = await prisma.auditLog.count({
      where: { action: { in: ["PERSON_ADMIN_ACCESS_GRANTED", "PERSON_ADMIN_ACCESS_REVOKED"] } },
    });
    expect(auditoría, "una llamada rechazada no registra concesión ni revocación").toBe(0);
  }

  it("un administrador SÍ puede (control positivo)", async () => {
    const persona = await crearPersona("Alba", ["swimmer"]);
    await cuentaPara(persona);

    const res = await llamarAdminAccess(persona.id, true, await iniciarSesion("system_admin"));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: persona.id, adminAccess: true });
    expect(await marcaEnLaPersona(persona.id)).toBe(true);
    expect(await rolesDeLaCuenta(persona.id)).toContain("admin");
  });

  it("un nadador no puede concederse permisos a sí mismo", async () => {
    const persona = await crearPersona("Bruno", ["swimmer"]);
    await cuentaPara(persona, ["swimmer"]);

    const res = await llamarAdminAccess(persona.id, true, await iniciarSesion(persona.username));

    expect(res.statusCode).toBe(403);
    await sinRastro(persona.id);
  });

  it("un delegado tampoco, ni sobre otra persona", async () => {
    const delegada = await crearPersona("Carmen", ["delegate"]);
    await cuentaPara(delegada, ["delegate"]);
    const objetivo = await crearPersona("Diego", ["swimmer"]);
    await cuentaPara(objetivo);

    const res = await llamarAdminAccess(objetivo.id, true, await iniciarSesion(delegada.username));

    expect(res.statusCode).toBe(403);
    await sinRastro(objetivo.id);
  });

  it("tener `persons:write` NO basta: el guard de rol es el que decide", async () => {
    /**
     * El escenario que justifica el doble guard de la ruta. Hoy `persons:write`
     * lo tiene solo `admin`, así que sin esto la comprobación de rol parecería
     * redundante; aquí se le concede el permiso a `delegate` —como haría quien
     * quisiera que los delegados editaran fichas— y la ruta sigue cerrada.
     */
    await concederPermisoAlRol("delegate", "persons:write");
    const delegada = await crearPersona("Elena", ["delegate"]);
    await cuentaPara(delegada, ["delegate"]);
    const objetivo = await crearPersona("Fabián", ["swimmer"]);
    await cuentaPara(objetivo);

    const token = await iniciarSesion(delegada.username);

    // Con ese permiso, editar la ficha sí le está permitido…
    const edición = await app.inject({
      method: "PUT",
      url: `/persons/${objetivo.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { firstName: "Fabián", paternalLastName: "Prueba", birthDate: "1990-05-05", gender: "male" },
    });
    expect(edición.statusCode, "el permiso nuevo sí habilita la edición corriente").toBe(200);

    // …y repartir administración, no.
    const res = await llamarAdminAccess(objetivo.id, true, token);
    expect(res.statusCode).toBe(403);
    expect(res.json().message ?? res.json().error).toMatch(/rol/i);
    await sinRastro(objetivo.id);
  });

  it("sin token no se llega siquiera a los guards", async () => {
    const persona = await crearPersona("Gabriela", ["swimmer"]);
    await cuentaPara(persona);

    expect((await llamarAdminAccess(persona.id, true)).statusCode).toBe(401);
    await sinRastro(persona.id);
  });

  it("a quien le retiran el rol, la MISMA sesión deja de servir", async () => {
    /**
     * No hace falta esperar a que caduque el access token: el estado de
     * autorización se relee de la base en cada solicitud.
     */
    const persona = await crearPersona("Hilda", ["swimmer"]);
    await cuentaPara(persona);
    await personsService.setAdminAccess(persona.id, true, ADMIN);

    const token = await iniciarSesion(persona.username);
    const objetivo = await crearPersona("Ignacio", ["swimmer"]);
    await cuentaPara(objetivo);

    expect((await llamarAdminAccess(objetivo.id, true, token)).statusCode, "mientras es administradora").toBe(200);

    // La cuenta `system` sigue siendo administradora, así que el retiro no
    // choca con la protección del último administrador.
    await personsService.setAdminAccess(persona.id, false, ADMIN);

    const después = await llamarAdminAccess(objetivo.id, false, token);
    expect(después.statusCode, "con el mismo token, ya sin el rol").toBe(403);
  });
});
