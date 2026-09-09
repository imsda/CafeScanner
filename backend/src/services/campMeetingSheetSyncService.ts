import { MealDay, MealTrackingMode, MealType } from '@prisma/client';
import { parsePersonType, peopleSheetRows } from './peopleSheetRows.js';
import { google } from 'googleapis';
import { getSettings } from './settingsService.js';
import { prisma } from '../db.js';
import { importCampMeetingRows, mapRowsToCampMeetingInput } from './campMeetingImportService.js';
import { acquireOperationLock, isImportInProgress, isResetInProgress, isSchedulerPaused, isWritebackInProgress, releaseOperationLock } from './operationLockService.js';

const HEADER = ['ticket_id','reg_id','guest_name','meal_type','meal_day','meal_date','ticket_type','price','redeemed','redeemed_at','redeemed_by','notes'];
const TALLY_HEADER = ['id', 'name', 'breakfast', 'lunch', 'dinner', 'total'];
const WEEKLY_TALLY_HEADER = ['Week Starting', 'Week Ending', 'ID', 'Name', 'Breakfast', 'Lunch', 'Dinner', 'Total'];
const LOG_TAB_NAME = 'LOG';
const LOG_HEADER = ['Time', 'Value', 'Meal', 'Result', 'Reason', 'Person', 'Station', 'Transaction ID'];
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
  lastSyncError: string | null;
  lastCycleDurationMs: number | null;
  lastLogSyncTime: string | null;
  lastRowsUpdated: number;
  lastCampMeetingWriteBackError: string | null;
  lastScheduledCycleOrder: string | null;
  nextExpectedRunTime: string | null;
};

const schedulerStatus: SchedulerStatus = {
  schedulerEnabled: false,
  lastAutomaticCheckTime: null,
  lastAutomaticWriteBackTime: null,
  lastAutomaticImportTime: null,
  lastAutomaticImportSummary: null,
  lastSkipReason: null,
  lastSyncError: null,
  lastCycleDurationMs: null,
  lastLogSyncTime: null,
  lastRowsUpdated: 0,
  lastCampMeetingWriteBackError: null,
  lastScheduledCycleOrder: null,
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

  if (status === 429) return new Error('Google Sheets write quota exceeded (429). Wait a minute before retrying. Local scans are saved.');
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
  const dataRows = peopleSheetRows(rows as string[][]);
  return importPeopleFromRows(dataRows, { includeBalances: false, overwriteExistingBalances: false, overwriteExistingCounts: true });
}

export async function importCountdownFromSheet() {
  if (isResetInProgress()) throw new Error('Reset in progress. Try again after reset completes.');
  const { rows } = await readSheetRows();
  const dataRows = peopleSheetRows(rows as string[][]);
  return importPeopleFromRows(dataRows, { includeBalances: true, overwriteExistingBalances: true, overwriteExistingCounts: true });
}

async function readSheetRows() {
  const settings = await getSettings();
  if (!settings.googleSheetsEnabled) throw new Error('Google Sheets sync is disabled in Settings.');
  const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
  const sheetName = (settings.googleSheetTabName || DEFAULT_SHEET_TAB_NAME).trim();
  const range = `${sheetName}!A:ZZ`;
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return { spreadsheetId, sheetName, rows: resp.data.values || [] };
}

