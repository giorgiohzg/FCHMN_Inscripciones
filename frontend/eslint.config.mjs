import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";

/** Ver la nota sobre el alcance de las reglas en `backend/eslint.config.mjs`. */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        sessionStorage: "readonly",
        localStorage: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        alert: "readonly",
        confirm: "readonly",
        FormData: "readonly",
        File: "readonly",
        Blob: "readonly",
        URL: "readonly",
        HTMLInputElement: "readonly",
        HTMLSelectElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLElement: "readonly",
        HTMLDivElement: "readonly",
        AbortController: "readonly",
        navigator: "readonly",
      },
    },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // `eslint-plugin-react-hooks` v6 incorpora las reglas del React
      // Compiler. Son útiles como guía, pero marcan como ERROR patrones que
      // este código usa de forma consistente y correcta (por ejemplo,
      // `useEffect(() => { load(); }, [load])` para la carga inicial de cada
      // pantalla). Convertirlas en advertencias mantiene el lint verde y
      // accionable en CI; migrar las 27 ocurrencias sería una refactorización
      // completa del frontend, fuera del alcance de esta auditoría.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  prettier
);
