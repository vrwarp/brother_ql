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
    // Build and release scripts run under Node, so the globals the default
    // ECMAScript environment does not know about have to be named. Declared
    // here rather than repo-wide so `no-undef` still catches a stray `process`
    // in src/, where there is no Node to provide one.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    // The diagnostics smoke test drives a real browser: its page.evaluate /
    // waitForFunction callbacks are parsed here as Node code but execute in
    // the page, where the DOM globals do exist.
    files: ['scripts/smoke-diagnostics.mjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        navigator: 'readonly',
        window: 'readonly',
        DOMException: 'readonly',
        DataView: 'readonly',
        Uint8Array: 'readonly',
        setTimeout: 'readonly',
      },
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