export async function importPeopleFromRows(dataRows: string[][], options: { includeBalances: boolean; overwriteExistingBalances: boolean; overwriteExistingCounts: boolean }) {
  if (!acquireOperationLock('import')) throw new Error('Import already in progress.');
  try {
  let peopleCreated = 0; let peopleUpdated = 0; let rowsImported = 0; let rowsSkipped = 0;
  const errors: string[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i] as string[];
    const id = (r[0] || '').trim();
    const name = (r[1] || '').trim();
    if (!id) { rowsSkipped += 1; errors.push(`Row ${i + 2}: missing ID`); continue; }
    let personType;
    try { personType = parsePersonType(r[6] || ''); }
    catch (error) { rowsSkipped += 1; errors.push(`Row ${i + 2}: ${error instanceof Error ? error.message : 'Invalid User Type'}`); continue; }
    const existing = await prisma.person.findFirst({ where: { OR: [{ personId: id }, { codeValue: id }] }, select: { id: true } });
    const breakfast = Number(r[2] || 0); const lunch = Number(r[3] || 0); const dinner = Number(r[4] || 0);
    const total = breakfast + lunch + dinner;
    const data: any = { personId: id, codeValue: id, firstName: name || id, lastName: ' ', active: true, ...(personType ? { personType } : {}) };
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
  const dataRows = peopleSheetRows(rows as string[][]);
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
const formattedLogSheets = new Set<string>();

export async function syncTransactionLogToSheet() {
  if (!acquireOperationLock('writeback')) {
    throw new Error('Another sheet sync is running. Please try again shortly.');
  }
  try {
    console.log('[SHEET_SYNC][LOG] Starting LOG sync');
    const settings = await getSettings();
    if (!settings.googleSheetsEnabled) throw new Error('Google Sheets sync is disabled in Settings.');
    const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
    if (!spreadsheetId) throw new Error('Google Sheet URL/ID is not configured.');
    const sheets = getSheetsClient();

    const transactions = await prisma.scanTransaction.findMany({
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      include: { person: { select: { firstName: true, lastName: true } } }
    });
    console.log(`[SHEET_SYNC][LOG] Loaded local transactions: ${transactions.length}`);

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const logTab = meta.data.sheets?.find((s) => s.properties?.title === LOG_TAB_NAME);
    if (!logTab) {
      console.log('[SHEET_SYNC][LOG] LOG tab missing; creating tab');
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: LOG_TAB_NAME } } }] } });
    }

    const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:H1` });
    const currentHeader = (headerResp.data.values?.[0] || []).map((cell) => `${cell ?? ''}`.trim());
    const transactionIdHeaderIndex = currentHeader.findIndex((value) => value === 'Transaction ID');
    const headerMatches = LOG_HEADER.every((value, idx) => (currentHeader[idx] || '') === value);
    if (!headerMatches) {
      if (transactionIdHeaderIndex === -1) {
        console.log('[SHEET_SYNC][LOG] Transaction ID header missing; writing canonical LOG header with Transaction ID after Station');
      } else {
        console.log('[SHEET_SYNC][LOG] LOG header mismatch; normalizing header');
      }
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:H1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [LOG_HEADER] } });
    }

    const refreshedMeta = logTab ? meta : await sheets.spreadsheets.get({ spreadsheetId });
    const logSheetId = refreshedMeta.data.sheets?.find((s) => s.properties?.title === LOG_TAB_NAME)?.properties?.sheetId;
    if (typeof logSheetId === 'number' && !formattedLogSheets.has(spreadsheetId)) {
      const transactionIdColumnIndex = 7;
      console.log('[SHEET_SYNC][LOG] Hiding Transaction ID column');
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            updateDimensionProperties: {
              range: { sheetId: logSheetId, dimension: 'COLUMNS', startIndex: transactionIdColumnIndex, endIndex: transactionIdColumnIndex + 1 },
              properties: { hiddenByUser: true },
              fields: 'hiddenByUser'
            }
          }]
        }
      });
    }

    if (typeof logSheetId === 'number') formattedLogSheets.add(spreadsheetId);
    console.log('[SHEET_SYNC][LOG] Reading existing LOG rows');
    const logResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${LOG_TAB_NAME}!A2:H` });
    const logRows = (logResp.data.values || []) as string[][];
    const existingTransactionIds = new Set(
      logRows
        .map((row) => `${row[7] ?? ''}`.trim())
        .filter((value) => value.length > 0)
    );
    console.log(`[SHEET_SYNC][LOG] Existing LOG rows: ${logRows.length}; transaction IDs found: ${existingTransactionIds.size}`);

    const missingTransactions = transactions.filter((tx) => !existingTransactionIds.has(String(tx.id)));
    const rowsToAppend = missingTransactions.map((tx) => {
      const personName = tx.person ? `${tx.person.firstName} ${tx.person.lastName}`.trim() : (tx.entitlementPersonName || '').trim();
      return [tx.timestamp.toISOString(), tx.scannedValue, tx.mealType, tx.result, tx.failureReason || '', personName, tx.stationName || '', String(tx.id)];
    });

    // Keep existing LOG rows intact. A failed append can be retried by Transaction ID.
    for (let offset = 0; offset < rowsToAppend.length; offset += 1000) {
      await sheets.spreadsheets.values.append({
        spreadsheetId, range: `${LOG_TAB_NAME}!A:H`, valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS', requestBody: { values: rowsToAppend.slice(offset, offset + 1000) }
      });
    }
    console.log(`[SHEET_SYNC] totalTransactions=${transactions.length} logRowsFound=${logRows.length} existingTransactionIds=${existingTransactionIds.size} missingTransactions=${missingTransactions.length} rowsAppended=${rowsToAppend.length}`);

    const presentTransactionIds = new Set<string>([...existingTransactionIds, ...missingTransactions.map((tx) => String(tx.id))]);
    const unsyncedPresentTransactionIds = transactions.filter((tx) => tx.googleLogSyncedAt === null && presentTransactionIds.has(String(tx.id))).map((tx) => tx.id);
    if (unsyncedPresentTransactionIds.length) {
      await prisma.scanTransaction.updateMany({ where: { id: { in: unsyncedPresentTransactionIds }, googleLogSyncedAt: null }, data: { googleLogSyncedAt: new Date() } });
    }

    const reason = rowsToAppend.length === 0 ? (transactions.length === 0 ? 'No local ScanTransaction rows exist.' : 'No missing transactions found; LOG already includes every local Transaction ID.') : '';
    const result = {
      tabName: LOG_TAB_NAME,
      totalTransactions: transactions.length,
      logRowCount: transactions.length,
      existingLogRows: logRows.length,
      existingLogTransactionIds: existingTransactionIds.size,
      missingTransactionsFound: missingTransactions.length,
      rowsAppended: rowsToAppend.length,
      rowsRecreated: missingTransactions.length,
      duplicatesSkipped: transactions.length - missingTransactions.length,
      transactionsMarkedSynced: unsyncedPresentTransactionIds.length,
      transactionsSynced: unsyncedPresentTransactionIds.length,
      reason
    };
    schedulerStatus.lastLogSyncTime = new Date().toISOString();
    console.log('[SHEET_SYNC][LOG] Sync complete', result);
    return result;
  } catch (error) {
    throw mapGoogleSheetsError(error);
  } finally {
    releaseOperationLock('writeback');
  }
}

