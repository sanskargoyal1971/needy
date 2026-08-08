import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/** ── Lint policy ───────────────────────────────────────────────────────────
 *  Flat config, one file for the whole workspace. The rule set is deliberately small: the
 *  point is to catch the classes of bug this audit actually found, not to enforce style
 *  (Prettier owns formatting, and a lint rule that argues with the formatter is noise).
 *
 *  Rules that exist because of a real defect in this codebase:
 *   - `no-floating-promises` — a dropped `await` on a repo write is how a task silently fails
 *     to persist while the socket acks success.
 *   - `require-await` / `no-misused-promises` — passing an async function where a void callback
 *     is expected is exactly how an unhandled rejection escapes a socket handler.
 *   - `no-restricted-syntax` on `Date.now()` inside src — handlers must use the injected
 *     `deps.now()` clock; a direct `Date.now()` makes time-dependent behaviour untestable and
 *     was the reason several expiry paths had no coverage.
 */
export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/*.tsbuildinfo"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── Backend: type-aware, because the promise rules need types to work at all.
  {
    files: ["packages/backend/src/**/*.ts", "packages/shared/src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        // Socket.io handlers are typed as returning void; an async handler there is a real
        // trap (rejections vanish), so this stays on for arguments as well as conditionals.
        { checksVoidReturn: { arguments: true, attributes: false } },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Prefer an explicit `unknown` over `any` at boundaries; zod is what narrows it.
      "@typescript-eslint/no-explicit-any": "warn",
      eqeqeq: ["error", "always", { null: "ignore" }],
      // The backend has a structured logger; a bare console.log bypasses redaction and could
      // print an OTP or a token into a log aggregator.
      "no-console": "error",
    },
  },

  // The injected-clock rule applies to handler code, not to the clock's own definition or to
  // tests (which legitimately construct timestamps).
  {
    files: ["packages/backend/src/socket/**/*.ts", "packages/backend/src/http/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            "Use the injected deps.now() clock instead of Date.now() so expiry and staleness logic is testable.",
        },
      ],
    },
  },

  // ── Frontend: browser globals, JSX, no type-aware rules (much slower, less payoff here).
  {
    files: ["packages/frontend/src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2022 },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },

  // ── Tests: looser. A test that reaches into internals or shadows a global is fine.
  {
    files: ["**/*.test.{ts,tsx}", "**/test/**/*.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
      "no-restricted-syntax": "off",
    },
  },

  // Config files and scripts run in Node and may legitimately log.
  {
    files: ["*.config.{js,ts}", "**/*.config.{js,ts}", "scripts/**/*.{js,mjs,ts}"],
    languageOptions: { globals: globals.node },
    rules: { "no-console": "off", "@typescript-eslint/no-floating-promises": "off" },
  },
);
