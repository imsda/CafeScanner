import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { useIsolatedDatabase, startTestApp } from './helpers/testApp.js';

// Always use an isolated database; never touch the application's configured data.
const database = useIsolatedDatabase('api');
const { prisma } = await import('../src/db.js');
const bcrypt = (await import('bcryptjs')).default;
const client = await startTestApp();
const { request, login } = client;

const PASSWORD = 'test-password-123';
const passwordHash = await bcrypt.hash(PASSWORD, 4);
await prisma.setting.create({ data: { id: 1, mealTrackingMode: 'tally', timezone: 'Etc/UTC', allowManualMealOverride: true, scannerCooldownSeconds: 0.5 } });
const owner = await prisma.adminUser.create({ data: { username: 'owner', passwordHash, role: 'OWNER' } });
await prisma.adminUser.create({ data: { username: 'admin', passwordHash, role: 'ADMIN' } });
await prisma.adminUser.create({ data: { username: 'scanner', passwordHash, role: 'SCANNER' } });
const custom = await prisma.adminUser.create({
  data: { username: 'custom', passwordHash, role: 'CUSTOM', pageAccess: { createMany: { data: [{ page: 'SETTINGS' }, { page: 'USER_MANAGEMENT' }] } } }
});

test.after(async () => {
  await client.close();
  await prisma.$disconnect();
  database.cleanup();
});

test('login validates input and never crashes the server', async () => {
  assert.equal((await request('/api/auth/login', { method: 'POST', json: {} })).status, 400);
  const malformed = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(malformed.status, 400);
  assert.equal((await request('/api/auth/login', { method: 'POST', json: { username: 'admin', password: 'wrong' } })).status, 401);
  assert.equal((await request('/api/health')).status, 200);

  const cookie = await login('admin');
  const me = await request('/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).role, 'ADMIN');
  assert.equal((await request('/api/auth/logout', { method: 'POST', cookie })).status, 200);
  assert.equal((await request('/api/auth/me', { cookie })).status, 401);
});

test('unknown API routes return JSON 404', async () => {
  const cookie = await login('admin');
  const response = await request('/api/does-not-exist', { cookie });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Not found.' });
});

test('role and page access matrix', async () => {
  assert.equal((await request('/api/settings')).status, 401);

  const scanner = await login('scanner');
  assert.equal((await request('/api/scan/settings', { cookie: scanner })).status, 200);
  assert.equal((await request('/api/settings', { cookie: scanner })).status, 403);
  assert.equal((await request('/api/users', { cookie: scanner })).status, 403);

  const customCookie = await login('custom');
  const me = await (await request('/api/auth/me', { cookie: customCookie })).json();
  assert.deepEqual(me.allowedPages, ['SETTINGS'], 'USER_MANAGEMENT cannot be granted to CUSTOM users');
  assert.equal((await request('/api/settings', { cookie: customCookie })).status, 200);
  assert.equal((await request('/api/users', { cookie: customCookie })).status, 403);
  for (const action of ['clear-meal-data', 'clear-people-import-data', 'reset-meal-tracking-data', 'clear-database']) {
    assert.equal((await request(`/api/system/${action}`, { method: 'POST', cookie: customCookie })).status, 403, action);
  }
  assert.equal((await request('/api/settings/meal-tracking-mode', { method: 'PUT', cookie: customCookie, json: { mealTrackingMode: 'countdown', confirmationPhrase: 'SWITCH MODE' } })).status, 403);
  assert.equal((await request('/api/system/backups/download', { cookie: customCookie })).status, 403);

  const admin = await login('admin');
  assert.equal((await request('/api/system/clear-meal-data', { method: 'POST', cookie: admin })).status, 200);
  assert.equal((await request('/api/settings/full-wipe/arm', { method: 'POST', cookie: admin, json: { confirmationPhrase: 'ARM FULL WIPE' } })).status, 403);

  const ownerCookie = await login('owner');
  assert.equal((await request('/api/settings/full-wipe/arm', { method: 'POST', cookie: ownerCookie, json: { confirmationPhrase: 'ARM FULL WIPE' } })).status, 200);
});

test('settings responses never expose full-wipe token state', async () => {
  const admin = await login('admin');
  for (const response of [
    await request('/api/settings', { cookie: admin }),
    await request('/api/settings', { method: 'PUT', cookie: admin, json: { schoolName: 'Test Academy' } })
  ]) {
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(Object.keys(body).some((key) => key.startsWith('fullWipe')), false);
    assert.equal(typeof body.studentMealWarningDays, 'number');
  }
  const invalid = await request('/api/settings', { method: 'PUT', cookie: admin, json: { scannerCooldownSeconds: 'soon' } });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /scannerCooldownSeconds/);
});

