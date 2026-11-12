import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useIsolatedDatabase, startTestApp } from './helpers/testApp.js';

// Always use an isolated database; never touch the application's configured data.
const database = useIsolatedDatabase('reports');
const { prisma } = await import('../src/db.js');
const bcrypt = (await import('bcryptjs')).default;
const client = await startTestApp();
const { request, login } = client;

const passwordHash = await bcrypt.hash('test-password-123', 4);
await prisma.setting.create({ data: { id: 1, mealTrackingMode: 'tally', timezone: 'Etc/UTC', studentMealWarningDays: 3 } });
await prisma.adminUser.create({ data: { username: 'admin', passwordHash, role: 'ADMIN' } });

// Two people; scans on 2026-03-10 (in range) plus one on 2026-03-01 (out of range).
const alice = await prisma.person.create({ data: { firstName: 'Alice', lastName: 'Anderson', personId: 'rep-100', codeValue: 'code-rep-100', personType: 'STAFF' } });
const bob = await prisma.person.create({ data: { firstName: 'Bob', lastName: 'Baker', personId: 'rep-200', codeValue: 'code-rep-200', personType: 'GUEST' } });
const at = (time: string) => new Date(`2026-03-10T${time}:00.000Z`);
await prisma.scanTransaction.createMany({
  data: [
    { timestamp: at('07:30'), scannedValue: 'rep-100', personId: alice.id, mealType: 'BREAKFAST', result: 'SUCCESS' },
    { timestamp: at('12:00'), scannedValue: 'rep-100', personId: alice.id, mealType: 'LUNCH', result: 'SUCCESS' },
    { timestamp: at('12:01'), scannedValue: 'rep-100', personId: alice.id, mealType: 'LUNCH', result: 'SUCCESS' },
    { timestamp: at('18:00'), scannedValue: 'rep-100', personId: alice.id, mealType: 'DINNER', result: 'SUCCESS' },
    { timestamp: at('12:05'), scannedValue: 'rep-200', personId: bob.id, mealType: 'LUNCH', result: 'SUCCESS' },
    { timestamp: at('12:06'), scannedValue: 'rep-200', personId: bob.id, mealType: 'LUNCH', result: 'FAILURE', failureReason: 'COOLDOWN_ACTIVE' },
    { timestamp: at('12:07'), scannedValue: 'mystery-999', mealType: 'LUNCH', result: 'FAILURE', failureReason: 'INVALID_PERSON_ID' },
    { timestamp: new Date('2026-03-01T12:00:00.000Z'), scannedValue: 'rep-200', personId: bob.id, mealType: 'DINNER', result: 'SUCCESS' }
  ]
});

test.after(async () => {
  await client.close();
  await prisma.$disconnect();
  database.cleanup();
});

test('report summary aggregates stats and meal totals without returning the scans', async () => {
  const admin = await login('admin');
  const response = await request('/api/reports/summary?from=2026-03-10&to=2026-03-10', { cookie: admin });
  assert.equal(response.status, 200);
  const summary = await response.json();

  assert.equal(summary.mealTrackingMode, 'tally');
  assert.deepEqual(summary.stats, { scans: 7, breakfastsServed: 1, lunchesServed: 3, dinnersServed: 1, failedScans: 2 });
  assert.deepEqual(summary.tallySummary, { breakfastCount: 1, lunchCount: 3, dinnerCount: 1, totalMealsCount: 5 });
  assert.deepEqual(summary.remainingBalanceSummary, { breakfastRemaining: 0, lunchRemaining: 0, dinnerRemaining: 0 });
  assert.deepEqual(summary.entitlementSummary, { totalEntitlements: 0, totalRedeemed: 0, totalRemaining: 0 });
  assert.deepEqual(summary.mealTotalsByPerson, [
    { personId: 'rep-100', firstName: 'Alice', lastName: 'Anderson', personType: 'STAFF', breakfasts: 1, lunches: 2, dinners: 1, total: 4 },
    { personId: 'rep-200', firstName: 'Bob', lastName: 'Baker', personType: 'GUEST', breakfasts: 0, lunches: 1, dinners: 0, total: 1 }
  ]);
  assert.deepEqual(summary.perPersonUsage, summary.mealTotalsByPerson);
  assert.equal('transactions' in summary, false, 'the summary must not return the scans themselves');

  // A wider range picks up the earlier dinner as well.
  const wide = await (await request('/api/reports/summary?from=2026-03-01&to=2026-03-10', { cookie: admin })).json();
  assert.equal(wide.stats.scans, 8);
  assert.equal(wide.stats.dinnersServed, 2);
  assert.deepEqual(wide.mealTotalsByPerson.map((row: { personId: string; total: number; dinners: number }) => [row.personId, row.total, row.dinners]), [['rep-100', 4, 1], ['rep-200', 2, 1]]);

  // A range with no scans is all zeroes.
  const empty = await (await request('/api/reports/summary?from=2026-02-01&to=2026-02-02', { cookie: admin })).json();
  assert.deepEqual(empty.stats, { scans: 0, breakfastsServed: 0, lunchesServed: 0, dinnersServed: 0, failedScans: 0 });
  assert.deepEqual(empty.mealTotalsByPerson, []);

  const csv = await request('/api/reports/export.csv?from=2026-03-10&to=2026-03-10', { cookie: admin });
  assert.equal(csv.status, 200);
  assert.equal((await csv.text()).trim().split('\n').length, 8, 'header plus the seven scans in range');
});