export async function rebuildTransactionLogFromDatabase() {
  if (!acquireOperationLock('writeback')) {
    return { tabName: LOG_TAB_NAME, totalTransactions: 0, rowsRebuilt: 0, reason: 'Writeback lock unavailable.' };
  }
  try {
    const settings = await getSettings();
    if (!settings.googleSheetsEnabled) throw new Error('Google Sheets sync is disabled in Settings.');
    const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
    if (!spreadsheetId) throw new Error('Google Sheet URL/ID is not configured.');
    const sheets = getSheetsClient();
    const transactions = await prisma.scanTransaction.findMany({
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      include: { person: { select: { firstName: true, lastName: true } } }
    });

    const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:H1` });
    const currentHeader = (headerResp.data.values?.[0] || []).map((cell) => `${cell ?? ''}`.trim());
    const headerMatches = LOG_HEADER.every((value, idx) => (currentHeader[idx] || '') === value);
    if (!headerMatches) {
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:H1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [LOG_HEADER] } });
    }

    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${LOG_TAB_NAME}!A2:H` });
    const values = transactions.map((tx) => {
      const personName = tx.person ? `${tx.person.firstName} ${tx.person.lastName}`.trim() : (tx.entitlementPersonName || '').trim();
      return [tx.timestamp.toISOString(), tx.scannedValue, tx.mealType, tx.result, tx.failureReason || '', personName, tx.stationName || '', String(tx.id)];
    });
    if (values.length) {
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${LOG_TAB_NAME}!A2:H`, valueInputOption: 'USER_ENTERED', requestBody: { values } });
    }
    await prisma.scanTransaction.updateMany({ where: { googleLogSyncedAt: null }, data: { googleLogSyncedAt: new Date() } });
    return { tabName: LOG_TAB_NAME, totalTransactions: transactions.length, rowsRebuilt: values.length };
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

function getWeekRangeForDate(date: Date, timezone: string, weekStartsOn: 'SUNDAY' | 'MONDAY') {
  const dateParts = getDateInTimezoneParts(date, timezone);
  const d = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day));
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
  const index = headers.findIndex((header) => normalizedAliases.includes(normalizeHeaderName(header)));
  return index < 0 ? undefined : index;
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
  if (!acquireOperationLock('writeback')) {
    if (force) throw new Error('Another sheet sync is running. Please try again shortly.');
    return { writeBackRowsUpdated: 0, rowsAppended: 0, tabName: '' };
  }
  try {
    const settings = await getSettings();
    if (!force && !isWithinMealWindowPlus10Minutes(new Date(), settings.timezone || 'Etc/UTC', settings)) return { writeBackRowsUpdated: 0, rowsAppended: 0, tabName: '' };
    if (!settings.googleSheetsEnabled) return { writeBackRowsUpdated: 0, rowsAppended: 0, tabName: '' };
    const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
    const tabName = (settings.tallyWeeklyRawTabName || '').trim() || 'Weekly Tally Raw';
    const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
    const weekStartsOn = settings.tallyWeekStartsOn === 'SUNDAY' ? 'SUNDAY' : 'MONDAY';
    const timezone = settings.timezone || 'Etc/UTC';
    const sheets = getSheetsClient();
    let meta = await sheets.spreadsheets.get({ spreadsheetId });
    let existingTab = meta.data.sheets?.find((s) => s.properties?.title === tabName);
    if (!existingTab) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] } });
      meta = await sheets.spreadsheets.get({ spreadsheetId });
      existingTab = meta.data.sheets?.find((s) => s.properties?.title === tabName);
    }
    const existingRowsResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${quotedTab}!A:ZZ`, valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });
    const existingRows = (existingRowsResp.data.values || []).map((row) => (row || []));
    if (existingRows.length === 0) {
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${quotedTab}!A1:H1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [WEEKLY_TALLY_HEADER] } });
      existingRows.push([...WEEKLY_TALLY_HEADER]);
    }
    const headerMap = getTallyHeaderMap(existingRows[0] as string[]);
    assertRequiredHeaders(headerMap, ['week_starting', 'week_ending', 'id', 'name', 'breakfast', 'lunch', 'dinner', 'total'], 'weekly tally write-back');

    const txns = await prisma.scanTransaction.findMany({
      where: { result: 'SUCCESS', mealType: { in: [MealType.BREAKFAST, MealType.LUNCH, MealType.DINNER] }, personId: { not: null } },
      include: { person: true }
    });

    const grouped = new Map<string, { weekStart: string; weekEnd: string; id: string; name: string; breakfast: number; lunch: number; dinner: number }>();
    const weeksCovered = new Set<string>();
    for (const t of txns) {
      if (!t.person?.personId) continue;
      const { weekStart, weekEnd } = getWeekRangeForDate(t.timestamp, timezone, weekStartsOn);
      weeksCovered.add(weekStart);
      const key = `${weekStart}::${t.person.personId}`;
      const current = grouped.get(key) ?? { weekStart, weekEnd, id: t.person.personId, name: `${t.person.firstName} ${t.person.lastName}`.trim(), breakfast: 0, lunch: 0, dinner: 0 };
      if (t.mealType === MealType.BREAKFAST) current.breakfast += 1;
      if (t.mealType === MealType.LUNCH) current.lunch += 1;
      if (t.mealType === MealType.DINNER) current.dinner += 1;
      grouped.set(key, current);
    }

    const rowByWeekAndId = new Map<string, number>();
    const duplicateRowsFound: Array<{ key: string; rows: number[] }> = [];
    for (let i = 1; i < existingRows.length; i++) {
      const row = existingRows[i] || [];
      const rawWeek = row[headerMap.week_starting!];
      const weekValue = typeof rawWeek === 'number'
        ? new Date(Date.UTC(1899, 11, 30) + Math.round(rawWeek) * 86400000).toISOString().slice(0, 10)
        : String(rawWeek || '').trim();
      const idValue = String(row[headerMap.id!] || '').trim();
      if (!weekValue || !idValue) continue;
      const key = `${weekValue}::${idValue}`;
      if (rowByWeekAndId.has(key)) {
        const firstRow = rowByWeekAndId.get(key)!;
        duplicateRowsFound.push({ key, rows: [firstRow, i + 1] });
        continue;
      }
      rowByWeekAndId.set(key, i + 1);
    }

    let rowsUpdated = 0; let rowsAppended = 0;
    const appendValues: Array<Array<string | number>> = [];
    const updates: Array<{ range: string; values: Array<Array<string | number>> }> = [];
    const dateSerial = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
    for (const item of grouped.values()) {
      const existingRowNumber = rowByWeekAndId.get(`${item.weekStart}::${item.id}`);
      const values = {
        week_starting: dateSerial(item.weekStart), week_ending: dateSerial(item.weekEnd),
        id: item.id, name: item.name, breakfast: item.breakfast, lunch: item.lunch,
        dinner: item.dinner, total: item.breakfast + item.lunch + item.dinner
      };
      if (existingRowNumber) {
        for (const key of Object.keys(values) as Array<keyof typeof values>) {
          const colLetter = columnNumberToLetter(headerMap[key]! + 1);
          const existing = existingRows[existingRowNumber - 1]?.[headerMap[key]!];
          const normalized = (key === 'week_starting' || key === 'week_ending') && typeof existing === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(existing)
            ? dateSerial(existing) : existing;
          if (String(normalized ?? '') === String(values[key])) continue;
          updates.push({ range: `${quotedTab}!${colLetter}${existingRowNumber}`, values: [[values[key]]] });
        }
        rowsUpdated += 1;
      } else {
        const row: Array<string | number> = Array(existingRows[0].length).fill('');
        for (const key of Object.keys(values) as Array<keyof typeof values>) row[headerMap[key]!] = values[key];
        appendValues.push(row);
      }
    }
    // Batch writes instead of consuming one API request per cell.
    for (let offset = 0; offset < updates.length; offset += 1000) {
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data: updates.slice(offset, offset + 1000) } });
    }
    if (appendValues.length > 0) {
      await sheets.spreadsheets.values.append({ spreadsheetId, range: `${quotedTab}!A:${columnNumberToLetter(existingRows[0].length)}`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: appendValues } });
      rowsAppended = appendValues.length;
    }

    if (existingTab?.properties?.sheetId !== undefined) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            repeatCell: {
              range: { sheetId: existingTab.properties.sheetId, startRowIndex: 1, startColumnIndex: headerMap.week_starting, endColumnIndex: (headerMap.week_starting ?? 0) + 1 },
              cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
              fields: 'userEnteredFormat.numberFormat'
            }
          }, {
            repeatCell: {
              range: { sheetId: existingTab.properties.sheetId, startRowIndex: 1, startColumnIndex: headerMap.week_ending, endColumnIndex: (headerMap.week_ending ?? 0) + 1 },
              cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
              fields: 'userEnteredFormat.numberFormat'
            }
          }]
        }
      });
    }

    const rowsWritten = rowsUpdated + rowsAppended;
    return { writeBackRowsUpdated: rowsWritten, rowsUpdated, rowsAppended, rowsWritten, tabName, expectedRows: grouped.size, duplicateRowsFound: duplicateRowsFound.length, duplicateRowDetails: duplicateRowsFound, weeksCovered: Array.from(weeksCovered).sort() };
  } finally {
    releaseOperationLock('writeback');
  }
}

