import { defineConfig } from 'vitest/config';
import path from 'node:path';

/*
 * The PostgreSQL certification gate.
 *
 * A separate config rather than a flag, because these suites are the opposite of the
 * default run: they require a real database and fail without one. Keeping them in their
 * own project means `vitest run` stays meaningful on a machine with no database, while
 * this gate can never pass by skipping — `requireTestDatabaseUrl` throws at collection
 * time when `ASSURAPAY_TEST_DATABASE_URL` is unset.
 *
 * Sequential, single-fork: several suites take advisory locks, create and drop databases,
 * and assert on connection-handle counts. Running them in parallel would make those
 * assertions depend on what another file happened to be doing.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.postgres.test.ts'],
    exclude: ['**/node_modules/**'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@assurapay/shared': path.resolve(
        __dirname,
        'packages/shared/src/index.ts',
      ),

      '@assurapay/domain-contracts': path.resolve(
        __dirname,
        'packages/domain-contracts/src/index.ts',
      ),
      '@assurapay/domain': path.resolve(
        __dirname,
        'packages/domain/src/index.ts',
      ),
      '@assurapay/database': path.resolve(
        __dirname,
        'packages/database/src/index.ts',
      ),
      '@assurapay/database-testing': path.resolve(
        __dirname,
        'packages/database-testing/src/index.ts',
      ),
      '@assurapay/runtime': path.resolve(
        __dirname,
        'packages/runtime/src/index.ts',
      ),
      '@assurapay/identity': path.resolve(
        __dirname,
        'packages/identity/src/index.ts',
      ),
      '@assurapay/organizations': path.resolve(
        __dirname,
        'packages/organizations/src/index.ts',
      ),
      '@assurapay/permissions': path.resolve(
        __dirname,
        'packages/permissions/src/index.ts',
      ),
      '@assurapay/parties': path.resolve(
        __dirname,
        'packages/parties/src/index.ts',
      ),
      '@assurapay/legal': path.resolve(
        __dirname,
        'packages/legal/src/index.ts',
      ),
      '@assurapay/governance-core': path.resolve(
        __dirname,
        'packages/governance-core/src/index.ts',
      ),
      '@assurapay/agreement-creation': path.resolve(
        __dirname,
        'packages/agreement-creation/src/index.ts',
      ),
      '@assurapay/agreement-intelligence': path.resolve(
        __dirname,
        'packages/agreement-intelligence/src/index.ts',
      ),
      '@assurapay/performance-blueprint': path.resolve(
        __dirname,
        'packages/performance-blueprint/src/index.ts',
      ),
      '@assurapay/performance-readiness': path.resolve(
        __dirname,
        'packages/performance-readiness/src/index.ts',
      ),
      '@assurapay/execution-orchestration': path.resolve(
        __dirname,
        'packages/execution-orchestration/src/index.ts',
      ),
      '@assurapay/completion-assurance': path.resolve(
        __dirname,
        'packages/completion-assurance/src/index.ts',
      ),
      '@assurapay/settlement-assurance': path.resolve(
        __dirname,
        'packages/settlement-assurance/src/index.ts',
      ),
      '@assurapay/settlement-execution': path.resolve(
        __dirname,
        'packages/settlement-execution/src/index.ts',
      ),
      '@assurapay/enterprise-intelligence': path.resolve(
        __dirname,
        'packages/enterprise-intelligence/src/index.ts',
      ),
      '@assurapay/enterprise-analytics': path.resolve(
        __dirname,
        'packages/enterprise-analytics/src/index.ts',
      ),
      '@assurapay/agent-runtime': path.resolve(
        __dirname,
        'packages/agent-runtime/src/index.ts',
      ),
      '@assurapay/workflow-intelligence': path.resolve(
        __dirname,
        'packages/workflow-intelligence/src/index.ts',
      ),
      '@assurapay/audit-ledger': path.resolve(
        __dirname,
        'packages/audit-ledger/src/index.ts',
      ),
      '@assurapay/reos': path.resolve(__dirname, 'packages/reos/src/index.ts'),
    },
  },
});
