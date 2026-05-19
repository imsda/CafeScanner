import { MealDay, MealTrackingMode, MealType } from '@prisma/client';
import { google } from 'googleapis';
import { getSettings } from './settingsService.js';
import { prisma } from '../db.js';
import { importCampMeetingRows, mapRowsToCampMeetingInput } from './campMeetingImportService.js';
import { acquireOperationLock, isImportInProgress, isResetInProgress, isSchedulerPaused, isWritebackInProgress, releaseOperationLock } from './operationLockService.js';

const HEADER = ['ticket_id','reg_id','guest_name','meal_type','meal_day','meal_date','ticket_type','price','redeemed','redeemed_at','redeemed_by','notes'];
const TALLY_HEADER = ['id', 'name', 'breakfast', 'lunch', 'dinner', 'total'];
const WEEKLY_TALLY_HEADER = ['Week Starting', 'Week Ending', 'ID', 'Name', 'Breakfast', 'Lunch', 'Dinner', 'Total'];
const LOG_TAB_NAME = 'LOG';
const LOG_HEADER = ['Time', 'Value', 'Meal', 'Result', 'Reason', 'Person', 'Station'];
const DEFAULT_SHEET_TAB_NAME = 'Sheet1';
const TALLY_COUNT_COLUMNS = ['breakfast', 'lunch', 'dinner', 'total'] as const;

type ColumnKey = 'id' | 'name' | 'breakfast' | 'lunch' | 'dinner' | 'total' | 'week_starting' | 'week_ending';
type HeaderMap = Record<ColumnKey, number | undefined>;
type SchedulerStatus = {
  schedulerEnabled: boolean;
  lastAutomaticCheckTime: string | null;
  lastAutomaticWriteBackTime: string | null;
  lastAutomaticImportTime: string | null;
  lastAutomaticImportSummary: string | null;
  lastSkipReason: string | null;
  lastRowsUpdated: number;
  nextExpectedRunTime: string | null;
};

const schedulerStatus: SchedulerStatus = {
  schedulerEnabled: false,
  lastAutomaticCheckTime: null,
  lastAutomaticWriteBackTime: null,
  lastAutomaticImportTime: null,
  lastAutomaticImportSummary: null,
  lastSkipReason: null,
  lastRowsUpdated: 0,
  nextExpectedRunTime: null
};

function parseSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? trimmed;
}

function mealTypeFromSheet(value: string): MealType | null {
  const v = value.trim().toLowerCase();
  if (v === 'b') return MealType.BREAKFAST;
  if (v === 'l') return MealType.LUNCH;
  if (v === 'd' || v === 's') return MealType.DINNER;
  if (v === 'breakfast') return MealType.BREAKFAST;
  if (v === 'lunch') return MealType.LUNCH;
  if (v === 'supper' || v === 'dinner') return MealType.DINNER;
  return null;
}
function mealDayFromSheet(value: string): MealDay | null {
  const v = value.trim().slice(0,3).toLowerCase();
  const map: Record<string, MealDay> = {sun:MealDay.SUN,mon:MealDay.MON,tue:MealDay.TUE,wed:MealDay.WED,thu:MealDay.THU,fri:MealDay.FRI,sat:MealDay.SAT};
  return map[v] ?? null;
}
function mealDayFromDate(dateValue: string, timezone: string): MealDay | null {
  const raw = dateValue.trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const shortDay = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(parsed).toLowerCase();
  return mealDayFromSheet(shortDay);
}
function parseBool(value: string): boolean {
  return ['1', 'true', 'yes', 'y'].includes(value.trim().toLowerCase());
}
function isWithinMealWindowPlus10Minutes(d: Date, tz: string, settings: any): boolean {
  const fmt = new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false});
  const [h,m] = fmt.format(d).split(':').map(Number);
  const now = h*60+m;
  const windows: Array<[string, string]> = [[settings.breakfastStart,settings.breakfastEnd],[settings.lunchStart,settings.lunchEnd],[settings.dinnerStart,settings.dinnerEnd]];
  return windows.some(([s,e])=>{
    if (!s || !e) return false;
    const [sh,sm]=s.split(':').map(Number); const [eh,em]=e.split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return false;
    return now >= sh*60+sm && now <= eh*60+em+10;
  });
}
function getLocalTimeHHMM(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
function calculateActiveWindow(d: Date, tz: string, settings: any): string | null {
  const [h,m] = getLocalTimeHHMM(d, tz).split(':').map(Number);
  const now = h * 60 + m;
  const windows: Array<{ key: string; start?: string; end?: string }> = [
    { key: 'breakfast', start: settings.breakfastStart, end: settings.breakfastEnd },
    { key: 'lunch', start: settings.lunchStart, end: settings.lunchEnd },
    { key: 'dinner', start: settings.dinnerStart, end: settings.dinnerEnd }
  ];
  for (const window of windows) {
    if (!window.start || !window.end) continue;
    const [sh,sm]=window.start.split(':').map(Number); const [eh,em]=window.end.split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) continue;
    if (now >= sh*60+sm && now <= eh*60+em+10) return `${window.key} (${window.start}-${window.end}+10m)`;
  }
  return null;
}

