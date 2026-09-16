import js from '@eslint/js';
import globals from 'globals';
export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node }, rules: { 'no-control-regex': 'off', 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
];
