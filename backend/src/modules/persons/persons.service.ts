import { prisma } from "../../shared/prisma.client";
import { audit, withAudit } from "../audit/audit.service";
import { assertUsernameAvailable } from "../../shared/username";
import { hashPassword, generateOpaqueToken } from "../auth/password.util";
import { normalizeRun } from "../../shared/run.util";
import { ValidationError, NotFoundError } from "../../shared/errors";
import { formatPersonFullName } from "../../shared/personName.util";
import type { PersonCreateInput, PersonUpdateInput, PersonListQuery } from "./persons.schemas";

interface ActorContext {
  userId: string;
  ipAddress?: string;
}

async function assertRunNotDuplicated(run: string, excludePersonId?: string) {
  const normalized = normalizeRun(run);
  const existing = await prisma.person.findFirst({
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

export async function createPerson(input: PersonCreateInput, actor: ActorContext) {
  const normalizedRun = normalizeRun(input.run);
  await assertRunNotDuplicated(normalizedRun);
  await assertUsernameAvailable(input.username);

  const person = await withAudit(
    (tx) =>
      tx.person.create({
    data: {
      run: normalizedRun,
      username: input.username,
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
    })
  );

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

  const person = await prisma.$transaction(async (tx) => {
    await tx.person.update({
      where: { id },
      data: {
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
  });

  return person;
}

async function setStatus(id: string, status: "active" | "locked" | "disabled", action: string, actor: ActorContext) {
  const before = await getPersonById(id);

  // Los tres pasos van en UNA transacción: cambiar el estado de la persona,
  // propagarlo a su cuenta y cortar sus sesiones. Antes eran dos escrituras
  // sueltas y las sesiones NO se cortaban: la persona bloqueada seguía
  // operando con su access token vigente y renovándolo con su refresh token.
  const person = await prisma.$transaction(async (tx) => {
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

    if (status !== "active") {
      await tx.refreshToken.updateMany({ where: { user: { personId: id }, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await audit({ userId: actor.userId, action, entityType: "Person", entityId: id, ipAddress: actor.ipAddress, before, after: updated }, { tx });
    return updated;
  });
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
    const updated = await tx.person.update({
      where: { id },
      data: { deletedAt: new Date(), status: "disabled", updatedBy: actor.userId },
    });
    await tx.user.updateMany({ where: { personId: id }, data: { status: "disabled", deletedAt: new Date(), lockedUntil: null } });
    await tx.refreshToken.updateMany({ where: { user: { personId: id }, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(
      { userId: actor.userId, action: "PERSON_DELETED", entityType: "Person", entityId: id, ipAddress: actor.ipAddress, before, after: updated },
      { tx }
    );
    return updated;
  });
  return person;
}

// --------------------------------------------------------------------------
// Credenciales de acceso (RB-01: un user = una persona XOR un club)
// --------------------------------------------------------------------------

/**
 * Crea una cuenta de acceso para la persona, usando su `username` ya
 * definido (RUN/creación de la persona) — con contraseña temporal que
 * debe cambiarse en el primer ingreso. Retorna la contraseña en claro UNA
 * SOLA VEZ (para comunicarla fuera de banda); nunca se persiste ni se
 * vuelve a exponer.
 */
export async function createCredentials(personId: string, actor: ActorContext) {
  const person = await getPersonById(personId);
  if (person.user) throw new ValidationError("La persona ya tiene credenciales de acceso");

  // Solo puede tomar el nombre de usuario su propio dueño: la persona.
  await assertUsernameAvailable(person.username, { excludePersonId: person.id });

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

  const roles = await prisma.role.findMany({ where: { name: { in: loginRoleNames } } });
  if (roles.length !== loginRoleNames.length) {
    throw new ValidationError("Uno o más roles de acceso no están configurados en el sistema (revise el seed)");
  }

  const tempPassword = generateOpaqueToken().token.slice(0, 12);
  const passwordHash = await hashPassword(tempPassword);

  const user = await withAudit(
    (tx) =>
      tx.user.create({
        data: {
          username: person.username,
          passwordHash,
          ownerType: "person",
          personId,
          mustChangePassword: true,
          status: "active",
          userRoles: { create: roles.map((r) => ({ roleId: r.id })) },
        },
      }),
    (user) => ({ userId: actor.userId, action: "PERSON_CREDENTIALS_CREATED", entityType: "User", entityId: user.id, ipAddress: actor.ipAddress })
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
      await tx.user.update({
        where: { id: person.user!.id },
        data: { passwordHash, mustChangePassword: true, failedLoginAttempts: 0, status: "active", lockedUntil: null },
      });
      await tx.refreshToken.updateMany({ where: { userId: person.user!.id, revokedAt: null }, data: { revokedAt: new Date() } });
    },
    () => ({ userId: actor.userId, action: "PERSON_CREDENTIALS_RESET", entityType: "User", entityId: person.user!.id, ipAddress: actor.ipAddress })
  );

  return { temporaryPassword: tempPassword };
}
