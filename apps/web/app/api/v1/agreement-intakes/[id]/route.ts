import { agreementIntakes } from '../../../../../lib/agreement-intake-app';
import { authorizeAgreementIntakeRead } from '../../../../../lib/agreement-intake-authorization';
import { errorResponse } from '../../../../../lib/trust-app';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try { return Response.json(await agreementIntakes.get(await authorizeAgreementIntakeRead(request), params.id)); }
  catch (error) { return errorResponse(error); }
}
