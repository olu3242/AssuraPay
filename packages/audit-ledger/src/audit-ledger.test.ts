import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { AuditRecord, RequestContext } from '@assurapay/shared';
import {
  AuditLedgerEngine,
  EvidenceLedgerError,
  diffAuditSnapshots,
  recomputeIntegrityHash,
  verifyAuditChain,
} from './index';

const WORKSPACE = 'workspace-1';
const TENANT = 'tenant-1';

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    actorUserId: 'user-1',
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId: WORKSPACE,
    tenantId: TENANT,
    memberships: [WORKSPACE],
    correlationId: 'corr-1',
    ...overrides,
  };
}

/**
 * Records are produced by the real store rather than hand-built, because the whole
 * point of verification is that it reproduces what the writer actually did. A
 * synthetic fixture would test the verifier against itself.
 */
function chainOf(count: number, store = new InMemoryTrustStore()) {
  for (let index = 0; index < count; index += 1) {
    store.audit({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      actorId: 'user-1',
      eventType: 'ThingHappened',
      aggregateType: 'Thing',
      aggregateId: `thing-${index}`,
      correlationId: 'corr-1',
      metadata: { index },
    });
  }
  return { store, records: store.list<AuditRecord>('auditRecords') };
}

const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');

describe('Engine 08 chain verification — accepts an untampered chain', () => {
  it('verifies a chain the store actually wrote', () => {
    const { records } = chainOf(5);
    const outcome = verifyAuditChain(records);

    expect(outcome.valid).toBe(true);
    expect(outcome.checked).toBe(5);
    expect(outcome.findings).toEqual([]);
    expect(outcome.head).toBe(records.at(-1)?.integrityHash);
  });

  it('recomputes the writer’s hash exactly', () => {
    // If this drifts, every other assertion here becomes vacuous: a verifier that
    // computes a different hash would report a clean chain as tampered.
    for (const record of chainOf(3).records) {
      expect(recomputeIntegrityHash(record)).toBe(record.integrityHash);
    }
  });

  it('treats an empty chain as valid rather than as an error', () => {
    expect(verifyAuditChain([])).toMatchObject({ valid: true, checked: 0, findings: [] });
  });

  it('verifies a single-record chain, whose first record links to nothing', () => {
    const { records } = chainOf(1);
    expect(verifyAuditChain(records).valid).toBe(true);
    expect(records[0].previousHash).toBeUndefined();
  });

  it('verifies records whose optional fields are absent', () => {
    const store = new InMemoryTrustStore();
    store.audit({
      actorId: 'user-1',
      eventType: 'NoWorkspace',
      aggregateType: 'Thing',
      aggregateId: 'thing-1',
      correlationId: 'corr-1',
      metadata: {},
    });
    expect(verifyAuditChain(store.list<AuditRecord>('auditRecords')).valid).toBe(true);
  });

  it('verifies records the store redacted a sensitive field from', () => {
    // The store strips password/token/secret-shaped keys before hashing, so the
    // verifier must hash the redacted metadata, not the metadata that was passed in.
    const store = new InMemoryTrustStore();
    store.audit({
      actorId: 'user-1',
      eventType: 'Sensitive',
      aggregateType: 'Thing',
      aggregateId: 'thing-1',
      correlationId: 'corr-1',
      metadata: { token: 'super-secret', reason: 'kept' },
    });

    const records = store.list<AuditRecord>('auditRecords');
    expect(records[0].metadata).toEqual({ reason: 'kept' });
    expect(verifyAuditChain(records).valid).toBe(true);
  });
});

