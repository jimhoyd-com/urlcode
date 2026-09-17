import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['node_modules/**', 'coverage/**', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.node }, rules: { 'no-control-regex': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-non-null-assertion': 'off' } },
  // Modules shipped to the Cloudflare Worker must import nothing from Node.
  { files: ['src/match.ts','src/header-validation.ts','src/http-policy.ts','src/http-response.ts','src/cloudflare.ts','src/errors.ts','src/policies/agents.ts','src/policies/security.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['node:*'], message: 'This module ships to the Worker' }] }] } },
);
