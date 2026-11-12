import { MealTrackingMode } from '@prisma/client';
import { peopleSheetRows } from '../peopleSheetRows.js';
import { getSettings } from '../settingsService.js';
import { prisma } from '../../db.js';
import { isImportInProgress, isResetInProgress, isSchedulerPaused, isWritebackInProgress } from '../operationLockService.js';
import { resolveTimezone } from '../../utils/timezone.js';
import { mapGoogleSheetsError, parseSpreadsheetId, readSheetRows, SheetSyncBusyError } from './client.js';
import type { SheetSyncSettings } from './client.js';
import { isWithinMealWindowPlus10Minutes } from './mealWindow.js';
import { importPeopleFromRows, runCampMeetingSheetImport } from './import.js';
import { flushCampMeetingRedemptionsToSheet, getTallyWriteBackMode, writeBackPeopleRows, writeBackWeeklyTally } from './writeBack.js';
import { syncTransactionLogToSheet } from './transactionLog.js';
import { schedulerStatus } from './state.js';
import { getPersistedSheetSyncStatus, recordSheetSyncError, recordSheetSyncSuccess } from './status.js';

// A cycle that runs longer than this is abandoned by the scheduler (logged and
// reported as an error) so the next cycle can start. Individual Google requests
// already time out on their own; this is the backstop.
const CYCLE_HARD_CEILING_MS = 5 * 60_000;
const LOG_EXPORT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;

// When the write-back stages of a cycle last all succeeded (this process).
let lastWriteBackSuccessAtMs: number | null = null;

/**
 * Write-back normally runs only during meal windows (+10 minutes). Scans made in
 * the last minutes of a meal would otherwise wait for the next meal, so one more
 * write-back is allowed after the window when a successful scan is newer than the
 * last successful write-back.
 */
async function hasScansNewerThanLastWriteBack(): Promise<boolean> {
  const newest = await prisma.scanTransaction.findFirst({ where: { result: 'SUCCESS' }, orderBy: { timestamp: 'desc' }, select: { timestamp: true } });
  if (!newest) return false;
  const lastWriteBack = lastWriteBackSuccessAtMs ?? (await getPersistedSheetSyncStatus()).lastSuccessAt?.getTime() ?? null;
  return lastWriteBack === null || newest.timestamp.getTime() > lastWriteBack;
}

async function getSchedulerPlan(settings: SheetSyncSettings): Promise<{ skipReason: string } | { finalFlush: boolean }> {
  if (!settings.googleSheetsEnabled) return { skipReason: 'sync disabled' };
  if (!parseSpreadsheetId(settings.googleSheetId || '')) return { skipReason: 'missing sheet ID' };
  if (isResetInProgress()) return { skipReason: 'reset in progress' };
  if (isImportInProgress()) return { skipReason: 'import already running' };
  if (isWritebackInProgress()) return { skipReason: 'writeback already running' };
  if (isSchedulerPaused()) return { skipReason: 'scheduler paused' };
  if (isWithinMealWindowPlus10Minutes(new Date(), resolveTimezone(settings.timezone), settings)) return { finalFlush: false };
  if (await hasScansNewerThanLastWriteBack()) return { finalFlush: true };
  return { skipReason: 'outside meal window' };
}

