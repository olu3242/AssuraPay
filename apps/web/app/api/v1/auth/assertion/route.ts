import type { AssuranceLevel } from '@assurapay/shared';
import { errorResponse, issueSessionAssertion } from '../../../../../lib/trust-app';

/** The assurance levels the platform defines, for validating an untrusted request body. */
const ASSURANCE_LEVELS: readonly AssuranceLevel[] = [
  'IAL0_UNVERIFIED',
  'IAL1_BASIC',
  'IAL2_VERIFIED',
  'IAL3_HIGH_ASSURANCE',
];

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

    // `request.json()` returns the promise; `.catch` belongs on it, not on the object it resolves
    // to. The previous form was `await (await request.json()).catch(...)`, which awaited first and
    // then called `.catch` on a plain object — a TypeError on every request whose body parsed, and
    // an unhandled parse error on every request without one. The route could not succeed on any
    // input, which is why the browser journey reached it and got `GATEWAY_ASSERTION_MISSING`: no
    // caller had ever obtained an assertion, because obtaining one was impossible.
    //
    // The fallback is what makes a body optional, which is the intended contract: every field in it
    // is optional, and a caller wanting a session-scoped assertion sends nothing.
    const body = (await request.json().catch(() => ({}))) as {
      workspaceId?: string;
      purpose?: string;
      minimumAssuranceLevel?: string;
    };

    // Checked against the set rather than cast to it. This route is public and the body is
    // attacker-controlled, so an unrecognised assurance level is dropped — passing an arbitrary
    // string through would let a caller name a level the comparison logic does not understand,
    // and the safe reading of "I don't know this level" is "you asked for nothing".
    const minimumAssuranceLevel = ASSURANCE_LEVELS.find(
      (level) => level === body.minimumAssuranceLevel,
    );
    const issued = await issueSessionAssertion({
      rawSessionToken: token,
      workspaceId: body.workspaceId,
      purpose: body.purpose,
      minimumAssuranceLevel,
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
