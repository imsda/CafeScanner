import path from 'node:path';
import { fileURLToPath } from 'node:url';

// backend/ — this file lives at backend/src/utils (or backend/dist/utils once built).
export const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Prisma resolves relative SQLite `file:` URLs against the directory containing
// schema.prisma, so every tool that touches the DB file must do the same.
export const prismaSchemaDir = path.join(backendDir, 'prisma');

export function resolveSqliteDbPath(databaseUrl = process.env.DATABASE_URL): string {
  if (!databaseUrl || !databaseUrl.startsWith('file:')) {
    throw new Error('DATABASE_URL must be a SQLite file: URL');
  }
  const rawPath = databaseUrl.slice('file:'.length).split('?')[0];
  return path.resolve(prismaSchemaDir, rawPath);
}

// BACKUP_DIR is resolved relative to the repository root (default backend/backups).
export function resolveBackupsDirectory(backupDir = process.env.BACKUP_DIR): string {
  return path.resolve(backendDir, '..', backupDir || 'backend/backups');
}

export const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;
