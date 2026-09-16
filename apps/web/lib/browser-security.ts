import type { TrustPersistence } from '@assurapay/shared';

export function browserMutationRefusal(
  request: Request,
  applicationUrl?: string,
): string | undefined {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return;
  const url = new URL(request.url);
  const expected = applicationUrl ? new URL(applicationUrl).origin : url.origin;
  const origin = request.headers.get('origin');
  const cookie = request.headers.get('cookie') ?? '';
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (origin !== null && origin !== expected)
  )
    return 'CSRF_ORIGIN_DENIED';
  if (/(?:^|;\s*)assurapay_session=/.test(cookie) && origin !== expected)
    return 'CSRF_ORIGIN_REQUIRED';
  if (
    url.pathname.startsWith('/api/v1/auth/') &&
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') ?? '',
    )
  )
    return 'JSON_CONTENT_TYPE_REQUIRED';
}

export async function protectBrowserMutation(
  request: Request,
  store: TrustPersistence,
  applicationUrl?: string,
): Promise<void> {
  const code = browserMutationRefusal(request, applicationUrl);
  if (!code) return;
  await store.audit({
    actorId: 'anonymous',
    eventType: 'BrowserMutationDenied',
    aggregateType: 'HttpRequest',
    aggregateId: 'browser',
    correlationId:
      request.headers.get('x-correlation-id') ?? crypto.randomUUID(),
    metadata: { reasonCode: code, method: request.method },
  });
  throw new Error(code);
}
