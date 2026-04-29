import { MealDay, MealTrackingMode, MealType } from '@prisma/client';
import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { isSqliteTimeoutError, prisma, withSqliteTimeoutRetry } from '../db.js';
import { nanoid } from 'nanoid';
import { getMealTrackingMode } from '../services/settingsService.js';
import { importCampMeetingFromSheet, importTallyFromSheet, importCountdownFromSheet, writeBackCampMeetingRedemptions, writeBackCountdownBalances, writeBackTallyCounts } from '../services/campMeetingSheetSyncService.js';

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

type Row = Record<string, string>;

type CampMeetingPreviewRow = {
  index: number;
  personId: string;
  personName: string;
  mealType: string;
  mealDay: string;
  mealDate: string;
  errors: string[];
  valid: boolean;
};

type ParsedPersonName = {
  firstName: string;
  lastName: string;
};

function normalizeCampMeetingPersonId(value: string): string {
  return value.trim().toUpperCase();
}

function parseBool(v: string) {
  return ['1', 'true', 'yes', 'y'].includes((v || '').toLowerCase());
}

function normalizeMealType(value: string): MealType | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'breakfast') return MealType.BREAKFAST;
  if (normalized === 'lunch') return MealType.LUNCH;
  if (normalized === 'dinner' || normalized === 'supper') return MealType.DINNER;
  return null;
}

function normalizeDateOnly(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, yearRaw, monthRaw, dayRaw] = dateOnlyMatch;
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return `${yearRaw}-${monthRaw}-${dayRaw}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}



function normalizeCampMeetingMealDay(value: string): MealDay | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  const dayMap: Record<string, MealDay> = {
    sun: MealDay.SUN,
    sunday: MealDay.SUN,
    mon: MealDay.MON,
    monday: MealDay.MON,
    tue: MealDay.TUE,
    tues: MealDay.TUE,
    tuesday: MealDay.TUE,
    wed: MealDay.WED,
    wednesday: MealDay.WED,
    thu: MealDay.THU,
    thur: MealDay.THU,
    thurs: MealDay.THU,
    thursday: MealDay.THU,
    fri: MealDay.FRI,
    friday: MealDay.FRI,
    sat: MealDay.SAT,
    saturday: MealDay.SAT
  };

  return dayMap[normalized] ?? null;
}

function normalizeCampMeetingDate(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, yearRaw, monthRaw, dayRaw] = isoMatch;
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);

    const localDate = new Date(year, month - 1, day);
    if (
      localDate.getFullYear() !== year ||
      localDate.getMonth() !== month - 1 ||
      localDate.getDate() !== day
    ) {
      return null;
    }

    return `${yearRaw}-${monthRaw}-${dayRaw}`;
  }

  const mmddyyMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!mmddyyMatch) return null;

  const [, monthRaw, dayRaw, yearRaw] = mmddyyMatch;
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const fullYear = 2000 + Number(yearRaw);

  if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const localDate = new Date(fullYear, month - 1, day);
  if (
    localDate.getFullYear() !== fullYear ||
    localDate.getMonth() !== month - 1 ||
    localDate.getDate() !== day
  ) {
    return null;
  }

  return `${String(fullYear)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isCampMeetingHeaderRow(cols: string[]): boolean {
  const normalized = cols.map((col) => (col || '').trim().toLowerCase());
  const colB = normalized[1] || '';
  const colC = normalized[2] || '';
  const colD = normalized[3] || '';
  const colE = normalized[4] || '';

  const personIdLike = new Set(['reg_id', 'personid', 'person_id', 'id']);
  const personNameLike = new Set(['guest_name', 'personname', 'person_name', 'name']);
  const mealTypeLike = new Set(['meal_type', 'mealtype']);
  const mealDayLike = new Set(['meal_day', 'mealday', 'day', 'day_of_week']);

  return personIdLike.has(colB) && personNameLike.has(colC) && mealTypeLike.has(colD) && mealDayLike.has(colE);
}

function splitCampMeetingName(personName: string): ParsedPersonName {
  const normalized = personName.trim().replace(/\s+/g, ' ');
  if (!normalized) return { firstName: 'Unknown', lastName: '' };

  const parts = normalized.split(' ');
  if (parts.length === 1) return { firstName: normalized, lastName: '' };

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ')
  };
}

async function getMode() {
  return getMealTrackingMode();
}

function parseErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Unexpected import error';
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function parseCampMeetingRows(text: string): CampMeetingPreviewRow[] {
  const rows = parse(text, { columns: false, skip_empty_lines: true, trim: false }) as string[][];
  const rowsWithoutHeader = rows.length > 0 && isCampMeetingHeaderRow(rows[0]) ? rows.slice(1) : rows;

  return rowsWithoutHeader.map((cols, idx) => {
    const personId = normalizeCampMeetingPersonId(cols[1] || '');
    const personName = (cols[2] || '').trim();
    const mealTypeRaw = (cols[3] || '').trim();
    const mealDayRaw = (cols[4] || '').trim();
    const mealDateRaw = (cols[5] || '').trim();
    const errors: string[] = [];

    if (!personId) errors.push('Column B (Person ID) is required');
    if (!personName) errors.push('Column C (Name) is required');
    if (!mealTypeRaw) errors.push('Column D (Meal Type) is required');
    if (!mealDayRaw) errors.push('Column E (Meal Day) is required');
    if (mealTypeRaw && !normalizeMealType(mealTypeRaw)) {
      errors.push('Column D must be Breakfast, Lunch, Dinner, or Supper');
    }
    if (mealDayRaw && !normalizeCampMeetingMealDay(mealDayRaw)) errors.push('Column E must be a valid day of week');
    if (mealDateRaw && !normalizeCampMeetingDate(mealDateRaw)) errors.push('Column F must be a valid date when provided');

    return {
      index: idx + 1,
      personId,
      personName,
      mealType: normalizeMealType(mealTypeRaw) ?? mealTypeRaw,
      mealDay: normalizeCampMeetingMealDay(mealDayRaw) ?? mealDayRaw,
      mealDate: normalizeCampMeetingDate(mealDateRaw) ?? mealDateRaw,
      errors,
      valid: errors.length === 0
    };
  }).filter((row) => row.personId || row.personName || row.mealType || row.mealDay || row.mealDate);
}

