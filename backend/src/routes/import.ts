import { MealTrackingMode, MealType } from '@prisma/client';
import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { prisma } from '../db.js';
import { nanoid } from 'nanoid';

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

type Row = Record<string, string>;

type CampMeetingPreviewRow = {
  index: number;
  personId: string;
  personName: string;
  mealType: string;
  mealDate: string;
  errors: string[];
  valid: boolean;
};

function parseBool(v: string) {
  return ['1', 'true', 'yes', 'y'].includes((v || '').toLowerCase());
}

function normalizeMealType(value: string): MealType | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'breakfast') return MealType.BREAKFAST;
  if (normalized === 'lunch') return MealType.LUNCH;
  if (normalized === 'dinner') return MealType.DINNER;
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

async function getMode() {
  const settings = await prisma.setting.findUnique({ where: { id: 1 }, select: { mealTrackingMode: true } });
  return settings?.mealTrackingMode ?? MealTrackingMode.camp_meeting;
}

function parseCampMeetingRows(text: string): CampMeetingPreviewRow[] {
  const rows = parse(text, { columns: false, skip_empty_lines: true, trim: false }) as string[][];

  return rows.map((cols, idx) => {
    const personId = (cols[1] || '').trim();
    const personName = (cols[2] || '').trim();
    const mealTypeRaw = (cols[3] || '').trim();
    const mealDateRaw = (cols[4] || '').trim();
    const errors: string[] = [];

    if (!personId) errors.push('Column B (Person ID) is required');
    if (!mealTypeRaw) errors.push('Column D (Meal Type) is required');
    if (!mealDateRaw) errors.push('Column E (Meal Day) is required');
    if (mealTypeRaw && !normalizeMealType(mealTypeRaw)) errors.push('Column D must be Breakfast, Lunch, or Dinner');
    if (mealDateRaw && !normalizeDateOnly(mealDateRaw)) errors.push('Column E must be a valid date');

    return {
      index: idx + 1,
      personId,
      personName,
      mealType: mealTypeRaw,
      mealDate: mealDateRaw,
      errors,
      valid: errors.length === 0
    };
  }).filter((row) => row.personId || row.personName || row.mealType || row.mealDate);
}

router.get('/template', async (_req, res) => {
  const mode = await getMode();
  if (mode === MealTrackingMode.camp_meeting) {
    const header = 'A,Person ID,Name,Meal Type,Meal Day\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="camp-meeting-template.csv"');
    return res.send(header);
  }

  const header = 'firstName,lastName,personId,codeValue,breakfastRemaining,lunchRemaining,dinnerRemaining,breakfastCount,lunchCount,dinnerCount,totalMealsCount,active,grade,group,campus,notes\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="people-template.csv"');
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
    let successRows = 0;

    await prisma.$transaction(async (tx) => {
      if (replaceExisting) {
        await tx.mealEntitlement.deleteMany({});
      }

      for (const row of validRows) {
        const mealType = normalizeMealType(row.mealType);
        const mealDate = normalizeDateOnly(row.mealDate);
        if (!mealType || !mealDate || !row.personId) continue;

        await tx.mealEntitlement.create({
          data: {
            personId: row.personId,
            personName: row.personName || null,
            mealType,
            mealDate
          }
        });
        successRows += 1;
      }
    });

    const failedRows = preview.length - successRows;
    const errors = preview
      .filter((row) => !row.valid)
      .map((row) => ({ row: row.index, error: row.errors.join('; ') }));

    await prisma.importHistory.create({
      data: {
        filename: req.file?.originalname || 'camp-meeting.csv',
        totalRows: preview.length,
        successRows,
        failedRows,
        errorSummary: errors.slice(0, 8).map((e) => `Row ${e.row}: ${e.error}`).join('; ') || null
      }
    });

    return res.json({ totalRows: preview.length, successRows, failedRows, errors, mode });
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
