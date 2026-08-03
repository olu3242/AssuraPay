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
const ctx = {
  actorUserId: 'author',
  sessionId: 's',
  identityAssuranceLevel: 'IAL3_HIGH_ASSURANCE' as const,
  activeWorkspaceId: 'w',
  tenantId: 't',
  memberships: ['w'],
  correlationId: 'c',
};
function draft(store: InMemoryTrustStore) {
  const a = new ContractAuthoringEngine(store),
    contract = a.create(ctx, {
      contractNumber: 'AP-1',
      title: 'Data Agreement',
      contractType: 'DATA',
      ownerUserId: 'author',
    }),
    template = a.publishTemplate(
      ctx,
      a.createTemplateVersion(ctx, {
        templateKey: 'data',
        variableSchema: [{ key: 'vendor', required: true }],
        content: 'template',
      }).id,
    ),
    d = a.createDraft(ctx, contract.id, template.id, 'docs/1', 'body');
  return { a, contract, template, d };
}
describe('Engine 11 Contract Authoring', () => {
  it('enforces numbering, immutable templates, required variables, locks and internal visibility', () => {
    const s = new InMemoryTrustStore(),
      { a, contract, template, d } = draft(s);
    expect(() =>
      a.create(ctx, {
        contractNumber: 'AP-1',
        title: 'x',
        contractType: 'DATA',
        ownerUserId: 'author',
      }),
    ).toThrow('EXISTS');
    expect(() => a.publishTemplate(ctx, template.id)).toThrow('IMMUTABLE');
    expect(() => a.submit(ctx, d.id)).toThrow('REQUIRED');
    a.comment(ctx, contract.id, 'privileged', 'INTERNAL');
    a.comment(ctx, contract.id, 'shared', 'SHARED');
    expect(a.comments(ctx, contract.id, true)).toHaveLength(1);
    a.lock(ctx, d.id);
    expect(() => a.revise(ctx, d.id, 'docs/2', 'changed')).toThrow('LOCKED');
  });
});
describe('Engine 12 Clause Intelligence', () => {
  it('preserves published baselines, custom source and high-risk deviation review', () => {
    const s = new InMemoryTrustStore(),
      e = new ClauseIntelligenceEngine(s),
      v = e.publish(
        ctx,
        e.createVersion(ctx, {
          clauseKey: 'liability',
          body: 'cap',
          risk: 'HIGH',
          guidance: 'internal',
        }).id,
      );
    expect(() => e.publish(ctx, v.id)).toThrow('IMMUTABLE');
    const i = e.insert(ctx, 'd', { clauseVersionId: v.id }),
      custom = e.insert(ctx, 'd', { customBody: 'custom' }),
      dev = e.deviate(ctx, i.id, v.id, 'uncapped', 'counterparty');
    expect(custom.source).toBe('CUSTOM');
    expect(dev).toMatchObject({ risk: 'HIGH', status: 'PENDING' });
    expect(() => e.guidance(ctx, v.id, true)).toThrow('FORBIDDEN');
    expect(e.approve({ ...ctx, actorUserId: 'legal' }, dev.id).status).toBe(
      'APPROVED',
    );
  });
});
describe('Engine 13 Negotiation', () => {
  it('keeps round history and blocks unauthorized submission and unresolved closure', () => {
    const s = new InMemoryTrustStore(),
      e = new NegotiationEngine(s);
    expect(() =>
      e.submit(ctx, {
        contractId: 'c',
        documentVersionId: 'd',
        participantIds: ['other'],
        mandatoryOpenItems: [],
      }),
    ).toThrow('PARTICIPANT');
    const r = e.submit(ctx, {
      contractId: 'c',
      documentVersionId: 'd',
      participantIds: ['author'],
      mandatoryOpenItems: ['liability'],
    });
    expect(() => e.accept(ctx, r.id)).toThrow('UNRESOLVED');
    expect(e.withdraw(ctx, r.id).status).toBe('WITHDRAWN');
  });
});
describe('Engine 14 Approval Workflow', () => {
  it('preserves policy/document versions, authority, segregation and immutable decisions', () => {
    const s = new InMemoryTrustStore(),
      { d } = draft(s),
      e = new ApprovalWorkflowEngine(s),
      p = e.policy(ctx, [{ role: 'LEGAL', minimumAssurance: 'IAL2_VERIFIED' }]),
      r = e.route(ctx, {
        contractId: d.contractId,
        documentVersionId: d.documentVersionId,
        policyId: p.id,
      });
    expect(() => e.decide(ctx, r.id, 'APPROVE', [], ['LEGAL'])).toThrow(
      'SELF_APPROVAL',
    );
    const legal = { ...ctx, actorUserId: 'legal' };
    expect(() => e.decide(legal, r.id, 'APPROVE', [], ['FINANCE'])).toThrow(
      'AUTHORITY',
    );
    e.decide(legal, r.id, 'APPROVE', [], ['LEGAL']);
    expect(() => e.decide(legal, r.id, 'APPROVE', [], ['LEGAL'])).toThrow(
      'IMMUTABLE',
    );
    expect(e.invalidateOnChange(legal, r.id, 'changed').status).toBe(
      'INVALIDATED',
    );
  });
});
describe('Engine 15 Digital Execution', () => {
  it('requires exact approval and authority, verifies idempotent callbacks, witnesses and deterministic certificates', async () => {
    const s = new InMemoryTrustStore(),
      { d } = draft(s),
      approval = new ApprovalWorkflowEngine(s),
      p = approval.policy(ctx, [
        { role: 'LEGAL', minimumAssurance: 'IAL2_VERIFIED' },
      ]),
      r = approval.route(ctx, {
        contractId: d.contractId,
        documentVersionId: d.documentVersionId,
        policyId: p.id,
      });
    approval.decide(
      { ...ctx, actorUserId: 'legal' },
      r.id,
      'APPROVE',
      [],
      ['LEGAL'],
    );
    const e = new DigitalExecutionEngine(
      s,
      deterministicSignatureProvider,
      'secret',
    );
    expect(() =>
      e.create(ctx, {
        contractId: d.contractId,
        approvalRequestId: r.id,
        documentVersionId: d.documentVersionId,
        signers: [
          { userId: 'signer', authorityReference: '', witnessRequired: true },
        ],
      }),
    ).toThrow('AUTHORITY');
    const pack = e.create(ctx, {
      contractId: d.contractId,
      approvalRequestId: r.id,
      documentVersionId: d.documentVersionId,
      signers: [
        {
          userId: 'signer',
          authorityReference: 'board-1',
          witnessRequired: true,
        },
      ],
    });
    await e.send(ctx, pack.id);
    const signed = {
        eventId: '1',
        userId: 'signer',
        action: 'SIGNED' as const,
        documentHash: pack.documentHash,
      },
      sig = (x: unknown) =>
        createHmac('sha256', 'secret').update(JSON.stringify(x)).digest('hex');
    expect(e.callback(ctx, pack.id, signed, sig(signed)).status).toBe(
      'PARTIALLY_SIGNED',
    );
    expect(() => e.issue(ctx, pack.id)).toThrow('INCOMPLETE');
    const witnessed = { ...signed, eventId: '2', action: 'WITNESSED' as const };
    e.callback(ctx, pack.id, witnessed, sig(witnessed));
    const cert = e.issue(ctx, pack.id);
    expect(e.issue(ctx, pack.id).canonicalHash).toBe(cert.canonicalHash);
    expect(e.revoke(ctx, cert.id).status).toBe('REVOKED');
  });
});
