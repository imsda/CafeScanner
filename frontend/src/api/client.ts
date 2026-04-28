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

export class ApiNetworkError extends Error {
  requestUrl: string;
  causeError: unknown;

  constructor(requestUrl: string, causeError: unknown) {
    const fallbackMessage = causeError instanceof Error ? causeError.message : 'Unknown network error';
    super(fallbackMessage);
    this.name = causeError instanceof Error ? causeError.name : 'NetworkError';
    this.requestUrl = requestUrl;
    this.causeError = causeError;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const requestUrl = `${API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(requestUrl, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
      ...init
    });
  } catch (networkError) {
    throw new ApiNetworkError(requestUrl, networkError);
  }

  if (!res.ok) {
    const errPayload = await res.json().catch(() => null);
    throw new Error(getErrorMessage(errPayload) || 'Request failed');
  }

  return res.json() as Promise<T>;
}

export { API_BASE };
