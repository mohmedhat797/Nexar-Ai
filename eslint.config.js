import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // One program over all sources + tests (package tsconfigs exclude tests).
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': 'warn',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'warn' },
  },
);
