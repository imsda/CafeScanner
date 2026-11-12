import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useIsolatedDatabase, startTestApp } from './helpers/testApp.js';

// Always use an isolated database; never touch the application's configured data.
const database = useIsolatedDatabase('import');
const { prisma } = await import('../src/db.js');
const bcrypt = (await import('bcryptjs')).default;
const client = await startTestApp();
const { request, login } = client;

await prisma.setting.create({ data: { id: 1, mealTrackingMode: 'tally', timezone: 'Etc/UTC' } });
await prisma.adminUser.create({ data: { username: 'admin', passwordHash: await bcrypt.hash('test-password-123', 4), role: 'ADMIN' } });
const admin = await login('admin');

test.after(async () => {
  await client.close();
  await prisma.$disconnect();
  database.cleanup();
});

type Mode = 'tally' | 'countdown' | 'camp_meeting';
const setMode = (mealTrackingMode: Mode) => prisma.setting.update({ where: { id: 1 }, data: { mealTrackingMode } });

async function upload(path: '/api/import/preview' | '/api/import/commit', csv: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new Blob([csv]), 'upload.csv');
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await request(path, { method: 'POST', cookie: admin, body: form });
  return { status: response.status, body: await response.json() };
}

const CAMP_HEADER = 'ticket_id,reg_id,guest_name,meal_type,meal_day,meal_date,ticket_type,price,redeemed,redeemed_at,redeemed_by,notes';

test('names-only re-import keeps counts, balances, details, badge code and inactive status', async () => {
  await setMode('tally');
  const before = await prisma.person.create({
    data: {
      firstName: 'Old', lastName: 'Name', personId: 'keep-1', codeValue: 'BADGE-KEEP-1', personType: 'STAFF',
      breakfastRemaining: 3, lunchRemaining: 4, dinnerRemaining: 5,
      breakfastCount: 6, lunchCount: 7, dinnerCount: 8, totalMealsCount: 21,
      active: false, grade: '11', group: 'Choir', campus: 'North', notes: 'allergy'
    }
  });

  const { status, body } = await upload('/api/import/commit', 'firstName,lastName,personId\nNew,Surname,keep-1\n', { generateMissingCodes: 'true' });
  assert.equal(status, 200);
  assert.equal(body.successRows, 1);
  assert.equal(body.failedRows, 0);

  const after = await prisma.person.findUniqueOrThrow({ where: { personId: 'keep-1' } });
  assert.deepEqual(
    { ...after, updatedAt: null },
    { ...before, firstName: 'New', lastName: 'Surname', updatedAt: null }
  );
});

test('a column that is present but empty for a row does not erase the stored value', async () => {
  await setMode('countdown');
  await prisma.person.create({
    data: { firstName: 'A', lastName: 'B', personId: 'keep-2', codeValue: 'BADGE-KEEP-2', lunchRemaining: 9, dinnerRemaining: 2, grade: '10', active: false }
  });

  const csv = 'firstName,lastName,personId,lunchRemaining,dinnerRemaining,grade,active\nA,B,keep-2,,7,,\n';
  assert.equal((await upload('/api/import/commit', csv)).body.successRows, 1);

  const after = await prisma.person.findUniqueOrThrow({ where: { personId: 'keep-2' } });
  assert.equal(after.lunchRemaining, 9);
  assert.equal(after.dinnerRemaining, 7);
  assert.equal(after.grade, '10');
  assert.equal(after.active, false);
});

test('a file with a UTF-8 byte order mark imports', async () => {
  await setMode('tally');
  const { status, body } = await upload('/api/import/commit', '﻿firstName,lastName,personId\nBom,Person,bom-1\n');
  assert.equal(status, 200);
  assert.equal(body.successRows, 1);
  assert.deepEqual(body.recognizedColumns, ['firstName', 'lastName', 'personId']);

  const person = await prisma.person.findUniqueOrThrow({ where: { personId: 'bom-1' } });
  assert.equal(person.firstName, 'Bom');
  assert.equal(person.active, true);
  assert.equal(person.totalMealsCount, 0);
  assert.ok(person.codeValue);
});

