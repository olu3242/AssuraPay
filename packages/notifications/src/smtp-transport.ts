import { createTransport } from 'nodemailer';
import type { NotificationTransport } from './transport';

/**
 * An SMTP transport, so a configured deployment actually sends the mail it has been recording as
 * undeliverable.
 *
 * ## What was missing, and what was not
 *
 * Engine 09 was built: versioned templates, masked recipients, verified-address-only delivery,
 * idempotency, suppression, and delivery evidence per subject — twenty-nine tests over all of it.
 * `FlowNotificationDispatcher` is composed and `advanceWorkspace` already calls `deliverPending`. The
 * one thing absent was a transport, so every obligation was raised durably and then recorded `FAILED`
 * with `NOTIFICATION_TRANSPORT_NOT_CONFIGURED`.
 *
 * That was the right way to ship it — `transport.ts` explains why a silent no-op would have been
 * worse than nothing, because it manufactures evidence — and this is the other half.
 *
 * ## TLS is not a deployment choice
 *
 * SMTP authentication sends the password. `loadSmtpConfig` therefore produces a configuration that
 * **always** demands TLS, and there is no environment variable that turns it off: port 465 uses
 * implicit TLS, every other port requires STARTTLS and the connection fails if the relay will not
 * upgrade. A relay that cannot do TLS is a relay this platform does not send credentials to.
 *
 * `requireTls` exists on the type because the local sink in `smtp-transport.test.ts` speaks plain
 * SMTP, and a test that could only run against a real relay would not run. It is unreachable from
 * configuration, and a test asserts that: `loadSmtpConfig` never returns it false, whatever the
 * environment says.
 *
 * Certificate verification is likewise not configurable. There is no `rejectUnauthorized: false`
 * here, because that flag is how TLS quietly becomes decoration.
 *
 * ## Failure is propagated, never swallowed
 *
 * `send` rejects, and `NotificationEngine.deliverPending` turns that into a `FAILED` record carrying
 * the reason. A transport that caught its own errors would restore exactly the silence this engine
 * was designed to avoid.
 */

export type SmtpConfig = {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS from the first byte. True for 465, false elsewhere, where STARTTLS is used instead. */
  readonly secure: boolean;
  /**
   * Whether the connection must be encrypted before anything else is sent.
   *
   * Always true from configuration. See the note above for why it is a field rather than a constant.
   */
  readonly requireTls: boolean;
  readonly user?: string;
  readonly pass?: string;
  /** The envelope sender. Required: every relay rejects a message without one. */
  readonly from: string;
};

export type SmtpConfigErrorCode =
  | 'SMTP_HOST_REQUIRED'
  | 'SMTP_FROM_REQUIRED'
  | 'SMTP_PORT_INVALID'
  | 'SMTP_PASSWORD_WITHOUT_USER';

export class SmtpConfigError extends Error {
  readonly code: SmtpConfigErrorCode;
  constructor(code: SmtpConfigErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SmtpConfigError';
    this.code = code;
  }
}

/** The port whose convention is TLS from the first byte rather than an upgrade. */
const IMPLICIT_TLS_PORT = 465;

/**
 * Reads SMTP settings from the environment.
 *
 * Returns `undefined` when the deployment has configured no mail at all, which is the ordinary case
 * and is not an error: the caller keeps `unconfiguredEmailTransport` and notifications go on
 * recording honest failures. It *throws* when settings are present but incoherent — a half-configured
 * relay should stop a deployment rather than silently behave like an unconfigured one, because the
 * operator who set two of the four variables believes mail is working.
 *
 * `ASSURAPAY_SMTP_HOST` is the switch. Nothing is defaulted to localhost: a platform that sends
 * counterparty mail to whatever happens to be listening on the container is worse than one that
 * sends none.
 */
export function loadSmtpConfig(
  env: Record<string, string | undefined>,
): SmtpConfig | undefined {
  const host = env.ASSURAPAY_SMTP_HOST?.trim();
  const from = env.ASSURAPAY_SMTP_FROM?.trim();
  const rawPort = env.ASSURAPAY_SMTP_PORT?.trim();
  const user = env.ASSURAPAY_SMTP_USER?.trim() || undefined;
  const pass = env.ASSURAPAY_SMTP_PASSWORD ?? undefined;

  // Nothing configured at all. Not a failure.
  if (!host && !from && !rawPort && !user && !pass) return undefined;

  if (!host) throw new SmtpConfigError('SMTP_HOST_REQUIRED', 'set ASSURAPAY_SMTP_HOST');
  if (!from) throw new SmtpConfigError('SMTP_FROM_REQUIRED', 'set ASSURAPAY_SMTP_FROM');

  const port = rawPort === undefined || rawPort === '' ? 587 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new SmtpConfigError('SMTP_PORT_INVALID', rawPort);
  }

  // A password with no user is a credential about to be sent nowhere useful, and usually means the
  // user variable was misspelled. Caught here rather than at the first send.
  if (pass !== undefined && pass !== '' && !user) {
    throw new SmtpConfigError('SMTP_PASSWORD_WITHOUT_USER', 'set ASSURAPAY_SMTP_USER');
  }

  return Object.freeze({
    host,
    port,
    secure: port === IMPLICIT_TLS_PORT,
    // Not read from the environment. There is deliberately no way to ask for plaintext SMTP.
    requireTls: true,
    ...(user === undefined ? {} : { user }),
    ...(pass === undefined || pass === '' ? {} : { pass }),
    from,
  });
}

/** What nodemailer is asked for, narrowed to what this transport uses. */
type Mailer = {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<{ messageId?: string }>;
};

/**
 * Builds the transport.
 *
 * `mailer` is injectable so the suite can drive the envelope without a relay, and because the
 * alternative — a module-level nodemailer the tests monkey-patch — is the kind of test-only fork the
 * convergence brief forbids. The default path is the real client, constructed from the same config
 * a deployment supplies.
 */
export function createSmtpTransport(config: SmtpConfig, mailer?: Mailer): NotificationTransport {
  const client: Mailer =
    mailer ??
    (createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.requireTls,
      ...(config.user === undefined ? {} : { auth: { user: config.user, pass: config.pass ?? '' } }),
    }) as unknown as Mailer);

  return {
    // The host, so delivery evidence says which relay accepted the message. Never the credentials.
    id: `smtp:${config.host}:${config.port}`,
    async send(input) {
      const result = await client.sendMail({
        from: config.from,
        to: input.to,
        subject: input.subject,
        // Text only. These templates are deliberately plain — they say that something is waiting and
        // never what it is — and an HTML part would be a second rendering of the same content that
        // could disagree with the one the notification record stored.
        text: input.body,
      });
      return result.messageId === undefined ? {} : { providerMessageId: result.messageId };
    },
  };
}
