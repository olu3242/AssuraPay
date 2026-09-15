import { agreementIntakes } from '../../../../../../../lib/agreement-intake-app';
import { authorizeAgreementIntakeWrite } from '../../../../../../../lib/agreement-intake-authorization';
import { errorResponse } from '../../../../../../../lib/trust-app';

export async function POST(request: Request, { params }: { params: { id: string; clarificationId: string } }) {
  try {
    const context = await authorizeAgreementIntakeWrite(request);
    const { answer } = await request.json();
    return Response.json(await agreementIntakes.resolveClarification(context, params.id, params.clarificationId, answer));
  } catch (error) { return errorResponse(error); }
}
