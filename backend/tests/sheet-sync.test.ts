import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useIsolatedDatabase, startTestApp } from './helpers/testApp.js';

// Always use an isolated database; never touch the application's configured data.
const database = useIsolatedDatabase('sheet-sync');
const { prisma } = await import('../src/db.js');
const bcrypt = (await import('bcryptjs')).default;
const { google } = await import('googleapis');
const {
  importPeopleFromRows, splitFullName, runGoogleSheetsSyncSchedulerCheckNow, getGoogleSheetsSchedulerStatus,
  syncTransactionLogToSheet, rebuildTransactionLogFromDatabase, writeBackCampMeetingRedemptions
} = await import('../src/services/campMeetingSheetSyncService.js');
const { peopleSheetRows } = await import('../src/services/peopleSheetRows.js');
const client = await startTestApp();

// Meal windows that never contain "now" (UTC), so scheduled write-back is outside the window.
const farHour = String((new Date().getUTCHours() + 12) % 24).padStart(2, '0');
const closedWindows = {
  breakfastStart: `${farHour}:00`, breakfastEnd: `${farHour}:01`,
  lunchStart: `${farHour}:00`, lunchEnd: `${farHour}:01`,
  dinnerStart: `${farHour}:00`, dinnerEnd: `${farHour}:01`
};
await prisma.setting.create({ data: { id: 1, mealTrackingMode: 'tally', timezone: 'Etc/UTC', googleAutoImportEnabled: false, ...closedWindows } });
await prisma.adminUser.create({ data: { username: 'admin', passwordHash: await bcrypt.hash('test-password-123', 4), role: 'ADMIN' } });
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test@example.com';
process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----';

test.after(async () => {
  await client.close();
  await prisma.$disconnect();
  database.cleanup();
});

const TALLY_OPTIONS = { includeBalances: false, overwriteExistingBalances: false, overwriteExistingCounts: false };
const HEADER = ['ID', 'Name', 'Breakfast', 'Lunch', 'Dinner', 'Total', 'User Type'];
const rowsFor = (...rows: string[][]) => peopleSheetRows([HEADER, ...rows]);

type Write = { range: string; values: unknown[][]; valueInputOption?: string };
type ValuesRequest = { range: string; valueInputOption?: string; requestBody: { values?: unknown[][]; valueInputOption?: string; data?: Array<{ range: string; values: unknown[][] }> } };

// Minimal stand-in for the Sheets API boundary; records every write and how it was sent.
function fakeSheets(tabs: Record<string, unknown[][]>, options: { failBatchUpdate?: Error } = {}) {
  const writes: Write[] = [];
  const appends: Write[] = [];
  const reads: string[] = [];
  const cleared: string[] = [];
  const clientOptions: unknown[] = [];
  const tabOf = (range: string) => range.split('!')[0].replace(/^'|'$/g, '').replace(/''/g, "'");
  const factory = (clientOption: unknown) => {
    clientOptions.push(clientOption);
    return {
      spreadsheets: {
        get: async () => ({ data: { sheets: Object.keys(tabs).map((title, sheetId) => ({ properties: { title, sheetId } })) } }),
        batchUpdate: async () => ({}),
        values: {
          get: async (request: { range: string }) => {
            reads.push(request.range);
            const rows = tabs[tabOf(request.range)] || [];
            if (/!A1:I1$/.test(request.range)) return { data: { values: rows.slice(0, 1) } };
            const start = Number(/!A(\d+):I$/.exec(request.range)?.[1] ?? 1);
            return { data: { values: rows.slice(start - 1) } };
          },
          update: async (request: ValuesRequest) => {
            writes.push({ range: request.range, values: request.requestBody.values || [], valueInputOption: request.valueInputOption });
            if (/!A2:I$/.test(request.range)) tabs[tabOf(request.range)].push(...(request.requestBody.values || []));
            return {};
          },
          batchUpdate: async (request: ValuesRequest) => {
            if (options.failBatchUpdate) throw options.failBatchUpdate;
            for (const item of request.requestBody.data || []) writes.push({ ...item, valueInputOption: request.requestBody.valueInputOption });
            return {};
          },
          append: async (request: ValuesRequest) => {
            appends.push({ range: request.range, values: request.requestBody.values || [], valueInputOption: request.valueInputOption });
            tabs[tabOf(request.range)].push(...(request.requestBody.values || []));
            return {};
          },
          clear: async (request: { range: string }) => { cleared.push(request.range); tabs[tabOf(request.range)].splice(1); return {}; }
        }
      }
    };
  };
  return { factory: factory as unknown as typeof google.sheets, writes, appends, reads, cleared, clientOptions };
}