test('report summary uses redeemed entitlements in camp meeting mode and balances in countdown mode', async () => {
  const admin = await login('admin');
  await prisma.person.update({ where: { id: bob.id }, data: { lunchRemaining: 4, dinnerRemaining: 2, lunchCount: 6, totalMealsCount: 6 } });
  try {
    await prisma.setting.update({ where: { id: 1 }, data: { mealTrackingMode: 'countdown' } });
    const countdown = await (await request('/api/reports/summary?from=2026-03-10&to=2026-03-10', { cookie: admin })).json();
    assert.deepEqual(countdown.remainingBalanceSummary, { breakfastRemaining: 0, lunchRemaining: 4, dinnerRemaining: 2 });
    assert.deepEqual(countdown.tallySummary, { breakfastCount: 0, lunchCount: 6, dinnerCount: 0, totalMealsCount: 6 });
    assert.equal(countdown.mealTotalsByPerson.length, 2);

    await prisma.mealEntitlement.createMany({
      data: [
        { personId: 'rep-200', personName: 'Bob Baker', mealType: 'LUNCH', mealDay: 'TUE', mealDate: '2026-03-10', redeemed: true, redeemedAt: at('12:05') },
        { personId: 'walkup-1', personName: 'Carla De Soto', mealType: 'DINNER', mealDay: 'TUE', mealDate: '2026-03-10', redeemed: true, redeemedAt: at('18:10') },
        { personId: 'walkup-1', personName: 'Carla De Soto', mealType: 'BREAKFAST', mealDay: 'WED', mealDate: '2026-03-11', redeemed: false }
      ]
    });
    await prisma.setting.update({ where: { id: 1 }, data: { mealTrackingMode: 'camp_meeting' } });
    const camp = await (await request('/api/reports/summary?from=2026-03-10&to=2026-03-10', { cookie: admin })).json();
    assert.deepEqual(camp.entitlementSummary, { totalEntitlements: 3, totalRedeemed: 2, totalRemaining: 1 });
    assert.deepEqual(camp.mealTotalsByPerson, [
      { personId: 'rep-200', firstName: 'Bob', lastName: 'Baker', personType: 'GUEST', breakfasts: 0, lunches: 1, dinners: 0, total: 1 },
      { personId: 'walkup-1', firstName: 'Carla', lastName: 'De Soto', personType: 'GUEST', breakfasts: 0, lunches: 0, dinners: 1, total: 1 }
    ]);
  } finally {
    await prisma.mealEntitlement.deleteMany();
    await prisma.setting.update({ where: { id: 1 }, data: { mealTrackingMode: 'tally' } });
    await prisma.person.update({ where: { id: bob.id }, data: { lunchRemaining: 0, dinnerRemaining: 0, lunchCount: 0, totalMealsCount: 0 } });
  }
});

