import { getSettings } from '../settingsService.js';
import { prisma } from '../../db.js';
import { acquireOperationLock, releaseOperationLock } from '../operationLockService.js';
import { getSheetsClient, mapGoogleSheetsError, parseSpreadsheetId } from './client.js';
import { schedulerStatus } from './state.js';

const LOG_TAB_NAME = 'LOG';
const LOG_HEADER = ['Time', 'Value', 'Meal', 'Result', 'Reason', 'Person', 'Station', 'Transaction ID', 'Type'];

const formattedLogSheets = new Set<string>();

export async function syncTransactionLogToSheet() {
  if (!acquireOperationLock('writeback')) {
    throw new Error('Another sheet sync is running. Please try again shortly.');
  }
  try {
    console.log('[SHEET_SYNC][LOG] Starting LOG sync');
    const settings = await getSettings();
    if (!settings.googleSheetsEnabled) throw new Error('Google Sheets sync is disabled in Settings.');
    const spreadsheetId = parseSpreadsheetId(settings.googleSheetId || '');
    if (!spreadsheetId) throw new Error('Google Sheet URL/ID is not configured.');
    const sheets = getSheetsClient();

    const transactions = await prisma.scanTransaction.findMany({
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      include: { person: { select: { firstName: true, lastName: true, personType: true } } }
    });
    console.log(`[SHEET_SYNC][LOG] Loaded local transactions: ${transactions.length}`);

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const logTab = meta.data.sheets?.find((s) => s.properties?.title === LOG_TAB_NAME);
    if (!logTab) {
      console.log('[SHEET_SYNC][LOG] LOG tab missing; creating tab');
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: LOG_TAB_NAME } } }] } });
    }

    const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:I1` });
    const currentHeader = (headerResp.data.values?.[0] || []).map((cell) => `${cell ?? ''}`.trim());
    const transactionIdHeaderIndex = currentHeader.findIndex((value) => value === 'Transaction ID');
    const headerMatches = LOG_HEADER.every((value, idx) => (currentHeader[idx] || '') === value);
    if (!headerMatches) {
      if (transactionIdHeaderIndex === -1) {
        console.log('[SHEET_SYNC][LOG] Transaction ID header missing; writing canonical LOG header with Transaction ID after Station');
      } else {
        console.log('[SHEET_SYNC][LOG] LOG header mismatch; normalizing header');
      }
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:I1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [LOG_HEADER] } });
    }

    const refreshedMeta = logTab ? meta : await sheets.spreadsheets.get({ spreadsheetId });
    const logSheetId = refreshedMeta.data.sheets?.find((s) => s.properties?.title === LOG_TAB_NAME)?.properties?.sheetId;
    if (typeof logSheetId === 'number' && !formattedLogSheets.has(spreadsheetId)) {
      const transactionIdColumnIndex = 7;
      console.log('[SHEET_SYNC][LOG] Hiding Transaction ID column');
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            updateDimensionProperties: {
              range: { sheetId: logSheetId, dimension: 'COLUMNS', startIndex: transactionIdColumnIndex, endIndex: transactionIdColumnIndex + 1 },
              properties: { hiddenByUser: true },
              fields: 'hiddenByUser'
            }
          }]
        }
      });
    }

    if (typeof logSheetId === 'number') formattedLogSheets.add(spreadsheetId);
    console.log('[SHEET_SYNC][LOG] Reading existing LOG rows');
    const logResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${LOG_TAB_NAME}!A2:I` });
    const logRows = (logResp.data.values || []) as string[][];
    const existingTransactionIds = new Set(
      logRows
        .map((row) => `${row[7] ?? ''}`.trim())
        .filter((value) => value.length > 0)
    );
    console.log(`[SHEET_SYNC][LOG] Existing LOG rows: ${logRows.length}; transaction IDs found: ${existingTransactionIds.size}`);

    const missingTransactions = transactions.filter((tx) => !existingTransactionIds.has(String(tx.id)));
    const rowsToAppend = missingTransactions.map((tx) => {
      const personName = tx.person ? `${tx.person.firstName} ${tx.person.lastName}`.trim() : (tx.entitlementPersonName || '').trim();
      return [tx.timestamp.toISOString(), tx.scannedValue, tx.mealType, tx.result, tx.failureReason || '', personName, tx.stationName || '', String(tx.id), tx.person?.personType || ''];
    });

    // Keep existing LOG rows intact. A failed append can be retried by Transaction ID.
    for (let offset = 0; offset < rowsToAppend.length; offset += 1000) {
      await sheets.spreadsheets.values.append({
        spreadsheetId, range: `${LOG_TAB_NAME}!A:I`, valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS', requestBody: { values: rowsToAppend.slice(offset, offset + 1000) }
      });
    }
    console.log(`[SHEET_SYNC] totalTransactions=${transactions.length} logRowsFound=${logRows.length} existingTransactionIds=${existingTransactionIds.size} missingTransactions=${missingTransactions.length} rowsAppended=${rowsToAppend.length}`);

    const presentTransactionIds = new Set<string>([...existingTransactionIds, ...missingTransactions.map((tx) => String(tx.id))]);
    const unsyncedPresentTransactionIds = transactions.filter((tx) => tx.googleLogSyncedAt === null && presentTransactionIds.has(String(tx.id))).map((tx) => tx.id);
    if (unsyncedPresentTransactionIds.length) {
      await prisma.scanTransaction.updateMany({ where: { id: { in: unsyncedPresentTransactionIds }, googleLogSyncedAt: null }, data: { googleLogSyncedAt: new Date() } });
    }

    const reason = rowsToAppend.length === 0 ? (transactions.length === 0 ? 'No local ScanTransaction rows exist.' : 'No missing transactions found; LOG already includes every local Transaction ID.') : '';
    const result = {
      tabName: LOG_TAB_NAME,
      totalTransactions: transactions.length,
      logRowCount: transactions.length,
      existingLogRows: logRows.length,
      existingLogTransactionIds: existingTransactionIds.size,
      missingTransactionsFound: missingTransactions.length,
      rowsAppended: rowsToAppend.length,
      rowsRecreated: missingTransactions.length,
      duplicatesSkipped: transactions.length - missingTransactions.length,
      transactionsMarkedSynced: unsyncedPresentTransactionIds.length,
      transactionsSynced: unsyncedPresentTransactionIds.length,
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

export async function rebuildTransactionLogFromDatabase() {
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
      include: { person: { select: { firstName: true, lastName: true, personType: true } } }
    });

    const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:I1` });
    const currentHeader = (headerResp.data.values?.[0] || []).map((cell) => `${cell ?? ''}`.trim());
    const headerMatches = LOG_HEADER.every((value, idx) => (currentHeader[idx] || '') === value);
    if (!headerMatches) {
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${LOG_TAB_NAME}!A1:I1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [LOG_HEADER] } });
    }

    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${LOG_TAB_NAME}!A2:I` });
    const values = transactions.map((tx) => {
      const personName = tx.person ? `${tx.person.firstName} ${tx.person.lastName}`.trim() : (tx.entitlementPersonName || '').trim();
      return [tx.timestamp.toISOString(), tx.scannedValue, tx.mealType, tx.result, tx.failureReason || '', personName, tx.stationName || '', String(tx.id), tx.person?.personType || ''];
    });
    if (values.length) {
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${LOG_TAB_NAME}!A2:I`, valueInputOption: 'USER_ENTERED', requestBody: { values } });
    }
    await prisma.scanTransaction.updateMany({ where: { googleLogSyncedAt: null }, data: { googleLogSyncedAt: new Date() } });
    return { tabName: LOG_TAB_NAME, totalTransactions: transactions.length, rowsRebuilt: values.length };
  } catch (error) {
    throw mapGoogleSheetsError(error);
  } finally {
    releaseOperationLock('writeback');
  }
}
