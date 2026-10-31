/**
 * Siembra de RBAC y actores para las pruebas de integración.
 *
 * Usa la MISMA matriz de permisos que el seed de producción
 * (`src/modules/auth/rbac.definitions.ts`): si mañana se le agrega o quita un
 * permiso a un rol, estas pruebas lo reflejan sin tocarlas.
 */
import { prisma } from "../../src/shared/prisma.client";
import { PERMISSIONS, ROLES } from "../../src/modules/auth/rbac.definitions";
import { hashPassword } from "../../src/modules/auth/password.util";
import { fechaCalendarioAUtc, hoyEnZonaDelNegocio } from "../../src/shared/fecha.util";

export const TEST_PASSWORD = "ClaveValida123";

export async function seedRolesAndPermissions() {
  for (const code of PERMISSIONS) {
    await prisma.permission.upsert({ where: { code }, update: {}, create: { code } });
  }
  for (const [roleName, permCodes] of Object.entries(ROLES)) {
    const role = await prisma.role.upsert({ where: { name: roleName }, update: {}, create: { name: roleName } });
    for (const code of permCodes) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { code } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }
}

/**
 * `username` se puede fijar porque desde `phase4_identity_guards` la cuenta de
 * acceso de un club DEBE llamarse igual que el club. Los fixtures que crean
 * una cuenta con un nombre propio tienen que darle ese mismo nombre al club.
 */
export async function createClub(name: string, code: string, username?: string) {
  return prisma.club.create({
    data: {
      name,
      username: username ?? `club_${code.toLowerCase()}`,
      code,
      email: `${code.toLowerCase()}@test.local`,
      status: "active",
    },
  });
}

export async function createPerson(opts: { run: string; username: string; firstName: string; gender: "male" | "female"; birthYear?: number; roles?: ("swimmer" | "delegate" | "coach" | "legal_representative")[] }) {
  return prisma.person.create({
    data: {
      run: opts.run,
      username: opts.username,
      firstName: opts.firstName,
      paternalLastName: "Prueba",
      fullName: `${opts.firstName} Prueba`,
      birthDate: new Date(`${opts.birthYear ?? 1990}-05-05`),
      gender: opts.gender,
      status: "active",
      roles: { create: (opts.roles ?? ["swimmer"]).map((roleType) => ({ roleType, active: true })) },
    },
  });
}

/** Crea la cuenta de acceso y le asigna los roles indicados. */
export async function createUser(opts: {
  username: string;
  roleNames: string[];
  personId?: string;
  clubId?: string;
  mustChangePassword?: boolean;
  status?: "active" | "locked" | "disabled";
  lockedUntil?: Date | null;
}) {
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const user = await prisma.user.create({
    data: {
      username: opts.username,
      passwordHash,
      // Coherente con `users_owner_coherente`: sin persona ni club, la cuenta
      // es de tipo `system` (el caso del administrador).
      ownerType: opts.clubId ? "club" : opts.personId ? "person" : "system",
      personId: opts.personId ?? null,
      clubId: opts.clubId ?? null,
      mustChangePassword: opts.mustChangePassword ?? false,
      status: opts.status ?? "active",
      lockedUntil: opts.lockedUntil ?? null,
    },
  });

  for (const roleName of opts.roleNames) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  return user;
}

/** Vincula a una persona como personal (delegado/entrenador/rep. legal) de un club. */
export async function addClubStaff(clubId: string, personId: string, roleType: "delegate" | "coach" | "legal_representative") {
  return prisma.clubStaff.create({ data: { clubId, personId, roleType } });
}

/**
 * Membresía ACTIVA de un nadador en un club.
 *
 * `startDate` es una FECHA de calendario, no un instante: se construye igual que
 * en producción, para que los fixtures no guarden algo que el servicio nunca
 * guardaría. Con `new Date()` el día depende de la zona del proceso.
 */
export async function addActiveMembership(clubId: string, personId: string, requestedByUserId: string) {
  return prisma.clubSwimmer.create({
    data: { clubId, personId, status: "active", requestedByUserId, startDate: fechaCalendarioAUtc(hoyEnZonaDelNegocio()) },
  });
}