test('the downloaded tally template round-trips through the importer', async () => {
  await setMode('tally');
  const template = await (await request('/api/import/template', { cookie: admin })).text();
  assert.equal(template, 'ID,Name,Breakfast,Lunch,Dinner,Total,User Type\n');

  const { status, body } = await upload('/api/import/commit', `${template}T-1,Mary Ann Smith,2,3,4,999,Staff\n`);
  assert.equal(status, 200);
  assert.equal(body.successRows, 1);
  assert.deepEqual(body.ignoredColumns, ['Total']);

  const person = await prisma.person.findUniqueOrThrow({ where: { personId: 'T-1' } });
  assert.equal(person.firstName, 'Mary Ann');
  assert.equal(person.lastName, 'Smith');
  assert.deepEqual([person.breakfastCount, person.lunchCount, person.dinnerCount], [2, 3, 4]);
  assert.equal(person.totalMealsCount, 9, 'the total is recomputed from the counts, not read from the file');
  assert.equal(person.personType, 'STAFF');
  assert.deepEqual([person.breakfastRemaining, person.lunchRemaining, person.dinnerRemaining], [0, 0, 0]);
});

test('bare meal columns are balances in countdown mode; ?format=csv serves the people CSV template', async () => {
  await setMode('countdown');
  const csvTemplate = await (await request('/api/import/template?format=csv', { cookie: admin })).text();
  assert.equal(csvTemplate, 'firstName,lastName,personId,personType,breakfastRemaining,lunchRemaining,dinnerRemaining,grade,group,campus,notes\n');
  assert.equal(await (await request('/api/import/template', { cookie: admin })).text(), 'ID,Name,Breakfast,Lunch,Dinner,Total\n');

  assert.equal((await upload('/api/import/commit', 'Student ID,First Name,last_name,BREAKFAST,Lunch,Dinner\nC-1,Count,Down,5,6,7\n')).body.successRows, 1);
  const person = await prisma.person.findUniqueOrThrow({ where: { personId: 'C-1' } });
  assert.deepEqual([person.breakfastRemaining, person.lunchRemaining, person.dinnerRemaining], [5, 6, 7]);
  assert.equal(person.totalMealsCount, 0);

  await setMode('tally');
  assert.equal(await (await request('/api/import/template?format=csv', { cookie: admin })).text(), 'firstName,lastName,personId,personType,grade,group,campus,notes\n');
});

test('an invalid number is a row error and nothing is written for that row', async () => {
  await setMode('tally');
  await prisma.person.create({ data: { firstName: 'Num', lastName: 'Ber', personId: 'num-1', codeValue: 'BADGE-NUM-1', lunchCount: 5, totalMealsCount: 5 } });

  const csv = [
    'firstName,lastName,personId,lunchCount,personType',
    'Changed,Name,num-1,lots,',
    'Neg,Ative,num-2,-1,',
    'Frac,Tion,num-3,1.5,',
    'Bad,Type,num-4,1,Wizard',
    'Good,Row,num-5,2,4'
  ].join('\n');
  const { status, body } = await upload('/api/import/commit', csv);
  assert.equal(status, 200);
  assert.equal(body.successRows, 1);
  assert.equal(body.failedRows, 4);
  assert.deepEqual(body.errors.map((entry: { row: number }) => entry.row), [1, 2, 3, 4]);
  assert.match(body.errors[0].error, /lunchCount must be a whole number/);

  const untouched = await prisma.person.findUniqueOrThrow({ where: { personId: 'num-1' } });
  assert.equal(untouched.firstName, 'Num');
  assert.equal(untouched.lunchCount, 5);
  assert.equal(await prisma.person.count({ where: { personId: { in: ['num-2', 'num-3', 'num-4'] } } }), 0);

  const good = await prisma.person.findUniqueOrThrow({ where: { personId: 'num-5' } });
  assert.equal(good.lunchCount, 2);
  assert.equal(good.totalMealsCount, 2);
  assert.equal(good.personType, 'VILLAGE_STUDENT');
});

test('people preview and commit agree on which rows are valid', async () => {
  await setMode('tally');
  const csv = [
    'ID,Name,Breakfast,Favourite Colour',
    'agree-1,Valid Person,1,blue',
    ',Missing Id,1,red',
    'agree-3,,1,green',
    'agree-4,Bad Count,x,pink',
    'agree-5,Mononym,,'
  ].join('\n');

  const preview = await upload('/api/import/preview', csv);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.total, 5);
  assert.equal(preview.body.mode, 'tally');
  assert.deepEqual(preview.body.recognizedColumns, ['ID', 'Name', 'Breakfast']);
  assert.deepEqual(preview.body.ignoredColumns, ['Favourite Colour']);
  const previewValid = preview.body.preview.map((row: { valid: boolean }) => row.valid);
  assert.deepEqual(previewValid, [true, false, false, false, true]);
  assert.equal(await prisma.person.count({ where: { personId: { startsWith: 'agree-' } } }), 0, 'preview writes nothing');

  const commit = await upload('/api/import/commit', csv);
  assert.equal(commit.body.totalRows, 5);
  assert.equal(commit.body.successRows, 2);
  const failedRows = commit.body.errors.map((entry: { row: number }) => entry.row);
  const previewInvalid = preview.body.preview.filter((row: { valid: boolean }) => !row.valid).map((row: { index: number }) => row.index);
  assert.deepEqual(failedRows, previewInvalid);
  const imported = await prisma.person.findMany({ where: { personId: { startsWith: 'agree-' } }, orderBy: { personId: 'asc' } });
  assert.deepEqual(imported.map((person) => person.personId), ['agree-1', 'agree-5']);
});

