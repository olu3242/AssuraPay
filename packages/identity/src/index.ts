import { createHash, randomUUID } from 'node:crypto';

export * from './assertions';
export * from './gateway';
export * from './issuance';
export * from './verification';

import type { AssuranceLevel, RequestContext, TrustPersistence } from '@assurapay/shared';
import { mintVerificationToken, verificationTokenDigest, verificationTokenMatches } from './verification';

export type IdentityStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'LOCKED' | 'DISABLED' | 'DELETED';
// `emailVerificationTokenHash` is a digest, never the token: the same treatment
// `UserSession.sessionTokenHash` gets, for the same reason. Both are cleared when the token is
// consumed, so a verification token is single-use by the absence of anything left to match.
export type UserIdentity = { id: string; tenantNeutralSubjectId: string; email: string; phone?: string; displayName: string; legalName?: string; status: IdentityStatus; primaryAuthenticationMethod: string; identityAssuranceLevel: AssuranceLevel; emailVerificationTokenHash?: string; emailVerificationExpiresAt?: string; emailVerifiedAt?: string; phoneVerifiedAt?: string; lastAuthenticatedAt?: string; createdAt: string; updatedAt: string; version: number };

/**
 * What `register` returns: the identity, plus the one and only copy of the raw verification token.
 *
 * Separated from `UserIdentity` at the type level so the token cannot be persisted by accident —
 * `store.append('identities', ...)` is given the identity, and this wrapper never reaches it.
 * `POST /v1/auth/register` decides whether the caller sees `emailVerificationToken` based on the
 * configured delivery channel; see `verification.ts`.
 */
