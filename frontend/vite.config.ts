import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    // Objetivo explícito de la compilación. Es el que Vite 5.4.21 aplicaba por omisión (`build.target: "modules"`,
    // la constante `ESBUILD_MODULES_TARGET` de su paquete). Vite 7 cambió el valor por omisión a
    // `baseline-widely-available` (Chrome/Edge 107, Firefox 104, Safari 16); se fija el anterior para que la
    // actualización de Vite no eleve en silencio los navegadores mínimos. No añade polyfills.
    target: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
  },
});
