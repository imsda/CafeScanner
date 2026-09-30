import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Always use an isolated database; never touch the application's configured data.
const directory = mkdtempSync(join(tmpdir(), 'cafescanner-scan-'));
writeFileSync(join(directory, 'test.db'), '');
process.env.DATABASE_URL = `file:${join(directory, 'test.db')}`;
execFileSync(process.execPath, ['../node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: process.env, stdio: 'inherit' });
const { prisma } = await import('../src/db.js');
const { processScan } = await import('../src/services/scanService.js');
const { resolveSqliteDbPath, prismaSchemaDir } = await import('../src/utils/sqlitePath.js');

// Real clock: transaction timestamps come from the database engine, so Date cannot be mocked here.
const today = new Intl.DateTimeFormat('en-US', { timeZone: 'Etc/UTC', weekday: 'short' }).format(new Date()).toUpperCase() as 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT';

test.after(async () => {
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

test('camp meeting: concurrent scans of one ID redeem a single entitlement, case-insensitively', async () => {
  await prisma.setting.upsert({
    where: { id: 1 },
    create: { id: 1, timezone: 'Etc/UTC', mealTrackingMode: 'camp_meeting', allowManualMealOverride: true, scannerCooldownSeconds: 1, campMeetingAutoSelectFirstAvailable: true },
    update: { mealTrackingMode: 'camp_meeting' }
  });
  // Two duplicate tickets for the same (uppercased on import) registration ID.
  for (const row of [1, 2]) {
    await prisma.mealEntitlement.create({
      data: { personId: 'ABC123', personName: `Guest ${row}`, mealType: 'LUNCH', mealDay: today, mealDate: new Date().toISOString().slice(0, 10), sourceSheetRow: row }
    });
  }

  const results = await Promise.all([
    processScan(' abc123 ', { manualMealOverride: 'LUNCH' }),
    processScan('ABC123', { manualMealOverride: 'LUNCH' }),
    processScan('Abc123', { manualMealOverride: 'LUNCH' })
  ]);

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(results.filter((result) => !result.ok).map((result) => (result as { reason?: string }).reason), ['COOLDOWN_ACTIVE', 'COOLDOWN_ACTIVE']);
  assert.equal(await prisma.mealEntitlement.count({ where: { personId: 'ABC123', redeemed: true } }), 1);
  assert.equal(await prisma.scanTransaction.count({ where: { scannedValue: 'ABC123', result: 'SUCCESS' } }), 1);
});

test('countdown: concurrent scans never drive a balance below zero', async () => {
  await prisma.setting.update({ where: { id: 1 }, data: { mealTrackingMode: 'countdown' } });
  await prisma.person.create({ data: { firstName: 'Count', lastName: 'Down', personId: 'cd-1', codeValue: 'cd-1', lunchRemaining: 1 } });

  const results = await Promise.all(Array.from({ length: 4 }, () => processScan('cd-1', { manualMealOverride: 'LUNCH' })));

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal((await prisma.person.findUniqueOrThrow({ where: { personId: 'cd-1' } })).lunchRemaining, 0);
});

test('SQLite paths resolve relative to the Prisma schema directory, like Prisma does', () => {
  assert.equal(resolveSqliteDbPath('file:./prisma/dev.db'), join(prismaSchemaDir, 'prisma', 'dev.db'));
  assert.equal(resolveSqliteDbPath('file:./dev.db?connection_limit=1'), join(prismaSchemaDir, 'dev.db'));
  assert.equal(resolveSqliteDbPath('file:/var/lib/cafescanner/app.db'), '/var/lib/cafescanner/app.db');
  assert.throws(() => resolveSqliteDbPath('postgresql://localhost/db'));
});
