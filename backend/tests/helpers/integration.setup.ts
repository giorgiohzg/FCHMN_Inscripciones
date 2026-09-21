/**
 * Setup global de la suite de integración (`vitest.integration.config.ts`).
 *
 * Orden importante: primero se cargan las variables de `.env.test`, y recién
 * después se valida el destino. Cualquier import de `src/**` que lea
 * `process.env` (por ejemplo `shared/env.ts`) debe ocurrir DESPUÉS de esto,
 * por eso este archivo no importa nada del código de la aplicación.
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { assertDisposableDatabase } from "./testDb";

export async function setup() {
  loadEnv({ path: resolve(__dirname, "../../.env.test"), override: true });

  const target = assertDisposableDatabase();

  // El esquema se aplica con las migraciones reales (no `db push`): así las
  // pruebas de integración validan también que las migraciones versionadas
  // producen un esquema utilizable.
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: resolve(__dirname, "../.."),
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  // El marcador se escribe DESPUÉS de validar el destino y aplicar las
  // migraciones: `truncateAllTables` se niega a borrar cualquier base que no
  // lo tenga, de modo que una base ajena —aunque alguien la pusiera en el
  // puerto y con el nombre correctos— nunca puede vaciarse.
  const { prisma } = await import("../../src/shared/prisma.client");
  const { createDisposableMarker } = await import("./testDb");
  await createDisposableMarker(prisma);
  await prisma.$disconnect();

  console.log(`[integración] base desechable lista: ${target.database} en ${target.host}:${target.port}`);
}