async function writeBackPeopleRows(useBalances: boolean, force: boolean) {
  if (!acquireOperationLock('writeback')) {
    if (force) throw new Error('Another sheet sync is running. Please try again shortly.');
    return { writeBackRowsUpdated: 0 };
  }
  try {
  const settings = await getSettings();
  if (!force && !isWithinMealWindowPlus10Minutes(new Date(), settings.timezone || 'Etc/UTC', settings)) return { writeBackRowsUpdated: 0 };
  if (!settings.googleSheetsEnabled) return { writeBackRowsUpdated: 0 };
  const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
  const sheetName = (settings.googleSheetTabName || DEFAULT_SHEET_TAB_NAME).trim();
  const quotedSheet = `'${sheetName.replace(/'/g, "''")}'`;
  const sheets = getSheetsClient();
  const people = await prisma.person.findMany({ where: { active: true }, orderBy: { personId: 'asc' } });
  const existingRowsResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${quotedSheet}!A:ZZ` });
  const existingRows = existingRowsResp.data.values || [];
  if (existingRows.length === 0) {
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${quotedSheet}!A1:F1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [TALLY_HEADER] } });
    existingRows.push([...TALLY_HEADER]);
  }
  if (!useBalances && !existingRows[0].some((cell) => ['usertype', 'persontype'].includes(String(cell).toLowerCase().replace(/[ _-]/g, '')))) {
    const column = columnNumberToLetter(existingRows[0].length + 1);
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${quotedSheet}!${column}1`, valueInputOption: 'RAW', requestBody: { values: [['User Type']] } });
    existingRows[0].push('User Type');
  }
  const typeColumn = existingRows[0].findIndex((cell) => ['usertype', 'persontype'].includes(String(cell).toLowerCase().replace(/[ _-]/g, '')));
  const headerMap = getTallyHeaderMap(existingRows[0] as string[]);
  assertRequiredHeaders(headerMap, ['id', 'name', 'breakfast', 'lunch', 'dinner', 'total'], 'tally write-back');
  const peopleById = new Map(people.map((p) => {
    const b = useBalances ? p.breakfastRemaining : p.breakfastCount;
    const l = useBalances ? p.lunchRemaining : p.lunchCount;
    const d = useBalances ? p.dinnerRemaining : p.dinnerCount;
    return [p.personId, { id: p.personId, name: `${p.firstName} ${p.lastName}`.trim(), breakfast: b, lunch: l, dinner: d, total: b + l + d, personType: p.personType }];
  }));
  const rowById = new Map<string, number>();
  for (let i = 1; i < existingRows.length; i++) {
    const id = String((existingRows[i] || [])[headerMap.id!] || '').trim();
    if (id) rowById.set(id, i + 1);
  }
  let rowsUpdated = 0;
  const updates: Array<{ range: string; values: Array<Array<string | number>> }> = [];
  for (const [id, tally] of peopleById.entries()) {
    const rowNum = rowById.get(id);
    // The sheet owns the roster. Database-only people must not be added back.
    if (!rowNum) continue;
    for (const key of TALLY_COUNT_COLUMNS) {
      const colIndex = headerMap[key]!;
      const colLetter = columnNumberToLetter(colIndex + 1);
      const current = existingRows[rowNum - 1]?.[colIndex];
      if (current !== '' && current !== undefined && Number(current) === tally[key]) continue;
      updates.push({ range: `${quotedSheet}!${colLetter}${rowNum}`, values: [[tally[key]]] });
    }
    rowsUpdated += 1;
  }
  for (let offset = 0; offset < updates.length; offset += 1000) {
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data: updates.slice(offset, offset + 1000) } });
  }
  console.log(`[SHEET_SYNC][TOTALS] tab=${sheetName} people=${people.length} matched=${rowsUpdated} changedCells=${updates.length}`);
  return { writeBackRowsUpdated: rowsUpdated, rowsAppended: 0 };
  } finally {
    releaseOperationLock('writeback');
  }
}