async function getMeta() {
  const cookie = await client.login('admin');
  const response = await client.request('/api/meta', { cookie });
  assert.equal(response.status, 200);
  return await response.json() as { schoolName: string; sheetSync: null | { enabled: boolean; lastSuccessAt: string | null; lastError: string | null; lastErrorAt: string | null } };
}

test('splitFullName gives a usable first/last name', () => {
  assert.deepEqual(splitFullName('Jane Smith'), { firstName: 'Jane', lastName: 'Smith' });
  assert.deepEqual(splitFullName('  Mary  Ann   Jones '), { firstName: 'Mary Ann', lastName: 'Jones' });
  assert.deepEqual(splitFullName('Smith, Jane'), { firstName: 'Jane', lastName: 'Smith' });
  assert.deepEqual(splitFullName('Cher'), { firstName: 'Cher', lastName: '' });
});

test('importPeopleFromRows only writes real changes and never re-activates people', async () => {
  const rows = rowsFor(['00123', 'Jane Smith', '0', '0', '0', '0', 'Student'], ['00456', 'Sam Lee Jones', '0', '0', '0', '0', 'Staff'], ['00789', '', '0', '0', '0', '0', '']);
  const first = await importPeopleFromRows(rows, TALLY_OPTIONS);
  assert.deepEqual({ created: first.peopleCreated, updated: first.peopleUpdated, imported: first.rowsImported, skipped: first.rowsSkipped }, { created: 3, updated: 0, imported: 3, skipped: 0 });
  const jane = await prisma.person.findUniqueOrThrow({ where: { personId: '00123' } });
  assert.deepEqual([jane.firstName, jane.lastName, jane.codeValue, jane.personType, jane.active], ['Jane', 'Smith', '00123', 'STUDENT', true], 'leading zeros and name split are kept');
  const sam = await prisma.person.findUniqueOrThrow({ where: { personId: '00456' } });
  assert.deepEqual([sam.firstName, sam.lastName], ['Sam Lee', 'Jones']);
  const unnamed = await prisma.person.findUniqueOrThrow({ where: { personId: '00789' } });
  assert.deepEqual([unnamed.firstName, unnamed.lastName, unnamed.personType], ['00789', '', 'GUEST']);

  // An admin deactivates Jane and fixes Sam's stored names without changing the combined name.
  await prisma.person.update({ where: { id: jane.id }, data: { active: false } });
  await prisma.person.update({ where: { id: sam.id }, data: { firstName: 'Sam', lastName: 'Lee Jones', lunchCount: 4, totalMealsCount: 4 } });
  const before = await prisma.person.findMany({ orderBy: { id: 'asc' } });
  await new Promise((resolve) => setTimeout(resolve, 15));

  const second = await importPeopleFromRows(rows, TALLY_OPTIONS);
  assert.deepEqual({ created: second.peopleCreated, updated: second.peopleUpdated, imported: second.rowsImported }, { created: 0, updated: 0, imported: 3 });
  const after = await prisma.person.findMany({ orderBy: { id: 'asc' } });
  assert.deepEqual(after, before, 'an identical import must not touch any row (updatedAt, active, names, counts)');
  assert.equal(after.find((person) => person.personId === '00123')?.active, false);

  // Type and name changes are still applied, and still do not re-activate or reset counts.
  const changed = await importPeopleFromRows(
    rowsFor(['00123', 'Jane Smith-Brown', '9', '9', '9', '27', 'Village Student'], ['00456', 'Sam Lee Jones', '0', '0', '0', '0', 'Staff'], ['00789', '', '0', '0', '0', '0', '']),
    TALLY_OPTIONS
  );
  assert.equal(changed.peopleUpdated, 1);
  const janeAfter = await prisma.person.findUniqueOrThrow({ where: { personId: '00123' } });
  assert.deepEqual([janeAfter.firstName, janeAfter.lastName, janeAfter.personType, janeAfter.active, janeAfter.totalMealsCount], ['Jane', 'Smith-Brown', 'VILLAGE_STUDENT', false, 0]);
  assert.ok(janeAfter.updatedAt > jane.updatedAt);
  const samAfter = await prisma.person.findUniqueOrThrow({ where: { personId: '00456' } });
  assert.deepEqual([samAfter.firstName, samAfter.lastName, samAfter.lunchCount], ['Sam', 'Lee Jones', 4]);

  // People missing from the sheet are left alone; bad rows are reported, not fatal.
  const partial = await importPeopleFromRows(rowsFor(['', 'No Id', '0', '0', '0', '0', ''], ['00456', 'Sam Lee Jones', '0', '0', '0', '0', 'Teacher'], ['00999', 'New Person', '0', '0', '0', '0', '2'], ['00999', 'Duplicate', '0', '0', '0', '0', '2']), TALLY_OPTIONS);
  assert.deepEqual({ created: partial.peopleCreated, updated: partial.peopleUpdated, skipped: partial.rowsSkipped }, { created: 1, updated: 0, skipped: 3 });
  assert.equal(partial.errors.length, 3);
  assert.equal(await prisma.person.count(), 4);
  assert.equal((await prisma.person.findUniqueOrThrow({ where: { personId: '00789' } })).active, true);
});

