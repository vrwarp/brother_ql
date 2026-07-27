import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'demo/dist/**', 'node_modules/**', 'brother_ql/**', 'test/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The published library targets the browser. Node built-ins are available
    // to the tests and to build tooling, but must never reach src/.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'url', 'zlib', 'crypto', 'buffer'],
              message:
                'The browser library must not depend on Node built-ins. Keep platform code in test helpers or the demo.',
            },
          ],
        },
      ],
    },
  },
);
