/**
 * Permisos de administrador por persona: quién los tiene de verdad y cómo
 * evitar quedarse sin ninguno.
 *
 * LA FUENTE DE VERDAD DEL ACCESO ES `user_roles`.
 *
 * `persons.admin_access` guarda la INTENCIÓN —se puede marcar antes de que la
 * persona tenga cuenta— pero ninguna consulta de autorización la lee. Quien
 * concede acceso es la fila que une la cuenta con el rol `admin`, y es lo
 * único que `loadAuthorizationState` consulta en cada solicitud. Este módulo
 * existe para que las dos no se separen: es el único lugar del sistema que
 * crea o borra esa fila para una cuenta de persona.
 *
 * QUÉ CUENTA COMO ADMINISTRADOR UTILIZABLE. Las tres condiciones a la vez:
 *   - la cuenta tiene el rol `admin`;
 *   - la cuenta está activa y no eliminada;
 *   - si la cuenta pertenece a una persona, esa persona está activa y no
 *     eliminada.
 *
 * La cuenta `system` CUENTA. No tiene persona detrás, así que la tercera
 * condición no le aplica, y es la que en la práctica garantiza que el sistema
 * nunca se quede sin administración. Una cuenta bloqueada NO cuenta: su dueño
 * no puede entrar, y un administrador que no puede entrar no administra.
 *
 * Una cuenta con la contraseña pendiente de cambio SÍ cuenta: puede entrar y
 * cambiarla, que es exactamente el camino previsto para un administrador
 * recién creado.
 */
import type { Prisma } from "@prisma/client";
import { ValidationError } from "../../shared/errors";

type Db = Prisma.TransactionClient;

/** Nombre del rol de acceso administrativo, en un solo sitio. */
export const ROL_ADMIN = "admin";

/**
 * Condición de «administrador utilizable», escrita una sola vez.
 *
 * Se usa tanto para contar como para comprobar, y tenerla duplicada sería el
 * tipo de divergencia que deja pasar justo el caso que se quería frenar.
 */
function dondeAdministradorUtilizable(excluirUserIds: readonly string[] = []): Prisma.UserWhereInput {
  return {
    ...(excluirUserIds.length > 0 ? { id: { notIn: [...excluirUserIds] } } : {}),
    status: "active",
    deletedAt: null,
    userRoles: { some: { role: { name: ROL_ADMIN } } },
    // `is: null` cubre las cuentas `system` y `club`, que no tienen persona:
    // sin esta rama quedarían fuera del conteo y la cuenta `system` —la que
    // de verdad sostiene el sistema— no contaría como administrador.
    OR: [{ person: { is: null } }, { person: { is: { status: "active", deletedAt: null } } }],
  };
}

/**
 * Cuántos administradores utilizables quedarían si las cuentas indicadas
 * dejaran de serlo.
 *
 * La lectura ocurre DENTRO de la transacción que hará el cambio, y eso es lo
 * que cierra la carrera: dos revocaciones simultáneas de los dos últimos
 * administradores leerían ambas «quedan 2» y ambas seguirían adelante. Con
 * `Serializable`, las dos leen el mismo conjunto que la otra escribe, se forma
 * el ciclo y PostgreSQL aborta una.
 */
export async function contarAdministradoresUtilizables(db: Db, excluirUserIds: readonly string[] = []): Promise<number> {
  return db.user.count({ where: dondeAdministradorUtilizable(excluirUserIds) });
}

/**
 * Impide dejar el sistema sin ningún administrador utilizable.
 *
 * `motivo` se incrusta en el mensaje porque el mismo bloqueo llega desde
 * cuatro acciones distintas —quitar el rol, bloquear, inhabilitar y eliminar—
 * y un texto genérico obligaría a adivinar cuál se intentó.
 */
export async function exigirQueQuedeAlgunAdministrador(
  db: Db,
  excluirUserIds: readonly string[],
  motivo: string
): Promise<void> {
  const quedan = await contarAdministradoresUtilizables(db, excluirUserIds);
  if (quedan === 0) {
    throw new ValidationError(
      `${motivo} dejaría al sistema sin ningún administrador que pueda entrar. ` +
        "Conceda permisos de administrador a otra persona con cuenta activa —o reactive una existente— antes de continuar."
    );
  }
}

/**
 * Cuentas de persona que perderían el acceso administrativo al aplicar una
 * acción sobre esa persona.
 *
 * Devuelve un arreglo y no un identificador suelto porque quien llama necesita
 * pasárselo tal cual a las funciones de arriba, y porque una persona sin
 * cuenta —caso corriente— no excluye a nadie.
 */
export async function cuentasAfectadasPorPersona(db: Db, personId: string): Promise<string[]> {
  const cuenta = await db.user.findFirst({ where: { personId }, select: { id: true } });
  return cuenta ? [cuenta.id] : [];
}

/**
 * Pone o quita la fila `user_roles` del rol `admin` para una cuenta.
 *
 * Es idempotente a propósito: marcar dos veces no duplica —la clave primaria
 * compuesta lo impediría igual, pero fallando— y desmarcar algo que no estaba
 * no es un error. Quien llama expresa el estado deseado, no la operación.
 *
 * Devuelve si hubo cambio real, que es lo que decide si se audita y si se
 * revocan sesiones: registrar una concesión que no concedió nada ensucia la
 * auditoría, y revocar sesiones sin motivo expulsa a alguien por nada.
 */
export async function aplicarRolAdmin(db: Db, userId: string, conceder: boolean): Promise<boolean> {
  const rol = await db.role.findUnique({ where: { name: ROL_ADMIN }, select: { id: true } });
  if (!rol) {
    throw new ValidationError(`El rol '${ROL_ADMIN}' no está configurado en el sistema (revise el seed inicial).`);
  }

  const yaLoTiene = await db.userRole.findUnique({
    where: { userId_roleId: { userId, roleId: rol.id } },
    select: { userId: true },
  });

  if (conceder && !yaLoTiene) {
    await db.userRole.create({ data: { userId, roleId: rol.id } });
    return true;
  }
  if (!conceder && yaLoTiene) {
    await db.userRole.delete({ where: { userId_roleId: { userId, roleId: rol.id } } });
    return true;
  }
  return false;
}

/**
 * Revoca los refresh tokens vigentes de una cuenta.
 *
 * QUÉ HACE Y QUÉ NO, con precisión, porque es fácil creer de más: impide
 * obtener un access token NUEVO. **No invalida el access token ya emitido**,
 * que sigue siendo criptográficamente válido hasta que caduque.
 *
 * Lo que sí retira los permisos de inmediato es otra cosa: `authenticate`
 * recarga roles y permisos de la base en CADA solicitud, así que la siguiente
 * petición de esa persona ya no será administrativa aunque presente el token
 * viejo. La revocación del refresh añade que, cuando ese token caduque, la
 * sesión no se pueda renovar y haya que entrar de nuevo.
 */
export async function revocarSesiones(db: Db, userId: string): Promise<number> {
  const { count } = await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}
