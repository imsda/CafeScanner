import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';
import type session from 'express-session';
import { SqliteSessionStore } from '../src/utils/sqliteSessionStore.js';

const directory = mkdtempSync(join(tmpdir(), 'cafescanner-sessions-'));
test.after(() => rmSync(directory, { recursive: true, force: true }));

const cookie = (maxAge: number) => ({ originalMaxAge: maxAge, maxAge, httpOnly: true, path: '/' }) as unknown as session.Cookie;
const get = (store: SqliteSessionStore, sid: string) =>
  new Promise<session.SessionData | null | undefined>((resolve, reject) => store.get(sid, (error, value) => (error ? reject(error) : resolve(value))));
const set = (store: SqliteSessionStore, sid: string, data: session.SessionData) =>
  new Promise<void>((resolve, reject) => store.set(sid, data, (error) => (error ? reject(error) : resolve())));
const destroy = (store: SqliteSessionStore, sid: string) =>
  new Promise<void>((resolve, reject) => store.destroy(sid, (error) => (error ? reject(error) : resolve())));

test('sessions are stored, read back, expired and destroyed', async () => {
  const store = new SqliteSessionStore({ dir: join(directory, 'fresh') });
  await set(store, 'live', { cookie: cookie(60_000), adminUserId: 7, role: 'ADMIN' });
  await set(store, 'stale', { cookie: cookie(-1000), adminUserId: 8 });
  assert.equal((await get(store, 'live'))?.adminUserId, 7);
  assert.equal(await get(store, 'stale'), null, 'an expired session is not returned');
  assert.equal(await get(store, 'missing'), null);
  await destroy(store, 'live');
  assert.equal(await get(store, 'live'), null);
  await store.close();
});

test('sessions survive a restart and sessions written by the previous store are still valid', async () => {
  const dir = join(directory, 'upgrade');
  const first = new SqliteSessionStore({ dir });
  await set(first, 'kept', { cookie: cookie(60_000), adminUserId: 3 });
  await first.close();

  // A row exactly as connect-sqlite3 wrote it: (sid, expired in epoch ms, JSON text).
  await new Promise<void>((resolve, reject) => {
    const db = new sqlite3.Database(join(dir, 'sessions.sqlite'));
    db.run('INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)',
      ['legacy', Date.now() + 60_000, JSON.stringify({ cookie: { originalMaxAge: 60_000, httpOnly: true, path: '/' }, adminUserId: 4, role: 'OWNER' })],
      (error) => db.close(() => (error ? reject(error) : resolve())));
  });

  const second = new SqliteSessionStore({ dir });
  assert.equal((await get(second, 'kept'))?.adminUserId, 3);
  assert.equal((await get(second, 'legacy'))?.role, 'OWNER');
  await second.close();
});
