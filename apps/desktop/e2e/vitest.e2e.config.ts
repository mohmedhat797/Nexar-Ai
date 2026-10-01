import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/*.e2e.ts'],
    root: fileURLToPath(new URL('..', import.meta.url)),
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
