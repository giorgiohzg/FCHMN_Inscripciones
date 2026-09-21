import { defineConfig } from "vitest/config";

/**
 * Configuración de las pruebas de integración (`npm run test:integration`).
 *
 * Solo corren contra la base DESECHABLE de `docker-compose.test.yml`
 * (puerto 55432, base `natacion_test`). El setup global valida el destino y
 * aborta si apunta a cualquier otra base — ver `tests/helpers/testDb.ts`.
 *
 * `fileParallelism: false` porque varios archivos comparten la misma base y
 * truncan tablas entre sí.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.integration.test.ts"],
    globalSetup: ["tests/helpers/integration.setup.ts"],
    setupFiles: ["tests/helpers/integration.env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
