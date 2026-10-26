import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // UI text comes from the dictionaries (src/i18n/messages); a literal in JSX would show the
    // same words in both languages. Symbols and punctuation are fine.
    files: ["src/app/**/*.tsx", "src/components/**/*.tsx"],
    rules: {
      "react/jsx-no-literals": [
        "error",
        {
          noStrings: false,
          ignoreProps: true,
          allowedStrings: ["·", "—", "–", "-", "→", "←", "*", "/", ":", "(", ")", "+", "%", "|", ",", "…", "×", "#", "@"],
        },
      ],
    },
  },
  globalIgnores([".next/**", "node_modules/**", "playwright-report/**", "test-results/**", "next-env.d.ts"]),
]);