test('transactions support search, result filter, paging and a total count header', async () => {
  const admin = await login('admin');
  const range = 'from=2026-03-10&to=2026-03-10';
  type Row = { id: number; scannedValue: string; result: string; person: { personId: string } | null };
  const list = async (query: string) => {
    const response = await request(`/api/transactions?${query}`, { cookie: admin });
    assert.equal(response.status, 200, query);
    return { total: response.headers.get('x-total-count'), rows: (await response.json()) as Row[] };
  };

  const all = await list(range);
  assert.equal(all.total, '7');
  assert.equal(all.rows.length, 7);

  const failed = await list(`${range}&result=FAILURE`);
  assert.equal(failed.total, '2');
  assert.ok(failed.rows.every((row) => row.result === 'FAILURE'));

  // q matches the person's name (any case), their Person ID, or the raw scanned value.
  const byName = await list(`${range}&q=anderson`);
  assert.equal(byName.total, '4');
  assert.ok(byName.rows.every((row) => row.person?.personId === 'rep-100'));
  assert.equal((await list(`${range}&q=${encodeURIComponent('alice anderson')}`)).total, '4');
  assert.equal((await list(`${range}&q=${encodeURIComponent('alice baker')}`)).total, '0');
  assert.equal((await list(`${range}&q=rep-200`)).total, '2');
  const byValue = await list(`${range}&q=mystery`);
  assert.equal(byValue.total, '1');
  assert.equal(byValue.rows[0].scannedValue, 'mystery-999');
  assert.equal((await list(`${range}&q=baker&result=SUCCESS`)).total, '1');
  assert.equal((await list(`${range}&q=${encodeURIComponent('   ')}`)).total, '7', 'a blank search is ignored');

  // Paging: newest first, the header always carries the full match count.
  const firstPage = await list(`${range}&limit=3`);
  const secondPage = await list(`${range}&limit=3&offset=3`);
  const lastPage = await list(`${range}&limit=3&offset=6`);
  assert.deepEqual([firstPage.total, secondPage.total, lastPage.total], ['7', '7', '7']);
  assert.deepEqual([firstPage.rows.length, secondPage.rows.length, lastPage.rows.length], [3, 3, 1]);
  assert.deepEqual(
    [...firstPage.rows, ...secondPage.rows, ...lastPage.rows].map((row) => row.id),
    all.rows.map((row) => row.id)
  );
  assert.equal((await list(`${range}&offset=50`)).rows.length, 0);

  for (const bad of ['limit=0', 'limit=1001', 'limit=abc', 'offset=-1']) {
    assert.equal((await request(`/api/transactions?${bad}`, { cookie: admin })).status, 400, bad);
  }

  // The export honours the same filters.
  const csv = await (await request(`/api/transactions/export.csv?${range}&q=mystery`, { cookie: admin })).text();
  assert.equal(csv.trim().split('\n').length, 2);
  assert.ok(csv.includes('mystery-999'));
});

test('scan warning status is cached and invalidated when a warning is cleared or the village setting changes', async () => {
  const admin = await login('admin');
  const status = async () => (await (await request('/api/scan/warnings/status', { cookie: admin })).json()).hasWarnings as boolean;
  const reportCount = async () => (await (await request('/api/reports/students-not-eating', { cookie: admin })).json()).students.length as number;

  assert.equal(await status(), false);

  // A new warning does not show up on the stations until the cached answer expires...
  const student = await prisma.person.create({
    data: { firstName: 'Dana', lastName: 'Dormer', personId: 'rep-300', codeValue: 'code-rep-300', personType: 'STUDENT', mealWarningSince: new Date() }
  });
  assert.equal(await status(), false, 'status is served from the cache');
  // ...while the Reports endpoint is always computed fresh.
  assert.equal(await reportCount(), 1);

  // Clearing any warning invalidates the cache.
  const village = await prisma.person.create({
    data: { firstName: 'Vera', lastName: 'Village', personId: 'rep-400', codeValue: 'code-rep-400', personType: 'VILLAGE_STUDENT', mealWarningSince: new Date() }
  });
  assert.equal((await request(`/api/reports/students-not-eating/${village.id}/clear`, { method: 'POST', cookie: admin })).status, 200);
  assert.equal(await status(), true, 'cache was invalidated by the clear');

  assert.equal((await request(`/api/reports/students-not-eating/${student.id}/clear`, { method: 'POST', cookie: admin })).status, 200);
  assert.equal(await status(), false);
  assert.equal(await reportCount(), 0);

  // Changing the village setting invalidates it too.
  await prisma.person.update({ where: { id: village.id }, data: { mealWarningSince: new Date() } });
  assert.equal(await status(), false, 'still cached');
  const off = await request('/api/reports/students-not-eating/settings', { method: 'PUT', cookie: admin, json: { villageStudentMealWarningsEnabled: false } });
  assert.equal(off.status, 200);
  assert.equal(await status(), false, 'village students are excluded while the setting is off');
  const on = await request('/api/reports/students-not-eating/settings', { method: 'PUT', cookie: admin, json: { villageStudentMealWarningsEnabled: true } });
  assert.equal(on.status, 200);
  assert.equal(await status(), true, 'cache was invalidated by the setting change');
});