test('countdown imports set balances for new people and only overwrite existing ones when asked', async () => {
  const scheduled = { includeBalances: true, overwriteExistingBalances: false, overwriteExistingCounts: false };
  const manual = { includeBalances: true, overwriteExistingBalances: true, overwriteExistingCounts: true };
  await importPeopleFromRows(rowsFor(['C1', 'Count Down', '5', '6', '7', '18', '']), scheduled);
  const created = await prisma.person.findUniqueOrThrow({ where: { personId: 'C1' } });
  assert.deepEqual([created.breakfastRemaining, created.lunchRemaining, created.dinnerRemaining, created.totalMealsCount], [5, 6, 7, 18]);
  // A scan lowered the balance; the scheduled import must not put the sheet value back.
  await prisma.person.update({ where: { id: created.id }, data: { lunchRemaining: 5 } });
  const auto = await importPeopleFromRows(rowsFor(['C1', 'Count Down', '5', '6', '7', '18', '']), scheduled);
  assert.equal(auto.peopleUpdated, 0);
  assert.equal((await prisma.person.findUniqueOrThrow({ where: { id: created.id } })).lunchRemaining, 5);
  const forced = await importPeopleFromRows(rowsFor(['C1', 'Count Down', '1', '2', '3', '6', '']), manual);
  assert.equal(forced.peopleUpdated, 1);
  const overwritten = await prisma.person.findUniqueOrThrow({ where: { id: created.id } });
  assert.deepEqual([overwritten.breakfastRemaining, overwritten.lunchRemaining, overwritten.dinnerRemaining, overwritten.totalMealsCount], [1, 2, 3, 6]);
  const bad = await importPeopleFromRows(rowsFor(['C2', 'Bad Number', 'x', '2', '3', '6', '']), manual);
  assert.equal(bad.rowsSkipped, 1);
  assert.equal(await prisma.person.count({ where: { personId: 'C2' } }), 0);
});

test('GET /api/meta exposes persisted sheet sync status only when sync is enabled', async () => {
  const errorAt = new Date('2031-01-02T03:04:05Z');
  await prisma.setting.update({ where: { id: 1 }, data: { googleLastSyncError: 'weekly totals: Google Sheets API denied access (403).', googleLastSyncErrorAt: errorAt, googleLastSyncSuccessAt: new Date('2031-01-01T00:00:00Z') } });
  assert.equal((await getMeta()).sheetSync, null, 'disabled sync reports nothing');
  await prisma.setting.update({ where: { id: 1 }, data: { googleSheetsEnabled: true, googleSheetId: 'test-sheet', googleSheetTabName: 'Sheet1' } });
  const meta = await getMeta();
  assert.equal(meta.schoolName, 'My School Cafeteria');
  assert.deepEqual(meta.sheetSync, {
    enabled: true, lastSuccessAt: '2031-01-01T00:00:00.000Z',
    lastError: 'weekly totals: Google Sheets API denied access (403).', lastErrorAt: errorAt.toISOString()
  });
  assert.equal((await getGoogleSheetsSchedulerStatus()).persistedLastError, meta.sheetSync?.lastError);
  await prisma.setting.update({ where: { id: 1 }, data: { googleLastSyncError: null, googleLastSyncErrorAt: null, googleLastSyncSuccessAt: null } });
  assert.deepEqual((await getMeta()).sheetSync, { enabled: true, lastSuccessAt: null, lastError: null, lastErrorAt: null });
});

