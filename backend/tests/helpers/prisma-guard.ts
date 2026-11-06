/**
 * Protección de las pruebas UNITARIAS contra la construcción accidental del cliente real de Prisma.
 *
 * Es un `setupFiles` de `vitest.config.ts` (la configuración unitaria) y de ninguna otra: la
 * integración y la cobertura combinada necesitan el cliente real y conservan sus propias
 * configuraciones y protecciones de base de datos.
 *
 * POR QUÉ. `src/shared/prisma.client.ts` hace `globalThis.__prisma ?? new PrismaClient()` al
 * importarse. Basta que una prueba unitaria importe un servicio (`meet-import.service`,
 * `relay-registrations.service`…) para que se construya un cliente real, y con él se carga el
 * motor nativo de Prisma, aunque la prueba no consulte nada. Una ejecución de CI abortó con un
 * pánico de ese motor (código 134). El archivo causante y el mecanismo exacto no están
 * demostrados; esto cierra la vía de entrada, que es no construir un cliente real donde no
 * hace falta.
 *
 * QUÉ HACE. Antes de cada archivo de prueba pone en `globalThis.__prisma` —el punto que el
 * singleton ya consulta— un doble que NO es un cliente real. El singleton lo encuentra y no
 * llama al constructor.
 *
 * El doble FALLA CLARAMENTE ante cualquier uso: leer un modelo (`prisma.person`), llamar
 * `$transaction`, `$connect`, etc. No devuelve listas vacías, éxitos ni resultados que
 * pudieran esconder un fallo. Solo responde a las sondas que no son uso: `then` (para que un
 * `await` o una importación no lo traten como una promesa), los símbolos, `toJSON` y las
 * consultas internas de inspección.
 *
 * LO QUE NO TOCA. Las pruebas que ya simulan el singleton con `vi.mock(".../prisma.client")`
 * siguen usando SU doble: el módulo simulado reemplaza al singleton y este doble no llega a
 * consultarse (lo comprueban `prisma-guard-doble-explicito.test.ts` y `orden-determinista`).
 *
 * Este archivo no importa servicios, ni `@prisma/client`, ni construye nada real.
 */

/** Marca para que una prueba reconozca el doble sin usarlo. */
export const MARCA_DEL_DOBLE = Symbol.for("fchmn.prismaGuard");

export const MENSAJE_DEL_DOBLE = (uso: string) =>
  `Una prueba UNITARIA usó el cliente real de Prisma (${uso}). Las pruebas unitarias no acceden a la base de datos: ` +
  "simule el singleton con vi.mock('../src/shared/prisma.client', () => ({ prisma: ... })) y devuelva datos explícitos, " +
  "o muévala a una prueba de integración (*.integration.test.ts), que usa la base desechable.";

/** Claves que NO son uso del cliente: inspección, conversión y detección de promesas. */
const SONDAS = new Set<string | symbol>(["then", "toJSON", "asymmetricMatch", "nodeType", "$$typeof", "constructor"]);

function crearDoble(): object {
  return new Proxy(Object.create(null), {
    get(_destino, propiedad) {
      if (propiedad === MARCA_DEL_DOBLE) return true;
      if (typeof propiedad === "symbol" || SONDAS.has(propiedad)) return undefined;
      throw new Error(MENSAJE_DEL_DOBLE(`prisma.${propiedad}`));
    },
    set(_destino, propiedad) {
      throw new Error(MENSAJE_DEL_DOBLE(`asignar prisma.${String(propiedad)}`));
    },
    has() {
      return false;
    },
    ownKeys() {
      return [];
    },
    getOwnPropertyDescriptor() {
      return undefined;
    },
  });
}

/** Instala el doble. Es idempotente: no pisa uno ya instalado (ni uno explícito de una prueba). */
export function instalarDobleDePrisma(): void {
  const global = globalThis as { __prisma?: unknown };
  if (global.__prisma === undefined) global.__prisma = crearDoble();
}

instalarDobleDePrisma();
