import { errorResponse, issueSessionAssertion } from '../../../../../lib/trust-app';

/**
 * Mints an identity assertion for the holder of a valid session cookie.
 *
 * Public in the route table for the same reason sign-in is: the caller presents a
 * session cookie, which is the credential this route authenticates. Requiring an
 * assertion here would be circular — obtaining one is what the route is for.
 *
 * The session is the authority. Nothing in the request body can name a subject, a
 * session or an assurance level; the only inputs are which workspace to select and
 * how the assertion is scoped, both of which are checked against the session.
 */
export async function POST(request: Request) {
  try {
    const token = request.headers
      .get('cookie')
      ?.match(/assurapay_session=([^;]+)/)?.[1];
    if (!token) throw new Error('UNAUTHENTICATED');

    const body = await request.json().catch(() => ({}));
    const issued = issueSessionAssertion({
      rawSessionToken: token,
      workspaceId: body.workspaceId,
      purpose: body.purpose,
      minimumAssuranceLevel: body.minimumAssuranceLevel,
      correlationId: request.headers.get('x-correlation-id') ?? crypto.randomUUID(),
    });

    // The token is returned in the body, never set as a cookie: it is a bearer
    // credential the client attaches to one request, not ambient state a browser
    // would replay onto every request automatically.
    return Response.json({
      assertion: issued.token,
      expiresAt: issued.expiresAt,
      boundedBySession: issued.boundedBySession,
      workspaceId: issued.claims.workspaceId ?? null,
      identityAssuranceLevel: issued.claims.identityAssuranceLevel,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