export async function flushCampMeetingRedemptionsToSheet(force = false) {
  if (!acquireOperationLock('writeback')) {
    console.log('[SHEET_SYNC] skipped: sync already running');
    return { writeBackRowsUpdated: 0 };
  }
  try {
  const settings = await getSettings();
  if (settings.mealTrackingMode !== MealTrackingMode.camp_meeting) return { writeBackRowsUpdated: 0 };
  if (!force && !isWithinMealWindowPlus10Minutes(new Date(), settings.timezone || 'Etc/UTC', settings)) return { writeBackRowsUpdated: 0 };
  const pending = await prisma.mealEntitlement.findMany({ where: { redeemed: true, sheetSyncedAt: null } });
  console.log(`[SHEET_SYNC] Camp Meeting pending redeemed rows (sheetSyncedAt=null): ${pending.length}`);
  if (!pending.length) return { writeBackRowsUpdated: 0 };
  if (!settings.googleSheetsEnabled) return { writeBackRowsUpdated: 0 };
  const sheets = getSheetsClient();
  const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
  const sheetName = (settings.googleSheetTabName || DEFAULT_SHEET_TAB_NAME).trim();
  if (!spreadsheetId) throw new Error('Google Sheet URL/ID is not configured.');
  if (!sheetName) throw new Error('Missing worksheet/tab name in Settings.');
  for (const row of pending) {
    const r = row.sourceSheetRow;
    const targetSheetRow = r ?? 'not-found';
    const ticketId = (row.notes || '').match(/ticket_id=([^,\s]+)/)?.[1] || '';
    if (!r) {
      console.log(`[SHEET_SYNC][CAMP_WRITEBACK] pendingRedemptions=${pending.length} entitlementId=${row.id} ticket_id=${ticketId} personName=${row.personName || ''} sourceRowKey=${row.sourceTicketId || ''} targetSheetRow=${targetSheetRow} updatedColumns=none failure=missing_source_row`);
      continue;
    }
    try {
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: [
        { range: `${sheetName}!I${r}:K${r}`, values: [['yes', row.redeemedAt?.toISOString() || new Date().toISOString(), row.redeemedBy || row.personName || '']] }
      ] } });
      console.log(`[SHEET_SYNC][CAMP_WRITEBACK] pendingRedemptions=${pending.length} entitlementId=${row.id} ticket_id=${ticketId} personName=${row.personName || ''} sourceRowKey=${row.sourceTicketId || ''} targetSheetRow=${r} updatedColumns=I:K success=true`);
    } catch (error) {
      console.log(`[SHEET_SYNC][CAMP_WRITEBACK] pendingRedemptions=${pending.length} entitlementId=${row.id} ticket_id=${ticketId} personName=${row.personName || ''} sourceRowKey=${row.sourceTicketId || ''} targetSheetRow=${r} updatedColumns=I:K success=false`);
      throw mapGoogleSheetsError(error);
    }
    await prisma.mealEntitlement.update({ where: { id: row.id }, data: { sheetSyncedAt: new Date() } });
  }
  return { writeBackRowsUpdated: pending.length };
  } finally {
    releaseOperationLock('writeback');
  }
}

