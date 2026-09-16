/** Exchange the current HTTP-only session for a fresh, single-use workspace assertion. */
export async function workspaceFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!path.startsWith('/api/v1/') || path.startsWith('//'))
    throw new Error('INVALID_API_PATH');
  const sessionResponse = await fetch('/api/v1/auth/session', {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!sessionResponse.ok) throw new Error('Sign in to continue.');
  const session = await sessionResponse.json();
  if (!session.activeWorkspaceId)
    throw new Error('Select an active workspace to continue.');
  const assertionResponse = await fetch('/api/v1/auth/assertion', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: session.activeWorkspaceId }),
  });
  if (!assertionResponse.ok)
    throw new Error(
      'Your session could not authorize this action. Sign in again.',
    );
  const { assertion } = await assertionResponse.json();
  if (typeof assertion !== 'string' || !assertion)
    throw new Error('Authorization response was incomplete.');
  const headers = new Headers(init.headers);
  headers.set('x-assurapay-identity-assertion', assertion);
  if (init.body && typeof init.body === 'string')
    headers.set('content-type', 'application/json');
  return fetch(path, {
    ...init,
    headers,
    cache: 'no-store',
    credentials: 'same-origin',
  });
}
