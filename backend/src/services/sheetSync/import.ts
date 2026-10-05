import { MealDay, MealType } from '@prisma/client';
import { parsePersonType, peopleSheetRows } from '../peopleSheetRows.js';
import { prisma } from '../../db.js';
import { importCampMeetingRows, mapRowsToCampMeetingInput } from '../campMeetingImportService.js';
import { acquireOperationLock, isResetInProgress, releaseOperationLock } from '../operationLockService.js';
import { readSheetRows } from './client.js';

const HEADER = ['ticket_id','reg_id','guest_name','meal_type','meal_day','meal_date','ticket_type','price','redeemed','redeemed_at','redeemed_by','notes'];

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
