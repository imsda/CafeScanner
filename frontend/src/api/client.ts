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

/** A non-2xx response. `payload` is the parsed JSON body, if any (e.g. a failed scan result). */
export class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

// AuthContext registers a handler so an expired or revoked session signs the user out.
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const requestUrl = `${API_BASE}${path}`;
  const headers = new Headers(init.headers);
  // FormData bodies need the browser to set the multipart boundary itself.
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let res: Response;
  try {
    res = await fetch(requestUrl, { ...init, credentials: 'include', headers });
  } catch (networkError) {
    throw new ApiNetworkError(requestUrl, networkError);
  }

  if (!res.ok) {
    const errPayload = await res.json().catch(() => null);
    if (res.status === 401 && !path.startsWith('/auth/')) unauthorizedHandler?.();
    throw new ApiError(getErrorMessage(errPayload) || `Request failed (${res.status})`, res.status, errPayload);
  }

  return res.json() as Promise<T>;
}

/** POSTs a multipart form (file uploads) through the same error handling as api(). */
export function apiUpload<T>(path: string, form: FormData): Promise<T> {
  return api<T>(path, { method: 'POST', body: form });
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export { API_BASE };
