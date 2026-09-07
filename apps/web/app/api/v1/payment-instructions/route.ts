import {
  authorizedContextForRoute,
  errorResponse,
  treasury,
} from '../../../../lib/trust-app';
import {
  governPaymentIssueRequest,
  type PaymentIssueRequest,
} from '../../../../lib/multi-currency-payment';

export async function POST(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = (await request.json()) as PaymentIssueRequest;
    const governed = governPaymentIssueRequest(body);
    const payment = await treasury.payments.issue(context, governed.paymentInput);

    return Response.json(
      {
        ...payment,
        currencyRoute: governed.currencyRoute,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