function getSchedulerSkipReason(settings: any): string | null {
  if (!settings.googleSheetsEnabled) return 'sync disabled';
  if (!parseSpreadsheetId(settings.googleSheetId || '')) return 'missing sheet ID';
  if (isResetInProgress()) return 'reset in progress';
  if (isImportInProgress()) return 'import already running';
  if (isWritebackInProgress()) return 'writeback already running';
  if (isSchedulerPaused()) return 'scheduler paused';
  if (!isWithinMealWindowPlus10Minutes(new Date(), settings.timezone || 'Etc/UTC', settings)) return 'outside meal window';
  return null;
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

function getSheetsClient() {
  const { email, key } = validateServiceAccountCredentials();
  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

function mapGoogleSheetsError(error: unknown): Error {
  const maybe = error as { code?: number; message?: string; response?: { status?: number; data?: { error?: { message?: string } } } };
  const status = maybe?.response?.status ?? maybe?.code;
  const apiMessage = maybe?.response?.data?.error?.message || maybe?.message || 'Unknown Google Sheets API error';

  if (status === 403) {
    return new Error('Google Sheets API denied access (403). Share the sheet with the service account email and confirm API access is enabled.');
  }
  if (status === 404) {
    return new Error('Google Sheet or worksheet not found (404). Verify the sheet ID and tab name in Settings.');
  }

  return new Error(`Google Sheets API error${status ? ` (${status})` : ''}: ${apiMessage}`);
}

export async function importCampMeetingFromSheet() {
  if (isResetInProgress()) throw new Error('Reset in progress. Try again after reset completes.');
  if (!acquireOperationLock('import')) throw new Error('Import already in progress.');
  try {
  const { sheetName, rows } = await readSheetRows();
  const { inputRows, errors } = mapRowsToCampMeetingInput(rows as string[][]);
  if (errors.length) {
    return {
      totalRows: 0,
      validRows: 0,
      duplicateTicketIdCount: 0,
      skippedRows: 0,
      skippedRowReasons: [],
      peopleCreated: 0,
      peopleUpdated: 0,
      entitlementsCreated: 0,
      entitlementsUpdated: 0,
      uniqueRegIdCount: 0,
      errors
    };
  }
  const summary = await importCampMeetingRows(inputRows, { source: 'google_sheet', sheetName, batchSize: 50 });
  console.log('[SHEET_IMPORT]', summary);
  return summary;
  } finally {
    releaseOperationLock('import');
  }
}


export async function importTallyFromSheet() {
  if (isResetInProgress()) throw new Error('Reset in progress. Try again after reset completes.');
  const { spreadsheetId, sheetName, rows } = await readSheetRows();
  void spreadsheetId; void sheetName;
  const normalizedHeader = (rows[0] || []).map((v: string) => v.toLowerCase().trim());
  const dataRows = JSON.stringify(normalizedHeader) === JSON.stringify(TALLY_HEADER) ? rows.slice(1) : [];
  return importPeopleFromRows(dataRows, { includeBalances: false, overwriteExistingBalances: false, overwriteExistingCounts: true });
}

export async function importCountdownFromSheet() {
  if (isResetInProgress()) throw new Error('Reset in progress. Try again after reset completes.');
  const { rows } = await readSheetRows();
  const normalizedHeader = (rows[0] || []).map((v: string) => v.toLowerCase().trim());
  const dataRows = JSON.stringify(normalizedHeader) === JSON.stringify(TALLY_HEADER) ? rows.slice(1) : [];
  return importPeopleFromRows(dataRows, { includeBalances: true, overwriteExistingBalances: true, overwriteExistingCounts: true });
}

async function readSheetRows() {
  const settings = await getSettings();
  if (!settings.googleSheetsEnabled) throw new Error('Google Sheets sync is disabled in Settings.');
  const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
  const sheetName = (settings.googleSheetTabName || DEFAULT_SHEET_TAB_NAME).trim();
  const range = `${sheetName}!A:L`;
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return { spreadsheetId, sheetName, rows: resp.data.values || [] };
}

async function importPeopleFromRows(dataRows: string[][], options: { includeBalances: boolean; overwriteExistingBalances: boolean; overwriteExistingCounts: boolean }) {
  if (!acquireOperationLock('import')) throw new Error('Import already in progress.');
  try {
  let peopleCreated = 0; let peopleUpdated = 0; let rowsImported = 0; let rowsSkipped = 0;
  const errors: string[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i] as string[];
    const id = (r[0] || '').trim();
    const name = (r[1] || '').trim();
    if (!id) { rowsSkipped += 1; errors.push(`Row ${i + 2}: missing ID`); continue; }
    const existing = await prisma.person.findFirst({ where: { OR: [{ personId: id }, { codeValue: id }] }, select: { id: true } });
    const breakfast = Number(r[2] || 0); const lunch = Number(r[3] || 0); const dinner = Number(r[4] || 0);
    const total = breakfast + lunch + dinner;
    const data: any = { personId: id, codeValue: id, firstName: name || id, lastName: ' ', active: true };
    if (options.includeBalances) Object.assign(data, { breakfastRemaining: breakfast, lunchRemaining: lunch, dinnerRemaining: dinner, totalMealsCount: total });
    if (existing) {
      if (!options.overwriteExistingBalances) {
        delete data.breakfastRemaining;
        delete data.lunchRemaining;
        delete data.dinnerRemaining;
      }
      if (!options.overwriteExistingCounts) {
        delete data.breakfastCount;
        delete data.lunchCount;
        delete data.dinnerCount;
        delete data.totalMealsCount;
      }
      await prisma.person.update({ where: { id: existing.id }, data }); peopleUpdated += 1;
    }
    else { await prisma.person.create({ data }); peopleCreated += 1; }
    rowsImported += 1;
  }
  return { peopleCreated, peopleUpdated, rowsImported, rowsSkipped, writeBackRowsUpdated: 0, errors };
  } finally {
    releaseOperationLock('import');
  }
}
async function runAutoImportForMode(settings: Awaited<ReturnType<typeof getSettings>>) {
  if (!settings.googleSheetsEnabled || !settings.googleAutoImportEnabled || !parseSpreadsheetId(settings.googleSheetId || '') || isResetInProgress()) {
    return null;
  }
  if (settings.mealTrackingMode === MealTrackingMode.camp_meeting) {
    const summary = await importCampMeetingFromSheet();
    const text = `[SHEET_SYNC] Auto import completed: ${summary.peopleCreated} people created, ${summary.peopleUpdated} updated, ${summary.entitlementsCreated + summary.entitlementsUpdated} entitlements created/updated, ${summary.skippedRows} skipped`;
    console.log(text);
    await prisma.setting.update({ where: { id: 1 }, data: { googleLastAutoImportAt: new Date(), googleLastAutoImportSummary: text } });
    schedulerStatus.lastAutomaticImportTime = new Date().toISOString();
    schedulerStatus.lastAutomaticImportSummary = text;
    return text;
  }
  const { rows } = await readSheetRows();
  const normalizedHeader = (rows[0] || []).map((v: string) => v.toLowerCase().trim());
  const dataRows = JSON.stringify(normalizedHeader) === JSON.stringify(TALLY_HEADER) ? rows.slice(1) : [];
  const result = settings.mealTrackingMode === MealTrackingMode.tally
    ? await importPeopleFromRows(dataRows as string[][], { includeBalances: false, overwriteExistingBalances: false, overwriteExistingCounts: false })
    : await importPeopleFromRows(dataRows as string[][], { includeBalances: true, overwriteExistingBalances: false, overwriteExistingCounts: false });
  const text = `[SHEET_SYNC] Auto import completed: ${result.peopleCreated} people created, ${result.peopleUpdated} updated, 0 entitlements created/updated, ${result.rowsSkipped} skipped`;
  console.log(text);
  await prisma.setting.update({ where: { id: 1 }, data: { googleLastAutoImportAt: new Date(), googleLastAutoImportSummary: text } });
  schedulerStatus.lastAutomaticImportTime = new Date().toISOString();
  schedulerStatus.lastAutomaticImportSummary = text;
  return text;
}

export async function writeBackTallyCounts(force = false) {
  const settings = await getSettings();
  const mode = getTallyWriteBackMode(settings);
  if (mode === 'weekly') return { writeBackRowsUpdated: 0 };
  return writeBackPeopleRows(false, force);
}
export async function writeBackCountdownBalances(force = false) { return writeBackPeopleRows(true, force); }
export async function writeBackCampMeetingRedemptions(force = false) { return flushCampMeetingRedemptionsToSheet(force); }
export async function writeBackWeeklyTallyNow(force = true) { return writeBackWeeklyTally(force); }
export async function syncTransactionLogToSheet() {
  if (!acquireOperationLock('writeback')) return { tabName: LOG_TAB_NAME, rowsAppended: 0, transactionsSynced: 0 };
  try {
    const settings = await getSettings();
    if (!settings.googleSheetsEnabled) throw new Error('Google Sheets sync is disabled in Settings.');
    const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
    if (!spreadsheetId) throw new Error('Google Sheet URL/ID is not configured.');
    const sheets = getSheetsClient();
    const pending = await prisma.scanTransaction.findMany({
      where: { googleLogSyncedAt: null },
      orderBy: { id: 'asc' },
      include: { person: { select: { firstName: true, lastName: true } } }
    });
    if (!pending.length) return { tabName: LOG_TAB_NAME, rowsAppended: 0, transactionsSynced: 0 };
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    if (!meta.data.sheets?.find((s) => s.properties?.title === LOG_TAB_NAME)) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: LOG_TAB_NAME } } }] } });
    }
    const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:G1` });
    const currentHeader = (headerResp.data.values?.[0] || []).map((cell) => `${cell ?? ''}`.trim());
    const headerMatches = LOG_HEADER.every((value, idx) => (currentHeader[idx] || '') === value);
    if (!headerMatches) {
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:G1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [LOG_HEADER] } });
    }
    const rows = pending.map((tx) => {
      const personName = tx.person ? `${tx.person.firstName} ${tx.person.lastName}`.trim() : (tx.entitlementPersonName || '').trim();
      return [tx.timestamp.toISOString(), tx.scannedValue, tx.mealType, tx.result, tx.failureReason || '', personName, tx.stationName || ''];
    });
    await sheets.spreadsheets.values.append({ spreadsheetId, range: `${LOG_TAB_NAME}!A:G`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: rows } });
    await prisma.scanTransaction.updateMany({ where: { id: { in: pending.map((tx) => tx.id) }, googleLogSyncedAt: null }, data: { googleLogSyncedAt: new Date() } });
    return { tabName: LOG_TAB_NAME, rowsAppended: rows.length, transactionsSynced: rows.length };
  } catch (error) {
    throw mapGoogleSheetsError(error);
  } finally {
    releaseOperationLock('writeback');
  }
}

function getTallyWriteBackMode(settings: Awaited<ReturnType<typeof getSettings>>): 'lifetime' | 'weekly' | 'both' {
  const mode = (settings.tallyWriteBackMode || 'lifetime').toLowerCase();
  if (mode === 'weekly' || mode === 'both') return mode;
  return 'lifetime';
}

function getDateInTimezoneParts(date: Date, timezone: string) {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = dtf.formatToParts(date);
  const year = Number(parts.find((p) => p.type === 'year')?.value || 0);
  const month = Number(parts.find((p) => p.type === 'month')?.value || 0);
  const day = Number(parts.find((p) => p.type === 'day')?.value || 0);
  return { year, month, day };
}

function isoFromParts(p: { year: number; month: number; day: number }) {
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function getCurrentWeekRange(timezone: string, weekStartsOn: 'SUNDAY' | 'MONDAY') {
  const todayParts = getDateInTimezoneParts(new Date(), timezone);
  const d = new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day));
  const day = d.getUTCDay();
  const weekStartIndex = weekStartsOn === 'SUNDAY' ? 0 : 1;
  const diffToStart = (day - weekStartIndex + 7) % 7;
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - diffToStart);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const s = getDateInTimezoneParts(start, 'UTC');
  const e = getDateInTimezoneParts(end, 'UTC');
  return { weekStart: isoFromParts(s), weekEnd: isoFromParts(e) };
}

function normalizeHeaderName(value: string): string {
  return (value || '').trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

function findHeaderIndex(headers: string[], aliases: string[]): number | undefined {
  const normalizedAliases = aliases.map((a) => normalizeHeaderName(a));
  return headers.findIndex((header) => normalizedAliases.includes(normalizeHeaderName(header)));
}

function getTallyHeaderMap(headerRow: string[]): HeaderMap {
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

function assertRequiredHeaders(map: HeaderMap, required: Array<ColumnKey>, label: string) {
  const missing = required.filter((key) => map[key] === undefined);
  if (missing.length) {
    throw new Error(`Missing required ${label} columns: ${missing.join(', ')}.`);
  }
}

function columnNumberToLetter(columnNumber: number): string {
  let n = columnNumber;
  let result = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

async function writeBackWeeklyTally(force: boolean) {
  if (!acquireOperationLock('writeback')) return { writeBackRowsUpdated: 0, rowsAppended: 0, tabName: '' };
  try {
    const settings = await getSettings();
    if (!force && !isWithinMealWindowPlus10Minutes(new Date(), settings.timezone || 'Etc/UTC', settings)) return { writeBackRowsUpdated: 0, rowsAppended: 0, tabName: '' };
    if (!settings.googleSheetsEnabled) return { writeBackRowsUpdated: 0, rowsAppended: 0, tabName: '' };
    const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
    const tabName = (settings.tallyWeeklyRawTabName || '').trim() || 'Weekly Tally Raw';
    const weekStartsOn = settings.tallyWeekStartsOn === 'SUNDAY' ? 'SUNDAY' : 'MONDAY';
    const timezone = settings.timezone || 'Etc/UTC';
    const { weekStart, weekEnd } = getCurrentWeekRange(timezone, weekStartsOn);
    const sheets = getSheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const existingTab = meta.data.sheets?.find((s) => s.properties?.title === tabName);
    if (!existingTab) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] } });
    }
    const existingRowsResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!A:H` });
    const existingRows = (existingRowsResp.data.values || []).map((row) => (row || []).slice(0, 8));
    if (existingRows.length === 0) {
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${tabName}!A1:H1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [WEEKLY_TALLY_HEADER] } });
      existingRows.push([...WEEKLY_TALLY_HEADER]);
    }
    const headerMap = getTallyHeaderMap(existingRows[0] as string[]);
    assertRequiredHeaders(headerMap, ['week_starting', 'id', 'name', 'breakfast', 'lunch', 'dinner', 'total'], 'weekly tally write-back');
    const txns = await prisma.scanTransaction.findMany({
      where: { result: 'SUCCESS', mealType: { in: [MealType.BREAKFAST, MealType.LUNCH, MealType.DINNER] }, personId: { not: null } },
      include: { person: true }
    });
    const grouped = new Map<string, { id: string; name: string; breakfast: number; lunch: number; dinner: number }>();
    for (const t of txns) {
      const d = getDateInTimezoneParts(t.timestamp, timezone);
      const txnDate = isoFromParts(d);
      if (txnDate < weekStart || txnDate > weekEnd) continue;
      if (!t.person?.personId) continue;
      const key = `${t.person.personId}`;
      const current = grouped.get(key) ?? { id: t.person.personId, name: `${t.person.firstName} ${t.person.lastName}`.trim(), breakfast: 0, lunch: 0, dinner: 0 };
      if (t.mealType === MealType.BREAKFAST) current.breakfast += 1;
      if (t.mealType === MealType.LUNCH) current.lunch += 1;
      if (t.mealType === MealType.DINNER) current.dinner += 1;
      grouped.set(key, current);
    }
    const rowByWeekAndId = new Map<string, number>();
    for (let i = 1; i < existingRows.length; i++) {
      const row = existingRows[i] || [];
      const weekValue = String(row[headerMap.week_starting!] || '').trim();
      const idValue = String(row[headerMap.id!] || '').trim();
      if (!weekValue || !idValue) continue;
      rowByWeekAndId.set(`${weekValue}::${idValue}`, i + 1);
    }
    let rowsUpdated = 0; let rowsAppended = 0;
    const appendValues: Array<Array<string | number>> = [];
    for (const item of grouped.values()) {
      const row = [weekStart, weekEnd, item.id, item.name, item.breakfast, item.lunch, item.dinner, item.breakfast + item.lunch + item.dinner];
      const existingRowNumber = rowByWeekAndId.get(`${weekStart}::${item.id}`);
      if (existingRowNumber) {
        const updates = [
          { key: 'breakfast' as const, value: item.breakfast },
          { key: 'lunch' as const, value: item.lunch },
          { key: 'dinner' as const, value: item.dinner },
          { key: 'total' as const, value: item.breakfast + item.lunch + item.dinner }
        ];
        for (const update of updates) {
          const col = headerMap[update.key]!;
          const colLetter = columnNumberToLetter(col + 1);
          await sheets.spreadsheets.values.update({ spreadsheetId, range: `${tabName}!${colLetter}${existingRowNumber}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[update.value]] } });
        }
        rowsUpdated += 1;
      } else {
        appendValues.push(row);
      }
    }
    if (appendValues.length > 0) {
      await sheets.spreadsheets.values.append({ spreadsheetId, range: `${tabName}!A:H`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: appendValues } });
      rowsAppended = appendValues.length;
    }
    const rowsWritten = rowsUpdated + rowsAppended;
    const viewTabName = (settings.tallyWeeklyViewTabName || '').trim();
    if (viewTabName) {
      const viewTab = meta.data.sheets?.find((sh) => sh.properties?.title === viewTabName);
      if (!viewTab) {
        await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: viewTabName } } }] } });
      }
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${viewTabName}!A1:H1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [WEEKLY_TALLY_HEADER] }
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${viewTabName}!A2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[`=IFERROR(FILTER('${tabName}'!A:H,LEN('${tabName}'!A:A)),)`]] }
      });
    }
    return { writeBackRowsUpdated: rowsUpdated, rowsUpdated, rowsAppended, rowsWritten, totalRows: grouped.size, tabName };
  } finally {
    releaseOperationLock('writeback');
  }
}

async function writeBackPeopleRows(useBalances: boolean, force: boolean) {
  if (!acquireOperationLock('writeback')) return { writeBackRowsUpdated: 0 };
  try {
  const settings = await getSettings();
  if (!force && !isWithinMealWindowPlus10Minutes(new Date(), settings.timezone || 'Etc/UTC', settings)) return { writeBackRowsUpdated: 0 };
  if (!settings.googleSheetsEnabled) return { writeBackRowsUpdated: 0 };
  const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
  const sheetName = (settings.googleSheetTabName || DEFAULT_SHEET_TAB_NAME).trim();
  const sheets = getSheetsClient();
  const people = await prisma.person.findMany({ where: { active: true }, orderBy: { personId: 'asc' } });
  const existingRowsResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A:ZZ` });
  const existingRows = existingRowsResp.data.values || [];
  if (existingRows.length === 0) {
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!A1:F1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [TALLY_HEADER] } });
    existingRows.push([...TALLY_HEADER]);
  }
  const headerMap = getTallyHeaderMap(existingRows[0] as string[]);
  assertRequiredHeaders(headerMap, ['id', 'name', 'breakfast', 'lunch', 'dinner', 'total'], 'tally write-back');
  const peopleById = new Map(people.map((p) => {
    const b = useBalances ? p.breakfastRemaining : p.breakfastCount;
    const l = useBalances ? p.lunchRemaining : p.lunchCount;
    const d = useBalances ? p.dinnerRemaining : p.dinnerCount;
    return [p.personId, { id: p.personId, name: `${p.firstName} ${p.lastName}`.trim(), breakfast: b, lunch: l, dinner: d, total: b + l + d }];
  }));
  const rowById = new Map<string, number>();
  for (let i = 1; i < existingRows.length; i++) {
    const id = String((existingRows[i] || [])[headerMap.id!] || '').trim();
    if (id) rowById.set(id, i + 1);
  }
  let rowsUpdated = 0;
  const appendValues: Array<Array<string | number>> = [];
  for (const [id, tally] of peopleById.entries()) {
    const rowNum = rowById.get(id);
    if (!rowNum) {
      appendValues.push([tally.id, tally.name, tally.breakfast, tally.lunch, tally.dinner, tally.total]);
      continue;
    }
    for (const key of TALLY_COUNT_COLUMNS) {
      const colIndex = headerMap[key]!;
      const colLetter = columnNumberToLetter(colIndex + 1);
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!${colLetter}${rowNum}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[tally[key]]] } });
    }
    rowsUpdated += 1;
  }
  if (appendValues.length > 0) {
    await sheets.spreadsheets.values.append({ spreadsheetId, range: `${sheetName}!A:F`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: appendValues } });
  }
  return { writeBackRowsUpdated: rowsUpdated + appendValues.length, rowsAppended: appendValues.length };
  } finally {
    releaseOperationLock('writeback');
  }
}

