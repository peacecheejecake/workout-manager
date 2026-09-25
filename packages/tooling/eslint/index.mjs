import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { createBoundaryRule } from './boundaries.mjs';

export function createConfig(root) {
  return tseslint.config(
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/.turbo/**',
        '**/coverage/**',
        '**/playwright-report/**',
        '**/test-results/**',
        // Opt-in self-hosted map build workspace (tiles, graphs, bundled harness output).
        '**/.geo-build/**',
        '**/.geo-build-*/**',
        '**/.venv/**',
        'docs/.pre/**',
        '.agents/**',
        '.codex/**',
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.strict,
    {
      files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts,jsx}'],
      languageOptions: { globals: { ...globals.node } },
      plugins: {
        architecture: { rules: { boundaries: createBoundaryRule(root) } },
        'react-hooks': reactHooks,
      },
      rules: { 'architecture/boundaries': 'error', ...reactHooks.configs.recommended.rules },
    },
    {
      files: ['**/*.{ts,tsx,mts,cts}'],
      rules: {
        '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
      },
    },
    {
      files: ['**/*.{jsx,tsx}'],
      languageOptions: {
        globals: { ...globals.browser },
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      plugins: { 'jsx-a11y': jsxA11y },
      rules: { ...jsxA11y.configs.recommended.rules },
    },
    prettier,
  );
}