test('role changes and deletions take effect on existing sessions', async () => {
  const customCookie = await login('custom');
  assert.equal((await request('/api/settings', { cookie: customCookie })).status, 200);

  const admin = await login('admin');
  assert.equal((await request(`/api/users/${custom.id}`, { method: 'PATCH', cookie: admin, json: { role: 'SCANNER' } })).status, 200);
  assert.equal((await request('/api/settings', { cookie: customCookie })).status, 403);

  const temp = await request('/api/users', { method: 'POST', cookie: admin, json: { username: 'temp', password: PASSWORD, role: 'ADMIN' } });
  assert.equal(temp.status, 201);
  const tempCookie = await login('temp');
  assert.equal((await request(`/api/users/${(await temp.json()).id}`, { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal((await request('/api/settings', { cookie: tempCookie })).status, 401);

  // Restore for later tests.
  await request(`/api/users/${custom.id}`, { method: 'PATCH', cookie: admin, json: { role: 'CUSTOM', allowedPages: ['SETTINGS'] } });
});

test('user management validation', async () => {
  const admin = await login('admin');
  assert.equal((await request('/api/users', { method: 'POST', cookie: admin, json: { username: 'admin', password: PASSWORD, role: 'ADMIN' } })).status, 409);
  assert.equal((await request('/api/users', { method: 'POST', cookie: admin, json: { username: 'short', password: 'abc', role: 'ADMIN' } })).status, 400);
  assert.equal((await request('/api/users', { method: 'POST', cookie: admin, json: { username: 'boss', password: PASSWORD, role: 'OWNER' } })).status, 403);
  assert.equal((await request('/api/users', { method: 'POST', cookie: admin, json: { username: 'x', password: PASSWORD, role: 'SUPERUSER' } })).status, 400);
  assert.equal((await request(`/api/users/${owner.id}`, { method: 'DELETE', cookie: admin })).status, 403);
  assert.equal((await request('/api/users/abc', { method: 'DELETE', cookie: admin })).status, 400);
});

test('meta and badges endpoints work without SETTINGS or PEOPLE access', async () => {
  const admin = await login('admin');
  await request(`/api/users/${custom.id}`, { method: 'PATCH', cookie: admin, json: { role: 'CUSTOM', allowedPages: ['BADGES'] } });
  await prisma.person.create({ data: { firstName: 'Badge', lastName: 'Holder', personId: 'b-1', codeValue: 'code-b-1' } });

  const customCookie = await login('custom');
  const meta = await request('/api/meta', { cookie: customCookie });
  assert.equal(meta.status, 200);
  assert.equal((await meta.json()).mealTrackingMode, 'tally');
  const badges = await request('/api/meta/badges', { cookie: customCookie });
  assert.equal(badges.status, 200);
  assert.ok((await badges.json()).some((person: { codeValue: string }) => person.codeValue === 'code-b-1'));
  assert.equal((await request('/api/people', { cookie: customCookie })).status, 403);

  const scanner = await login('scanner');
  assert.equal((await request('/api/meta/badges', { cookie: scanner })).status, 403);
  await request(`/api/users/${custom.id}`, { method: 'PATCH', cookie: admin, json: { role: 'CUSTOM', allowedPages: ['SETTINGS'] } });
});

test('scan cooldown blocks a repeat scan, then allows it once the delay passes', async () => {
  await prisma.person.create({ data: { firstName: 'Cool', lastName: 'Down', personId: 'guest-1', codeValue: 'guest-1', personType: 'GUEST' } });
  const scanner = await login('scanner');
  const scan = () => request('/api/scan', { method: 'POST', cookie: scanner, json: { personId: 'guest-1', manualMealOverride: 'LUNCH' } });

  assert.equal((await scan()).status, 200);
  const blocked = await scan();
  assert.equal(blocked.status, 400);
  assert.equal((await blocked.json()).reason, 'COOLDOWN_ACTIVE');
  // Blocked attempts restart the cooldown, so wait out the full delay after the last attempt.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal((await scan()).status, 200);
});

test('backup download and restore round-trip through the API', async () => {
  const admin = await login('admin');
  await prisma.person.create({ data: { firstName: 'Before', lastName: 'Backup', personId: 'keep-me', codeValue: 'keep-me' } });

  const download = await request('/api/system/backups/download', { cookie: admin });
  assert.equal(download.status, 200);
  const backup = Buffer.from(await download.arrayBuffer());
  assert.equal(backup.subarray(0, 15).toString('utf8'), 'SQLite format 3');

  await prisma.person.create({ data: { firstName: 'After', lastName: 'Backup', personId: 'drop-me', codeValue: 'drop-me' } });

  const upload = (bytes: Buffer, name = 'backup.db') => {
    const form = new FormData();
    form.append('backup', new Blob([bytes]), name);
    return request('/api/system/backups/restore', { method: 'POST', cookie: admin, body: form });
  };
  assert.equal((await upload(Buffer.from('not a database'))).status, 400);
  assert.equal((await upload(backup, 'backup.txt')).status, 400);

  const restored = await upload(backup);
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.ok(await prisma.person.findUnique({ where: { personId: 'keep-me' } }));
  assert.equal(await prisma.person.findUnique({ where: { personId: 'drop-me' } }), null);
  assert.ok(readFileSync(process.env.DATABASE_URL!.slice('file:'.length)).length > 0);
});

// Runs last: it exhausts the login rate limit for 127.0.0.1 in this process.
test('login attempts are rate limited per client IP', async () => {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 21; attempt++) {
    lastStatus = (await request('/api/auth/login', { method: 'POST', json: { username: 'admin', password: 'nope' } })).status;
  }
  assert.equal(lastStatus, 429);

  // The test client connects from 127.0.0.1, which the default TRUST_PROXY=loopback treats as a
  // trusted proxy. With proxies untrusted, a spoofed X-Forwarded-For must not reset the limit.
  process.env.TRUST_PROXY = 'false';
  const direct = await startTestApp();
  try {
    const spoofed = await direct.request('/api/auth/login', { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.9' }, json: { username: 'admin', password: PASSWORD } });
    assert.equal(spoofed.status, 429);
  } finally {
    delete process.env.TRUST_PROXY;
    await direct.close();
  }
});
