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


test('scanner preferences are private, validated, and enforced', async (t) => {
  t.after(async () => { await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true }); });
  const express = (await import('express')).default;
  const session = (await import('express-session')).default;
  const bcrypt = (await import('bcryptjs')).default;
  const auth = (await import('../src/routes/auth.js')).default;
  const scanRouter = (await import('../src/routes/scan.js')).default;
  const { requireAuth, requirePageAccess } = await import('../src/middleware/auth.js');
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'isolated-test-session', resave: false, saveUninitialized: false }));
  app.use('/auth', auth);
  app.use('/scan', requireAuth, requirePageAccess('SCAN'), scanRouter);
  app.get('/admin-settings', requireAuth, requirePageAccess('SETTINGS'), (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  await prisma.setting.create({ data: { id: 1, scannerCooldownSeconds: 1, mealTrackingMode: 'tally', allowManualMealOverride: true } });
  const passwordHash = await bcrypt.hash('test-password', 4);
  const a = await prisma.adminUser.create({ data: { username: 'scanner-a', passwordHash, role: 'SCANNER' } });
  const b = await prisma.adminUser.create({ data: { username: 'scanner-b', passwordHash, role: 'SCANNER' } });
  async function login(username: string) {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'test-password' }) });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  const cookieA = await login(a.username); const cookieB = await login(b.username);
  const get = (cookie: string) => fetch(`${base}/scan/settings`, { headers: { Cookie: cookie } });
  const put = (cookie: string, body: unknown) => fetch(`${base}/scan/settings`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/scan/settings`)).status, 401);
  assert.equal((await fetch(`${base}/admin-settings`, { headers: { Cookie: cookieA } })).status, 403);
  assert.equal((await get(cookieA)).status, 200);
  assert.equal((await put(cookieA, { scannerCooldownSeconds: 0.5 })).status, 200);
  assert.equal((await (await get(cookieA)).json()).scannerCooldownSeconds, 0.5);
  assert.equal((await (await get(cookieB)).json()).scannerCooldownSeconds, 1);
  assert.equal((await put(cookieB, { scannerCooldownSeconds: 3 })).status, 200);
  for (const value of [-1, 0, 11, '2']) assert.equal((await put(cookieA, { scannerCooldownSeconds: value })).status, 400);
  assert.equal((await put(cookieA, { scannerCooldownSeconds: 1, adminUserId: b.id })).status, 400);
  assert.equal((await prisma.setting.findUniqueOrThrow({ where: { id: 1 } })).scannerCooldownSeconds, 1);
  assert.equal((await (await get(await login(a.username))).json()).scannerCooldownSeconds, 0.5);

  const now = new Date('2030-09-10T16:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const person = await prisma.person.create({ data: { firstName: 'Guest', lastName: 'Test', personId: 'guest', codeValue: 'guest', personType: 'GUEST' } });
  await prisma.scanTransaction.create({ data: { scannedValue: 'guest', personId: person.id, mealType: 'LUNCH', result: 'SUCCESS', timestamp: new Date(now.getTime() - 1000) } });
  assert.equal((await processScan('guest', { adminUserId: b.id, manualMealOverride: 'LUNCH' })).ok, false);
  assert.equal((await processScan('guest', { adminUserId: a.id, manualMealOverride: 'LUNCH' })).ok, true);
  assert.equal((await put(cookieA, { scannerCooldownSeconds: null })).status, 200);
  assert.equal((await (await get(cookieA)).json()).scannerCooldownSeconds, 1);
});
