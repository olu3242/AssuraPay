import { createHash, randomUUID } from 'node:crypto';
import type { AuditRecord, RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

/**
 * Engine 08 — Audit & Evidence Ledger.
 *
 * The catalogue declared this "Foundation only", and the foundation is real: the
 * trust store already chains every audit record with a SHA-256 hash over the
 * record and its predecessor's hash. What was missing is everything that makes a
 * hash chain worth having — nothing recomputed it, so a mutated, reordered or
 * deleted record would have gone unnoticed, and the chain was decoration.
 *
 * CLAUDE.md constraint 3 requires that history is append-only and never mutated in
 * place. A constraint nothing checks is a hope. This engine checks it:
 *
 *   - `verifyAuditChain` recomputes every hash and every link, so mutation,
 *     reordering, insertion and deletion each produce a distinct finding.
 *   - `diffAuditSnapshots` compares two points in time and reports anything that
 *     was not a pure append.
 *   - The evidence ledger records what a decision was based on, hash-addressed, so
 *     evidence cited by a certificate can be shown to be the evidence that existed
 *     when the decision was made.
 *
 * Verification is deliberately independent of the writer. It reads records back
 * and recomputes from their own contents rather than trusting a stored flag, which
 * is the only way a check of an append-only log means anything.
 */

export type AuditFindingKind =
  | 'hash-mismatch'
  | 'link-broken'
  | 'genesis-linked'
  | 'duplicate-id'
  | 'chain-empty';

export type AuditFinding = {
  kind: AuditFindingKind;
  /** Position in the chain, so a finding can be located without an id lookup. */
  index: number;
  recordId: string;
  detail: string;
};

export type AuditChainVerification = {
  valid: boolean;
  checked: number;
  findings: AuditFinding[];
  /** The hash of the last record, which is the chain's state as a single value. */
  head?: string;
};

/**
 * Recomputes the integrity hash of a record from its own contents.
 *
 * The store hashes `{...input, metadata, createdAt, previousHash}` — the record
 * minus `id` and `integrityHash`, with `previousHash` moved to the end. Key order
 * matters because the hash is over `JSON.stringify`, so the reconstruction walks
 * the record's own keys in their stored order rather than naming them, which would
 * fix an order the writer does not guarantee.
 */
export function recomputeIntegrityHash(record: AuditRecord): string {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'id' || key === 'integrityHash' || key === 'previousHash') continue;
    payload[key] = value;
  }
  payload.previousHash = record.previousHash;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Verifies an audit chain end to end.
 *
 * Every record is checked even after the first failure. Stopping at the first
 * would report one tampered record and hide the rest, and an auditor needs the
 * extent of the damage, not its first symptom.
 */
export function verifyAuditChain(records: readonly AuditRecord[]): AuditChainVerification {
  const findings: AuditFinding[] = [];

  if (records.length === 0) {
    return { valid: true, checked: 0, findings };
  }

  const seen = new Set<string>();

  records.forEach((record, index) => {
    if (seen.has(record.id)) {
      findings.push({
        kind: 'duplicate-id',
        index,
        recordId: record.id,
        detail: 'id appears more than once in the chain',
      });
    }
    seen.add(record.id);

    const expected = recomputeIntegrityHash(record);
    if (expected !== record.integrityHash) {
      findings.push({
        kind: 'hash-mismatch',
        index,
        recordId: record.id,
        // The hashes themselves are not secret, but quoting them adds nothing an
        // auditor can act on; the position and identity are what locate the record.
        detail: 'record contents do not match its stored integrity hash',
      });
    }

    if (index === 0) {
      if (record.previousHash !== undefined) {
        findings.push({
          kind: 'genesis-linked',
          index,
          recordId: record.id,
          // A first record that links backwards means the records before it are
          // gone — the most important thing a chain can tell you.
          detail: 'first record links to a predecessor that is not present',
        });
      }
      return;
    }

    const predecessor = records[index - 1];
    if (record.previousHash !== predecessor.integrityHash) {
      findings.push({
        kind: 'link-broken',
        index,
        recordId: record.id,
        detail: `does not follow ${predecessor.id}`,
      });
    }
  });

  return {
    valid: findings.length === 0,
    checked: records.length,
    findings,
    head: records.at(-1)?.integrityHash,
  };
}

