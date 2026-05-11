import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { prisma } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { acquireOperationLock, pauseScheduler, releaseOperationLock, resumeScheduler, waitForOperationsToFinish } from '../services/operationLockService.js';

const router = Router();
let activeUpdatePromise: Promise<{ ok: boolean; output: string; startedAt: string; finishedAt: string; error?: string }> | null = null;

const backendRouteDir = path.dirname(fileURLToPath(import.meta.url));

async function resolveRepoRoot(): Promise<string> {
  let current = backendRouteDir;
  const filesystemRoot = path.parse(current).root;

  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    const updateScriptPath = path.join(current, 'scripts', 'update-service.sh');

    try {
      const [packageStats, scriptStats] = await Promise.all([
        fs.stat(packageJsonPath),
        fs.stat(updateScriptPath)
      ]);
      if (packageStats.isFile() && scriptStats.isFile()) return current;
    } catch {
      // Continue walking upward until we either find the repo root or hit filesystem root.
    }

    if (current === filesystemRoot) break;
    current = path.dirname(current);
  }

  throw new Error(`Unable to locate repository root from ${backendRouteDir}`);
}


type UpdateScriptDiagnostics = {
  cwd: string;
  repoRoot: string | null;
  resolvedScriptPath: string;
  exists: boolean;
  executable: boolean;
  statMode: string | null;
};

async function getUpdateScriptDiagnostics(): Promise<UpdateScriptDiagnostics> {
  const cwd = process.cwd();
  let repoRoot: string | null = null;

  try {
    repoRoot = await resolveRepoRoot();
  } catch {
    repoRoot = null;
  }

  const resolvedScriptPath = repoRoot
    ? path.join(repoRoot, 'scripts', 'update-service.sh')
    : path.resolve(cwd, 'scripts/update-service.sh');
  let exists = false;
  let executable = false;
  let statMode: string | null = null;

  try {
    const stats = await fs.stat(resolvedScriptPath);
    exists = stats.isFile();
    statMode = `0o${(stats.mode & 0o777).toString(8).padStart(3, '0')}`;
  } catch {
    exists = false;
  }

  if (exists) {
    try {
      await fs.access(resolvedScriptPath, fsConstants.X_OK);
      executable = true;
    } catch {
      executable = false;
    }
  }

  return { cwd, repoRoot, resolvedScriptPath, exists, executable, statMode };
}

function requireOwner(req: any, res: any, next: any) {
  if (req.session?.role !== 'OWNER') return res.status(403).json({ error: 'Owner access required' });
  next();
}

async function readGitRef(command: string[]) {
  const repoRoot = await resolveRepoRoot();
  return new Promise<string | null>((resolve) => {
    const proc = spawn(command[0], command.slice(1), { cwd: repoRoot });
    let output = '';
    proc.stdout.on('data', (chunk) => { output += String(chunk); });
    proc.on('close', (code) => resolve(code === 0 ? output.trim() || null : null));
    proc.on('error', () => resolve(null));
  });
}
const backupRouter = Router();
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

async function resolveSqliteDbPath() {
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl.startsWith('file:')) throw new Error('DATABASE_URL must use sqlite file: path');
  const rawPath = dbUrl.slice('file:'.length).split('?')[0];
  const repoRoot = await resolveRepoRoot();
  return path.resolve(repoRoot, rawPath);
}

async function resolveBackupsDirectory() {
  const repoRoot = await resolveRepoRoot();
  return path.resolve(repoRoot, process.env.BACKUP_DIR || 'backend/backups');
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
}

// Safeguard: reset operations in this module must never touch admin/auth tables
// (adminUser, userPageAccess) so user accounts, roles, password hashes, and page access survive data clears.
async function clearOperationalMealData(clearPeople: boolean) {
  const transactions = await prisma.scanTransaction.deleteMany({});
  const importRows = await prisma.importHistory.deleteMany({});
  const mealEntitlements = await prisma.mealEntitlement.deleteMany({});
  const people = clearPeople ? await prisma.person.deleteMany({}) : { count: 0 };

  return {
    transactions: transactions.count,
    importRows: importRows.count,
    mealEntitlements: mealEntitlements.count,
    people: people.count
  };
}

