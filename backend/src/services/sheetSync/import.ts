import type { PersonType, Prisma } from '@prisma/client';
import { parsePersonType, peopleSheetRows } from '../peopleSheetRows.js';
import { prisma } from '../../db.js';
import { importCampMeetingRows, mapRowsToCampMeetingInput } from '../campMeetingImportService.js';
import { acquireOperationLock, isResetInProgress, releaseOperationLock } from '../operationLockService.js';
import { readSheetRows, SheetSyncBusyError } from './client.js';
import { trackManualSheetSync } from './status.js';

const WRITE_BATCH_SIZE = 100;

export type PeopleImportOptions = { includeBalances: boolean; overwriteExistingBalances: boolean; overwriteExistingCounts: boolean };

function assertNoReset() {
  if (isResetInProgress()) throw new SheetSyncBusyError('Reset in progress. Try again after reset completes.');
}

/** Scheduled camp-meeting import; outcome is recorded by the scheduler cycle. */
export async function runCampMeetingSheetImport() {
  assertNoReset();
  if (!acquireOperationLock('import')) throw new SheetSyncBusyError('Import already in progress.');
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

// The three exports below are the manual "Import from Google Sheet" actions.
export async function importCampMeetingFromSheet() {
  return trackManualSheetSync(() => runCampMeetingSheetImport());
}

export async function importTallyFromSheet() {
  return trackManualSheetSync(async () => {
    assertNoReset();
    const { rows } = await readSheetRows();
    return importPeopleFromRows(peopleSheetRows(rows as string[][]), { includeBalances: false, overwriteExistingBalances: false, overwriteExistingCounts: true });
  });
}

export async function importCountdownFromSheet() {
  return trackManualSheetSync(async () => {
    assertNoReset();
    const { rows } = await readSheetRows();
    return importPeopleFromRows(peopleSheetRows(rows as string[][]), { includeBalances: true, overwriteExistingBalances: true, overwriteExistingCounts: true });
  });
}

/**
 * Splits a sheet's single "Name" cell into first/last names.
 * "Last, First" is honoured; otherwise the final word is the last name.
 */
export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const name = fullName.replace(/\s+/g, ' ').trim();
  const comma = name.indexOf(',');
  if (comma > 0 && comma < name.length - 1) {
    return { firstName: name.slice(comma + 1).trim(), lastName: name.slice(0, comma).trim() };
  }
  const lastSpace = name.lastIndexOf(' ');
  if (lastSpace < 0) return { firstName: name, lastName: '' };
  return { firstName: name.slice(0, lastSpace), lastName: name.slice(lastSpace + 1) };
}

function displayName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.replace(/\s+/g, ' ').trim();
}

