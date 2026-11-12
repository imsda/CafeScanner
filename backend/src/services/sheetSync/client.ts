import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';
import { getSettings } from '../settingsService.js';

// gaxios is a transitive dependency; derive its types from googleapis instead of importing it.
type RetryConfig = NonNullable<sheets_v4.Options['retryConfig']>;
type GaxiosError = Parameters<NonNullable<RetryConfig['shouldRetry']>>[0];

export type SheetSyncSettings = Awaited<ReturnType<typeof getSettings>>;

/** Thrown when a sync cannot start because another operation holds the lock (not a Google failure). */
export class SheetSyncBusyError extends Error {}

// Every Google API request is abandoned after this long so a stalled connection
// can never hold the import/write-back lock (and the scheduler) forever.
export const SHEETS_REQUEST_TIMEOUT_MS = 30_000;
// A full-table rebuild sends one large request on an explicit admin action.
export const SHEETS_BULK_REQUEST_TIMEOUT_MS = 120_000;

const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'PUT', 'OPTIONS', 'DELETE'];
const MAX_RETRIES = 2;

// 429 means the request was rejected before doing anything, so it is safe to retry
// for every method. 5xx and dropped connections are retried only for idempotent
// methods: re-sending a POST (values.append) that may have been applied would
// duplicate LOG rows.
function shouldRetrySheetsRequest(error: GaxiosError): boolean {
  const config = error.config?.retryConfig;
  if ((config?.currentRetryAttempt ?? 0) >= MAX_RETRIES) return false;
  const status = error.response?.status;
  if (status === 429) return true;
  const idempotent = IDEMPOTENT_METHODS.includes((error.config?.method || 'GET').toUpperCase());
  if (!idempotent) return false;
  if (status === undefined) return true; // timeout / network error
  return status >= 500 && status <= 599;
}

export const SHEETS_RETRY_CONFIG: RetryConfig = {
  retry: MAX_RETRIES,
  noResponseRetries: MAX_RETRIES,
  retryDelay: 1000,
  maxRetryDelay: 8000,
  statusCodesToRetry: [[429, 429], [500, 599]],
  shouldRetry: shouldRetrySheetsRequest
};

export const DEFAULT_SHEET_TAB_NAME = 'Sheet1';

export type ColumnKey = 'id' | 'name' | 'breakfast' | 'lunch' | 'dinner' | 'total' | 'week_starting' | 'week_ending';
export type HeaderMap = Record<ColumnKey, number | undefined>;

export function parseSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? trimmed;
}

function validateServiceAccountCredentials() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() || '';
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
  const key = rawKey.replace(/\\n/g, '\n').trim();

  if (!email) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL environment variable.');
  if (!key) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY environment variable.');
  if (!key.includes('BEGIN PRIVATE KEY') || !key.includes('END PRIVATE KEY')) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY format is invalid. Expected a PEM private key.');
  }

  return { email, key };
}

export function getSheetsClient() {
  const { email, key } = validateServiceAccountCredentials();
  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  // Options given here become the default gaxios options for every request made
  // through this client (googleapis merges them into each call).
  return google.sheets({ version: 'v4', auth, timeout: SHEETS_REQUEST_TIMEOUT_MS, retry: true, retryConfig: SHEETS_RETRY_CONFIG });
}

export function mapGoogleSheetsError(error: unknown): Error {
  if (error instanceof SheetSyncBusyError) return error;
  const maybe = error as { code?: number | string; name?: string; message?: string; response?: { status?: number; data?: { error?: { message?: string } } } };
  const status = maybe?.response?.status ?? maybe?.code;
  const apiMessage = maybe?.response?.data?.error?.message || maybe?.message || 'Unknown Google Sheets API error';

  // gaxios reports its own request timeout as "The operation was aborted." without a status.
  const timedOut = maybe?.name === 'TimeoutError' || maybe?.code === 'TimeoutError' || maybe?.code === 'ETIMEDOUT'
    || (!maybe?.response && /operation was aborted|timed? ?out/i.test(maybe?.message || ''));
  if (timedOut) {
    return new Error('Google Sheets did not respond in time (request timed out). Local scans are saved; the sync will retry.');
  }
  if (status === 429) return new Error('Google Sheets write quota exceeded (429). Wait a minute before retrying. Local scans are saved.');
  if (status === 403) {
    return new Error('Google Sheets API denied access (403). Share the sheet with the service account email and confirm API access is enabled.');
  }
  if (status === 404) {
    return new Error('Google Sheet or worksheet not found (404). Verify the sheet ID and tab name in Settings.');
  }

  return new Error(`Google Sheets API error${status ? ` (${status})` : ''}: ${apiMessage}`);
}

export async function readSheetRows() {
  const settings = await getSettings();
  if (!settings.googleSheetsEnabled) throw new Error('Google Sheets sync is disabled in Settings.');
  const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
  const sheetName = (settings.googleSheetTabName || DEFAULT_SHEET_TAB_NAME).trim();
  const range = `${sheetName}!A:ZZ`;
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return { spreadsheetId, sheetName, rows: resp.data.values || [] };
}

function normalizeHeaderName(value: string): string {
  return (value || '').trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

function findHeaderIndex(headers: string[], aliases: string[]): number | undefined {
  const normalizedAliases = aliases.map((a) => normalizeHeaderName(a));
  const index = headers.findIndex((header) => normalizedAliases.includes(normalizeHeaderName(header)));
  return index < 0 ? undefined : index;
}

export function getTallyHeaderMap(headerRow: string[]): HeaderMap {
  const headers = headerRow || [];
  const id = findHeaderIndex(headers, ['id', 'student id', 'person id']);
  const name = findHeaderIndex(headers, ['name', 'student name']);
  const breakfast = findHeaderIndex(headers, ['breakfast']);
  const lunch = findHeaderIndex(headers, ['lunch']);
  const dinner = findHeaderIndex(headers, ['dinner']);
  const total = findHeaderIndex(headers, ['total']);
  const week_starting = findHeaderIndex(headers, ['week starting']);
  const week_ending = findHeaderIndex(headers, ['week ending']);
  return { id, name, breakfast, lunch, dinner, total, week_starting, week_ending };
}

export function assertRequiredHeaders(map: HeaderMap, required: Array<ColumnKey>, label: string) {
  const missing = required.filter((key) => map[key] === undefined);
  if (missing.length) {
    throw new Error(`Missing required ${label} columns: ${missing.join(', ')}.`);
  }
}

export function columnNumberToLetter(columnNumber: number): string {
  let n = columnNumber;
  let result = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}
