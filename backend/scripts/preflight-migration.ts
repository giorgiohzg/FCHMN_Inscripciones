/**
 * Preflight de migración — se ejecuta ANTES de aplicar
 * `20260905000000_phase2_integrity` sobre una base con datos.
 *
 *   npm run preflight:migration
 *
 * Esa migración crea índices únicos PARCIALES y una clave foránea compuesta.
 * Si la base ya contiene filas que los violan, `prisma migrate deploy` falla
 * a mitad de camino con un error de PostgreSQL que no dice qué fila sobra ni
 * cómo arreglarlo, y la migración queda marcada como fallida (bloqueando el
 * despliegue hasta resolverlo a mano).
 *
 * Este script detecta esos casos ANTES, los lista con nombre y apellido, y
 * propone la corrección concreta para cada uno. No modifica nada.
 *
 * Salida: código 0 si la base puede migrarse; 1 si hay bloqueos.
 */
import { PrismaClient } from "@prisma/client";
import { CHECKS, type Check } from "./migrationChecks";

const prisma = new PrismaClient();

/** Existe la tabla en el esquema public de esta base? */
async function tablaExiste(nombre: string): Promise<boolean> {
  const filas = (await prisma.$queryRawUnsafe(`SELECT to_regclass('public.' || $1) IS NOT NULL AS existe`, nombre)) as {
    existe: boolean;
  }[];
  return filas[0]?.existe === true;
}

/**
 * Estado de una migración en el historial de Prisma.
 *
 * Un booleano "aplicada / no aplicada" mezclaba tres situaciones muy
 * distintas, y la peor —una ejecución FALLIDA, que Prisma deja como fila con
 * `finished_at` y `rolled_back_at` nulos— caía del lado de "no aplicada", es
 * decir, del lado que NO bloquea. Justamente al revés de lo que corresponde:
 * una migración a medio aplicar es el estado más peligroso para seguir
 * migrando encima.
 */
type EstadoMigracion = "aplicada" | "fallida" | "revertida" | "ausente";

/**
 * Prisma inserta una fila por INTENTO, así que puede haber varias con el mismo
 * nombre. Se resuelven por prioridad:
 *
 *   fallida   — hay un intento SIN RESOLVER (`finished_at` y `rolled_back_at`
 *               nulos), aunque exista otro aplicado del mismo nombre.
 *   aplicada  — hay al menos un intento terminado y no revertido, y ningún
 *               fallo sin resolver.
 *   revertida — todos los intentos figuran revertidos.
 *   ausente   — no hay ninguna fila, o la base nunca pasó por Prisma.
 *
 * POR QUÉ "fallida" MANDA SOBRE "aplicada". Una fila sin terminar y sin
 * revertir es exactamente el estado que hace que Prisma se niegue a seguir con
 * P3009. Dar por buena la migración porque existe otra fila correcta
 * describiría una base sobre la que `migrate deploy` no va a poder avanzar: el
 * preflight aprobaría un despliegue que se va a frenar igual.
 *
 * CÓMO SE RESUELVE. Un fallo deja de contar cuando alguien le declara un
 * desenlace con `prisma migrate resolve`, no cuando se aplica otro intento
 * encima. Hay dos desenlaces, y no son intercambiables:
 *
 *   --rolled-back  la migración se deshizo, o se va a volver a ejecutar. Deja
 *                  la fila como revertida y el siguiente `deploy` la reintenta.
 *   --applied      los pasos que faltaban se completaron A MANO y el resultado
 *                  se verificó. Deja la fila como aplicada y el siguiente
 *                  `deploy` la omite. Usarlo sin haber completado y comprobado
 *                  esos pasos deja la base a medias con el historial diciendo
 *                  lo contrario.
 *
 * Cuál corresponde lo decide quien opera, mirando qué alcanzó a hacer la
 * migración. Mientras no se decida, el preflight bloquea.
 */
