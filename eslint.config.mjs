// ESLint flat config for the whole repository (backend, frontend, scripts, tests).
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/dist.*/**', 'backend/data/**', 'backend/backups/**', 'backend/prisma/prisma/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['backend/**/*.ts'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    rules: {
      // Unused values are almost always leftovers; a leading underscore marks an intentional one.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off'
    }
  },
  {
    // Tests stub the Google Sheets client with loosely typed fakes.
    files: ['backend/tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  },
  {
    files: ['*.{js,mjs}', 'frontend/*.ts'],
    languageOptions: { globals: globals.node }
  },
);