export type RegisteredIdentity = { identity: UserIdentity; emailVerificationToken: string };
export type AuthenticationMethod = { id: string; userId: string; methodType: string; provider: string; providerSubjectReference: string; status: 'PENDING' | 'VERIFIED' | 'REVOKED'; verifiedAt?: string; lastUsedAt?: string; createdAt: string; updatedAt: string };
export type UserSession = { id: string; userId: string; workspaceId?: string; sessionTokenHash: string; authenticationMethodId: string; identityAssuranceLevel: AssuranceLevel; deviceId?: string; ipContext?: string; userAgentContext?: string; issuedAt: string; expiresAt: string; lastSeenAt: string; revokedAt?: string; revokedBy?: string; revocationReason?: string; status: 'ACTIVE' | 'REVOKED' | 'EXPIRED'; createdAt: string };
export type TrustedDevice = { id: string; userId: string; deviceFingerprintHash: string; displayName: string; deviceType: string; trustStatus: 'SEEN' | 'TRUSTED' | 'REVOKED'; firstSeenAt: string; lastSeenAt: string; trustedAt?: string; trustExpiresAt?: string; revokedAt?: string; createdAt: string; updatedAt: string };
export type StepUpChallenge = { id: string; userId: string; sessionId: string; requiredAssuranceLevel: AssuranceLevel; reason: string; challengeType: string; status: 'PENDING' | 'COMPLETED' | 'EXPIRED' | 'FAILED'; issuedAt: string; expiresAt: string; completedAt?: string; createdAt: string };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class IdentityService {
  constructor(private readonly store: TrustPersistence) {}
  async register(input: { email: string; displayName: string; correlationId: string; verificationTokenTtlMs?: number }): Promise<RegisteredIdentity> {
    const email = input.email.trim().toLowerCase(); if (!email.includes('@')) throw new Error('VALID_EMAIL_REQUIRED');
    if ((await this.store.list<UserIdentity>('identities')).some((entry) => entry.email === email && entry.status !== 'DELETED')) throw new Error('IDENTITY_EXISTS');
    const emailVerificationToken = mintVerificationToken();
    const issuedAt = new Date(); const now = issuedAt.toISOString();
    const identity: UserIdentity = { id: randomUUID(), tenantNeutralSubjectId: randomUUID(), email, displayName: input.displayName.trim(), status: 'PENDING_VERIFICATION', primaryAuthenticationMethod: 'PASSWORDLESS_EMAIL', identityAssuranceLevel: 'IAL0_UNVERIFIED', emailVerificationTokenHash: verificationTokenDigest(emailVerificationToken), emailVerificationExpiresAt: new Date(issuedAt.getTime() + (input.verificationTokenTtlMs ?? 24 * 60 * 60 * 1000)).toISOString(), createdAt: now, updatedAt: now, version: 1 };
    await this.store.append('identities', identity); await this.store.audit({ actorId: identity.id, eventType: 'IdentityRegistered', aggregateType: 'UserIdentity', aggregateId: identity.id, correlationId: input.correlationId, metadata: { method: 'PASSWORDLESS_EMAIL' } }); await this.store.emit({ aggregateType: 'UserIdentity', aggregateId: identity.id, eventType: 'IdentityRegistered', eventVersion: 1, payload: { userId: identity.id }, correlationId: input.correlationId }); return { identity, emailVerificationToken };
  }

  /**
   * Consumes a verification token and activates the identity it belongs to.
   *
   * The route behind this is what was missing entirely: registration produced
   * `PENDING_VERIFICATION`, login demanded `ACTIVE`, and nothing in the HTTP surface bridged them,
   * so no identity the platform created could ever sign in. See `verification.ts`.
   *
   * Every failure raises the same `VERIFICATION_DENIED`. Distinguishing "no such user" from "wrong
   * token" from "already verified" would let a caller enumerate which addresses are registered and
   * which registrations are still outstanding, and none of those distinctions helps the person
   * holding a real token.
   */
  async verifyEmail(input: { userId: string; token: string; correlationId: string }): Promise<UserIdentity> {
    const user = (await this.store.list<UserIdentity>('identities')).find((entry) => entry.id === input.userId);
    const denied = () => new Error('VERIFICATION_DENIED');
    if (!user || user.status !== 'PENDING_VERIFICATION' || !user.emailVerificationTokenHash) throw denied();
    if (!user.emailVerificationExpiresAt || Date.parse(user.emailVerificationExpiresAt) <= Date.now()) throw denied();
    if (!verificationTokenMatches(input.token, user.emailVerificationTokenHash)) {
      await this.store.audit({ actorId: user.id, eventType: 'IdentityVerificationFailed', aggregateType: 'UserIdentity', aggregateId: user.id, correlationId: input.correlationId, metadata: { reason: 'TOKEN_MISMATCH' } });
      throw denied();
    }
    return await this.activate(user.id, input.correlationId);
  }
  async activate(userId: string, correlationId: string) { const user = await this.requireIdentity(userId); if (user.status !== 'PENDING_VERIFICATION') throw new Error('INVALID_IDENTITY_STATE'); const now = new Date().toISOString(); // The token is cleared here rather than in `verifyEmail`, so it is spent by *any* path that
// activates — including the administrative one — and a token cannot be replayed against an
// identity that some other route already moved to ACTIVE.
const updated = { ...user, status: 'ACTIVE' as const, identityAssuranceLevel: 'IAL1_BASIC' as const, emailVerificationTokenHash: undefined, emailVerificationExpiresAt: undefined, emailVerifiedAt: now, updatedAt: now, version: user.version + 1 }; await this.store.replace('identities', updated); await this.store.audit({ actorId: userId, eventType: 'IdentityActivated', aggregateType: 'UserIdentity', aggregateId: userId, correlationId, metadata: {} }); return updated; }
  async registerAuthenticationMethod(userId: string, input: { methodType: string; provider: string; providerSubjectReference: string }) { await this.requireIdentity(userId); const now = new Date().toISOString(); const method: AuthenticationMethod = { id: randomUUID(), userId, ...input, providerSubjectReference: hash(input.providerSubjectReference), status: 'VERIFIED', verifiedAt: now, createdAt: now, updatedAt: now }; await this.store.append('authenticationMethods', method); return method; }
  async login(input: { email: string; rawSessionToken: string; authenticationMethodId?: string; deviceFingerprint?: string; ipContext?: string; userAgentContext?: string; correlationId: string }) {
    const user = (await this.store.list<UserIdentity>('identities')).find((entry) => entry.email === input.email.trim().toLowerCase()); if (!user || user.status !== 'ACTIVE') { await this.store.audit({ actorId: user?.id ?? 'anonymous', eventType: 'AuthenticationFailed', aggregateType: 'UserIdentity', aggregateId: user?.id ?? 'unknown', correlationId: input.correlationId, metadata: { reason: 'ACCOUNT_UNAVAILABLE' } }); throw new Error('AUTHENTICATION_DENIED'); }
    const method = input.authenticationMethodId ? (await this.store.list<AuthenticationMethod>('authenticationMethods')).find((entry) => entry.id === input.authenticationMethodId && entry.userId === user.id && entry.status === 'VERIFIED') : undefined; const methodId = method?.id ?? (await this.registerAuthenticationMethod(user.id, { methodType: 'PASSWORDLESS_EMAIL', provider: 'deterministic', providerSubjectReference: user.email })).id;
    let deviceId: string | undefined; if (input.deviceFingerprint) deviceId = (await this.registerDevice(user.id, input.deviceFingerprint, 'Current device', 'BROWSER')).id;
    const now = new Date(); const session: UserSession = { id: randomUUID(), userId: user.id, sessionTokenHash: hash(input.rawSessionToken), authenticationMethodId: methodId, identityAssuranceLevel: user.identityAssuranceLevel, deviceId, ipContext: input.ipContext, userAgentContext: input.userAgentContext, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(), lastSeenAt: now.toISOString(), status: 'ACTIVE', createdAt: now.toISOString() }; await this.store.append('sessions', session); await this.store.audit({ actorId: user.id, eventType: 'AuthenticationSucceeded', aggregateType: 'UserSession', aggregateId: session.id, correlationId: input.correlationId, metadata: { assurance: session.identityAssuranceLevel } }); await this.store.emit({ aggregateType: 'UserSession', aggregateId: session.id, eventType: 'SessionCreated', eventVersion: 1, payload: { userId: user.id }, correlationId: input.correlationId }); return { session, token: input.rawSessionToken };
  }
  /**
   * Records which workspace a session is working in.
   *
   * The durable half of context activation, and it was missing entirely.
   * `POST /v1/workspaces/{id}/activate-context` called `OrganizationService.activateContext`, which
   * *computes* a `RequestContext` and returns it — nothing wrote the choice down. So the route was
   * named for a state change it did not make: `GET /v1/auth/session` reported "no active workspace"
   * immediately afterwards, and the next assertion minted from that session carried no workspace
   * either, which meant a client had to re-name the workspace on every single request. The browser
   * journey found it at the last step, with activation reporting success and the session unchanged.
   *
   * Membership is *not* checked here, deliberately. Authorization is Engine 03's and the route calls
   * `activateContext` first, which refuses a workspace the caller is not an ACTIVE member of with
   * `WORKSPACE_ACCESS_DENIED`. Re-deciding it here would put a second authority on the same question
   * — the thing CLAUDE.md's trust-foundation boundary exists to prevent. What this does enforce is
   * that a session may only ever be moved by the user who owns it.
   */
  async selectWorkspace(input: { sessionId: string; userId: string; workspaceId: string }): Promise<UserSession> {
    const session = (await this.store.list<UserSession>('sessions')).find((entry) => entry.id === input.sessionId);
    if (!session || session.userId !== input.userId || session.status !== 'ACTIVE') throw new Error('SESSION_INVALID');
    const updated: UserSession = { ...session, workspaceId: input.workspaceId, lastSeenAt: new Date().toISOString() };
    await this.store.replace('sessions', updated);
    return updated;
  }

  async resolveSession(rawToken: string): Promise<UserSession> { const tokenHash = hash(rawToken); const session = (await this.store.list<UserSession>('sessions')).find((entry) => entry.sessionTokenHash === tokenHash); if (!session || session.status !== 'ACTIVE' || Date.parse(session.expiresAt) <= Date.now()) throw new Error('SESSION_INVALID'); const user = await this.requireIdentity(session.userId); if (user.status !== 'ACTIVE') throw new Error('IDENTITY_INACTIVE'); return session; }
  async revokeSession(id: string, context: RequestContext, reason: string) { const session = (await this.store.list<UserSession>('sessions')).find((entry) => entry.id === id && entry.userId === context.actorUserId); if (!session) throw new Error('SESSION_NOT_FOUND'); const updated = { ...session, status: 'REVOKED' as const, revokedAt: new Date().toISOString(), revokedBy: context.actorUserId, revocationReason: reason }; await this.store.replace('sessions', updated); await this.store.audit({ actorId: context.actorUserId, eventType: 'SessionRevoked', aggregateType: 'UserSession', aggregateId: id, correlationId: context.correlationId, metadata: { reason } }); return updated; }
  /** Revoked sequentially: each revocation writes an audit record, and the ledger's hash chain is only verifiable if links are appended one at a time. */
  async revokeAll(userId: string, context: RequestContext) { const active = (await this.store.list<UserSession>('sessions')).filter((entry) => entry.userId === userId && entry.status === 'ACTIVE'); const revoked: UserSession[] = []; for (const entry of active) revoked.push(await this.revokeSession(entry.id, context, 'LOGOUT_ALL')); return revoked; }
  async registerDevice(userId: string, fingerprint: string, displayName: string, deviceType: string) { await this.requireIdentity(userId); const now = new Date().toISOString(); const fingerprintHash = hash(fingerprint); const existing = (await this.store.list<TrustedDevice>('devices')).find((entry) => entry.userId === userId && entry.deviceFingerprintHash === fingerprintHash); if (existing) { const updated = { ...existing, lastSeenAt: now, updatedAt: now }; await this.store.replace('devices', updated); return updated; } const device: TrustedDevice = { id: randomUUID(), userId, deviceFingerprintHash: fingerprintHash, displayName, deviceType, trustStatus: 'SEEN', firstSeenAt: now, lastSeenAt: now, createdAt: now, updatedAt: now }; await this.store.append('devices', device); return device; }
  async trustDevice(id: string, context: RequestContext) { const device = (await this.store.list<TrustedDevice>('devices')).find((entry) => entry.id === id && entry.userId === context.actorUserId); if (!device) throw new Error('DEVICE_NOT_FOUND'); const now = new Date(); const updated = { ...device, trustStatus: 'TRUSTED' as const, trustedAt: now.toISOString(), trustExpiresAt: new Date(now.getTime() + 30 * 86400000).toISOString(), updatedAt: now.toISOString() }; await this.store.replace('devices', updated); return updated; }
  async requestStepUp(input: { userId: string; sessionId: string; requiredAssuranceLevel: AssuranceLevel; reason: string; challengeType: string; ttlMs?: number }) { const session = (await this.store.list<UserSession>('sessions')).find((entry) => entry.id === input.sessionId && entry.userId === input.userId && entry.status === 'ACTIVE'); if (!session) throw new Error('SESSION_INVALID'); const now = new Date(); const challenge: StepUpChallenge = { id: randomUUID(), ...input, status: 'PENDING', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + (input.ttlMs ?? 300000)).toISOString(), createdAt: now.toISOString() }; await this.store.append('stepUpChallenges', challenge); return challenge; }
  async completeStepUp(id: string, userId: string) { const challenge = (await this.store.list<StepUpChallenge>('stepUpChallenges')).find((entry) => entry.id === id && entry.userId === userId); if (!challenge) throw new Error('CHALLENGE_NOT_FOUND'); if (challenge.status !== 'PENDING' || Date.parse(challenge.expiresAt) <= Date.now()) throw new Error('CHALLENGE_EXPIRED'); const updated = { ...challenge, status: 'COMPLETED' as const, completedAt: new Date().toISOString() }; await this.store.replace('stepUpChallenges', updated); return updated; }
  private async requireIdentity(id: string) { const user = (await this.store.list<UserIdentity>('identities')).find((entry) => entry.id === id); if (!user) throw new Error('IDENTITY_NOT_FOUND'); return user; }
}