describe('Engine 08 chain verification — detects tampering', () => {
  it('detects a mutated record', () => {
    const { records } = chainOf(4);
    records[2] = { ...records[2], eventType: 'SomethingElse' };

    const outcome = verifyAuditChain(records);
    expect(outcome.valid).toBe(false);
    expect(outcome.findings.map((finding) => finding.kind)).toContain('hash-mismatch');
    expect(outcome.findings[0].index).toBe(2);
  });

  it('detects mutated metadata, not only mutated headers', () => {
    const { records } = chainOf(3);
    records[1] = { ...records[1], metadata: { index: 99 } };
    expect(verifyAuditChain(records).valid).toBe(false);
  });

  it('detects a removed record through the broken link', () => {
    const { records } = chainOf(5);
    const truncated = [...records.slice(0, 2), ...records.slice(3)];

    const outcome = verifyAuditChain(truncated);
    expect(outcome.valid).toBe(false);
    expect(outcome.findings.map((finding) => finding.kind)).toContain('link-broken');
  });

  it('detects a removed first record, which no link would otherwise reveal', () => {
    // Dropping the head leaves a chain that is internally consistent from its new
    // start; the only evidence is that the new first record points backwards.
    const { records } = chainOf(4);
    const outcome = verifyAuditChain(records.slice(1));

    expect(outcome.valid).toBe(false);
    expect(outcome.findings.map((finding) => finding.kind)).toContain('genesis-linked');
  });

  it('detects reordering', () => {
    const { records } = chainOf(4);
    const swapped = [records[0], records[2], records[1], records[3]];
    expect(verifyAuditChain(swapped).valid).toBe(false);
  });

  it('detects an inserted record even when its own hash is self-consistent', () => {
    const { records } = chainOf(3);
    const forged = { ...records[1], id: 'forged', aggregateId: 'thing-forged' };
    const withHash = { ...forged, integrityHash: recomputeIntegrityHash(forged) };

    const outcome = verifyAuditChain([records[0], withHash, records[1], records[2]]);
    // The forgery hashes correctly, so it is the link from the record after it
    // that gives it away.
    expect(outcome.valid).toBe(false);
    expect(outcome.findings.map((finding) => finding.kind)).toContain('link-broken');
  });

  it('detects a duplicated record', () => {
    const { records } = chainOf(3);
    const outcome = verifyAuditChain([records[0], records[1], records[1], records[2]]);
    expect(outcome.findings.map((finding) => finding.kind)).toContain('duplicate-id');
  });

  it('reports every damaged record, not only the first', () => {
    // An auditor needs the extent of the damage; stopping at the first finding
    // would report one tampered record and hide the rest.
    const { records } = chainOf(6);
    records[1] = { ...records[1], eventType: 'A' };
    records[4] = { ...records[4], eventType: 'B' };

    const mismatches = verifyAuditChain(records).findings.filter(
      (finding) => finding.kind === 'hash-mismatch',
    );
    expect(mismatches.map((finding) => finding.index)).toEqual([1, 4]);
  });

  it('locates each finding by position and record id', () => {
    const { records } = chainOf(3);
    records[1] = { ...records[1], actorId: 'someone-else' };

    const finding = verifyAuditChain(records).findings[0];
    expect(finding.index).toBe(1);
    expect(finding.recordId).toBe(records[1].id);
    expect(finding.detail.length).toBeGreaterThan(0);
  });
});

