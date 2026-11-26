import { createServer, type Server } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import type { RequestContext } from '@assurapay/shared';
import { NotificationEngine } from './index';
import { createSmtpTransport, loadSmtpConfig, SmtpConfigError } from './smtp-transport';

/**
 * The SMTP transport, as assertions.
 *
 * Three things need proving, and they need different kinds of proof:
 *
 * 1. **Configuration refuses what it should.** Pure, so it is enumerated.
 * 2. **TLS cannot be switched off from a deployment.** The assertion this file exists for.
 * 3. **It actually speaks SMTP.** Proved over a real socket against a sink in this process, because a
 *    transport asserted only through an injected double is a transport nobody has run.
 */

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('configuration refuses a half-configured relay', () => {
  it('reports no configuration at all as absence, not failure', () => {
    // The ordinary case. The caller keeps `unconfiguredEmailTransport` and notifications go on
    // recording honest failures, which is what this platform did before this change.
    expect(loadSmtpConfig({})).toBeUndefined();
    expect(loadSmtpConfig({ UNRELATED: 'x' })).toBeUndefined();
  });

  it('refuses settings that are present but incomplete', () => {
    // A half-configured relay must stop a deployment rather than behave like an unconfigured one:
    // the operator who set two of the four variables believes mail is working.
    expect(() => loadSmtpConfig({ ASSURAPAY_SMTP_HOST: 'mail.example.com' })).toThrow(SmtpConfigError);
    expect(() => loadSmtpConfig({ ASSURAPAY_SMTP_FROM: 'a@example.com' })).toThrow(/SMTP_HOST_REQUIRED/);
    expect(() =>
      loadSmtpConfig({
        ASSURAPAY_SMTP_HOST: 'mail.example.com',
        // Present, so the port is what is wrong here. Omitting it reports the missing sender first,
        // which is also right and is what the line above covers.
        ASSURAPAY_SMTP_FROM: 'a@example.com',
        ASSURAPAY_SMTP_PORT: 'eighty',
      }),
    ).toThrow(/SMTP_PORT_INVALID/);
    expect(() =>
      loadSmtpConfig({
        ASSURAPAY_SMTP_HOST: 'mail.example.com',
        ASSURAPAY_SMTP_FROM: 'a@example.com',
        ASSURAPAY_SMTP_PORT: '70000',
      }),
    ).toThrow(/SMTP_PORT_INVALID/);
    // A password with no user is usually a misspelled user variable, and is a credential about to be
    // offered to a relay that was never told whose it is.
    expect(() =>
      loadSmtpConfig({
        ASSURAPAY_SMTP_HOST: 'mail.example.com',
        ASSURAPAY_SMTP_FROM: 'a@example.com',
        ASSURAPAY_SMTP_PASSWORD: 'secret',
      }),
    ).toThrow(/SMTP_PASSWORD_WITHOUT_USER/);
  });

  it('defaults the port to submission, and treats 465 as implicit TLS', () => {
    const base = { ASSURAPAY_SMTP_HOST: 'mail.example.com', ASSURAPAY_SMTP_FROM: 'a@example.com' };
    expect(loadSmtpConfig(base)).toMatchObject({ port: 587, secure: false });
    expect(loadSmtpConfig({ ...base, ASSURAPAY_SMTP_PORT: '465' })).toMatchObject({
      port: 465,
      secure: true,
    });
    expect(loadSmtpConfig({ ...base, ASSURAPAY_SMTP_PORT: '2525' })).toMatchObject({
      port: 2525,
      secure: false,
    });
  });

  it('never carries the password into the transport identifier', () => {
    const config = loadSmtpConfig({
      ASSURAPAY_SMTP_HOST: 'mail.example.com',
      ASSURAPAY_SMTP_FROM: 'a@example.com',
      ASSURAPAY_SMTP_USER: 'postmaster',
      ASSURAPAY_SMTP_PASSWORD: 'hunter2',
    })!;
    const transport = createSmtpTransport(config, { async sendMail() { return {}; } });
    // The id is written onto every delivery record, so it must name the relay and nothing else.
    expect(transport.id).toBe('smtp:mail.example.com:587');
    expect(transport.id).not.toContain('hunter2');
    expect(transport.id).not.toContain('postmaster');
  });
});