async function estadoDeMigracion(nombre: string): Promise<EstadoMigracion> {
  if (!(await tablaExiste("_prisma_migrations"))) return "ausente";

  const filas = (await prisma.$queryRawUnsafe(
    `SELECT
        count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS aplicadas,
        count(*) FILTER (WHERE finished_at IS NULL     AND rolled_back_at IS NULL)::int AS fallidas,
        count(*) FILTER (WHERE rolled_back_at IS NOT NULL)::int                        AS revertidas
       FROM _prisma_migrations WHERE migration_name = $1`,
    nombre
  )) as { aplicadas: number; fallidas: number; revertidas: number }[];

  const conteo = filas[0] ?? { aplicadas: 0, fallidas: 0, revertidas: 0 };
  // El orden importa: un fallo sin resolver gana sobre un intento aplicado.
  if (conteo.fallidas > 0) return "fallida";
  if (conteo.aplicadas > 0) return "aplicada";
  if (conteo.revertidas > 0) return "revertida";
  return "ausente";
}

type Aplicabilidad = { estado: "ejecutar" } | { estado: "no-aplica"; motivo: string } | { estado: "sin-verificar"; motivo: string };

/**
 * Cruza las DOS señales —historial y catálogo— en vez de mirar solo si la
 * tabla existe. Que exista no basta: una tabla presente sin migración que la
 * respalde significa que el historial y la base no describen lo mismo, y eso
 * hay que aclararlo antes de migrar encima.
 *
 *   aplicada  + presente -> ejecutar
 *   aplicada  + ausente  -> SIN VERIFICAR (falta algo que debería estar)
 *   ausente   + ausente  -> NO APLICA (base anterior; normal y esperado)
 *   revertida + ausente  -> NO APLICA (se revirtió a conciencia)
 *   ausente   + presente -> SIN VERIFICAR (tabla sin respaldo en el historial)
 *   revertida + presente -> SIN VERIFICAR (se revirtió y la tabla sigue ahí)
 *   fallida   + lo que sea -> SIN VERIFICAR (quedó a medias), incluso si
 *                             además hay un intento aplicado del mismo nombre
 */
async function evaluarAplicabilidad(check: Check): Promise<Aplicabilidad> {
  if (!check.requires) return { estado: "ejecutar" };

  const { table, migration } = check.requires;
  const [estado, presente] = await Promise.all([estadoDeMigracion(migration), tablaExiste(table)]);

  if (estado === "fallida") {
    return {
      estado: "sin-verificar",
      motivo:
        `la migración "${migration}" tiene una EJECUCIÓN FALLIDA en el historial (sin terminar y sin revertir), ` +
        `así que la tabla "${table}" ${presente ? "existe pero puede estar incompleta" : "no existe"}`,
    };
  }

  if (estado === "aplicada") {
    if (presente) return { estado: "ejecutar" };
    return {
      estado: "sin-verificar",
      motivo: `la migración "${migration}" figura aplicada, pero la tabla "${table}" que crea NO existe`,
    };
  }

  // ausente o revertida
  const comoFigura = estado === "revertida" ? "figura REVERTIDA" : "no figura en el historial";
  if (presente) {
    return {
      estado: "sin-verificar",
      motivo: `la tabla "${table}" existe pero su migración ("${migration}") ${comoFigura}: el historial no respalda lo que hay en la base`,
    };
  }
  return { estado: "no-aplica", motivo: `la tabla "${table}" no existe y su migración ("${migration}") ${comoFigura}` };
}

