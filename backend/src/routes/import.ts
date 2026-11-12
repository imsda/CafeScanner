import { MealTrackingMode, type PersonType, type Prisma } from '@prisma/client';
import { asyncRouter } from '../utils/asyncRouter.js';
import { requireAdmin } from '../middleware/auth.js';
import type { Request, Response } from 'express';
import { acquireOperationLock, isResetInProgress, releaseOperationLock } from '../services/operationLockService.js';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { isSqliteTimeoutError, prisma } from '../db.js';
import { nanoid } from 'nanoid';
import { getMealTrackingMode, getSettings } from '../services/settingsService.js';
import { importCampMeetingFromSheet, importTallyFromSheet, importCountdownFromSheet, writeBackCampMeetingRedemptions, writeBackCountdownBalances, writeBackTallyCounts, writeBackWeeklyTallyNow, syncTransactionLogToSheet, rebuildTransactionLogFromDatabase } from '../services/campMeetingSheetSyncService.js';
import { importCampMeetingRows, mapRowsToCampMeetingInput, normalizeCampMeetingRows } from '../services/campMeetingImportService.js';
import { parsePersonType } from '../services/peopleSheetRows.js';

// CSV uploads are parsed in memory, so cap their size.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

// Every CSV upload goes through here. `bom` strips the byte order mark Excel's "CSV UTF-8" export
// adds (otherwise the first header never matches) and `trim` drops stray spaces around cells.
// Malformed CSV is a client error (400), not a server failure.
function parseCsvRows(text: string): string[][] {
  try {
    return parse(text, { columns: false, skip_empty_lines: true, bom: true, trim: true }) as string[][];
  } catch (error) {
    throw Object.assign(new Error(`Could not read CSV file: ${error instanceof Error ? error.message : 'invalid format'}`), { status: 400 });
  }
}

function uploadedText(req: Request): string {
  return req.file?.buffer.toString('utf-8') || '';
}

const router = asyncRouter();

async function getMode() {
  return getMealTrackingMode();
}

function parseErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Unexpected import error';
}

// ---------------------------------------------------------------------------
// People CSV (tally / countdown). Preview and commit both go through
// parsePeopleCsv so they can never disagree about which rows are valid.
// ---------------------------------------------------------------------------

const NUMERIC_FIELDS = ['breakfastRemaining', 'lunchRemaining', 'dinnerRemaining', 'breakfastCount', 'lunchCount', 'dinnerCount', 'totalMealsCount'] as const;
const COUNT_FIELDS = ['breakfastCount', 'lunchCount', 'dinnerCount'] as const;
const TEXT_FIELDS = ['grade', 'group', 'campus', 'notes'] as const;
type NumericField = typeof NUMERIC_FIELDS[number];
type TextField = typeof TEXT_FIELDS[number];
type PeopleField = 'personId' | 'firstName' | 'lastName' | 'name' | 'codeValue' | 'personType' | 'active' | NumericField | TextField;

// Only columns that are present in the file AND have a value in the row appear here, so an update
// never overwrites existing data with a default.
type NormalizedPersonRow = {
  personId: string;
  firstName: string;
  lastName: string;
  codeValue?: string;
  personType?: PersonType;
  active?: boolean;
} & Partial<Record<NumericField, number>> & Partial<Record<TextField, string>>;

type PeopleCsvRow = { index: number; valid: boolean; errors: string[]; normalized: NormalizedPersonRow | null };

type PeopleCsv = {
  rows: PeopleCsvRow[];
  recognizedColumns: string[];
  ignoredColumns: string[];
  // True when the file carries any per-meal count column, in which case the tally total is recomputed.
  hasCountColumns: boolean;
};

// Header names match case-insensitively, ignoring spaces, underscores and hyphens.
const HEADER_ALIASES: Record<string, PeopleField> = {
  personid: 'personId', id: 'personId', studentid: 'personId',
  firstname: 'firstName', lastname: 'lastName', name: 'name', fullname: 'name',
  codevalue: 'codeValue', code: 'codeValue',
  usertype: 'personType', persontype: 'personType',
  active: 'active', grade: 'grade', group: 'group', campus: 'campus', notes: 'notes',
  breakfastremaining: 'breakfastRemaining', lunchremaining: 'lunchRemaining', dinnerremaining: 'dinnerRemaining',
  breakfastcount: 'breakfastCount', lunchcount: 'lunchCount', dinnercount: 'dinnerCount',
  totalmealscount: 'totalMealsCount'
};