router.post('/clear-database', async (req, res) => {
  const actedBy = req.session.adminUserId;

  try {
    pauseScheduler();
    console.log('[RESET] waiting for import to finish');
    await waitForOperationsToFinish(['import', 'writeback'], '[RESET] wait');
    const deleted = await clearOperationalMealData(true);
    console.log(`[ADMIN_ACTION] clear-database (legacy route) executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);
    return res.json({ ok: true, action: 'clear-database', deleted, message: 'Meal tracking operational data cleared. Users, credentials, roles, account status, and page permissions were preserved.' });
  } catch (error) {
    console.error('[SYSTEM] clear-database failed', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Failed to clear database data.' });
  }
});

router.post('/clear-meal-data', async (req, res) => {
  const actedBy = req.session.adminUserId;

  try {
    const transactions = await prisma.scanTransaction.deleteMany({});
    const mealEntitlements = await prisma.mealEntitlement.deleteMany({});
    const deleted = { transactions: transactions.count, mealEntitlements: mealEntitlements.count, people: 0, importRows: 0 };
    console.log(`[ADMIN_ACTION] clear-meal-data executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);
    return res.json({ ok: true, action: 'clear-meal-data', deleted, message: 'Meal data cleared (transactions + meal entitlements). Users and permissions were preserved.' });
  } catch (error) {
    console.error('[SYSTEM] clear-meal-data failed', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Failed to clear meal data.' });
  }
});

router.post('/clear-people-import-data', async (req, res) => {
  const actedBy = req.session.adminUserId;

  try {
    pauseScheduler();
    console.log('[RESET] waiting for import to finish');
    await waitForOperationsToFinish(['import', 'writeback'], '[RESET] wait');
    const deleted = await clearOperationalMealData(true);
    console.log(`[ADMIN_ACTION] clear-people-import-data executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);
    return res.json({ ok: true, action: 'clear-people-import-data', deleted, message: 'People/import data cleared (people + imports + dependent meal data). Users and permissions were preserved.' });
  } catch (error) {
    console.error('[SYSTEM] clear-people-import-data failed', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Failed to clear people/import data.' });
  }
});

router.post('/reset-meal-tracking-data', async (req, res) => {
  const actedBy = req.session.adminUserId;

  if (!acquireOperationLock('reset')) {
    return res.status(409).json({ ok: false, error: 'Reset already in progress.' });
  }

  try {
    pauseScheduler();
    console.log('[RESET] waiting for import to finish');
    await waitForOperationsToFinish(['import', 'writeback'], '[RESET] wait');
    const deleted = await clearOperationalMealData(true);
    console.log(`[ADMIN_ACTION] reset-meal-tracking-data executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);
    return res.json({ ok: true, action: 'reset-meal-tracking-data', deleted, message: 'Meal tracking data reset. Users, credentials, roles, account status, and page permissions were preserved.' });
  } catch (error) {
    console.error('[SYSTEM] reset-meal-tracking-data failed', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Failed to reset meal tracking data.' });
  } finally {
    releaseOperationLock('reset');
    resumeScheduler();
  }
});

backupRouter.get('/download', async (_req, res) => {
  const dbPath = await resolveSqliteDbPath();
  const backupsDir = await resolveBackupsDirectory();
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

  const dbPath = await resolveSqliteDbPath();
  const backupsDir = await resolveBackupsDirectory();
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


router.get('/update-status', requireAdmin, async (_req, res) => {
  const diagnostics = await getUpdateScriptDiagnostics();
  console.log('[SYSTEM] update-status diagnostics', { cwd: diagnostics.cwd, repoRoot: diagnostics.repoRoot, resolvedScriptPath: diagnostics.resolvedScriptPath });
  const branch = await readGitRef(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
  const localCommit = await readGitRef(['git', 'rev-parse', 'HEAD']);
  await readGitRef(['git', 'fetch', '--quiet', 'origin']);
  const remoteCommit = branch ? await readGitRef(['git', 'rev-parse', `origin/${branch}`]) : null;
  const updatesAvailable = Boolean(localCommit && remoteCommit && localCommit !== remoteCommit);

  res.json({
    branch,
    localCommit,
    remoteCommit,
    updatesAvailable,
    updateInProgress: Boolean(activeUpdatePromise),
    updateScriptDiagnostics: diagnostics
  });
});

router.post('/update', requireOwner, async (req, res) => {
  const actedBy = req.session.adminUserId;
  if (activeUpdatePromise) {
    return res.status(409).json({ ok: false, error: 'An update is already running.' });
  }

  const diagnostics = await getUpdateScriptDiagnostics();
  if (!diagnostics.exists || !diagnostics.executable) {
    const reason = !diagnostics.exists
      ? 'Update script is missing.'
      : 'Update script is not executable by the backend process.';
    return res.status(500).json({
      ok: false,
      error: reason,
      diagnostics
    });
  }

  const startedAt = new Date().toISOString();
  console.log(`[ADMIN_ACTION] update install requested by userId=${actedBy ?? 'unknown'} at ${startedAt}`);

  activeUpdatePromise = new Promise((resolve) => {
    const child = spawn(diagnostics.resolvedScriptPath, [], { cwd: diagnostics.repoRoot ?? diagnostics.cwd, shell: false });
    let output = '';

    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', (error) => {
      const finishedAt = new Date().toISOString();
      resolve({ ok: false, output, startedAt, finishedAt, error: error.message });
    });
    child.on('close', (code) => {
      const finishedAt = new Date().toISOString();
      resolve({ ok: code === 0, output, startedAt, finishedAt, error: code === 0 ? undefined : `Update script exited with code ${code}` });
    });
  });

  const result = await activeUpdatePromise;
  activeUpdatePromise = null;

  if (!result.ok) {
    console.error(`[SYSTEM] update failed for userId=${actedBy ?? 'unknown'} at ${result.finishedAt}`, result.error);
    return res.status(500).json(result);
  }

  console.log(`[ADMIN_ACTION] update install completed by userId=${actedBy ?? 'unknown'} at ${result.finishedAt}`);
  return res.json(result);
});

export default router;