let schedulerCycleRunning = false;

export function startCampMeetingSheetSyncScheduler() {
  if (schedulerStatus.schedulerEnabled) return;
  schedulerStatus.schedulerEnabled = true;
  console.log('[SHEET_SYNC] Scheduler started');
  const run = async () => {
    try { await runGoogleSheetsSyncSchedulerCheckNow(); }
    catch (error) { console.error('[SHEET_SYNC]', error instanceof Error ? error.message : String(error)); }
    finally {
      const settings = await getSettings().catch(() => null);
      const delay = Math.max(1, settings?.googleSyncIntervalMinutes ?? 5) * 60000;
      schedulerStatus.nextExpectedRunTime = new Date(Date.now() + delay).toISOString();
      setTimeout(() => { void run(); }, delay);
    }
  };
  void run();
}

export async function runGoogleSheetsSyncSchedulerCheckNow() {
  if (schedulerCycleRunning) return { ran: false, reason: 'sync cycle already running' };
  schedulerCycleRunning = true;
  const started = Date.now();
  try {
    const settings = await getSettings();
    schedulerStatus.lastAutomaticCheckTime = new Date().toISOString();
    const skipReason = getSchedulerSkipReason(settings);
    if (skipReason) {
      schedulerStatus.lastSkipReason = skipReason;
      console.log(`[SHEET_SYNC] skipped: ${skipReason}`);
      return { ran: false, reason: skipReason, mode: settings.mealTrackingMode };
    }
    const errors: string[] = [];
    let rowsUpdated = 0;
    const stage = async (label: string, action: () => Promise<unknown>) => {
      const stageStarted = Date.now();
      try {
        const result = await action() as { writeBackRowsUpdated?: number } | null;
        rowsUpdated += result?.writeBackRowsUpdated ?? 0;
        console.log(`[SHEET_SYNC] ${label} completed durationMs=${Date.now() - stageStarted}`);
      } catch (error) {
        const message = mapGoogleSheetsError(error).message;
        errors.push(`${label}: ${message}`);
        console.error(`[SHEET_SYNC] ${label} failed: ${message}`);
      }
    };
    if (settings.mealTrackingMode === MealTrackingMode.camp_meeting) await stage('entitlements', () => writeBackCampMeetingRedemptions(false));
    if (settings.mealTrackingMode === MealTrackingMode.countdown) await stage('balances', () => writeBackCountdownBalances(false));
    if (settings.mealTrackingMode === MealTrackingMode.tally) {
      const mode = getTallyWriteBackMode(settings);
      if (mode === 'weekly' || mode === 'both') await stage('weekly totals', () => writeBackWeeklyTally(false));
      if (mode === 'lifetime' || mode === 'both') await stage('lifetime totals', () => writeBackTallyCounts(false));
    }
    // Do not re-import balances when write-back failed; still attempt LOG recovery.
    if (!errors.length) await stage('import', () => runAutoImportForMode(settings));
    const logDue = !schedulerStatus.lastLogSyncTime || Date.now() - Date.parse(schedulerStatus.lastLogSyncTime) >= 15 * 60000;
    if (logDue) await stage('LOG', () => syncTransactionLogToSheet());
    else console.log('[SHEET_SYNC] LOG export not due (15 minute interval)');
    schedulerStatus.lastRowsUpdated = rowsUpdated;
    schedulerStatus.lastScheduledCycleOrder = 'writeback -> import (if writeback succeeded) -> LOG (when due)';
    schedulerStatus.lastSkipReason = null;
    schedulerStatus.lastSyncError = errors.length ? errors.join('; ') : null;
    schedulerStatus.lastCampMeetingWriteBackError = settings.mealTrackingMode === MealTrackingMode.camp_meeting ? schedulerStatus.lastSyncError : null;
    if (errors.length) throw new Error(errors.join('; '));
    schedulerStatus.lastAutomaticWriteBackTime = new Date().toISOString();
    return { ran: true, rowsUpdated, mode: settings.mealTrackingMode };
  } finally {
    schedulerCycleRunning = false;
    schedulerStatus.lastCycleDurationMs = Date.now() - started;
  }
}

export async function getGoogleSheetsSchedulerStatus() {
  const settings = await getSettings().catch(() => null);
  return {
    ...schedulerStatus,
    lastAutomaticImportTime: schedulerStatus.lastAutomaticImportTime ?? settings?.googleLastAutoImportAt?.toISOString() ?? null,
    lastAutomaticImportSummary: schedulerStatus.lastAutomaticImportSummary ?? settings?.googleLastAutoImportSummary ?? null
  };
}