export async function flushCampMeetingRedemptionsToSheet(force = false) {
  if (!acquireOperationLock('writeback')) return { writeBackRowsUpdated: 0 };
  try {
  const settings = await getSettings();
  if (settings.mealTrackingMode !== MealTrackingMode.camp_meeting) return { writeBackRowsUpdated: 0 };
  if (!force && !isWithinMealWindowPlus10Minutes(new Date(), settings.timezone || 'Etc/UTC', settings)) return { writeBackRowsUpdated: 0 };
  const pending = await prisma.mealEntitlement.findMany({ where: { redeemed: true, sourceSheetRow: { not: null }, sheetSyncedAt: null } });
  console.log(`[SHEET_SYNC] Camp Meeting pending redeemed rows (sheetSyncedAt=null): ${pending.length}`);
  if (!pending.length) return { writeBackRowsUpdated: 0 };
  if (!settings.googleSheetsEnabled) return { writeBackRowsUpdated: 0 };
  const sheets = getSheetsClient();
  const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
  const sheetName = (settings.googleSheetTabName || DEFAULT_SHEET_TAB_NAME).trim();
  if (!spreadsheetId) throw new Error('Google Sheet URL/ID is not configured.');
  if (!sheetName) throw new Error('Missing worksheet/tab name in Settings.');
  for (const row of pending) {
    const r = row.sourceSheetRow!;
    try {
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: [
        { range: `${sheetName}!I${r}:K${r}`, values: [['yes', row.redeemedAt?.toISOString() || new Date().toISOString(), row.redeemedBy || row.personName || '']] }
      ] } });
    } catch (error) {
      throw mapGoogleSheetsError(error);
    }
    await prisma.mealEntitlement.update({ where: { id: row.id }, data: { sheetSyncedAt: new Date() } });
  }
  return { writeBackRowsUpdated: pending.length };
  } finally {
    releaseOperationLock('writeback');
  }
}

