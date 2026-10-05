import { MealTrackingMode, MealType } from '@prisma/client';
import { getSettings } from '../settingsService.js';
import { prisma } from '../../db.js';
import { acquireOperationLock, releaseOperationLock } from '../operationLockService.js';
import { resolveTimezone } from '../../utils/timezone.js';
import { assertRequiredHeaders, columnNumberToLetter, DEFAULT_SHEET_TAB_NAME, getSheetsClient, getTallyHeaderMap, mapGoogleSheetsError, parseSpreadsheetId } from './client.js';
import { isWithinMealWindowPlus10Minutes } from './mealWindow.js';

const TALLY_HEADER = ['id', 'name', 'breakfast', 'lunch', 'dinner', 'total'];
const WEEKLY_TALLY_HEADER = ['Week Starting', 'Week Ending', 'ID', 'Name', 'Breakfast', 'Lunch', 'Dinner', 'Total'];
const TALLY_COUNT_COLUMNS = ['breakfast', 'lunch', 'dinner', 'total'] as const;

export async function writeBackTallyCounts(force = false) {
  const settings = await getSettings();
  const mode = getTallyWriteBackMode(settings);
  if (mode === 'weekly') return { writeBackRowsUpdated: 0 };
  return writeBackPeopleRows(false, force);
}
export async function writeBackCountdownBalances(force = false) { return writeBackPeopleRows(true, force); }
export async function writeBackCampMeetingRedemptions(force = false) { return flushCampMeetingRedemptionsToSheet(force); }
export async function writeBackWeeklyTallyNow(force = true) { return writeBackWeeklyTally(force); }

export function getTallyWriteBackMode(settings: Awaited<ReturnType<typeof getSettings>>): 'lifetime' | 'weekly' | 'both' {
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

export async function writeBackWeeklyTally(force: boolean) {
  if (!acquireOperationLock('writeback')) {
    if (force) throw new Error('Another sheet sync is running. Please try again shortly.');
    return { writeBackRowsUpdated: 0, rowsAppended: 0, tabName: '' };
  }
  try {
    const settings = await getSettings();
    if (!force && !isWithinMealWindowPlus10Minutes(new Date(), resolveTimezone(settings.timezone), settings)) return { writeBackRowsUpdated: 0, rowsAppended: 0, tabName: '' };
    if (!settings.googleSheetsEnabled) return { writeBackRowsUpdated: 0, rowsAppended: 0, tabName: '' };
    const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
    const tabName = (settings.tallyWeeklyRawTabName || '').trim() || 'Weekly Tally Raw';
    const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
    const weekStartsOn = settings.tallyWeekStartsOn === 'SUNDAY' ? 'SUNDAY' : 'MONDAY';
    const timezone = resolveTimezone(settings.timezone);
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
  if (!force && !isWithinMealWindowPlus10Minutes(new Date(), resolveTimezone(settings.timezone), settings)) return { writeBackRowsUpdated: 0 };
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
  if (!force && !isWithinMealWindowPlus10Minutes(new Date(), resolveTimezone(settings.timezone), settings)) return { writeBackRowsUpdated: 0 };
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