async function runAutoImportForMode(settings: SheetSyncSettings) {
  if (!settings.googleSheetsEnabled || !settings.googleAutoImportEnabled || !parseSpreadsheetId(settings.googleSheetId || '') || isResetInProgress()) {
    return null;
  }
  let text: string;
  if (settings.mealTrackingMode === MealTrackingMode.camp_meeting) {
    const summary = await runCampMeetingSheetImport();
    text = `[SHEET_SYNC] Auto import completed: ${summary.peopleCreated} people created, ${summary.peopleUpdated} updated, ${summary.entitlementsCreated + summary.entitlementsUpdated} entitlements created/updated, ${summary.skippedRows} skipped`;
  } else {
    const { rows } = await readSheetRows();
    const dataRows = peopleSheetRows(rows as string[][]);
    // Scheduled imports never overwrite balances or counts of people who already exist.
    const result = await importPeopleFromRows(dataRows, {
      includeBalances: settings.mealTrackingMode !== MealTrackingMode.tally, overwriteExistingBalances: false, overwriteExistingCounts: false
    });
    text = `[SHEET_SYNC] Auto import completed: ${result.peopleCreated} people created, ${result.peopleUpdated} updated, 0 entitlements created/updated, ${result.rowsSkipped} skipped`;
  }
  console.log(text);
  const now = new Date();
  await prisma.setting.update({ where: { id: 1 }, data: { googleLastAutoImportAt: now, googleLastAutoImportSummary: text } });
  schedulerStatus.lastAutomaticImportTime = now.toISOString();
  schedulerStatus.lastAutomaticImportSummary = text;
  return text;
}

let schedulerCycleRunning = false;

export function startCampMeetingSheetSyncScheduler() {
  if (schedulerStatus.schedulerEnabled) return;
  schedulerStatus.schedulerEnabled = true;
  console.log('[SHEET_SYNC] Scheduler started');
  const run = async () => {
    let delay = DEFAULT_INTERVAL_MS;
    try {
      await runGoogleSheetsSyncSchedulerCheckNow();
    } catch (error) {
      console.error('[SHEET_SYNC]', error instanceof Error ? error.message : String(error));
    } finally {
      // Always re-arm, whatever happened above.
      try {
        const settings = await getSettings();
        delay = Math.max(1, settings.googleSyncIntervalMinutes ?? 5) * 60_000;
      } catch { /* keep the default interval */ }
      schedulerStatus.nextExpectedRunTime = new Date(Date.now() + delay).toISOString();
      setTimeout(() => { void run(); }, delay);
    }
  };
  void run();
}

