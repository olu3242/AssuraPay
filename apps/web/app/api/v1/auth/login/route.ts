import { LoginProofService } from '@assurapay/identity/src/login-proof';
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
    const body = (await request.json()) as {
      email?: string;
      challengeId?: string;
      proofToken?: string;
      deviceFingerprint?: string;
    };
    const email = body.email?.trim();
    if (!email) throw new Error('AUTHENTICATION_DENIED');

    const correlationId = request.headers.get('x-correlation-id') ?? crypto.randomUUID();

    if (!body.challengeId || !body.proofToken) {
      const issued = await loginProofs.issue({ email, correlationId });
      const channel = loadIdentityVerificationConfig(process.env).channel;
      return Response.json({
        challengeId: issued.challengeId,
        expiresAt: issued.expiresAt,
        ...(channel === 'DIRECT_RETURN' ? { proofToken: issued.proofToken } : {}),
      });
    }

    const authenticationMethodId = await loginProofs.consume({
      email,
      challengeId: body.challengeId,
      proofToken: body.proofToken,
      correlationId,
    });
    const rawSessionToken = crypto.randomUUID();
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
