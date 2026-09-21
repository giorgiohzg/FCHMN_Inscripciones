import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Pruebas del frontend. Entorno jsdom para poder montar componentes con
 * @testing-library/react; los módulos puros (`src/shared/*`) se prueban
 * igual sin tocar el DOM.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    /**
     * UNIVERSO ESTABLE DE ARCHIVOS.
     *
     * Sin `all`, el proveedor v8 solo informa de los archivos que alguna prueba
     * llega a cargar: un archivo sin ninguna prueba **no aparece**, no suma al
     * denominador y por tanto no baja el porcentaje. Eso hacía que la cifra
     * subiera o bajara sola según qué módulos importara la suite, y una medición
     * así no sirve como suelo antirregresión: escribir la primera prueba de un
     * módulo grande podía **empeorar** el número.
     *
     * Con `all: true` el denominador es todo el código productivo, siempre el
     * mismo, y la cifra solo se mueve por lo que se prueba.
     */
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        // Las propias pruebas: medir cuánto de una prueba se ejecuta no dice
        // nada del producto.
        "src/**/*.test.{ts,tsx}",
        // Andamiaje de la suite (setup de jsdom, sesión de prueba): existe para
        // que las pruebas corran, no es código que se entregue.
        "src/test/**",
        // Declaraciones de tipos: no generan código ejecutable.
        "src/**/*.d.ts",
      ],
      reporter: ["text", "json-summary", "html"],
    },
  },
});