export type AuditSnapshotDiffKind =
  | 'record-removed'
  | 'record-mutated'
  | 'record-reordered'
  | 'record-inserted';

export type AuditSnapshotDiff = {
  kind: AuditSnapshotDiffKind;
  index: number;
  recordId: string;
  detail: string;
};

export type AuditSnapshotComparison = {
  appendOnly: boolean;
  appended: number;
  differences: AuditSnapshotDiff[];
};

/**
 * Compares two observations of the same chain.
 *
 * A hash chain proves internal consistency, but a sufficiently thorough tamperer
 * rewrites the chain and it verifies cleanly. Comparing against an earlier
 * observation is what catches that: the prefix must be unchanged, and everything
 * new must be at the end.
 */
export function diffAuditSnapshots(
  before: readonly AuditRecord[],
  after: readonly AuditRecord[],
): AuditSnapshotComparison {
  const differences: AuditSnapshotDiff[] = [];
  const afterById = new Map(after.map((record, index) => [record.id, { record, index }]));

  before.forEach((record, index) => {
    const found = afterById.get(record.id);
    if (!found) {
      differences.push({
        kind: 'record-removed',
        index,
        recordId: record.id,
        detail: 'present in the earlier observation and absent now',
      });
      return;
    }
    if (found.index !== index) {
      differences.push({
        kind: 'record-reordered',
        index,
        recordId: record.id,
        detail: `moved from position ${index} to ${found.index}`,
      });
    }
    if (found.record.integrityHash !== record.integrityHash) {
      differences.push({
        kind: 'record-mutated',
        index,
        recordId: record.id,
        detail: 'integrity hash changed for an existing record',
      });
    }
  });

  // Anything new inside the original range is an insertion, not an append.
  after.slice(0, before.length).forEach((record, index) => {
    if (!before.some((earlier) => earlier.id === record.id)) {
      differences.push({
        kind: 'record-inserted',
        index,
        recordId: record.id,
        detail: 'new record appears before the end of the earlier chain',
      });
    }
  });

  return {
    appendOnly: differences.length === 0,
    appended: Math.max(0, after.length - before.length),
    differences,
  };
}

export type EvidenceLedgerEntry = {
  id: string;
  workspaceId: string;
  tenantId: string;
  /** What the evidence is about — a certificate, a release, a dispute. */
  subjectType: string;
  subjectId: string;
  evidenceType: string;
  /**
   * Hash of the evidence content, never the content. The ledger proves what was
   * relied on without becoming a second copy of it, which would put potentially
   * sensitive material into an append-only store that can never be redacted.
   */
  contentHash: string;
  /** Where the content itself lives, for retrieval. */
  contentLocation: string;
  recordedBy: string;
  recordedAt: string;
  /** The audit record this entry was written alongside. */
  auditRecordId: string;
};

export type RecordEvidenceInput = {
  subjectType: string;
  subjectId: string;
  evidenceType: string;
  contentHash: string;
  contentLocation: string;
  now?: () => Date;
};

export type EvidenceLedgerErrorCode =
  | 'EVIDENCE_SUBJECT_REQUIRED'
  | 'EVIDENCE_CONTENT_HASH_INVALID'
  | 'EVIDENCE_LOCATION_REQUIRED';

export class EvidenceLedgerError extends Error {
  readonly code: EvidenceLedgerErrorCode;
  readonly detail?: string;

  constructor(code: EvidenceLedgerErrorCode, detail?: string) {
    super(code);
    this.name = 'EvidenceLedgerError';
    this.code = code;
    this.detail = detail;
  }
}

/** Lowercase hex SHA-256, the only content-hash form the ledger accepts. */
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Engine 08 — the audit and evidence ledger.
 *
 * It reads the chain the store writes and never rewrites it. There is deliberately
 * no repair, redaction or compaction method: an append-only log with a fix-up
 * operation is not append-only, and the ability to correct history is exactly what
 * the constraint forbids.
 */
export class AuditLedgerEngine {
  constructor(private readonly store: TrustPersistence) {}

  /** Verifies the whole chain as stored. */
  verify(): AuditChainVerification {
    return verifyAuditChain(this.store.list<AuditRecord>('auditRecords'));
  }

