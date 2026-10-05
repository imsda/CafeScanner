import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Creates an isolated, fully migrated SQLite database and points DATABASE_URL and
// BACKUP_DIR at it. Must run before anything imports ../src/db.js.
export function useIsolatedDatabase(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), `cafescanner-${prefix}-`));
  writeFileSync(join(directory, 'test.db'), '');
  mkdirSync(join(directory, 'backups'));
  process.env.DATABASE_URL = `file:${join(directory, 'test.db')}`;
  process.env.BACKUP_DIR = join(directory, 'backups');
  execFileSync(process.execPath, ['../node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: process.env, stdio: 'ignore' });
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export type TestClient = {
  base: string;
  request: (path: string, init?: RequestInit & { cookie?: string; json?: unknown }) => Promise<Response>;
  login: (username: string, password?: string) => Promise<string>;
  close: () => Promise<void>;
};

// Starts the real Express app (all routes and middleware) with an in-memory session store.
export async function startTestApp(): Promise<TestClient> {
  const session = (await import('express-session')).default;
  const { createApp } = await import('../../src/app.js');
  const app = createApp({ sessionStore: new session.MemoryStore(), serveFrontend: false });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const request: TestClient['request'] = (path, init = {}) => {
    const { cookie, json, headers, ...rest } = init;
    return fetch(`${base}${path}`, {
      ...rest,
      headers: {
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(headers as Record<string, string> | undefined)
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body
    });
  };

  const login: TestClient['login'] = async (username, password = 'test-password-123') => {
    const response = await request('/api/auth/login', { method: 'POST', json: { username, password } });
    if (response.status !== 200) throw new Error(`login ${username} failed: ${response.status} ${await response.text()}`);
    return response.headers.get('set-cookie')!.split(';')[0];
  };

  const close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return { base, request, login, close };
}
