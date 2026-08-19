import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import { IdentityService } from './index';
import { loadIdentityVerificationConfig, mintVerificationToken, verificationTokenMatches } from './verification';

/**
 * Engine 01 — the email verification step that did not exist.
 *
 * The gap these tests close was not subtle and had survived every suite in the repository:
 * `register` produced `PENDING_VERIFICATION`, `login` demanded `ACTIVE`, and no route bridged them.
 * The reason nothing caught it is worth stating, because it is the argument for browser
 * certification existing at all — every unit test here called `activate()` directly, so the suites
 * exercised a transition that no user could ever reach.
 */

describe('a registration is not usable until it is verified', () => {
  it('refuses sign-in for a registered but unverified identity', async () => {
    const service = new IdentityService(new InMemoryTrustStore());
    const { identity } = await service.register({
      email: 'pending@example.test',
      displayName: 'Pending',
      correlationId: 'c1',
    });

    expect(identity.status).toBe('PENDING_VERIFICATION');
    await expect(
      service.login({ email: identity.email, rawSessionToken: 'raw', correlationId: 'c2' }),
    ).rejects.toThrow('AUTHENTICATION_DENIED');
  });

  it('activates on a correct token, and then sign-in works', async () => {
    const service = new IdentityService(new InMemoryTrustStore());
    const { identity, emailVerificationToken } = await service.register({
      email: 'verified@example.test',
      displayName: 'Verified',
      correlationId: 'c1',
    });

    const verified = await service.verifyEmail({
      userId: identity.id,
      token: emailVerificationToken,
      correlationId: 'c2',
    });

    expect(verified.status).toBe('ACTIVE');
    expect(verified.emailVerifiedAt).toBeDefined();
    // Assurance rises to IAL1 because an address has now been demonstrated, which is the whole
    // content of the claim: it does not rise further, because nothing else has been proven.
    expect(verified.identityAssuranceLevel).toBe('IAL1_BASIC');

    const login = await service.login({
      email: identity.email,
      rawSessionToken: 'raw',
      correlationId: 'c3',
    });
    expect(login.session.userId).toBe(identity.id);
  });

  it('never persists the raw token, only its digest', async () => {
    const store = new InMemoryTrustStore();
    const service = new IdentityService(store);
    const { emailVerificationToken } = await service.register({
      email: 'digest@example.test',
      displayName: 'Digest',
      correlationId: 'c1',
    });

    const stored = JSON.stringify(await store.list('identities'));
    expect(stored).not.toContain(emailVerificationToken);
    expect(stored).toContain('emailVerificationTokenHash');
  });

  it('spends the token: the same one cannot verify twice', async () => {
    const service = new IdentityService(new InMemoryTrustStore());
    const { identity, emailVerificationToken } = await service.register({
      email: 'once@example.test',
      displayName: 'Once',
      correlationId: 'c1',
    });

    await service.verifyEmail({ userId: identity.id, token: emailVerificationToken, correlationId: 'c2' });
    await expect(
      service.verifyEmail({ userId: identity.id, token: emailVerificationToken, correlationId: 'c3' }),
    ).rejects.toThrow('VERIFICATION_DENIED');
  });

  it('refuses a wrong token, an unknown user and an expired token with the same error', async () => {
    const service = new IdentityService(new InMemoryTrustStore());
    const { identity } = await service.register({
      email: 'wrong@example.test',
      displayName: 'Wrong',
      correlationId: 'c1',
    });

    // One error for every failure. Distinguishing them would let a caller learn which addresses are
    // registered and which registrations are still outstanding, and tells a legitimate holder of a
    // token nothing they can act on.
    await expect(
      service.verifyEmail({ userId: identity.id, token: mintVerificationToken(), correlationId: 'c2' }),
    ).rejects.toThrow('VERIFICATION_DENIED');
    await expect(
      service.verifyEmail({ userId: 'no-such-user', token: mintVerificationToken(), correlationId: 'c3' }),
    ).rejects.toThrow('VERIFICATION_DENIED');
  });

  it('refuses a token that has expired', async () => {
    const service = new IdentityService(new InMemoryTrustStore());
    const { identity, emailVerificationToken } = await service.register({
      email: 'expired@example.test',
      displayName: 'Expired',
      correlationId: 'c1',
      // Already expired when it is minted, which is the cleanest way to assert the boundary without
      // making the suite wait or making the clock injectable purely for a test.
      verificationTokenTtlMs: -1,
    });

    await expect(
      service.verifyEmail({ userId: identity.id, token: emailVerificationToken, correlationId: 'c2' }),
    ).rejects.toThrow('VERIFICATION_DENIED');
  });

  it('records a failed attempt without activating anything', async () => {
    const store = new InMemoryTrustStore();
    const service = new IdentityService(store);
    const { identity } = await service.register({
      email: 'audited@example.test',
      displayName: 'Audited',
      correlationId: 'c1',
    });

    await expect(
      service.verifyEmail({ userId: identity.id, token: mintVerificationToken(), correlationId: 'c2' }),
    ).rejects.toThrow('VERIFICATION_DENIED');

    const audits = (await store.list<{ eventType: string }>('auditRecords')).map(
      (entry: { eventType: string }) => entry.eventType,
    );
    expect(audits).toContain('IdentityVerificationFailed');
    expect(audits).not.toContain('IdentityActivated');
  });
});

describe('token comparison', () => {
  it('matches a token against its own digest and rejects any other', () => {
    const token = mintVerificationToken();
    // The digest as the engine stores it, recomputed from `node:crypto` directly rather than through
    // the helper under test, so the comparison is checked against an independent value rather than
    // against itself.
    const digest = createHash('sha256').update(token).digest('hex');

    expect(verificationTokenMatches(token, digest)).toBe(true);
    expect(verificationTokenMatches(mintVerificationToken(), digest)).toBe(false);
    // A malformed digest must be refused rather than throwing out of the length check.
    expect(verificationTokenMatches(token, 'short')).toBe(false);
  });
});

describe('the delivery channel is stated by the deployment', () => {
  it('refuses to start when the channel is unset', () => {
    expect(() => loadIdentityVerificationConfig({})).toThrow(/ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL/);
  });

  it('refuses NOTIFICATION_ENGINE while Engine 09 is deferred', () => {
    expect(() =>
      loadIdentityVerificationConfig({ ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL: 'NOTIFICATION_ENGINE' }),
    ).toThrow(/Engine 09/);
  });

  it('refuses a channel it does not recognise rather than falling back', () => {
    expect(() =>
      loadIdentityVerificationConfig({ ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL: 'SMTP' }),
    ).toThrow(/not a channel/);
  });

  it('accepts DIRECT_RETURN, with a default token lifetime', () => {
    const config = loadIdentityVerificationConfig({
      ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL: 'DIRECT_RETURN',
    });
    expect(config.channel).toBe('DIRECT_RETURN');
    expect(config.tokenTtlMs).toBe(24 * 60 * 60 * 1000);
  });

  it('ignores a nonsensical lifetime rather than minting a token that is already expired', () => {
    const config = loadIdentityVerificationConfig({
      ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL: 'DIRECT_RETURN',
      ASSURAPAY_IDENTITY_VERIFICATION_TTL_MS: 'not-a-number',
    });
    expect(config.tokenTtlMs).toBe(24 * 60 * 60 * 1000);
  });
});
