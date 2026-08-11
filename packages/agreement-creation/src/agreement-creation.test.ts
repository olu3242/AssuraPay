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
async function draft(store: InMemoryTrustStore) {
  const a = new ContractAuthoringEngine(store),
    contract = await a.create(ctx, {
      contractNumber: 'AP-1',
      title: 'Data Agreement',
      contractType: 'DATA',
      ownerUserId: 'author',
    }),
    template = await a.publishTemplate(
      ctx,
      (await a.createTemplateVersion(ctx, {
        templateKey: 'data',
        variableSchema: [{ key: 'vendor', required: true }],
        content: 'template',
      })).id,
    ),
    d = await a.createDraft(ctx, contract.id, template.id, 'docs/1', 'body');
  return { a, contract, template, d };
}
describe('Engine 11 Contract Authoring', () => {
  it('enforces numbering, immutable templates, required variables, locks and internal visibility', async () => {
    const s = new InMemoryTrustStore(),
      { a, contract, template, d } = await draft(s);
    await expect(a.create(ctx, {
        contractNumber: 'AP-1',
        title: 'x',
        contractType: 'DATA',
        ownerUserId: 'author',
      })).rejects.toThrow('EXISTS');
    await expect(a.publishTemplate(ctx, template.id)).rejects.toThrow('IMMUTABLE');
    await expect(a.submit(ctx, d.id)).rejects.toThrow('REQUIRED');
    await a.comment(ctx, contract.id, 'privileged', 'INTERNAL');
    await a.comment(ctx, contract.id, 'shared', 'SHARED');
    expect(await a.comments(ctx, contract.id, true)).toHaveLength(1);
    await a.lock(ctx, d.id);
    await expect(a.revise(ctx, d.id, 'docs/2', 'changed')).rejects.toThrow('LOCKED');
  });
});
describe('Engine 12 Clause Intelligence', () => {
  it('preserves published baselines, custom source and high-risk deviation review', async () => {
    const s = new InMemoryTrustStore(),
      e = new ClauseIntelligenceEngine(s),
      v = await e.publish(
        ctx,
        (await e.createVersion(ctx, {
          clauseKey: 'liability',
          body: 'cap',
          risk: 'HIGH',
          guidance: 'internal',
        })).id,
      );
    await expect(e.publish(ctx, v.id)).rejects.toThrow('IMMUTABLE');
    const i = await e.insert(ctx, 'd', { clauseVersionId: v.id }),
      custom = await e.insert(ctx, 'd', { customBody: 'custom' }),
      dev = await e.deviate(ctx, i.id, v.id, 'uncapped', 'counterparty');
    expect(custom.source).toBe('CUSTOM');
    expect(dev).toMatchObject({ risk: 'HIGH', status: 'PENDING' });
    await expect(e.guidance(ctx, v.id, true)).rejects.toThrow('FORBIDDEN');
    expect((await e.approve({ ...ctx, actorUserId: 'legal' }, dev.id)).status).toBe(
      'APPROVED',
    );
  });
});
describe('Engine 13 Negotiation', () => {
  it('keeps round history and blocks unauthorized submission and unresolved closure', async () => {
    const s = new InMemoryTrustStore(),
      e = new NegotiationEngine(s);
    await expect(e.submit(ctx, {
        contractId: 'c',
        documentVersionId: 'd',
        participantIds: ['other'],
        mandatoryOpenItems: [],
      })).rejects.toThrow('PARTICIPANT');
    const r = await e.submit(ctx, {
      contractId: 'c',
      documentVersionId: 'd',
      participantIds: ['author'],
      mandatoryOpenItems: ['liability'],
    });
    await expect(e.accept(ctx, r.id)).rejects.toThrow('UNRESOLVED');
    expect((await e.withdraw(ctx, r.id)).status).toBe('WITHDRAWN');
    // A withdrawn round is closed. Neither method checked the status before, so an accepted round could
    // be withdrawn and a withdrawn one accepted — reversing a settled position after the fact.
    await expect(e.withdraw(ctx, r.id)).rejects.toThrow('CLOSED');
    await expect(e.accept(ctx, r.id)).rejects.toThrow('CLOSED');
    const open = await e.submit(ctx, {
      contractId: 'c',
      documentVersionId: 'd',
      participantIds: ['author'],
      mandatoryOpenItems: [],
    });
    expect((await e.accept(ctx, open.id)).status).toBe('ACCEPTED');
    await expect(e.withdraw(ctx, open.id)).rejects.toThrow('CLOSED');
  });
});
describe('Engine 14 Approval Workflow', () => {
  it('preserves policy/document versions, authority, segregation and immutable decisions', async () => {
    const s = new InMemoryTrustStore(),
      { d } = await draft(s),
      e = new ApprovalWorkflowEngine(s),
      p = await e.policy(ctx, [{ role: 'LEGAL', minimumAssurance: 'IAL2_VERIFIED' }]),
      r = await e.route(ctx, {
        contractId: d.contractId,
        documentVersionId: d.documentVersionId,
        policyId: p.id,
      });
    await expect(e.decide(ctx, r.id, 'APPROVE', [], ['LEGAL'])).rejects.toThrow(
      'SELF_APPROVAL',
    );
    const legal = { ...ctx, actorUserId: 'legal' };
    await expect(e.decide(legal, r.id, 'APPROVE', [], ['FINANCE'])).rejects.toThrow(
      'AUTHORITY',
    );
    await e.decide(legal, r.id, 'APPROVE', [], ['LEGAL']);
    await expect(e.decide(legal, r.id, 'APPROVE', [], ['LEGAL'])).rejects.toThrow(
      'IMMUTABLE',
    );
    expect((await e.invalidateOnChange(legal, r.id, 'changed')).status).toBe(
      'INVALIDATED',
    );
  });
});
describe('Engine 15 Digital Execution', () => {
  it('requires exact approval and authority, verifies idempotent callbacks, witnesses and deterministic certificates', async () => {
    const s = new InMemoryTrustStore(),
      { d } = await draft(s),
      approval = new ApprovalWorkflowEngine(s),
      p = await approval.policy(ctx, [
        { role: 'LEGAL', minimumAssurance: 'IAL2_VERIFIED' },
      ]),
      r = await approval.route(ctx, {
        contractId: d.contractId,
        documentVersionId: d.documentVersionId,
        policyId: p.id,
      });
    await approval.decide(
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
    await expect(e.create(ctx, {
        contractId: d.contractId,
        approvalRequestId: r.id,
        documentVersionId: d.documentVersionId,
        signers: [
          { userId: 'signer', authorityReference: '', witnessRequired: true },
        ],
      })).rejects.toThrow('AUTHORITY');
    const pack = await e.create(ctx, {
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
    expect((await e.callback(ctx, pack.id, signed, sig(signed))).status).toBe(
      'PARTIALLY_SIGNED',
    );
    await expect(e.issue(ctx, pack.id)).rejects.toThrow('INCOMPLETE');
    const witnessed = { ...signed, eventId: '2', action: 'WITNESSED' as const };
    await e.callback(ctx, pack.id, witnessed, sig(witnessed));
    const cert = await e.issue(ctx, pack.id);
    expect((await e.issue(ctx, pack.id)).canonicalHash).toBe(cert.canonicalHash);
    expect((await e.revoke(ctx, cert.id)).status).toBe('REVOKED');
  });

  it('scopes callback replay to the workspace and refuses to reopen a closed package', async () => {
    const s = new InMemoryTrustStore(),
      sig = (x: unknown) =>
        createHmac('sha256', 'secret').update(JSON.stringify(x)).digest('hex'),
      e = new DigitalExecutionEngine(s, deterministicSignatureProvider, 'secret');
    // Built per workspace rather than through the shared `draft` helper, which authors into `ctx`'s
    // workspace under a fixed contract number whatever context it is handed.
    async function sent(c: typeof ctx) {
      const a = new ContractAuthoringEngine(s),
        contract = await a.create(c, {
          contractNumber: `AP-${c.activeWorkspaceId}`,
          title: 'Data Agreement',
          contractType: 'DATA',
          ownerUserId: 'author',
        }),
        template = await a.publishTemplate(
          c,
          (await a.createTemplateVersion(c, {
            templateKey: 'data',
            variableSchema: [],
            content: 'template',
          })).id,
        ),
        d = await a.createDraft(c, contract.id, template.id, 'docs/1', 'body'),
        approval = new ApprovalWorkflowEngine(s),
        p = await approval.policy(c, [
          { role: 'LEGAL', minimumAssurance: 'IAL2_VERIFIED' },
        ]),
        r = await approval.route(c, {
          contractId: d.contractId,
          documentVersionId: d.documentVersionId,
          policyId: p.id,
        });
      await approval.decide({ ...c, actorUserId: 'legal' }, r.id, 'APPROVE', [], ['LEGAL']);
      const pack = await e.create(c, {
        contractId: d.contractId,
        approvalRequestId: r.id,
        documentVersionId: d.documentVersionId,
        signers: [
          { userId: 'signer', authorityReference: 'board-1', witnessRequired: false },
        ],
      });
      await e.send(c, pack.id);
      return pack;
    }
    const first = await sent(ctx);
    const signed = {
      eventId: 'provider-collision',
      userId: 'signer',
      action: 'SIGNED' as const,
      documentHash: first.documentHash,
    };
    expect((await e.callback(ctx, first.id, signed, sig(signed))).status).toBe('COMPLETED');
    // The same event delivered twice is a replay: the package comes back unchanged rather than
    // transitioning again.
    expect((await e.callback(ctx, first.id, signed, sig(signed))).status).toBe('COMPLETED');

    // A second workspace whose provider issued the same event identifier. Before the replay check was
    // scoped, this matched the first workspace's row and returned the package untouched — silently
    // dropping a real signature event rather than recording it.
    const other = { ...ctx, activeWorkspaceId: 'w2', memberships: ['w2'] },
      second = await sent(other),
      collision = { ...signed, documentHash: second.documentHash };
    expect((await e.callback(other, second.id, collision, sig(collision))).status).toBe('COMPLETED');

    // A stray event arriving after the package closed does not reopen it. The signer list would be
    // recomputed, nothing would be outstanding, and a declined execution would read as completed.
    const stray = { ...signed, eventId: 'late', userId: 'someone-else' };
    await expect(e.callback(ctx, first.id, stray, sig(stray))).rejects.toThrow('CLOSED');
  });
});
