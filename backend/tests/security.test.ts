import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useIsolatedDatabase, startTestApp } from './helpers/testApp.js';

// Always use an isolated database; never touch the application's configured data.
const database = useIsolatedDatabase('security');
const { prisma } = await import('../src/db.js');
const bcrypt = (await import('bcryptjs')).default;
const client = await startTestApp();
const { request, login } = client;

const PASSWORD = 'test-password-123';
const NEW_PASSWORD = 'another-password-456';
const passwordHash = await bcrypt.hash(PASSWORD, 4);
await prisma.setting.create({ data: { id: 1, mealTrackingMode: 'tally', timezone: 'Etc/UTC' } });
const admin = await prisma.adminUser.create({ data: { username: 'admin', passwordHash, role: 'ADMIN' } });
const other = await prisma.adminUser.create({ data: { username: 'other', passwordHash, role: 'ADMIN' } });

test.after(async () => {
  await client.close();
  await prisma.$disconnect();
  database.cleanup();
});

test('responses carry baseline security headers', async () => {
  const response = await request('/api/health');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('a password change signs out that user\'s other sessions but keeps the one that made the change', async () => {
  const adminCookie = await login('admin');
  const otherCookieA = await login('other');
  const otherCookieB = await login('other');
  assert.equal((await request('/api/settings', { cookie: otherCookieA })).status, 200);

  // An admin resets another user's password: all of that user's sessions end.
  assert.equal((await request(`/api/users/${other.id}`, { method: 'PATCH', cookie: adminCookie, json: { password: NEW_PASSWORD } })).status, 200);
  assert.equal((await request('/api/settings', { cookie: otherCookieA })).status, 401);
  assert.equal((await request('/api/settings', { cookie: otherCookieB })).status, 401);
  const fresh = await login('other', NEW_PASSWORD);
  assert.equal((await request('/api/settings', { cookie: fresh })).status, 200);

  // Changing your own password keeps the current session and ends the others.
  const adminSecond = await login('admin');
  assert.equal((await request(`/api/users/${admin.id}`, { method: 'PATCH', cookie: adminCookie, json: { password: NEW_PASSWORD } })).status, 200);
  assert.equal((await request('/api/settings', { cookie: adminCookie })).status, 200);
  assert.equal((await request('/api/settings', { cookie: adminSecond })).status, 401);
});

test('backup downloads never collide and old backups are pruned', async () => {
  const cookie = await login('admin', NEW_PASSWORD);
  const backupsDir = process.env.BACKUP_DIR!;
  // 25 old backups already on disk.
  for (let i = 0; i < 25; i++) {
    const file = join(backupsDir, `cafescanner-backup-2020-01-01-00-00-${String(i).padStart(2, '0')}.db`);
    writeFileSync(file, 'old');
    utimesSync(file, new Date(2020, 0, 1, 0, 0, i), new Date(2020, 0, 1, 0, 0, i));
  }
  // Two downloads in quick succession (same second) must both succeed.
  const [first, second] = await Promise.all([
    request('/api/system/backups/download', { cookie }),
    request('/api/system/backups/download', { cookie })
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  await first.arrayBuffer(); await second.arrayBuffer();
  const third = await request('/api/system/backups/download', { cookie });
  assert.equal(third.status, 200);
  assert.equal(Buffer.from(await third.arrayBuffer()).subarray(0, 15).toString('utf8'), 'SQLite format 3');
  const remaining = readdirSync(backupsDir).filter((name) => name.startsWith('cafescanner-backup-'));
  assert.ok(remaining.length <= 20, `expected at most 20 backups, found ${remaining.length}`);
});