export function startCampMeetingSheetSyncScheduler() {
  console.log('[SHEET_SYNC] Scheduler started');
  schedulerStatus.schedulerEnabled = true;
  const run = async () => {
    try {
      const settings = await getSettings();
      const now = new Date();
      const intervalMinutes = Math.max(1, settings.googleSyncIntervalMinutes ?? 5);
      const timezone = settings.timezone || 'Etc/UTC';
      const activeWindow = calculateActiveWindow(now, timezone, settings);
      schedulerStatus.lastAutomaticCheckTime = now.toISOString();
      const skipReason = getSchedulerSkipReason(settings);
      console.log(
        `[SHEET_SYNC] cycle ts=${now.toISOString()} intervalMin=${intervalMinutes} mode=${settings.mealTrackingMode} enabled=${settings.googleSheetsEnabled} sheetIdPresent=${Boolean(parseSpreadsheetId(settings.googleSheetId || ''))} localTime=${getLocalTimeHHMM(now, timezone)} tz=${timezone} activeMealWindow=${Boolean(activeWindow)} activeWindow=${activeWindow ?? 'none'} skipReason=${skipReason ?? 'none'}`
      );
      if (skipReason) {
        if (skipReason === 'import already running') console.log('[SHEET_SYNC] skipped: import already running');
        if (skipReason === 'reset in progress') console.log('[SHEET_SYNC] skipped: reset in progress');
        console.log(`[SHEET_SYNC] skipped: ${skipReason}`);
        schedulerStatus.lastSkipReason = skipReason;
        schedulerStatus.lastRowsUpdated = 0;
      } else {
        await runAutoImportForMode(settings);
        console.log('[SHEET_SYNC] Running scheduled write-back');
        let result: { writeBackRowsUpdated?: number } | void = { writeBackRowsUpdated: 0 };
        if (settings.mealTrackingMode === MealTrackingMode.camp_meeting) result = await writeBackCampMeetingRedemptions(false);
        if (settings.mealTrackingMode === MealTrackingMode.tally) {
          const tallyMode = getTallyWriteBackMode(settings);
          if (tallyMode === 'weekly' || tallyMode === 'both') await writeBackWeeklyTally(false);
          if (tallyMode === 'lifetime' || tallyMode === 'both') result = await writeBackTallyCounts(false);
        }
        if (settings.mealTrackingMode === MealTrackingMode.countdown) result = await writeBackCountdownBalances(false);
        try {
          await syncTransactionLogToSheet();
        } catch (error) {
          console.error('[SHEET_SYNC] LOG sync failed during scheduler cycle', error);
        }
        const rowsUpdated = result?.writeBackRowsUpdated ?? 0;
        if (settings.mealTrackingMode === MealTrackingMode.camp_meeting && rowsUpdated === 0) {
          console.log('[SHEET_SYNC] Completed scheduled write-back: 0 rows updated (no pending redemptions)');
        } else {
          console.log(`[SHEET_SYNC] Completed scheduled write-back: ${rowsUpdated} rows updated`);
        }
        schedulerStatus.lastAutomaticWriteBackTime = now.toISOString();
        schedulerStatus.lastSkipReason = null;
        schedulerStatus.lastRowsUpdated = rowsUpdated;
      }
    } catch (e) {
      console.error('[SHEET_SYNC]', e);
    } finally {
      const settings = await getSettings().catch(() => null);
      const intervalMinutes = Math.max(1, settings?.googleSyncIntervalMinutes ?? 5);
      schedulerStatus.nextExpectedRunTime = new Date(Date.now() + (intervalMinutes * 60 * 1000)).toISOString();
      setTimeout(() => {
        void run();
      }, intervalMinutes * 60 * 1000);
    }
  };
  void run();
}

