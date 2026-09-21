import { PrismaClient } from "@prisma/client";
// La matriz de permisos por rol vive en `src/modules/auth/rbac.definitions.ts`
// para que el seed y las pruebas de autorización usen exactamente la misma.
import { PERMISSIONS, ROLES } from "../src/modules/auth/rbac.definitions";

/**
 * DATOS DE REFERENCIA: permisos, roles, parámetros del sistema y catálogos
 * base. Todo con `upsert`, así que ejecutarlo mil veces deja el mismo estado.
 *
 * La creación del ADMINISTRADOR INICIAL vive aparte, en `seed-admin.ts`, y no
 * se ejecuta desde aquí: una operación repetible (poblar catálogos) no debe ir
 * mezclada con una irrepetible y sensible (crear la cuenta más poderosa del
 * sistema), y menos aún ejecutarse en cada arranque del contenedor.
 */
const prisma = new PrismaClient();

async function main() {
  console.log("Seeding permissions...");
  for (const code of PERMISSIONS) {
    await prisma.permission.upsert({ where: { code }, update: {}, create: { code } });
  }

  console.log("Seeding roles...");
  for (const [roleName, permCodes] of Object.entries(ROLES)) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName },
    });

    for (const code of permCodes) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { code } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }

  /**
   * YA NO SE SIEMBRA NINGÚN PARÁMETRO. Los dos que había se retiraron porque
   * ninguno configuraba nada — el primero el 12 de septiembre de 2026 y el
   * segundo el 13:
   *
   * - `LOGIN_MAX_ATTEMPTS`: nadie la leía. El servicio de autenticación usa
   *   `env.LOGIN_MAX_ATTEMPTS`, y esa es la única fuente, junto con
   *   `LOGIN_LOCKOUT_MINUTES`.
   * - `SWIMMER_SINGLE_CLUB_ACTIVE`: ponerla en `false` no habilitaba nada. La
   *   migración crea un índice único parcial sobre
   *   `club_swimmers(person_id) WHERE status='active'` de forma incondicional,
   *   así que la base seguía rechazando la segunda membresía activa y el
   *   usuario veía un error de base de datos en lugar del mensaje de negocio.
   *   «Un solo club activo» pasó a ser una **invariante** (RB-06), comprobada
   *   siempre en el servicio y respaldada por el índice.
   *
   * La tabla `system_settings` ya NO existe: la retiró la migración
   * `20260913000000_drop_dead_schema` junto con `password_reset_tokens`. Si
   * algún día hace falta un parámetro que de verdad se configure en caliente,
   * se vuelve a crear con su propia migración. Mantener una tabla sin
   * consumidores no aportaba utilidad y sí invitaba a creer que existía
   * configuración dinámica.
   */

  console.log("Seeding catálogos base (Módulo 5)...");

  // Sección 6: tipos de prueba iniciales.
  await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
  await prisma.testType.upsert({ where: { name: "Relevo" }, update: {}, create: { name: "Relevo", swimmersCount: 4 } });

  // Sección 8: distancias iniciales (catálogo extensible).
  for (const meters of [50, 100, 200, 400, 800, 1500]) {
    await prisma.distance.upsert({ where: { meters }, update: {}, create: { meters } });
  }

  // Sección 8: estilos iniciales (catálogo extensible).
  for (const name of ["Mariposa", "Espalda", "Pecho", "Libre"]) {
    await prisma.stroke.upsert({ where: { name }, update: {}, create: { name } });
  }

  // Sección 11: tipos de jornada iniciales (catálogo extensible).
  for (const name of ["Mañana", "Tarde"]) {
    await prisma.sessionType.upsert({ where: { name }, update: {}, create: { name } });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
