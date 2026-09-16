import { describe, expect, it, vi, afterEach } from 'vitest';
import { workspaceFetch } from './workspace-fetch';
afterEach(() => vi.unstubAllGlobals());
describe('workspace browser requests', () => {
  it('uses a fresh workspace assertion for each action and preserves its body', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ activeWorkspaceId: 'w1' }))
      .mockResolvedValueOnce(Response.json({ assertion: 'proof-1' }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ activeWorkspaceId: 'w1' }))
      .mockResolvedValueOnce(Response.json({ assertion: 'proof-2' }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    await workspaceFetch('/api/v1/flows', {
      method: 'POST',
      body: JSON.stringify({ transactionId: 't1' }),
    });
    await workspaceFetch('/api/v1/flows?view=health');
    expect(
      new Headers(fetcher.mock.calls[2][1].headers).get(
        'x-assurapay-identity-assertion',
      ),
    ).toBe('proof-1');
    expect(
      new Headers(fetcher.mock.calls[5][1].headers).get(
        'x-assurapay-identity-assertion',
      ),
    ).toBe('proof-2');
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({
      transactionId: 't1',
    });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      workspaceId: 'w1',
    });
  });
  it('refuses requests without a workspace', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ userId: 'u1' }));
    vi.stubGlobal('fetch', fetcher);
    await expect(workspaceFetch('/api/v1/flows')).rejects.toThrow(
      'Select an active workspace',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses requests after assertion denial', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ activeWorkspaceId: 'w1' }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(workspaceFetch('/api/v1/flows')).rejects.toThrow(
      'could not authorize',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never forwards credentials to an external URL', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      workspaceFetch('https://example.com/api/v1/flows'),
    ).rejects.toThrow('INVALID_API_PATH');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
