import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  ApprovalWorkflowEngine,
  ClauseIntelligenceEngine,
  ContractAuthoringEngine,
  DigitalExecutionEngine,
  NegotiationEngine,
  deterministicSignatureProvider,
} from './index';
describe('e2e Batch 3 governed agreement creation', () => {
  it('runs template through executed certificate with human approval and verified signatures', async () => {
    const s = new InMemoryTrustStore(),
      c = {
        actorUserId: 'manager',
        sessionId: 's',
        identityAssuranceLevel: 'IAL3_HIGH_ASSURANCE' as const,
        activeWorkspaceId: 'w',
        tenantId: 't',
        memberships: ['w'],
        correlationId: 'c',
      },
      a = new ContractAuthoringEngine(s),
      contract = await a.create(c, {
        contractNumber: 'AP-2026-1',
        title: 'Vendor Agreement',
        contractType: 'DATA',
        ownerUserId: 'manager',
      }),
      t = await a.publishTemplate(
        c,
        (await a.createTemplateVersion(c, {
          templateKey: 'vendor',
          variableSchema: [{ key: 'vendor', required: true }],
          content: 'v1',
        })).id,
      ),
      d = await a.createDraft(c, contract.id, t.id, 'draft/1', 'agreement');
    await a.setVariables(c, d.id, { vendor: 'Fictional Data Ltd' });
    await a.submit(c, d.id);
    const clauses = new ClauseIntelligenceEngine(s),
      cv = await clauses.publish(
        c,
        (await clauses.createVersion(c, {
          clauseKey: 'scope',
          body: 'deliver data',
          risk: 'LOW',
          guidance: 'standard',
        })).id,
      );
    await clauses.insert(c, d.id, { clauseVersionId: cv.id });
    const n = new NegotiationEngine(s),
      round = await n.submit(
        { ...c, actorUserId: 'counterparty' },
        {
          contractId: contract.id,
          documentVersionId: d.documentVersionId,
          participantIds: ['counterparty'],
          mandatoryOpenItems: [],
        },
      );
    await n.accept(c, round.id);
    const approvals = new ApprovalWorkflowEngine(s),
      policy = await approvals.policy(c, [
        { role: 'LEGAL', minimumAssurance: 'IAL2_VERIFIED' },
      ]),
      request = await approvals.route(c, {
        contractId: contract.id,
        documentVersionId: d.documentVersionId,
        policyId: policy.id,
      });
    await approvals.decide(
      { ...c, actorUserId: 'legal' },
      request.id,
      'APPROVE',
      [],
      ['LEGAL'],
    );
    const execution = new DigitalExecutionEngine(
        s,
        deterministicSignatureProvider,
        'secret',
      ),
      pack = await execution.create(c, {
        contractId: contract.id,
        approvalRequestId: request.id,
        documentVersionId: d.documentVersionId,
        signers: [
          {
            userId: 'signer',
            authorityReference: 'board-resolution',
            witnessRequired: false,
          },
        ],
      });
    await execution.send(c, pack.id);
    const payload = {
        eventId: 'evt',
        userId: 'signer',
        action: 'SIGNED' as const,
        documentHash: pack.documentHash,
      },
      signature = createHmac('sha256', 'secret')
        .update(JSON.stringify(payload))
        .digest('hex');
    await execution.callback(c, pack.id, payload, signature);
    expect(await execution.issue(c, pack.id)).toMatchObject({
      contractId: contract.id,
      status: 'VALID',
    });
  });
});