test('camp meeting preview and commit agree, and use the header names rather than column positions', async () => {
  await setMode('camp_meeting');
  // reg_id and guest_name are swapped relative to the template to prove the mapping is by header.
  const csv = [
    'ticket_id,guest_name,reg_id,meal_type,meal_day,meal_date,ticket_type,price,redeemed,redeemed_at,redeemed_by,notes',
    't1,Ann Camper,R100,Lunch,Monday,2026-06-15,adult,5,,,,',
    't2,Ann Camper,R100,Brunch,Monday,,adult,5,,,,',
    't3,,R101,Dinner,Tue,,adult,5,,,,',
    't4,Bob Camper,R102,Supper,Friday,13/45/26,adult,5,,,,',
    't5,Bob Camper,R102,Supper,Fri,6/19/26,adult,5,yes,,,'
  ].join('\n');

  const preview = await upload('/api/import/preview', `﻿${csv}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.total, 5);
  assert.equal(preview.body.mode, 'camp_meeting');
  assert.deepEqual(preview.body.preview.map((row: { valid: boolean }) => row.valid), [true, false, false, false, true]);
  assert.deepEqual(preview.body.preview[1].errors, ['invalid meal_type']);
  assert.equal(preview.body.preview[4].mealType, 'DINNER');
  assert.equal(preview.body.preview[4].mealDate, '2026-06-19');
  assert.equal(await prisma.mealEntitlement.count(), 0, 'preview writes nothing');

  const commit = await upload('/api/import/commit', `﻿${csv}`);
  assert.equal(commit.status, 200);
  assert.equal(commit.body.validRows, 2);
  assert.equal(commit.body.skippedRows, 3);
  // Commit reports file row numbers (header = row 1); the preview list is in the same order.
  const previewInvalidRows = preview.body.preview.flatMap((row: { valid: boolean }, idx: number) => (row.valid ? [] : [idx + 2]));
  assert.deepEqual(commit.body.skippedRowReasons.map((entry: { row: number }) => entry.row), previewInvalidRows);
  assert.equal(await prisma.mealEntitlement.count(), 2);

  const badHeader = 'ticket_id,reg_id,guest_name\nt1,R1,Ann\n';
  assert.equal((await upload('/api/import/preview', badHeader)).status, 400);
  assert.equal((await upload('/api/import/commit', badHeader, { replaceExisting: 'true' })).status, 400);
  assert.equal(await prisma.mealEntitlement.count(), 2);
});

test('camp meeting replace with an all-invalid file returns 400 and keeps existing entitlements', async () => {
  await setMode('camp_meeting');
  await prisma.mealEntitlement.deleteMany({});
  await prisma.mealEntitlement.createMany({
    data: [
      { personId: 'R200', personName: 'Keep Me', mealType: 'LUNCH', mealDay: 'MON', mealDate: '2026-06-15', redeemed: true },
      { personId: 'R200', personName: 'Keep Me', mealType: 'DINNER', mealDay: 'MON', mealDate: '2026-06-15' }
    ]
  });

  const allInvalid = `${CAMP_HEADER}\nt1,,No Id,Lunch,Monday,,,,,,,\nt2,R300,Bad Meal,Snack,Monday,,,,,,,\n`;
  const rejected = await upload('/api/import/commit', allInvalid, { replaceExisting: 'true' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /No valid rows/);
  const kept = await prisma.mealEntitlement.findMany({ orderBy: { id: 'asc' } });
  assert.equal(kept.length, 2);
  assert.equal(kept[0].redeemed, true);

  // Without confirmation an import over existing tickets is still refused, and changes nothing.
  const valid = `${CAMP_HEADER}\nt9,R400,New Camper,Breakfast,Wed,,,,,,,\n`;
  assert.equal((await upload('/api/import/commit', valid)).status, 409);
  assert.equal(await prisma.mealEntitlement.count(), 2);

  // A valid replace swaps the tickets.
  const replaced = await upload('/api/import/commit', valid, { replaceExisting: 'true' });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.entitlementsCreated, 1);
  const now = await prisma.mealEntitlement.findMany();
  assert.deepEqual(now.map((row) => row.personId), ['R400']);
});
