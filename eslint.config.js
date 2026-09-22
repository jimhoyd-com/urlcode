import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  // Anchored at `**/` rather than the root: the workspace packages under
  // `packages/` have build output and dependencies of their own, and a
  // root-only pattern lints their generated `dist/` files.
  { ignores: ['**/node_modules/**', '**/coverage/**', '**/dist/**', '.claude/worktrees/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.node }, rules: { 'no-control-regex': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-non-null-assertion': 'off' } },
  // Modules shipped to the Cloudflare Worker must import nothing from Node.
  // scripts/check.ts computes the real Worker import closure; keep this list
  // in step with what it reports.
  { files: ['packages/core/src/match.ts','packages/core/src/header-validation.ts','packages/core/src/http-policy.ts','packages/core/src/http-response.ts','packages/core/src/cloudflare.ts','packages/core/src/errors.ts','packages/core/src/policies/agents.ts','packages/core/src/policies/security.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['node:*'], message: 'This module ships to the Worker' }] }] } },
);
