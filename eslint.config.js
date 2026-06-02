import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default [
  {
    // `old/` is the untouched reference port; `dist/` is build output. run-bench.mjs
    // is a dev-only headless-Chrome driver with dense CDP plumbing — not shipped.
    ignores: ['dist/**', 'old/**', 'scripts/run-bench.mjs'],
  },
  stylistic.configs.customize({
    indent: 2,
    quotes: 'single',
    semi: true,
  }),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  },
  {
    rules: {
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      '@stylistic/no-multiple-empty-lines': ['error', { max: 2, maxEOF: 0, maxBOF: 0 }],
      '@stylistic/space-before-function-paren': ['error', {
        anonymous: 'always',
        named: 'never',
        asyncArrow: 'always',
      }],
    },
  },
];
