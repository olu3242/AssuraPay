import { protectBrowserMutation } from '../../../../../lib/browser-security';
import { trustStore as browserSecurityStore } from '../../../../../lib/persistence';
import { deliverAuthenticationEmail } from '../../../../../lib/authentication-email';
import { loadIdentityVerificationConfig } from '@assurapay/identity';
import { trust, errorResponse } from '../../../../../lib/trust-app';

/**
 * Registers an identity and, depending on the configured channel, hands back its verification
 * token.
 *
 * The token is what `POST /v1/auth/verify-email` consumes to move the identity from
 * `PENDING_VERIFICATION` to `ACTIVE`. Until this route existed in this shape there was no way to
 * make that transition at all through HTTP, so every identity the platform created was permanently
 * unable to sign in — see `packages/identity/src/verification.ts`.
 *
 * `emailVerificationToken` is included **only** when the deployment declares `DIRECT_RETURN`, which
 * is a statement that it has no delivery channel because Engine 09 is deferred. The configuration
 * is read per request rather than captured at module load so that a deployment cannot be changed
 * out from under a running process without the next request reflecting it, and it is read *before*
 * the identity is created so a misconfigured deployment refuses rather than creating an identity
 * whose token it then cannot deliver.
 */
export async function POST(request: Request) {
  try {
    await protectBrowserMutation(
      request,
      browserSecurityStore,
      process.env.NEXT_PUBLIC_APP_URL,
    );
    const verification = loadIdentityVerificationConfig(process.env);
    const body = await request.json();
    const correlationId =
      request.headers.get('x-correlation-id') ?? crypto.randomUUID();
    const { identity, emailVerificationToken } = await trust.identity.register({
      email: body.email,
      displayName: body.displayName,
      correlationId,
      verificationTokenTtlMs: verification.tokenTtlMs,
    });

    // The stored digest never leaves the server, on any channel. Stripped the same way the login
    // route strips `sessionTokenHash`.
    const { emailVerificationTokenHash: _digest, ...safeIdentity } = identity;

    const delivery =
      verification.channel === 'EMAIL'
        ? await deliverAuthenticationEmail({
            purpose: 'VERIFY_EMAIL',
            userId: identity.id,
            email: identity.email,
            reference: identity.id,
            credential: emailVerificationToken,
            correlationId,
          })
        : undefined;
    return Response.json(
      verification.channel === 'DIRECT_RETURN'
        ? { ...safeIdentity, emailVerificationToken }
        : { ...safeIdentity, delivery, correlationId },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
