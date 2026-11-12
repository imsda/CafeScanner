import type { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { requireAdmin, requireOwner } from '../../middleware/auth.js';
import { backendDir } from '../../utils/sqlitePath.js';

let activeUpdate: { startedAt: string; pid: number | null } | null = null;

const backendRouteDir = path.dirname(fileURLToPath(import.meta.url));
// Output of the most recent in-app update (backend/data is runtime data, not tracked by git).
const UPDATE_LOG_PATH = path.join(backendDir, 'data', 'update-last.log');
const UPDATE_LOG_TAIL_LINES = 200;

// In-app updates end with `sudo -n systemctl restart cafescanner`; check up front that sudo allows it.
function canRestartServiceWithoutPassword(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('sudo', ['-n', '-l', 'systemctl', 'restart', 'cafescanner'], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

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

export function registerUpdateRoutes(router: Router) {
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
      updateInProgress: Boolean(activeUpdate),
      updateScriptDiagnostics: diagnostics
    });
  });

  // Starts scripts/update-service.sh in in-app mode and returns immediately. The script ends by
  // restarting this service, so the request cannot wait for it; progress is read from the log.
  router.post('/update', requireOwner, async (req, res) => {
    const actedBy = req.session.adminUserId;
    if (activeUpdate) {
      return res.status(409).json({ ok: false, error: 'An update is already running.' });
    }

    const diagnostics = await getUpdateScriptDiagnostics();
    if (!diagnostics.exists || !diagnostics.executable) {
      const reason = !diagnostics.exists
        ? 'Update script is missing.'
        : 'Update script is not executable by the backend process.';
      return res.status(500).json({ ok: false, error: reason, diagnostics });
    }

    if (!(await canRestartServiceWithoutPassword())) {
      return res.status(409).json({
        ok: false,
        error: `In-app updates are not set up on this server: the service user needs passwordless sudo for "systemctl restart cafescanner". Run ./scripts/update-service.sh from a terminal instead, or add the sudoers rule described in the README (Update Workflow).`
      });
    }

    const startedAt = new Date().toISOString();
    console.log(`[ADMIN_ACTION] update install requested by userId=${actedBy ?? 'unknown'} at ${startedAt}`);

    await fs.mkdir(path.dirname(UPDATE_LOG_PATH), { recursive: true });
    const logHandle = await fs.open(UPDATE_LOG_PATH, 'w');
    try {
      const child = spawn(diagnostics.resolvedScriptPath, [], {
        cwd: diagnostics.repoRoot ?? diagnostics.cwd,
        shell: false,
        detached: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
        env: { ...process.env, CAFESCANNER_IN_APP_UPDATE: '1' }
      });
      activeUpdate = { startedAt, pid: child.pid ?? null };
      child.on('error', (error) => {
        console.error('[SYSTEM] update script failed to start', error);
        activeUpdate = null;
      });
      child.on('close', (code) => {
        console.log(`[SYSTEM] update script exited with code ${code}`);
        activeUpdate = null;
      });
      child.unref();
    } finally {
      await logHandle.close();
    }

    return res.status(202).json({ ok: true, started: true, startedAt });
  });

  router.get('/update-log', requireAdmin, async (_req, res) => {
    let log = '';
    try {
      log = await fs.readFile(UPDATE_LOG_PATH, 'utf8');
    } catch {
      log = '';
    }
    const inProgress = Boolean(activeUpdate);
    // The script prints UPDATE_RESULT=success as its last line; every failure path logs "[UPDATE] ERROR:".
    const result = log.includes('UPDATE_RESULT=success')
      ? 'success'
      : /\[UPDATE\] ERROR:/.test(log)
        ? 'failed'
        : inProgress ? 'running' : log ? 'interrupted' : null;
    const lines = log.split('\n');
    res.json({ inProgress, result, startedAt: activeUpdate?.startedAt ?? null, log: lines.slice(-UPDATE_LOG_TAIL_LINES).join('\n') });
  });
}
