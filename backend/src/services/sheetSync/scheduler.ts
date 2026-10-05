import { MealTrackingMode } from '@prisma/client';
import { peopleSheetRows } from '../peopleSheetRows.js';
import { getSettings } from '../settingsService.js';
import { prisma } from '../../db.js';
import { isImportInProgress, isResetInProgress, isSchedulerPaused, isWritebackInProgress } from '../operationLockService.js';
import { resolveTimezone } from '../../utils/timezone.js';
import { mapGoogleSheetsError, parseSpreadsheetId, readSheetRows } from './client.js';
import { isWithinMealWindowPlus10Minutes } from './mealWindow.js';
import { importCampMeetingFromSheet, importPeopleFromRows } from './import.js';
import { getTallyWriteBackMode, writeBackCampMeetingRedemptions, writeBackCountdownBalances, writeBackTallyCounts, writeBackWeeklyTally } from './writeBack.js';
import { syncTransactionLogToSheet } from './transactionLog.js';
import { schedulerStatus } from './state.js';

function getSchedulerSkipReason(settings: any): string | null {
  if (!settings.googleSheetsEnabled) return 'sync disabled';
  if (!parseSpreadsheetId(settings.googleSheetId || '')) return 'missing sheet ID';
  if (isResetInProgress()) return 'reset in progress';
  if (isImportInProgress()) return 'import already running';
  if (isWritebackInProgress()) return 'writeback already running';
  if (isSchedulerPaused()) return 'scheduler paused';
  if (!isWithinMealWindowPlus10Minutes(new Date(), resolveTimezone(settings.timezone), settings)) return 'outside meal window';
  return null;
}

async function runAutoImportForMode(settings: Awaited<ReturnType<typeof getSettings>>) {
  if (!settings.googleSheetsEnabled || !settings.googleAutoImportEnabled || !parseSpreadsheetId(settings.googleSheetId || '') || isResetInProgress()) {
    return null;
  }
  if (settings.mealTrackingMode === MealTrackingMode.camp_meeting) {
    const summary = await importCampMeetingFromSheet();
    const text = `[SHEET_SYNC] Auto import completed: ${summary.peopleCreated} people created, ${summary.peopleUpdated} updated, ${summary.entitlementsCreated + summary.entitlementsUpdated} entitlements created/updated, ${summary.skippedRows} skipped`;
    console.log(text);
    await prisma.setting.update({ where: { id: 1 }, data: { googleLastAutoImportAt: new Date(), googleLastAutoImportSummary: text } });
    schedulerStatus.lastAutomaticImportTime = new Date().toISOString();
    schedulerStatus.lastAutomaticImportSummary = text;
    return text;
  }
  const { rows } = await readSheetRows();
  const dataRows = peopleSheetRows(rows as string[][]);
  const result = settings.mealTrackingMode === MealTrackingMode.tally
    ? await importPeopleFromRows(dataRows as string[][], { includeBalances: false, overwriteExistingBalances: false, overwriteExistingCounts: false })
    : await importPeopleFromRows(dataRows as string[][], { includeBalances: true, overwriteExistingBalances: false, overwriteExistingCounts: false });
  const text = `[SHEET_SYNC] Auto import completed: ${result.peopleCreated} people created, ${result.peopleUpdated} updated, 0 entitlements created/updated, ${result.rowsSkipped} skipped`;
  console.log(text);
  await prisma.setting.update({ where: { id: 1 }, data: { googleLastAutoImportAt: new Date(), googleLastAutoImportSummary: text } });
  schedulerStatus.lastAutomaticImportTime = new Date().toISOString();
  schedulerStatus.lastAutomaticImportSummary = text;
  return text;
}

let schedulerCycleRunning = false;

export function startCampMeetingSheetSyncScheduler() {
  if (schedulerStatus.schedulerEnabled) return;
  schedulerStatus.schedulerEnabled = true;
  console.log('[SHEET_SYNC] Scheduler started');
  const run = async () => {
    try { await runGoogleSheetsSyncSchedulerCheckNow(); }
    catch (error) { console.error('[SHEET_SYNC]', error instanceof Error ? error.message : String(error)); }
    finally {
      const settings = await getSettings().catch(() => null);
      const delay = Math.max(1, settings?.googleSyncIntervalMinutes ?? 5) * 60000;
      schedulerStatus.nextExpectedRunTime = new Date(Date.now() + delay).toISOString();
      setTimeout(() => { void run(); }, delay);
    }
  };
  void run();
}