export async function runGoogleSheetsSyncSchedulerCheckNow() {
  const settings = await getSettings();
  const now = new Date();
  const intervalMinutes = Math.max(1, settings.googleSyncIntervalMinutes ?? 5);
  const timezone = settings.timezone || 'Etc/UTC';
  const activeWindow = calculateActiveWindow(now, timezone, settings);
  schedulerStatus.lastAutomaticCheckTime = now.toISOString();
  const skipReason = getSchedulerSkipReason(settings);
  console.log(
    `[SHEET_SYNC] manual-cycle ts=${now.toISOString()} intervalMin=${intervalMinutes} mode=${settings.mealTrackingMode} enabled=${settings.googleSheetsEnabled} sheetIdPresent=${Boolean(parseSpreadsheetId(settings.googleSheetId || ''))} localTime=${getLocalTimeHHMM(now, timezone)} tz=${timezone} activeMealWindow=${Boolean(activeWindow)} activeWindow=${activeWindow ?? 'none'} skipReason=${skipReason ?? 'none'}`
  );
  if (skipReason) {
    console.log(`[SHEET_SYNC] skipped: ${skipReason}`);
    schedulerStatus.lastSkipReason = skipReason;
    schedulerStatus.lastRowsUpdated = 0;
    schedulerStatus.nextExpectedRunTime = new Date(Date.now() + (intervalMinutes * 60 * 1000)).toISOString();
    return { ran: false, reason: skipReason, mode: settings.mealTrackingMode };
  }
  await runAutoImportForMode(settings);
  console.log('[SHEET_SYNC] Running scheduled write-back');
  let result: { writeBackRowsUpdated?: number } | void = { writeBackRowsUpdated: 0 };
  if (settings.mealTrackingMode === MealTrackingMode.camp_meeting) result = await writeBackCampMeetingRedemptions(false);
  if (settings.mealTrackingMode === MealTrackingMode.tally) {
    const tallyMode = getTallyWriteBackMode(settings);
    if (tallyMode === 'weekly' || tallyMode === 'both') await writeBackWeeklyTally(false);
    if (tallyMode === 'lifetime' || tallyMode === 'both') result = await writeBackTallyCounts(false);
  }
  if (settings.mealTrackingMode === MealTrackingMode.countdown) result = await writeBackCountdownBalances(false);
  try {
    await syncTransactionLogToSheet();
  } catch (error) {
    console.error('[SHEET_SYNC] LOG sync failed during manual scheduler check', error);
  }
  const rowsUpdated = result?.writeBackRowsUpdated ?? 0;
  if (settings.mealTrackingMode === MealTrackingMode.camp_meeting && rowsUpdated === 0) {
    console.log('[SHEET_SYNC] Completed scheduled write-back: 0 rows updated (no pending redemptions)');
  } else {
    console.log(`[SHEET_SYNC] Completed scheduled write-back: ${rowsUpdated} rows updated`);
  }
  schedulerStatus.lastAutomaticWriteBackTime = now.toISOString();
  schedulerStatus.lastSkipReason = null;
  schedulerStatus.lastRowsUpdated = rowsUpdated;
  schedulerStatus.nextExpectedRunTime = new Date(Date.now() + (intervalMinutes * 60 * 1000)).toISOString();
  return { ran: true, rowsUpdated, mode: settings.mealTrackingMode };
}

export async function getGoogleSheetsSchedulerStatus() {
  const settings = await getSettings().catch(() => null);
  return {
    ...schedulerStatus,
    lastAutomaticImportTime: schedulerStatus.lastAutomaticImportTime ?? settings?.googleLastAutoImportAt?.toISOString() ?? null,
    lastAutomaticImportSummary: schedulerStatus.lastAutomaticImportSummary ?? settings?.googleLastAutoImportSummary ?? null
  };
}
