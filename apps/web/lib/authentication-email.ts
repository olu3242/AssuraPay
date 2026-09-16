import { withTrustScope } from '@assurapay/database';
import {
  NotificationService,
  ResendEmailProvider,
} from '@assurapay/notifications';
import { trustStore } from './persistence';

export async function deliverAuthenticationEmail(input: {
  purpose: 'VERIFY_EMAIL' | 'LOGIN';
  userId: string;
  email: string;
  reference: string;
  credential: string;
  correlationId: string;
}): Promise<{ id: string; status: string }> {
  const provider = new ResendEmailProvider(
    process.env.RESEND_API_KEY ?? '',
    process.env.ASSURAPAY_EMAIL_FROM ?? '',
  );
  const delivery = await withTrustScope({ actorId: input.userId }, () =>
    new NotificationService(trustStore, provider).deliver({
      purpose: input.purpose,
      userId: input.userId,
      recipient: input.email,
      idempotencyKey: input.reference,
      correlationId: input.correlationId,
      subject:
        input.purpose === 'VERIFY_EMAIL'
          ? 'Verify your AssuraPay email address'
          : 'Your AssuraPay sign-in code',
      text: `Use this code only in AssuraPay at ${process.env.NEXT_PUBLIC_APP_URL}.\nReference: ${input.reference}\nCode: ${input.credential}\nIf you did not request this, ignore this message.`,
    }),
  );
  return { id: delivery.id, status: delivery.status };
}