export async function runGoogleSheetsSyncSchedulerCheckNow() {
  if (schedulerCycleRunning) return { ran: false, reason: 'sync cycle already running' };
  schedulerCycleRunning = true;
  const started = Date.now();
  try {
    const settings = await getSettings();
    schedulerStatus.lastAutomaticCheckTime = new Date().toISOString();
    const skipReason = getSchedulerSkipReason(settings);
    if (skipReason) {
      schedulerStatus.lastSkipReason = skipReason;
      console.log(`[SHEET_SYNC] skipped: ${skipReason}`);
      return { ran: false, reason: skipReason, mode: settings.mealTrackingMode };
    }
    const errors: string[] = [];
    let rowsUpdated = 0;
    const stage = async (label: string, action: () => Promise<unknown>) => {
      const stageStarted = Date.now();
      try {
        const result = await action() as { writeBackRowsUpdated?: number } | null;
        rowsUpdated += result?.writeBackRowsUpdated ?? 0;
        console.log(`[SHEET_SYNC] ${label} completed durationMs=${Date.now() - stageStarted}`);
      } catch (error) {
        const message = mapGoogleSheetsError(error).message;
        errors.push(`${label}: ${message}`);
        console.error(`[SHEET_SYNC] ${label} failed: ${message}`);
      }
    };
    if (settings.mealTrackingMode === MealTrackingMode.camp_meeting) await stage('entitlements', () => writeBackCampMeetingRedemptions(false));
    if (settings.mealTrackingMode === MealTrackingMode.countdown) await stage('balances', () => writeBackCountdownBalances(false));
    if (settings.mealTrackingMode === MealTrackingMode.tally) {
      const mode = getTallyWriteBackMode(settings);
      if (mode === 'weekly' || mode === 'both') await stage('weekly totals', () => writeBackWeeklyTally(false));
      if (mode === 'lifetime' || mode === 'both') await stage('lifetime totals', () => writeBackTallyCounts(false));
    }
    // Do not re-import balances when write-back failed; still attempt LOG recovery.
    if (!errors.length) await stage('import', () => runAutoImportForMode(settings));
    const logDue = !schedulerStatus.lastLogSyncTime || Date.now() - Date.parse(schedulerStatus.lastLogSyncTime) >= 15 * 60000;
    if (logDue) await stage('LOG', () => syncTransactionLogToSheet());
    else console.log('[SHEET_SYNC] LOG export not due (15 minute interval)');
    schedulerStatus.lastRowsUpdated = rowsUpdated;
    schedulerStatus.lastScheduledCycleOrder = 'writeback -> import (if writeback succeeded) -> LOG (when due)';
    schedulerStatus.lastSkipReason = null;
    schedulerStatus.lastSyncError = errors.length ? errors.join('; ') : null;
    schedulerStatus.lastCampMeetingWriteBackError = settings.mealTrackingMode === MealTrackingMode.camp_meeting ? schedulerStatus.lastSyncError : null;
    if (errors.length) throw new Error(errors.join('; '));
    schedulerStatus.lastAutomaticWriteBackTime = new Date().toISOString();
    return { ran: true, rowsUpdated, mode: settings.mealTrackingMode };
  } finally {
    schedulerCycleRunning = false;
    schedulerStatus.lastCycleDurationMs = Date.now() - started;
  }
}

export async function getGoogleSheetsSchedulerStatus() {
  const settings = await getSettings().catch(() => null);
  return {
    ...schedulerStatus,
    lastAutomaticImportTime: schedulerStatus.lastAutomaticImportTime ?? settings?.googleLastAutoImportAt?.toISOString() ?? null,
    lastAutomaticImportSummary: schedulerStatus.lastAutomaticImportSummary ?? settings?.googleLastAutoImportSummary ?? null
  };
}
