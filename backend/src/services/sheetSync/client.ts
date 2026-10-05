import { google } from 'googleapis';
import { getSettings } from '../settingsService.js';

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
  return google.sheets({ version: 'v4', auth });
}

export function mapGoogleSheetsError(error: unknown): Error {
  const maybe = error as { code?: number; message?: string; response?: { status?: number; data?: { error?: { message?: string } } } };
  const status = maybe?.response?.status ?? maybe?.code;
  const apiMessage = maybe?.response?.data?.error?.message || maybe?.message || 'Unknown Google Sheets API error';

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
