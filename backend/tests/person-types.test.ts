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
  const writes: any[] = [];
  const appends: any[] = [];
  const sheetRows = [['Name', 'User Type', 'ID', 'Breakfast', 'Lunch', 'Dinner', 'Total'], ['Jane Smith', 'Staff', '00123', '0', '0', '0', '0']];
  t.mock.method(google, 'sheets', () => ({ spreadsheets: { values: {
    get: async () => ({ data: { values: sheetRows } }),
    update: async (request: any) => { writes.push(request); return {}; },
    append: async (request: any) => { appends.push(request); return {}; }
  } } }));
  await writeBackTallyCounts(true);
  assert.equal(writes.some((request) => /!B2$/.test(request.range)), false);
  assert.equal(writes.length, 4);
  const samRow = appends[0].requestBody.values.find((row: string[]) => row[2] === '00456');
  assert.equal(samRow[0], 'Sam Jones');
  assert.equal(samRow[1], 'STAFF');

});
