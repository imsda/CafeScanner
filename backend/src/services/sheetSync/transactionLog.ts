import type { Prisma } from '@prisma/client';
import { getSettings } from '../settingsService.js';
import { prisma } from '../../db.js';
import { acquireOperationLock, releaseOperationLock } from '../operationLockService.js';
import { getSheetsClient, mapGoogleSheetsError, parseSpreadsheetId, SheetSyncBusyError, SHEETS_BULK_REQUEST_TIMEOUT_MS } from './client.js';
import { schedulerStatus } from './state.js';
import { trackManualSheetSync } from './status.js';

const LOG_TAB_NAME = 'LOG';
const LOG_HEADER = ['Time', 'Value', 'Meal', 'Result', 'Reason', 'Person', 'Station', 'Transaction ID', 'Type'];
const TRANSACTION_ID_COLUMN_INDEX = 7; // column H
const APPEND_BATCH_SIZE = 1000;
// How many of the newest LOG rows are re-checked for Transaction IDs on each sync.
const DUPLICATE_CHECK_TAIL_ROWS = 2000;

const formattedLogSheets = new Set<string>();
// Last LOG data row seen per spreadsheet (this process only). Unknown after a
// restart, which triggers one full read of the Transaction ID column.
const knownLastLogRow = new Map<string, number>();

const LOG_TRANSACTION_SELECT = {
  id: true, timestamp: true, scannedValue: true, mealType: true, result: true, failureReason: true,
  stationName: true, entitlementPersonName: true,
  person: { select: { firstName: true, lastName: true, personType: true } }
} satisfies Prisma.ScanTransactionSelect;
type LogTransaction = Prisma.ScanTransactionGetPayload<{ select: typeof LOG_TRANSACTION_SELECT }>;

function toLogRow(tx: LogTransaction): string[] {
  const personName = tx.person ? `${tx.person.firstName} ${tx.person.lastName}`.replace(/\s+/g, ' ').trim() : (tx.entitlementPersonName || '').trim();
  return [tx.timestamp.toISOString(), tx.scannedValue, tx.mealType, tx.result, tx.failureReason || '', personName, tx.stationName || '', String(tx.id), tx.person?.personType || ''];
}

type SheetsClient = ReturnType<typeof getSheetsClient>;

/**
 * Reads Transaction IDs from the tail of the LOG tab only (whole rows, so the
 * Transaction ID keeps its column position). Unsynced transactions are
 * always the newest ones, so their rows (if a previous append succeeded but the
 * database was not marked, e.g. a crash) are at the end of the tab.
 */
