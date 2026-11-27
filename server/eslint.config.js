// ESLint flat config for the API server.
//
// Kept separate from the frontend config (which ignores server/**): the
// server has its own tsconfig and no Vue. The rule set is the recommended
// baseline of ESLint + typescript-eslint, aligned with the frontend's
// unused-vars convention (leading underscore = intentionally unused).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  {
    name: 'server/ignores',
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: 'server/rules',
    linterOptions: {
      // Existing `eslint-disable no-console` comments document intent even
      // though no-console is not enabled; do not flag them.
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    name: 'server/tests',
    files: ['**/*.test.ts', '**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
