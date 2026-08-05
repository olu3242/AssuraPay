import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  BottleneckDetectionEngine,
  DependencyIntelligenceEngine,
  EscalationIntelligenceEngine,
  ExceptionManagementEngine,
  ExecutionHealthEngine,
  PredictiveRiskIntelligenceEngine,
  ResourceIntelligenceEngine,
  ScheduleOptimizationEngine,
  SlaIntelligenceEngine,
  WorkflowIntelligenceEngine,
  deterministicRiskPredictionGateway,
} from './index';
const c = {
  actorUserId: 'pm',
  sessionId: 's',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'unit',
};

describe('Engines 71–80 workflow intelligence', () => {
  it('71 computes workflow progress and detects blocked and stalled canonical nodes', async () => {
    const engine = new WorkflowIntelligenceEngine(new InMemoryTrustStore());
    const report = await engine.assess(c, {
      agreementId: 'a',
      observedAt: '2026-08-03T12:00:00Z',
      stalledAfterHours: 24,
      edges: [],
      nodes: [
        {
          id: 'm1',
          kind: 'MILESTONE',
          state: 'IN_PROGRESS',
          progressPercent: 50,
          updatedAt: '2026-08-01T00:00:00Z',
        },
        {
          id: 'd1',
          kind: 'DOD',
          state: 'BLOCKED',
          progressPercent: 0,
          updatedAt: '2026-08-03T00:00:00Z',
        },
      ],
    });
    expect(report.status).toBe('AT_RISK');
    expect(report.stalledNodeIds).toEqual(['m1']);
    expect(report.healthScore).toBe(10);
  });
  it('72 detects cycles and calculates downstream impact and blocked work', () => {
    const engine = new DependencyIntelligenceEngine();
    const edges = [
      { from: 'a', to: 'b', type: 'MILESTONE' as const },
      { from: 'b', to: 'c', type: 'PAYMENT' as const },
    ];
    expect(engine.analyze(['a', 'b', 'c'], edges).downstream.a).toEqual([
      'b',
      'c',
    ]);
    expect(() =>
      engine.analyze(
        ['a', 'b'],
        [
          { from: 'a', to: 'b', type: 'MILESTONE' },
          { from: 'b', to: 'a', type: 'MILESTONE' },
        ],
      ),
    ).toThrow('CIRCULAR_DEPENDENCY');
    expect(
      engine.blocked(
        [
          {
            id: 'a',
            kind: 'MILESTONE',
            state: 'BLOCKED',
            progressPercent: 0,
            updatedAt: '',
          },
          {
            id: 'b',
            kind: 'MILESTONE',
            state: 'NOT_STARTED',
            progressPercent: 0,
            updatedAt: '',
          },
        ],
        edges.slice(0, 1),
      ),
    ).toEqual(['b']);
  });
  it('73 emits deterministic severity-ranked bottleneck recommendations', () => {
    const result = new BottleneckDetectionEngine().detect({
      delayedNodeIds: ['m1'],
      approvalQueueHours: { approval: 80 },
      missingEvidenceByMilestone: { m2: 2 },
      validationFailuresByMilestone: { m3: 1 },
    });
    expect(result.map((x) => x.type)).toEqual([
      'APPROVAL_QUEUE',
      'EXECUTION_DELAY',
      'EVIDENCE_SHORTAGE',
      'VALIDATION_FAILURE',
    ]);
  });
  it('74 calculates deadline breach and late-completion probability', () => {
    const result = new SlaIntelligenceEngine().assess(
      [
        {
          id: 'm',
          kind: 'MILESTONE',
          dueAt: '2026-08-03T10:00:00Z',
          progressPercent: 80,
        },
      ],
      '2026-08-03T12:00:00Z',
    )[0];
    expect(result.breached).toBe(true);
    expect(result.breachProbability).toBe(100);
  });
  it('75 produces a governed remediation proposal without changing domain state', async () => {
    const plan = await new ExceptionManagementEngine(
      new InMemoryTrustStore(),
    ).createPlan(c, {
      agreementId: 'a',
      scopeId: 'dod',
      type: 'INCOMPLETE_DOD',
      facts: ['criterion missing'],
    });
    expect(plan.status).toBe('PROPOSED');
    expect(plan.proposedActions).toContain('List unmet criteria');
  });
  it('76 recommends but never performs role-aware escalation', () => {
    const proposal = new EscalationIntelligenceEngine().recommend({
      type: 'SETTLEMENT_BLOCKER',
      severity: 95,
      rationale: 'provider confirmation missing',
    });
    expect(proposal).toMatchObject({
      recipient: 'FINANCE',
      status: 'PROPOSED',
    });
  });
  it('77 requires a governed model and returns confidence, rationale and unreviewed status', async () => {
    await expect(
      await new PredictiveRiskIntelligenceEngine().predict({
        agreementId: 'a',
        signals: {},
      }),
    ).rejects.toThrow('GOVERNED_RISK_GATEWAY_REQUIRED');
    const prediction = await new PredictiveRiskIntelligenceEngine(
      deterministicRiskPredictionGateway,
    ).predict({ agreementId: 'a', signals: { delay: 40 } });
    expect(prediction.completionProbability).toBe(60);
    expect(prediction.confidence).toBe(0.75);
    expect(prediction.reviewStatus).toBe('NOT_REVIEWED');
    expect(prediction.rationale).toBeTruthy();
  });
  it('78 proposes a dependency-safe schedule and identifies overload', () => {
    const result = new ScheduleOptimizationEngine().recommend({
      nodes: [
        { id: 'm1', ownerId: 'o', durationHours: 9 },
        { id: 'm2', ownerId: 'p', durationHours: 2 },
      ],
      edges: [{ from: 'm1', to: 'm2', type: 'MILESTONE' }],
      capacityHoursByOwner: { o: 8, p: 8 },
    });
    expect(result.proposedSequence).toEqual(['m1', 'm2']);
    expect(result.overloadedOwners).toEqual(['o']);
    expect(result.status).toBe('PROPOSED');
  });
  it('79 analyzes utilization and recommends additional capacity', () => {
    const result = new ResourceIntelligenceEngine().analyze([
      {
        ownerId: 'o',
        assignedHours: 12,
        capacityHours: 8,
        approvalQueue: 4,
        completedApprovals: 1,
      },
    ])[0];
    expect(result.utilization).toBe(150);
    expect(result.bottleneck).toBe(true);
    expect(result.recommendation).toContain('reassignment');
  });
  it('80 computes the primary weighted execution KPI and persists an immutable snapshot', async () => {
    const store = new InMemoryTrustStore();
    const result = await new ExecutionHealthEngine(store).compute(c, {
      agreementId: 'a',
      signals: {
        milestoneCompletion: 80,
        dodCompliance: 90,
        evidenceQuality: 80,
        validationStatus: 100,
        approvalVelocity: 70,
        settlementReadiness: 60,
        executionRisk: 20,
      },
    });
    expect(result.score).toBe(82);
    expect(result.health).toBe('HEALTHY');
    expect(await store.list('executionHealthScores')).toHaveLength(1);
  });
});
