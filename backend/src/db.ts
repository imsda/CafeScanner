import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

function isPrismaErrorWithCode(error: unknown, code: string): error is { code: string } {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === code);
}

export function isSqliteTimeoutError(error: unknown) {
  return isPrismaErrorWithCode(error, 'P1008');
}

export async function withSqliteTimeoutRetry<T>(label: string, fn: () => Promise<T>, maxRetries = 1): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isSqliteTimeoutError(error) || attempt >= maxRetries) {
        throw error;
      }

      const retryInMs = 150 * (attempt + 1);
      console.warn(`[SQLITE_RETRY] ${label} timed out (P1008). Retrying in ${retryInMs}ms (attempt ${attempt + 1}/${maxRetries}).`);
      await new Promise((resolve) => setTimeout(resolve, retryInMs));
    }
  }
}

export async function configureSqlitePragmas() {
  try {
    await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL;');
    await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000;');
    console.log('[DB] SQLite PRAGMAs set: journal_mode=WAL, busy_timeout=5000ms.');
  } catch (error) {
    console.warn('[DB] Unable to set SQLite PRAGMAs at startup.', error);
  }
}