async function readRecentLogTransactionIds(sheets: SheetsClient, spreadsheetId: string) {
  const read = async (startRow: number) => {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${LOG_TAB_NAME}!A${startRow}:I` });
    return (resp.data.values || []) as unknown[][];
  };
  const lastKnown = knownLastLogRow.get(spreadsheetId);
  let startRow = lastKnown === undefined ? 2 : Math.max(2, lastKnown - DUPLICATE_CHECK_TAIL_ROWS + 1);
  let rows = await read(startRow);
  if (rows.length === 0 && startRow > 2) {
    // Rows were removed in the sheet; fall back to a full read once.
    startRow = 2;
    rows = await read(startRow);
  }
  knownLastLogRow.set(spreadsheetId, startRow + rows.length - 1);
  const ids = new Set<string>();
  for (const row of rows) {
    const value = `${row?.[TRANSACTION_ID_COLUMN_INDEX] ?? ''}`.trim();
    if (value) ids.add(value);
  }
  return { ids, rowsRead: rows.length };
}

async function runTransactionLogSync() {
  if (!acquireOperationLock('writeback')) {
    throw new SheetSyncBusyError('Another sheet sync is running. Please try again shortly.');
  }
  try {
    console.log('[SHEET_SYNC][LOG] Starting LOG sync');
    const settings = await getSettings();
    if (!settings.googleSheetsEnabled) throw new Error('Google Sheets sync is disabled in Settings.');
    const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
    if (!spreadsheetId) throw new Error('Google Sheet URL/ID is not configured.');
    const sheets = getSheetsClient();

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const logTab = meta.data.sheets?.find((s) => s.properties?.title === LOG_TAB_NAME);
    if (!logTab) {
      console.log('[SHEET_SYNC][LOG] LOG tab missing; creating tab');
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: LOG_TAB_NAME } } }] } });
      knownLastLogRow.delete(spreadsheetId);
      formattedLogSheets.delete(spreadsheetId);
    }

    const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:I1` });
    const currentHeader = (headerResp.data.values?.[0] || []).map((cell) => `${cell ?? ''}`.trim());
    const headerMatches = LOG_HEADER.every((value, idx) => (currentHeader[idx] || '') === value);
    if (!headerMatches) {
      console.log('[SHEET_SYNC][LOG] LOG header missing or different; writing canonical LOG header');
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:I1`, valueInputOption: 'RAW', requestBody: { values: [LOG_HEADER] } });
    }

    if (!formattedLogSheets.has(spreadsheetId)) {
      const refreshedMeta = logTab ? meta : await sheets.spreadsheets.get({ spreadsheetId });
      const logSheetId = refreshedMeta.data.sheets?.find((s) => s.properties?.title === LOG_TAB_NAME)?.properties?.sheetId;
      if (typeof logSheetId === 'number') {
        console.log('[SHEET_SYNC][LOG] Hiding Transaction ID column');
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              updateDimensionProperties: {
                range: { sheetId: logSheetId, dimension: 'COLUMNS', startIndex: TRANSACTION_ID_COLUMN_INDEX, endIndex: TRANSACTION_ID_COLUMN_INDEX + 1 },
                properties: { hiddenByUser: true },
                fields: 'hiddenByUser'
              }
            }]
          }
        });
        formattedLogSheets.add(spreadsheetId);
      }
    }

    // Only the newest LOG rows are read (see readRecentLogTransactionIds), and only
    // transactions not yet marked as exported are loaded from the database.
    const { ids: existingTransactionIds, rowsRead } = await readRecentLogTransactionIds(sheets, spreadsheetId);
    const totalTransactions = await prisma.scanTransaction.count();

    let rowsAppended = 0;
    let alreadyPresent = 0;
    let markedSynced = 0;
    const markSynced = async (ids: number[]) => {
      if (!ids.length) return;
      const result = await prisma.scanTransaction.updateMany({ where: { id: { in: ids }, googleLogSyncedAt: null }, data: { googleLogSyncedAt: new Date() } });
      markedSynced += result.count;
    };
    // Each pass marks everything it loaded, so the next pass sees the next batch.
    for (;;) {
      const batch = await prisma.scanTransaction.findMany({
        where: { googleLogSyncedAt: null },
        orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
        take: APPEND_BATCH_SIZE,
        select: LOG_TRANSACTION_SELECT
      });
      if (!batch.length) break;
      const present = batch.filter((tx) => existingTransactionIds.has(String(tx.id)));
      const missing = batch.filter((tx) => !existingTransactionIds.has(String(tx.id)));
      await markSynced(present.map((tx) => tx.id));
      alreadyPresent += present.length;
      if (missing.length) {
        // RAW: scanned values and names are stored exactly as text (no formulas, leading zeros kept).
        await sheets.spreadsheets.values.append({
          spreadsheetId, range: `${LOG_TAB_NAME}!A:I`, valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS', requestBody: { values: missing.map(toLogRow) }
        });
        // A failed append leaves this batch unmarked, so it is retried on the next sync.
        await markSynced(missing.map((tx) => tx.id));
        rowsAppended += missing.length;
        knownLastLogRow.set(spreadsheetId, (knownLastLogRow.get(spreadsheetId) ?? 1) + missing.length);
      }
      if (batch.length < APPEND_BATCH_SIZE) break;
    }

    const reason = rowsAppended === 0 ? (totalTransactions === 0 ? 'No local ScanTransaction rows exist.' : 'No missing transactions found; LOG already includes every local Transaction ID.') : '';
    const result = {
      tabName: LOG_TAB_NAME,
      totalTransactions,
      logRowCount: totalTransactions,
      existingLogRows: rowsRead,
      existingLogTransactionIds: existingTransactionIds.size,
      missingTransactionsFound: rowsAppended,
      rowsAppended,
      rowsRecreated: rowsAppended,
      duplicatesSkipped: alreadyPresent,
      transactionsMarkedSynced: markedSynced,
      transactionsSynced: markedSynced,
      reason
    };
    schedulerStatus.lastLogSyncTime = new Date().toISOString();
    console.log('[SHEET_SYNC][LOG] Sync complete', result);
    return result;
  } catch (error) {
    throw mapGoogleSheetsError(error);
  } finally {
    releaseOperationLock('writeback');
  }
}

/**
 * Appends transactions that have not been exported yet to the LOG tab.
 * `scheduled` is set by the scheduler, which records the outcome of its whole cycle;
 * otherwise this is the manual "Sync LOG" button and the outcome is recorded here.
 */
export async function syncTransactionLogToSheet(options: { scheduled?: boolean } = {}) {
  return options.scheduled ? runTransactionLogSync() : trackManualSheetSync(runTransactionLogSync);
}

/** Explicit admin action: clears the LOG tab and rewrites it from every stored transaction. */
export async function rebuildTransactionLogFromDatabase() {
  return trackManualSheetSync(runTransactionLogRebuild);
}

async function runTransactionLogRebuild() {
  if (!acquireOperationLock('writeback')) {
    return { tabName: LOG_TAB_NAME, totalTransactions: 0, rowsRebuilt: 0, reason: 'Writeback lock unavailable.' };
  }
  try {
    const settings = await getSettings();
    if (!settings.googleSheetsEnabled) throw new Error('Google Sheets sync is disabled in Settings.');
    const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
    if (!spreadsheetId) throw new Error('Google Sheet URL/ID is not configured.');
    const sheets = getSheetsClient();
    const transactions = await prisma.scanTransaction.findMany({
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      select: LOG_TRANSACTION_SELECT
    });

    const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:I1` });
    const currentHeader = (headerResp.data.values?.[0] || []).map((cell) => `${cell ?? ''}`.trim());
    const headerMatches = LOG_HEADER.every((value, idx) => (currentHeader[idx] || '') === value);
    if (!headerMatches) {
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:I1`, valueInputOption: 'RAW', requestBody: { values: [LOG_HEADER] } });
    }

    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${LOG_TAB_NAME}!A2:I` });
    knownLastLogRow.delete(spreadsheetId);
    const values = transactions.map(toLogRow);
    if (values.length) {
      // RAW: scanned values and names must not be parsed as formulas or numbers.
      // One large request, so it gets a longer timeout than the default.
      await sheets.spreadsheets.values.update(
        { spreadsheetId, range: `${LOG_TAB_NAME}!A2:I`, valueInputOption: 'RAW', requestBody: { values } },
        { timeout: SHEETS_BULK_REQUEST_TIMEOUT_MS }
      );
    }
    // Scans recorded while the rebuild was running are not in `values`; leave them
    // unmarked so the next incremental sync appends them.
    const newestId = transactions.reduce((max, tx) => Math.max(max, tx.id), 0);
    await prisma.scanTransaction.updateMany({ where: { googleLogSyncedAt: null, id: { lte: newestId } }, data: { googleLogSyncedAt: new Date() } });
    return { tabName: LOG_TAB_NAME, totalTransactions: transactions.length, rowsRebuilt: values.length };
  } catch (error) {
    throw mapGoogleSheetsError(error);
  } finally {
    releaseOperationLock('writeback');
  }
}
