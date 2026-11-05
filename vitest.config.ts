import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] }, test: {
  include: ['tests/**/*.spec.{ts,tsx}'],
  // Phase 2 C's specs hold the TP environment's one lock as legitimate holders and run real git in
  // throw-away repositories; every file keeps its own temporary state, so files run one at a time, which
  // also leaves a fork its whole CPU budget for git instead of starving it.
  fileParallelism: false,
} })
