/** Single-use email verification with explicit production email delivery. */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type IdentityVerificationChannel =
  'DIRECT_RETURN' | 'NOTIFICATION_ENGINE' | 'EMAIL';

export type IdentityVerificationConfig = {
  channel: IdentityVerificationChannel;
  /** How long a freshly minted verification token stays usable. */
  tokenTtlMs: number;
};

export class IdentityVerificationConfigError extends Error {
  constructor(
    readonly code:
      | 'VERIFICATION_CHANNEL_UNSET'
      | 'VERIFICATION_CHANNEL_UNKNOWN'
      | 'VERIFICATION_CHANNEL_UNAVAILABLE'
      | 'VERIFICATION_DIRECT_RETURN_FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'IdentityVerificationConfigError';
  }
}

/** Verification codes expire after ten minutes by default. */
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;

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
  if (
    channel === 'DIRECT_RETURN' &&
    (env.NODE_ENV === 'production' ||
      env.VERCEL === '1' ||
      !['development', 'test'].includes(
        env.ASSURAPAY_DEPLOYMENT ?? env.NODE_ENV ?? '',
      ) ||
      env.ASSURAPAY_ALLOW_DIRECT_RETURN !== 'true')
  ) {
    throw new IdentityVerificationConfigError(
      'VERIFICATION_DIRECT_RETURN_FORBIDDEN',
      'DIRECT_RETURN requires explicit local development/test configuration and is forbidden on production hosts',
    );
  }

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

  if (channel === 'EMAIL') {
    if (
      env.NOTIFICATION_PROVIDER !== 'RESEND' ||
      !env.RESEND_API_KEY?.trim() ||
      !env.ASSURAPAY_EMAIL_FROM?.trim()
    )
      throw new IdentityVerificationConfigError(
        'VERIFICATION_CHANNEL_UNAVAILABLE',
        'EMAIL requires a configured RESEND provider',
      );
    let origin: URL;
    try {
      origin = new URL(env.NEXT_PUBLIC_APP_URL ?? '');
    } catch {
      throw new IdentityVerificationConfigError(
        'VERIFICATION_CHANNEL_UNAVAILABLE',
        'EMAIL requires a public application URL',
      );
    }
    if (
      origin.protocol !== 'https:' &&
      !(
        env.NODE_ENV !== 'production' &&
        ['localhost', '127.0.0.1'].includes(origin.hostname)
      )
    )
      throw new IdentityVerificationConfigError(
        'VERIFICATION_CHANNEL_UNAVAILABLE',
        'EMAIL requires an HTTPS application URL',
      );
  }
  if (channel !== 'DIRECT_RETURN' && channel !== 'EMAIL')
    throw new IdentityVerificationConfigError(
      'VERIFICATION_CHANNEL_UNKNOWN',
      `ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL=${channel} is not a channel. Use DIRECT_RETURN.`,
    );

  const ttl = env.ASSURAPAY_IDENTITY_VERIFICATION_TTL_MS
    ? Number(env.ASSURAPAY_IDENTITY_VERIFICATION_TTL_MS)
    : DEFAULT_TOKEN_TTL_MS;

  return {
    channel,
    tokenTtlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TOKEN_TTL_MS,
  };
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
export function verificationTokenMatches(
  presented: string,
  storedDigest: string,
): boolean {
  const candidate = Buffer.from(verificationTokenDigest(presented), 'hex');
  const stored = Buffer.from(storedDigest, 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
