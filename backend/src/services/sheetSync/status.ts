import { prisma } from '../../db.js';
import { SheetSyncBusyError } from './client.js';

// Sync health is persisted on the Setting row so it survives restarts and can be
// shown outside the Settings page (see GET /api/meta and the Dashboard banner).
const MAX_ERROR_LENGTH = 500;

export type PersistedSheetSyncStatus = {
  enabled: boolean;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
};

export async function getPersistedSheetSyncStatus(): Promise<PersistedSheetSyncStatus> {
  const row = await prisma.setting.findUnique({
    where: { id: 1 },
    select: { googleSheetsEnabled: true, googleLastSyncSuccessAt: true, googleLastSyncError: true, googleLastSyncErrorAt: true }
  });
  return {
    enabled: Boolean(row?.googleSheetsEnabled),
    lastSuccessAt: row?.googleLastSyncSuccessAt ?? null,
    lastError: row?.googleLastSyncError ?? null,
    lastErrorAt: row?.googleLastSyncErrorAt ?? null
  };
}

async function safely(label: string, action: () => Promise<unknown>) {
  // Status bookkeeping must never turn a finished sync into a failure.
  try { await action(); }
  catch (error) { console.error(`[SHEET_SYNC] Could not persist sync status (${label}):`, error instanceof Error ? error.message : String(error)); }
}

/** A complete scheduled cycle finished without errors. */
export function recordSheetSyncSuccess(at = new Date()) {
  return safely('success', () => prisma.setting.updateMany({
    where: { id: 1 },
    data: { googleLastSyncSuccessAt: at, googleLastSyncError: null, googleLastSyncErrorAt: null }
  }));
}

/** Keeps the time of the first failure in a streak so the UI can say "failing since". */
export function recordSheetSyncError(message: string, at = new Date()) {
  return safely('error', async () => {
    const current = await prisma.setting.findUnique({ where: { id: 1 }, select: { googleLastSyncError: true, googleLastSyncErrorAt: true } });
    if (!current) return;
    const streakStart = current.googleLastSyncError && current.googleLastSyncErrorAt ? current.googleLastSyncErrorAt : at;
    await prisma.setting.update({
      where: { id: 1 },
      data: { googleLastSyncError: message.slice(0, MAX_ERROR_LENGTH), googleLastSyncErrorAt: streakStart }
    });
  });
}

/** A manual sync worked, so the sheet is reachable again; the last full-cycle success time is left alone. */
export function clearSheetSyncError() {
  return safely('clear', () => prisma.setting.updateMany({
    where: { id: 1, googleLastSyncError: { not: null } },
    data: { googleLastSyncError: null, googleLastSyncErrorAt: null }
  }));
}

const NOT_A_SYNC_FAILURE = /sync is disabled in settings|reset in progress/i;

/**
 * Wraps a sync started by a person (Settings/Import buttons) so its outcome is
 * persisted like a scheduled cycle. Lock contention and "sync disabled" are not
 * sync failures and are not recorded.
 */
export async function trackManualSheetSync<T>(action: () => Promise<T>): Promise<T> {
  try {
    const result = await action();
    await clearSheetSyncError();
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof SheetSyncBusyError) && !NOT_A_SYNC_FAILURE.test(message)) await recordSheetSyncError(message);
    throw error;
  }
}
