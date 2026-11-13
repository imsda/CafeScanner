import { vi } from 'vitest';

export type MockRoute = (request: { url: string; method: string; body: unknown }) => { status?: number; json: unknown } | undefined;

/**
 * Replaces window.fetch with a fake API. `route` returns the response for a request
 * (or undefined for 404). Every call is recorded in `calls` for assertions.
 */
export function mockApi(route: MockRoute) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body ?? null;
    const request = { url, method, body };
    calls.push(request);
    const response = route(request) ?? { status: 404, json: { error: 'Not found.' } };
    return new Response(JSON.stringify(response.json), { status: response.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}
