import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // eslint-plugin-react-hooks v6 turns on new React-Compiler-based rules
      // that flag patterns this app uses deliberately and correctly: latest-value
      // refs (`ref.current = x` in render), deck.gl layer accessors and
      // `updateTriggers` that read refs during render, a ref-held Set mutated in
      // callbacks, and a self-scheduling rAF loop. Satisfying them would mean
      // ~25 inline disables or risky rewrites of working code. Keep the
      // battle-tested rules (exhaustive-deps, rules-of-hooks) and turn off the
      // two noisy compiler rules.
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
    },
  },
])