  /** The current chain state as a single value, for recording elsewhere. */
  head(): string | undefined {
    return this.store.list<AuditRecord>('auditRecords').at(-1)?.integrityHash;
  }

  /** Compares the chain now against an earlier observation of it. */
  compareWith(before: readonly AuditRecord[]): AuditSnapshotComparison {
    return diffAuditSnapshots(before, this.store.list<AuditRecord>('auditRecords'));
  }

  /**
   * The audit trail for one aggregate, in order.
   *
   * Scoped to the caller's workspace: an audit trail is as sensitive as the events
   * it records, and reading another workspace's history is not something a caller
   * becomes entitled to by knowing an id.
   */
  trailFor(
    context: RequestContext,
    aggregateType: string,
    aggregateId: string,
  ): AuditRecord[] {
    requireActiveWorkspace(context);
    return this.store
      .list<AuditRecord>('auditRecords')
      .filter(
        (record) =>
          record.workspaceId === context.activeWorkspaceId &&
          record.aggregateType === aggregateType &&
          record.aggregateId === aggregateId,
      );
  }

  /**
   * Records what a decision relied on.
   *
   * The content hash is stored, never the content: the ledger proves what was
   * relied on without becoming an unredactable copy of potentially sensitive
   * material.
   */
  recordEvidence(
    context: RequestContext,
    input: RecordEvidenceInput,
  ): EvidenceLedgerEntry {
    requireActiveWorkspace(context);

    if (!input?.subjectType?.trim() || !input?.subjectId?.trim()) {
      throw new EvidenceLedgerError('EVIDENCE_SUBJECT_REQUIRED');
    }
    if (!CONTENT_HASH_PATTERN.test(input.contentHash ?? '')) {
      throw new EvidenceLedgerError(
        'EVIDENCE_CONTENT_HASH_INVALID',
        'expected lowercase hex sha256',
      );
    }
    if (!input.contentLocation?.trim()) {
      throw new EvidenceLedgerError('EVIDENCE_LOCATION_REQUIRED');
    }

    const recordedAt = (input.now ?? (() => new Date()))().toISOString();

    // The audit record is written first so the entry can name it. An entry
    // referencing an audit record that does not exist would be the one link an
    // auditor cannot follow.
    const audit = this.store.audit({
      tenantId: context.tenantId,
      workspaceId: context.activeWorkspaceId,
      actorId: context.actorUserId,
      eventType: 'EvidenceRecorded',
      aggregateType: input.subjectType,
      aggregateId: input.subjectId,
      correlationId: context.correlationId,
      metadata: {
        evidenceType: input.evidenceType,
        contentHash: input.contentHash,
        contentLocation: input.contentLocation,
      },
    });

    const entry: EvidenceLedgerEntry = {
      id: randomUUID(),
      workspaceId: context.activeWorkspaceId,
      tenantId: context.tenantId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      evidenceType: input.evidenceType,
      contentHash: input.contentHash,
      contentLocation: input.contentLocation,
      recordedBy: context.actorUserId,
      recordedAt,
      auditRecordId: audit.id,
    };
    this.store.append('evidenceLedgerEntries', entry);
    return entry;
  }

  /** Evidence recorded for one subject, scoped to the caller's workspace. */
  evidenceFor(
    context: RequestContext,
    subjectType: string,
    subjectId: string,
  ): EvidenceLedgerEntry[] {
    requireActiveWorkspace(context);
    return this.store
      .list<EvidenceLedgerEntry>('evidenceLedgerEntries')
      .filter(
        (entry) =>
          entry.workspaceId === context.activeWorkspaceId &&
          entry.subjectType === subjectType &&
          entry.subjectId === subjectId,
      );
  }

  /**
   * Confirms that a specific piece of evidence is the one that was recorded.
   *
   * Takes the hash rather than the content, so verification never requires handing
   * the material back to this engine.
   */
  evidenceMatches(
    context: RequestContext,
    subjectType: string,
    subjectId: string,
    contentHash: string,
  ): boolean {
    return this.evidenceFor(context, subjectType, subjectId).some(
      (entry) => entry.contentHash === contentHash,
    );
  }
}