function headerToField(header: string, mode: MealTrackingMode): PeopleField | null {
  const key = header.toLowerCase().replace(/[\s_-]/g, '');
  // The Google Sheet layout (ID, Name, Breakfast, Lunch, Dinner, Total) uses bare meal names: they
  // are counts in tally mode and remaining balances in countdown mode. "Total" is never read; it is
  // recomputed from the counts.
  if (key === 'breakfast' || key === 'lunch' || key === 'dinner') {
    return `${key}${mode === MealTrackingMode.countdown ? 'Remaining' : 'Count'}` as PeopleField;
  }
  return HEADER_ALIASES[key] ?? null;
}

const TRUE_VALUES = ['1', 'true', 'yes', 'y'];
const FALSE_VALUES = ['0', 'false', 'no', 'n'];
const MAX_INT = 2147483647;

function parsePeopleCsv(text: string, mode: MealTrackingMode): PeopleCsv {
  const records = parseCsvRows(text);
  const headers = records[0] ?? [];
  const columnByField = new Map<PeopleField, number>();
  const recognizedColumns: string[] = [];
  const ignoredColumns: string[] = [];
  headers.forEach((header, column) => {
    const field = headerToField(header, mode);
    // An unknown column, or a second column for a field that is already mapped, is ignored.
    if (!field || columnByField.has(field)) {
      if (header) ignoredColumns.push(header);
      return;
    }
    columnByField.set(field, column);
    recognizedColumns.push(header);
  });

  const hasSplitName = columnByField.has('firstName') || columnByField.has('lastName');
  const rows = records.slice(1).map((record, idx): PeopleCsvRow => {
    const cell = (field: PeopleField) => {
      const column = columnByField.get(field);
      return column === undefined ? '' : String(record[column] ?? '').trim();
    };
    const errors: string[] = [];

    const personId = cell('personId');
    if (!personId) errors.push('personId is required');

    let firstName = '';
    let lastName = '';
    if (hasSplitName) {
      firstName = cell('firstName');
      lastName = cell('lastName');
      if (!firstName) errors.push('firstName is required');
      if (!lastName) errors.push('lastName is required');
    } else {
      // A single full-name column is split on the last space: "Mary Ann Smith" -> "Mary Ann" + "Smith".
      const name = cell('name').replace(/\s+/g, ' ');
      const lastSpace = name.lastIndexOf(' ');
      firstName = lastSpace < 0 ? name : name.slice(0, lastSpace);
      lastName = lastSpace < 0 ? '' : name.slice(lastSpace + 1);
      if (!name) errors.push(columnByField.has('name') ? 'name is required' : 'firstName and lastName (or name) are required');
    }

    const normalized: NormalizedPersonRow = { personId, firstName, lastName };

    for (const field of NUMERIC_FIELDS) {
      const raw = cell(field);
      if (!raw) continue;
      if (!/^\d+$/.test(raw) || Number(raw) > MAX_INT) {
        errors.push(`${field} must be a whole number of 0 or more (got "${raw}")`);
        continue;
      }
      normalized[field] = Number(raw);
    }

    for (const field of TEXT_FIELDS) {
      const raw = cell(field);
      if (raw) normalized[field] = raw;
    }

    const codeValue = cell('codeValue');
    if (codeValue) normalized.codeValue = codeValue;

    const activeRaw = cell('active').toLowerCase();
    if (activeRaw) {
      if (TRUE_VALUES.includes(activeRaw)) normalized.active = true;
      else if (FALSE_VALUES.includes(activeRaw)) normalized.active = false;
      else errors.push('active must be true/false, yes/no or 1/0');
    }

    try {
      const personType = parsePersonType(cell('personType'));
      if (personType) normalized.personType = personType;
    } catch (error) {
      errors.push(parseErrorMessage(error));
    }

    const valid = errors.length === 0;
    return { index: idx + 1, valid, errors, normalized: valid ? normalized : null };
  });

  return { rows, recognizedColumns, ignoredColumns, hasCountColumns: COUNT_FIELDS.some((field) => columnByField.has(field)) };
}

