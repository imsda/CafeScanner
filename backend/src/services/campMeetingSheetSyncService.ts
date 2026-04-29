import { MealDay, MealTrackingMode, MealType } from '@prisma/client';
import { google } from 'googleapis';
import { getSettings } from './settingsService.js';
import { prisma } from '../db.js';

const HEADER = ['ticket_id','reg_id','guest_name','meal_type','meal_day','meal_date','ticket_type','price','redeemed','redeemed_at','redeemed_by','notes'];
const TALLY_HEADER = ['id', 'name', 'breakfast', 'lunch', 'dinner', 'total'];
const DEFAULT_SHEET_TAB_NAME = 'Sheet1';
type SchedulerStatus = {
  schedulerEnabled: boolean;
  lastAutomaticCheckTime: string | null;
  lastAutomaticWriteBackTime: string | null;
  lastSkipReason: string | null;
  lastRowsUpdated: number;
  nextExpectedRunTime: string | null;
};

const schedulerStatus: SchedulerStatus = {
  schedulerEnabled: false,
  lastAutomaticCheckTime: null,
  lastAutomaticWriteBackTime: null,
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
  const settings = await getSettings();
  if (!settings.googleSheetsEnabled) throw new Error('Google Sheets sync is disabled in Settings.');

  const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
  if (!spreadsheetId) {
    const summary = { totalRows: 0, validRows: 0, skippedRows: 0, created: 0, updated: 0, errors: ['missing sheet ID'] };
    console.log('[SHEET_IMPORT]', summary);
    return summary;
  }

  const sheetName = (settings.googleSheetTabName || DEFAULT_SHEET_TAB_NAME).trim();
  if (!sheetName) throw new Error('Missing worksheet/tab name in Settings.');

  const range = `${sheetName}!A:L`;
  const sheets = getSheetsClient();
  let resp;
  try {
    resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  } catch (error) {
    const mapped = mapGoogleSheetsError(error);
    const summary = { totalRows: 0, validRows: 0, skippedRows: 0, created: 0, updated: 0, errors: [`parsing failed: ${mapped.message}`] };
    console.log('[SHEET_IMPORT]', summary);
    throw mapped;
  }

  const rows = resp.data.values || [];
  const normalizedHeader = (rows[0] || []).map((v: string) => v.toLowerCase().trim());
  const hasHeader = JSON.stringify(normalizedHeader) === JSON.stringify(HEADER);
  const missingHeaders = HEADER.filter((header) => !normalizedHeader.includes(header));
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const totalRows = dataRows.length;
  let validRows = 0;
  let skippedRows = 0;
  let created = 0;
  let updated = 0;
  const errors: string[] = [];

  if (!hasHeader) {
    skippedRows = totalRows;
    errors.push(`Invalid header row. Missing required headers: ${missingHeaders.join(', ') || 'unknown'}`);
  } else if (!dataRows.length) {
    errors.push('no valid rows');
  } else {
    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i] as string[];
      const regId = (r[1] || '').trim().toUpperCase();
      const personName = (r[2] || '').trim();
      const mealType = mealTypeFromSheet(r[3] || '');
      const mealDay = mealDayFromSheet(r[4] || '');
      if (!mealType || !mealDay || !regId) {
        skippedRows += 1;
        errors.push(`Row ${i + 2}: invalid reg_id, meal_type, or meal_day.`);
        continue;
      }

      validRows += 1;

      const displayName = personName || regId;
      const existingPerson = await prisma.person.findUnique({ where: { personId: regId }, select: { id: true } });
      if (existingPerson) {
        await prisma.person.update({
          where: { personId: regId },
          data: { firstName: displayName, lastName: ' ', codeValue: regId, active: true }
        });
      } else {
        await prisma.person.create({
          data: { personId: regId, codeValue: regId, firstName: displayName, lastName: ' ', active: true }
        });
      }

      const ticketId = (r[0] || '').trim() || `row-${i + 2}`;
      const existingEntitlement = await prisma.mealEntitlement.findUnique({ where: { sourceTicketId: ticketId }, select: { id: true } });
      await prisma.mealEntitlement.upsert({
        where: { sourceTicketId: ticketId },
        update: {
          personId: regId, personName, mealType, mealDay, mealDate: (r[5] || '').trim(), redeemed: parseBool(String(r[8] || '')), notes: (r[11] || '').trim() || null, sourceSheetRow: i + 2
        },
        create: {
          sourceTicketId: ticketId,
          sourceSheetRow: i + 2,
          personId: regId, personName, mealType, mealDay, mealDate: (r[5] || '').trim(), redeemed: parseBool(String(r[8] || '')), notes: (r[11] || '').trim() || null
        }
      });
      if (existingEntitlement) updated += 1;
      else created += 1;
    }

    if (validRows === 0 && errors.length === 0) {
      errors.push('no valid rows');
    }
  }

  const summary = { peopleCreated: created, peopleUpdated: updated, rowsImported: validRows, rowsSkipped: skippedRows, writeBackRowsUpdated: 0, errors };
  if (created + updated === 0 && errors.length === 0) summary.errors.push('no valid rows');
  console.log('[SHEET_IMPORT]', { totalRows, validRows, skippedRows, created, updated, errors });
  return summary;
}

