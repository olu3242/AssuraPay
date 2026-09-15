import { agreementIntakeConvergence } from '../../../../../../lib/agreement-intake-app';
import { authorizeAgreementIntakeWrite } from '../../../../../../lib/agreement-intake-authorization';
import { errorResponse } from '../../../../../../lib/trust-app';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try { return Response.json(await agreementIntakeConvergence.convert(await authorizeAgreementIntakeWrite(request), params.id)); }
  catch (error) { return errorResponse(error); }
}
