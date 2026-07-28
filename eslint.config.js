import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

const noUnusedVars = [
  'error',
  { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
];

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'server/data/**', 'docs/**'],
  },

  js.configs.recommended,

  // ---- Server: Node + ESM ------------------------------------------------
  {
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': noUnusedVars,
    },
  },

  // ---- Client: browser + React + JSX ------------------------------------
  {
    files: ['client/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: '18.3' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // The automatic JSX runtime means React need not be in scope.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // Apostrophes in user-facing copy are intentional, not markup bugs.
      'react/no-unescaped-entities': 'off',
      'no-unused-vars': noUnusedVars,
    },
  },

  // ---- Config files (root + workspace) run under Node -------------------
  {
    files: ['**/*.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Disable stylistic rules that Prettier owns.
  prettier,
];