describe('TLS is not a deployment choice', () => {
  it('always requires TLS, whatever the environment asks for', () => {
    // The assertion this file exists for. SMTP authentication sends the password, so a relay that
    // cannot do TLS is a relay this platform does not send credentials to — and there must be no
    // variable that turns that off. These are the names someone would reach for.
    const base = { ASSURAPAY_SMTP_HOST: 'mail.example.com', ASSURAPAY_SMTP_FROM: 'a@example.com' };
    for (const attempt of [
      { ASSURAPAY_SMTP_REQUIRE_TLS: 'false' },
      { ASSURAPAY_SMTP_SECURE: 'false' },
      { ASSURAPAY_SMTP_TLS: 'off' },
      { ASSURAPAY_SMTP_INSECURE: '1' },
      { ASSURAPAY_SMTP_REJECT_UNAUTHORIZED: 'false' },
    ]) {
      const config = loadSmtpConfig({ ...base, ...attempt });
      expect(config?.requireTls, JSON.stringify(attempt)).toBe(true);
    }
  });

  it('offers no certificate-verification escape hatch anywhere in the module', async () => {
    // `rejectUnauthorized: false` is how TLS quietly becomes decoration. Asserted against the source
    // rather than the behaviour, because the behaviour would need a bad certificate to observe.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./smtp-transport.ts', import.meta.url), 'utf8'),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('rejectUnauthorized');
    expect(code).not.toContain('ignoreTLS');
  });
});

describe('it hands the relay the right envelope', () => {
  const config = loadSmtpConfig({
    ASSURAPAY_SMTP_HOST: 'mail.example.com',
    ASSURAPAY_SMTP_FROM: 'AssuraPay <no-reply@example.com>',
  })!;

  it('sends from the configured sender to the notification recipient', async () => {
    const sent: unknown[] = [];
    const transport = createSmtpTransport(config, {
      async sendMail(message) {
        sent.push(message);
        return { messageId: '<abc@example.com>' };
      },
    });

    const result = await transport.send({
      to: 'recipient@example.com',
      subject: 'Action required: Independent release approval',
      body: 'A task is waiting for you.',
    });

    expect(sent).toEqual([
      {
        from: 'AssuraPay <no-reply@example.com>',
        to: 'recipient@example.com',
        subject: 'Action required: Independent release approval',
        text: 'A task is waiting for you.',
      },
    ]);
    // Recorded as delivery evidence, so an operator can trace the message the relay accepted.
    expect(result.providerMessageId).toBe('<abc@example.com>');
  });

  it('omits the provider message id rather than inventing one', async () => {
    const transport = createSmtpTransport(config, { async sendMail() { return {}; } });
    expect(await transport.send({ to: 'a@b.com', subject: 's', body: 'b' })).toEqual({});
  });

  it('propagates a relay refusal instead of swallowing it', async () => {
    // `deliverPending` turns this rejection into a FAILED record carrying the reason. A transport
    // that caught its own errors would restore the silence this engine was designed to avoid.
    const transport = createSmtpTransport(config, {
      async sendMail() {
        throw new Error('550 5.1.1 recipient rejected');
      },
    });
    await expect(transport.send({ to: 'a@b.com', subject: 's', body: 'b' })).rejects.toThrow(
      /550 5\.1\.1/,
    );
  });
});

/**
 * A minimal SMTP sink, enough for one message.
 *
 * Hand-rolled rather than a dependency: this needs to accept a conversation, not implement a server,
 * and a test-only package in the manifest is a cost that outlives the test. It advertises no
 * STARTTLS and no AUTH, which is why the config below is constructed in-process with
 * `requireTls: false` — a shape `loadSmtpConfig` cannot produce, as the block above asserts.
 */
function smtpSink(): Promise<{ port: number; received: Promise<string> }> {
  return new Promise((resolveServer) => {
    let resolveMessage: (value: string) => void;
    const received = new Promise<string>((resolve) => {
      resolveMessage = resolve;
    });

    const server = createServer((socket) => {
      let inData = false;
      let buffer = '';
      socket.write('220 sink ESMTP\r\n');
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (inData) {
          buffer += text;
          if (buffer.includes('\r\n.\r\n')) {
            inData = false;
            resolveMessage(buffer.slice(0, buffer.indexOf('\r\n.\r\n')));
            socket.write('250 2.0.0 Ok: queued as SINK1\r\n');
          }
          return;
        }
        for (const line of text.split('\r\n').filter(Boolean)) {
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') socket.write('250-sink\r\n250 SIZE 10240000\r\n');
          else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 2.1.0 Ok\r\n');
          else if (verb === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (verb === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else socket.write('250 2.0.0 Ok\r\n');
        }
      });
      socket.on('error', () => undefined);
    });

    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveServer({ port: typeof address === 'object' && address ? address.port : 0, received });
    });
  });
}