test('scheduler: failures are persisted, and scans after the meal window still get one final write-back', async (t) => {
  // No successful scans yet and outside every meal window: nothing to do.
  const idle = await runGoogleSheetsSyncSchedulerCheckNow();
  assert.deepEqual([idle.ran, 'reason' in idle && idle.reason], [false, 'outside meal window']);

  const jane = await prisma.person.findUniqueOrThrow({ where: { personId: '00123' } });
  const sam = await prisma.person.findUniqueOrThrow({ where: { personId: '00456' } });
  await prisma.person.update({ where: { id: sam.id }, data: { lunchCount: 5, totalMealsCount: 5 } });
  await prisma.scanTransaction.create({ data: { personId: sam.id, scannedValue: '=HYPERLINK("http://evil.example","x")', result: 'SUCCESS', mealType: 'LUNCH', stationName: '+cmd' } });
  await prisma.scanTransaction.create({ data: { personId: jane.id, scannedValue: '00123', result: 'FAILURE', mealType: 'LUNCH', failureReason: 'INACTIVE' } });
  const roster = () => [['ID', 'Name', 'Breakfast', 'Lunch', 'Dinner', 'Total', 'User Type'], ['00456', 'Sam Lee Jones', '0', '0', '0', '0', 'Staff']];

  // 1. The write-back fails: the error is persisted and visible through /api/meta.
  const failing = fakeSheets({ Sheet1: roster(), LOG: [] }, { failBatchUpdate: Object.assign(new Error('The caller does not have permission'), { code: 403 }) });
  t.mock.method(google, 'sheets', failing.factory);
  await assert.rejects(runGoogleSheetsSyncSchedulerCheckNow(), /denied access \(403\)/);
  const failed = (await getMeta()).sheetSync;
  assert.match(failed?.lastError || '', /lifetime totals: .*403/);
  assert.ok(failed?.lastErrorAt);
  assert.equal(failed?.lastSuccessAt, null);
  const clientOptions = failing.clientOptions[0] as { timeout?: number; retry?: boolean; retryConfig?: { retry?: number } };
  assert.equal(clientOptions.timeout, 30000, 'every Sheets client is created with a request timeout');
  assert.equal(clientOptions.retry, true);
  assert.equal(clientOptions.retryConfig?.retry, 2);
  // The LOG export of that cycle still ran, with scanned text sent as RAW values.
  assert.equal(failing.appends.length, 1);
  assert.equal(failing.appends[0].valueInputOption, 'RAW');
  assert.equal(failing.appends[0].values.length, 2);
  assert.equal(failing.appends[0].values[0][1], '=HYPERLINK("http://evil.example","x")');
  assert.equal(failing.appends[0].values[1][1], '00123');
  assert.equal(await prisma.scanTransaction.count({ where: { googleLogSyncedAt: null } }), 0);

  // 2. The next cycle is still outside the window but the scan has not been written back: final flush.
  const working = fakeSheets({ Sheet1: roster(), LOG: [['Time', 'Value', 'Meal', 'Result', 'Reason', 'Person', 'Station', 'Transaction ID', 'Type']] });
  t.mock.method(google, 'sheets', working.factory);
  const flushed = await runGoogleSheetsSyncSchedulerCheckNow();
  assert.equal(flushed.ran, true);
  assert.deepEqual(working.writes.map((write) => [write.range, write.values[0][0], write.valueInputOption]).sort(), [["'Sheet1'!D2", 5, 'RAW'], ["'Sheet1'!F2", 5, 'RAW']]);
  assert.equal(working.appends.length, 0, 'already exported transactions are not appended again');
  const recovered = (await getMeta()).sheetSync;
  assert.equal(recovered?.lastError, null);
  assert.equal(recovered?.lastErrorAt, null);
  assert.ok(recovered?.lastSuccessAt);

  // 3. Nothing new since the flush: back to skipping outside the window.
  const skipped = await runGoogleSheetsSyncSchedulerCheckNow();
  assert.deepEqual([skipped.ran, 'reason' in skipped && skipped.reason], [false, 'outside meal window']);
  assert.equal((await getGoogleSheetsSchedulerStatus()).lastSkipReason, 'outside meal window');
});

