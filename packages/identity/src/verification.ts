/**
 * Engine 01 — email verification, and the channel that carries it.
 *
 * ## The defect this closes
 *
 * `IdentityService.register` creates an identity with status `PENDING_VERIFICATION`.
 * `IdentityService.login` refuses anything whose status is not `ACTIVE`. The only transition
 * between the two is `IdentityService.activate`, and **no HTTP route reached it** — the web
 * application exposed `register`, `login`, `logout` and `session`, and nothing else under
 * `/v1/auth`. Every identity the platform could create was therefore permanently unable to sign
 * in, and the browser certification found it the only way it could be found: by registering
 * through the real UI and being refused at the next click with `AUTHENTICATION_DENIED`.
 *
 * The engine method existed the whole time. What was missing was a way for a user to prove the
 * email is theirs, which is the thing activation is supposed to be evidence of.
 *
 * ## Why a token, when login has no proof of possession at all
 *
 * `POST /v1/auth/login` takes `{ email }` and returns a session. It is passwordless in the literal
 * sense: possession of the address is never proven, because Engine 02's identity-provider
 * integration is not built. So one could argue activation needs no proof either.
 *
 * That argument is wrong in the direction that matters. Exposing `activate(userId)` as a route
 * would let anyone move *another* person's dormant, unverified registration into a state where it
 * can be signed into — turning a record nobody can use into a live account, on behalf of someone
 * who never completed anything. Adding a single-use token costs little and refuses that, and it
 * leaves the verification step correct for when the login path is eventually given real proof of
 * possession rather than requiring it to be revisited then.
 *
 * The token is stored as a SHA-256 digest and compared in constant time, which is the same
 * treatment `UserSession.sessionTokenHash` already gets in this engine — the raw value is returned
 * once and never persisted.
 *
 * ## The delivery channel is configured, and there is no default
 *
 * A verification token has to reach the person who registered. Engine 09, Notification &
 * Communication, is the engine that would carry it, and `docs/ENGINE_CATALOG.md` marks it
 * **Deferred** — the platform has no email transport of any kind.
 *
 * So the channel is stated by the deployment rather than assumed, in the same shape
 * `ASSURAPAY_DATABASE_SSL` is stated: there is no default and an unset value refuses to start.
 * A deployment that names `DIRECT_RETURN` is declaring that it has no delivery channel and that
 * `POST /v1/auth/register` may therefore hand the token straight back to its caller. That is a
 * property of the deployment, uniform for every caller of that deployment — not a branch keyed on
 * a test, which §19 of the RC1 brief forbids and which would certify a path production never runs.
 * The business rule is identical either way: a token is required, it is single-use, it expires,
 * and it is what makes an identity `ACTIVE`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type IdentityVerificationChannel = 'DIRECT_RETURN' | 'NOTIFICATION_ENGINE';

export type IdentityVerificationConfig = {
  channel: IdentityVerificationChannel;
  /** How long a freshly minted verification token stays usable. */
  tokenTtlMs: number;
};

export class IdentityVerificationConfigError extends Error {
  constructor(
    readonly code: 'VERIFICATION_CHANNEL_UNSET' | 'VERIFICATION_CHANNEL_UNKNOWN' | 'VERIFICATION_CHANNEL_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'IdentityVerificationConfigError';
  }
}

/** Twenty-four hours, matching the horizon a person plausibly acts on a registration within. */
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Reads the verification channel from the environment. No default, deliberately.
 *
 * An unset value is refused rather than assumed, because both possible assumptions are bad: taking
 * `DIRECT_RETURN` silently would make an unconfigured production deployment return verification
 * tokens over its API, and taking `NOTIFICATION_ENGINE` silently would make registration fail at
 * runtime on a deployment that had no way to know it needed something that does not exist yet.
 */
export function loadIdentityVerificationConfig(
  env: Record<string, string | undefined>,
): IdentityVerificationConfig {
  const channel = env.ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL?.trim();

  if (!channel)
    throw new IdentityVerificationConfigError(
      'VERIFICATION_CHANNEL_UNSET',
      'set ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL. A registered identity is PENDING_VERIFICATION ' +
        'and cannot sign in until a verification token reaches its owner, so a deployment has to ' +
        'state how that token travels. Engine 09 (Notification & Communication) is the engine that ' +
        'would carry it and is deferred, so the only channel currently implemented is ' +
        'DIRECT_RETURN, in which POST /v1/auth/register returns the token to its caller.',
    );

  if (channel === 'NOTIFICATION_ENGINE')
    throw new IdentityVerificationConfigError(
      'VERIFICATION_CHANNEL_UNAVAILABLE',
      'ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL=NOTIFICATION_ENGINE requires Engine 09 ' +
        '(Notification & Communication), which docs/ENGINE_CATALOG.md marks Deferred. This value is ' +
        'accepted by the type and refused at load so that the deployment which eventually needs it ' +
        'fails loudly here rather than silently sending nothing.',
    );

  if (channel !== 'DIRECT_RETURN')
    throw new IdentityVerificationConfigError(
      'VERIFICATION_CHANNEL_UNKNOWN',
      `ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL=${channel} is not a channel. Use DIRECT_RETURN.`,
    );

  const ttl = env.ASSURAPAY_IDENTITY_VERIFICATION_TTL_MS
    ? Number(env.ASSURAPAY_IDENTITY_VERIFICATION_TTL_MS)
    : DEFAULT_TOKEN_TTL_MS;

  return { channel, tokenTtlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TOKEN_TTL_MS };
}

/** A verification token: 32 random bytes, hex-encoded. */
export function mintVerificationToken(): string {
  return randomBytes(32).toString('hex');
}

export function verificationTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of a presented token against a stored digest.
 *
 * `timingSafeEqual` throws on length mismatch, so the digests are compared rather than the raw
 * values — a digest is always 64 hex characters, which makes the lengths equal by construction and
 * keeps the comparison from leaking through an exception rather than through timing.
 */
export function verificationTokenMatches(presented: string, storedDigest: string): boolean {
  const candidate = Buffer.from(verificationTokenDigest(presented), 'hex');
  const stored = Buffer.from(storedDigest, 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