async function main() {
  const url = process.env.DATABASE_URL ?? "(no definida)";
  const target = url.replace(/\/\/[^@]*@/, "//***@");
  console.log(`\nPreflight de migración — base: ${target}\n`);

  let blocking = 0;
  let unverified = 0;
  let noAplican = 0;

  for (const check of CHECKS) {
    /**
     * "No aplica" no es lo mismo que "no se pudo verificar".
     *
     * Algunas comprobaciones miran objetos que crea una migración anterior de
     * la misma tanda; en el baseline no existen y la consulta ni siquiera
     * parsea. Sin esta distinción caían en SIN VERIFICAR —que bloquea, y con
     * razón— y el preflight quedaba imposible de aprobar antes de migrar.
     */
    const aplicabilidad = await evaluarAplicabilidad(check);
    if (aplicabilidad.estado === "no-aplica") {
      noAplican += 1;
      console.log(`  NO APLICA ${check.title}`);
      console.log(`     (${aplicabilidad.motivo})`);
      continue;
    }
    if (aplicabilidad.estado === "sin-verificar") {
      unverified += 1;
      console.log(`
  SIN VERIFICAR ${check.title}`);
      console.log(`     Restricción asociada: ${check.constraint}`);
      console.log(`     Motivo: ${aplicabilidad.motivo}`);
      console.log(
        `     Qué hacer: el historial de migraciones y el contenido de la base no coinciden. Averigüe qué pasó ` +
          `—una ejecución que quedó a medias, un objeto eliminado a mano, una restauración parcial— ANTES de seguir ` +
          `migrando encima. Una migración fallida además hay que resolverla con "prisma migrate resolve".
`
      );
      continue;
    }

    let rows: Record<string, unknown>[];
    try {
      rows = (await prisma.$queryRawUnsafe(check.query)) as Record<string, unknown>[];
    } catch (err) {
      /**
       * Una comprobación que no se puede ejecutar NO es un aprobado.
       *
       * Antes esto solo imprimía un aviso y seguía, de modo que el script
       * podía terminar diciendo "la base puede migrarse" habiendo dejado
       * conflictos sin mirar — exactamente el escenario en que el preflight
       * es más peligroso que no tenerlo, porque da una falsa garantía antes
       * de un despliegue.
       *
       * Causas típicas: falta una tabla o columna (la base es anterior a lo
       * que asume esta comprobación), o el usuario no tiene permisos de
       * lectura sobre ella. Ambas exigen intervención humana antes de migrar.
       */
      unverified += 1;
      console.log(`\n  SIN VERIFICAR ${check.title}`);
      console.log(`     Restricción asociada: ${check.constraint}`);
      console.log(`     Motivo: ${(err as Error).message.split("\n")[0]}`);
      console.log(
        `     Qué hacer: confirme que la base corresponde a la versión anterior esperada y que el usuario de conexión ` +
          `puede leer esa tabla. Mientras esta comprobación no se ejecute, no se puede afirmar que la migración sea segura.\n`
      );
      continue;
    }

    if (rows.length === 0) {
      console.log(`  OK ${check.title}`);
      continue;
    }

    blocking += rows.length;
    console.log(`\n  BLOQUEA ${check.title}`);
    console.log(`     Restricción que fallaría: ${check.constraint}`);
    console.log(`     Filas conflictivas: ${rows.length}`);
    for (const row of rows.slice(0, 10)) {
      console.log(`       - ${JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? Number(v) : v))}`);
    }
    if (rows.length > 10) console.log(`       ... y ${rows.length - 10} más`);
    console.log(`     Cómo resolverlo: ${check.remediation}`);

    // Si la comprobación produce SQL de remediación fila por fila, se imprime
    // listo para copiar y pegar.
    const sentencias = rows.map((r) => r["sql_de_remediacion"]).filter((s): s is string => typeof s === "string");
    if (sentencias.length > 0) {
      console.log(`     SQL a ejecutar:`);
      for (const sentencia of sentencias) console.log(`       ${sentencia}`);
    }
    console.log("");
  }

  console.log("");
  if (blocking > 0 || unverified > 0) {
    if (blocking > 0) {
      console.log(`RESULTADO: ${blocking} conjunto(s) de filas impiden la migración. Corríjalos y vuelva a ejecutar este preflight.`);
    }
    if (unverified > 0) {
      console.log(
        `RESULTADO: ${unverified} comprobación(es) no se pudieron ejecutar. NO se puede afirmar que la base sea migrable ` +
          `mientras queden comprobaciones sin verificar.`
      );
    }
    console.log("No aplique la migración hasta que este script termine sin bloqueos ni comprobaciones pendientes, y haga un respaldo antes de hacerlo.\n");
    process.exitCode = 1;
    return;
  }

  const ejecutadas = CHECKS.length - noAplican;
  const detalleNoAplican = noAplican > 0 ? ` (${noAplican} no aplican a esta versión de la base)` : "";
  console.log(
    `RESULTADO: ${ejecutadas} de ${CHECKS.length} comprobaciones se ejecutaron y ninguna bloquea${detalleNoAplican}. ` +
      `Haga un respaldo igualmente antes de aplicar la migración.\n`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
