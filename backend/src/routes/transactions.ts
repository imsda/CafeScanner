import { MealType, ScanResult } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { asyncRouter } from '../utils/asyncRouter.js';
import { prisma } from '../db.js';
import { toCsv } from '../utils/csv.js';
import { parseQueryDate, resolveTimezone } from '../utils/timezone.js';

const router = asyncRouter();

const TRANSACTION_CSV_FIELDS = ['timestamp', 'scannedValue', 'mealType', 'result', 'failureReason', 'stationName', 'entitlementId', 'entitlementPersonName', 'person.firstName', 'person.lastName', 'person.personId', 'person.personType'];
// Exports are capped so a single request cannot load an unbounded history into memory.
const EXPORT_ROW_LIMIT = 100_000;

const filterSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  mealType: z.nativeEnum(MealType).optional(),
  result: z.nativeEnum(ScanResult).optional(),
  station: z.string().optional(),
  personId: z.coerce.number().int().positive().optional()
});

async function buildWhere(query: unknown): Promise<Prisma.ScanTransactionWhereInput> {
  const filters = filterSchema.parse(query);
  const settings = await prisma.setting.findUnique({ where: { id: 1 }, select: { timezone: true } });
  const timezone = resolveTimezone(settings?.timezone);
  // Date-only values (YYYY-MM-DD) are whole days in the school timezone.
  const from = parseQueryDate(filters.from, timezone, 'start');
  const to = parseQueryDate(filters.to, timezone, 'end');
  return {
    ...(from || to ? { timestamp: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(filters.mealType ? { mealType: filters.mealType } : {}),
    ...(filters.result ? { result: filters.result } : {}),
    ...(filters.station ? { stationName: filters.station } : {}),
    ...(filters.personId ? { personId: filters.personId } : {})
  };
}

router.get('/', async (req, res) => {
  const rows = await prisma.scanTransaction.findMany({ where: await buildWhere(req.query), include: { person: true }, orderBy: { timestamp: 'desc' }, take: 1000 });
  res.json(rows);
});

router.get('/export.csv', async (req, res) => {
  const rows = await prisma.scanTransaction.findMany({ where: await buildWhere(req.query), include: { person: true }, orderBy: { timestamp: 'desc' }, take: EXPORT_ROW_LIMIT });
  res.header('Content-Type', 'text/csv');
  res.attachment('transactions.csv');
  res.send(toCsv(rows, TRANSACTION_CSV_FIELDS));
});

export default router;