test('LOG sync appends only unsynced transactions and reads only the header plus the tail', async (t) => {
  const header = ['Time', 'Value', 'Meal', 'Result', 'Reason', 'Person', 'Station', 'Transaction ID', 'Type'];
  const existing = await prisma.scanTransaction.findMany({ orderBy: { id: 'asc' } });
  // Earlier transactions are already marked as exported. They are deliberately absent from
  // this tab: if the sync still compared every transaction with the sheet, it would re-append them.
  assert.equal(await prisma.scanTransaction.count({ where: { googleLogSyncedAt: null } }), 0);
  const log: unknown[][] = [header];
  const sheets = fakeSheets({ LOG: log });
  t.mock.method(google, 'sheets', sheets.factory);

  const fresh = await prisma.scanTransaction.create({ data: { scannedValue: '000789', result: 'FAILURE', mealType: 'DINNER', failureReason: 'PERSON_NOT_FOUND' } });
  const result = await syncTransactionLogToSheet();
  assert.equal(result.rowsAppended, 1);
  assert.equal(result.totalTransactions, existing.length + 1);
  assert.equal(sheets.appends.length, 1);
  assert.equal(sheets.appends[0].valueInputOption, 'RAW');
  assert.deepEqual(sheets.appends[0].values, [[fresh.timestamp.toISOString(), '000789', 'DINNER', 'FAILURE', 'PERSON_NOT_FOUND', '', '', String(fresh.id), '']]);
  assert.equal(sheets.reads.length, 2);
  assert.match(sheets.reads[0], /^LOG!A1:I1$/);

  // A row that reached the sheet but was never marked (crash after append) is not duplicated.
  await prisma.scanTransaction.update({ where: { id: fresh.id }, data: { googleLogSyncedAt: null } });
  const repeated = await syncTransactionLogToSheet();
  assert.equal(repeated.rowsAppended, 0);
  assert.equal(repeated.duplicatesSkipped, 1);
  assert.equal(sheets.appends.length, 1);
  assert.equal(await prisma.scanTransaction.count({ where: { googleLogSyncedAt: null } }), 0);

  // The explicit rebuild still rewrites everything, as RAW values.
  const rebuilt = await rebuildTransactionLogFromDatabase();
  assert.equal(rebuilt.rowsRebuilt, existing.length + 1);
  assert.deepEqual(sheets.cleared, ['LOG!A2:I']);
  const rebuildWrite = sheets.writes.find((write) => write.range === 'LOG!A2:I');
  assert.equal(rebuildWrite?.valueInputOption, 'RAW');
  assert.equal(rebuildWrite?.values.length, existing.length + 1);
  assert.equal(log.length, existing.length + 2);
});

test('camp meeting redemption write-back sends names as RAW values in one batch', async (t) => {
  await prisma.setting.update({ where: { id: 1 }, data: { mealTrackingMode: 'camp_meeting', googleSheetTabName: "Camp's Tickets" } });
  t.after(() => prisma.setting.update({ where: { id: 1 }, data: { mealTrackingMode: 'tally', googleSheetTabName: 'Sheet1' } }));
  const base = { mealType: 'LUNCH' as const, mealDay: 'MON' as const, redeemed: true, redeemedAt: new Date('2031-02-03T12:00:00Z'), mealDate: '2031-02-03' };
  const first = await prisma.mealEntitlement.create({ data: { ...base, personId: 'R1', personName: '=cmd|x', sourceSheetRow: 7, sourceTicketId: 'T1' } });
  const second = await prisma.mealEntitlement.create({ data: { ...base, personId: 'R2', personName: 'Ann', redeemedBy: '+Station', sourceSheetRow: 9, sourceTicketId: 'T2' } });
  const orphan = await prisma.mealEntitlement.create({ data: { ...base, personId: 'R3', personName: 'No Row', sourceTicketId: 'T3' } });
  const sheets = fakeSheets({});
  t.mock.method(google, 'sheets', sheets.factory);
  const result = await writeBackCampMeetingRedemptions(true);
  assert.equal(result.writeBackRowsUpdated, 2);
  assert.deepEqual(sheets.writes, [
    { range: "'Camp''s Tickets'!I7:K7", values: [['yes', '2031-02-03T12:00:00.000Z', '=cmd|x']], valueInputOption: 'RAW' },
    { range: "'Camp''s Tickets'!I9:K9", values: [['yes', '2031-02-03T12:00:00.000Z', '+Station']], valueInputOption: 'RAW' }
  ]);
  assert.ok((await prisma.mealEntitlement.findUniqueOrThrow({ where: { id: first.id } })).sheetSyncedAt);
  assert.ok((await prisma.mealEntitlement.findUniqueOrThrow({ where: { id: second.id } })).sheetSyncedAt);
  assert.equal((await prisma.mealEntitlement.findUniqueOrThrow({ where: { id: orphan.id } })).sheetSyncedAt, null);
});
