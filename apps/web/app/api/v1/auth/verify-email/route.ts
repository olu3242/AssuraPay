import { trust, errorResponse } from '../../../../../lib/trust-app';

/**
 * Consumes an email verification token and activates the identity.
 *
 * This is the route that did not exist. `POST /v1/auth/register` produced an identity with status
 * `PENDING_VERIFICATION`; `POST /v1/auth/login` refuses anything that is not `ACTIVE`; and the only
 * engine method bridging them, `IdentityService.activate`, had no HTTP surface anywhere in the
 * application. The result was a platform in which registration succeeded, sign-in was refused with
 * `AUTHENTICATION_DENIED`, and nothing a user could do would ever change that. The browser
 * certification found it by being the first thing to try.
 *
 * Unauthenticated by necessity and by design: the caller is proving possession of an address
 * precisely because it has no session yet. The token is the credential, so the route carries no
 * identity requirement of its own — which is why `route-permissions.ts` classifies it `public` and
 * why `IdentityService.verifyEmail` refuses every failure with one indistinguishable error.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const identity = await trust.identity.verifyEmail({
      userId: body.userId,
      token: body.token,
      correlationId: request.headers.get('x-correlation-id') ?? crypto.randomUUID(),
    });
    // Activation clears the digest, so there is nothing to strip — but the destructure stays as the
    // explicit statement that this response must never carry it, whatever the record holds later.
    const { emailVerificationTokenHash: _digest, ...safeIdentity } = identity;
    return Response.json(safeIdentity);
  } catch (error) {
    return errorResponse(error);
  }
}
