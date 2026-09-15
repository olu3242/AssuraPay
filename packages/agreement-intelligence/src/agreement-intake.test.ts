import { describe, expect, it } from 'vitest';
import { AgreementIntakeEngine } from './agreement-intake';

function memoryPersistence() {
  const data = new Map<string, any[]>();
  return {
    async list<T>(key: string) { return (data.get(key) ?? []) as T[]; },
    async append(key: string, value: any) { data.set(key, [...(data.get(key) ?? []), value]); },
    async replace(key: string, value: any) {
      data.set(key, (data.get(key) ?? []).map((item) => item.id === value.id ? value : item));
    },
    async audit() {}, async emit() {},
  } as any;
}

const context = {
  tenantId: 'tenant-1', activeWorkspaceId: 'workspace-1', actorUserId: 'user-1', correlationId: 'corr-1',
} as any;
const completeTerms = [
  ['title', 'Website delivery'], ['parties', ['Buyer', 'Seller']], ['scope', 'Build website'],
  ['currency', 'USD'], ['value', 5000], ['paymentTerms', 'On verified milestone completion'],
].map(([key, value]) => ({ key: key as string, value, confidence: 0.95, sourceReferences: [] }));

describe('AgreementIntakeEngine', () => {
  it.each(['DIRECT_DESCRIPTION', 'INFORMAL_ARTIFACT', 'FORMAL_DOCUMENT'] as const)(
    'converges %s into the canonical ready state', async (sourceType) => {
      const engine = new AgreementIntakeEngine(memoryPersistence());
      const terms = completeTerms.map((term) => ({
        ...term,
        sourceReferences: sourceType === 'DIRECT_DESCRIPTION' ? [] : [{ artifactId: 'artifact-1', section: 'Terms' }],
      }));
      const intake = await engine.ingest(context, { sourceType, rawSource: 'source content', proposedTerms: terms });
      expect(intake.status).toBe('READY_FOR_REVIEW');
      expect(intake.clarityScore).toBe(100);
    },
  );

  it('requires clarification rather than inventing missing commercial terms', async () => {
    const engine = new AgreementIntakeEngine(memoryPersistence());
    const intake = await engine.ingest(context, {
      sourceType: 'DIRECT_DESCRIPTION', rawSource: 'Build a website for me', proposedTerms: completeTerms.slice(0, 3),
    });
    expect(intake.status).toBe('NEEDS_CLARIFICATION');
    expect(intake.clarifications.map((x) => x.key)).toEqual(['currency', 'value', 'paymentTerms']);
  });

  it('requires source references for artifact-derived terms', async () => {
    const engine = new AgreementIntakeEngine(memoryPersistence());
    await expect(engine.ingest(context, {
      sourceType: 'FORMAL_DOCUMENT', rawSource: 'contract', proposedTerms: completeTerms,
    })).rejects.toThrow('SOURCE_REFERENCE_REQUIRED');
  });

  it('does not convert until required clarifications are resolved', async () => {
    const persistence = memoryPersistence();
    const engine = new AgreementIntakeEngine(persistence);
    const intake = await engine.ingest(context, {
      sourceType: 'DIRECT_DESCRIPTION', rawSource: 'Build a website', proposedTerms: completeTerms.slice(0, 5),
    });
    await expect(engine.markConverted(context, intake.id, 'agreement-1')).rejects.toThrow('INTAKE_NOT_READY');
    const resolved = await engine.resolveClarification(context, intake.id, intake.clarifications[0].id, 'Net 15 after verification');
    expect(resolved.status).toBe('READY_FOR_REVIEW');
    expect((await engine.markConverted(context, intake.id, 'agreement-1')).convertedAgreementId).toBe('agreement-1');
  });
});
