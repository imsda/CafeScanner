import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useIsolatedDatabase, startTestApp } from './helpers/testApp.js';

// Always use an isolated database; never touch the application's configured data.
const database = useIsolatedDatabase('people');
const { prisma } = await import('../src/db.js');
const bcrypt = (await import('bcryptjs')).default;
const client = await startTestApp();
const { request, login } = client;

const passwordHash = await bcrypt.hash('test-password-123', 4);
await prisma.setting.create({ data: { id: 1, mealTrackingMode: 'tally', timezone: 'Etc/UTC' } });
await prisma.adminUser.create({ data: { username: 'admin', passwordHash, role: 'ADMIN' } });
await prisma.adminUser.create({
  data: { username: 'custom', passwordHash, role: 'CUSTOM', pageAccess: { createMany: { data: [{ page: 'PEOPLE' }] } } }
});

test.after(async () => {
  await client.close();
  await prisma.$disconnect();
  database.cleanup();
});

let sequence = 0;
async function createPerson(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  return prisma.person.create({
    data: {
      firstName: 'Test',
      lastName: `Person${sequence}`,
      personId: `P-${sequence}`,
      codeValue: `CODE-${sequence}`,
      personType: 'STUDENT',
      ...overrides
    }
  });
}

test('partial PUT does not overwrite counts or balances written by a concurrent scan', async () => {
  const cookie = await login('custom');
  const person = await createPerson({ breakfastRemaining: 9, lunchRemaining: 9, dinnerRemaining: 9 });

  // A scan lands after the operator loaded the People page.
  await prisma.person.update({
    where: { id: person.id },
    data: { breakfastCount: 2, lunchCount: 1, dinnerCount: 3, totalMealsCount: 6, lunchRemaining: 8 }
  });

  const typeOnly = await request(`/api/people/${person.id}`, { method: 'PUT', cookie, json: { personType: 'STAFF' } });
  assert.equal(typeOnly.status, 200);
  const afterType = await typeOnly.json();
  assert.equal(afterType.personType, 'STAFF');
  assert.deepEqual(
    [afterType.breakfastCount, afterType.lunchCount, afterType.dinnerCount, afterType.totalMealsCount],
    [2, 1, 3, 6]
  );
  assert.deepEqual([afterType.breakfastRemaining, afterType.lunchRemaining, afterType.dinnerRemaining], [9, 8, 9]);

  // Only the count that was sent changes; the total uses the database values of the others.
  const lunchOnly = await request(`/api/people/${person.id}`, { method: 'PUT', cookie, json: { lunchCount: 5 } });
  assert.equal(lunchOnly.status, 200);
  const stored = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
  assert.deepEqual([stored.breakfastCount, stored.lunchCount, stored.dinnerCount, stored.totalMealsCount], [2, 5, 3, 10]);
  assert.equal(stored.personType, 'STAFF');

  // One balance sent: the other balances and all counts stay as they are.
  const balanceOnly = await request(`/api/people/${person.id}`, { method: 'PUT', cookie, json: { dinnerRemaining: 4 } });
  assert.equal(balanceOnly.status, 200);
  const afterBalance = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
  assert.deepEqual([afterBalance.breakfastRemaining, afterBalance.lunchRemaining, afterBalance.dinnerRemaining], [9, 8, 4]);
  assert.equal(afterBalance.totalMealsCount, 10);
});

test('a client-supplied total is ignored: the total always equals the sum of the counts', async () => {
  const cookie = await login('custom');
  const person = await createPerson({ breakfastCount: 1, lunchCount: 1, dinnerCount: 1, totalMealsCount: 3 });

  const staleTotal = await request(`/api/people/${person.id}`, { method: 'PUT', cookie, json: { totalMealsCount: 99 } });
  assert.equal(staleTotal.status, 200);
  assert.equal((await staleTotal.json()).totalMealsCount, 3);

  const withCount = await request(`/api/people/${person.id}`, { method: 'PUT', cookie, json: { dinnerCount: 4, totalMealsCount: 99 } });
  assert.equal((await withCount.json()).totalMealsCount, 6);
});

test('PUT edits identity fields and returns 409 for a duplicate person ID or badge code', async () => {
  const cookie = await login('custom');
  const first = await createPerson();
  const second = await createPerson();

  const edited = await request(`/api/people/${second.id}`, {
    method: 'PUT',
    cookie,
    json: { firstName: 'Renamed', grade: '7', notes: null, active: false }
  });
  assert.equal(edited.status, 200);
  const body = await edited.json();
  assert.equal(body.firstName, 'Renamed');
  assert.equal(body.grade, '7');
  assert.equal(body.active, false);
  assert.equal(body.personId, second.personId, 'fields that were not sent are untouched');

  const duplicateId = await request(`/api/people/${second.id}`, { method: 'PUT', cookie, json: { personId: first.personId } });
  assert.equal(duplicateId.status, 409);
  assert.equal(typeof (await duplicateId.json()).error, 'string');

  const duplicateCode = await request(`/api/people/${second.id}`, { method: 'PUT', cookie, json: { codeValue: first.codeValue } });
  assert.equal(duplicateCode.status, 409);

  const unchanged = await prisma.person.findUniqueOrThrow({ where: { id: second.id } });
  assert.equal(unchanged.personId, second.personId);
  assert.equal(unchanged.codeValue, second.codeValue);

  assert.equal((await request('/api/people/999999', { method: 'PUT', cookie, json: { firstName: 'Nobody' } })).status, 404);
});

test('delete and bulk-set require an admin; PEOPLE page access alone is not enough', async () => {
  const customCookie = await login('custom');
  const adminCookie = await login('admin');
  const person = await createPerson({ breakfastRemaining: 1 });
  const confirmation = { confirmationPhrase: 'DELETE PERSON' };

  // The CUSTOM user can still use the rest of the People page.
  assert.equal((await request('/api/people?showInactive=true', { cookie: customCookie })).status, 200);

  const customDelete = await request(`/api/people/${person.id}`, { method: 'DELETE', cookie: customCookie, json: confirmation });
  assert.equal(customDelete.status, 403);
  const customBulk = await request('/api/people/bulk-set', { method: 'POST', cookie: customCookie, json: { breakfast: 7 } });
  assert.equal(customBulk.status, 403);
  const untouched = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
  assert.equal(untouched.breakfastRemaining, 1);

  const adminBulk = await request('/api/people/bulk-set', { method: 'POST', cookie: adminCookie, json: { breakfast: 7 } });
  assert.equal(adminBulk.status, 200);
  assert.equal((await prisma.person.findUniqueOrThrow({ where: { id: person.id } })).breakfastRemaining, 7);

  const adminDelete = await request(`/api/people/${person.id}`, { method: 'DELETE', cookie: adminCookie, json: confirmation });
  assert.equal(adminDelete.status, 200);
  assert.equal(await prisma.person.findUnique({ where: { id: person.id } }), null);
});