// Writes one validated row. An existing person only has the supplied values changed: columns that
// are missing from the file, and empty cells, leave the stored value alone (so a names-only roster
// cannot zero counts and balances, clear grade/group/campus/notes, re-activate someone or replace
// the code printed on their badge). New people get defaults for whatever is missing.
async function savePersonRow(row: NormalizedPersonRow, options: { hasCountColumns: boolean; generateMissingCodes: boolean }) {
  const { personId, ...values } = row;
  const existing = await prisma.person.findUnique({
    where: { personId },
    select: { breakfastCount: true, lunchCount: true, dinnerCount: true }
  });

  const data: Prisma.PersonUpdateInput = { ...values };
  if (options.hasCountColumns) {
    data.totalMealsCount = COUNT_FIELDS.reduce((sum, field) => sum + (row[field] ?? existing?.[field] ?? 0), 0);
  }

  if (existing) {
    await prisma.person.update({ where: { personId }, data });
    return;
  }
  await prisma.person.create({
    data: {
      ...(data as Prisma.PersonCreateInput),
      personId,
      codeValue: row.codeValue || (options.generateMissingCodes ? nanoid(10) : `${personId}-${nanoid(4)}`)
    }
  });
}

// ---------------------------------------------------------------------------
// Camp Meeting CSV. Preview and commit share the header mapping and row
// normalisation used by the import itself.
// ---------------------------------------------------------------------------

function parseCampMeetingCsv(text: string) {
  const { inputRows, errors: headerErrors } = mapRowsToCampMeetingInput(parseCsvRows(text));
  if (headerErrors.length) return { headerErrors, inputRows, normalized: null };
  return { headerErrors, inputRows, normalized: normalizeCampMeetingRows(inputRows, { source: 'csv' }) };
}

const CAMP_MEETING_TEMPLATE = 'ticket_id,reg_id,guest_name,meal_type,meal_day,meal_date,ticket_type,price,redeemed,redeemed_at,redeemed_by,notes\n';

// Default response: the Google Sheet column layout for the current mode (linked from Settings).
// ?format=csv: the people CSV layout for the Import page (Camp Meeting uses one layout for both).
router.get('/template', async (req, res) => {
  const mode = await getMode();
  res.setHeader('Content-Type', 'text/csv');
  if (mode === MealTrackingMode.camp_meeting) {
    res.setHeader('Content-Disposition', 'attachment; filename="camp-meeting-google-sheet-template.csv"');
    return res.send(CAMP_MEETING_TEMPLATE);
  }
  const modeName = mode === MealTrackingMode.tally ? 'tally-up' : 'count-down';
  if (req.query.format === 'csv') {
    const balances = mode === MealTrackingMode.countdown ? 'breakfastRemaining,lunchRemaining,dinnerRemaining,' : '';
    res.setHeader('Content-Disposition', `attachment; filename="${modeName}-people-import-template.csv"`);
    return res.send(`firstName,lastName,personId,personType,${balances}grade,group,campus,notes\n`);
  }
  const header = mode === MealTrackingMode.tally ? 'ID,Name,Breakfast,Lunch,Dinner,Total,User Type\n' : 'ID,Name,Breakfast,Lunch,Dinner,Total\n';
  res.setHeader('Content-Disposition', `attachment; filename="${modeName}-google-sheet-template.csv"`);
  return res.send(header);
});

router.get('/camp-meeting/summary', async (_req, res) => {
  const [totalEntitlements, totalRedeemed] = await Promise.all([
    prisma.mealEntitlement.count(),
    prisma.mealEntitlement.count({ where: { redeemed: true } })
  ]);

  res.json({
    totalEntitlements,
    totalRedeemed,
    totalRemaining: Math.max(0, totalEntitlements - totalRedeemed)
  });
});

router.post('/google-sheet/import', async (_req, res) => {
  try {
    const mode = await getMode();
    const result = mode === MealTrackingMode.camp_meeting ? await importCampMeetingFromSheet() : mode === MealTrackingMode.tally ? await importTallyFromSheet() : await importCountdownFromSheet();
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[GOOGLE_SHEETS_IMPORT]', error);
    const message = error instanceof Error ? error.message : 'Google Sheet import failed.';
    const lower = message.toLowerCase();
    const isBadRequest = lower.includes('missing') || lower.includes('invalid') || lower.includes('not found') || lower.includes('denied access') || lower.includes('disabled');
    return res.status(isBadRequest ? 400 : 500).json({ error: message });
  }
});

