import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.{test,spec}.ts'],
  },
  resolve: {
    alias: {
      '@assurapay/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
      '@assurapay/domain': path.resolve(__dirname, 'packages/domain/src/index.ts'),
      '@assurapay/database': path.resolve(__dirname, 'packages/database/src/index.ts'),
    },
  },
});
