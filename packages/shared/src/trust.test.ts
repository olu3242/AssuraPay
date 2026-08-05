import { describe, expect, it } from 'vitest';
import type { RequestContext, TrustPersistence } from './trust';
import { maskValue, requireActiveWorkspace, requireAuthenticatedIdentity } from './trust';

/**
 * The shared trust boundary, tested where it is declared.
 *
 * `packages/shared` holds the guards every engine's authorization rests on and the
 * masking every sensitive field passes through, and had no tests of its own — the
 * behaviour was covered incidentally, through whichever engine happened to call it.
 * These assert the properties directly, so a change here fails in the package that
 * owns it rather than somewhere downstream.
 */

const identity = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  actorUserId: 'user-1',
  sessionId: 'session-1',
  identityAssuranceLevel: 'IAL2_VERIFIED',
  memberships: [],
  correlationId: 'corr-1',
  ...overrides,
});

describe('requireAuthenticatedIdentity', () => {
  it('accepts a context carrying both an actor and a session', () => {
    expect(() => requireAuthenticatedIdentity(identity())).not.toThrow();
  });

  it('refuses an absent context rather than treating it as anonymous-but-allowed', () => {
    expect(() => requireAuthenticatedIdentity(undefined)).toThrow('UNAUTHENTICATED');
  });

  it('refuses a context missing either half of the proof', () => {
    // An actor without a session is an assertion about identity with nothing behind
    // it; a session without an actor cannot be attributed in the audit trail.
    expect(() => requireAuthenticatedIdentity(identity({ actorUserId: '' }))).toThrow(
      'UNAUTHENTICATED',
    );
    expect(() => requireAuthenticatedIdentity(identity({ sessionId: '' }))).toThrow(
      'UNAUTHENTICATED',
    );
  });
});

describe('requireActiveWorkspace', () => {
  const scoped = identity({
    activeWorkspaceId: 'workspace-1',
    tenantId: 'tenant-1',
    memberships: ['workspace-1'],
  });

  it('accepts a workspace the caller is a member of', () => {
    expect(() => requireActiveWorkspace(scoped)).not.toThrow();
  });

  it('refuses a workspace the caller is not a member of', () => {
    // The central tenancy rule: workspace context requires active membership, so a
    // claimed activeWorkspaceId is not sufficient on its own.
    expect(() =>
      requireActiveWorkspace({ ...scoped, memberships: ['workspace-2'] }),
    ).toThrow('ACTIVE_WORKSPACE_REQUIRED');
  });

  it('refuses a workspace without a tenant, so a record cannot be written untenanted', () => {
    expect(() => requireActiveWorkspace({ ...scoped, tenantId: undefined })).toThrow(
      'ACTIVE_WORKSPACE_REQUIRED',
    );
  });

  it('refuses an unauthenticated caller before it looks at membership', () => {
    expect(() =>
      requireActiveWorkspace({ ...scoped, actorUserId: '' }),
    ).toThrow('UNAUTHENTICATED');
  });
});

describe('maskValue', () => {
  it('leaves a value untouched only when masking is explicitly off', () => {
    expect(maskValue('0123456789', 'NONE')).toBe('0123456789');
  });

  it('reveals the last four of a longer value', () => {
    expect(maskValue('0123456789', 'LAST_FOUR')).toBe('****6789');
  });

  it('reveals the ends of a longer value under partial masking', () => {
    expect(maskValue('0123456789', 'PARTIAL')).toBe('01***89');
  });

  it('replaces the value entirely under full and tokenized masking', () => {
    expect(maskValue('0123456789', 'FULL')).toBe('[REDACTED]');
    expect(maskValue('0123456789', 'TOKENIZED')).toBe('[TOKENIZED]');
  });

  it('never returns the whole input from a mode meant to hide part of it', () => {
    // A partial mode reveals a fixed number of characters, so a short value is fully
    // exposed by it: LAST_FOUR of a four-digit reference is the reference, and
    // PARTIAL reveals first-two and last-two, which covers everything up to four.
    // Beneficiary account identifiers go through LAST_FOUR, so this is a live path.
    for (const value of ['1', '12', '123', '1234'])
      for (const mode of ['LAST_FOUR', 'PARTIAL'] as const) {
        const masked = maskValue(value, mode);
        expect(masked, `${mode} of ${value}`).toBe('[REDACTED]');
        expect(masked.includes(value), `${mode} of ${value}`).toBe(false);
      }
  });

  it('masks by length, not by what the value looks like', () => {
    // Five characters is the shortest input where LAST_FOUR withholds anything.
    expect(maskValue('12345', 'LAST_FOUR')).toBe('****2345');
  });
});

describe('the persistence contract', () => {
  it('is asynchronous in every method, so a caller cannot forget to await and still compile', async () => {
    // Type-level assertion: this store satisfies TrustPersistence only because every
    // method returns a promise. A synchronous method, or a `T | Promise<T>` union
    // permitting one, would make the annotation below fail — which is the point of
    // having no compatibility layer.
    const store: TrustPersistence = {
      async list<T>() {
        return [] as T[];
      },
      async append() {},
      async replace() {},
      async audit(input) {
        return {
          ...input,
          id: 'audit-1',
          createdAt: new Date(0).toISOString(),
          integrityHash: 'hash',
        };
      },
      async emit(input) {
        return { ...input, id: 'event-1', occurredAt: new Date(0).toISOString() };
      },
      async transaction(operation) {
        return operation(store);
      },
    };

    expect(await store.transaction(async (tx) => (await tx.list('things')).length)).toBe(0);
  });
});
