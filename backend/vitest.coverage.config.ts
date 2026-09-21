import { defineConfig } from "vitest/config";

/**
 * COBERTURA COMBINADA en UNA sola invocación: unitarias + integración.
 *
 * Por qué existe. Medir solo `vitest.config.ts` da la cobertura de las pruebas
 * unitarias, que en este proyecto es una fracción de lo que realmente se
 * ejercita: la suite de integración corre la aplicación entera contra la base
 * desechable y cubre el grueso de servicios y rutas. Publicar el número unitario
 * como «la cobertura del backend» lo subestima, y poner un umbral sobre él
 * premia escribir pruebas superficiales de código que la integración ya prueba a
 * fondo.
 *
 * Por qué NO se fusionan dos informes. Vitest 1.6 no tiene `--merge-reports`
 * —llegó en 2.1—, y fusionar informes de v8 a mano exigiría una herramienta
 * nueva. No hace falta ninguna de las dos cosas: basta con ejecutar TODO junto,
 * que es lo que hace este archivo, y dejar que el proveedor de cobertura sume
 * una sola vez.
 *
 * LAS PROTECCIONES DE LA BASE SE CONSERVAN ÍNTEGRAS. `globalSetup` y
 * `setupFiles` son exactamente los de `vitest.integration.config.ts`: se carga
 * `.env.test`, se valida el destino con `assertDisposableDatabase()` —host local,
 * puerto 55432, nombre terminado en `_test`, confirmación explícita y marcador
 * dentro de la propia base— y solo entonces se aplica el esquema. Una ejecución
 * de cobertura no puede tocar la base de trabajo, igual que no puede la de
 * integración.
 *
 * `fileParallelism: false` porque los archivos comparten la base y se truncan
 * entre sí.
 */
export default defineConfig({
  test: {
    // Sin `exclude` de `*.integration.test.ts`: el punto es incluirlas.
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["tests/helpers/integration.setup.ts"],
    setupFiles: ["tests/helpers/integration.env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      // Los cuatro indicadores, no solo líneas: un archivo puede tener el 90 %
      // de líneas y el 40 % de ramas, y es en las ramas donde vive la lógica
      // que decide cupos, permisos y elegibilidad.
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage-combinada",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/index.ts"],
      all: true,
    },
  },
});
