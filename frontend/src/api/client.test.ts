import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ApiNetworkError, api, apiUpload, setUnauthorizedHandler } from './client';
import { mockApi } from '../test/mockApi';

afterEach(() => setUnauthorizedHandler(null));

describe('api client', () => {
  it('sends JSON with credentials and returns the parsed body', async () => {
    const { fetchMock } = mockApi(() => ({ json: { ok: true } }));
    await expect(api('/things', { method: 'POST', body: JSON.stringify({ a: 1 }) })).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/things');
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('lets the browser set the multipart header for uploads', async () => {
    const { fetchMock } = mockApi(() => ({ json: {} }));
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.csv');
    await apiUpload('/import/preview', form);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
    expect(init.method).toBe('POST');
  });

  it('throws ApiError with the server message, status and payload', async () => {
    mockApi(() => ({ status: 400, json: { ok: false, error: 'Please wait before scanning this ID again.', reason: 'COOLDOWN_ACTIVE' } }));
    const error: unknown = await api('/scan', { method: 'POST', body: '{}' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.message).toBe('Please wait before scanning this ID again.');
    expect(apiError.status).toBe(400);
    expect((apiError.payload as { reason: string }).reason).toBe('COOLDOWN_ACTIVE');
  });

  it('signs the user out on 401, except for the auth endpoints themselves', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockApi(() => ({ status: 401, json: { error: 'Unauthorized' } }));
    await api('/auth/me').catch(() => undefined);
    expect(onUnauthorized).not.toHaveBeenCalled();
    await api('/people').catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('reports network failures separately from server errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(api('/people')).rejects.toBeInstanceOf(ApiNetworkError);
  });
});
