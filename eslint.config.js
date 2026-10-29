import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "scripts/**", "live-smoke-results.txt"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    ignores: ["src/log.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/tools.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='registerTool']",
          message:
            "Register tools with registerConnectorTool so each tool has a Zod object schema and a non-empty description.",
        },
      ],
    },
  },
  prettier,
);
