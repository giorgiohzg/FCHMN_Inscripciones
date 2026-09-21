import type { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/modules/auth/password.util";
import { passwordField } from "../src/modules/auth/auth.schemas";
import { usernameField } from "../src/shared/username.schema";

/**
 * Creación del ADMINISTRADOR INICIAL. Operación deliberadamente separada y
 * manual (`npm run seed:admin`), no parte del arranque del contenedor.
 *
 * `SEED_ADMIN_USERNAME` y `SEED_ADMIN_PASSWORD` son OBLIGATORIAS en todos los
 * entornos, desarrollo incluido. No existen credenciales por omisión: una
 * cuenta de administrador con usuario y contraseña previsibles es explotable
 * apenas el puerto queda accesible, y `mustChangePassword` no lo impide, porque
 * quien conoce la credencial puede usarla antes que su dueño legítimo y
 * cambiarla él.
 *
 * Tener el mismo requisito en todos los entornos evita además que la instalación
 * local y la de producción sigan caminos distintos: lo que se prueba en una es
 * lo que ocurre en la otra.
 *
 * La contraseña se valida contra la MISMA política que se le exige a cualquier
 * usuario (`passwordField`). Nunca se imprime el usuario, la contraseña, su
 * hash ni fragmento alguno.
 *
 * NINGUNA parte de este módulo instancia un cliente de Prisma al importarse: el
 * cliente se crea solo en el punto de entrada de abajo, cuando el archivo se
 * ejecuta como comando. Así, importarlo para probar la decisión de credenciales
 * no abre ninguna conexión.
 */

/** Credenciales resueltas, o la lista de motivos por los que no se puede continuar. */
export function resolverCredencialesDeAdmin(
  vars: Record<string, string | undefined>
): { ok: true; username: string; password: string } | { ok: false; errores: string[] } {
  /**
   * Una variable DEFINIDA PERO VACÍA cuenta como ausente.
   *
   * `SEED_ADMIN_PASSWORD=` en un `.env` —o una variable declarada sin valor en
   * el panel del proveedor— llega como `""`, no como `undefined`. Sin esta
   * comprobación, una cadena vacía se tomaría como un valor legítimo y el
   * comando fallaría por "contraseña demasiado corta" en vez de por ausente,
   * que es el motivo real.
   */
  const estaVacia = (v: string | undefined): boolean => (v ?? "").trim().length === 0;

  /**
   * El USUARIO se normaliza recortando espacios exteriores: un `.env` con
   * `SEED_ADMIN_USERNAME= admin.fchmn ` describe el mismo nombre, y el formato
   * no admite espacios de todas formas.
   *
   * La CONTRASEÑA **no se recorta**. Los espacios exteriores son caracteres
   * legítimos y forman parte del secreto: recortarlos guardaría un hash de algo
   * distinto de lo que el operador escribió, y el primer ingreso fallaría sin
   * explicación. `trim()` se usa arriba solo para decidir si está vacía.
   */
  const usuario = estaVacia(vars.SEED_ADMIN_USERNAME) ? undefined : vars.SEED_ADMIN_USERNAME!.trim();
  const clave = estaVacia(vars.SEED_ADMIN_PASSWORD) ? undefined : vars.SEED_ADMIN_PASSWORD!;

  const errores: string[] = [];

  if (!usuario) errores.push("SEED_ADMIN_USERNAME es obligatoria: no hay usuario administrador por omisión.");
  if (!clave) errores.push("SEED_ADMIN_PASSWORD es obligatoria: no hay contraseña por omisión.");

  /**
   * El formato del nombre de usuario es el MISMO que el de personas y clubes
   * (`shared/username.ts`): los tres compiten por la misma reserva, así que el
   * administrador no puede tomar un nombre que ningún otro camino admitiría.
   */
  if (usuario !== undefined) {
    const r = usernameField.safeParse(usuario);
    if (!r.success) {
      errores.push(`SEED_ADMIN_USERNAME no cumple el formato de nombre de usuario: ${r.error.issues.map((i) => i.message).join("; ")}`);
    }
  }

  // La política se comprueba solo si hay algo que comprobar; si falta, el motivo
  // del rechazo debe ser la ausencia, no la debilidad.
  if (clave !== undefined) {
    const r = passwordField.safeParse(clave);
    if (!r.success) {
      errores.push(`SEED_ADMIN_PASSWORD no cumple la política de contraseñas: ${r.error.issues.map((i) => i.message).join("; ")}`);
    }
  }

  if (errores.length > 0) return { ok: false, errores };

  return { ok: true, username: usuario!, password: clave! };
}

/** Credenciales ya validadas que recibe el trabajo real. */
export interface CredencialesDeAdmin {
  username: string;
  password: string;
}

/** Lo mínimo que el ejecutor necesita del cliente: poder cerrarse. */
export interface ClienteDesconectable {
  $disconnect(): Promise<void>;
}

/**
 * EJECUTOR del comando, con sus dependencias inyectadas.
 *
 * Existe separado del trabajo real para poder comprobar su único contrato sin
 * una base de datos detrás: **pase lo que pase —éxito, credenciales inválidas o
 * excepción— el cliente se desconecta, y el código de salida es el correcto**.
 *
 * Antes esto no se podía observar. El comando usaba `process.exit(1)`, que
 * termina el proceso de inmediato y deja sin ejecutar el cierre de Prisma; y
 * desde fuera del proceso solo se puede ver el código de salida, que no
 * distingue "cerró y salió" de "salió sin cerrar".
 *
 * Devuelve el código de salida en lugar de asignarlo: quien lo invoca decide.
 */
export async function ejecutarSeedAdmin(deps: {
  cliente: ClienteDesconectable;
  vars: Record<string, string | undefined>;
  trabajo: (credenciales: CredencialesDeAdmin) => Promise<void>;
  registrarError?: (mensaje: string) => void;
}): Promise<number> {
  const registrar = deps.registrarError ?? ((m: string) => console.error(m));

  let codigo: number;
  try {
    const credenciales = resolverCredencialesDeAdmin(deps.vars);
    if (!credenciales.ok) {
      registrar("No se creó el administrador inicial:");
      for (const e of credenciales.errores) registrar(`  - ${e}`);
      codigo = 1;
    } else {
      await deps.trabajo({ username: credenciales.username, password: credenciales.password });
      codigo = 0;
    }
  } catch (e) {
    registrar(e instanceof Error ? e.message : String(e));
    codigo = 1;
  }

  /**
   * El cierre se intenta SIEMPRE, y su fallo se trata, no se ignora.
   *
   * Va fuera del `try` anterior para que un error al desconectar no se confunda
   * con un fallo del trabajo, y se captura para que no salga como rechazo sin
   * controlar. Si el cierre falla, el resultado pasa a 1 —el comando no puede
   * declararse correcto si dejó la conexión en un estado desconocido— pero el
   * motivo anterior ya quedó registrado antes: no se oculta.
   */
  try {
    await deps.cliente.$disconnect();
  } catch (e) {
    registrar(`No se pudo cerrar la conexión con la base de datos: ${e instanceof Error ? e.message : String(e)}`);
    codigo = 1;
  }

  return codigo;
}

export async function crearAdministrador(prisma: PrismaClient, credenciales: CredencialesDeAdmin): Promise<void> {
  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  if (!adminRole) {
    throw new Error("No existe el rol 'admin'. Ejecute primero el seed de datos de referencia: npm run prisma:seed");
  }

  /**
   * `findFirst`, no `findUnique`.
   *
   * `users.username` NO está declarado `@unique` en el esquema: su unicidad la
   * da un índice único PARCIAL (`WHERE deleted_at IS NULL`) creado por SQL
   * crudo, que Prisma no ve. El seed original hacía
   * `findUnique({ where: { username } })` y eso no compila contra el cliente
   * generado: Prisma responde "Argument `where` of type UserWhereUniqueInput
   * needs at least one of `id`, `personId` or `clubId`". Es decir, la creación
   * del administrador venía fallando en tiempo de ejecución.
   */
  const existente = await prisma.user.findFirst({
    where: { username: credenciales.username, deletedAt: null },
    include: { userRoles: { include: { role: true } } },
  });

  if (existente) {
    /**
     * "Ya existe" NO es lo mismo que "ya está bien".
     *
     * Antes se anunciaba éxito con solo encontrar el nombre de usuario. Pero un
     * despliegue puede terminar con esa cuenta en un estado que NO sirve para
     * entrar —bloqueada por intentos fallidos, deshabilitada, o creada sin el
     * rol `admin` por un seed anterior que falló a medias—, y el operador se
     * quedaba creyendo que el administrador estaba listo hasta que intentaba
     * usarlo. Se comprueba lo que hace falta para poder iniciar sesión como
     * administrador, y si algo no cuadra el comando FALLA diciendo qué.
     */
    const problemas: string[] = [];
    if (existente.status !== "active") problemas.push(`su estado es "${existente.status}" y no "active"`);
    if (!existente.userRoles.some((ur) => ur.role.name === "admin")) problemas.push("no tiene el rol 'admin'");
    if (existente.ownerType !== "system") problemas.push(`su ownerType es "${existente.ownerType}" y no "system"`);
    if (existente.lockedUntil && existente.lockedUntil > new Date()) {
      problemas.push("está bloqueada temporalmente por intentos fallidos de ingreso");
    }

    if (problemas.length > 0) {
      // El nombre de usuario NO se incluye: la salida de un despliegue suele
      // quedar registrada, y quien ejecuta el comando ya sabe qué definió.
      throw new Error(
        `El usuario indicado en SEED_ADMIN_USERNAME ya existe pero NO sirve como administrador: ${problemas.join("; ")}. ` +
          "Corrija esa cuenta o use otro SEED_ADMIN_USERNAME. No se modifica una cuenta existente desde este comando."
      );
    }

    // Idempotente: la cuenta está correcta y no se toca su contraseña.
    console.log("El usuario indicado en SEED_ADMIN_USERNAME ya existe y es un administrador válido: no se modifica.");
    return;
  }

  const passwordHash = await hashPassword(credenciales.password);

  /**
   * Usuario y rol en UNA transacción.
   *
   * Estaban en dos escrituras sueltas: si la segunda fallaba —la base se cae,
   * el contenedor se reinicia a mitad— quedaba un usuario administrador SIN el
   * rol `admin`. Esa cuenta no puede hacer nada, pero ocupa el nombre de
   * usuario, así que reintentar el comando encontraba "el usuario ya existe" y
   * anunciaba éxito sobre una cuenta inservible. O las dos filas, o ninguna.
   */
  await prisma.$transaction(async (tx) => {
    const admin = await tx.user.create({
      data: {
        username: credenciales.username,
        passwordHash,
        // El administrador no pertenece a ninguna persona ni club: antes se
        // guardaba como `person` con `person_id` nulo (hallazgo 20).
        ownerType: "system",
        mustChangePassword: true,
        status: "active",
      },
    });
    await tx.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
  });

  // Ni la contraseña ni el nombre de usuario se imprimen: quien ejecuta esto ya
  // los conoce, y la salida de un despliegue suele quedar guardada en los
  // registros del orquestador.
  console.log("Administrador inicial creado. Debe cambiar la contraseña en el primer ingreso.");
}

if (require.main === module) {
  /**
   * ÚNICO lugar donde se carga e instancia un cliente real. La importación es
   * DINÁMICA a propósito: importar este módulo para probar la decisión de
   * credenciales no debe traer `@prisma/client` ni abrir ninguna conexión.
   *
   * `process.exitCode`, nunca `process.exit`: este último corta el proceso de
   * inmediato y dejaría sin ejecutar el cierre de la conexión.
   */
  void (async () => {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();

    process.exitCode = await ejecutarSeedAdmin({
      cliente: prisma,
      vars: process.env,
      trabajo: (credenciales) => crearAdministrador(prisma, credenciales),
    });
  })();
}
