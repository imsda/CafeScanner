import type { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { requireAdmin, requireOwner } from '../../middleware/auth.js';

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
}