describe('Engine 08 snapshot comparison — catches a rewritten chain', () => {
  it('accepts pure appends', () => {
    const { store, records } = chainOf(3);
    const engine = new AuditLedgerEngine(store);
    chainOf(2, store);

    const comparison = engine.compareWith(records);
    expect(comparison.appendOnly).toBe(true);
    expect(comparison.appended).toBe(2);
  });

  it('accepts an unchanged chain', () => {
    const { store, records } = chainOf(3);
    expect(new AuditLedgerEngine(store).compareWith(records)).toMatchObject({
      appendOnly: true,
      appended: 0,
    });
  });

  it('catches a wholesale rewrite that verifies cleanly on its own', () => {
    // This is the attack a hash chain alone cannot detect: rebuild the chain from
    // scratch and every hash agrees. Only an earlier observation reveals it.
    const { records: original } = chainOf(3);
    const { store: rebuilt } = chainOf(3);

    expect(verifyAuditChain(rebuilt.list<AuditRecord>('auditRecords')).valid).toBe(true);
    const comparison = new AuditLedgerEngine(rebuilt).compareWith(original);
    expect(comparison.appendOnly).toBe(false);
    expect(comparison.differences.map((difference) => difference.kind)).toContain(
      'record-removed',
    );
  });

  it('reports a removed record', () => {
    const { records } = chainOf(4);
    const comparison = diffAuditSnapshots(records, records.slice(0, 3));
    expect(comparison.differences.map((difference) => difference.kind)).toEqual([
      'record-removed',
    ]);
  });

  it('reports reordering and mutation separately', () => {
    const { records } = chainOf(3);
    const reordered = [records[1], records[0], records[2]];
    expect(
      diffAuditSnapshots(records, reordered).differences.map((difference) => difference.kind),
    ).toContain('record-reordered');

    const mutated = [...records];
    mutated[1] = { ...mutated[1], integrityHash: hashOf('different') };
    expect(
      diffAuditSnapshots(records, mutated).differences.map((difference) => difference.kind),
    ).toContain('record-mutated');
  });

  it('reports an insertion into the middle as an insertion, not an append', () => {
    const { records } = chainOf(3);
    const injected = [records[0], { ...records[0], id: 'injected' }, records[1], records[2]];

    const comparison = diffAuditSnapshots(records, injected);
    expect(comparison.appendOnly).toBe(false);
    expect(comparison.differences.map((difference) => difference.kind)).toContain(
      'record-inserted',
    );
  });
});

describe('Engine 08 evidence ledger', () => {
  const CONTENT = hashOf('the evidence');

  function record(store = new InMemoryTrustStore()) {
    const engine = new AuditLedgerEngine(store);
    const entry = engine.recordEvidence(context(), {
      subjectType: 'CompletionCertificate',
      subjectId: 'cert-1',
      evidenceType: 'INSPECTION_REPORT',
      contentHash: CONTENT,
      contentLocation: 's3://evidence/cert-1',
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });
    return { store, engine, entry };
  }

  it('records the hash and the location, never the content', () => {
    const { entry } = record();
    expect(entry.contentHash).toBe(CONTENT);
    expect(entry.contentLocation).toBe('s3://evidence/cert-1');
    expect(Object.keys(entry)).not.toContain('content');
  });

  it('links the entry to an audit record that exists', () => {
    // An entry naming an audit record that is absent would be the one link an
    // auditor cannot follow.
    const { store, entry } = record();
    const audit = store
      .list<AuditRecord>('auditRecords')
      .find((candidate) => candidate.id === entry.auditRecordId);

    expect(audit).toBeDefined();
    expect(audit?.eventType).toBe('EvidenceRecorded');
    expect(audit?.aggregateId).toBe('cert-1');
  });

  it('leaves the chain verifiable after writing', () => {
    const { store, engine } = record();
    engine.recordEvidence(context(), {
      subjectType: 'CompletionCertificate',
      subjectId: 'cert-1',
      evidenceType: 'PHOTO',
      contentHash: hashOf('second'),
      contentLocation: 's3://evidence/cert-1/photo',
    });
    expect(new AuditLedgerEngine(store).verify().valid).toBe(true);
  });

  it('confirms that a given hash is the evidence that was recorded', () => {
    const { engine } = record();
    expect(
      engine.evidenceMatches(context(), 'CompletionCertificate', 'cert-1', CONTENT),
    ).toBe(true);
    expect(
      engine.evidenceMatches(context(), 'CompletionCertificate', 'cert-1', hashOf('other')),
    ).toBe(false);
  });

  it('rejects a content hash that is not a lowercase hex sha256', () => {
    const engine = new AuditLedgerEngine(new InMemoryTrustStore());
    for (const bad of ['', 'not-a-hash', CONTENT.toUpperCase(), CONTENT.slice(0, 63)]) {
      expect(() =>
        engine.recordEvidence(context(), {
          subjectType: 'Thing',
          subjectId: 'thing-1',
          evidenceType: 'X',
          contentHash: bad,
          contentLocation: 'somewhere',
        }),
      ).toThrow('EVIDENCE_CONTENT_HASH_INVALID');
    }
  });

  it('rejects a missing subject or location, and writes nothing', () => {
    const store = new InMemoryTrustStore();
    const engine = new AuditLedgerEngine(store);

    expect(() =>
      engine.recordEvidence(context(), {
        subjectType: '',
        subjectId: 'thing-1',
        evidenceType: 'X',
        contentHash: CONTENT,
        contentLocation: 'somewhere',
      }),
    ).toThrow(EvidenceLedgerError);
    expect(() =>
      engine.recordEvidence(context(), {
        subjectType: 'Thing',
        subjectId: 'thing-1',
        evidenceType: 'X',
        contentHash: CONTENT,
        contentLocation: '  ',
      }),
    ).toThrow('EVIDENCE_LOCATION_REQUIRED');

    expect(store.list('evidenceLedgerEntries')).toEqual([]);
    expect(store.list('auditRecords')).toEqual([]);
  });

  it('requires an active workspace', () => {
    const engine = new AuditLedgerEngine(new InMemoryTrustStore());
    expect(() =>
      engine.recordEvidence(context({ memberships: [] }), {
        subjectType: 'Thing',
        subjectId: 'thing-1',
        evidenceType: 'X',
        contentHash: CONTENT,
        contentLocation: 'somewhere',
      }),
    ).toThrow('ACTIVE_WORKSPACE_REQUIRED');
  });
});

