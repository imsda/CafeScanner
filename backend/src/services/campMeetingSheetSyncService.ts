import { MealDay, MealTrackingMode, MealType } from '@prisma/client';
import { google } from 'googleapis';
import { getSettings } from './settingsService.js';
import { prisma } from '../db.js';

const HEADER = ['ticket_id','reg_id','guest_name','meal_type','meal_day','meal_date','ticket_type','price','redeemed','redeemed_at','redeemed_by','notes'];

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

function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing service account credentials');
  const auth = new google.auth.JWT(email, undefined, key, ['https://www.googleapis.com/auth/spreadsheets']);
  return google.sheets({ version: 'v4', auth });
}

export async function importCampMeetingFromSheet() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const range = process.env.GOOGLE_SHEETS_RANGE || 'Sheet1!A:L';
  if (!spreadsheetId) throw new Error('Missing GOOGLE_SHEETS_SPREADSHEET_ID');
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = resp.data.values || [];
  const hasHeader = JSON.stringify((rows[0]||[]).map((v:string)=>v.toLowerCase())) === JSON.stringify(HEADER);
  const dataRows = hasHeader ? rows.slice(1) : rows;
  await prisma.mealEntitlement.deleteMany({});
  for (let i=0;i<dataRows.length;i++) {
    const r = dataRows[i] as string[];
    const mealType = mealTypeFromSheet(r[3] || '');
    const mealDay = mealDayFromSheet(r[4] || '');
    if (!mealType || !mealDay || !(r[1]||'').trim()) continue;
    await prisma.mealEntitlement.upsert({
      where: { sourceTicketId: (r[0]||'').trim() || `row-${i+2}` },
      update: {
        personId: (r[1]||'').trim().toUpperCase(), personName: (r[2]||'').trim(), mealType, mealDay, mealDate: (r[5]||'').trim(), redeemed: String(r[8]||'').toLowerCase()==='yes', notes: (r[11]||'').trim() || null, sourceSheetRow: i+2
      },
      create: {
        sourceTicketId: (r[0]||'').trim() || `row-${i+2}`,
        sourceSheetRow: i+2,
        personId: (r[1]||'').trim().toUpperCase(), personName: (r[2]||'').trim(), mealType, mealDay, mealDate: (r[5]||'').trim(), redeemed: String(r[8]||'').toLowerCase()==='yes', notes: (r[11]||'').trim() || null
      }
    });
  }
}

export async function flushCampMeetingRedemptionsToSheet(force = false) {
  const settings = await getSettings();
  if (settings.mealTrackingMode !== MealTrackingMode.camp_meeting) return;
  if (!force && !isWithinMealWindowPlus10Minutes(new Date(), settings.timezone || 'Etc/UTC', settings)) return;
  const pending = await prisma.mealEntitlement.findMany({ where: { redeemed: true, sourceSheetRow: { not: null }, sheetSyncedAt: null } });
  if (!pending.length) return;
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const sheetName = process.env.GOOGLE_SHEETS_TAB || 'Sheet1';
  if (!spreadsheetId) throw new Error('Missing GOOGLE_SHEETS_SPREADSHEET_ID');
  for (const row of pending) {
    const r = row.sourceSheetRow!;
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: [
      { range: `${sheetName}!I${r}:K${r}`, values: [['yes', row.redeemedAt?.toISOString() || new Date().toISOString(), row.redeemedBy || row.personName || '']] }
    ] } });
    await prisma.mealEntitlement.update({ where: { id: row.id }, data: { sheetSyncedAt: new Date() } });
  }
}

export function startCampMeetingSheetSyncScheduler() {
  setInterval(() => { void flushCampMeetingRedemptionsToSheet(false).catch((e) => console.error('[SHEET_SYNC]', e)); }, 5 * 60 * 1000);
}