describe('it actually speaks SMTP', () => {
  it('delivers a real message over a socket, and reports the relay’s queue id', async () => {
    // The real nodemailer client against a real socket. Everything above drives an injected double,
    // which proves the envelope and proves nothing about the wire.
    const { port, received } = await smtpSink();
    const transport = createSmtpTransport({
      host: '127.0.0.1',
      port,
      secure: false,
      // Constructible here and nowhere else. `loadSmtpConfig` never returns this.
      requireTls: false,
      from: 'AssuraPay <no-reply@example.com>',
    });

    const result = await transport.send({
      to: 'approver@example.com',
      subject: 'Action required: Independent release approval',
      body: 'A release approval is waiting for you in AssuraPay.',
    });

    const message = await received;
    expect(message).toContain('To: approver@example.com');
    expect(message).toContain('Subject: Action required: Independent release approval');
    expect(message).toContain('A release approval is waiting for you in AssuraPay.');
    expect(message).toContain('From: AssuraPay <no-reply@example.com>');
    // nodemailer generates the Message-ID it set on the wire, which is what delivery evidence stores.
    expect(result.providerMessageId).toMatch(/^<.+>$/);
    expect(message).toContain(`Message-ID: ${result.providerMessageId}`);
  }, 30_000);

  it('records SENT against this relay when the engine drives the whole path', async () => {
    // The path the product actually uses, with a real socket at the end of it: the engine raises a
    // durable obligation against a verified identity, `deliverPending` hands it to this transport,
    // and the delivery evidence names the relay that accepted it.
    //
    // Before this change that last step always recorded FAILED with
    // `NOTIFICATION_TRANSPORT_NOT_CONFIGURED`, because there was no transport. This is the assertion
    // that the gap is closed, rather than that a transport exists.
    const { port, received } = await smtpSink();
    const transport = createSmtpTransport({
      host: '127.0.0.1',
      port,
      secure: false,
      requireTls: false,
      from: 'AssuraPay <no-reply@example.com>',
    });

    const store = new InMemoryTrustStore();
    await store.append('identities', {
      id: 'user-approver',
      email: 'approver@acme.test',
      displayName: 'Ada',
      status: 'ACTIVE',
      emailVerifiedAt: '2026-01-01T00:00:00.000Z',
    });
    const engine = new NotificationEngine(store, transport);
    const ctx: RequestContext = {
      actorUserId: 'user-operator',
      sessionId: 'session-1',
      identityAssuranceLevel: 'IAL2_VERIFIED',
      activeWorkspaceId: 'workspace-1',
      tenantId: 'tenant-1',
      memberships: ['workspace-1'],
      correlationId: 'corr-1',
    };

    await engine.raise(ctx, {
      recipientIdentityId: 'user-approver',
      templateId: 'human-task-raised',
      variables: {
        recipientName: 'Ada',
        stepTitle: 'Independent release approval',
        requiredRole: 'RELEASE_APPROVER',
        flowReference: 'COMMERCIAL_COMMITMENT_FLOW / txn-1',
        actionPath: '/approvals?task=task-1',
      },
      subjectType: 'HumanTask',
      subjectId: 't-1',
      idempotencyKey: 'human-task:t-1:raised',
    });

    await engine.deliverPending(ctx);

    const [delivered] = await store.list<{
      status: string;
      transportId?: string;
      providerMessageId?: string;
      failureReason?: string;
      recipientMask?: string;
    }>('notifications');
    expect(delivered?.status, delivered?.failureReason).toBe('SENT');
    expect(delivered?.transportId).toBe(`smtp:127.0.0.1:${port}`);
    expect(delivered?.providerMessageId).toMatch(/^<.+>$/);

    // And the message really left: the subject the template rendered is on the wire.
    const message = await received;
    expect(message).toContain('Subject: Action required: Independent release approval');
    expect(message).toContain('To: approver@acme.test');
  }, 30_000);
});
