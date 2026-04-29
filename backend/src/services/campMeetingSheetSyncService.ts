import { MealDay, MealTrackingMode, MealType } from '@prisma/client';
import { google } from 'googleapis';
import { getSettings } from './settingsService.js';
import { prisma } from '../db.js';

const HEADER = ['ticket_id','reg_id','guest_name','meal_type','meal_day','meal_date','ticket_type','price','redeemed','redeemed_at','redeemed_by','notes'];
const DEFAULT_SHEET_TAB_NAME = 'Sheet1';

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
    const [sh,sm]=s.split(':').map(Number); const [eh,em]=e.split(':').map(Number);
    return now >= sh*60+sm && now <= eh*60+em+10;
  });
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
  if (!spreadsheetId) throw new Error('Google Sheet URL/ID is not configured.');
  const sheetName = (settings.googleSheetTabName || DEFAULT_SHEET_TAB_NAME).trim();
  if (!sheetName) throw new Error('Missing worksheet/tab name in Settings.');
  const range = `${sheetName}!A:L`;
  const sheets = getSheetsClient();
  let resp;
  try {
    resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  } catch (error) {
    throw mapGoogleSheetsError(error);
  }
  const rows = resp.data.values || [];
  const normalizedHeader = (rows[0] || []).map((v: string) => v.toLowerCase().trim());
  const hasHeader = JSON.stringify(normalizedHeader) === JSON.stringify(HEADER);
  const missingHeaders = HEADER.filter((header) => !normalizedHeader.includes(header));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (!hasHeader) {
    return {
      peopleCreated: 0,
      peopleUpdated: 0,
      entitlementsCreated: 0,
      entitlementsUpdated: 0,
      skippedRows: dataRows.length,
      errors: [`Invalid header row. Missing required headers: ${missingHeaders.join(', ') || 'unknown'}`]
    };
  }
  if (!dataRows.length) {
    return {
      peopleCreated: 0,
      peopleUpdated: 0,
      entitlementsCreated: 0,
      entitlementsUpdated: 0,
      skippedRows: 0,
      errors: ['No data rows found in the configured sheet tab.']
    };
  }
  let peopleCreated = 0;
  let peopleUpdated = 0;
  let entitlementsCreated = 0;
  let entitlementsUpdated = 0;
  let skippedRows = 0;
  const errors: string[] = [];
  for (let i=0;i<dataRows.length;i++) {
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
    const displayName = personName || regId;
    const existingPerson = await prisma.person.findUnique({ where: { personId: regId }, select: { id: true } });
    if (existingPerson) {
      await prisma.person.update({
        where: { personId: regId },
        data: { firstName: displayName, lastName: ' ', codeValue: regId, active: true }
      });
      peopleUpdated += 1;
    } else {
      await prisma.person.create({
        data: { personId: regId, codeValue: regId, firstName: displayName, lastName: ' ', active: true }
      });
      peopleCreated += 1;
    }

    const ticketId = (r[0] || '').trim() || `row-${i + 2}`;
    const existingEntitlement = await prisma.mealEntitlement.findUnique({ where: { sourceTicketId: ticketId }, select: { id: true } });
    await prisma.mealEntitlement.upsert({
      where: { sourceTicketId: ticketId },
      update: {
        personId: regId, personName, mealType, mealDay, mealDate: (r[5]||'').trim(), redeemed: parseBool(String(r[8]||'')), notes: (r[11]||'').trim() || null, sourceSheetRow: i+2
      },
      create: {
        sourceTicketId: ticketId,
        sourceSheetRow: i+2,
        personId: regId, personName, mealType, mealDay, mealDate: (r[5]||'').trim(), redeemed: parseBool(String(r[8]||'')), notes: (r[11]||'').trim() || null
      }
    });
    if (existingEntitlement) entitlementsUpdated += 1;
    else entitlementsCreated += 1;
  }
  return { peopleCreated, peopleUpdated, entitlementsCreated, entitlementsUpdated, skippedRows, errors };
}

export async function flushCampMeetingRedemptionsToSheet(force = false) {
  const settings = await getSettings();
  if (settings.mealTrackingMode !== MealTrackingMode.camp_meeting) return;
  if (!force && !isWithinMealWindowPlus10Minutes(new Date(), settings.timezone || 'Etc/UTC', settings)) return;
  const pending = await prisma.mealEntitlement.findMany({ where: { redeemed: true, sourceSheetRow: { not: null }, sheetSyncedAt: null } });
  if (!pending.length) return;
  if (!settings.googleSheetsEnabled) return;
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
}

export function startCampMeetingSheetSyncScheduler() {
  const run = async () => {
    try {
      await flushCampMeetingRedemptionsToSheet(false);
    } catch (e) {
      console.error('[SHEET_SYNC]', e);
    } finally {
      const settings = await getSettings().catch(() => null);
      const intervalMinutes = Math.max(1, settings?.googleSyncIntervalMinutes ?? 5);
      setTimeout(() => {
        void run();
      }, intervalMinutes * 60 * 1000);
    }
  };
  void run();
}
