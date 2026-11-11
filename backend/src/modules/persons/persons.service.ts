import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { audit, withAudit } from "../audit/audit.service";
import {
  assertUsernameAvailable,
  conErroresDeIdentidad,
  MENSAJE_FALTA_USERNAME,
  MENSAJE_NOMBRE_BLOQUEADO,
  tieneCuentaVigente,
} from "../../shared/username";
import { hashPassword, generateOpaqueToken } from "../auth/password.util";
import { normalizeRun } from "../../shared/run.util";
import { ValidationError, NotFoundError } from "../../shared/errors";
import { formatPersonFullName } from "../../shared/personName.util";
import { withTranslatedPrismaErrors } from "../../shared/prismaErrors";
import { dbFrom, type Db, type TxOption } from "../../shared/transaction";
import {
  ROL_ADMIN,
  aplicarRolAdmin,
  cuentasAfectadasPorPersona,
  exigirQueQuedeAlgunAdministrador,
} from "./admin-access";
import { terminarSesionesDelTitular, terminarSesionesDelUsuario } from "../auth/sessions";
import { anularCuentaEnLimitador } from "../auth/limitadorLogin";
import type { PersonCreateInput, PersonUpdateInput, PersonListQuery } from "./persons.schemas";

interface ActorContext {
  userId: string;
  ipAddress?: string;
}

async function assertRunNotDuplicated(run: string, excludePersonId?: string, db: Db = prisma) {
  const normalized = normalizeRun(run);
  const existing = await db.person.findFirst({
    where: { run: normalized, deletedAt: null, ...(excludePersonId ? { id: { not: excludePersonId } } : {}) },
  });
  if (existing) {
    throw new ValidationError("Ya existe una persona registrada con este RUN");
  }
}

/**
 * Hallazgo 20: la comprobación miraba SOLO la tabla `persons`, así que un
 * club o una cuenta de acceso con el mismo nombre de usuario no la
 * activaban. El choque aparecía más tarde, al crear las credenciales, con la
 * persona ya creada y su nombre de usuario ya inmutable.
 * `assertUsernameAvailable` mira las tres tablas y dice cuál es el dueño.
 */

