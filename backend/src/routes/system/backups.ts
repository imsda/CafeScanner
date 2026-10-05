import { asyncRouter } from '../../utils/asyncRouter.js';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import sqlite3 from 'sqlite3';
import { configureSqlitePragmas, prisma } from '../../db.js';
import { resolveBackupsDirectory, resolveSqliteDbPath, SQLITE_SIDECAR_SUFFIXES } from '../../utils/sqlitePath.js';
import { acquireOperationLock, pauseScheduler, releaseOperationLock, resumeScheduler, waitForOperationsToFinish } from '../../services/operationLockService.js';

const backupRouter = asyncRouter();
const dbUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

function backupTimestamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day}-${hh}-${mm}`;
}

async function validateCafeScannerDbFile(dbPath: string) {
  const stats = await fs.stat(dbPath);
  if (!stats.isFile() || stats.size === 0) throw new Error('Backup file is empty or invalid.');

  const handle = await fs.open(dbPath, 'r');
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const signature = header.subarray(0, bytesRead).toString('utf8');
    if (!signature.startsWith('SQLite format 3')) throw new Error('Backup file is not a valid SQLite database.');
  } finally {
    await handle.close();
  }

  const tables = await listSqliteTables(dbPath);
  const missing = REQUIRED_BACKUP_TABLES.filter((table) => !tables.includes(table));
  if (missing.length > 0) {
    throw new Error(`Backup file is not a CafeScanner database (missing tables: ${missing.join(', ')}).`);
  }
}

const REQUIRED_BACKUP_TABLES = ['AdminUser', 'Setting', 'Person', 'ScanTransaction', '_prisma_migrations'];

function listSqliteTables(dbPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openError) => {
      if (openError) return reject(new Error('Backup file could not be opened as a SQLite database.'));
      db.all("SELECT name FROM sqlite_master WHERE type = 'table'", (queryError, rows: Array<{ name: string }>) => {
        db.close();
        if (queryError) return reject(new Error('Backup file could not be read as a SQLite database.'));
        resolve(rows.map((row) => row.name));
      });
    });
  });
}

function sqliteStringLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

// VACUUM INTO writes a consistent snapshot that includes pages still in the WAL,
// unlike a plain file copy of a live WAL-mode database.
async function snapshotDatabase(targetPath: string) {
  await prisma.$executeRawUnsafe(`VACUUM INTO ${sqliteStringLiteral(targetPath)}`);
}

async function removeSqliteSidecars(dbPath: string) {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    await fs.rm(`${dbPath}${suffix}`, { force: true });
  }
}

backupRouter.get('/download', async (_req, res) => {
  const backupsDir = resolveBackupsDirectory();
  await fs.mkdir(backupsDir, { recursive: true });
  const filename = `cafescanner-backup-${backupTimestamp()}.db`;
  const backupPath = path.join(backupsDir, filename);

  await snapshotDatabase(backupPath);
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
  const preRestorePath = path.join(backupsDir, `cafescanner-pre-restore-${backupTimestamp()}-${token}.db`);
  const tempRestorePath = `${dbPath}.restore-${token}.tmp`;

  try {
    await fs.writeFile(uploadPath, file.buffer, { flag: 'wx' });
    await validateCafeScannerDbFile(uploadPath);
  } catch (error) {
    await fs.rm(uploadPath, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : 'Backup file is invalid.';
    return res.status(400).json({ error: message });
  }

  if (!acquireOperationLock('reset')) {
    await fs.rm(uploadPath, { force: true }).catch(() => undefined);
    return res.status(409).json({ error: 'Another reset or restore is already in progress.' });
  }

  try {
    pauseScheduler();
    await waitForOperationsToFinish(['import', 'writeback'], '[RESTORE] wait');
    await snapshotDatabase(preRestorePath);
    await fs.copyFile(uploadPath, tempRestorePath);

    // Close Prisma's connections before swapping the file, and drop the old WAL/SHM
    // so SQLite cannot replay the previous database's pages onto the restored one.
    await prisma.$disconnect();
    await fs.rename(tempRestorePath, dbPath);
    await removeSqliteSidecars(dbPath);
    // Drop any connection opened during the swap so every query sees the restored file.
    await prisma.$disconnect();
    await configureSqlitePragmas();

    console.log(`[ADMIN_ACTION] restore-backup executed by userId=${req.session.adminUserId ?? 'unknown'} at ${new Date().toISOString()}`);
    return res.json({ ok: true, message: 'Backup restored successfully. Reload the app. If the backup came from an older version, run npm run db:migrate and restart the service.', preRestoreBackup: path.basename(preRestorePath) });
  } catch (error) {
    console.error('[SYSTEM] restore-backup failed', error);
    const message = error instanceof Error ? error.message : 'Backup restore failed.';
    return res.status(500).json({ error: message });
  } finally {
    releaseOperationLock('reset');
    resumeScheduler();
    await fs.rm(uploadPath, { force: true }).catch(() => undefined);
    await fs.rm(tempRestorePath, { force: true }).catch(() => undefined);
  }
});

export default backupRouter;
