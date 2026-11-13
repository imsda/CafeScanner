import fs from 'node:fs';
import path from 'node:path';
import session from 'express-session';
import sqlite3 from 'sqlite3';

const ONE_DAY_MS = 86_400_000;

type StoreCallback = (error?: unknown) => void;

/**
 * express-session store backed by a small SQLite file (backend/data/sessions.sqlite).
 *
 * Uses the same table layout as the connect-sqlite3 package it replaces
 * (`sessions(sid PRIMARY KEY, expired, sess)`, `expired` in epoch milliseconds), so
 * people stay signed in across the upgrade. Written on the app's own sqlite3 driver
 * so no second, outdated copy of that driver is installed.
 */
export class SqliteSessionStore extends session.Store {
  private readonly db: sqlite3.Database;
  private readonly ready: Promise<void>;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options: { dir: string; file?: string; cleanupIntervalMs?: number }) {
    super();
    fs.mkdirSync(options.dir, { recursive: true });
    this.db = new sqlite3.Database(path.join(options.dir, options.file ?? 'sessions.sqlite'));
    this.ready = new Promise((resolve, reject) => {
      this.db.exec(
        'PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS sessions (sid PRIMARY KEY, expired, sess)',
        (error) => (error ? reject(error) : resolve())
      );
    });
    this.ready.catch((error) => console.error('[SESSION] Unable to open the session store.', error));
    this.cleanupTimer = setInterval(() => this.removeExpired(), options.cleanupIntervalMs ?? 15 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  private removeExpired() {
    this.db.run('DELETE FROM sessions WHERE ? > expired', [Date.now()], (error) => {
      if (error) console.warn('[SESSION] Unable to remove expired sessions.', error);
    });
  }

  private expiryFor(sess: session.SessionData): number {
    const maxAge = sess.cookie?.maxAge;
    return Date.now() + (typeof maxAge === 'number' ? maxAge : ONE_DAY_MS);
  }

  private run(sql: string, params: unknown[], callback?: StoreCallback) {
    this.ready.then(
      () => this.db.run(sql, params, (error) => callback?.(error ?? undefined)),
      (error) => callback?.(error)
    );
  }

  get(sid: string, callback: (error: unknown, session?: session.SessionData | null) => void) {
    this.ready.then(
      () => this.db.get('SELECT sess FROM sessions WHERE sid = ? AND ? <= expired', [sid, Date.now()], (error, row: { sess: string } | undefined) => {
        if (error) return callback(error);
        if (!row) return callback(null, null);
        try {
          callback(null, JSON.parse(row.sess) as session.SessionData);
        } catch (parseError) {
          callback(parseError);
        }
      }),
      (error) => callback(error)
    );
  }

  set(sid: string, sess: session.SessionData, callback?: StoreCallback) {
    this.run('INSERT OR REPLACE INTO sessions (sid, expired, sess) VALUES (?, ?, ?)', [sid, this.expiryFor(sess), JSON.stringify(sess)], callback);
  }

  touch(sid: string, sess: session.SessionData, callback?: () => void) {
    this.run('UPDATE sessions SET expired = ? WHERE sid = ? AND ? <= expired', [this.expiryFor(sess), sid, Date.now()], () => callback?.());
  }

  destroy(sid: string, callback?: StoreCallback) {
    this.run('DELETE FROM sessions WHERE sid = ?', [sid], callback);
  }

  /** Closes the database file (used by tests). */
  close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    return new Promise((resolve) => this.db.close(() => resolve()));
  }
}
