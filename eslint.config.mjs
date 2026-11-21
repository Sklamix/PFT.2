// ESLint 10 flat config (PHASE 1.10.37).
//
// Scope decisions:
//  - `typescript-eslint` recommended (non-type-checked): full type-checked linting
//    duplicates `tsc --noEmit` (already clean) at a large time cost. Type-aware
//    rules can be added later as a separate owner decision.
//  - `no-unused-vars` is error-level for TS files via tseslint (catches real
//    defects), with a targeted exception for leading-underscore params, which
//    the existing codebase uses for intentionally-unused placeholders.
//  - `no-console` stays off: workers/crons legitimately log structured output.
//  - Next.js core-web-vitals rules come from @next/eslint-plugin-next; React
//    hook rules from eslint-plugin-react-hooks.
//  - Generated / vendored artifacts and tool assets are never scanned.
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import nextPlugin from '@next/eslint-plugin-next'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      '**/generated/**',
      '**/*.min.js',
      'public/**',
      '.agents/**',
      '-files --others --exclude-standard',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      '@next/next': nextPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,
      // React 19 compiler-era hook rules (v7): valuable, but the current codebase
      // predates them (legacy findings; see lint output). Downgraded to warnings
      // with a separate owner decision to modernize; NOT masked as errors elsewhere.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-constant-condition': ['error', { checkLoops: 'allExceptWhileTrue' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // CommonJS operational scripts: `require()` is the intended module system.
    files: ['scripts/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Prisma seed / standalone scripts legitimately use console and any-tolerant glue.
    files: ['prisma/seed*.ts', 'scripts/*.cjs'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)
