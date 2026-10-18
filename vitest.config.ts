import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['extensions/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['extensions/provider.ts', 'extensions/routing.ts'],
      thresholds: {
        lines: 40,
        statements: 40,
        branches: 30,
        functions: 30,
      },
    },
  },
});