/** Runs one sync cycle (scheduler tick, or "Run Scheduled Check Now" in Settings). */
export async function runGoogleSheetsSyncSchedulerCheckNow() {
  if (schedulerCycleRunning) return { ran: false, reason: 'sync cycle already running' };
  schedulerCycleRunning = true;
  const started = Date.now();
  let ceilingTimer: NodeJS.Timeout | undefined;
  try {
    const cycle = runSyncCycle();
    // If the ceiling wins, the abandoned cycle may still settle later; its outcome is ignored.
    cycle.catch(() => undefined);
    const ceiling = new Promise<never>((_resolve, reject) => {
      ceilingTimer = setTimeout(
        () => reject(new Error(`Sync cycle exceeded ${CYCLE_HARD_CEILING_MS / 60_000} minutes and was abandoned.`)),
        CYCLE_HARD_CEILING_MS
      );
    });
    return await Promise.race([cycle, ceiling]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    schedulerStatus.lastSyncError = message;
    await recordSheetSyncError(message);
    throw error;
  } finally {
    // Always release the flag so one bad cycle can never block the next one.
    clearTimeout(ceilingTimer);
    schedulerCycleRunning = false;
    schedulerStatus.lastCycleDurationMs = Date.now() - started;
  }
}

async function runSyncCycle() {
  const settings = await getSettings();
  schedulerStatus.lastAutomaticCheckTime = new Date().toISOString();
  const plan = await getSchedulerPlan(settings);
  if ('skipReason' in plan) {
    schedulerStatus.lastSkipReason = plan.skipReason;
    console.log(`[SHEET_SYNC] skipped: ${plan.skipReason}`);
    return { ran: false, reason: plan.skipReason, mode: settings.mealTrackingMode };
  }
  // A final flush runs outside the meal window, so the write-backs must be forced.
  const force = plan.finalFlush;
  if (force) console.log('[SHEET_SYNC] Outside meal window with scans newer than the last write-back: running a final write-back');

  const errors: string[] = [];
  let rowsUpdated = 0;
  let writeBackComplete = true;
  const stage = async (label: string, isWriteBack: boolean, action: () => Promise<unknown>) => {
    const stageStarted = Date.now();
    try {
      const result = await action() as { writeBackRowsUpdated?: number } | null;
      rowsUpdated += result?.writeBackRowsUpdated ?? 0;
      console.log(`[SHEET_SYNC] ${label} completed durationMs=${Date.now() - stageStarted}`);
    } catch (error) {
      if (isWriteBack) writeBackComplete = false;
      if (error instanceof SheetSyncBusyError) {
        // Someone started a manual sync in the meantime; not a failure, try again next cycle.
        console.log(`[SHEET_SYNC] ${label} skipped: ${error.message}`);
        return;
      }
      const message = mapGoogleSheetsError(error).message;
      errors.push(`${label}: ${message}`);
      console.error(`[SHEET_SYNC] ${label} failed: ${message}`);
    }
  };
  if (settings.mealTrackingMode === MealTrackingMode.camp_meeting) await stage('entitlements', true, () => flushCampMeetingRedemptionsToSheet(force));
  if (settings.mealTrackingMode === MealTrackingMode.countdown) await stage('balances', true, () => writeBackPeopleRows(true, force));
  if (settings.mealTrackingMode === MealTrackingMode.tally) {
    const mode = getTallyWriteBackMode(settings);
    if (mode === 'weekly' || mode === 'both') await stage('weekly totals', true, () => writeBackWeeklyTally(force));
    if (mode === 'lifetime' || mode === 'both') await stage('lifetime totals', true, () => writeBackPeopleRows(false, force));
  }
  if (writeBackComplete) lastWriteBackSuccessAtMs = Date.now();
  // Do not re-import balances when write-back failed; still attempt LOG recovery.
  if (!errors.length && writeBackComplete) await stage('import', false, () => runAutoImportForMode(settings));
  // A final flush also exports the last LOG rows of the meal straight away.
  const logDue = plan.finalFlush || !schedulerStatus.lastLogSyncTime || Date.now() - Date.parse(schedulerStatus.lastLogSyncTime) >= LOG_EXPORT_INTERVAL_MS;
  if (logDue) await stage('LOG', false, () => syncTransactionLogToSheet({ scheduled: true }));
  else console.log('[SHEET_SYNC] LOG export not due (15 minute interval)');
  schedulerStatus.lastRowsUpdated = rowsUpdated;
  schedulerStatus.lastScheduledCycleOrder = 'writeback -> import (if writeback succeeded) -> LOG (when due)';
  schedulerStatus.lastSkipReason = null;
  schedulerStatus.lastSyncError = errors.length ? errors.join('; ') : null;
  schedulerStatus.lastCampMeetingWriteBackError = settings.mealTrackingMode === MealTrackingMode.camp_meeting ? schedulerStatus.lastSyncError : null;
  if (errors.length) throw new Error(errors.join('; '));
  if (writeBackComplete) {
    schedulerStatus.lastAutomaticWriteBackTime = new Date().toISOString();
    await recordSheetSyncSuccess();
  }
  return { ran: true, rowsUpdated, mode: settings.mealTrackingMode };
}

export async function getGoogleSheetsSchedulerStatus() {
  const settings = await getSettings().catch(() => null);
  const persisted = await getPersistedSheetSyncStatus().catch(() => null);
  return {
    ...schedulerStatus,
    // After a restart the in-memory status is empty; fall back to what was persisted.
    lastSyncError: schedulerStatus.lastSyncError ?? persisted?.lastError ?? null,
    lastAutomaticImportTime: schedulerStatus.lastAutomaticImportTime ?? settings?.googleLastAutoImportAt?.toISOString() ?? null,
    lastAutomaticImportSummary: schedulerStatus.lastAutomaticImportSummary ?? settings?.googleLastAutoImportSummary ?? null,
    persistedLastSuccessAt: persisted?.lastSuccessAt?.toISOString() ?? null,
    persistedLastError: persisted?.lastError ?? null,
    persistedLastErrorAt: persisted?.lastErrorAt?.toISOString() ?? null
  };
}
