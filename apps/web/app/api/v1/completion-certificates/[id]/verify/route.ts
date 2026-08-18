import {
  authorizedContextForRoute,
  completion,
  errorResponse,
} from '../../../../../../lib/trust-app';

/**
 * Verifies a completion certificate.
 *
 * Re-pointed from the `FileAssuraStore` snapshot to `CompletionCertificationEngine.verify`, which reads the
 * durable `completionCertificates` row and returns its status with the canonical hash it was issued under.
 *
 * Permission-gated rather than open, unchanged: certificate verification is the evidence a release is built
 * on, and an unauthenticated caller could otherwise enumerate certificate ids and read their status.
 *
 * The response gains `canonicalHash` and no longer returns the whole certificate. Both follow from the same
 * reasoning. The hash is what makes the answer checkable — a verifier can recompute it against the
 * certificate they hold rather than trusting this endpoint's word — while returning the full record from a
 * verification endpoint discloses the certified work's detail to anyone permitted only to verify. The engine
 * returns the narrower shape and it is passed through rather than widened here.
 *
 * A missing certificate now raises `RECORD_NOT_FOUND` from the engine instead of returning
 * `{ status: 'NOT_FOUND' }` with HTTP 200. A 200 for a certificate that does not exist is a verification
 * result that reads as an answer, and `errorResponse` maps the engine's refusal to a status a client can
 * branch on.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const context = await authorizedContextForRoute(request);
    return Response.json(await completion.certification.verify(context, params.id));
  } catch (error) {
    return errorResponse(error);
  }
}
