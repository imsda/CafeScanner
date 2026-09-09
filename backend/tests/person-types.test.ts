import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Always use an isolated database; never touch the application's configured data.
const directory = mkdtempSync(join(tmpdir(), 'cafescanner-types-'));
writeFileSync(join(directory, 'test.db'), '');
process.env.DATABASE_URL = `file:${join(directory, 'test.db')}`;
execFileSync(process.execPath, ['../node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: process.env, stdio: 'inherit' });
const { prisma } = await import('../src/db.js');
const { processScan } = await import('../src/services/scanService.js');

test('Tally Up person types and meal limits', async (t) => {
  t.after(async () => { await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true }); });
  const now = new Date('2030-09-09T16:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  await prisma.setting.create({ data: { id: 1, mealTrackingMode: 'tally', timezone: 'America/Chicago', allowManualMealOverride: true, scannerCooldownSeconds: 0 } });
  const student = await prisma.person.create({ data: { firstName: 'Test', lastName: 'Student', personId: 'student', codeValue: 'student', personType: 'STUDENT' } });
  const scan = (id: string, meal: 'BREAKFAST' | 'LUNCH' | 'DINNER' = 'LUNCH') => processScan(id, { manualMealOverride: meal });
  assert.equal((await scan('student')).ok, true);
  const duplicate = await scan('student');
  assert.equal(duplicate.ok, false);
  assert.equal('reason' in duplicate && duplicate.reason, 'STUDENT_MEAL_ALREADY_SCANNED');
  assert.equal((await scan('student', 'BREAKFAST')).ok, true);
  assert.equal((await scan('student', 'DINNER')).ok, true);
  assert.equal((await prisma.person.findUniqueOrThrow({ where: { id: student.id } })).totalMealsCount, 3);
  assert.equal(await prisma.scanTransaction.count({ where: { failureReason: 'STUDENT_MEAL_ALREADY_SCANNED' } }), 1);

  // Counter edits do not bypass the once-per-meal rule.
  await prisma.person.update({ where: { id: student.id }, data: { lunchCount: 0, totalMealsCount: 0 } });
  assert.equal((await scan('student')).ok, false);
  // Crossing UTC midnight alone does not start a new Chicago meal day.
  t.mock.timers.setTime(new Date('2030-09-10T01:00:00Z').getTime());
  assert.equal((await scan('student')).ok, false);
  t.mock.timers.setTime(new Date('2030-09-10T16:00:00Z').getTime());
  assert.equal((await scan('student')).ok, true);

  for (const personType of ['STAFF', 'GUEST'] as const) {
    await prisma.person.create({ data: { firstName: 'Test', lastName: personType, personId: personType, codeValue: personType, personType } });
    for (let i = 0; i < 3; i++) assert.equal((await scan(personType)).ok, true);
    assert.equal((await prisma.person.findUniqueOrThrow({ where: { personId: personType } })).lunchCount, 3);
  }
  await prisma.person.create({ data: { firstName: 'Concurrent', lastName: 'Student', personId: 'concurrent', codeValue: 'concurrent', personType: 'STUDENT' } });
  const concurrent = await Promise.all([scan('concurrent'), scan('concurrent')]);
  assert.equal(concurrent.filter((result) => result.ok).length, 1);
  assert.equal((await prisma.person.findUniqueOrThrow({ where: { personId: 'concurrent' } })).lunchCount, 1);

  const legacy = await prisma.person.create({ data: { firstName: 'Legacy', lastName: 'Person', personId: 'legacy', codeValue: 'legacy' } });
  assert.equal(legacy.personType, 'GUEST');

  await prisma.setting.update({ where: { id: 1 }, data: { mealTrackingMode: 'countdown' } });
  await prisma.person.update({ where: { id: student.id }, data: { lunchRemaining: 2 } });
  assert.equal((await scan('student')).ok, true);
  assert.equal((await scan('student')).ok, true);
  assert.equal((await scan('student')).ok, false);

  await prisma.setting.update({ where: { id: 1 }, data: { mealTrackingMode: 'tally' } });
  await prisma.person.update({ where: { personId: 'STAFF' }, data: { active: false } });
  assert.equal((await scan('STAFF')).ok, false);

  const { peopleSheetRows, parsePersonType } = await import('../src/services/peopleSheetRows.js');
  const { importPeopleFromRows, writeBackTallyCounts } = await import('../src/services/campMeetingSheetSyncService.js');
  const { searchPeople } = await import('../src/services/searchPeople.js');
  for (const [value, expected] of [['1', 'STUDENT'], ['student', 'STUDENT'], ['2', 'STAFF'], ['Staff', 'STAFF'], ['3', 'GUEST'], ['guest', 'GUEST']]) assert.equal(parsePersonType(value), expected);
  assert.equal(parsePersonType(' '), undefined);
  assert.throws(() => parsePersonType('4'));
  assert.throws(() => peopleSheetRows([['Wrong header']]));
  const rows = peopleSheetRows([
    ['Name', 'User Type', 'ID', 'Total', 'Dinner', 'Lunch', 'Breakfast'],
    ['Jane Smith', '1', '00123', '0', '0', '0', '0'],
    ['Sam Jones', 'Staff', '00456', '0', '0', '0', '0'],
    ['Invalid Person', 'Teacher', 'bad', '0', '0', '0', '0']
  ]);
  const options = { includeBalances: false, overwriteExistingBalances: false, overwriteExistingCounts: false };
  const imported = await importPeopleFromRows(rows, options);
  assert.equal(imported.peopleCreated, 2);
  assert.equal(imported.rowsSkipped, 1);
  assert.match(imported.errors[0], /User Type/);
  assert.equal((await prisma.person.findUniqueOrThrow({ where: { personId: '00123' } })).personType, 'STUDENT');
  // Six-column imports preserve an assigned type and existing counts.
  const legacyRows = peopleSheetRows([['ID', 'Name', 'Breakfast', 'Lunch', 'Dinner', 'Total'], ['00123', 'Jane Smith', '99', '99', '99', '297']]);
  await importPeopleFromRows(legacyRows, options);
  const jane = await prisma.person.findUniqueOrThrow({ where: { personId: '00123' } });
  assert.equal(jane.personType, 'STUDENT');
  assert.equal(jane.lunchCount, 0);
  assert.equal((await searchPeople('jane smith'))[0].personId, '00123');
  assert.equal((await searchPeople('00123'))[0].name, 'Jane Smith');
  assert.equal((await searchPeople('Jones'))[0].personId, '00456');
  assert.deepEqual(await searchPeople(''), []);
  assert.deepEqual(await searchPeople('does not exist'), []);
  assert.equal((await searchPeople('STAFF')).some((person) => person.personId === 'STAFF'), false);

  // Mock the Sheets boundary: existing type cells must never be overwritten.
  const { google } = await import('googleapis');
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test@example.com';
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----';
  await prisma.setting.update({ where: { id: 1 }, data: { googleSheetsEnabled: true, googleSheetId: 'test-sheet', googleSheetTabName: 'Sheet1' } });
  await prisma.person.update({ where: { id: jane.id }, data: { lunchCount: 3, totalMealsCount: 3 } });
  const writes: any[] = [];
  const appends: any[] = [];
  const sheetRows = [['Name', 'User Type', 'ID', 'Breakfast', 'Lunch', 'Dinner', 'Total'], ['Jane Smith', 'Staff', '00123', '0', '0', '0', '0']];
  t.mock.method(google, 'sheets', () => ({ spreadsheets: { values: {
    get: async () => ({ data: { values: sheetRows } }),
    update: async (request: any) => { writes.push(request); return {}; },
    batchUpdate: async (request: any) => { writes.push(...request.requestBody.data); return {}; },
    append: async (request: any) => { appends.push(request); return {}; }
  } } }));
  await writeBackTallyCounts(true);
  assert.equal(writes.some((request) => /!B2$/.test(request.range)), false);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((write) => write.range).sort(), ["'Sheet1'!E2", "'Sheet1'!G2"]);
  assert.equal(writes.every((write) => write.values[0][0] === 3), true);
  assert.equal(appends.length, 0, 'Database-only people must not be written into the master roster');

  const { writeBackWeeklyTallyNow } = await import('../src/services/campMeetingSheetSyncService.js');
  await prisma.scanTransaction.create({ data: { personId: jane.id, scannedValue: jane.personId, result: 'SUCCESS', mealType: 'LUNCH', timestamp: new Date('2030-09-10T16:00:00Z') } });
  await prisma.setting.update({ where: { id: 1 }, data: { tallyWeeklyRawTabName: "Cafe's Weekly Tally Raw" } });
  let weeklyRows: any[][] = [['Name', 'ID', 'Week Ending', 'Lunch', 'Week Starting', 'Total', 'Breakfast', 'Dinner']];
  const batches: any[] = [];
  const weeklyAppends: any[] = [];
  t.mock.method(google, 'sheets', () => ({ spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { title: "Cafe's Weekly Tally Raw", sheetId: 0 } }] } }),
    batchUpdate: async () => ({}),
    values: {
      get: async (request: any) => { assert.equal(request.range, "'Cafe''s Weekly Tally Raw'!A:ZZ"); assert.equal(request.valueRenderOption, 'UNFORMATTED_VALUE'); return { data: { values: weeklyRows } }; },
      update: async () => { throw new Error('Unexpected per-cell write'); },
      batchUpdate: async (request: any) => { batches.push(request); return {}; },
      append: async (request: any) => { weeklyAppends.push(request); weeklyRows.push(...request.requestBody.values); return {}; }
    }
  } }));
  const firstWeekly = await writeBackWeeklyTallyNow(true);
  assert.equal(firstWeekly.rowsAppended > 0, true);
  const janeWeekly = weeklyRows.find((row) => row[1] === '00123');
  assert.equal(janeWeekly[0], 'Jane Smith');
  assert.equal(janeWeekly[3], 1);
  assert.equal(typeof janeWeekly[4], 'number');
  assert.equal(weeklyAppends[0].valueInputOption, 'RAW');
  const secondWeekly = await writeBackWeeklyTallyNow(true);
  assert.equal(secondWeekly.rowsAppended, 0);
  assert.equal(secondWeekly.rowsUpdated, firstWeekly.rowsAppended);
  assert.equal(batches.length, 0, 'Unchanged weekly cells should not consume write quota');
  await prisma.scanTransaction.create({ data: { personId: jane.id, scannedValue: jane.personId, result: 'SUCCESS', mealType: 'LUNCH', timestamp: new Date('2030-09-10T16:00:00Z') } });
  await writeBackWeeklyTallyNow(true);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].requestBody.valueInputOption, 'RAW');
  assert.equal(batches[0].requestBody.data.length, 2, 'Only the changed lunch and total cells are sent');
  weeklyRows = [['Week Starting', 'Week Ending', 'ID', 'Name']];
  await assert.rejects(writeBackWeeklyTallyNow(true), /Missing required weekly tally write-back columns: breakfast, lunch, dinner, total/);


  const { syncTransactionLogToSheet } = await import('../src/services/campMeetingSheetSyncService.js');
  const localTransactions = await prisma.scanTransaction.findMany({ orderBy: { id: 'asc' } });
  const logRows: any[][] = [['old', 'preserved', '', '', '', '', '', String(localTransactions[0].id)]];
  let failAppend = true;
  let appendCalls = 0;
  t.mock.method(google, 'sheets', () => ({ spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { title: 'LOG', sheetId: 0 } }] } }),
    batchUpdate: async () => ({}),
    values: {
      get: async (request: any) => ({ data: { values: request.range.endsWith('A1:H1')
        ? [['Time', 'Value', 'Meal', 'Result', 'Reason', 'Person', 'Station', 'Transaction ID']] : logRows } }),
      clear: async () => { throw new Error('LOG must not be cleared'); },
      update: async () => { throw new Error('LOG must not be rewritten'); },
      append: async (request: any) => {
        appendCalls++;
        if (failAppend) throw new Error('Simulated Sheets failure');
        assert.equal(request.valueInputOption, 'RAW');
        logRows.push(...request.requestBody.values); return {};
      }
    }
  } }));
  await assert.rejects(syncTransactionLogToSheet(), /Simulated Sheets failure/);
  assert.equal(logRows.length, 1);
  assert.equal(logRows[0][1], 'preserved');
  failAppend = false;
  const logResult = await syncTransactionLogToSheet();
  assert.equal(logResult.rowsAppended, localTransactions.length - 1);
  assert.equal(logRows.length, localTransactions.length);
  const repeatedLog = await syncTransactionLogToSheet();
  assert.equal(repeatedLog.rowsAppended, 0);
  assert.equal(appendCalls, 2);
  assert.equal(new Set(logRows.map((row) => row[7])).size, localTransactions.length);

  const { runGoogleSheetsSyncSchedulerCheckNow, getGoogleSheetsSchedulerStatus } = await import('../src/services/campMeetingSheetSyncService.js');
  await prisma.setting.update({ where: { id: 1 }, data: { googleAutoImportEnabled: false, tallyWriteBackMode: 'lifetime' } });
  let logReads = 0;
  const quotaError = Object.assign(new Error('Quota exceeded'), { code: 429 });
  t.mock.method(google, 'sheets', () => ({ spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { title: 'LOG', sheetId: 0 } }] } }),
    batchUpdate: async () => ({}),
    values: {
      get: async (request: any) => {
        if (request.range.startsWith("'Sheet1'!")) return { data: { values: sheetRows } };
        logReads++;
        return { data: { values: request.range.endsWith('A1:H1')
          ? [['Time', 'Value', 'Meal', 'Result', 'Reason', 'Person', 'Station', 'Transaction ID']] : logRows } };
      },
      batchUpdate: async () => { throw quotaError; },
      append: async () => { throw new Error('Unexpected append'); }
    }
  } }));
  await assert.rejects(runGoogleSheetsSyncSchedulerCheckNow(), /quota exceeded/);
  assert.equal(logReads, 0, 'Automatic cycles do not repeat a recent LOG export');
  assert.match((await getGoogleSheetsSchedulerStatus()).lastSyncError || '', /429/);
  t.mock.timers.setTime(Date.now() + 16 * 60000);
  await assert.rejects(runGoogleSheetsSyncSchedulerCheckNow(), /quota exceeded/);
  assert.equal(logReads, 2, 'Due LOG export still runs when tally write-back fails');

});
