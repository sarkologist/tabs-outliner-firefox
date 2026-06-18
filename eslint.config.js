// @ts-check
// Flat ESLint config (ESLint 9 + typescript-eslint 8).
//
// Goal: a SUSTAINABLE, LOW-NOISE gate. The compiler is already strict (strict tsc,
// noUncheckedIndexedAccess, exactOptionalPropertyTypes, 0 `any`/`console`/`ts-ignore`),
// so this config deliberately does NOT pull `recommended-type-checked` wholesale. It
// keeps the non-type-checked `recommended` base (which locks in the pristine invariants:
// no-explicit-any, ban-ts-comment, …) and layers on the handful of TYPE-AWARE rules that
// strict `tsc` does not provide — chiefly the async-safety pair the codebase needs most.
//
// Scoping (see README of this block in REPO_MAP.md gate table / docs/QUALITY.md):
//   - Type-aware rules run on PRODUCTION `src/` only. `projectService` resolves each file
//     via the nearest `tsconfig.json`, which EXCLUDES tests; tests live in
//     `tsconfig.test.json`. Rather than fight multi-tsconfig project resolution, tests,
//     test-support, Playwright specs, scripts and config files get a lighter, non-type-aware
//     lint. Production async correctness is the prize, and that lives in `src/`.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

/** Unused-vars policy shared across blocks: allow intentional `_`-prefixed throwaways. */
const noUnusedVars = [
  "error",
  {
    args: "all",
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    caughtErrors: "all",
    caughtErrorsIgnorePattern: "^_",
    destructuredArrayIgnorePattern: "^_",
    ignoreRestSiblings: true
  }
];

export default tseslint.config(
  // --- Global ignores: build output, generated artifacts, vendored/oracle, big scratch ---
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
      "web-ext-artifacts/**",
      ".cache/**",
      "node_modules/**",
      "oracle/**", // PureScript oracle + its vendored JS — not ours to lint
      "public/**", // static assets
      "autoresearch/**/*.tsv"
    ]
  },

  // --- Plain JS (.mjs scripts + this config): non-type-aware, node globals ---
  {
    files: ["scripts/**/*.mjs", "*.mjs", "eslint.config.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: {
      "no-unused-vars": noUnusedVars
    }
  },

  // --- TypeScript: non-type-checked recommended base (locks in pristine invariants) ---
  // Applies to ALL `.ts`; the type-aware block below narrows to production.
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "*.config.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": noUnusedVars,
      // Boundary clarity: the sidebar→background edges are mostly type-only. Enforcing a
      // consistent `import type` makes those edges explicit (the debt ratchet tracks them).
      // This rule is syntactic, so it is safe to run repo-wide (not just type-aware blocks).
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" }
      ]
    }
  },

  // --- Production `src/`: the TYPE-AWARE high-value rules strict tsc does NOT give ---
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/**/*.test-support.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // THE prize. This codebase is heavily async (runtime ports, the mutation scheduler,
      // deferred/coalesced saves, fire-and-forget broadcasts). Intentional fire-and-forget
      // is annotated with the `void` operator (see ARCHITECTURE.md "Do Not Await Sidebar
      // Broadcasts"); genuinely dropped awaits are real bugs to fix.
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
      "@typescript-eslint/no-misused-promises": "error",
      // Flags `await` on a non-thenable -- e.g. awaiting the synchronous sidebar-broadcaster
      // ("Do Not Await Sidebar Broadcasts"). The 6 controller broadcast wrappers and the sync
      // persist/finalizer chain that calls them are deliberately non-async so this holds.
      "@typescript-eslint/await-thenable": "error",
      // Flags `async` functions that never await -- pairs with the rules above.
      "@typescript-eslint/require-await": "error",
      // Complements the compiler-exhaustive command classification: a `switch` over a union
      // must cover every case (a `default` counts as exhaustive).
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true }
      ]
    }
  },

  // --- Tests, test-support, Playwright specs: lighter, non-type-aware ---
  {
    files: ["src/**/*.test.ts", "src/**/*.test-support.ts", "tests/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    }
  },

  // Turn off any stylistic rules that would fight Prettier. Must be last.
  eslintConfigPrettier
);