router.post('/google-sheet/write-back-now', requireAdmin, async (req, res) => {
  try {
  const mode = await getMode();
  let result;
  if (mode === MealTrackingMode.camp_meeting) result = await writeBackCampMeetingRedemptions(true);
  else if (mode === MealTrackingMode.countdown) result = await writeBackCountdownBalances(true);
  else {
    const settings = await getSettings();
    const tallyMode = (settings.tallyWriteBackMode || 'lifetime').toLowerCase();
    if (tallyMode === 'weekly') result = await writeBackWeeklyTallyNow(true);
    else if (tallyMode === 'both') {
      const lifetime = await writeBackTallyCounts(true);
      const weekly = await writeBackWeeklyTallyNow(true);
      result = { ...lifetime, weekly };
    } else result = await writeBackTallyCounts(true);
  }
  return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[TALLY_WRITEBACK]', error instanceof Error ? error.message : String(error));
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Tally write-back failed.' });
  }
});

router.post('/google-sheet/write-weekly-tally-now', requireAdmin, async (req, res) => {
  const settings = await getSettings();
  if (!settings.googleSheetsEnabled) return res.status(400).json({ error: 'Google Sheets sync is disabled.' });
  if (!settings.googleSheetId?.trim()) return res.status(400).json({ error: 'Google Sheet ID is required.' });
  const weeklyTabName = settings.tallyWeeklyRawTabName?.trim() || 'Weekly Tally Raw';
  if (!settings.tallyWeeklyRawTabName?.trim()) {
    await prisma.setting.update({ where: { id: settings.id }, data: { tallyWeeklyRawTabName: weeklyTabName } });
  }
  try {
  const result = await writeBackWeeklyTallyNow(true);
  return res.json({
    ok: true,
    tabName: result.tabName ?? weeklyTabName,
    expectedRows: result.expectedRows ?? 0,
    rowsUpdated: result.rowsUpdated ?? result.writeBackRowsUpdated ?? 0,
    rowsAppended: result.rowsAppended ?? 0,
    duplicateRowsFound: result.duplicateRowsFound ?? 0,
    weeksCovered: result.weeksCovered ?? [],
    rowsWritten: result.rowsWritten ?? ((result.rowsUpdated ?? result.writeBackRowsUpdated ?? 0) + (result.rowsAppended ?? 0))
  });
  } catch (error) {
    console.error('[WEEKLY_TALLY_SYNC]', error instanceof Error ? error.message : String(error));
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Weekly tally sync failed.' });
  }
});

router.post('/google-sheet/write-log-now', requireAdmin, async (req, res) => {
  try {
    const result = await syncTransactionLogToSheet();
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[GOOGLE_SHEETS_LOG_SYNC]', error instanceof Error ? error.message : String(error));
    const message = error instanceof Error ? error.message : 'Google Sheet LOG sync failed.';
    return res.status(400).json({ error: message });
  }
});

router.post('/google-sheet/rebuild-log-now', requireAdmin, async (req, res) => {
  try {
    const result = await rebuildTransactionLogFromDatabase();
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[GOOGLE_SHEETS_LOG_REBUILD]', error);
    const message = error instanceof Error ? error.message : 'Google Sheet LOG rebuild failed.';
    return res.status(400).json({ error: message });
  }
});

router.post('/preview', upload.single('file'), async (req, res) => {
  const mode = await getMode();
  const text = uploadedText(req);

  if (mode === MealTrackingMode.camp_meeting) {
    const { headerErrors, inputRows, normalized } = parseCampMeetingCsv(text);
    if (!normalized) return res.status(400).json({ error: headerErrors.join('; '), mode });
    const validByRow = new Map(normalized.validRows.map((row) => [row.rowNumber, row]));
    const reasonByRow = new Map(normalized.skipped.map((entry) => [entry.row, entry.reason]));
    const preview = inputRows.map((raw, idx) => {
      // Row numbers match the import: the header is row 1, so the first data row is row 2.
      const rowNumber = idx + 2;
      const row = validByRow.get(rowNumber);
      const reason = reasonByRow.get(rowNumber);
      return {
        index: idx + 1,
        personId: row?.personId ?? raw.reg_id,
        personName: row?.personName ?? raw.guest_name,
        mealType: row?.mealType ?? raw.meal_type,
        mealDay: row?.mealDay ?? raw.meal_day,
        mealDate: row?.mealDate ?? raw.meal_date,
        errors: reason ? [reason] : [],
        valid: Boolean(row)
      };
    });
    return res.json({ total: preview.length, mode, preview });
  }

  const parsed = parsePeopleCsv(text, mode);
  const preview = parsed.rows.map(({ index, valid, errors, normalized }) => ({ index, row: normalized, errors, valid }));
  return res.json({ total: preview.length, mode, preview, recognizedColumns: parsed.recognizedColumns, ignoredColumns: parsed.ignoredColumns });
});