export async function listPersons(query: PersonListQuery) {
  const where: any = { deletedAt: null };

  if (query.search) {
    const term = query.search.trim();
    where.OR = [
      { fullName: { contains: term, mode: "insensitive" } },
      { run: { contains: normalizeRun(term) } },
    ];
  }
  if (query.status) where.status = query.status;
  if (query.role) where.roles = { some: { roleType: query.role, active: true } };

  const [items, total] = await Promise.all([
    prisma.person.findMany({
      where,
      include: { roles: { where: { active: true } } },
      // Los homónimos existen: sin `id` el orden entre ellos es arbitrario.
      orderBy: [{ fullName: "asc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.person.count({ where }),
  ]);

  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getPersonById(id: string) {
  const person = await prisma.person.findFirst({
    where: { id, deletedAt: null },
    include: { roles: true, user: { select: { id: true, username: true, status: true, mustChangePassword: true, lastLoginAt: true } } },
  });
  if (!person) throw new NotFoundError("Persona");
  return person;
}

/**
 * `options.tx`: la carga masiva crea la persona DENTRO de la transacción de su fila,
 * junto con la membresía, el rol derivado y la auditoría (etapa 6). Sin `tx` se
 * comporta exactamente como antes.
 */
export async function createPerson(input: PersonCreateInput, actor: ActorContext, options?: TxOption) {
  const db = dbFrom(options);
  const normalizedRun = normalizeRun(input.run);
  await assertRunNotDuplicated(normalizedRun, undefined, db);
  // Sin nombre de usuario la persona queda con `NULL`: no se genera ninguno ni
  // se crea cuenta. Registrar y dar acceso son pasos separados.
  const username = input.username ?? null;
  if (username) await assertUsernameAvailable(username, { tx: options?.tx });

  const person = await conErroresDeIdentidad(() => withAudit(
    (tx) =>
      tx.person.create({
    data: {
      run: normalizedRun,
      username,
      firstName: input.firstName,
      paternalLastName: input.paternalLastName,
      maternalLastName: input.maternalLastName || null,
      fullName: formatPersonFullName(input.firstName, input.paternalLastName, input.maternalLastName),
      birthDate: input.birthDate,
      gender: input.gender,
      email: input.email,
      phone: input.phone,
      status: "active",
      createdBy: actor.userId,
      updatedBy: actor.userId,
      // Sin roles: una persona recién creada no es todavía nadadora de ningún
      // club ni personal de ninguno. El rol aparece cuando aparece la relación
      // que lo justifica.
    },
        include: { roles: true },
      }),
    (person) => ({
      userId: actor.userId,
      action: "PERSON_CREATED",
      entityType: "Person",
      entityId: person.id,
      ipAddress: actor.ipAddress,
      after: person,
    }),
    options
  ));

  return person;
}

export async function updatePerson(id: string, input: PersonUpdateInput, actor: ActorContext) {
  const before = await getPersonById(id);

  // El nombre completo solo se recalcula si el admin efectivamente está
  // editando alguno de los 3 campos que lo componen — si ninguno viene en
  // este update, se deja `fullName` y los 3 campos crudos intactos (evita
  // sobrescribir con datos vacíos el `fullName` histórico de una persona
  // creada antes de este cambio, cuyos campos separados aún son `null`).
  const isEditingName = input.firstName !== undefined || input.paternalLastName !== undefined || input.maternalLastName !== undefined;
  const newFirstName = input.firstName ?? before.firstName ?? "";
  const newPaternalLastName = input.paternalLastName ?? before.paternalLastName ?? "";
  const newMaternalLastName = input.maternalLastName !== undefined ? input.maternalLastName : before.maternalLastName;

  if (isEditingName && (!newFirstName || !newPaternalLastName)) {
    throw new ValidationError(
      "Esta persona todavía no tiene nombre y apellido paterno por separado (fue creada antes de este cambio) — al editar el nombre, debe completar ambos campos."
    );
  }

  /**
   * Nombre de usuario: `undefined` no lo toca; un valor lo asigna o lo cambia;
   * `null` lo quita. Solo se considera si de verdad cambia —reenviar el mismo
   * nombre, aunque haya cuenta, no es un cambio—.
   */
  const cambiaUsername = input.username !== undefined && input.username !== before.username;

  const person = await conErroresDeIdentidad(() => prisma.$transaction(async (tx) => {
    if (cambiaUsername) {
      /**
       * Bloqueado con una cuenta VIGENTE (activa, bloqueada o inhabilitada).
       * Se comprueba dentro de la transacción para dar el mensaje; la garantía
       * frente a una creación de credenciales simultánea la da
       * `titular_forbid_rename_con_cuenta` junto con el cerrojo que toma sobre
       * esta misma fila `users_username_igual_al_titular`.
       */
      if (await tieneCuentaVigente({ personId: id }, { tx })) throw new ValidationError(MENSAJE_NOMBRE_BLOQUEADO);
      if (input.username) await assertUsernameAvailable(input.username, { excludePersonId: id, tx });
    }

    await tx.person.update({
      where: { id },
      data: {
        username: cambiaUsername ? input.username : undefined,
        firstName: isEditingName ? newFirstName : undefined,
        paternalLastName: isEditingName ? newPaternalLastName : undefined,
        maternalLastName: isEditingName ? newMaternalLastName || null : undefined,
        fullName: isEditingName ? formatPersonFullName(newFirstName, newPaternalLastName, newMaternalLastName) : undefined,
        birthDate: input.birthDate ?? undefined,
        gender: input.gender ?? undefined,
        // OJO: no usar `?? undefined` aquí — cuando la persona borra su
        // correo, el esquema lo transforma a `null` (para limpiarlo de
        // verdad), y `?? undefined` convertiría ese `null` de vuelta en
        // "no tocar el campo", dejando el correo viejo sin borrar nunca.
        email: input.email === undefined ? undefined : input.email,
        phone: input.phone ?? undefined,
        updatedBy: actor.userId,
      },
    });

    /**
     * SIN sincronización manual de roles.
     *
     * Aquí vivía un bloque que activaba y desactivaba `person_roles` —y los
     * `user_roles` derivados— según una lista que llegaba en el payload. Con
     * los roles derivados eso es una puerta trasera: permitía fabricar un
     * delegado sin nombramiento en `club_staff` o un nadador sin membresía en
     * `club_swimmers`, y el sistema quedaba afirmando dos cosas incompatibles.
     *
     * Quién escribe cada rol ahora:
     *   - `swimmer` → `syncSwimmerRole`, al cambiar una membresía;
     *   - `delegate` / `coach` / `legal_representative` → el alta y la baja de
     *     su nombramiento en la ficha del club.
     */

    const actualizada = await tx.person.findUniqueOrThrow({ where: { id }, include: { roles: true } });
    await audit(
      { userId: actor.userId, action: "PERSON_UPDATED", entityType: "Person", entityId: id, ipAddress: actor.ipAddress, before, after: actualizada },
      { tx }
    );
    return actualizada;
  }));

  return person;
}

async function setStatus(id: string, status: "active" | "locked" | "disabled", action: string, actor: ActorContext) {
  const before = await getPersonById(id);

  // Los tres pasos van en UNA transacción: cambiar el estado de la persona,
  // propagarlo a su cuenta y cortar sus sesiones. Antes eran dos escrituras
  // sueltas y las sesiones NO se cortaban: la persona bloqueada seguía
  // operando con su access token vigente y renovándolo con su refresh token.
  const person = await prisma.$transaction(async (tx) => {
    /**
     * Bloquear o inhabilitar a la última persona administradora dejaría el
     * sistema sin quien administre, así que se comprueba antes de escribir.
     *
     * Solo al salir de `active`: reactivar nunca puede dejar sin
     * administradores. La comprobación va dentro de esta transacción, que es
     * lo que impide que dos bloqueos simultáneos pasen ambos.
     */
    if (status !== "active") {
      const cuentas = await cuentasAfectadasPorPersona(tx, id);
      if (cuentas.length > 0) {
        const accion = status === "locked" ? "Bloquear a esta persona" : "Inhabilitar a esta persona";
        await exigirQueQuedeAlgunAdministrador(tx, cuentas, accion);
      }
    }

    const updated = await tx.person.update({ where: { id }, data: { status, updatedBy: actor.userId } });

    await tx.user.updateMany({
      where: { personId: id },
      data:
        status === "active"
          ? { status, lockedUntil: null, failedLoginAttempts: 0 }
          : // `lockedUntil: null` marca el bloqueo como ADMINISTRATIVO
            // (indefinido). Sin esto, un bloqueo temporal previo por
            // intentos fallidos dejaría una fecha de vencimiento y la
            // cuenta se reactivaría sola al pasar esa hora.
            { status, lockedUntil: null },
    });

    // Reactivar no revive nada: lo que se terminó aquí sigue terminado.
    if (status !== "active") await terminarSesionesDelTitular(tx, { personId: id }, "admin_revocation");
    await audit({ userId: actor.userId, action, entityType: "Person", entityId: id, ipAddress: actor.ipAddress, before, after: updated }, { tx });
    return updated;
  },
  // Serializable por la guarda del último administrador: sin esto, dos
  // bloqueos simultáneos de los dos últimos administradores pasarían ambos.
  { isolationLevel: "Serializable" });
  return person;
}

export const blockPerson = (id: string, actor: ActorContext) => setStatus(id, "locked", "PERSON_BLOCKED", actor);
export const disablePerson = (id: string, actor: ActorContext) => setStatus(id, "disabled", "PERSON_DISABLED", actor);
export const reactivatePerson = (id: string, actor: ActorContext) => setStatus(id, "active", "PERSON_REACTIVATED", actor);

/** Eliminación lógica (nunca física, ver requerimiento sección 5). */
export async function softDeletePerson(id: string, actor: ActorContext) {
  const before = await getPersonById(id);

  // La eliminación lógica NO tocaba la cuenta de acceso: la persona quedaba
  // "eliminada" pero su usuario seguía activo y podía entrar al sistema con
  // normalidad. Ahora se inhabilita, se marca como eliminada y se revocan
  // sus sesiones, todo en la misma transacción.
  const person = await prisma.$transaction(async (tx) => {
    // Eliminar a la última persona administradora dejaría el sistema sin
    // quien administre. Misma guarda, misma transacción.
    const cuentas = await cuentasAfectadasPorPersona(tx, id);
    if (cuentas.length > 0) {
      await exigirQueQuedeAlgunAdministrador(tx, cuentas, "Eliminar a esta persona");
    }

    const updated = await tx.person.update({
      where: { id },
      data: { deletedAt: new Date(), status: "disabled", updatedBy: actor.userId },
    });
    await tx.user.updateMany({ where: { personId: id }, data: { status: "disabled", deletedAt: new Date(), lockedUntil: null } });
    await terminarSesionesDelTitular(tx, { personId: id }, "admin_revocation");
    await audit(
      { userId: actor.userId, action: "PERSON_DELETED", entityType: "Person", entityId: id, ipAddress: actor.ipAddress, before, after: updated },
      { tx }
    );
    return updated;
  },
  // Serializable por la guarda del último administrador, igual que en
  // `setStatus`: dos eliminaciones simultáneas no pueden pasar ambas.
  { isolationLevel: "Serializable" });
  return person;
}

// --------------------------------------------------------------------------
// Permisos de administrador (casilla «Habilitar permisos de administrador»)
// --------------------------------------------------------------------------

/**
 * Concede o retira permisos de administrador a una persona.
 *
 * ES EL ÚNICO ESCRITOR de `persons.admin_access` y el único que crea o borra
 * la fila `user_roles` del rol `admin` para una cuenta de persona. Esa
 * exclusividad es lo que mantiene coherentes la marca y el rol: si mañana
 * apareciera un segundo camino, la coherencia dejaría de estar garantizada
 * —ninguna restricción de la base puede imponerla, porque cruza tres tablas—.
 * `scripts/auditar-admin-desincronizado.sql` sirve para comprobarlo.
 *
 * Todo ocurre en UNA transacción serializable:
 *   1. se lee el conjunto de administradores utilizables;
 *   2. se comprueba que la operación no lo deje vacío;
 *   3. se escribe la marca y se ajusta el rol.
 *
 * Leer fuera y escribir después dejaría la carrera clásica: dos revocaciones
 * simultáneas de los dos últimos administradores verían ambas «queda otro» y
 * ambas seguirían adelante.
 *
 * LOS DEMÁS ROLES NO SE TOCAN. Ni los `PersonRole` funcionales ni los otros
 * `UserRole` de la cuenta: quitar el acceso administrativo a una delegada la
 * devuelve a ser delegada, no la deja sin nada.
 */
export async function setAdminAccess(personId: string, enabled: boolean, actor: ActorContext) {
  return withTranslatedPrismaErrors(() =>
    prisma.$transaction(
      async (tx) => {
        const person = await tx.person.findUnique({
          where: { id: personId },
          select: { id: true, fullName: true, adminAccess: true, status: true, deletedAt: true, user: { select: { id: true, status: true } } },
        });
        if (!person) throw new NotFoundError("Persona");

        /**
         * Conceder a una persona inhabilitada o eliminada no tiene sentido y
         * además sería engañoso: la marca quedaría puesta y el acceso no
         * existiría, porque la autenticación ya rechaza a esas personas.
         * Retirar sí se permite siempre — quitar permisos nunca debe
         * bloquearse por el estado de quien los pierde.
         */
        if (enabled && (person.status !== "active" || person.deletedAt !== null)) {
          throw new ValidationError(
            "No se pueden conceder permisos de administrador a una persona bloqueada, inhabilitada o eliminada. " +
              "Reactívela primero."
          );
        }

        const cuentaId = person.user?.id ?? null;

        if (!enabled && cuentaId) {
          await exigirQueQuedeAlgunAdministrador(tx, [cuentaId], "Retirar los permisos de administrador de esta persona");
        }

        const cambioLaMarca = person.adminAccess !== enabled;
        const actualizada = await tx.person.update({
          where: { id: personId },
          data: { adminAccess: enabled, updatedBy: actor.userId },
          select: { id: true, fullName: true, adminAccess: true },
        });

        /**
         * Sin cuenta, la marca queda guardada y nada más: NO se crean
         * credenciales ni se genera contraseña. `createCredentials` la leerá
         * cuando alguien decida crear la cuenta.
         */
        let cambioElRol = false;
        let sesionesRevocadas = 0;
        if (cuentaId) {
          cambioElRol = await aplicarRolAdmin(tx, cuentaId, enabled);
          // Al RETIRAR se revocan las sesiones. Al conceder no: nadie queda
          // con permisos de más por seguir con su sesión abierta.
          if (!enabled && cambioElRol) {
            sesionesRevocadas = await terminarSesionesDelUsuario(tx, cuentaId, "admin_revocation");
          }
        }

        if (cambioLaMarca || cambioElRol) {
          await audit(
            {
              userId: actor.userId,
              action: enabled ? "PERSON_ADMIN_ACCESS_GRANTED" : "PERSON_ADMIN_ACCESS_REVOKED",
              entityType: "Person",
              entityId: personId,
              ipAddress: actor.ipAddress,
              before: { adminAccess: person.adminAccess },
              // Sin contraseñas ni tokens: solo qué cambió y sobre qué cuenta.
              after: { adminAccess: enabled, cuentaAfectada: cuentaId, rolAjustado: cambioElRol, sesionesRevocadas },
            },
            { tx }
          );
        }

        return {
          ...actualizada,
          tieneCuenta: cuentaId !== null,
          sesionesRevocadas,
        };
      },
      { isolationLevel: "Serializable" }
    )
  );
}

// --------------------------------------------------------------------------
// Credenciales de acceso (RB-01: un user = una persona XOR un club)
// --------------------------------------------------------------------------

/**
 * Crea una cuenta de acceso para la persona, con contraseña temporal que debe
 * cambiarse en el primer ingreso. Retorna la contraseña en claro UNA SOLA VEZ
 * (para comunicarla fuera de banda); nunca se persiste ni se vuelve a exponer.
 *
 * NOMBRE DE USUARIO: el de `opciones.username` si viene, o el que la persona
 * ya tenga guardado. Sin ninguno de los dos, 400 y nada se escribe. Si viene
 * uno distinto del guardado, se asigna a la persona EN LA MISMA TRANSACCIÓN
 * que crea la cuenta: o quedan los dos, o ninguno. Un fallo en cualquier paso
 * deja la persona exactamente como estaba, con el nombre todavía editable.
 */
export async function createCredentials(personId: string, actor: ActorContext, opciones: { username?: string | null } = {}) {
  /**
   * El hash se calcula ANTES de abrir la transacción, a propósito: cuesta
   * decenas de milisegundos (medidos: unos 50 en este equipo) y no depende de
   * nada que haya que leer dentro. Hacerlo dentro mantendría la transacción
   * serializable abierta todo ese tiempo, y con ella la ventana de conflicto
   * con cualquier otra escritura sobre la misma persona.
   *
   * Si la transacción se aborta por conflicto, esta contraseña se descarta
   * sin haber llegado a ninguna parte.
   */
  const tempPassword = generateOpaqueToken().token.slice(0, 12);
  const passwordHash = await hashPassword(tempPassword);

  return withTranslatedPrismaErrors(() =>
    conErroresDeIdentidad(() =>
      prisma.$transaction(
        async (tx) => crearCredencialesEnTransaccion(tx, personId, actor, tempPassword, passwordHash, opciones.username ?? null),
        { isolationLevel: "Serializable" }
      )
    )
  );
}

/**
 * El cuerpo de `createCredentials`, dentro de UNA transacción serializable.
 *
 * POR QUÉ TODO VA DENTRO, y en particular la lectura de `adminAccess`.
 *
 * La marca de la persona y el rol `admin` de su cuenta son dos filas en dos
 * tablas distintas que deben contar lo mismo. Leer la marca fuera y crear la
 * cuenta después abría una ventana con dos desenlaces, ninguno detectable a
 * simple vista:
 *
 *   - marcar + crear credenciales: la creación leía `adminAccess = false`,
 *     entremedio se concedía el permiso —sin cuenta todavía, así que no había
 *     ningún `UserRole` que ajustar— y la cuenta nacía SIN el rol. Quedaba una
 *     persona marcada como administradora que no podía administrar nada.
 *   - desmarcar + crear credenciales: el reverso, y el peor de los dos. La
 *     creación leía `adminAccess = true`, se retiraba el permiso, y la cuenta
 *     nacía CON el rol `admin`. Acceso administrativo real, sin marca que lo
 *     declarara y sin nadie que lo hubiera pedido.
 *
 * Con las dos operaciones en transacciones serializables que leen y escriben
 * la misma persona y la misma cuenta, PostgreSQL ya no puede intercalarlas:
 * el resultado equivale siempre a ejecutarlas una tras otra —en cualquiera de
 * los dos órdenes la marca y el rol terminan de acuerdo— y si no puede
 * garantizarlo, aborta una con 40001. Ese aborto llega al llamador traducido
 * como conflicto («Otra operación modificó estos datos al mismo tiempo. Vuelva
 * a intentarlo»), que es un fallo explícito y reintentable, no una cuenta a
 * medio hacer.
 *
 * El script de conciliación sigue existiendo para los datos anteriores a esto,
 * no como red de seguridad de este camino.
 */
async function crearCredencialesEnTransaccion(
  tx: Prisma.TransactionClient,
  personId: string,
  actor: ActorContext,
  tempPassword: string,
  passwordHash: string,
  usernameSolicitado: string | null
) {
  const person = await tx.person.findFirst({
    where: { id: personId, deletedAt: null },
    include: { roles: true, user: { select: { id: true } } },
  });
  if (!person) throw new NotFoundError("Persona");
  if (person.user) throw new ValidationError("La persona ya tiene credenciales de acceso");

  const username = usernameSolicitado ?? person.username;
  if (!username) throw new ValidationError(MENSAJE_FALTA_USERNAME, { field: "username" });

  // Solo puede tomar el nombre de usuario su propio dueño: la persona.
  await assertUsernameAvailable(username, { excludePersonId: person.id, tx });

  /**
   * El rol de ACCESO (login) se deriva de los roles funcionales activos.
   *
   * Los CUATRO cuentan. El representante legal faltaba en esta lista, y la
   * omisión dejaba un estado incoherente: RBAC le concede exactamente los
   * permisos de un delegado (`CLUB_STAFF_PERMISSIONS`), el propio mensaje de
   * error de abajo dice que nombrarla habilita el acceso, y sin embargo una
   * persona cuyo único rol fuera ese no podía obtener credenciales. Quedaba
   * nombrada, con permisos definidos, y sin forma de entrar.
   *
   * `swimmer` también accede, con permisos acotados a sus propias pruebas
   * individuales; esa restricción la aplica el alcance del actor, no esta
   * lista.
   */
  const ROLES_DE_ACCESO = ["delegate", "coach", "legal_representative", "swimmer"] as const;
  const activeRoleTypes = new Set(person.roles.filter((r) => r.active).map((r) => r.roleType));
  const loginRoleNames = ROLES_DE_ACCESO.filter((rol) => activeRoleTypes.has(rol)) as string[];

  /**
   * LA MARCA DE ADMINISTRADOR BASTA POR SÍ SOLA.
   *
   * Una persona a la que se le concedió el acceso administrativo antes de
   * tener cuenta no necesita además un rol funcional: administrar no es
   * nadar, ni entrenar, ni delegar. Exigírselo obligaría a inventarle un rol
   * que no ejerce solo para poder crearle la cuenta.
   *
   * El rol se añade aquí y no después porque la cuenta debe nacer ya
   * administrativa: crearla y concederle el rol en dos pasos deja una ventana
   * —breve, pero real— en la que existe una cuenta sin permisos, y si el
   * segundo paso fallara quedaría así para siempre.
   */
  if (person.adminAccess) loginRoleNames.push(ROL_ADMIN);

  if (loginRoleNames.length === 0) {
    /**
     * El mensaje dice CÓMO conseguir el rol, no «agréguelo»: los roles son
     * derivados y ya no se marcan a mano en la ficha de la persona. Decirle a
     * alguien que agregue un rol que no puede agregar es mandarlo a buscar un
     * botón que no existe.
     */
    throw new ValidationError(
      "Esta persona no tiene ningún rol que otorgue acceso al sistema (delegado, entrenador, representante legal o nadador). " +
        "El rol no se marca a mano: se obtiene incorporándola al plantel de un club (rol de nadador) o nombrándola " +
        "delegada, entrenadora o representante legal en la ficha del club. Hágalo primero y vuelva a crear las credenciales."
    );
  }

  const roles = await tx.role.findMany({ where: { name: { in: loginRoleNames } } });
  if (roles.length !== loginRoleNames.length) {
    throw new ValidationError("Uno o más roles de acceso no están configurados en el sistema (revise el seed)");
  }

  /**
   * El nombre se asigna a la persona JUSTO ANTES de crear la cuenta y en la
   * misma transacción: `users_username_igual_al_titular` exige que la cuenta
   * nazca con el nombre de su titular, y aquí ya lo tiene. Si algo de lo que
   * sigue falla, esta escritura se revierte con todo lo demás.
   */
  if (username !== person.username) {
    await tx.person.update({ where: { id: personId }, data: { username, updatedBy: actor.userId } });
  }

  const user = await withAudit(
    (tx) =>
      tx.user.create({
        data: {
          username,
          passwordHash,
          ownerType: "person",
          personId,
          mustChangePassword: true,
          status: "active",
          userRoles: { create: roles.map((r) => ({ roleId: r.id })) },
        },
      }),
    (user) => ({
      userId: actor.userId,
      action: "PERSON_CREDENTIALS_CREATED",
      entityType: "User",
      entityId: user.id,
      ipAddress: actor.ipAddress,
      // Que la cuenta nazca administrativa queda registrado: sin esto, la
      // concesión de admin de una persona sin cuenta no dejaría rastro del
      // momento en que se hizo efectiva.
      // Y con qué nombre, y si se asignó en este mismo paso.
      after: { roles: loginRoleNames, administrativa: person.adminAccess, username, usernameAnterior: person.username },
    }),
    // La auditoría va DENTRO de la misma transacción: si la creación se
    // aborta por conflicto, no queda registrada una cuenta que no existe.
    { tx }
  );

  return { userId: user.id, username: user.username, temporaryPassword: tempPassword };
}

export async function resetCredentials(personId: string, actor: ActorContext) {
  const person = await getPersonById(personId);
  if (!person.user) throw new ValidationError("La persona no tiene credenciales de acceso");

  const tempPassword = generateOpaqueToken().token.slice(0, 12);
  const passwordHash = await hashPassword(tempPassword);

  // `mustChangePassword: true` vuelve a activar la restricción de cambio
  // obligatorio (ahora aplicada en backend por `requireAuth`), y la
  // revocación de sesiones va en la misma transacción para que no pueda
  // quedar la contraseña nueva con las sesiones anteriores vivas.
  await withAudit(
    async (tx) => {
      const cuenta = await tx.user.update({
        where: { id: person.user!.id },
        data: { passwordHash, mustChangePassword: true, failedLoginAttempts: 0, status: "active", lockedUntil: null },
      });
      await terminarSesionesDelUsuario(tx, person.user!.id, "admin_revocation");
      // C-02: borra los contadores de la cuenta y de sus pares (no los de ningún origen) y
      // anula sus reservas en curso, en esta misma transacción y después de `users` y sesiones.
      await anularCuentaEnLimitador(tx, cuenta.username);
    },
    () => ({ userId: actor.userId, action: "PERSON_CREDENTIALS_RESET", entityType: "User", entityId: person.user!.id, ipAddress: actor.ipAddress })
  );

  return { temporaryPassword: tempPassword };
}