function parseMealCount(value: string | undefined): number | null {
  const text = (value ?? '').trim();
  if (!text) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

type ExistingPerson = {
  id: number; personId: string; codeValue: string; firstName: string; lastName: string; personType: PersonType;
  breakfastRemaining: number; lunchRemaining: number; dinnerRemaining: number; totalMealsCount: number;
};

/**
 * Upserts people from canonical sheet rows ([id, name, breakfast, lunch, dinner, total, type]).
 *
 * This runs on every scheduled cycle, so it only writes rows that actually differ:
 * - an existing person's `active` flag is never touched (a deactivated person stays deactivated);
 * - an existing person's stored first/last names are kept while the combined name matches the sheet;
 * - people missing from the sheet are left alone.
 */
export async function importPeopleFromRows(dataRows: string[][], options: PeopleImportOptions) {
  if (!acquireOperationLock('import')) throw new SheetSyncBusyError('Import already in progress.');
  try {
    let peopleCreated = 0; let peopleUpdated = 0; let rowsImported = 0; let rowsSkipped = 0;
    const errors: string[] = [];

    // One query for the whole roster instead of one lookup per sheet row.
    const existingPeople: ExistingPerson[] = await prisma.person.findMany({
      select: {
        id: true, personId: true, codeValue: true, firstName: true, lastName: true, personType: true,
        breakfastRemaining: true, lunchRemaining: true, dinnerRemaining: true, totalMealsCount: true
      }
    });
    const byPersonId = new Map(existingPeople.map((person) => [person.personId, person]));
    const byCodeValue = new Map(existingPeople.map((person) => [person.codeValue, person]));

    const creates: Prisma.PersonCreateManyInput[] = [];
    const updates: Array<{ id: number; data: Prisma.PersonUpdateInput }> = [];
    const seenIds = new Set<string>();

    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i];
      const skip = (reason: string) => { rowsSkipped += 1; errors.push(`Row ${i + 2}: ${reason}`); };
      const id = (r[0] || '').trim();
      const name = (r[1] || '').replace(/\s+/g, ' ').trim();
      if (!id) { skip('missing ID'); continue; }
      if (seenIds.has(id)) { skip(`duplicate ID ${id} (first occurrence used)`); continue; }
      let personType: PersonType | undefined;
      try { personType = parsePersonType(r[6] || ''); }
      catch (error) { skip(error instanceof Error ? error.message : 'Invalid User Type'); continue; }
      const breakfast = parseMealCount(r[2]); const lunch = parseMealCount(r[3]); const dinner = parseMealCount(r[4]);
      if (options.includeBalances && (breakfast === null || lunch === null || dinner === null)) { skip('meal balances must be numbers'); continue; }
      const total = (breakfast ?? 0) + (lunch ?? 0) + (dinner ?? 0);
      seenIds.add(id);
      rowsImported += 1;

      const existing = byPersonId.get(id) ?? byCodeValue.get(id);
      if (!existing) {
        const names = name ? splitFullName(name) : { firstName: id, lastName: '' };
        creates.push({
          personId: id, codeValue: id, ...names,
          ...(personType ? { personType } : {}),
          ...(options.includeBalances
            ? { breakfastRemaining: breakfast ?? 0, lunchRemaining: lunch ?? 0, dinnerRemaining: dinner ?? 0, totalMealsCount: total }
            : {})
        });
        continue;
      }

      const data: Prisma.PersonUpdateInput = {};
      // Keep the badge code in step with the ID, but never steal a value another person holds.
      if (existing.personId !== id && !byPersonId.has(id)) data.personId = id;
      if (existing.codeValue !== id && !byCodeValue.has(id)) data.codeValue = id;
      if (name && displayName(existing.firstName, existing.lastName) !== name) Object.assign(data, splitFullName(name));
      if (personType && existing.personType !== personType) data.personType = personType;
      if (options.includeBalances && options.overwriteExistingBalances) {
        if (existing.breakfastRemaining !== breakfast) data.breakfastRemaining = breakfast ?? 0;
        if (existing.lunchRemaining !== lunch) data.lunchRemaining = lunch ?? 0;
        if (existing.dinnerRemaining !== dinner) data.dinnerRemaining = dinner ?? 0;
      }
      if (options.includeBalances && options.overwriteExistingCounts && existing.totalMealsCount !== total) data.totalMealsCount = total;
      if (Object.keys(data).length > 0) updates.push({ id: existing.id, data });
    }

    for (let offset = 0; offset < creates.length; offset += WRITE_BATCH_SIZE) {
      const result = await prisma.person.createMany({ data: creates.slice(offset, offset + WRITE_BATCH_SIZE) });
      peopleCreated += result.count;
    }
    for (let offset = 0; offset < updates.length; offset += WRITE_BATCH_SIZE) {
      const batch = updates.slice(offset, offset + WRITE_BATCH_SIZE);
      await prisma.$transaction(batch.map((update) => prisma.person.update({ where: { id: update.id }, data: update.data })));
      peopleUpdated += batch.length;
    }
    return { peopleCreated, peopleUpdated, rowsImported, rowsSkipped, writeBackRowsUpdated: 0, errors };
  } finally {
    releaseOperationLock('import');
  }
}
