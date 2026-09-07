import {
  authorizedContextForRoute,
  errorResponse,
  treasury,
  trustStore,
} from '../../../../lib/trust-app';
import {
  governPaymentIssueRequest,
  type PaymentIssueRequest,
} from '../../../../lib/multi-currency-payment';
import { persistPaymentCurrencyRouteEvidence } from '../../../../lib/payment-currency-link';

export async function POST(request: Request) {
  try {
    const context = await authorizedContextForRoute(request);
    const body = (await request.json()) as PaymentIssueRequest;
    const governed = governPaymentIssueRequest(body);
    const payment = await treasury.payments.issue(context, governed.paymentInput);
    const currencyRoute = await persistPaymentCurrencyRouteEvidence(
      trustStore,
      context,
      payment,
      governed,
    );

    return Response.json(
      {
        ...payment,
        currencyRoute,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
