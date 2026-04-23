import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { prisma } from '../db.js';
import { nanoid } from 'nanoid';

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

type Row = Record<string, string>;

function parseBool(v: string) {
  return ['1', 'true', 'yes', 'y'].includes((v || '').toLowerCase());
}

router.get('/template', (_req, res) => {
  const header = 'firstName,lastName,personId,codeValue,breakfastRemaining,lunchRemaining,dinnerRemaining,breakfastCount,lunchCount,dinnerCount,totalMealsCount,active,grade,group,campus,notes\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="people-template.csv"');
  res.send(header);
});

router.post('/preview', upload.single('file'), async (req, res) => {
  const text = req.file?.buffer.toString('utf-8') || '';
  const rows = parse(text, { columns: true, skip_empty_lines: true }) as Row[];
  const preview = rows.map((row, idx) => {
    const errors: string[] = [];
    if (!row.firstName) errors.push('firstName is required');
    if (!row.lastName) errors.push('lastName is required');
    if (!row.personId) errors.push('personId is required');
    return { index: idx + 1, row, errors, valid: errors.length === 0 };
  });
  res.json({ total: rows.length, preview });
});

router.post('/commit', upload.single('file'), async (req, res) => {
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

  res.json({ totalRows: rows.length, successRows, failedRows: errors.length, errors });
});

export default router;