describe('Engine 08 reads are workspace-scoped', () => {
  it('does not return another workspace’s evidence or trail', () => {
    // An audit trail is as sensitive as the events it records; knowing an id must
    // not be enough to read another workspace's history.
    const store = new InMemoryTrustStore();
    const engine = new AuditLedgerEngine(store);
    engine.recordEvidence(context(), {
      subjectType: 'Thing',
      subjectId: 'thing-1',
      evidenceType: 'X',
      contentHash: hashOf('a'),
      contentLocation: 'somewhere',
    });

    const other = context({ activeWorkspaceId: 'workspace-9', memberships: ['workspace-9'] });
    expect(engine.evidenceFor(other, 'Thing', 'thing-1')).toEqual([]);
    expect(engine.trailFor(other, 'Thing', 'thing-1')).toEqual([]);
  });

  it('returns the trail for an aggregate in order', () => {
    const store = new InMemoryTrustStore();
    const engine = new AuditLedgerEngine(store);
    for (const evidenceType of ['FIRST', 'SECOND']) {
      engine.recordEvidence(context(), {
        subjectType: 'Thing',
        subjectId: 'thing-1',
        evidenceType,
        contentHash: hashOf(evidenceType),
        contentLocation: 'somewhere',
      });
    }

    const trail = engine.trailFor(context(), 'Thing', 'thing-1');
    expect(trail).toHaveLength(2);
    expect(trail[0].metadata.evidenceType).toBe('FIRST');
  });
});

describe('Engine 08 offers no way to rewrite history', () => {
  it('exposes no repair, redaction or compaction method', () => {
    // An append-only log with a fix-up operation is not append-only, and the
    // ability to correct history is exactly what CLAUDE.md constraint 3 forbids.
    const surface = [
      ...Object.getOwnPropertyNames(AuditLedgerEngine.prototype),
      ...Object.keys(new AuditLedgerEngine(new InMemoryTrustStore())),
    ];

    for (const forbidden of ['repair', 'redact', 'compact', 'rewrite', 'delete', 'prune']) {
      expect(surface.some((name) => name.toLowerCase().includes(forbidden))).toBe(false);
    }
  });

  it('reports the head without offering a way to set it', () => {
    const { store } = chainOf(2);
    const engine = new AuditLedgerEngine(store);
    expect(engine.head()).toBe(store.list<AuditRecord>('auditRecords').at(-1)?.integrityHash);
    expect(Object.getOwnPropertyNames(AuditLedgerEngine.prototype)).not.toContain('setHead');
  });
});
