import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['../tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['functions/**/*.ts', 'shared/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@shared': './shared',
    },
  },
});