// Takes the shared import lock so resets and Google Sheets syncs cannot interleave with a CSV import.
router.post('/commit', upload.single('file'), async (req, res) => {
  if (isResetInProgress()) return res.status(409).json({ error: 'A reset is in progress. Try again after it completes.' });
  if (!acquireOperationLock('import')) return res.status(409).json({ error: 'Another import or sync is in progress. Try again shortly.' });
  try {
    return await commitCsvImport(req, res);
  } finally {
    releaseOperationLock('import');
  }
});

async function commitCsvImport(req: Request, res: Response) {
  const mode = await getMode();
  const text = uploadedText(req);

  if (mode === MealTrackingMode.camp_meeting) {
    // Validate the whole file before touching any data: a file with a bad header or no usable
    // rows must never wipe the existing tickets.
    const { headerErrors, inputRows, normalized } = parseCampMeetingCsv(text);
    if (!normalized) return res.status(400).json({ error: headerErrors.join('; '), mode });
    if (normalized.validRows.length === 0) {
      return res.status(400).json({
        error: 'No valid rows found in the file. Nothing was imported and existing entitlements were kept.',
        mode,
        totalRows: normalized.totalRows,
        skippedRowReasons: normalized.skipped
      });
    }

    const replaceExisting = req.body.replaceExisting === 'true';
    const existingCount = await prisma.mealEntitlement.count();

    if (existingCount > 0 && !replaceExisting) {
      return res.status(409).json({
        error: 'Existing Camp Meeting entitlements found. Confirm replace to continue.',
        requiresReplaceConfirmation: true,
        existingCount
      });
    }

    try {
      // The delete and the import run in one transaction, so a failure part-way through rolls
      // back and leaves the previous entitlements in place. The timeout is generous because the
      // import writes row by row.
      const summary = await prisma.$transaction(async (tx) => {
        if (replaceExisting) await tx.mealEntitlement.deleteMany({});
        return importCampMeetingRows(inputRows, { source: 'csv', db: tx });
      }, { maxWait: 15_000, timeout: 10 * 60_000 });

      await prisma.importHistory.create({
        data: {
          filename: req.file?.originalname || 'camp-meeting.csv',
          totalRows: summary.totalRows,
          successRows: summary.validRows,
          failedRows: summary.skippedRows,
          errorSummary: summary.errors.slice(0, 8).join('; ') || null
        }
      });

      return res.json({ ...summary, mode });
    } catch (error) {
      const isTimeout = isSqliteTimeoutError(error);
      const message = isTimeout
        ? 'Database is busy during import. Please wait a moment and try again.'
        : parseErrorMessage(error);

      console.error('[IMPORT] Camp Meeting import failed.', error);

      return res.status(500).json({
        error: message,
        code: isTimeout ? 'SQLITE_TIMEOUT' : 'IMPORT_FAILED'
      });
    }
  }

  const generateMissingCodes = req.body.generateMissingCodes === 'true';
  const parsed = parsePeopleCsv(text, mode);
  let successRows = 0;
  const errors: Array<{ row: number; error: string }> = [];

  for (const row of parsed.rows) {
    if (!row.normalized) {
      errors.push({ row: row.index, error: row.errors.join('; ') });
      continue;
    }
    try {
      await savePersonRow(row.normalized, { hasCountColumns: parsed.hasCountColumns, generateMissingCodes });
      successRows++;
    } catch (e) {
      errors.push({ row: row.index, error: parseErrorMessage(e) });
    }
  }

  await prisma.importHistory.create({
    data: {
      filename: req.file?.originalname || 'upload.csv',
      totalRows: parsed.rows.length,
      successRows,
      failedRows: errors.length,
      errorSummary: errors.slice(0, 8).map((e) => `Row ${e.row}: ${e.error}`).join('; ')
    }
  });

  return res.json({
    totalRows: parsed.rows.length,
    successRows,
    failedRows: errors.length,
    errors,
    mode,
    recognizedColumns: parsed.recognizedColumns,
    ignoredColumns: parsed.ignoredColumns
  });
}

export default router;
