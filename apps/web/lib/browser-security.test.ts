import { describe, expect, it } from 'vitest';
import { InMemoryTrustStore } from '@assurapay/database';
import {
  browserMutationRefusal,
  protectBrowserMutation,
} from './browser-security';
const request = (headers: HeadersInit = {}) =>
  new Request('https://app.example.test/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
  });
describe('browser mutation CSRF boundary', () => {
  it('permits same-origin cookie requests', () =>
    expect(
      browserMutationRefusal(
        request({
          origin: 'https://app.example.test',
          cookie: 'assurapay_session=secret',
        }),
      ),
    ).toBeUndefined());
  it('refuses cross-origin and missing-origin cookie requests', () => {
    expect(
      browserMutationRefusal(request({ origin: 'https://other.example.test' })),
    ).toBe('CSRF_ORIGIN_DENIED');
    expect(
      browserMutationRefusal(request({ cookie: 'assurapay_session=secret' })),
    ).toBe('CSRF_ORIGIN_REQUIRED');
    expect(
      browserMutationRefusal(request({ 'sec-fetch-site': 'cross-site' })),
    ).toBe('CSRF_ORIGIN_DENIED');
  });
  it('refuses simple-form authentication posts', () =>
    expect(
      browserMutationRefusal(request({ 'content-type': 'text/plain' })),
    ).toBe('JSON_CONTENT_TYPE_REQUIRED'));
  it('audits refusal with no cookie or credential value', async () => {
    const store = new InMemoryTrustStore();
    await expect(
      protectBrowserMutation(
        request({
          cookie: 'assurapay_session=sensitive-value',
          'x-correlation-id': 'csrf-test',
        }),
        store,
      ),
    ).rejects.toThrow('CSRF_ORIGIN_REQUIRED');
    const audit = await store.list('auditRecords');
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ correlationId: 'csrf-test' }),
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain('sensitive-value');
  });
});
