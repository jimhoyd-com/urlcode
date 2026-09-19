import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  // Anchored at `**/` rather than the root: the workspace packages under
  // `packages/` have build output and dependencies of their own, and a
  // root-only pattern lints their generated `dist/` files.
  { ignores: ['**/node_modules/**', '**/coverage/**', '**/dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.node }, rules: { 'no-control-regex': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-non-null-assertion': 'off' } },
  // Auth's HTTP tests read response bodies with `await res.json()`, which is
  // typed `unknown`, and then assert on the shape that is the contract under
  // test. Every one of the 31 `as any` casts there is that escape. They are
  // not accidental looseness, and re-typing them properly means building typed
  // response helpers for auth's API -- worth doing, but it is a test-typing
  // project rather than migration work, so it is tracked separately instead of
  // being smuggled into the commit that moved the package. Scoped to auth's
  // test directory so `any` stays an error everywhere else, including in
  // auth's own `src/`.
  { files: ['packages/auth/test/**'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  // Modules shipped to the Cloudflare Worker must import nothing from Node.
  // scripts/check.ts computes the real Worker import closure; keep this list
  // in step with what it reports.
  { files: ['src/match.ts','src/header-validation.ts','src/http-policy.ts','src/http-response.ts','src/cloudflare.ts','src/errors.ts','src/policies/agents.ts','src/policies/security.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['node:*'], message: 'This module ships to the Worker' }] }] } },
);
