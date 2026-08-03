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
      '@assurapay/identity': path.resolve(__dirname, 'packages/identity/src/index.ts'),
      '@assurapay/organizations': path.resolve(__dirname, 'packages/organizations/src/index.ts'),
      '@assurapay/permissions': path.resolve(__dirname, 'packages/permissions/src/index.ts'),
      '@assurapay/parties': path.resolve(__dirname, 'packages/parties/src/index.ts'),
      '@assurapay/legal': path.resolve(__dirname, 'packages/legal/src/index.ts'),
      '@assurapay/governance-core': path.resolve(__dirname, 'packages/governance-core/src/index.ts'),
      '@assurapay/agreement-creation': path.resolve(__dirname, 'packages/agreement-creation/src/index.ts'),
      '@assurapay/agreement-intelligence': path.resolve(__dirname, 'packages/agreement-intelligence/src/index.ts'),
      '@assurapay/performance-blueprint': path.resolve(__dirname, 'packages/performance-blueprint/src/index.ts'),
      '@assurapay/performance-readiness': path.resolve(__dirname, 'packages/performance-readiness/src/index.ts'),
      '@assurapay/execution-orchestration': path.resolve(__dirname, 'packages/execution-orchestration/src/index.ts'),
      '@assurapay/completion-assurance': path.resolve(__dirname, 'packages/completion-assurance/src/index.ts'),
      '@assurapay/settlement-assurance': path.resolve(__dirname, 'packages/settlement-assurance/src/index.ts'),
      '@assurapay/settlement-execution': path.resolve(__dirname, 'packages/settlement-execution/src/index.ts'),
      '@assurapay/enterprise-intelligence': path.resolve(__dirname, 'packages/enterprise-intelligence/src/index.ts'),
      '@assurapay/enterprise-analytics': path.resolve(__dirname, 'packages/enterprise-analytics/src/index.ts'),
    },
  },
});
