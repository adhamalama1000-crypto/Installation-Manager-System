import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Interface text comes from the dictionaries (src/i18n/messages); text typed straight into JSX
    // would show the same words in Arabic and English. Symbols and punctuation are allowed; brand
    // or format names that stay the same in both languages are written as {"CSV"}.
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
