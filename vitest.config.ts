import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}'],
    // Web component tests opt in with `// @vitest-environment happy-dom`.
    environmentOptions: { happyDOM: { url: 'http://localhost/' } },
    environment: 'node',
    pool: 'forks',
  },
});