export async function importTallyFromSheet() {
  const { spreadsheetId, sheetName, rows } = await readSheetRows();
  void spreadsheetId; void sheetName;
  const normalizedHeader = (rows[0] || []).map((v: string) => v.toLowerCase().trim());
  const dataRows = JSON.stringify(normalizedHeader) === JSON.stringify(TALLY_HEADER) ? rows.slice(1) : [];
  return importPeopleFromRows(dataRows, false);
}

export async function importCountdownFromSheet() {
  const { rows } = await readSheetRows();
  const normalizedHeader = (rows[0] || []).map((v: string) => v.toLowerCase().trim());
  const dataRows = JSON.stringify(normalizedHeader) === JSON.stringify(TALLY_HEADER) ? rows.slice(1) : [];
  return importPeopleFromRows(dataRows, true);
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

async function importPeopleFromRows(dataRows: string[][], includeBalances: boolean) {
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
    if (includeBalances) Object.assign(data, { breakfastRemaining: breakfast, lunchRemaining: lunch, dinnerRemaining: dinner, totalMealsCount: total });
    if (existing) { await prisma.person.update({ where: { id: existing.id }, data }); peopleUpdated += 1; }
    else { await prisma.person.create({ data }); peopleCreated += 1; }
    rowsImported += 1;
  }
  return { peopleCreated, peopleUpdated, rowsImported, rowsSkipped, writeBackRowsUpdated: 0, errors };
}

export async function writeBackTallyCounts(force = false) { return writeBackPeopleRows(false, force); }
export async function writeBackCountdownBalances(force = false) { return writeBackPeopleRows(true, force); }
export async function writeBackCampMeetingRedemptions(force = false) { return flushCampMeetingRedemptionsToSheet(force); }

async function writeBackPeopleRows(useBalances: boolean, force: boolean) {
  const settings = await getSettings();
  if (!force && !isWithinMealWindowPlus10Minutes(new Date(), settings.timezone || 'Etc/UTC', settings)) return { writeBackRowsUpdated: 0 };
  if (!settings.googleSheetsEnabled) return { writeBackRowsUpdated: 0 };
  const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
  const sheetName = (settings.googleSheetTabName || DEFAULT_SHEET_TAB_NAME).trim();
  const sheets = getSheetsClient();
  const people = await prisma.person.findMany({ where: { active: true }, orderBy: { personId: 'asc' } });
  const values = [TALLY_HEADER, ...people.map((p) => {
    const b = useBalances ? p.breakfastRemaining : p.breakfastCount;
    const l = useBalances ? p.lunchRemaining : p.lunchCount;
    const d = useBalances ? p.dinnerRemaining : p.dinnerCount;
    return [p.personId, `${p.firstName} ${p.lastName}`.trim(), b, l, d, b + l + d];
  })];
  await sheets.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!A1:F${values.length}`, valueInputOption: 'USER_ENTERED', requestBody: { values } });
  return { writeBackRowsUpdated: people.length };
}

export async function flushCampMeetingRedemptionsToSheet(force = false) {
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
        console.log(`[SHEET_SYNC] Skipped: ${skipReason}`);
        schedulerStatus.lastSkipReason = skipReason;
        schedulerStatus.lastRowsUpdated = 0;
      } else {
        console.log('[SHEET_SYNC] Running scheduled write-back');
        let result: { writeBackRowsUpdated?: number } | void = { writeBackRowsUpdated: 0 };
        if (settings.mealTrackingMode === MealTrackingMode.camp_meeting) result = await writeBackCampMeetingRedemptions(false);
        if (settings.mealTrackingMode === MealTrackingMode.tally) result = await writeBackTallyCounts(false);
        if (settings.mealTrackingMode === MealTrackingMode.countdown) result = await writeBackCountdownBalances(false);
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
    console.log(`[SHEET_SYNC] Skipped: ${skipReason}`);
    schedulerStatus.lastSkipReason = skipReason;
    schedulerStatus.lastRowsUpdated = 0;
    schedulerStatus.nextExpectedRunTime = new Date(Date.now() + (intervalMinutes * 60 * 1000)).toISOString();
    return { ran: false, reason: skipReason, mode: settings.mealTrackingMode };
  }
  console.log('[SHEET_SYNC] Running scheduled write-back');
  let result: { writeBackRowsUpdated?: number } | void = { writeBackRowsUpdated: 0 };
  if (settings.mealTrackingMode === MealTrackingMode.camp_meeting) result = await writeBackCampMeetingRedemptions(false);
  if (settings.mealTrackingMode === MealTrackingMode.tally) result = await writeBackTallyCounts(false);
  if (settings.mealTrackingMode === MealTrackingMode.countdown) result = await writeBackCountdownBalances(false);
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

export function getGoogleSheetsSchedulerStatus() {
  return { ...schedulerStatus };
}
