import {
  authorizedContextForRoute,
  errorResponse,
  trustStore,
} from '../../../../../../lib/trust-app';
import { readAssuranceCase } from '../../../../../../lib/assurance-read-model';

/**
 * The milestone's assurance case.
 *
 * Re-pointed from `AssuraPayService.getAssuranceReadModel` over `FileAssuraStore` to `readAssuranceCase`,
 * which counts every figure from a durable record. The response shape changed, and deliberately: most of
 * what the previous version returned was a constant or arithmetic over a length — `declared: 90`,
 * `required: 2`, `evidenced: evidence.length * 30` — presented as a measurement on the endpoint named
 * `assurance`. Those fields are dropped rather than reproduced. See `lib/assurance-read-model.ts` for the
 * field-by-field account.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    await authorizedContextForRoute(request);
    return Response.json(await readAssuranceCase(trustStore, params.id));
  } catch (error) {
    return errorResponse(error);
  }
}
