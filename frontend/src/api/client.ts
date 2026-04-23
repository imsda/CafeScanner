const explicitApiBase = import.meta.env.VITE_API_BASE as string | undefined;

const API_BASE = (explicitApiBase && explicitApiBase.trim().length > 0
  ? explicitApiBase.trim()
  : '/api'
).replace(/\/$/, '');

function getErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) {
    return null;
  }

  const maybeError = payload.error;
  return typeof maybeError === 'string' && maybeError.length > 0 ? maybeError : null;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init
  });

  if (!res.ok) {
    const errPayload = await res.json().catch(() => null);
    throw new Error(getErrorMessage(errPayload) || 'Request failed');
  }

  return res.json() as Promise<T>;
}

export { API_BASE };
