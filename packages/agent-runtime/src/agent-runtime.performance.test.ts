import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { AgentTelemetryEngine, ExecutionMemoryEngine } from './index';
const c = {
  actorUserId: 'u',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'load',
};
describe('load: append-only runtime records', () => {
  it('records and reads 1,000 ordered memory and telemetry entries', async () => {
    const store = new InMemoryTrustStore();
    const memory = new ExecutionMemoryEngine(store);
    const telemetry = new AgentTelemetryEngine(store);
    for (let i = 0; i < 1_000; i++) {
      await memory.append(c, {
        executionId: 'run',
        agentId: 'agent',
        kind: 'TOOL',
        content: { i },
      });
      await telemetry.record(c, {
        executionId: `run-${i}`,
        agentId: 'agent',
        latencyMs: i,
        costMinor: 0,
        inputTokens: 1,
        outputTokens: 1,
        errors: 0,
        hallucinationFlag: false,
        approvalRequested: false,
      });
    }
    expect((await memory.history(c, 'run'))[999].sequence).toBe(1_000);
    expect((await telemetry.summarize(c)).count).toBe(1_000);
  });
});
