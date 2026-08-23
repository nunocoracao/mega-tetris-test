// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * A modest lint config: the recommended sets, type-aware, plus the handful of
 * rules that encode conventions this project actually cares about. Stylistic
 * opinions are deliberately absent — TypeScript's own strictness already carries
 * most of the weight, and a linter that argues about quotes is one people switch
 * off.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },

  js.configs.recommended,

  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser },
    },
    rules: {
      // `verbatimModuleSyntax` is on, so an unmarked type import is a runtime
      // import of nothing.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // An argument named `_something` is a documented placeholder.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Stray debug logging should not reach a player's console.
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    // Tests reach into internals and build deliberately malformed fixtures, and
    // they run in Node rather than the browser.
    files: ['**/*.test.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // Test fakes are object literals of arrow functions; there is no `this`
      // for one of them to lose.
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  {
    // The config files themselves are outside the app's tsconfig project.
    files: ['*.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    // The generators run in Node, not in a browser.
    files: ['build/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    // The service worker is shipped as it is written, so it is linted as it is
    // written: a classic worker script, outside the app's tsconfig project,
    // with the service-worker globals and nothing else.
    files: ['build/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
);
