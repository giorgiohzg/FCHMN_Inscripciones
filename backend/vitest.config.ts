import { defineConfig } from "vitest/config";

/**
 * Configuración por defecto (`npm run test`): SOLO pruebas unitarias.
 *
 * Las pruebas de integración se excluyen aquí de forma explícita porque
 * escriben y borran en la base de datos real de `DATABASE_URL`. Antes esta
 * exclusión vivía en el script de npm como `--exclude '**\/*.integration.test.ts'`,
 * lo que no funciona en PowerShell (las comillas simples no se expanden y el
 * patrón llega literal), y en esa situación `npm test` terminaba corriendo las
 * pruebas de integración contra la base de datos de trabajo. Vive en un archivo
 * de configuración para que no dependa del shell.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
});
