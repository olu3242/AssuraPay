import { protectBrowserMutation } from '../../../../../lib/browser-security';
import { trustStore as browserSecurityStore } from '../../../../../lib/persistence';
import { deliverAuthenticationEmail } from '../../../../../lib/authentication-email';
import { randomBytes } from 'node:crypto';
import { LoginProofService } from '@assurapay/identity';
import { loadIdentityVerificationConfig } from '@assurapay/identity';
import { trust, trustStore, errorResponse } from '../../../../../lib/trust-app';

const loginProofs = new LoginProofService(trustStore);

/**
 * Passwordless login is a two-step exchange on one public route.
 *
 * 1. `{ email }` issues a short-lived challenge. DIRECT_RETURN is used only by a
 *    deployment that explicitly declares it has no notification transport.
 * 2. `{ email, challengeId, proofToken }` consumes that single-use proof and only
 *    then creates a session.
 *
 * The previous route exchanged `{ email }` directly for a session, so knowing an
 * address was enough to impersonate its owner. This route no longer has that path.
 */
export async function POST(request: Request) {
  try {
    await protectBrowserMutation(
      request,
      browserSecurityStore,
      process.env.NEXT_PUBLIC_APP_URL,
    );
    const channel = loadIdentityVerificationConfig(process.env).channel;
    const body = (await request.json()) as {
      email?: string;
      challengeId?: string;
      proofToken?: string;
      deviceFingerprint?: string;
    };
    const email = body.email?.trim();
    if (!email) throw new Error('AUTHENTICATION_DENIED');

    const correlationId =
      request.headers.get('x-correlation-id') ?? crypto.randomUUID();

    if (!body.challengeId || !body.proofToken) {
      const issued = await loginProofs.issue({ email, correlationId });

      const delivery =
        channel === 'EMAIL'
          ? await deliverAuthenticationEmail({
              purpose: 'LOGIN',
              userId: issued.userId,
              email,
              reference: issued.challengeId,
              credential: issued.proofToken,
              correlationId,
            })
          : undefined;
      return Response.json({
        delivery,
        correlationId,
        challengeId: issued.challengeId,
        expiresAt: issued.expiresAt,
        ...(channel === 'DIRECT_RETURN'
          ? { proofToken: issued.proofToken }
          : {}),
      });
    }

    const authenticationMethodId = await loginProofs.consume({
      email,
      challengeId: body.challengeId,
      proofToken: body.proofToken,
      correlationId,
    });
    const rawSessionToken = randomBytes(32).toString('hex');
    const { session } = await trust.identity.login({
      email,
      rawSessionToken,
      authenticationMethodId,
      deviceFingerprint: body.deviceFingerprint,
      ipContext: request.headers.get('x-forwarded-for') ?? undefined,
      userAgentContext: request.headers.get('user-agent') ?? undefined,
      correlationId,
    });
    const { sessionTokenHash: _hash, ...safeSession } = session;
    const response = Response.json(safeSession);
    response.headers.append(
      'Set-Cookie',
      `assurapay_session=${rawSessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`,
    );
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
