import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { prisma } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();
const backupRouter = Router();
const dbUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const REQUIRED_TABLES = [
  'AdminUser',
  'UserPageAccess',
  'Person',
  'Setting',
  'ScanTransaction',
  'MealEntitlement',
  'ImportHistory',
  '_prisma_migrations'
];

function backupTimestamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day}-${hh}-${mm}`;
}

function resolveSqliteDbPath() {
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl.startsWith('file:')) throw new Error('DATABASE_URL must use sqlite file: path');
  const rawPath = dbUrl.slice('file:'.length).split('?')[0];
  return path.resolve(process.cwd(), rawPath);
}

function resolveBackupsDirectory() {
  return path.resolve(process.cwd(), process.env.BACKUP_DIR || 'backend/backups');
}

async function validateCafeScannerDbFile(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = new Set(rows.map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((name) => !names.has(name));
    if (missing.length > 0) throw new Error(`Backup file missing required tables: ${missing.join(', ')}`);
  } finally {
    db.close();
  }
}

// Safeguard: reset operations in this module must never touch admin/auth tables
// (adminUser, userPageAccess) so user accounts, roles, password hashes, and page access survive data clears.
async function clearOperationalMealData() {
  await prisma.$transaction(async (tx) => {
    await tx.scanTransaction.deleteMany({});
    await tx.importHistory.deleteMany({});
    await tx.mealEntitlement.deleteMany({});
    await tx.person.deleteMany({});
  });
}

router.post('/clear-database', async (req, res) => {
  const actedBy = req.session.adminUserId;

  await clearOperationalMealData();

  console.log(`[ADMIN_ACTION] clear-database (legacy route) executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);

  res.json({ ok: true, message: 'Meal tracking operational data cleared. Users, credentials, roles, account status, and page permissions were preserved.' });
});

router.post('/clear-meal-data', async (req, res) => {
  const actedBy = req.session.adminUserId;

  await prisma.$transaction(async (tx) => {
    await tx.scanTransaction.deleteMany({});
    await tx.mealEntitlement.deleteMany({});
  });

  console.log(`[ADMIN_ACTION] clear-meal-data executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);

  res.json({ ok: true, message: 'Meal data cleared (transactions + meal entitlements). Users and permissions were preserved.' });
});

router.post('/clear-people-import-data', async (req, res) => {
  const actedBy = req.session.adminUserId;

  await prisma.$transaction(async (tx) => {
    await tx.importHistory.deleteMany({});
    await tx.mealEntitlement.deleteMany({});
    await tx.person.deleteMany({});
    await tx.scanTransaction.deleteMany({});
  });

  console.log(`[ADMIN_ACTION] clear-people-import-data executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);

  res.json({ ok: true, message: 'People/import data cleared (people + imports + dependent meal data). Users and permissions were preserved.' });
});

router.post('/reset-meal-tracking-data', async (req, res) => {
  const actedBy = req.session.adminUserId;

  await clearOperationalMealData();

  console.log(`[ADMIN_ACTION] reset-meal-tracking-data executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);

  res.json({ ok: true, message: 'Meal tracking data reset. Users, credentials, roles, account status, and page permissions were preserved.' });
});

backupRouter.get('/download', async (_req, res) => {
  const dbPath = resolveSqliteDbPath();
  const backupsDir = resolveBackupsDirectory();
  await fs.mkdir(backupsDir, { recursive: true });
  const filename = `cafescanner-backup-${backupTimestamp()}.db`;
  const backupPath = path.join(backupsDir, filename);

  await fs.copyFile(dbPath, backupPath);
  res.download(backupPath, filename);
});

backupRouter.post('/restore', dbUpload.single('backup'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Backup file is required.' });
  if (!file.originalname.toLowerCase().endsWith('.db')) return res.status(400).json({ error: 'Only .db backup files are accepted.' });

  const dbPath = resolveSqliteDbPath();
  const backupsDir = resolveBackupsDirectory();
  await fs.mkdir(backupsDir, { recursive: true });

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const uploadPath = path.join(backupsDir, `restore-upload-${token}.db`);
  const preRestorePath = path.join(backupsDir, `cafescanner-pre-restore-${backupTimestamp()}.db`);
  const tempRestorePath = `${dbPath}.restore-${token}.tmp`;

  try {
    await fs.writeFile(uploadPath, file.buffer, { flag: 'wx' });
    await validateCafeScannerDbFile(uploadPath);
    await fs.copyFile(dbPath, preRestorePath);
    await fs.copyFile(uploadPath, tempRestorePath);
    await fs.rename(tempRestorePath, dbPath);
    console.log(`[ADMIN_ACTION] restore-backup executed by userId=${req.session.adminUserId ?? 'unknown'} at ${new Date().toISOString()}`);
    return res.json({ ok: true, message: 'Backup restored successfully. The app may need to be reloaded.', preRestoreBackup: path.basename(preRestorePath) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup restore failed.';
    return res.status(400).json({ error: message });
  } finally {
    await fs.rm(uploadPath, { force: true }).catch(() => undefined);
    await fs.rm(tempRestorePath, { force: true }).catch(() => undefined);
  }
});

router.use('/backups', requireAdmin, backupRouter);

export default router;