router.get('/template', async (_req, res) => {
  const mode = await getMode();
  if (mode === MealTrackingMode.camp_meeting) {
    const header = 'ticket_id,reg_id,guest_name,meal_type,meal_day,meal_date,ticket_type,price,redeemed,redeemed_at,redeemed_by,notes\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="camp-meeting-google-sheet-template.csv"');
    return res.send(header);
  }
  const header = 'ID,Name,Breakfast,Lunch,Dinner,Total\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${mode === MealTrackingMode.tally ? 'tally-up' : 'count-down'}-google-sheet-template.csv"`);
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

router.post('/google-sheet/write-back-now', async (req, res) => {
  if (req.session.role !== 'OWNER' && req.session.role !== 'ADMIN') return res.status(403).json({ error: 'OWNER or ADMIN required.' });
  const mode = await getMode();
  const result = mode === MealTrackingMode.camp_meeting ? await writeBackCampMeetingRedemptions(true) : mode === MealTrackingMode.tally ? await writeBackTallyCounts(true) : await writeBackCountdownBalances(true);
  return res.json({ ok: true, ...result });
});

router.post('/preview', upload.single('file'), async (req, res) => {
  const mode = await getMode();
  const text = req.file?.buffer.toString('utf-8') || '';

  if (mode === MealTrackingMode.camp_meeting) {
    const preview = parseCampMeetingRows(text);
    return res.json({ total: preview.length, mode, preview });
  }

  const rows = parse(text, { columns: true, skip_empty_lines: true }) as Row[];
  const preview = rows.map((row, idx) => {
    const errors: string[] = [];
    if (!row.firstName) errors.push('firstName is required');
    if (!row.lastName) errors.push('lastName is required');
    if (!row.personId) errors.push('personId is required');
    return { index: idx + 1, row, errors, valid: errors.length === 0 };
  });
  return res.json({ total: rows.length, mode, preview });
});

router.post('/commit', upload.single('file'), async (req, res) => {
  const mode = await getMode();

  if (mode === MealTrackingMode.camp_meeting) {
    const text = req.file?.buffer.toString('utf-8') || '';
    const preview = parseCampMeetingRows(text);
    const replaceExisting = req.body.replaceExisting === 'true';
    const existingCount = await prisma.mealEntitlement.count();

    if (existingCount > 0 && !replaceExisting) {
      return res.status(409).json({
        error: 'Existing Camp Meeting entitlements found. Confirm replace to continue.',
        requiresReplaceConfirmation: true,
        existingCount
      });
    }

    const validRows = preview.filter((row) => row.valid);
    const invalidRows = preview.filter((row) => !row.valid);
    const errors = invalidRows.map((row) => ({ row: row.index, error: row.errors.join('; ') }));

    const peopleByPersonId = new Map<string, { personId: string; personName: string; firstName: string; lastName: string }>();
    const entitlementRows: Array<{ personId: string; personName: string; mealType: MealType; mealDay: MealDay; mealDate: string }> = [];

    for (const row of validRows) {
      const mealType = normalizeMealType(row.mealType);
      const mealDay = normalizeCampMeetingMealDay(row.mealDay);
      const mealDate = normalizeCampMeetingDate(row.mealDate) ?? '';
      if (!mealType || !mealDay || !row.personId || !row.personName) continue;
      const normalizedPersonId = normalizeCampMeetingPersonId(row.personId);
      if (!normalizedPersonId) continue;

      if (!peopleByPersonId.has(normalizedPersonId)) {
        const { firstName, lastName } = splitCampMeetingName(row.personName);
        peopleByPersonId.set(normalizedPersonId, {
          personId: normalizedPersonId,
          personName: row.personName,
          firstName,
          lastName
        });
      }

      entitlementRows.push({
        personId: normalizedPersonId,
        personName: row.personName,
        mealType,
        mealDay,
        mealDate
      });
    }

    const peopleToUpsert = Array.from(peopleByPersonId.values());
    const personChunks = chunkArray(peopleToUpsert, 100);
    const entitlementChunks = chunkArray(entitlementRows, 250);

    console.log(`[IMPORT] Camp Meeting import start: file=${req.file?.originalname || 'camp-meeting.csv'}, totalRows=${preview.length}, validRows=${validRows.length}, invalidRows=${invalidRows.length}, peopleUpserts=${peopleToUpsert.length}, entitlementRows=${entitlementRows.length}, replaceExisting=${replaceExisting}`);

    try {
      if (replaceExisting) {
        await withSqliteTimeoutRetry('import.campMeeting.deleteExistingEntitlements', () => prisma.mealEntitlement.deleteMany({}));
      }

      for (let i = 0; i < personChunks.length; i++) {
        const chunk = personChunks[i];
        console.log(`[IMPORT] Upserting people chunk ${i + 1}/${personChunks.length} (rows=${chunk.length}).`);

        await withSqliteTimeoutRetry(`import.campMeeting.peopleChunk.${i + 1}`, async () => {
          await prisma.$transaction(
            chunk.map((person) => prisma.person.upsert({
              where: { personId: person.personId },
              update: {
                firstName: person.firstName,
                lastName: person.lastName,
                active: true
              },
              create: {
                firstName: person.firstName,
                lastName: person.lastName,
                personId: person.personId,
                codeValue: nanoid(10),
                active: true
              }
            }))
          );
        });
      }

      for (let i = 0; i < entitlementChunks.length; i++) {
        const chunk = entitlementChunks[i];
        console.log(`[IMPORT] Writing entitlement chunk ${i + 1}/${entitlementChunks.length} (rows=${chunk.length}).`);

        await withSqliteTimeoutRetry(`import.campMeeting.entitlementChunk.${i + 1}`, () => prisma.mealEntitlement.createMany({ data: chunk }));
      }

      const successRows = entitlementRows.length;
      const failedRows = preview.length - successRows;

      await prisma.importHistory.create({
        data: {
          filename: req.file?.originalname || 'camp-meeting.csv',
          totalRows: preview.length,
          successRows,
          failedRows,
          errorSummary: errors.slice(0, 8).map((e) => `Row ${e.row}: ${e.error}`).join('; ') || null
        }
      });

      console.log(`[IMPORT] Camp Meeting import complete: successRows=${successRows}, failedRows=${failedRows}.`);
      return res.json({ totalRows: preview.length, successRows, failedRows, errors, mode });
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
  const text = req.file?.buffer.toString('utf-8') || '';
  const rows = parse(text, { columns: true, skip_empty_lines: true }) as Row[];
  let successRows = 0;
  const errors: Array<{ row: number; error: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.firstName || !row.lastName || !row.personId) {
      errors.push({ row: i + 1, error: 'firstName,lastName,personId required' });
      continue;
    }

    try {
      await prisma.person.upsert({
        where: { personId: row.personId },
        update: {
          firstName: row.firstName,
          lastName: row.lastName,
          codeValue: row.codeValue || (generateMissingCodes ? nanoid(10) : undefined),
          breakfastRemaining: Number(row.breakfastRemaining || 0),
          lunchRemaining: Number(row.lunchRemaining || 0),
          dinnerRemaining: Number(row.dinnerRemaining || 0),
          breakfastCount: Number(row.breakfastCount || 0),
          lunchCount: Number(row.lunchCount || 0),
          dinnerCount: Number(row.dinnerCount || 0),
          totalMealsCount: Number(row.totalMealsCount || 0),
          active: row.active ? parseBool(row.active) : true,
          grade: row.grade || null,
          group: row.group || null,
          campus: row.campus || null,
          notes: row.notes || null
        },
        create: {
          firstName: row.firstName,
          lastName: row.lastName,
          personId: row.personId,
          codeValue: row.codeValue || (generateMissingCodes ? nanoid(10) : `${row.personId}-${nanoid(4)}`),
          breakfastRemaining: Number(row.breakfastRemaining || 0),
          lunchRemaining: Number(row.lunchRemaining || 0),
          dinnerRemaining: Number(row.dinnerRemaining || 0),
          breakfastCount: Number(row.breakfastCount || 0),
          lunchCount: Number(row.lunchCount || 0),
          dinnerCount: Number(row.dinnerCount || 0),
          totalMealsCount: Number(row.totalMealsCount || 0),
          active: row.active ? parseBool(row.active) : true,
          grade: row.grade || null,
          group: row.group || null,
          campus: row.campus || null,
          notes: row.notes || null
        }
      });
      successRows++;
    } catch (e: any) {
      errors.push({ row: i + 1, error: e.message });
    }
  }

  await prisma.importHistory.create({
    data: {
      filename: req.file?.originalname || 'upload.csv',
      totalRows: rows.length,
      successRows,
      failedRows: errors.length,
      errorSummary: errors.slice(0, 8).map((e) => `Row ${e.row}: ${e.error}`).join('; ')
    }
  });

  return res.json({ totalRows: rows.length, successRows, failedRows: errors.length, errors, mode });
});

export default router;
