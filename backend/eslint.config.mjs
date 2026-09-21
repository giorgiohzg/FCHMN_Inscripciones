import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Configuración plana de ESLint para el backend.
 *
 * Se parte del conjunto `recommended` (sin type-checking) a propósito: el
 * objetivo de esta primera versión es que `npm run lint` quede en verde y
 * sirva como red de seguridad en CI. Las reglas que exigen información de
 * tipos (`no-floating-promises`, etc.) son valiosas en un código con tantas
 * promesas como este, pero hoy producirían cientos de hallazgos que exceden
 * el alcance de la auditoría; queda anotado como mejora posterior.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "prisma/migrations/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { process: "readonly", console: "readonly", __dirname: "readonly", module: "readonly", require: "readonly", globalThis: "readonly" },
    },
    rules: {
      // Código muerto: es uno de los hallazgos de la auditoría (imports y
      // variables sin usar). Los argumentos con prefijo `_` son la convención
      // ya usada en el código para parámetros deliberadamente ignorados.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  prettier
);
